/**
 * The preview proxy: a loopback listener of its own in front of one site's dev
 * server, so the dashboard can inject its preview agent into the pages the
 * pane shows.
 *
 * Its own port is its own origin. The dev-server frame keeps `allow-same-origin`
 * (a dev server's module scripts need it), so the site's code runs with the
 * proxy's origin — never the dashboard's, and never within reach of its token.
 *
 * It forwards to exactly one upstream, the entry's dev URL, which the
 * workspace admits only on `127.0.0.1` or `localhost`; a request target that is
 * not a path is refused, so it can never be steered at another host. A page
 * the frame loads is requested unencoded and gains one script tag; every other
 * response (a fragment the page fetches among them), and every WebSocket
 * upgrade the dev server accepts (its hot reload), passes byte for byte.
 */

import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';

/** Where the proxy serves the agent; a path no site uses. */
export const AGENT_PATH = '/__stet/preview-agent.js';

/** How long the dev server may send nothing on a request before the frame gets the down answer. */
export const UPSTREAM_IDLE_MS = 30_000;

/**
 * Whether a request is for a page the frame shows: its `Sec-Fetch-Dest`, which
 * every current browser sends; where it is absent, whether the answer starts
 * an HTML document. A fragment the page fetches and inserts gains no agent.
 */
function framedPage(dest: string | string[] | undefined): boolean | 'by-body' {
  if (dest === undefined) return 'by-body';
  return dest === 'document' || dest === 'iframe';
}

/** An answer read as latin1 that opens an HTML document: a doctype or `<html`, after any BOM and whitespace. */
const DOCUMENT_START = /^(?:\xef\xbb\xbf)?[\t\n\f\r ]*<(?:!doctype|html)\b/i;

export interface PreviewProxy {
  /** `http://127.0.0.1:<port>`, the frame's origin. */
  origin: string;
  /** The dev URL it forwards to. */
  target: string;
  close(): Promise<void>;
}

export async function startPreviewProxy(
  target: string,
  dashboardOrigin: string,
  agent: string,
  channel: string,
  idleMs = UPSTREAM_IDLE_MS,
): Promise<PreviewProxy> {
  const upstream = new URL(target);
  const port = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  const host = upstream.hostname;
  let origin = '';

  /** The request's headers as the dev server expects them: its own Host and Origin, and no compression. */
  const forward = (headers: IncomingHttpHeaders, html: boolean): IncomingHttpHeaders => {
    const out: IncomingHttpHeaders = { ...headers, host: upstream.host };
    if (typeof out.origin === 'string') out.origin = upstream.origin;
    if (typeof out.referer === 'string' && out.referer.startsWith(origin)) out.referer = upstream.origin + out.referer.slice(origin.length);
    if (html) out['accept-encoding'] = 'identity';
    return out;
  };
  const ownHost = (value: string | undefined): boolean => value !== undefined && `http://${value}` === origin;
  // A request another page sent: the framed site's own requests carry the
  // proxy's origin, and the dev server's own client may name the dev server.
  const foreign = (value: string | string[] | undefined): boolean =>
    typeof value === 'string' && value !== origin && value !== upstream.origin;
  const refused = (req: { url?: string | undefined; headers: IncomingHttpHeaders }): boolean => {
    const path = req.url ?? '';
    return !ownHost(req.headers.host) || !path.startsWith('/') || path.startsWith('//') || foreign(req.headers.origin);
  };

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    if (refused(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused');
      return;
    }
    if (path === AGENT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(agent);
      return;
    }
    const page = framedPage(req.headers['sec-fetch-dest']);
    const down = (): void => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('the dev server is not answering');
      else res.destroy();
    };
    const upstreamReq = httpRequest(
      { host, port, method: req.method, path, headers: forward(req.headers, page !== false) },
      (up) => {
        // A dev server that stops mid-answer (a restart on a config change)
        // ends the frame's request rather than leaving it loading.
        up.on('aborted', down);
        up.on('error', down);
        const headers = { ...up.headers };
        if (typeof headers.location === 'string' && headers.location.startsWith(upstream.origin)) {
          headers.location = origin + headers.location.slice(upstream.origin.length);
        }
        const type = String(headers['content-type'] ?? '');
        const encoded = headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity';
        if (page === false || !type.startsWith('text/html') || encoded || req.method === 'HEAD') {
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on('data', (chunk: Buffer) => chunks.push(chunk));
        up.on('end', () => {
          if (res.headersSent || res.destroyed) return;
          // Read and written as latin1, one byte to one character, so a page in
          // any ASCII-compatible charset keeps its bytes; the tag is ASCII.
          const text = Buffer.concat(chunks).toString('latin1');
          if (page === 'by-body' && !DOCUMENT_START.test(text)) {
            res.writeHead(up.statusCode ?? 200, headers).end(Buffer.concat(chunks));
            return;
          }
          const body = Buffer.from(injectAgent(text, dashboardOrigin, channel), 'latin1');
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          res.writeHead(up.statusCode ?? 200, headers).end(body);
        });
      },
    );
    upstreamReq.on('error', down);
    upstreamReq.setTimeout(idleMs, () => upstreamReq.destroy(new Error('the dev server sent nothing')));
    req.pipe(upstreamReq);
  });

  /** A status line and raw header pairs, as written on the wire. */
  const head = (status: string, raw: string[]): string => {
    const lines = [status];
    for (let at = 0; at + 1 < raw.length; at += 2) lines.push(`${raw[at]}: ${raw[at + 1]}`);
    return `${lines.join('\r\n')}\r\n\r\n`;
  };

  // Hot reload: the upgrade is replayed to the dev server with its own Host
  // and Origin. Only a 101 joins the two sockets; any other answer is relayed
  // and both close, so nothing further on the socket reaches the dev server.
  server.on('upgrade', (req, socket, early) => {
    const path = req.url ?? '';
    if (refused(req)) {
      socket.destroy();
      return;
    }
    socket.on('error', () => upstreamReq.destroy());
    const upstreamReq = httpRequest({ host, port, method: req.method, path, headers: forward(req.headers, false), agent: false });
    upstreamReq.on('upgrade', (up, upstreamSocket, upHead) => {
      socket.write(head(`HTTP/1.1 101 ${up.statusMessage ?? 'Switching Protocols'}`, up.rawHeaders));
      if (upHead.length > 0) socket.write(upHead);
      if (early.length > 0) upstreamSocket.write(early);
      upstreamSocket.on('error', () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
    });
    let upstreamConn: Socket | null = null;
    upstreamReq.on('socket', (conn) => {
      upstreamConn = conn;
    });
    upstreamReq.on('response', (up) => {
      const raw: string[] = [];
      for (let at = 0; at + 1 < up.rawHeaders.length; at += 2) {
        const name = (up.rawHeaders[at] ?? '').toLowerCase();
        if (name !== 'connection' && name !== 'transfer-encoding' && name !== 'content-length' && name !== 'keep-alive') {
          raw.push(up.rawHeaders[at] ?? '', up.rawHeaders[at + 1] ?? '');
        }
      }
      socket.write(head(`HTTP/1.1 ${up.statusCode ?? 502} ${up.statusMessage ?? ''}`, [...raw, 'Connection', 'close']));
      up.on('data', (chunk: Buffer) => socket.write(chunk));
      up.on('end', () => {
        // Written out, then gone: nothing the client sends later is read.
        socket.end(() => socket.destroy());
        upstreamConn?.destroy();
      });
      up.on('error', () => socket.destroy());
    });
    upstreamReq.on('error', () => socket.destroy());
    upstreamReq.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return {
    origin,
    target,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The agent's script tag, before `</head>`, else at the start of `<body>`, else first. */
export function injectAgent(html: string, dashboardOrigin: string, channel: string, src = AGENT_PATH): string {
  const quote = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const tag = `<script src="${src}" data-parent="${quote(dashboardOrigin)}" data-channel="${quote(channel)}"></script>`;
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) return html.slice(0, head) + tag + html.slice(head);
  const body = /<body\b[^>]*>/i.exec(html);
  if (body !== null) return html.slice(0, body.index + body[0].length) + tag + html.slice(body.index + body[0].length);
  return tag + html;
}

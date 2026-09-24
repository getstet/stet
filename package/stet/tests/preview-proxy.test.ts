/**
 * The preview proxy (`cli/preview-proxy.ts`) in front of a plain loopback
 * upstream that records what reaches it. Requests go over raw sockets: the
 * offline guard leaves `node:net` alone, and a raw socket is also the only way
 * to send a foreign `Host` or an absolute-form target.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_PATH, startPreviewProxy, type PreviewProxy } from '../cli/preview-proxy.js';

const DASHBOARD = 'http://127.0.0.1:4400';
const AGENT = '/* the agent */';
const PAGE = '<!DOCTYPE html><html><head><title>Page</title></head><body><p>Hello</p></body></html>\n';
const LATIN = Buffer.concat([
  Buffer.from('<html><head><title>caf', 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from('</title></head><body>café</body></html>\n', 'utf8'),
]);
const IMAGE = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const FRAGMENT = '<span>island content</span>';
const BOM_PAGE = '\ufeff\n  <!doctype html><html><head></head><body>With a BOM</body></html>';

interface Upstream {
  origin: string;
  port: number;
  /** Every plain request that reached it: its path and headers. */
  seen: Array<{ url: string; headers: IncomingHttpHeaders }>;
  /** Every upgrade that reached it: its headers. */
  upgrades: IncomingHttpHeaders[];
  /** Whatever reached the socket of an upgrade it refused, after its answer. */
  afterRefusal: string[];
  server: Server;
}

const opened: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const one of opened.splice(0).reverse()) await one.close();
});

async function upstream(): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const upgrades: IncomingHttpHeaders[] = [];
  const afterRefusal: string[] = [];
  let origin = '';
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const html = (body: Buffer | string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.url === '/page') return html(PAGE);
    if (req.url === '/latin') return html(LATIN);
    if (req.url === '/fragment') return html(FRAGMENT);
    if (req.url === '/bom') return html(BOM_PAGE);
    if (req.url === '/reset' || req.url === '/stall') {
      // Headers and part of a page, then the dev server dies or goes quiet.
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': 1000 });
      res.write('<!DOCTYPE html><html><head>');
      if (req.url === '/reset') setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    if (req.url === '/gz') {
      const body = gzipSync(PAGE);
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': body.length });
      return void res.end(body);
    }
    if (req.url === '/img') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': IMAGE.length });
      return void res.end(IMAGE);
    }
    if (req.url === '/go') {
      res.writeHead(302, { location: `${origin}/page`, 'content-length': 0 });
      return void res.end();
    }
    res.writeHead(404, { 'content-length': 0 });
    res.end();
  });
  // An upgrade that echoes whatever the client sends once it is switched.
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.headers);
    if (req.url === '/_refuse') {
      // A keep-alive answer that is not a switch: the socket stays open.
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\nnope');
      socket.on('data', (chunk: Buffer) => afterRefusal.push(chunk.toString('latin1')));
      socket.on('end', () => {
        afterRefusal.push('<ended>');
        socket.end();
      });
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  const up: Upstream = { origin, port, seen, upgrades, afterRefusal, server };
  opened.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return up;
}

async function proxyTo(up: Upstream, idleMs?: number): Promise<PreviewProxy & { port: number; host: string }> {
  const proxy = await startPreviewProxy(up.origin, DASHBOARD, AGENT, 'c1', idleMs);
  opened.push(proxy);
  const host = proxy.origin.slice('http://'.length);
  return Object.assign(proxy, { port: Number(host.split(':')[1]), host });
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  closed: boolean;
}

/** One request over a raw socket, `Connection: close`, read to the end and de-chunked. */
function send(port: number, head: string): Promise<Reply> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect(port, '127.0.0.1', () => socket.write(head));
    const finish = (): void => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf('\r\n\r\n');
      if (split === -1) {
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), closed: true });
        return;
      }
      const lines = all.subarray(0, split).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      let body = all.subarray(split + 4);
      if (headers['transfer-encoding'] === 'chunked') {
        const parts: Buffer[] = [];
        for (let at = 0; ; ) {
          const end = body.indexOf('\r\n', at);
          const size = parseInt(body.subarray(at, end).toString('latin1'), 16);
          if (!(size > 0)) break;
          parts.push(body.subarray(end + 2, end + 2 + size));
          at = end + 2 + size + 2;
        }
        body = Buffer.concat(parts);
      }
      resolve({ status: Number(lines[0]?.split(' ')[1] ?? 0), headers, body, closed: false });
    };
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('close', finish);
    socket.on('error', () => undefined);
    socket.setTimeout(5_000, () => socket.destroy());
  });
}

const get = (port: number, path: string, host: string, extra = ''): Promise<Reply> =>
  send(port, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);

/** An upgrade over a raw socket: the status line it got, and what came back for `payload`. */
function upgrade(port: number, host: string, origin: string, payload: string): Promise<{ status: string; echoed: string }> {
  return new Promise((resolve) => {
    let seen = '';
    let switched = false;
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /_hmr HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      seen += chunk;
      if (!switched && seen.includes('\r\n\r\n')) {
        switched = true;
        seen = seen.slice(seen.indexOf('\r\n\r\n') + 4);
        socket.write(payload);
      }
      if (switched && seen === payload) {
        socket.destroy();
        resolve({ status: '101', echoed: seen });
      }
    });
    socket.on('close', () => resolve({ status: switched ? '101' : 'closed', echoed: seen }));
    socket.on('error', () => undefined);
    socket.setTimeout(3_000, () => socket.destroy());
  });
}

describe('the preview proxy', () => {
  it('forwards a path with the dev server’s own Host and Origin, and asks for HTML unencoded', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    const reply = await get(proxy.port, '/page', proxy.host, `Origin: ${proxy.origin}\r\nAccept-Encoding: gzip, br\r\n`);
    expect(reply.status).toBe(200);
    expect(up.seen.at(-1)?.headers['host']).toBe(`127.0.0.1:${up.port}`);
    expect(up.seen.at(-1)?.headers['origin']).toBe(up.origin);
    expect(up.seen.at(-1)?.headers['accept-encoding']).toBe('identity');
  });

  it('adds the agent’s tag before </head>, whole, with no length left from the upstream', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    const reply = await get(proxy.port, '/page', proxy.host);
    const tag = `<script src="${AGENT_PATH}" data-parent="${DASHBOARD}" data-channel="c1"></script>`;
    expect(reply.body.toString('utf8')).toBe(PAGE.replace('</head>', `${tag}</head>`));
    expect(reply.headers['content-length']).not.toBe(String(Buffer.byteLength(PAGE)));
    // The agent itself, from the proxy's own path.
    expect((await get(proxy.port, AGENT_PATH, proxy.host)).body.toString('utf8')).toBe(AGENT);
  });

  it('passes compressed HTML and every other type byte for byte, and keeps a redirect on its own origin', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    expect((await get(proxy.port, '/gz', proxy.host)).body).toEqual(gzipSync(PAGE));
    expect((await get(proxy.port, '/img', proxy.host)).body).toEqual(IMAGE);
    const moved = await get(proxy.port, '/go', proxy.host);
    expect(moved.status).toBe(302);
    expect(moved.headers['location']).toBe(`${proxy.origin}/page`);
  });

  it('keeps every byte of a page in another charset beside the tag', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    const reply = await get(proxy.port, '/latin', proxy.host);
    const text = reply.body.toString('latin1');
    const tag = /<script src="[^"]*" data-parent="[^"]*" data-channel="c1"><\/script>/.exec(text)?.[0] ?? '<none>';
    expect(Buffer.from(text.replace(tag, ''), 'latin1')).toEqual(LATIN);
  });

  it('refuses a foreign Origin, and forwards its own and the dev server’s', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    const refused = await get(proxy.port, '/page', proxy.host, 'Origin: http://evil.example\r\n');
    expect(refused.status).toBe(403);
    expect(refused.body.toString()).toBe('refused');
    expect(up.seen).toHaveLength(0);
    for (const origin of [proxy.origin, up.origin]) {
      expect((await get(proxy.port, '/page', proxy.host, `Origin: ${origin}\r\n`)).status, origin).toBe(200);
    }
    expect(up.seen).toHaveLength(2);
    expect((await upgrade(proxy.port, proxy.host, 'http://evil.example', 'ping')).status).toBe('closed');
    expect(up.upgrades).toHaveLength(0);
  });

  it('refuses a foreign Host, an absolute-form target and a //host target, forwarding nothing', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    for (const reply of [
      await get(proxy.port, '/page', 'evil.example'),
      await send(proxy.port, `GET http://example.com/ HTTP/1.1\r\nHost: ${proxy.host}\r\nConnection: close\r\n\r\n`),
      await get(proxy.port, '//example.com/', proxy.host),
    ]) {
      expect(reply.status).toBe(403);
      expect(reply.body.toString()).toBe('refused');
    }
    expect(up.seen).toHaveLength(0);
  });

  it('joins an upgrade both ways with the dev server’s own Origin, and drops one for a foreign Host', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    const joined = await upgrade(proxy.port, proxy.host, proxy.origin, 'a frame, both ways');
    expect(joined).toEqual({ status: '101', echoed: 'a frame, both ways' });
    expect(up.upgrades.at(-1)?.['origin']).toBe(up.origin);
    expect(up.upgrades.at(-1)?.['host']).toBe(`127.0.0.1:${up.port}`);
    expect((await upgrade(proxy.port, 'evil.example', proxy.origin, 'x')).status).toBe('closed');
    expect(up.upgrades).toHaveLength(1);
  });

  it('answers 502 while the dev server is down, and lets go of its port on close', async () => {
    const up = await upstream();
    const proxy = await proxyTo(up);
    await new Promise<void>((resolve) => {
      up.server.closeAllConnections();
      up.server.close(() => resolve());
    });
    const down = await get(proxy.port, '/page', proxy.host);
    expect(down.status).toBe(502);
    expect(down.body.toString()).toBe('the dev server is not answering');
    await proxy.close();
    // A status line would mean something still serves there.
    const after = await get(proxy.port, AGENT_PATH, proxy.host);
    expect(after.status).toBe(0);
  });

  describe('pages, fragments, refused upgrades and a dev server that stops mid-page', () => {
    const TAG = `<script src="${AGENT_PATH}" data-parent="${DASHBOARD}" data-channel="c1"></script>`;

    it('adds the agent to a page the frame loads, and passes a fragment the page fetches byte for byte', async () => {
      const up = await upstream();
      const proxy = await proxyTo(up);
      const page = await get(proxy.port, '/page', proxy.host, 'Sec-Fetch-Dest: iframe\r\n');
      expect(page.body.toString('utf8')).toBe(PAGE.replace('</head>', `${TAG}</head>`));
      expect((await get(proxy.port, '/page', proxy.host, 'Sec-Fetch-Dest: document\r\n')).body.toString('utf8')).toContain(TAG);
      const fetched = await get(proxy.port, '/fragment', proxy.host, 'Sec-Fetch-Dest: empty\r\nAccept-Encoding: gzip\r\n');
      expect(fetched.body.toString('utf8')).toBe(FRAGMENT);
      expect(up.seen.at(-1)?.headers['accept-encoding']).toBe('gzip');
      // A fetched full page is not a page the frame shows either.
      expect((await get(proxy.port, '/page', proxy.host, 'Sec-Fetch-Dest: empty\r\n')).body.toString('utf8')).toBe(PAGE);
    });

    it('with no Sec-Fetch-Dest, adds the agent only to an answer that starts an HTML document', async () => {
      const up = await upstream();
      const proxy = await proxyTo(up);
      expect((await get(proxy.port, '/fragment', proxy.host)).body.toString('utf8')).toBe(FRAGMENT);
      expect((await get(proxy.port, '/bom', proxy.host)).body.toString('utf8')).toBe(BOM_PAGE.replace('</head>', `${TAG}</head>`));
      expect((await get(proxy.port, '/page', proxy.host)).body.toString('utf8')).toContain(TAG);
    });

    it('relays an upgrade the dev server refuses and closes, so nothing sent after it reaches the dev server', async () => {
      const up = await upstream();
      const proxy = await proxyTo(up);
      const reply = await new Promise<{ text: string; closed: boolean }>((resolve) => {
        let text = '';
        const socket = connect(proxy.port, '127.0.0.1', () => {
          socket.write(
            `GET /_refuse HTTP/1.1\r\nHost: ${proxy.host}\r\nOrigin: ${proxy.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
          );
        });
        socket.setEncoding('latin1');
        socket.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('nope')) socket.write('GET /smuggled HTTP/1.1\r\nHost: evil.example\r\n\r\n');
        });
        socket.on('close', () => resolve({ text, closed: true }));
        socket.on('error', () => undefined);
        socket.setTimeout(3_000, () => {
          socket.destroy();
          resolve({ text, closed: false });
        });
      });
      expect(reply.closed).toBe(true);
      expect(reply.text.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
      expect(reply.text.endsWith('\r\n\r\nnope')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(up.afterRefusal).toEqual(['<ended>']);
    });

    it('answers the down line when the dev server dies mid-page, and when it goes quiet past the limit', async () => {
      const up = await upstream();
      const proxy = await proxyTo(up, 300);
      const started = Date.now();
      const reset = await get(proxy.port, '/reset', proxy.host, 'Sec-Fetch-Dest: iframe\r\n');
      expect([reset.status, reset.body.toString()]).toEqual([502, 'the dev server is not answering']);
      const stalled = await get(proxy.port, '/stall', proxy.host, 'Sec-Fetch-Dest: iframe\r\n');
      expect([stalled.status, stalled.body.toString()]).toEqual([502, 'the dev server is not answering']);
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });
});

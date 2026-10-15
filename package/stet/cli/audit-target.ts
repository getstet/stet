/**
 * What `stet audit lighthouse` measures: the checkout's documents served as
 * deployed, or a production preview relayed, fronted over HTTP/2 the way
 * production serves them.
 */

import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import {
  constants,
  createSecureServer,
  type Http2SecureServer,
  type IncomingHttpHeaders as H2Headers,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';

import { contentTypeOf, servableFile } from './static-files.js';

/** A served target: the URL Lighthouse loads, and how to stop it. */
export interface Front {
  url: string;
  close: () => Promise<void>;
}

/** Hop-by-hop headers HTTP/2 forbids in a response, and the request's own Host. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'http2-settings']);

/**
 * An HTTP/2 front on loopback port 0: the checkout's files where `root` is
 * given, else every request relayed to `upstream` over HTTP/1.1. The
 * certificate is minted for this run and never written to disk.
 */
export async function startFront(target: { root: string } | { upstream: URL }): Promise<Front> {
  const { generate } = await import('selfsigned');
  const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 86_400_000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  const server: Http2SecureServer = createSecureServer({ key: pems.private, cert: pems.cert });
  // Every connection, not every session: a client's `connect` fires before the
  // server's `session` event, and a TLS client that negotiated no protocol has
  // no session at all yet holds `server.close` for `unknownProtocolTimeout`.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('stream', (stream, headers) => {
    if ('root' in target) serveFile(target.root, stream, headers);
    else relay(target.upstream, stream, headers);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // `server.close` waits for every connection, and Chrome holds its until it exits.
        for (const socket of sockets) socket.destroy();
      }),
  };
}

function serveFile(root: string, stream: ServerHttp2Stream, headers: H2Headers): void {
  const method = headers[':method'];
  const path = String(headers[':path'] ?? '/').split('?')[0] ?? '/';
  const file = method === 'GET' || method === 'HEAD' ? servableFile(root, path) : null;
  if (file === null) {
    stream.respond({ ':status': 404, 'content-type': 'text/plain; charset=utf-8' });
    stream.end('not found');
    return;
  }
  stream.respond({ ':status': 200, 'content-type': contentTypeOf(file), 'cache-control': 'no-store' });
  stream.end(method === 'HEAD' ? undefined : readFileSync(file));
}

function relay(upstream: URL, stream: ServerHttp2Stream, headers: H2Headers): void {
  const out: Record<string, string | string[]> = { host: upstream.host };
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || HOP.has(name) || value === undefined) continue;
    out[name] = value;
  }
  const req = httpRequest(
    { host: upstream.hostname, port: upstream.port, method: String(headers[':method']), path: String(headers[':path']), headers: out },
    (res) => {
      const back: Record<string, string | string[] | number> = { ':status': res.statusCode ?? 502 };
      for (const [name, value] of Object.entries(res.headers as IncomingHttpHeaders)) {
        if (HOP.has(name) || value === undefined) continue;
        back[name] = value;
      }
      // An upstream that dies mid-body ends the stream, else Lighthouse waits out its load timeout on it.
      res.on('error', () => stream.close(constants.NGHTTP2_INTERNAL_ERROR));
      try {
        stream.respond(back);
        res.pipe(stream);
      } catch {
        res.resume();
      }
    },
  );
  req.on('error', () => {
    try {
      stream.respond({ ':status': 502 });
      stream.end();
    } catch {
      // The stream already closed.
    }
  });
  // A stream the browser resets (`INTERNAL_ERROR` included) would otherwise raise
  // an uncaught `ERR_HTTP2_STREAM_ERROR`; it ends the upstream request with it.
  stream.on('error', () => req.destroy());
  stream.on('close', () => req.destroy());
  stream.pipe(req);
}

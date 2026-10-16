/**
 * `cli/audit-target.ts` — the HTTP/2 front `stet audit lighthouse` measures
 * through: the checkout's documents, or a production preview relayed over
 * HTTP/1.1. Every case talks to the front over loopback with `node:http2`'s
 * client (or a raw TLS or TCP socket), and every server it starts it closes.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http, { ClientRequest, createServer, type Server } from 'node:http';
import { connect as h2connect, constants, type ClientHttp2Session } from 'node:http2';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startFront, type Front } from '../cli/audit-target.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'html-host');

/**
 * The offline guard (`setup.offline.ts`) replaces `http.request` for the whole
 * suite; the relay's upstream is a loopback server this file starts, so the
 * real client is put back for these cases and the guard restored after.
 */
const guarded = http.request;
beforeAll(() => {
  http.request = ((...args: ConstructorParameters<typeof ClientRequest>) => new ClientRequest(...args)) as typeof http.request;
});
afterAll(() => {
  http.request = guarded;
});

interface Answer {
  status?: number;
  headers?: Record<string, unknown>;
  body: string;
  error?: string;
}

function get(session: ClientHttp2Session, path: string, method = 'GET'): Promise<Answer> {
  return new Promise((resolve) => {
    const stream = session.request({ ':path': path, ':method': method });
    let headers: Record<string, unknown> | undefined;
    let body = '';
    stream.on('response', (h) => (headers = h as Record<string, unknown>));
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => (body += chunk));
    stream.on('end', () => resolve({ status: headers?.[':status'] as number, ...(headers === undefined ? {} : { headers }), body }));
    stream.on('error', (error: NodeJS.ErrnoException) => resolve({ body, error: error.code ?? error.message }));
    stream.end();
  });
}

const within = <T>(ms: number, work: Promise<T>): Promise<T | 'timed out'> =>
  Promise.race([work, new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms))]);

const opened: Array<{ close: () => unknown }> = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.close();
});

async function front(target: Parameters<typeof startFront>[0]): Promise<Front> {
  const f = await startFront(target);
  opened.push(f);
  return f;
}

function session(url: string): ClientHttp2Session {
  const s = h2connect(url, { rejectUnauthorized: false });
  s.on('error', () => undefined);
  opened.push({ close: () => s.destroy() });
  return s;
}

async function upstreamServer(handler: Parameters<typeof createServer>[1]): Promise<{ url: URL; server: Server; closeAll: () => void }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const closeAll = (): void => {
    server.closeAllConnections();
    server.close();
  };
  opened.push({ close: closeAll });
  return { url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`), server, closeAll };
}

describe('startFront — the documents', () => {
  it('answers index.html as text/html over h2', async () => {
    const f = await front({ root: ROOT });
    const s = session(f.url);
    const answer = await get(s, '/');
    expect(s.alpnProtocol).toBe('h2');
    expect(answer.status).toBe(200);
    expect(answer.headers?.['content-type']).toBe('text/html; charset=utf-8');
    expect(answer.body).toContain('<html');
    expect((await get(s, '/edges.html')).status).toBe(200);
  });

  it('answers 404 for what the static files refuse, and for a POST', async () => {
    const f = await front({ root: ROOT });
    const s = session(f.url);
    for (const path of ['/nosuch.html', '/../package.json', '/%2e%2e/package.json']) {
      expect((await get(s, path)).status, path).toBe(404);
    }
    expect((await get(s, '/', 'POST')).status).toBe(404);
  });

  it('serves no HTTP/1.1 client, and nothing hangs', async () => {
    const f = await front({ root: ROOT });
    const port = Number(new URL(f.url).port);
    // No ALPN at all: the server's 403 and the socket closed.
    const noAlpn = await within(
      5_000,
      new Promise<string>((resolve) => {
        let text = '';
        const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
          socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (text += chunk));
        socket.on('error', () => undefined);
        socket.on('close', () => resolve(text));
      }),
    );
    expect(noAlpn).toMatch(/^HTTP\/1\.[01] 403/);
    // `http/1.1` offered: the handshake ends with the no_application_protocol alert.
    const alpn11 = await within(
      5_000,
      new Promise<string>((resolve) => {
        const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () =>
          resolve(`connected ${String(socket.alpnProtocol)}`),
        );
        socket.on('error', (error: NodeJS.ErrnoException) => resolve(String(error.code)));
      }),
    );
    expect(alpn11).toBe('ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');
  });
});

describe('startFront — a reset on the documents', () => {
  it('a stream the client resets with INTERNAL_ERROR mid-body throws nothing and the front keeps answering', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stet-front-reset-'));
    const thrown: Error[] = [];
    const onThrown = (error: Error): void => void thrown.push(error);
    process.on('uncaughtException', onThrown);
    try {
      writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
      // Larger than the stream's flow-control window, so the body is still going when the client resets.
      writeFileSync(join(root, 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 65));
      const f = await front({ root });
      const s = session(f.url);
      const stream = s.request({ ':path': '/big.bin' });
      stream.on('error', () => undefined);
      stream.once('data', () => stream.close(constants.NGHTTP2_INTERNAL_ERROR));
      await within(2_000, new Promise<void>((resolve) => stream.on('close', () => resolve())));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(thrown.map((error) => error.message)).toEqual([]);
      expect((await get(session(f.url), '/index.html')).status).toBe(200);
    } finally {
      process.off('uncaughtException', onThrown);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('startFront — the relay', () => {
  it('passes status, headers and body from an HTTP/1.1 upstream, stripping the hop-by-hop headers', async () => {
    const up = await upstreamServer((req, res) => {
      res.statusCode = 203;
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Upstream', req.url ?? '');
      res.write('aaa');
      setTimeout(() => res.end('bbb'), 20);
    });
    const f = await front({ upstream: up.url });
    const answer = await get(session(f.url), '/chunked?x=1');
    expect(answer.error).toBeUndefined();
    expect(answer.status).toBe(203);
    expect(answer.headers?.['x-upstream']).toBe('/chunked?x=1');
    expect(answer.headers).not.toHaveProperty('connection');
    expect(answer.headers).not.toHaveProperty('transfer-encoding');
    expect(answer.body).toBe('aaabbb');
  });

  it('answers 502 where the upstream is down', async () => {
    const up = await upstreamServer((_req, res) => res.end('never'));
    const dead = up.url;
    up.closeAll();
    const f = await front({ upstream: dead });
    expect((await get(session(f.url), '/')).status).toBe(502);
  });

  it('a stream the client resets with INTERNAL_ERROR throws nothing and destroys the upstream request', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    const up = await upstreamServer((_req, res) => {
      const tick = setInterval(() => res.write('y'.repeat(1000)), 10);
      res.on('close', () => {
        clearInterval(tick);
        upstreamClosed();
      });
    });
    const f = await front({ upstream: up.url });
    const s = session(f.url);
    const stream = s.request({ ':path': '/slow' });
    stream.on('error', () => undefined);
    stream.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    expect(await within(2_000, closed)).toBeUndefined();
  });

  it('ends the stream within a second where the upstream dies mid-body', async () => {
    const up = await upstreamServer((req, res) => {
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 30);
    });
    const f = await front({ upstream: up.url });
    const answer = await within(1_000, get(session(f.url), '/cut'));
    expect(answer).not.toBe('timed out');
  });
});

describe('startFront — close', () => {
  const closesWithin = async (f: Front): Promise<void> => {
    expect(await within(1_000, f.close().then(() => 'closed'))).toBe('closed');
  };

  it('resolves with a client session still open', async () => {
    const f = await startFront({ root: ROOT });
    const s = session(f.url);
    await get(s, '/');
    await closesWithin(f);
  });

  it('resolves with a just-connected session that has opened no stream', async () => {
    const f = await startFront({ root: ROOT });
    const s = session(f.url);
    await new Promise((resolve) => s.on('connect', resolve));
    await closesWithin(f);
  });

  it('resolves with an idle TLS socket that negotiated no protocol', async () => {
    const f = await startFront({ root: ROOT });
    const socket = tlsConnect({ host: '127.0.0.1', port: Number(new URL(f.url).port), rejectUnauthorized: false });
    socket.on('error', () => undefined);
    opened.push({ close: () => socket.destroy() });
    await new Promise((resolve) => socket.on('secureConnect', resolve));
    await closesWithin(f);
  });

  it('resolves with a raw TCP socket', async () => {
    const f = await startFront({ root: ROOT });
    const socket = netConnect(Number(new URL(f.url).port), '127.0.0.1');
    socket.on('error', () => undefined);
    opened.push({ close: () => socket.destroy() });
    await new Promise((resolve) => socket.on('connect', resolve));
    await closesWithin(f);
  });
});

describe('startFront — nothing on disk', () => {
  it('writes no file under the checkout or the temp directory', async () => {
    // A temp directory of this case's own, so a file another suite file writes is never counted.
    const own = mkdtempSync(join(tmpdir(), 'stet-front-'));
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = own;
    try {
      expect(tmpdir()).toBe(own);
      const before = readdirSync(ROOT).sort();
      const f = await startFront({ root: ROOT });
      await get(session(f.url), '/');
      await f.close();
      expect(readdirSync(own)).toEqual([]);
      expect(readdirSync(ROOT).sort()).toEqual(before);
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
      rmSync(own, { recursive: true, force: true });
    }
  });
});

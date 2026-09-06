/**
 * `stet dev` — the local dashboard: an HTTP server on the loopback interface,
 * the page it serves, and the browser it opens.
 *
 * The server is thin on purpose. Everything it decides lives in
 * `cli/dev-routes.ts` as a `Request → Response` function; this file is the
 * listener, the adapter between Node's request and response objects and that
 * shape, the argument parsing, and the run token. The two things the adapter
 * owns rather than the handler are the ones a WHATWG `Request` cannot express:
 * a request target that does not parse as a URL, and a body larger than the
 * server will read.
 *
 * The token is minted per run, printed on the terminal, and stripped from every
 * child the server starts. It never reaches disk.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { StoreAdapter } from '../src/store.js';
import { flag, noPositionals, parse, text } from './args.js';
import { CONFIG_FILE } from './config.js';
import { createDevHandler, stopEveryChild, type DevChild, type DevContext } from './dev-routes.js';
import { packageRoot } from './installed.js';
import { disposeStore } from './project.js';
import type { CliIo } from './main.js';
import { CliError, UsageError } from './report.js';
import { addSite, childEnv, workspacePath } from './workspace.js';

/** The port the dashboard takes when nothing says otherwise. */
const DEFAULT_PORT = 4400;

/** A request body larger than this is refused before the handler runs. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** How long the rest of a refused body is read for before the socket is dropped. */
const DRAIN_MS = 5_000;

export interface DevServerHandle {
  /** The URL to open, with the run token — built from the port the OS actually bound. */
  url: string;
  /** The interface the server bound. Always the loopback one. */
  address: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface StartDevServerOptions {
  port: number;
  workspaceFile: string;
  io: CliIo;
  /** The run token. Minted here when absent; a fixture passes its own. */
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Test seam: an adapter to use in place of the one a site's config would build. */
  storeFor?: (path: string, env: string | undefined) => StoreAdapter | undefined;
  /** The page's html. Defaults to the copy shipped inside the package. */
  page?: string;
}

/** The page shipped inside the package, located the way every other shipped asset is. */
export function dashboardPage(): string {
  return readFileSync(join(packageRoot(), 'dashboard', 'index.html'), 'utf8');
}

/**
 * The listener. It binds `127.0.0.1` and nothing else: the dashboard has no
 * identity model, so reachability IS its access control.
 *
 * Port `0` binds a free port, and the URL is always built from
 * `server.address()` rather than from the argument — the suite's way in, and a
 * documented value on the command.
 */
export async function startDevServer(opts: StartDevServerOptions): Promise<DevServerHandle> {
  const token = opts.token ?? randomBytes(32).toString('hex');
  // Set HERE and not in `runDev`, because the mounted handler reads the run
  // token out of this process's own environment: a server started by anything
  // else would answer 401 to its own handle's token. `childEnv` takes it back
  // out again for everything the server spawns, and `close()` puts back
  // whatever was there before.
  const held = process.env['STET_DEV_TOKEN'];
  process.env['STET_DEV_TOKEN'] = token;
  const children = new Map<string, DevChild>();
  const stores = new Map<string, StoreAdapter>();
  // The origin is not known until the port is bound, so the context holds a
  // placeholder the listener rewrites the moment `listen` answers.
  const ctx: DevContext = {
    token,
    origin: `http://127.0.0.1:${opts.port}`,
    workspaceFile: opts.workspaceFile,
    io: opts.io,
    page: opts.page ?? dashboardPage(),
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    children,
    stores,
    queues: new Map(),
    ...(opts.storeFor === undefined ? {} : { storeFor: opts.storeFor }),
  };
  const handler = createDevHandler(ctx);
  const server = createServer((req, res) => {
    void serve(handler, ctx.origin, req, res);
  });

  const bound = await listen(server, opts.port);
  ctx.origin = `http://127.0.0.1:${bound.port}`;

  return {
    url: `${ctx.origin}/?t=${token}`,
    address: bound.address,
    port: bound.port,
    token,
    async close(): Promise<void> {
      await stopEveryChild(ctx);
      for (const store of stores.values()) await disposeStore(store);
      stores.clear();
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
      // An idle keep-alive client would otherwise hold the close open.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `listen`, as a promise, with the in-use case named for the flag that fixes it. */
function listen(server: Server, port: number): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new CliError(`port ${port} is in use — pass --port <another>`));
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address();
      resolve(
        typeof bound === 'object' && bound !== null
          ? { address: bound.address, port: bound.port }
          : { address: '127.0.0.1', port },
      );
    });
  });
}

/**
 * One Node request, through the handler and back.
 *
 * The two guards here are the ones a `Request` cannot carry, so no handler case
 * could ever reach them: `GET //[ HTTP/1.1` arrives with `req.url === '//['`,
 * which `new URL` refuses, and a body is capped before it is buffered rather
 * than after.
 */
async function serve(
  handler: (req: Request) => Promise<Response>,
  origin: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let request: Request;
  try {
    request = await toRequest(req, origin);
  } catch (error) {
    const tooLarge = (error as { tooLarge?: boolean }).tooLarge === true;
    // The rest of the refused body is read and thrown away BEFORE the refusal
    // is written. `end()` on a socket that still has unread inbound data makes
    // the stack send RST, which discards the reply the client has not read yet
    // — the 413 was lost about one time in six. Draining first costs the time
    // the upload takes and delivers every refusal.
    if (tooLarge && !(await drain(req))) {
      res.destroy();
      return;
    }
    // `Connection: close`: the socket carried a request this server refused to
    // read in full, so it cannot be trusted to frame another.
    res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: tooLarge ? 'request body too large' : 'bad request' }));
    return;
  }
  const out = await handler(request);
  send(res, out);
}

/**
 * The rest of a refused body, read and discarded, bounded.
 *
 * True when the request ended within the deadline and the socket is safe to
 * answer on; false when it did not, which is an upload with no end and the
 * honest outcome is a destroyed socket and no reply.
 */
function drain(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), DRAIN_MS);
    req.on('data', () => {});
    req.on('end', () => done(true));
    req.on('error', () => done(false));
    req.on('close', () => done(false));
    req.resume();
  });
}

/** Node's request as a WHATWG one. */
async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await collect(req);
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  } as RequestInit);
}

/** The body, or a refusal once it passes the cap — never the whole of an oversized upload. */
function collect(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        // Stop reading, but leave the socket alone: the refusal is written on
        // it, and a destroyed request takes the response with it.
        req.pause();
        req.removeAllListeners('data');
        reject(Object.assign(new Error('request body too large'), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The handler's response, written out. */
function send(res: ServerResponse, out: Response): void {
  const headers: Record<string, string> = {};
  out.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(out.status, headers);
  void out
    .arrayBuffer()
    .then((buffer) => res.end(Buffer.from(buffer)))
    .catch(() => res.end());
}

export interface RunDevHooks {
  /**
   * What to do once the server is listening. Absent, the command waits for
   * `SIGINT`/`SIGTERM`; a fixture passes one so a run can be driven and closed
   * without a signal.
   */
  onListening?: (handle: DevServerHandle) => Promise<void>;
}

export async function runDev(args: string[], io: CliIo, hooks: RunDevHooks = {}): Promise<number> {
  const { values, positionals } = parse(args, { port: 'string', 'no-open': 'boolean', add: 'string' });
  noPositionals(positionals, 'dev');

  const port = parsePort(text(values, 'port'));
  const workspaceFile = workspacePath(io);

  // Run inside a checkout, `stet dev` adds it — the walkthrough's first step —
  // and `--add` is the same addition from anywhere else. Neither ever removes.
  const adding = text(values, 'add') ?? (existsSync(join(io.cwd, CONFIG_FILE)) ? io.cwd : undefined);
  const opened = adding === undefined ? undefined : addSite(workspaceFile, adding).path;

  const handle = await startDevServer({ port, workspaceFile, io });
  const url = opened === undefined ? handle.url : `${handle.url}&site=${encodeURIComponent(opened)}`;
  io.stdout(`dashboard: ${url}`);
  if (!flag(values, 'no-open')) openBrowser(url);

  if (hooks.onListening !== undefined) {
    try {
      await hooks.onListening(handle);
    } finally {
      await handle.close();
    }
    return 0;
  }

  await untilInterrupted();
  await handle.close();
  return 0;
}

/** `--port`, as one rule for the command and the suite alike. */
function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError('--port must be an integer between 0 and 65535; 0 picks a free port');
  }
  return port;
}

/** The run, held open until the operator ends it. */
function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * The browser, opened on the printed URL. A failure is ignored on purpose: the
 * URL is on the terminal either way, and a platform whose opener is missing is
 * not a reason for the server not to run.
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command as string, args as string[], {
      detached: true,
      stdio: 'ignore',
      env: childEnv(),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL is on the terminal */
  }
}

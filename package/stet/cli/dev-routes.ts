/**
 * The local dashboard's request handler — a `Request → Response` function, the
 * same shape the mounted API takes.
 *
 * A function rather than a listener because that is what can be PROVEN: the
 * suite's offline guard replaces `fetch`, `http.request` and `http.get`, so a
 * server reachable only over a socket could not be driven by a single case
 * here. `cli/dev.ts` holds the listener and the thin adapter that turns Node's
 * request and response into and out of this shape, and the store-backed mount
 * composes in as one more branch.
 *
 * Everything the page can do is a route here, and every route is a call the
 * CLI already makes. A route that runs a command runs it through `runCli` —
 * never a `runX` function directly — so a usage mistake and a failure map to
 * the same exit codes and the same text the terminal gives.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

import { bearerMatches, createStetHandler } from '../server/mount.js';
import type { Snapshot } from '../src/snapshot.js';
import type { StoreAdapter } from '../src/store.js';
import type { Descriptor } from '../src/types.js';
import { planRepoForms, rethrowBatchFailure, writePlanned } from './artifacts.js';
import { check } from './check.js';
import type { StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { git, gitRun, gitState } from './git.js';
import { proposeHtml } from './html-host.js';
import { runCli, type CliIo } from './main.js';
import { applyPages, proposeForHost } from './pages.js';
import { planRemoval } from './remove.js';
import { resolveStore } from './store.js';
import { CliError, plural, Report, UsageError } from './report.js';
import { validateValue } from './validate.js';
import {
  addSite,
  childEnv,
  devDefaults,
  loadSite,
  readWorkspace,
  removeSite,
  siteEnv,
  siteId,
  siteIo,
  updateSite,
  type SiteState,
  type WorkspaceEntry,
} from './workspace.js';
import { osUser } from './write.js';
import { packageVersion } from './installed.js';

/** A dev-server child the dashboard started. Section 8 fills it; the context carries it from the start. */
export interface DevChild {
  pid: number;
  command: string;
  lines: string[];
  state: 'running' | 'exited' | 'detached';
  code: number | null;
  /** The entry's stop command, for a server that outlived its launcher. */
  stop?: string;
  /** Whether the exited-or-detached question has been answered once. */
  checked?: boolean;
  handle?: ChildProcess;
}

export interface DevContext {
  /** The per-run Bearer every `/api/` request carries. */
  token: string;
  /** `http://127.0.0.1:<port>` — the address the Host check and the frame policy are built from. */
  origin: string;
  workspaceFile: string;
  io: CliIo;
  /** The page's html, with `__STET_NONCE__` where the nonce goes. */
  page: string;
  fetchImpl: typeof globalThis.fetch;
  children: Map<string, DevChild>;
  stores: Map<string, StoreAdapter>;
  /** One promise chain per checkout, so this server's requests never interleave on one site. */
  queues: Map<string, Promise<unknown>>;
  /** Test seam: an adapter to use in place of the one the config would build. */
  storeFor?: (path: string, env: string | undefined) => StoreAdapter | undefined;
}

/** A JSON reply. Every route answers one, bar the page, the static files and the mount's own. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The content-security policy the page is served under, with its nonce.
 *
 * The script is NONCED, so no inline handler attribute runs and the page
 * carries none: every control dispatches through a delegated listener. Styles
 * are admitted inline because the page's whole rendering model is inline
 * `style=` attributes and CSS carries no script — a nonce on `style-src` would
 * silently strip every one of them, since a nonce in a directive makes
 * `'unsafe-inline'` ignored. `frame-src` admits the loopback origins the
 * preview embeds and nothing else; `frame-ancestors 'none'` keeps a foreign
 * page from framing the dashboard.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The host names this server answers to. Anything else is DNS rebinding — a
 * page on another origin resolving its own name to 127.0.0.1 and talking to
 * this server from the browser's point of view as same-site.
 *
 * On port 80 the bare host is accepted, because a browser omits a default port.
 */
function hostAllowed(req: Request, origin: string): boolean {
  const header = req.headers.get('host');
  if (header === null) return false;
  const { port } = new URL(origin);
  // A browser omits a default port, so on 80 the bare host IS the right one and
  // the suffix is empty; one comparison covers both.
  const suffix = port === '' || port === '80' ? '' : `:${port}`;
  return header === `127.0.0.1${suffix}` || header === `localhost${suffix}`;
}

/** Whether a request carrying an Origin or a fetch-site hint came from somewhere else. */
function crossOrigin(req: Request, origin: string): boolean {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return true;
  const sent = req.headers.get('origin');
  if (sent === null) return false;
  const { port } = new URL(origin);
  const suffix = port === '' ? '' : `:${port}`;
  return sent !== `http://127.0.0.1${suffix}` && sent !== `http://localhost${suffix}`;
}

/**
 * `requireEnv`'s unset-variable clause, rewritten for the dashboard.
 *
 * The CLI's own remedy — set it, or remove the store block — is the terminal's
 * remedy, and the dashboard reads a site's connection from that checkout's own
 * files rather than from the environment the operator happens to be in. One
 * clause replaced for one; every other message passes through untouched, a
 * missing driver's among them.
 */
export function withEnvFilesHint(message: string): string {
  const clause = ' is unset — set it or remove the store block';
  return message.endsWith(clause)
    ? `${message.slice(0, -clause.length)} is unset — stet dev reads it from the checkout's .env and .env.local`
    : message;
}

/** The sites the workspace holds, each read from disk right now. */
function listing(ctx: DevContext): SiteState[] {
  return readWorkspace(ctx.workspaceFile).sites.map((entry) => loadSite(entry));
}

/** A site's listing row: everything but the two big forms, which `GET /api/site` carries. */
function summary(site: SiteState): Record<string, unknown> {
  if (site.state !== 'ready') return { ...site };
  const { descriptor: _descriptor, snapshot: _snapshot, config: _config, ...rest } = site;
  return rest;
}

/** A JSON object body, or `{}` where there is none — the mount's own posture. */
async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json();
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A required string body field, refused by name where it is missing or the wrong shape. */
function reqStr(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') throw new UsageError(`${field} is required`);
  return value;
}

/**
 * One promise chain per checkout. A save and a commit on one site never
 * interleave, and a Health run never reads a half-written batch; two different
 * sites do not block each other.
 *
 * The map belongs to the context rather than to the module: two servers in one
 * process are two workspaces, and a chain shared between them would make one
 * server's slow commit hold up the other's reads.
 */
function enqueue<T>(ctx: DevContext, path: string, fn: () => Promise<T>): Promise<T> {
  const queues = ctx.queues;
  const previous = queues.get(path) ?? Promise.resolve();
  // The chain never rejects: a failed request must not wedge the site's queue.
  const next = previous.then(fn, fn);
  queues.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * A route that names a site, run inside that site's queue.
 *
 * The path is resolved against the WORKSPACE first: a directory the operator
 * never added is 404 whatever else the request names, so the server cannot be
 * pointed at a checkout by a request alone.
 */
async function withSite(
  ctx: DevContext,
  url: URL,
  fn: (site: SiteState, entry: WorkspaceEntry) => Promise<Response>,
): Promise<Response> {
  const wanted = url.searchParams.get('site');
  const id = idSegment(url);
  const entry = readWorkspace(ctx.workspaceFile).sites.find((site) =>
    id === null ? site.path === wanted : siteId(site.path) === id,
  );
  if (entry === undefined) return json({ error: 'not a workspace site' }, 404);
  return enqueue(ctx, entry.path, () => fn(loadSite(entry), entry));
}

/** The `<id>` of a `/s/<id>/…` path, or null where the path is not one. */
function idSegment(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  return parts[0] === 's' && parts[1] !== undefined ? parts[1] : null;
}

export interface Captured {
  code: number;
  out: string[];
  err: string[];
  json?: unknown;
}

/**
 * One CLI command, run in this process against the site's own working
 * directory, environment and collecting sinks.
 *
 * Through `runCli` and never through a `runX` function: the dispatch is where a
 * `UsageError` becomes `usage: <message>` and exit 2 and a `CliError` becomes
 * `error: <message>` and exit 1, so a route that called the function directly
 * would have to re-map both and would drift from the terminal the first time
 * one of them changed. A non-zero code from a reporting command is the ordinary
 * case here, not an error reply.
 */
export async function captured(
  ctx: DevContext,
  argv: string[],
  site: { path: string },
  env?: string,
): Promise<Captured> {
  const sink: { out: string[]; err: string[] } = { out: [], err: [] };
  const io = siteIo(site.path, sink, {
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
  });
  const full = env === undefined ? argv : [...argv, '--env', env];
  const code = await runCli(full, io);
  if (!argv.includes('--json')) return { code, out: sink.out, err: sink.err };
  // The `--json` object is one `stdout` call, so the sink holds it whole.
  try {
    return { code, out: sink.out, err: sink.err, json: JSON.parse(sink.out.join('\n')) };
  } catch {
    return { code, out: sink.out, err: sink.err };
  }
}

/**
 * The handler. Dispatch, in order: the Host check on every request, the page,
 * the Bearer and origin checks on the API, then the route table.
 */
export function createDevHandler(ctx: DevContext): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // 1. Every request, before anything reads a path.
    if (!hostAllowed(req, ctx.origin)) return json({ error: 'wrong host' }, 403);

    const url = new URL(req.url);
    const path = url.pathname;

    // 2. The page: public html carrying no data, so no token is checked here.
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html')) {
      return pageResponse(ctx, req.method === 'HEAD');
    }

    const id = idSegment(url);
    const isMount = id !== null && url.pathname.split('/').filter(Boolean)[2] === 'api';
    const isStatic = id !== null && url.pathname.split('/').filter(Boolean)[2] === 'site';

    // 3. The API's two checks. The static files under `/s/<id>/site/` carry NO
    //    Bearer: a browser cannot attach an Authorization header to an iframe
    //    navigation or to the framed page's own asset requests, so a token
    //    there would blank the pane. They are guarded by the Host check above,
    //    by workspace membership, by path containment, and by the frame
    //    sandbox that keeps the served site from reading the token.
    if (path.startsWith('/api/') || isMount) {
      if (!bearerMatches(req, ctx.token)) return json({ error: 'unauthorized' }, 401);
      if (crossOrigin(req, ctx.origin)) return json({ error: 'cross-origin request refused' }, 403);
    }

    try {
      if (path.startsWith('/api/')) return await apiRoute(ctx, req, url, path.slice('/api/'.length));
      if (isMount) return await mountRoute(ctx, req, url);
      if (isStatic) return await staticRoute(ctx, req, url);
      return json({ error: 'not found' }, 404);
    } catch (error) {
      // The two classes, mapped in ONE place: no route decides its own status.
      if (error instanceof UsageError) return json({ error: error.message }, 400);
      if (error instanceof CliError) return json({ error: withEnvFilesHint(error.message) }, 409);
      // Never a stack: the page shows what comes back.
      return json({ error: (error as Error).message }, 500);
    }
  };
}

/** The page, with a fresh nonce and the headers that make it safe to serve. */
function pageResponse(ctx: DevContext, headOnly = false): Response {
  const nonce = randomBytes(16).toString('base64');
  return new Response(headOnly ? null : ctx.page.split('__STET_NONCE__').join(nonce), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': contentSecurityPolicy(nonce),
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

/** `/api/<route>`. */
async function apiRoute(ctx: DevContext, req: Request, url: URL, route: string): Promise<Response> {
  if (route === 'workspace' && req.method === 'GET') {
    return json({ editor: `dashboard:${osUser()}`, version: packageVersion(), sites: listing(ctx).map(summary) });
  }
  if (route === 'workspace/add' && req.method === 'POST') {
    const body = await readJson(req);
    const added = addSite(ctx.workspaceFile, reqStr(body, 'path'));
    return json({ added: added.added, path: added.path, sites: listing(ctx).map(summary) });
  }
  if (route === 'workspace/update' && req.method === 'POST') {
    const body = await readJson(req);
    updateSite(ctx.workspaceFile, reqStr(body, 'path'), {
      ...(typeof body['dev'] === 'string' ? { dev: body['dev'] } : {}),
      ...(typeof body['devCommand'] === 'string' ? { devCommand: body['devCommand'] } : {}),
      ...(typeof body['devStopCommand'] === 'string' ? { devStopCommand: body['devStopCommand'] } : {}),
      ...(typeof body['pushAfterCommit'] === 'boolean' ? { pushAfterCommit: body['pushAfterCommit'] } : {}),
    });
    return json({ sites: listing(ctx).map(summary) });
  }
  if (route === 'workspace/remove' && req.method === 'POST') {
    const body = await readJson(req);
    const path = reqStr(body, 'path');
    // A site that leaves the workspace takes its dev server with it.
    await stopChild(ctx, path);
    removeSite(ctx.workspaceFile, path);
    return json({ sites: listing(ctx).map(summary) });
  }
  return sitePathRoute(ctx, req, url, route);
}

/**
 * `/api/site/…` — everything that names one checkout. Each runs inside that
 * site's queue, so two requests against one checkout never interleave.
 */
async function sitePathRoute(ctx: DevContext, req: Request, url: URL, route: string): Promise<Response> {
  return withSite(ctx, url, async (site, entry) => {
    switch (`${req.method} ${route}`) {
      case 'GET site':
        return siteReply(site, entry);
      case 'POST site/save':
        return await save(ctx, req, site);
      case 'POST site/commit':
        return await commit(ctx, req, site);
      case 'POST site/push':
        return await push(site);
      case 'GET site/history':
        return history(site);
      case 'GET site/health':
        return await health(ctx, url, site);
      case 'GET site/seo':
        return await seo(ctx, site);
      case 'POST site/pages/declare':
        return await declarePages(req, site);
      case 'POST site/remove':
        return await removeKeys(ctx, req, site);
      case 'GET site/setup':
        return await setup(ctx, url, site);
      case 'GET site/verify':
        return await verify(ctx, site);
      case 'GET site/preview':
        return await preview(ctx, url, site, entry);
      case 'POST site/dev-start':
        return await devStart(ctx, site, entry);
      case 'POST site/dev-stop':
        return await devStop(ctx, site, entry);
      case 'GET site/dev-log':
        return await devLog(ctx, site, entry);
      default:
        return json({ error: 'not found' }, 404);
    }
  });
}

/** A site that is not loadable is answered with what it is, on every route that needs its forms. */
function requireReady(site: SiteState): Extract<SiteState, { state: 'ready' }> {
  if (site.state === 'ready') return site;
  throw new CliError(
    site.state === 'not-adopted'
      ? `${site.name} is not a stet project — run stet init in ${site.path}`
      : `${site.name} cannot be loaded: ${site.message}`,
  );
}

/**
 * The whole site: its forms, the projection of its config the page reads, and
 * its environments with each variable's name and whether the checkout's own
 * files set it.
 *
 * The environments are computed from the config and the files and never by
 * DIALING: a listing that opened a connection per environment would hang on
 * the first unreachable one, and `doctor` is where a live check belongs.
 */
function siteReply(site: SiteState, entry: WorkspaceEntry): Response {
  if (site.state !== 'ready') return json(summary(site));
  const { config } = site;
  const env = siteEnv(site.path);
  // `requireEnv`'s own rule: an empty value is unset. A `DATABASE_URL=` line
  // reads as unset here exactly as it does at the mount.
  const vars = (block: { urlEnv: string; tokenEnv: string } | undefined, adapter: string): Array<{ name: string; set: boolean }> => {
    if (block === undefined) return [];
    const names = adapter === 'postgrest' ? [block.urlEnv, block.tokenEnv] : adapter === 'pg' ? [block.urlEnv] : [];
    return names.filter((name) => name !== '').map((name) => ({ name, set: (env[name] ?? '') !== '' }));
  };
  const environments = [
    {
      name: 'default',
      adapter: config.store?.adapter ?? 'snapshot',
      vars: vars(config.store, config.store?.adapter ?? 'snapshot'),
    },
    ...Object.entries(config.environments ?? {}).map(([name, block]) => ({
      name,
      adapter: block.adapter,
      vars: vars(block, block.adapter),
    })),
  ];
  return json({
    ...summary(site),
    descriptor: site.descriptor,
    snapshot: site.snapshot,
    config: {
      locales: config.locales,
      ...(config.seoCheck === undefined ? {} : { seoCheck: config.seoCheck }),
      host: site.host,
      readPath: { file: config.readPath.file },
      descriptorPath: config.descriptorPath,
      snapshotPath: config.snapshotPath,
      managedSurfaces: config.managedSurfaces,
      store: { adapter: config.store?.adapter ?? 'snapshot' },
    },
    environments,
    dev: devDefaults(config, entry),
    entry,
  });
}

/**
 * One or more values through the CLI's save gate and then through its one
 * all-or-nothing write batch — the same pair `remove`, `pages scan --apply`,
 * `register` and `pull` go through.
 *
 * The gate runs over the snapshot with the WHOLE batch applied, not over the
 * committed one: a template's class rule reads the body while checking the
 * subject, so two slots saved together have to see each other. One value that
 * errors refuses the whole save, and nothing is written.
 */
async function save(ctx: DevContext, req: Request, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  if (ready.mode !== 'snapshot') {
    return json({ error: 'a store-backed site is edited through its mounted API — use Save draft' }, 409);
  }
  const body = await readJson(req);
  const values = body['values'];
  if (!Array.isArray(values) || values.length === 0) throw new UsageError('values is required');

  const { config, descriptor } = ready;
  const next = structuredClone(ready.snapshot);
  const edits: Array<{ key: string; locale: string; value: unknown }> = [];
  for (const raw of values) {
    if (typeof raw !== 'object' || raw === null) throw new UsageError('each value is { key, locale?, value }');
    const entry = raw as { key?: unknown; locale?: unknown; value?: unknown };
    const key = typeof entry.key === 'string' ? entry.key : '';
    const locale = typeof entry.locale === 'string' ? entry.locale : config.locales.default;
    if (!Object.hasOwn(descriptor.keys, key)) return json({ error: `undeclared key: ${key}` }, 400);
    if (!config.locales.enabled.includes(locale)) return json({ error: `locale ${locale} is not enabled` }, 400);
    (next[locale] ??= {})[key] = entry.value;
    edits.push({ key, locale, value: entry.value });
  }

  const gate = new Report();
  let ok = true;
  for (const edit of edits) {
    ok = validateValue(descriptor, next, edit.key, edit.value, edit.locale, gate) && ok;
  }
  if (!ok) return json({ error: 'refused by the save gate', findings: gate.findings }, 409);

  const report = new Report();
  const { written, unchanged } = applyForms(ready.path, config, descriptor, next, report, 'dashboard save');
  const touched = body['touch'] === false ? null : touchReadPath(ready);
  return json({
    written,
    unchanged,
    touched,
    findings: [...gate.findings, ...report.findings],
    at: gitState(ready.path),
  });
}

/**
 * The five repo forms, written in one all-or-nothing batch, with the batch's
 * own refusal raised under the caller's name.
 *
 * The two routes that rewrite the forms — a save and an applied removal — take
 * the same three steps in the same order, so they take them here.
 */
function applyForms(
  path: string,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  report: Report,
  label: string,
): { written: string[]; unchanged: string[] } {
  try {
    return writePlanned(planRepoForms(path, config, descriptor, snapshot, report));
  } catch (error) {
    rethrowBatchFailure(label, error);
    // `rethrowBatchFailure` always throws; TypeScript cannot see it.
    throw error;
  }
}

/**
 * The read-path file's modification time, moved.
 *
 * A running dev server holds the resolved map until the read file itself
 * changes, so a snapshot edit is not served until something touches it. The
 * per-request scaffold makes this redundant on a freshly scaffolded host and
 * never wrong on one scaffolded before it. An html host has no read path.
 */
function touchReadPath(site: Extract<SiteState, { state: 'ready' }>): string | null {
  if (site.host === 'html') return null;
  // Through the same containment the static arm uses: a config naming a path
  // outside its own checkout would otherwise have the dashboard move an
  // unrelated file's stamp on every save.
  const file = insideCheckout(site.path, join(site.path, site.config.readPath.file));
  if (file === null) return null;
  const now = new Date();
  utimesSync(file, now, now);
  return site.config.readPath.file;
}

/**
 * The batch's own files, staged and committed — and nothing else in the working
 * tree.
 *
 * Every named file must be one of the labels the repo-form batch would produce
 * right now, so a request naming an unrelated file cannot make the dashboard
 * commit it; the pathspec form then commits exactly those paths whatever the
 * index already holds.
 */
async function commit(ctx: DevContext, req: Request, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const body = await readJson(req);
  const files = body['files'];
  const keys = body['keys'];
  if (!Array.isArray(files) || files.length === 0) throw new UsageError('files is required');
  if (!Array.isArray(keys) || keys.length === 0) throw new UsageError('keys is required');

  const labels = stetWrittenForms(
    ready,
    files.filter((file): file is string => typeof file === 'string'),
  );
  for (const file of files) {
    if (typeof file !== 'string' || !labels.has(file)) {
      return json({ error: `${String(file)} is not a stet-written form of this site` }, 400);
    }
  }

  const named = keys.map((key) => String(key));
  const message =
    typeof body['message'] === 'string' && body['message'] !== ''
      ? body['message']
      : clipTo72(`stet: ${plural(named.length, 'key')} updated — ${named.join(', ')}`);

  // Through the async twin: a pre-commit hook that runs a real check would
  // otherwise block the page and every other checkout for as long as it ran.
  const staged = await gitRun(ready.path, ['add', '--', ...(files as string[])]);
  if (staged.code !== 0) return json({ error: 'git commit failed', output: staged.out }, 409);
  const made = await gitRun(ready.path, ['commit', '-m', message, '--', ...(files as string[])]);
  if (made.code !== 0) return json({ error: 'git commit failed', output: made.out }, 409);

  return json({
    sha: git(ready.path, ['rev-parse', 'HEAD']).out.trim(),
    short: git(ready.path, ['rev-parse', '--short', 'HEAD']).out.trim(),
    subject: git(ready.path, ['log', '-1', '--format=%s']).out.trim(),
    at: gitState(ready.path),
  });
}

/**
 * Which of the NAMED files stet may write on this site.
 *
 * Not from a plan: `planRepoForms` yields a write only where the file would
 * CHANGE, and on the static-HTML host a document the save just made current has
 * no plan entry at all. Deriving the set from a plan therefore refused the
 * commit of exactly the document the save had written — the html half of
 * journeys B17 and A17 could not be committed from the page.
 *
 * The enumeration is the one `planRepoForms` itself walks, so the two cannot
 * drift: the descriptor, the snapshot, and then either the marked documents or
 * the codegen trio.
 *
 * Scoped to the request's own files because the html arm PARSES what it
 * answers about, and parsing a whole checkout of documents on every commit
 * holds the event loop for as long as it takes — half a second on five hundred
 * documents, which is exactly what the async git was made to stop. The answer
 * is unchanged by the scoping: a file the managed surfaces do not match is
 * never parsed and never accepted either way.
 */
function stetWrittenForms(site: Extract<SiteState, { state: 'ready' }>, files: string[]): Set<string> {
  const { config } = site;
  const labels = new Set([config.descriptorPath, config.snapshotPath]);
  if (site.host !== 'html') {
    for (const form of [config.codegen.registry, config.codegen.dts, config.codegen.defaults]) labels.add(form);
    return labels;
  }
  // The documents are NOT every file `managedSurfaces` matches: that set holds
  // html this project wrote by hand, and committing one of those under a
  // `stet:` subject would carry unrelated work with it. A document carrying a
  // mark is one stet regenerates, which is a property of the file rather than
  // of this process's memory — so a document written by a previous run is
  // still committable after a restart.
  const managed = filesForGlobs(site.path, config.managedSurfaces).filter((file) => files.includes(file));
  for (const mark of proposeHtml(site.path, managed).claimed) labels.add(mark.file);
  return labels;
}

/** A commit subject, held to one readable line. *//** A commit subject, held to one readable line. */
function clipTo72(text: string): string {
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`;
}

/** `git push`, and git's own answer either way. */
async function push(site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const pushed = await gitRun(ready.path, ['push']);
  if (pushed.code !== 0) return json({ error: 'git push failed', output: pushed.out }, 409);
  return json({ output: pushed.out, at: gitState(ready.path) });
}

/**
 * The commits that touched the snapshot — and, on an html host, the documents
 * beside it. Git has no per-key history, and the page labels the table as what
 * it is. A store-backed site's history is the mount's.
 */
function history(site: SiteState): Response {
  const ready = requireReady(site);
  if (ready.mode !== 'snapshot') return json({ mount: `/s/${ready.id}/api/stet/history` });
  // The globs go to git AS globs: an expanded file list is one argv entry per
  // document, which a static site of any size pushes past the argv limit.
  const paths = [
    ready.config.snapshotPath,
    ...(ready.host === 'html' ? ready.config.managedSurfaces.map((glob) => `:(glob)${glob}`) : []),
  ];
  const log = git(ready.path, [
    'log',
    '-n',
    '20',
    '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s',
    '--',
    ...paths,
  ]);
  if (log.code !== 0) return json({ commits: [] });
  const commits = log.out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha, short, author, at, subject] = line.split('\u001f');
      return { sha, short, author, at, subject };
    });
  return json({ commits });
}

/**
 * `/s/<id>/api/stet/<route>` — the package's own mounted handler over this
 * site's store.
 *
 * The request is forwarded AS IS: the mount reads the last path segment, so the
 * mount point is transparent to it. Its Bearer is the run token through
 * `STET_DEV_TOKEN`, which `runDev` set in this process's environment before the
 * server started; the site's own `apiTokenEnv` is never read, because the
 * dashboard is not the site's production API.
 */
async function mountRoute(ctx: DevContext, req: Request, url: URL): Promise<Response> {
  return withSite(ctx, url, async (site) => {
    const ready = requireReady(site);
    const handler = createStetHandler({
      store: await storeOf(ctx, ready, envOf(url)),
      descriptor: ready.descriptor,
      auth: 'STET_DEV_TOKEN',
    });
    if (req.method === 'GET') return handler.GET(req);
    if (req.method === 'POST') return handler.POST(req);
    return json({ error: 'not found' }, 404);
  });
}

/**
 * The adapter for one site and one environment, built once and kept.
 *
 * `resolveStore` selects the block first, so an undeclared `?env=` name is
 * `selectStoreBlock`'s own usage error and reaches the caller as a 400; an
 * unset connection variable or a missing driver is a `CliError` and reaches it
 * as a 409, its message dressed with the two files the dashboard actually
 * reads. The environment handed over is the CHECKOUT's, never this process's.
 */
async function storeOf(
  ctx: DevContext,
  site: Extract<SiteState, { state: 'ready' }>,
  env: string | undefined,
): Promise<StoreAdapter> {
  // A separator a path can contain is not a key: `/a b` with no environment and
  // `/a` with environment `b` would share one. JSON's own escaping is.
  const key = JSON.stringify([site.path, env ?? null]);
  const held = ctx.stores.get(key);
  if (held !== undefined) return held;
  const store = await resolveStore(site.config, siteEnv(site.path), ctx.storeFor?.(site.path, env), env);
  ctx.stores.set(key, store);
  return store;
}

/**
 * `/s/<id>/site/<path>` — a static-HTML checkout's own documents, read-only.
 *
 * No Bearer is checked here, and the reason is structural: a browser cannot
 * attach an Authorization header to an iframe navigation or to the framed
 * page's own script and image requests, so a token on this route would blank
 * the pane. What guards it instead is the Host check every request passes,
 * membership of the workspace, path containment checked on the REAL path, and
 * the frame sandbox that denies the served page an origin of its own.
 *
 * Stated limit: a root-absolute reference in the page (`src="/x.png"`) resolves
 * against the dashboard's root rather than the site's and is not served here;
 * a relative one works.
 */
async function staticRoute(ctx: DevContext, req: Request, url: URL): Promise<Response> {
  return withSite(ctx, url, async (site) => {
    if (site.state !== 'ready' || site.host !== 'html') return json({ error: 'not found' }, 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'not found' }, 404);

    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).slice(3).map(decodeURIComponent);
    } catch {
      // A malformed percent-escape is a path this server does not have, the
      // same as every other one it cannot resolve.
      return json({ error: 'not found' }, 404);
    }
    // A checkout holds more than its documents. A dot-leading segment is the
    // whole `.env`/`.git` family and `node_modules` is the other bulk of it;
    // neither is ever a page, and the route carries no Bearer.
    if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) {
      return json({ error: 'not found' }, 404);
    }
    const file = insideCheckout(site.path, resolvePath(site.path, ...parts));
    if (file === null) return json({ error: 'not found' }, 404);

    const body = readFileSync(file);
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), {
      status: 200,
      headers: { 'content-type': contentTypeOf(file), 'cache-control': 'no-store' },
    });
  });
}

/**
 * A path inside the checkout that names a readable file, or null.
 *
 * The containment test runs on the REAL path, so `..`, an absolute segment and
 * a symlink pointing out of the checkout are all one refusal. A directory
 * serves its `index.html` and nothing else — there is no listing.
 */
export function insideCheckout(root: string, target: string): string | null {
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(statSync(target).isDirectory() ? join(target, 'index.html') : target);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The types a static site is served as. Anything else is bytes. */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  map: 'application/json',
};

function contentTypeOf(file: string): string {
  const dot = file.lastIndexOf('.');
  const extension = dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** How long the preview probe waits before it answers down. */
const PROBE_MS = 1_500;

/**
 * Whether the site's dev server answers, under a short deadline.
 *
 * The fetch's own abort signal is RACED against the route's own timer: an
 * implementation that ignores the signal — a fake among them — must still
 * settle the route. Any response at all is up; only a throw or the deadline is
 * down, because a dev server answering 404 on the selected route is still a
 * dev server.
 */
async function probe(ctx: DevContext, target: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_MS);
  });
  try {
    let answered: Promise<boolean>;
    try {
      answered = Promise.resolve(
        ctx.fetchImpl(target, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_MS), redirect: 'manual' }),
      ).then(
        () => true,
        () => false,
      );
    } catch {
      return false;
    }
    return await Promise.race([answered, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Where the preview pane points, and whether anything is there.
 *
 * A static-HTML site has no dev server at all: the dashboard serves the
 * checkout itself, so the pane's URL is this server's own and it is always up.
 */
async function preview(
  ctx: DevContext,
  url: URL,
  site: SiteState,
  entry: WorkspaceEntry,
): Promise<Response> {
  const ready = requireReady(site);
  const route = url.searchParams.get('route') ?? '/';
  if (ready.host === 'html') {
    return json({ url: `${ctx.origin}/s/${ready.id}/site${route}`, up: true, static: true });
  }
  const defaults = devDefaults(ready.config, entry);
  if (defaults === null) return json({ error: 'this site has no dev server' }, 400);
  // The route is refused before it is used, not after: `new URL(route, base)`
  // lets `//example.com/` or an absolute URL REPLACE the base, which would turn
  // the probe into an outbound fetch and a local port scanner. A scheme, a
  // protocol-relative `//` and a Windows `\\` are the three spellings that
  // carry a host; everything else is a path. The entry's own `dev` is
  // loopback-checked when it is set, so the base keeps the probe there.
  if (ABSOLUTE_ROUTE.test(route) || route.startsWith('//') || route.startsWith('\\\\')) {
    return json({ error: 'route must be a path on the dev server' }, 400);
  }
  const target = new URL(defaults.dev);
  target.pathname = route.startsWith('/') ? route : `/${route}`;
  target.search = '';
  target.hash = '';
  return json({
    url: target.toString(),
    up: await probe(ctx, target.toString()),
    start: defaults.devCommand,
    source: defaults.source,
    router: ready.config.router,
  });
}

/** A route that names a scheme rather than a path — `https:`, `javascript:`, `file:`. */
const ABSOLUTE_ROUTE = /^[a-z][a-z0-9+.-]*:/i;

/** How much of a child's output is kept for the log pane. */
const LOG_LINES = 200;

/** A child's state as the page reads it. */
function childReply(child: DevChild): Record<string, unknown> {
  return {
    running: child.state === 'running',
    state: child.state,
    pid: child.pid,
    command: child.command,
    code: child.code,
    lines: child.lines,
  };
}

/**
 * The site's own dev command, started in its own process group.
 *
 * `shell: true` is deliberate: the command string is the operator's own, from a
 * file only they write, run in their own checkout — a shell is the intended
 * interpreter, and `npm run dev` is a compound command in the first place.
 * `detached: true` gives it a process group, which is the only way to end a
 * launcher's whole tree.
 */
async function devStart(ctx: DevContext, site: SiteState, entry: WorkspaceEntry): Promise<Response> {
  const ready = requireReady(site);
  const held = ctx.children.get(ready.path);
  if (held !== undefined && held.state === 'running') return json(childReply(held));

  const defaults = devDefaults(ready.config, entry);
  const command = entry.devCommand ?? defaults?.devCommand;
  if (command === undefined) {
    return json({ error: 'the workspace entry has no dev command — set it in Setup' }, 400);
  }
  const spawned = spawn(command, {
    cwd: ready.path,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
  });
  const stop = entry.devStopCommand ?? defaults?.devStopCommand;
  const child: DevChild = {
    pid: spawned.pid ?? 0,
    command,
    lines: [],
    state: 'running',
    code: null,
    ...(stop === undefined ? {} : { stop }),
    handle: spawned,
  };
  const keep = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      child.lines.push(line);
    }
    if (child.lines.length > LOG_LINES) child.lines.splice(0, child.lines.length - LOG_LINES);
  };
  spawned.stdout?.on('data', keep);
  spawned.stderr?.on('data', keep);
  spawned.on('exit', (code) => {
    child.state = 'exited';
    child.code = code;
  });
  spawned.on('error', (error) => {
    child.state = 'exited';
    child.lines.push(error.message);
  });
  ctx.children.set(ready.path, child);
  return json(childReply(child));
}

/** The child's output so far, and what it turned out to be. */
async function devLog(ctx: DevContext, site: SiteState, entry: WorkspaceEntry): Promise<Response> {
  const ready = requireReady(site);
  const child = ctx.children.get(ready.path);
  if (child === undefined) return json({ running: false, state: 'none', lines: [] });
  await settleDetached(ctx, ready, entry, child);
  return json(childReply(child));
}

/**
 * A launcher that exited while its server still answers is DETACHED, not gone.
 *
 * Astro 7 daemonises itself when it detects an agent environment, leaving a
 * server with its own process group that no child handle reaches. Calling that
 * `exited` would tell the operator the site is down while it is serving, and
 * would offer a Start button that then fails on a taken port.
 */
async function settleDetached(
  ctx: DevContext,
  site: Extract<SiteState, { state: 'ready' }>,
  entry: WorkspaceEntry,
  child: DevChild,
): Promise<void> {
  if (child.state !== 'exited' || child.checked === true) return;
  child.checked = true;
  const defaults = devDefaults(site.config, entry);
  if (defaults === null) return;
  if (await probe(ctx, defaults.dev)) child.state = 'detached';
}

/**
 * The child's whole process group, ended — `SIGTERM`, two seconds, then
 * `SIGKILL` for whatever is still alive. A dev server that traps `SIGTERM`
 * would otherwise keep its port and the next Start would fail on it.
 *
 * Where the group is already gone and the server is still answering, the
 * entry's own stop command is what ends it.
 */
async function devStop(ctx: DevContext, site: SiteState, entry: WorkspaceEntry): Promise<Response> {
  const ready = requireReady(site);
  const child = ctx.children.get(ready.path);
  if (child === undefined) return json({ running: false, state: 'none', lines: [] });
  await settleDetached(ctx, ready, entry, child);
  const ended = await endChild(child);
  if (!ended) {
    const stop = child.stop;
    if (stop === undefined) {
      return json({
        ...childReply(child),
        error: 'this dev server outlived its launcher and the workspace entry names no stop command — set one in Setup',
      });
    }
    spawnSync(stop, { cwd: ready.path, shell: true, stdio: 'ignore', env: childEnv() });
  }
  ctx.children.delete(ready.path);
  return json({ running: false, state: 'stopped', lines: child.lines });
}

/** Whether the group was there to end. */
async function endChild(child: DevChild): Promise<boolean> {
  if (child.pid === 0) return false;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return false;
  }
  if (await gone(child.pid, 2_000)) return true;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  // SIGKILL is delivered asynchronously: without this the caller can answer
  // "stopped" while the port is still held.
  await gone(child.pid, 2_000);
  return true;
}

/** Whether a process group has emptied, within a deadline. */
async function gone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Every child this run started, ended. Called by the server's own `close()`, so
 * a dev server the dashboard launched never outlives the dashboard.
 */
export async function stopEveryChild(ctx: DevContext): Promise<void> {
  for (const path of [...ctx.children.keys()]) await stopChild(ctx, path);
}

/** One site's child, ended. The one door to the kill, so nothing else spells it out. */
async function stopChild(ctx: DevContext, path: string): Promise<void> {
  const child = ctx.children.get(path);
  if (child === undefined) return;
  await endChild(child);
  ctx.children.delete(path);
}

/** The `?env=` selector, where a route takes one. */
function envOf(url: URL): string | undefined {
  return url.searchParams.get('env') ?? undefined;
}

/**
 * Health: `check` as a function, and `doctor`, `scan` and — on a store-backed
 * site — `audit` through the CLI's own dispatch, all in this process.
 *
 * `doctor` runs in HUMAN mode on purpose: the wrapper-chain, config and
 * generated-file facts are lines its `--json` form does not carry, so the card
 * shows what the terminal shows. The commit stamp is taken once, before the
 * runs, and rides the reply — every badge the page paints names the commit it
 * was measured against.
 */
async function health(ctx: DevContext, url: URL, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const env = envOf(url);
  const at = gitState(ready.path);
  const doctor = await captured(ctx, ['doctor'], ready, env);
  const report = new Report();
  check(ready.config, ready.path, report);
  const scan = await captured(ctx, ['scan', '--json'], ready);
  const audit = ready.mode === 'snapshot' ? null : (await captured(ctx, ['audit', '--json'], ready, env)).json;
  return json({
    at,
    doctor: {
      code: doctor.code,
      out: doctor.out.map(withEnvFilesHint),
      err: doctor.err.map(withEnvFilesHint),
    },
    check: report.findings,
    scan: scan.json ?? null,
    audit,
  });
}

/** The SEO findings and the routes no page record claims, as the two commands report them. */
async function seo(ctx: DevContext, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const rules = await captured(ctx, ['seo', 'check', '--json'], ready);
  const pages = await captured(ctx, ['pages', 'scan', '--json'], ready);
  return json({ seo: rules.json ?? null, pages: pages.json ?? null });
}

/**
 * The pages the SEO tab offered, declared — the same apply `pages scan --apply`
 * runs, over the names chosen. An empty list declares every proposal, as the
 * command's bare `--apply` does.
 */
async function declarePages(req: Request, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const body = await readJson(req);
  const raw = body['names'];
  const names = Array.isArray(raw) ? raw.map((name) => String(name)) : [];

  const set = proposeForHost(ready.path, ready.config, ready.descriptor);
  if (set === null) {
    return json({ error: 'no routing convention detected — expected src/pages, app/ or pages/' }, 400);
  }
  const report = new Report();
  applyPages(ready.path, ready.config, ready.descriptor, ready.snapshot, set, names, report);
  const touched = touchReadPath(ready);
  return json({ lines: linesOf(report), findings: report.findings, touched, at: gitState(ready.path) });
}

/**
 * A key's removal — the terminal's own plan, and the same batch behind
 * `--write`. The plan writes nothing; `apply` writes the five repo forms in one
 * go, as `stet remove --write` does.
 */
async function removeKeys(ctx: DevContext, req: Request, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const body = await readJson(req);
  const raw = body['keys'];
  if (!Array.isArray(raw) || raw.length === 0) throw new UsageError('keys is required');
  const keys = [...new Set(raw.map((key) => String(key)))];

  const report = new Report();
  let cleaned;
  let cleanedSnapshot;
  try {
    ({ cleaned, cleanedSnapshot } = planRemoval(ready.path, ready.config, ready.descriptor, ready.snapshot, keys, report));
  } catch (error) {
    // An unknown key is the caller naming something that is not there.
    if (error instanceof CliError) return json({ error: error.message }, 400);
    throw error;
  }
  if (body['apply'] !== true) {
    return json({ applied: false, lines: linesOf(report), findings: report.findings });
  }
  const { written, unchanged } = applyForms(
    ready.path,
    ready.config,
    cleaned,
    cleanedSnapshot,
    report,
    'dashboard remove',
  );
  return json({
    applied: true,
    lines: linesOf(report),
    findings: report.findings,
    written,
    unchanged,
    touched: touchReadPath(ready),
    at: gitState(ready.path),
  });
}

/**
 * What `stet upgrade` would do, without doing it. Applying stays in the
 * terminal, and the card says so.
 *
 * `upgrade` has no `--json`, so the findings arrive as formatted strings on the
 * error channel; the field is named `stderr` rather than `findings`, which
 * every other card reads as records.
 */
async function setup(ctx: DevContext, url: URL, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const run = await captured(ctx, ['upgrade', '--dry-run'], ready, envOf(url));
  return json({ lines: run.out, stderr: run.err.map(withEnvFilesHint), code: run.code });
}

/** `email verify`'s verdict per template, on demand. */
async function verify(ctx: DevContext, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const run = await captured(ctx, ['email', 'verify', '--json'], ready);
  return json(run.json ?? { templates: [] });
}

/**
 * A report's human LINES, without its findings. `Report.lines` is private, so
 * the channel is read the way every other reader reads it: through `emit` into
 * a sink that collects.
 */
function linesOf(report: Report): string[] {
  const out: string[] = [];
  report.emit({ stdout: (line) => out.push(line), stderr: () => {} });
  return out;
}

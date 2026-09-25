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

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { join, posix, resolve as resolvePath, sep } from 'node:path';

import { bearerMatches, createStetHandler } from '../server/mount.js';
import { route as normalizeRoute } from '../src/seo.js';
import { keyDefOf, loadDescriptor } from '../src/descriptor.js';
import { resolve } from '../src/resolve.js';
import { loadSnapshot, type Snapshot } from '../src/snapshot.js';
import type { StoreAdapter } from '../src/store.js';
import type { Descriptor } from '../src/types.js';
import { planRepoForms, rethrowBatchFailure, writePlanned } from './artifacts.js';
import { check } from './check.js';
import type { StetConfig } from './config.js';
import { filesForGlobs, staticPrefix } from './files.js';
import { git, gitData, gitRun, gitState, operationInProgress, uncommittedPaths } from './git.js';
import { isHeadText, lineIndex, metaCopyName, proposeHtml, readDocument, type Document, type Element } from './html-host.js';
import { runCli, type CliIo } from './main.js';
import { applyPages, fileRoute, proposeForHost } from './pages.js';
import { planRemoval } from './remove.js';
import { blankNonMarkup, dialectOf, matchGlob, type Dialect } from './source-scan.js';
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
import { packageRoot, packageVersion } from './installed.js';
import { gone } from './liveness.js';
import { injectAgent, startPreviewProxy, type PreviewProxy } from './preview-proxy.js';

/** A dev-server child the dashboard started: Start creates it, and the context holds it until Stop, the site's removal or the server's close ends it. */
export interface DevChild {
  pid: number;
  command: string;
  lines: string[];
  state: 'running' | 'exited' | 'detached';
  code: number | null;
  /** The entry's stop command, for a server that outlived its launcher. */
  stop?: string;
  /** The dev URL at Start, which the stop path polls until the server lets go of it. */
  dev?: string;
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
  /** One preview proxy per JavaScript site, keyed by checkout, started on its first answering probe. */
  proxies?: Map<string, PreviewProxy>;
  /** The run's preview channel, minted on first use. */
  previewChannel?: string;
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

    // The preview agent: public script carrying no data, loaded by the static
    // pane's documents, whose sandboxed frame can send no token.
    if ((req.method === 'GET' || req.method === 'HEAD') && path === PREVIEW_AGENT_ROUTE) {
      return new Response(req.method === 'HEAD' ? null : agentScript(), {
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
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
    await closeProxy(ctx, path);
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
      case 'GET site/marks':
        return marks(site);
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
    pending: pendingForms(site),
  });
}

/**
 * One or more values, and derived keys' templates, through the CLI's save gate
 * and then through its one all-or-nothing write batch — the same pair `remove`,
 * `pages scan --apply`, `register` and `pull` go through.
 *
 * The gate runs over the snapshot with the WHOLE batch applied, not over the
 * committed one: a template's class rule reads the body while checking the
 * subject, so two slots saved together have to see each other. One value that
 * errors refuses the whole save, and nothing is written.
 *
 * A derived key takes no value of its own — its text is its source's through
 * its template, and the template is what a save changes. Each derived key the
 * batch moves, by a new template or a new source value, is gated on the text it
 * now resolves to, so a headline edit that pushes a share description past its
 * limit is refused like the description itself.
 */
async function save(ctx: DevContext, req: Request, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  if (ready.mode !== 'snapshot') {
    return json({ error: 'a store-backed site is edited through its mounted API — use Save draft' }, 409);
  }
  const body = await readJson(req);
  const values = body['values'] ?? [];
  const templates = body['templates'] ?? [];
  if (!Array.isArray(values) || !Array.isArray(templates) || values.length + templates.length === 0) {
    throw new UsageError('values or templates is required');
  }

  const { config } = ready;
  const descriptor = structuredClone(ready.descriptor);
  const next = structuredClone(ready.snapshot);
  const edits: Array<{ key: string; locale: string; value: unknown }> = [];
  for (const raw of values) {
    if (typeof raw !== 'object' || raw === null) throw new UsageError('each value is { key, locale?, value }');
    const entry = raw as { key?: unknown; locale?: unknown; value?: unknown };
    const key = typeof entry.key === 'string' ? entry.key : '';
    const locale = typeof entry.locale === 'string' ? entry.locale : config.locales.default;
    if (!Object.hasOwn(descriptor.keys, key)) return json({ error: `undeclared key: ${key}` }, 400);
    const from = descriptor.keys[key]?.derivesFrom;
    if (from !== undefined) return json({ error: `${key} derives from ${from} — edit its template instead` }, 400);
    if (!config.locales.enabled.includes(locale)) return json({ error: `locale ${locale} is not enabled` }, 400);
    (next[locale] ??= {})[key] = entry.value;
    edits.push({ key, locale, value: entry.value });
  }
  const retemplated: string[] = [];
  for (const raw of templates) {
    if (typeof raw !== 'object' || raw === null) throw new UsageError('each template is { key, tmpl }');
    const entry = raw as { key?: unknown; tmpl?: unknown };
    const key = typeof entry.key === 'string' ? entry.key : '';
    const def = keyDefOf(descriptor, key);
    if (def === undefined) return json({ error: `undeclared key: ${key}` }, 400);
    if (def.derivesFrom === undefined) return json({ error: `${key} is not a derived key` }, 400);
    if (typeof entry.tmpl !== 'string' || entry.tmpl.split('{v}').length !== 2) {
      return json({ error: `the template of ${key} must hold {v} exactly once` }, 400);
    }
    def.tmpl = entry.tmpl;
    retemplated.push(key);
  }

  const gate = new Report();
  let ok = true;
  for (const edit of edits) {
    ok = validateValue(descriptor, next, edit.key, edit.value, edit.locale, gate) && ok;
  }
  // Every derived key whose text this batch moves — through a new template, a
  // new source value, or a source that is itself moved — in every locale.
  const moved = new Set([...edits.map((edit) => edit.key), ...retemplated]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [key, def] of Object.entries(descriptor.keys)) {
      if (def.derivesFrom === undefined || moved.has(key) || !moved.has(def.derivesFrom)) continue;
      moved.add(key);
      grew = true;
    }
  }
  // Each is gated where its text changes, so a locale's own earlier overrun
  // never refuses an edit that leaves it alone, and a locale that falls back to
  // another's text is gated once.
  for (const key of [...moved].sort()) {
    if (descriptor.keys[key]?.derivesFrom === undefined) continue;
    const gated = new Set<unknown>();
    for (const locale of config.locales.enabled) {
      const text = resolve(descriptor, next, null, { key, locale }).value;
      const was = resolve(ready.descriptor, ready.snapshot, null, { key, locale }).value;
      if (text === undefined || text === was || gated.has(text)) continue;
      gated.add(text);
      ok = validateValue(descriptor, next, key, text, locale, gate) && ok;
    }
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
    pending: pendingForms(ready),
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

/** A ready site, as every route past `requireReady` holds it. */
type Ready = Extract<SiteState, { state: 'ready' }>;

/**
 * The stet-written forms git reports as uncommitted, staged and committed —
 * and nothing else in the working tree.
 *
 * The list is read from git when the commit runs, not taken from the page: a
 * list gone stale since the page last asked would otherwise commit a deletion
 * or a file already committed in the terminal. Every name reaches git as a
 * literal pathspec, and every refusal carries the list as it now stands.
 */
async function commit(ctx: DevContext, req: Request, site: SiteState): Promise<Response> {
  const ready = requireReady(site);
  const body = await readJson(req);
  const files = body['files'];
  const keys = body['keys'];
  // Every refusal carries the list as git reads it now, so the page never
  // keeps offering a Commit the server just refused.
  const refuse = (error: string, status: number, output?: string): Response =>
    json({ error, ...(output === undefined ? {} : { output }), pending: pendingForms(ready) }, status);
  if (!Array.isArray(files) || files.length === 0) return refuse('files is required', 400);
  // `git add` would stage the forms into the operation's own index — a merge
  // commit would then carry the stet edit — and mid-rebase the commit would
  // land inside it.
  if (operationInProgress(ready.path)) {
    return refuse('a merge, cherry-pick, revert or rebase is in progress — finish it in the terminal', 409);
  }

  // Read from git now, not from the page's last reply: a list gone stale since
  // would otherwise commit a deletion or a file already committed elsewhere.
  const pending = pendingForms(ready);
  for (const file of files) {
    if (typeof file === 'string' && pending.includes(file)) continue;
    const form = typeof file === 'string' && stetWrittenForms(ready, [file]).has(file);
    return refuse(form ? `${String(file)} has nothing to commit` : `${String(file)} is not a stet-written form of this site`, 400);
  }
  const named = files as string[];

  // The keys the caller names, else — when the snapshot or the descriptor is in
  // the commit — the keys whose value it changes, a derived key's included; a
  // commit carrying neither names its files.
  const subject =
    Array.isArray(keys) && keys.length > 0
      ? keys.map((key) => String(key))
      : named.includes(gitSpelling(ready.config.snapshotPath)) || named.includes(gitSpelling(ready.config.descriptorPath))
        ? changedKeys(ready, named)
        : [];
  const message =
    typeof body['message'] === 'string' && body['message'] !== ''
      ? body['message']
      : clipTo72(
          subject.length > 0
            ? `stet: ${plural(subject.length, 'key')} updated — ${subject.join(', ')}`
            : `stet: ${plural(named.length, 'file')} updated — ${named.join(', ')}`,
        );

  // Through the async twin: a pre-commit hook that runs a real check would
  // otherwise block the page and every other checkout for as long as it ran.
  // Each name literal: a document named `p[ab].html` is that file, never a
  // pattern that stages an unrelated `pb.html`. Per path, not git's global
  // `--literal-pathspecs`, which exports GIT_LITERAL_PATHSPECS to the
  // operator's hook and blinds every glob it selects staged files with.
  //
  // Nothing is staged into the operator's index: `add -N` records only that an
  // untracked form will be added (a tracked one is left as it is), and a commit
  // limited to paths builds its own index. A hook that refuses the commit then
  // leaves the forms unstaged, and the operator's next commit never carries them.
  const literal = named.map((file) => `:(literal)${file}`);
  const intent = await gitRun(ready.path, ['add', '-N', '--', ...literal]);
  if (intent.code !== 0) return refuse('git commit failed', 409, intent.out);
  const made = await gitRun(ready.path, ['commit', '-m', message, '--', ...literal]);
  if (made.code !== 0) return refuse('git commit failed', 409, made.out);

  return json({
    sha: git(ready.path, ['rev-parse', 'HEAD']).out.trim(),
    short: git(ready.path, ['rev-parse', '--short', 'HEAD']).out.trim(),
    subject: git(ready.path, ['log', '-1', '--format=%s']).out.trim(),
    at: gitState(ready.path),
    pending: pendingForms(ready),
  });
}

/** A form as HEAD holds it, through its loader; null where HEAD does not hold it or the loader refuses it. */
function formAtHead<T>(site: Ready, path: string, load: (raw: unknown) => T): T | null {
  const found = gitData(site.path, ['show', `HEAD:./${gitSpelling(path)}`]);
  if (found.code !== 0) return null;
  try {
    return load(JSON.parse(found.stdout));
  } catch {
    return null;
  }
}

/**
 * The keys whose value the commit changes: between HEAD's forms and the forms
 * as the commit leaves them — the disk's for the snapshot and the descriptor
 * where `named` carries them, HEAD's where it does not — a literal key's value
 * in any locale, and a derived key's resolution, which a template edit or a
 * source edit moves. A snapshot HEAD does not hold, or one `loadSnapshot`
 * refuses — a locale block that is `null`, which is exactly the commit that
 * repairs it — makes every key on disk a change; a descriptor HEAD does not
 * hold, or one `loadDescriptor` refuses, is read as the one on disk.
 */
function changedKeys(site: Ready, named: string[]): string[] {
  const committed: Snapshot = formAtHead(site, site.config.snapshotPath, loadSnapshot) ?? {};
  const described: Descriptor = formAtHead(site, site.config.descriptorPath, loadDescriptor) ?? site.descriptor;
  // A form the commit leaves out stays as HEAD has it.
  const snapshot = named.includes(gitSpelling(site.config.snapshotPath)) ? site.snapshot : committed;
  const descriptor = named.includes(gitSpelling(site.config.descriptorPath)) ? site.descriptor : described;
  const own = (block: Record<string, unknown> | undefined, key: string): unknown =>
    block !== undefined && Object.hasOwn(block, key) ? block[key] : undefined;
  const keys = new Set<string>();
  for (const locale of new Set([...Object.keys(committed), ...Object.keys(snapshot)])) {
    const a = Object.hasOwn(committed, locale) ? committed[locale] : undefined;
    const b = Object.hasOwn(snapshot, locale) ? snapshot[locale] : undefined;
    for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      if (JSON.stringify(own(a, key)) !== JSON.stringify(own(b, key))) keys.add(key);
    }
  }
  for (const [key, def] of Object.entries(descriptor.keys)) {
    if (def.derivesFrom === undefined) continue;
    for (const locale of site.config.locales.enabled) {
      const was = resolve(described, committed, null, { key, locale }).value;
      const is = resolve(descriptor, snapshot, null, { key, locale }).value;
      if (JSON.stringify(was) !== JSON.stringify(is)) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * The forms stet writes on this site, enumerated once for the commit's accept
 * set and the pending list: the descriptor and the snapshot, then either the
 * codegen trio or — on the static-HTML host — the managed globs whose marked
 * documents count.
 */
function stetFormPaths(site: Ready): { files: string[]; globs: string[] } {
  const { config } = site;
  if (site.host === 'html') {
    return { files: [config.descriptorPath, config.snapshotPath].map(gitSpelling), globs: config.managedSurfaces };
  }
  return {
    files: [
      config.descriptorPath,
      config.snapshotPath,
      config.codegen.registry,
      config.codegen.dts,
      config.codegen.defaults,
    ].map(gitSpelling),
    globs: [],
  };
}

/** A configured path as git reports it: `./content/defaults.json` is `content/defaults.json`. */
function gitSpelling(path: string): string {
  return posix.normalize(path).replace(/^\.\//, '');
}

/**
 * The committable files: the stet-written forms git reports as differing from
 * HEAD — staged, unstaged or untracked — deletions and unmerged paths left out,
 * a document counting only where it carries a mark. Read from the checkout
 * every time, so a reload, a restart or a save made in the terminal all give
 * the same answer.
 */
function pendingForms(site: Ready): string[] {
  const { files, globs } = stetFormPaths(site);
  // Git reads a glob its own way (`[` is a class to git and a character to
  // stet; `**` beside a name is a plain `*` to git), so git is asked only for
  // the folders the globs walk, as literal paths, and stet's own matcher picks
  // the documents.
  const roots = [...new Set(globs.map(staticPrefix))].map((root) => (root === '' ? '.' : `:(literal)${root}`));
  const changed = uncommittedPaths(site.path, [...files, ...roots]).filter(
    (file) => files.includes(file) || globs.some((glob) => matchGlob(glob, file)),
  );
  // A document that cannot be read is left out, so one unreadable file never
  // stops the site opening.
  const readable = changed.filter((file) => files.includes(file) || canRead(join(site.path, file)));
  const accepted = stetWrittenForms(site, readable);
  return readable.filter((file) => accepted.has(file));
}

/** Opened, not asked: `access()` answers readable on some mounts (virtiofs, ACLs) where `open()` fails. */
function canRead(path: string): boolean {
  try {
    closeSync(openSync(path, 'r'));
    return true;
  } catch {
    return false;
  }
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
 * The enumeration is `stetFormPaths`, the one `planRepoForms` itself walks, so
 * the two cannot drift: the descriptor, the snapshot, and then either the
 * marked documents or the codegen trio, each in git's spelling.
 *
 * Scoped to the request's own files because the html arm PARSES what it
 * answers about, and parsing a whole checkout of documents on every commit
 * holds the event loop for as long as it takes — half a second on five hundred
 * documents, which is exactly what the async git was made to stop. The answer
 * is unchanged by the scoping: a file the managed surfaces do not match is
 * never parsed and never accepted either way.
 */
function stetWrittenForms(site: Ready, files: string[]): Set<string> {
  const { files: forms, globs } = stetFormPaths(site);
  const labels = new Set(forms);
  if (globs.length === 0) return labels;
  // The documents are NOT every file `managedSurfaces` matches: that set holds
  // html this project wrote by hand, and committing one of those under a
  // `stet:` subject would carry unrelated work with it. A document carrying a
  // mark is one stet regenerates, which is a property of the file rather than
  // of this process's memory — so a document written by a previous run is
  // still committable after a restart.
  const managed = filesForGlobs(site.path, globs).filter((file) => files.includes(file));
  for (const mark of proposeHtml(site.path, managed).claimed) labels.add(mark.file);
  return labels;
}

/** A commit subject, held to one readable line. */
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
 * `STET_DEV_TOKEN`, which `startDevServer` sets in this process's environment
 * as the server starts; the site's own `apiTokenEnv` is never read, because
 * the dashboard is not the site's production API.
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

    // A document gains the preview agent's tag as it is served; the file on
    // disk is never written.
    const read = readFileSync(file);
    const body = file.endsWith('.html')
      ? Buffer.from(injectAgent(read.toString('latin1'), ctx.origin, previewChannel(ctx), PREVIEW_AGENT_ROUTE), 'latin1')
      : read;
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), {
      status: 200,
      // Sandboxed wherever it is framed: a checkout's document nested in the
      // dev pane's frame, whose sandbox would otherwise pass it the
      // dashboard's origin, still runs with an opaque one and cannot reach
      // the run token.
      headers: {
        'content-type': contentTypeOf(file),
        'cache-control': 'no-store',
        'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups',
      },
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
  // The route is refused before it is used, on both panes, not after: `new
  // URL(route, base)` lets `//example.com/` or an absolute URL REPLACE the
  // base, which would turn the probe into an outbound fetch and a local port
  // scanner, and the operator types the static pane's route as well. A scheme,
  // a protocol-relative `//` and a Windows `\\` are the three spellings that
  // carry a host; everything else is a path. The entry's own `dev` is
  // loopback-checked when it is set, so the base keeps the probe there.
  if (ABSOLUTE_ROUTE.test(route) || route.startsWith('//') || route.startsWith('\\\\')) {
    return json({ error: 'route must be a path on the dev server' }, 400);
  }
  if (ready.host === 'html') {
    const path = route.startsWith('/') ? route : `/${route}`;
    return json({ url: `${ctx.origin}/s/${ready.id}/site${path}`, up: true, static: true, channel: previewChannel(ctx) });
  }
  const defaults = devDefaults(ready.config, entry);
  if (defaults === null) return json({ error: 'this site has no dev server' }, 400);
  const target = new URL(defaults.dev);
  target.pathname = route.startsWith('/') ? route : `/${route}`;
  target.search = '';
  target.hash = '';
  const up = await probe(ctx, target.toString());
  // The frame shows the site through its proxy, whose own origin keeps the
  // site's code away from the dashboard's; a down server has no frame to show.
  const proxied = up ? await proxyFor(ctx, ready.path, new URL(defaults.dev).origin) : null;
  return json({
    url: proxied === null ? target.toString() : proxied.origin + target.pathname,
    dev: target.toString(),
    up,
    channel: previewChannel(ctx),
    start: defaults.devCommand,
    source: defaults.source,
    router: ready.config.router,
  });
}

/**
 * The run's preview channel: a random value the agent carries on every message
 * it sends, so the page can tell its own agent from a page the frame navigated
 * to. Served inside the documents and in the Bearer-guarded preview reply,
 * never readable across origins.
 */
function previewChannel(ctx: DevContext): string {
  ctx.previewChannel ??= randomBytes(16).toString('hex');
  return ctx.previewChannel;
}

/** Where the dashboard serves the preview agent the static documents load. */
const PREVIEW_AGENT_ROUTE = '/preview-agent.js';

let agentText: string | undefined;
/** The preview agent, read once from the package. */
function agentScript(): string {
  agentText ??= readFileSync(join(packageRoot(), 'templates', 'preview-agent.js'), 'utf8');
  return agentText;
}

/** The site's preview proxy, started on first use and replaced when the entry's dev URL moves. */
async function proxyFor(ctx: DevContext, path: string, dev: string): Promise<PreviewProxy> {
  const proxies = (ctx.proxies ??= new Map());
  const held = proxies.get(path);
  if (held !== undefined && held.target === dev) return held;
  if (held !== undefined) await held.close();
  const started = await startPreviewProxy(dev, ctx.origin, agentScript(), previewChannel(ctx));
  proxies.set(path, started);
  return started;
}

async function closeProxy(ctx: DevContext, path: string): Promise<void> {
  const held = ctx.proxies?.get(path);
  if (held === undefined) return;
  ctx.proxies?.delete(path);
  await held.close();
}

/**
 * Where each key renders, because the page cannot read the site's files itself.
 *
 * On a static-HTML host: each managed document with the route the static arm
 * serves it at and the declared page whose route it is, per key the documents
 * carrying its mark, and per key each mark's PLACE — the file and line, the
 * element's tag, for an attribute mark the attribute and a meta's
 * `name`/`property`, and whether it is a head text. The page route is compared the way `pages scan` compares
 * it — `fileRoute` and `src/seo.ts`'s `route` — so a page the html arm declared
 * matches its document. The served route differs on purpose: `about.html` is
 * the page `/about` and is served at `/about.html`, because the static arm
 * serves files by path and a folder's index at the folder, where relative
 * references inside the page resolve.
 *
 * On a JavaScript host no document carries a mark, and the places are the
 * source reads `keyReads` finds, a read in a `<title>` or a copy meta's
 * `content` marked as a head text the same way.
 */
function marks(site: SiteState): Response {
  const ready = requireReady(site);
  if (ready.host !== 'html') return json({ documents: [], keys: {}, places: keyReads(ready) });
  const set = proposeHtml(ready.path, filesForGlobs(ready.path, ready.config.managedSurfaces));
  const pages = new Map<string, string>();
  for (const [name, page] of Object.entries(ready.descriptor.pages ?? {})) pages.set(normalizeRoute(page.route), name);
  const documents = set.documents.map((document) => ({
    file: document.file,
    route: servedRoute(document.file),
    page: pages.get(normalizeRoute(fileRoute(document.file))) ?? null,
  }));
  const keys = new Map<string, string[]>();
  const places = new Map<string, Place[]>();
  for (const mark of set.claimed) {
    const held = keys.get(mark.key) ?? [];
    if (!held.includes(mark.file)) held.push(mark.file);
    keys.set(mark.key, held);
    places.set(mark.key, [
      ...(places.get(mark.key) ?? []),
      {
        file: mark.file,
        line: mark.line,
        tag: mark.tag,
        ...(mark.attr === undefined ? {} : { attr: mark.attr }),
        ...(mark.metaName === undefined ? {} : { meta: mark.metaName }),
        ...(mark.inSvg === undefined ? {} : { svg: true as const }),
        ...(isHeadText(mark) ? { head: true as const } : {}),
      },
    ]);
  }
  return json({ documents, keys: Object.fromEntries(keys), places: Object.fromEntries(places) });
}

/** Where a key renders: a file and line, and the element's tag and attribute where stet can read them. */
interface Place {
  file: string;
  line: number;
  tag?: string;
  attr?: string;
  meta?: string;
  /** A `<title>` inside an `<svg>`: the graphic's name, which a browser shows as a tooltip. */
  svg?: true;
  /** A head text (`isHeadText`): the page's `<title>`, or a meta whose `content` is copy. */
  head?: true;
}

/**
 * A read of a key in a JavaScript host's source: `copy.get('<key>')`,
 * `copy('<key>')` or `get('<key>')`, and `copy.<key>` or `copyMap.<key>` — the
 * accessor `register` writes, the map the scaffolded read path exports, and
 * the forms a host re-exports them under.
 */
const KEY_READ =
  /\bcopy(?:Map)?\s*\.\s*get\s*\(\s*(['"`])([^'"`\n]+)\1|\b(?:copy|get)\s*\(\s*(['"`])([^'"`\n]+)\3|\bcopy(?:Map)?\s*\.\s*([A-Za-z_$][\w$]*)/g;

/**
 * Every declared key's reads in the managed surfaces and copy modules of a
 * JavaScript host, each with its file and line. A read inside a template
 * dialect's markup also carries the innermost element around it, or the
 * attribute it sits in — and on a `<meta>`'s `content`, the meta's name — through
 * the static-HTML host's own tokenizer over the dialect's blanked text. A read
 * in a JSX file, in frontmatter, a script or a comment, in markup the tokenizer
 * could not pair, or in a file it cannot read at all carries none, and the page
 * names the file instead. Only reads of declared keys count, so `copy.get` or
 * an unrelated `.data` is never a place.
 */
function keyReads(site: Ready): Record<string, Place[]> {
  const out = new Map<string, Place[]>();
  const files = [...new Set([...filesForGlobs(site.path, site.config.managedSurfaces), ...filesForGlobs(site.path, site.config.copyModules)])].sort();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(site.path, file), 'utf8');
    } catch {
      continue;
    }
    const dialect = dialectOf(file);
    const lineAt = lineIndex(source);
    // Markup stet cannot read — nesting deeper than the tokenizer's walk, say —
    // leaves the file's reads with their file and line, and the route answers.
    let document: Document | null = null;
    try {
      if (dialect === 'html') document = readDocument(file, source, dialect);
      else if (dialect !== null && dialect !== 'mdx') {
        document = readDocument(file, maskExpressions(dialect === 'vue' ? vueMarkup(source) : source, dialect), dialect);
      }
    } catch {
      document = null;
    }
    for (const found of source.matchAll(KEY_READ)) {
      const key = found[2] ?? found[4] ?? found[5] ?? '';
      if (!Object.hasOwn(site.descriptor.keys, key)) continue;
      const at = found.index;
      const place: Place = { file, line: lineAt(at) };
      if (document !== null && !document.blanked.slice(at, at + found[0].length).includes('\0')) {
        try {
          const element = elementAt(document.roots, at);
          Object.assign(place, element);
          if (element.tag !== undefined && isHeadText({
            kind: element.attr === undefined ? 'element' : 'attribute',
            tag: element.tag,
            ...(element.attr === undefined ? {} : { attr: element.attr }),
            ...(element.meta === undefined ? {} : { metaName: element.meta }),
          })) place.head = true;
        } catch {
          document = null;
        }
      }
      out.set(key, [...(out.get(key) ?? []), place]);
    }
  }
  return Object.fromEntries(out);
}

/**
 * A template dialect's markup with the inside of every `{…}` expression masked
 * with `_`, its braces and newlines kept: `content={copy.get('k')}` then reads
 * as one unquoted attribute value, where the quotes inside the expression would
 * otherwise end the attribute and the tag early. Braces count only in the
 * markup `blankNonMarkup` leaves, so a `'{'` in frontmatter or a script opens
 * nothing. Every offset stays put.
 */
function maskExpressions(source: string, dialect: Dialect): string {
  const markup = blankNonMarkup(source, dialect);
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (markup[i] === '\0') {
      out.push(ch);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
    else if (depth > 0 && ch !== '\n') {
      out.push('_');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/**
 * A `.vue` file with its top-level `<template>` open and close tags blanked to
 * spaces. The tokenizer reads `<template>` as opaque, as HTML defines it; in a
 * single-file component it is the markup itself. Every offset stays put.
 */
function vueMarkup(source: string): string {
  const open = /^<template\b[^>]*>/m.exec(source);
  const close = source.lastIndexOf('</template>');
  if (open === null || close < open.index + open[0].length) return source;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  return (
    source.slice(0, open.index) +
    blank(open[0]) +
    source.slice(open.index + open[0].length, close) +
    blank('</template>') +
    source.slice(close + '</template>'.length)
  );
}

/**
 * The innermost element whose content holds `at`, or whose open tag's attribute
 * does: its tag, the attribute's name, and for a `<meta>`'s `content` the meta's
 * `name` or `property`, so a head read on a JavaScript host reads as its kind.
 */
function elementAt(roots: Element[], at: number): { tag?: string; attr?: string; meta?: string } {
  for (const el of roots) {
    if (at < el.openStart || at >= el.closeEnd) continue;
    if (at < el.openEnd) {
      const attr = el.attrs.find((a) => a.start <= at && at < a.end);
      if (attr === undefined) return {};
      const meta = attr.name === 'content' ? metaCopyName(el) : null;
      return { tag: el.tag, attr: attr.name, ...(meta === null ? {} : { meta }) };
    }
    if (el.opaque) return {};
    const inner = elementAt(el.children, at);
    return inner.tag === undefined ? { tag: el.tag } : inner;
  }
  return {};
}

/** A document's path as the static arm serves it: a folder's index at the folder, anything else at itself. */
function servedRoute(file: string): string {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file}`;
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
    ...(defaults === null ? {} : { dev: defaults.dev }),
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
  if (!(await endDevServer(ctx, ready.path, child, Date.now() + STOP_COMMAND_MS))) {
    return json({
      ...childReply(child),
      error: 'this dev server outlived its launcher and the workspace entry names no stop command — set one in Setup',
    });
  }
  ctx.children.delete(ready.path);
  return json({ running: false, state: 'stopped', lines: child.lines });
}

/** How long Stop gives the entry's stop command. */
const STOP_COMMAND_MS = 30_000;

/** How long the server's close gives every child together. */
const SHUTDOWN_MS = 5_000;

/**
 * One dev server ended — the path Stop, a site's removal and the server's close
 * share. Its process group first. Then, where the entry names a stop command
 * and the dev URL still answers, that command, run in the checkout and ended at
 * `until`: a launcher that daemonised (Astro 7) left a server no group signal
 * reaches, whether it had exited before the kill or was still exiting. A
 * launcher that failed on its own never had a server, so a dev URL answering
 * then is another one's — the operator's own on that port — and is left be.
 * False only for a server that outlived its launcher with no stop command.
 */
async function endDevServer(ctx: DevContext, path: string, child: DevChild, until: number): Promise<boolean> {
  const hadGroup = await endChild(child);
  await launcherExit(child, EXIT_WAIT_MS);
  const failed = child.state === 'exited' && child.code !== null && child.code !== 0;
  if (failed) return true;
  if (child.stop === undefined) return hadGroup;
  if (child.dev !== undefined && !(await probe(ctx, child.dev))) return true;
  await runStop(child.stop, path, until - Date.now());
  // A stop command signals and returns; the port is free only once the server
  // has let go of it.
  while (child.dev !== undefined && Date.now() < until && (await probe(ctx, child.dev))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** How long a launcher whose group is gone gets to report its exit code. */
const EXIT_WAIT_MS = 500;

/** The launcher's own exit, once its group is gone: the code tells a launcher that failed from one that was ended. */
async function launcherExit(child: DevChild, ms: number): Promise<void> {
  const handle = child.handle;
  if (child.state !== 'running' || handle === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    new Promise<void>((resolve) => handle.once('exit', () => resolve())),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/** The entry's stop command, in the checkout, in a group of its own that is killed at the deadline. */
function runStop(command: string, cwd: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const run = spawn(command, { cwd, shell: true, detached: true, stdio: 'ignore', env: childEnv() });
    const timer = setTimeout(() => {
      // Never `kill(-0)`: a spawn that failed has no pid, and -0 is this
      // process's own group.
      if (run.pid !== undefined) {
        try {
          process.kill(-run.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    run.on('exit', done);
    run.on('error', done);
  });
}

/** Whether the group was there to end. */
async function endChild(child: DevChild): Promise<boolean> {
  if (child.pid === 0) return false;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return false;
  }
  if (await gone(-child.pid, 2_000)) return true;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  // SIGKILL is delivered asynchronously: without this the caller can answer
  // "stopped" while the port is still held.
  await gone(-child.pid, 2_000);
  return true;
}

/**
 * Every child this run started, ended together, within `SHUTDOWN_MS` in all.
 * Called by the server's own `close()`, so a dev server the dashboard launched
 * never outlives the dashboard — a daemonised one included.
 */
export async function stopEveryChild(ctx: DevContext): Promise<void> {
  const until = Date.now() + SHUTDOWN_MS;
  await Promise.all([...ctx.children.keys()].map((path) => stopChild(ctx, path, until)));
  await Promise.all([...(ctx.proxies?.keys() ?? [])].map((path) => closeProxy(ctx, path)));
}

/** One site's child, ended through the path Stop takes, by the deadline the caller holds. */
async function stopChild(ctx: DevContext, path: string, until = Date.now() + SHUTDOWN_MS): Promise<void> {
  const child = ctx.children.get(path);
  if (child === undefined) return;
  ctx.children.delete(path);
  await endDevServer(ctx, path, child, until);
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

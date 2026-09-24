/**
 * The dashboard's workspace: which local checkouts `stet dev` serves, and what
 * each of them is.
 *
 * A site is identified by its REAL path and by nothing else — the folder name
 * is what a person reads, the config's `project` is a detail, and two entries
 * reaching one directory through a symlink are one entry. Nothing here is
 * cached: `loadSite` re-reads the config, the descriptor and the snapshot on
 * every request, so an edit made in the terminal is seen by the next one.
 *
 * The site's ENVIRONMENT is the checkout's own `.env` files and nothing else. A
 * variable exported in the operator's shell is not read for a site's
 * connection, because two checkouts naming `DATABASE_URL` would otherwise share
 * one database; the five variables that do cross are a search path and a home,
 * which a command that spawns git or the render runner cannot run without.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { writeJsonDeterministic } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { CONFIG_FILE, isHtmlHost, loadConfig, selectStoreBlock, type StetConfig } from './config.js';
import { gitState } from './git.js';
import type { CliIo } from './main.js';
import { CliError, Report } from './report.js';
import { isStoreBacked } from './store.js';

export interface WorkspaceEntry {
  /** The checkout's real path. The site's identity in every request. */
  path: string;
  /** The dev server the preview pane embeds — loopback only, since the frame policy admits nothing else. */
  dev?: string;
  devCommand?: string;
  devStopCommand?: string;
  pushAfterCommit?: boolean;
}

export interface Workspace {
  sites: WorkspaceEntry[];
}

/**
 * Where the workspace file lives. The environment override is the suite's way
 * in — a test must never write the operator's own `~/.stet/projects.json` — and
 * is documented as exactly that.
 */
export function workspacePath(io: Pick<CliIo, 'env'>): string {
  return io.env['STET_WORKSPACE'] ?? join(homedir(), '.stet', 'projects.json');
}

/**
 * The workspace as it stands. An absent file is an empty workspace — the first
 * run creates nothing until something is added. A file that cannot be read as
 * the shape is a REFUSAL naming both remedies: silently treating a hand-broken
 * file as empty would lose the operator's list without saying so.
 */
export function readWorkspace(file: string): Workspace {
  if (!existsSync(file)) return { sites: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`${file}: ${(error as Error).message} — fix or delete the file`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CliError(`${file}: not an object — fix or delete the file`);
  }
  const sites = (raw as Record<string, unknown>)['sites'];
  if (sites === undefined) return { sites: [] };
  if (!Array.isArray(sites)) {
    throw new CliError(`${file}: sites must be an array of { "path": "/abs/checkout" } — fix or delete the file`);
  }
  const entries: WorkspaceEntry[] = [];
  for (const site of sites) {
    if (typeof site !== 'object' || site === null || typeof (site as WorkspaceEntry).path !== 'string') {
      throw new CliError(`${file}: sites must be an array of { "path": "/abs/checkout" } — fix or delete the file`);
    }
    entries.push(site as WorkspaceEntry);
  }
  return { sites: entries };
}

/**
 * The file, written whole. Through a temp file and a rename, so a crash between
 * the truncate and the write cannot leave the operator with a half-written
 * list; through the deterministic serializer, so two runs that changed nothing
 * write identical bytes.
 */
export function writeWorkspace(file: string, workspace: Workspace): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeJsonDeterministic(temp, workspace);
  renameSync(temp, file);
}

/**
 * A checkout added, or left alone where it is already there. Absolute and a
 * directory, both refused by name: a relative path has no meaning to a server
 * whose working directory is wherever `stet dev` was started, and a file path
 * would be read as a checkout on the next request.
 */
export function addSite(file: string, raw: string): { workspace: Workspace; added: boolean; path: string } {
  if (!isAbsolute(raw)) throw new CliError(`${raw}: a workspace path must be absolute`);
  let real: string;
  try {
    if (!statSync(raw).isDirectory()) throw new CliError(`${raw}: not a directory`);
    real = realpathSync(raw);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${raw}: not a directory`);
  }
  const workspace = readWorkspace(file);
  if (workspace.sites.some((site) => site.path === real)) {
    return { workspace, added: false, path: real };
  }
  workspace.sites.push({ path: real });
  writeWorkspace(file, workspace);
  return { workspace, added: true, path: real };
}

/**
 * One entry's own fields. The dev URL is validated against the two hosts the
 * page's frame policy admits: an entry naming anything else would pass here and
 * then be blocked in the pane with nothing said. The IPv6 literal is refused
 * for the same reason — `http://[::1]:4321` is not a CSP host-source in Chrome.
 */
export function updateSite(
  file: string,
  path: string,
  patch: Pick<WorkspaceEntry, 'dev' | 'devCommand' | 'devStopCommand' | 'pushAfterCommit'>,
): Workspace {
  const workspace = readWorkspace(file);
  const entry = workspace.sites.find((site) => site.path === path);
  if (entry === undefined) throw new CliError(`${path}: not a workspace site`);
  if (patch.dev !== undefined) {
    if (!isLoopbackUrl(patch.dev)) {
      throw new CliError(`${patch.dev}: the dev URL must be http(s) on 127.0.0.1 or localhost`);
    }
    entry.dev = patch.dev;
  }
  if (patch.devCommand !== undefined) {
    if (patch.devCommand.trim() === '') throw new CliError('the dev command cannot be empty');
    entry.devCommand = patch.devCommand;
  }
  if (patch.devStopCommand !== undefined) entry.devStopCommand = patch.devStopCommand;
  if (patch.pushAfterCommit !== undefined) {
    if (typeof patch.pushAfterCommit !== 'boolean') throw new CliError('pushAfterCommit must be true or false');
    entry.pushAfterCommit = patch.pushAfterCommit;
  }
  writeWorkspace(file, workspace);
  return workspace;
}

/** A URL the preview pane can embed: http(s) on the two hosts the frame policy names. */
function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  );
}

export function removeSite(file: string, path: string): Workspace {
  const workspace = readWorkspace(file);
  workspace.sites = workspace.sites.filter((site) => site.path !== path);
  writeWorkspace(file, workspace);
  return workspace;
}

/**
 * The stable id a path takes in a URL — the mount point of a store-backed
 * site's API and of a static host's files. A hash rather than the path itself
 * because a path in a URL segment carries separators; twelve hex characters
 * because it names one of a handful of local checkouts, not a public resource.
 */
export function siteId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

/** What a workspace entry turned out to be when the server last looked. */
export type SiteState =
  | { state: 'not-adopted'; name: string; path: string; id: string }
  | { state: 'broken'; name: string; path: string; id: string; message: string }
  | {
      state: 'ready';
      name: string;
      path: string;
      id: string;
      config: StetConfig;
      descriptor: Descriptor;
      snapshot: Snapshot;
      /** `snapshot` where no store is configured, else the selected adapter's name. */
      mode: string;
      host: 'html' | 'js';
      keys: number;
      environments: string[];
      locales: string[];
      git: { head: string | null; branch: string | null; dirty: boolean };
      /** The config's `project` id — shown beside the folder name, never an identity. */
      project: string;
      /** The config's router: the page names a JavaScript host by it. */
      router: StetConfig['router'];
    };

/**
 * One entry, read from disk right now.
 *
 * Never `loadProject`: it constructs an adapter and throws on an unset
 * connection variable, which is exactly the state the listing has to SHOW as a
 * line rather than die on. The offline loaders `seo check` uses are what this
 * takes instead.
 */
export function loadSite(entry: WorkspaceEntry): SiteState {
  const path = entry.path;
  const name = basename(path);
  const id = siteId(path);
  if (!existsSync(join(path, CONFIG_FILE))) return { state: 'not-adopted', name, path, id };

  let config: StetConfig;
  try {
    config = loadConfig(path);
  } catch (error) {
    return { state: 'broken', name, path, id, message: (error as Error).message };
  }

  const report = new Report();
  const descriptor = descriptorOf(config, path, report);
  const snapshot = descriptor === null ? null : snapshotOf(config, path, report);
  if (descriptor === null || snapshot === null) {
    const errors = report.findings.filter((f) => f.level === 'error').map((f) => f.message);
    return { state: 'broken', name, path, id, message: errors.join('; ') };
  }

  const block = selectStoreBlock(config, undefined).block;
  return {
    state: 'ready',
    name,
    path,
    id,
    config,
    descriptor,
    snapshot,
    mode: isStoreBacked(block) && block !== undefined ? block.adapter : 'snapshot',
    host: isHtmlHost(config) ? 'html' : 'js',
    keys: Object.keys(descriptor.keys).length,
    environments: Object.keys(config.environments ?? {}),
    locales: config.locales.enabled,
    git: gitState(path),
    project: config.project,
    router: config.router,
  };
}

/**
 * A checkout's own connection environment: `.env`, then `.env.local` over it.
 *
 * The map is a fresh object handed to `resolveStore` and to each command's
 * `io.env`; it never touches `process.env`, which is what keeps two checkouts
 * naming `DATABASE_URL` apart.
 *
 * The grammar, whole: a UTF-8 BOM on the first line is dropped; a trailing `\r`
 * is dropped; a blank line and a line whose first non-space character is `#`
 * are skipped; an optional `export ` prefix is dropped; the key is
 * `[A-Za-z_][A-Za-z0-9_]*` and the split is at the FIRST `=`, so an `=` inside
 * the value survives; `A=` is the empty string; a double-quoted value loses its
 * quotes and has `\n` unescaped; a single-quoted value loses its quotes and
 * nothing else; an unquoted value is trimmed and loses an inline ` #…` comment;
 * an unclosed quote is kept literally; a line the grammar cannot read is
 * skipped; an absent file contributes nothing.
 *
 * `util.parseEnv` was considered and rejected: it folds a bare-word line into
 * the next key, so the skip rule above cannot be met with it.
 */
export function siteEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['.env', '.env.local']) {
    let text: string;
    try {
      text = readFileSync(join(path, name), 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of parseEnvText(text)) env[key] = value;
  }
  return env;
}

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** The grammar above, as pairs in file order. Exported for its own fixture. */
export function parseEnvText(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = ENV_LINE.exec(trimmed);
    if (match === null) continue;
    const key = match[1] as string;
    const raw = match[2] as string;
    pairs.push([key, envValue(raw)]);
  }
  return pairs;
}

function envValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // An inline comment needs whitespace before the `#`: a `#` inside a value
  // (`PASSWORD=a#b`) is part of it. An unclosed quote falls through to here and
  // is kept literally, so nothing is silently repaired.
  const hash = value.search(/\s#/);
  return hash === -1 ? value : value.slice(0, hash).trimEnd();
}

/**
 * The five process variables a child may see. Copied one by one and only where
 * SET: Node hands an `undefined` value to a child as an empty string, and an
 * empty `PATH` finds git nowhere rather than on the platform's default path.
 *
 * No connection variable is among them, by construction — that is the whole
 * point of the list being written out rather than filtered.
 */
export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The environment every child the server starts receives: the server's own,
 * minus the run token. Git and its hooks, the site's dev command and the
 * browser open all take this.
 *
 * The token is the dashboard's API credential and a child has no Origin for the
 * server to refuse, so a child holding it holds the whole API. Only the mounted
 * handler reads the variable, from this process's own environment.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['STET_DEV_TOKEN'];
  return env;
}

/**
 * A `CliIo` pointed at one checkout, with its own environment and collecting
 * sinks.
 *
 * The base variables are spread last, so a checkout's `.env` cannot decide
 * where the tools this process runs are found: a `PATH` line in a project file
 * would otherwise pick the git and node the server executes.
 */
export function siteIo(
  path: string,
  sink: { out: string[]; err: string[] },
  extra: Pick<CliIo, 'fetchImpl' | 'store' | 'stores'> = {},
): CliIo {
  return {
    cwd: path,
    env: { ...siteEnv(path), ...baseEnv() },
    stdout: (line) => sink.out.push(line),
    stderr: (line) => sink.err.push(line),
    ...extra,
  };
}

export interface DevDefaults {
  dev: string;
  devCommand: string;
  devStopCommand?: string;
  /** Whether the pair came from the workspace entry or from the site's router. */
  source: 'entry' | 'router';
}

/**
 * What the preview pane should point at, and what Start should run.
 *
 * The html host is tested FIRST and answers null: it has no dev server at all,
 * the server serves its files itself, and `loadConfig` fills `router` with
 * `app` on that shape — so a router test alone would hand a static page Next's
 * pair. Every JavaScript host has a router and therefore a default; a host that
 * is neither Astro nor Next carries `router: app` and receives Next's pair,
 * which `source: 'router'` is what tells the operator.
 *
 * The Astro default keeps the `localhost` spelling and is never normalised to
 * `127.0.0.1`: Astro 7 binds `[::1]:4321` only, which `localhost` reaches and
 * the IPv4 literal does not.
 */
export function devDefaults(config: StetConfig, entry: WorkspaceEntry): DevDefaults | null {
  if (isHtmlHost(config)) return null;
  const router = routerDefaults(config);
  const named = entry.dev !== undefined || entry.devCommand !== undefined || entry.devStopCommand !== undefined;
  if (!named) return { ...router, source: 'router' };
  const stop = entry.devStopCommand ?? router.devStopCommand;
  return {
    dev: entry.dev ?? router.dev,
    devCommand: entry.devCommand ?? router.devCommand,
    ...(stop === undefined ? {} : { devStopCommand: stop }),
    source: 'entry',
  };
}

function routerDefaults(config: StetConfig): Omit<DevDefaults, 'source'> {
  if (config.router === 'astro') {
    return { dev: 'http://localhost:4321', devCommand: 'npx astro dev', devStopCommand: 'npx astro dev stop' };
  }
  return { dev: 'http://localhost:3000', devCommand: 'npm run dev' };
}

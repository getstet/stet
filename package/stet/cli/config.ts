/**
 * `stet.config.json` — the project half of the two-file configuration model
 * (§13.1). The descriptor describes keys and pages; this file describes the
 * project: which store, which OTHER stores it can be pointed at, where the
 * artifacts live, which locales are enabled.
 *
 * Every setting has a working default, so a repo with a descriptor and a
 * snapshot at the default paths is a valid project with no config file at all.
 * Unknown fields are IGNORED rather than rejected — later changes own them
 * (§13.1's table lists phase-2 and phase-3 fields this change does not read).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { SEO_SEVERITY } from '../src/seo.js';
import type { SeoRule } from '../src/seo.js';
import { writeJsonDeterministic } from './artifacts.js';
import { CliError, UsageError } from './report.js';

export const CONFIG_FILE = 'stet.config.json';

/** Where an adopting project keeps the migration copies (§4's emit path). */
export const HOST_MIGRATIONS = join('stet', 'migrations');

export type StoreAdapterName = 'pg' | 'postgrest' | 'memory' | 'snapshot';

/** One store connection: an adapter and the variables holding its credential. */
export interface StoreBlock {
  adapter: StoreAdapterName;
  urlEnv: string;
  tokenEnv: string;
}

export interface StetConfig {
  project: string;
  store?: StoreBlock;
  /**
   * The named connections beyond the bare `store` block, which IS the default
   * environment. An environment is a different database, never a column, so
   * declaring one is this line of config and nothing else.
   */
  environments?: Record<string, StoreBlock>;
  /**
   * Per-rule severity overrides for `stet seo check`. Keys are `SeoRule` ids,
   * validated at the parse; the seo capability owns what they mean.
   */
  seoCheck?: Record<string, 'error' | 'warn'>;
  /**
   * The files `scan` reads and `register` may rewrite — a curated list, never
   * the whole tree. `init` writes it from the detected layout; an empty list is
   * a project with no managed surfaces, which is what a bare repo is.
   */
  managedSurfaces: string[];
  /**
   * The EMAIL subset of the managed surfaces. `register` derives a stray
   * literal's `target` from the surface its FILE matched — a match here means
   * `EMAIL_TARGET`, so email copy gets email rules — never from a send-arg
   * heuristic, which misfires on `res.send`/`socket.send`. `init` writes the
   * email glob into both this and `managedSurfaces`. Absent or empty — the
   * default — means every stray derives `DEFAULT_TARGET`.
   */
  emailSurfaces: string[];
  /**
   * The declared COPY MODULES — files whose string literals `scan` walks as
   * copy rather than as code, the object-literal property names proposing
   * themselves as keys. A separate list from `managedSurfaces` because the walk
   * is a different one: the JSX locator has nothing to say about a `copy.ts`
   * whose whole content is an object literal. Default empty — a host declares
   * the modules it means, and a too-wide glob's noise is the declarer's cost.
   */
  copyModules: string[];
  /**
   * `scan`'s posture. `warn` is the default because a tool that fails a
   * stranger's commits on day one is uninstalled before it renders a heading;
   * `baseline` names the accepted-literals file that makes an existing repo
   * start at zero.
   */
  scan: { severity: 'warn' | 'fail'; baseline: string };
  /**
   * The detected router. `register` reads it to choose the accessor: only
   * `pages` forces the client form, a Pages-Router file being client-rendered
   * with no `'use client'` directive to detect it by.
   */
  router: 'app' | 'pages' | 'astro';
  /**
   * The host kind. Absent is a JavaScript host — a framework with a build, read
   * through a scaffolded module. `"html"` is the static-HTML host, whose
   * written config carries no `readPath`, `codegen`, `router` or `rootLayout`:
   * the loader fills defaults nothing on that host reads, and every consumer of
   * those fields branches on `isHtmlHost` at its own seam.
   */
  host?: 'html';
  /**
   * The module `init` scaffolds the server accessor into. `file` is where it
   * was written; `import` is the specifier `register` inserts into a server
   * leaf, which is a host path alias a bare relative path would not match.
   */
  readPath: { file: string; import: string };
  /**
   * Where the `CopyProvider` mount lives — the one source of truth for it.
   * `init` writes it source-root-rebased with the extension it found, and
   * `register`'s provider check and `eject`'s unwrap both address that file.
   *
   * ABSENT on an `astro` host, which has no root React layout: both readers
   * treat its absence as no layout, and the parse fills no default there — a
   * placeholder path is the lie this optionality exists to stop.
   */
  rootLayout?: string;
  /**
   * The NAME of the environment variable holding the mount's Bearer token.
   * `init` scaffolds `createStetHandler({ auth: apiTokenEnv })` and the handler
   * compares against `process.env[apiTokenEnv]`.
   */
  apiTokenEnv: string;
  /**
   * The API-mount route `init` scaffolded, where it scaffolded one. Absent on a
   * snapshot-only project, which has no store to mount — and it is `eject`'s
   * only way to find the route file it must delete, that route being the one
   * `@getstet/stet/server` importer outside the managed surfaces.
   */
  mountRoute?: string;
  descriptorPath: string;
  snapshotPath: string;
  bundlePath: string;
  codegen: { registry: string; defaults: string; dts: string };
  /** v1: the default locale IS the literal 'default' — every seam binds it. */
  locales: { default: 'default'; enabled: string[] };
}

export const STORE_ADAPTERS: readonly StoreAdapterName[] = ['pg', 'postgrest', 'memory', 'snapshot'];

/** The connection env var each adapter reads when the config does not name one. */
const URL_ENV: Record<StoreAdapterName, string> = {
  pg: 'STET_DATABASE_URL',
  postgrest: 'STET_POSTGREST_URL',
  memory: '',
  snapshot: '',
};

const TOKEN_ENV = 'STET_POSTGREST_TOKEN';

/**
 * A store block with this adapter's default variable names — what a config
 * that names only the adapter means, and what `stet upgrade --store` prints
 * for an operator to paste. One table, both readers.
 */
export function defaultStoreBlock(adapter: StoreAdapterName): StoreBlock {
  return { adapter, urlEnv: URL_ENV[adapter], tokenEnv: TOKEN_ENV };
}

/**
 * One store block, validated. The bare `store` block and every `environments`
 * entry are the same shape, so they are the same validator — `prefix` is what
 * makes an error name the block it came from
 * (`environments.staging.adapter must be one of: …`). A second copy of these
 * rules is exactly the drift this file exists to prevent.
 */
export function parseStoreBlock(raw: unknown, prefix: string): StoreBlock {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`${CONFIG_FILE}: ${prefix} must be an object`);
  }
  const block = raw as Record<string, unknown>;
  const adapter = str(block, 'adapter', '', `${prefix}.`);
  if (!(STORE_ADAPTERS as readonly string[]).includes(adapter)) {
    throw new CliError(
      `${prefix}.adapter must be one of: ${STORE_ADAPTERS.join(', ')} — got ${JSON.stringify(block['adapter'] ?? null)}`,
    );
  }
  const defaults = defaultStoreBlock(adapter as StoreAdapterName);
  return {
    adapter: defaults.adapter,
    urlEnv: str(block, 'urlEnv', defaults.urlEnv, `${prefix}.`),
    tokenEnv: str(block, 'tokenEnv', defaults.tokenEnv, `${prefix}.`),
  };
}

/**
 * The store block a run talks to, and the name it answers by. The ONE
 * resolution point: every reader of a store block takes its answer from here,
 * so a selection cannot half-apply.
 *
 * `undefined` and `'default'` both name the bare `store` block. An unknown name
 * is a usage error that lists what IS declared — a typo must never fall through
 * to the default connection, which is somebody's production database.
 *
 * The config is assumed loadConfig-built: the guard against a `default` key
 * inside `environments` lives there, at the parse, so this stays a pure lookup.
 */
export function selectStoreBlock(
  config: StetConfig,
  selection: string | undefined,
): { name: string; block: StoreBlock | undefined } {
  if (selection === undefined || selection === 'default') {
    return { name: 'default', block: config.store };
  }
  const declared = config.environments ?? {};
  const block = declared[selection];
  if (block === undefined) {
    const names = Object.keys(declared).sort();
    throw new UsageError(
      names.length === 0
        ? `--env ${selection}: no environments are declared in ${CONFIG_FILE} — only 'default', the bare store block`
        : `--env ${selection}: not a declared environment — declared: ${names.join(', ')} (and 'default', the bare store block)`,
    );
  }
  return { name: selection, block };
}

/** Where a Next host's `CopyProvider` mount lives, absent a host saying otherwise. */
export const DEFAULT_ROOT_LAYOUT = 'app/layout.tsx';

export function defaultConfig(): StetConfig {
  return {
    project: 'default',
    managedSurfaces: [],
    emailSurfaces: [],
    copyModules: [],
    scan: { severity: 'warn', baseline: '.stet/scan-baseline.json' },
    router: 'app',
    readPath: { file: 'lib/content.ts', import: '@/lib/content' },
    rootLayout: DEFAULT_ROOT_LAYOUT,
    apiTokenEnv: 'STET_API_TOKEN',
    descriptorPath: 'content/descriptor.json',
    snapshotPath: 'content/defaults.json',
    bundlePath: '.stet/bundle.json',
    codegen: {
      registry: 'content/keys.ts',
      defaults: 'content/defaults.ts',
      // NOT `keys.d.ts`: TypeScript treats `X.d.ts` as `X.ts`'s declaration
      // output and DROPS it from an include-globbed program, so the ambient
      // key-registry augmentation never loads and a typo'd key compiles clean.
      // A distinct stem (mirroring `next-env.d.ts`) keeps the ambient file in
      // the program (P1-2).
      dts: 'content/stet-env.d.ts',
    },
    locales: { default: 'default', enabled: ['default'] },
  };
}

/**
 * The config at `<cwd>/stet.config.json`, or all defaults where there is none.
 *
 * There is deliberately NO upward search: a command run from the wrong
 * directory then reads as a bare repo rather than silently adopting a parent
 * project's store, and `stet doctor`'s config line — which states where it
 * looked — is the mitigation.
 */
export function loadConfig(cwd: string): StetConfig {
  const path = join(cwd, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return defaultConfig();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`${CONFIG_FILE} must be a JSON object`);
  }

  const source = raw as Record<string, unknown>;
  const config = defaultConfig();

  config.project = str(source, 'project', config.project);
  config.descriptorPath = str(source, 'descriptorPath', config.descriptorPath);
  config.snapshotPath = str(source, 'snapshotPath', config.snapshotPath);
  config.bundlePath = str(source, 'bundlePath', config.bundlePath);

  const kind = host(source);
  if (kind !== undefined) config.host = kind;

  config.router = router(source);
  // The default is filled for a Next host only: on Astro `undefined` is the
  // truth, and `app/layout.tsx` would name a file that is not there.
  config.rootLayout =
    config.router === 'astro'
      ? optionalStr(source, 'rootLayout')
      : str(source, 'rootLayout', DEFAULT_ROOT_LAYOUT);
  config.apiTokenEnv = str(source, 'apiTokenEnv', config.apiTokenEnv);
  const mountRoute = source['mountRoute'];
  // Optional with no default: absent MEANS no scaffolded route, so a filled-in
  // fallback would send `eject` looking for a file nobody wrote.
  if (mountRoute !== undefined) config.mountRoute = str(source, 'mountRoute', '');

  config.managedSurfaces = stringArray(source, 'managedSurfaces', config.managedSurfaces);
  config.emailSurfaces = stringArray(source, 'emailSurfaces', config.emailSurfaces);
  config.copyModules = stringArray(source, 'copyModules', config.copyModules);

  const scan = obj(source, 'scan');
  if (scan) {
    const severity = str(scan, 'severity', config.scan.severity, 'scan.');
    if (severity !== 'warn' && severity !== 'fail') {
      throw new CliError(
        `${CONFIG_FILE}: scan.severity must be "warn" or "fail" — got ${JSON.stringify(scan['severity'] ?? null)}`,
      );
    }
    config.scan = { severity, baseline: str(scan, 'baseline', config.scan.baseline, 'scan.') };
  }

  const readPath = obj(source, 'readPath');
  if (readPath) {
    config.readPath = {
      file: str(readPath, 'file', config.readPath.file, 'readPath.'),
      import: str(readPath, 'import', config.readPath.import, 'readPath.'),
    };
  }

  const codegen = obj(source, 'codegen');
  if (codegen) {
    config.codegen = {
      registry: str(codegen, 'registry', config.codegen.registry, 'codegen.'),
      defaults: str(codegen, 'defaults', config.codegen.defaults, 'codegen.'),
      dts: str(codegen, 'dts', config.codegen.dts, 'codegen.'),
    };
  }

  const locales = obj(source, 'locales');
  if (locales) {
    const declared = str(locales, 'default', 'default', 'locales.');
    if (declared !== 'default') {
      throw new CliError(
        `locales.default must be "default": locale identity is 'default' in v1, and the resolution chain, the snapshot loader and the currency check all bind that literal`,
      );
    }
    const enabled = locales['enabled'];
    if (enabled !== undefined) {
      if (!Array.isArray(enabled) || enabled.some((l) => typeof l !== 'string')) {
        throw new CliError('locales.enabled must be an array of strings');
      }
      // The default locale is always processed: a project that left it out of
      // `enabled` would watch its own default block rot on every pull.
      config.locales.enabled = [...new Set(['default', ...(enabled as string[])])];
    }
  }

  const store = obj(source, 'store');
  if (store) config.store = parseStoreBlock(store, 'store');

  const environments = obj(source, 'environments');
  if (environments) {
    const map: Record<string, StoreBlock> = {};
    // These are operator-supplied map keys, so they are a validated input in
    // their own right — the block values alone are not the whole surface.
    for (const name of Object.keys(environments)) {
      if (name === 'default') {
        throw new CliError(
          `${CONFIG_FILE}: environments must not declare "default" — the bare store block IS the default environment, ` +
            "and 'default' is its reserved selector",
        );
      }
      if (name.trim() === '' || name.startsWith('-')) {
        throw new CliError(
          `${CONFIG_FILE}: ${JSON.stringify(name)} is not a usable environment name — it must not be blank, ` +
            'and a leading dash would read as an option after --env',
        );
      }
      map[name] = parseStoreBlock(environments[name], `environments.${name}`);
    }
    config.environments = map;
  }

  const seoCheck = obj(source, 'seoCheck');
  if (seoCheck) {
    const map: Record<string, 'error' | 'warn'> = {};
    for (const id of Object.keys(seoCheck)) {
      // The severity table IS the runtime rule list — a type has no
      // `.includes` — so membership is a lookup in it, the same shape the
      // adapter table is checked with above.
      if (!(id in SEO_SEVERITY)) {
        throw new CliError(
          `${CONFIG_FILE}: seoCheck.${id} is not a rule — declared rules: ${Object.keys(SEO_SEVERITY).sort().join(', ')}`,
        );
      }
      const severity = seoCheck[id];
      if (severity !== 'error' && severity !== 'warn') {
        throw new CliError(
          `${CONFIG_FILE}: seoCheck.${id} must be "error" or "warn" — got ${JSON.stringify(severity ?? null)}. ` +
            'There is no third state: a warn already never moves the exit code, so an "off" would add surface and change nothing.',
        );
      }
      map[id] = severity;
    }
    config.seoCheck = map;
  }

  return config;
}

/**
 * The config back to disk — `loadConfig`'s inverse, and `stet init`'s one
 * config write. It goes through the same deterministic serializer every other
 * emitted artifact does, so an `init` and a hand-sorted file are byte-equal and
 * a re-run has nothing to change.
 */
export function writeConfig(path: string, config: StetConfig): void {
  writeJsonDeterministic(path, config);
}

/**
 * The `seoCheck` block as the rule engine takes it. The terminal spells a
 * severity `warn` — `CliLevel`'s word, and what an operator types — while
 * `src/` spells it `warning`, `Finding`'s word. This is the one translation
 * between them, at the one boundary, so neither side learns the other's
 * spelling. The cast is sound because `loadConfig` rejected every id that is
 * not a rule.
 */
export function seoOverrides(config: StetConfig): Partial<Record<SeoRule, 'error' | 'warning'>> {
  const overrides: Partial<Record<SeoRule, 'error' | 'warning'>> = {};
  for (const [id, severity] of Object.entries(config.seoCheck ?? {})) {
    overrides[id as SeoRule] = severity === 'warn' ? 'warning' : 'error';
  }
  return overrides;
}

/**
 * The host project's OWN path aliases — `tsconfig.json`, else `jsconfig.json`.
 * Both fields come back: every dest is resolved through `baseUrl`, so a
 * paths-only reader would silently mislocate the alias root on every host that
 * declares one.
 *
 * `extends` chains are NOT followed — resolving them means walking
 * node_modules-resolved config packages — so a host whose alias lives only in
 * an extended base reads as declaring none, and each caller names that limit.
 *
 * Consumers: `init`'s read-path alias probe, and `register --write`'s guard
 * over the specifier it is about to write into host source.
 */
export function pathAliasMappings(
  target: string,
): { baseUrl: string; paths: Record<string, unknown> } | null {
  const parsed = readJsonc(join(target, 'tsconfig.json')) ?? readJsonc(join(target, 'jsconfig.json'));
  const compilerOptions = (parsed as { compilerOptions?: unknown } | null)?.compilerOptions;
  if (typeof compilerOptions !== 'object' || compilerOptions === null) return null;
  const { baseUrl, paths } = compilerOptions as { baseUrl?: unknown; paths?: unknown };
  // A bare `baseUrl` and NO `paths` is a real resolution rule, not an absent
  // one: it roots every non-relative specifier in the host. Answering `null`
  // there told both callers the project declares nothing.
  const declared = typeof paths === 'object' && paths !== null ? (paths as Record<string, unknown>) : {};
  return { baseUrl: typeof baseUrl === 'string' ? baseUrl : '.', paths: declared };
}

/**
 * Where a specifier could land on disk, extension-free, as candidates — the
 * host's own resolution rules as tsc applies them: relative resolution against
 * the importing file's directory, `paths` where an entry matches, and a bare
 * `baseUrl` rooting the specifier where none does.
 *
 * Callers ask different questions of the same answers: eject asks whether a
 * consumer's import lands on a file it plans to delete, and `register --write`
 * asks whether the specifier it is about to write lands on the read path. Both
 * are membership tests against this list — never a prefix test, which passes a
 * mapping that resolves somewhere else entirely.
 *
 * A bare package specifier resolves to nothing beyond the `baseUrl` candidate,
 * which is the right answer — it is not a host file.
 */
export function resolveSpecifier(
  spec: string,
  importer: string,
  cwd: string,
  aliases: { baseUrl: string; paths: Record<string, unknown> } | null,
): string[] {
  if (spec.startsWith('.')) {
    return [normalizeNoExt(resolvePath(dirname(join(cwd, importer)), spec))];
  }
  if (aliases === null) return [];
  const matched = matchPathsEntry(spec, aliases.paths);
  // A matched entry is the WHOLE answer. tsc commits to the one it picked and
  // falls back to nothing — not to a shorter pattern, not to `baseUrl` — so a
  // specifier whose mapping lands nowhere resolves nowhere, even with a file
  // sitting at the `baseUrl` path it would otherwise have found.
  if (matched === null) return [normalizeNoExt(join(cwd, aliases.baseUrl, spec))];
  const candidates: string[] = [];
  for (const dest of matched.dests) {
    if (typeof dest !== 'string') continue;
    // A destination carrying no `*` is used verbatim — legal, and how a
    // wildcard pattern funnels a whole prefix onto one module.
    const substituted = matched.star === null ? dest : dest.replace('*', matched.star);
    candidates.push(normalizeNoExt(join(cwd, aliases.baseUrl, substituted)));
  }
  return candidates;
}

/**
 * The ONE `paths` entry tsc would resolve `spec` through, with the text its `*`
 * captured (`null` for an exact key, which has no `*` to substitute).
 *
 * tsc's rule rather than an approximation of it: an exact key wins outright,
 * and otherwise a pattern is `<prefix>*<suffix>` with the `*` ANYWHERE — `'@/*'`,
 * `'@c-*'` and `'@x-*-mod'` are all legal — so matching means the prefix and the
 * suffix both sit on the specifier with room between them. Where several
 * patterns match, the LONGEST PREFIX takes it alone.
 */
function matchPathsEntry(
  spec: string,
  paths: Record<string, unknown>,
): { dests: unknown[]; star: string | null } | null {
  // Own-property only: `paths` is JSON-parsed, so a bare lookup answers
  // `constructor` with a function and reads as a declared mapping.
  if (Object.hasOwn(paths, spec) && Array.isArray(paths[spec])) {
    return { dests: paths[spec] as unknown[], star: null };
  }
  let best: { dests: unknown[]; star: string; prefix: number } | null = null;
  for (const [pattern, dests] of Object.entries(paths)) {
    if (!Array.isArray(dests)) continue;
    const star = pattern.indexOf('*');
    // No `*` is an exact key, answered above; a second `*` is not a legal
    // pattern, and tsc discards the entry rather than guess which one is the
    // wildcard.
    if (star === -1 || star !== pattern.lastIndexOf('*')) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length < prefix.length + suffix.length) continue;
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (best !== null && prefix.length <= best.prefix) continue;
    best = {
      dests,
      star: spec.slice(prefix.length, spec.length - suffix.length),
      prefix: prefix.length,
    };
  }
  return best === null ? null : { dests: best.dests, star: best.star };
}

/** A path with its module extension dropped — how two specifiers for one file compare. */
export function normalizeNoExt(path: string): string {
  return path.replace(/\.(tsx?|jsx?|json)$/, '');
}

/** JSON, then a comment/trailing-comma-tolerant retry for JSONC tsconfigs, else null. */
function readJsonc(path: string): unknown {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

/**
 * The host kind, constrained at the parse the way `router` is: absent, or the
 * one named state. A typo names both accepted spellings rather than silently
 * scaffolding a JavaScript host over a page that has no build.
 */
function host(source: Record<string, unknown>): 'html' | undefined {
  const value = source['host'];
  if (value === undefined) return undefined;
  if (value !== 'html') {
    throw new CliError(
      `${CONFIG_FILE}: host must be "html", or absent for a JavaScript host — got ${JSON.stringify(value)}`,
    );
  }
  return 'html';
}

/**
 * The ONE predicate every seam asks. Nothing tests `config.host === 'html'`
 * inline, so the proof that a seam branched is a grep for this name.
 */
export function isHtmlHost(config: Pick<StetConfig, 'host'>): boolean {
  return config.host === 'html';
}

/** The three routers, constrained at the parse so `register` never branches on a typo. */
function router(source: Record<string, unknown>): 'app' | 'pages' | 'astro' {
  const value = str(source, 'router', 'app');
  if (value !== 'app' && value !== 'pages' && value !== 'astro') {
    throw new CliError(
      `${CONFIG_FILE}: router must be "app", "pages" or "astro" — got ${JSON.stringify(source['router'] ?? null)}`,
    );
  }
  return value;
}

function str(
  source: Record<string, unknown>,
  field: string,
  fallback: string,
  prefix = '',
): string {
  const value = source[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new CliError(`${CONFIG_FILE}: ${prefix}${field} must be a string`);
  }
  return value;
}

/** A field with no default: absent MEANS absent, and a present one validates as `str` does. */
function optionalStr(source: Record<string, unknown>, field: string): string | undefined {
  return source[field] === undefined ? undefined : str(source, field, '');
}

function obj(source: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = source[field];
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`${CONFIG_FILE}: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** An array-of-strings field — `managedSurfaces`, `emailSurfaces` and `copyModules`. */
function stringArray(source: Record<string, unknown>, field: string, fallback: string[]): string[] {
  const value = source[field];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((g) => typeof g !== 'string')) {
    throw new CliError(`${CONFIG_FILE}: ${field} must be an array of strings`);
  }
  return value as string[];
}

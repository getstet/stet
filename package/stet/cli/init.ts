/**
 * `stet init` — the 90-second adopt. It DETECTS framework, router, source root
 * and store (never asks), asks only the two §13.1 questions (what the site is,
 * whether it sends email), and WRITES a project's worth of new files: the
 * descriptor and its snapshot (from the shipped starter assets), the three
 * codegen modules, the server read path, the migration, the config, and — where
 * a store exists — the `createStetHandler` API-mount route.
 *
 * Its ONE edit to pre-existing CODE is mounting the root-layout `CopyProvider`:
 * shown as a diff, applied only on confirm or `--yes`, skipped (with the manual
 * snippet) non-interactively, idempotent, and left alone where the wrap point is
 * ambiguous. It additionally APPENDS the agent-routing guidance block to the
 * host's `AGENTS.md`/`CLAUDE.md` (`cli/agents.ts`) — additive, marker-delimited,
 * shown before it is written, gated the same way, and reversed by `eject`.
 * Everything is `<base>`-rebased on the detected
 * `src/`-vs-root layout so a `src/app` or JS host is scaffolded and later
 * located correctly. Every new-file write is plan-then-apply: a pristine re-run
 * changes nothing, a run after a real edit is a named refusal.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import type * as TS from 'typescript';

import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { loadDescriptorWithWarnings } from '../src/descriptor.js';
import { loadSnapshot } from '../src/snapshot.js';
import { writeInitGuidance } from './agents.js';
import { flag, noPositionals, parse, text } from './args.js';
import { planJson, planWrite, writePlanned, writeText, type WritePlan } from './artifacts.js';
import { check } from './check.js';
import {
  CONFIG_FILE,
  HOST_MIGRATIONS,
  defaultConfig,
  defaultStoreBlock,
  pathAliasMappings,
  type StetConfig,
} from './config.js';
import { filesForGlobs } from './files.js';
import { proposeHtml } from './html-host.js';
import { packageRoot, migrations } from './installed.js';
import { detectPagesRoots } from './pages.js';
import type { CliIo } from './main.js';
import { posixRelative, Report, UsageError } from './report.js';
import { applyFileEdits, dominantEol, formatDiff, type Edit } from './rewrite.js';
import { loadTypescript, scriptKindFor } from './source-scan.js';

export async function runInit(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { app: 'string', host: 'string', yes: 'boolean' });
  noPositionals(positionals, 'init');
  const app = text(values, 'app');
  const forced = text(values, 'host');
  if (forced !== undefined && forced !== 'html') {
    throw new UsageError('stet init --host takes one value, html');
  }
  const yes = flag(values, 'yes');
  const target = app === undefined ? io.cwd : join(io.cwd, app);
  const report = new Report();

  // `--host html` forces the shape and skips detection: a folder about to
  // receive its page has no `.html` to detect yet.
  const { base, router, host, evidence } =
    forced === 'html'
      ? ({ base: '', router: 'app', host: 'html', evidence: '--host html' } as const)
      : detectLayout(target);
  const isHtml = host === 'html';
  // The host line REPLACES the router line: a static-HTML host has no router,
  // and naming one would be the lie the arm exists to stop.
  if (isHtml) report.line(`host: html (${evidence})`);
  else report.line(`router: ${router} (${evidence})`);
  // An Astro host has no root React layout, and a placeholder path is the lie
  // this absence exists to stop. Neither does a page with no build.
  const rootLayout = isHtml || router === 'astro' ? undefined : probeRootLayout(target, base, router);
  const storeBacked = detectStore(target, io.env);
  // The sub-package OR the invocation root: a hoisted monorepo declares react
  // once at the top, and reading only the app would call it react-less while
  // its layout sits there waiting to be wrapped.
  const hasReact = isHtml ? false : detectReact(target) || (target !== io.cwd && detectReact(io.cwd));

  // The two §13.1 questions. Both default in a non-interactive context (no
  // `ask`/`confirm` on the io), with a printed note — never a blocked run.
  const pack = await askPack(io, report);
  const sendsEmail = await askEmail(io, target, base, report);

  const config = buildConfig({ base, router, host, rootLayout, storeBacked, sendsEmail, target, report });

  const label = (diskPath: string): string => posixRelative(io.cwd, diskPath);
  const plan = (relPath: string, text: string): WritePlan =>
    planWrite(join(target, relPath), text, label(join(target, relPath)));
  const planJsonAt = (relPath: string, value: unknown): WritePlan =>
    planJson(join(target, relPath), value, label(join(target, relPath)));

  const plans: WritePlan[] = [];
  if (isHtml) {
    // An EMPTY descriptor and snapshot: the page already carries its copy, and
    // a starter key has nowhere to render on a document stet did not write. The
    // brand group arrives when a page needs it.
    plans.push(planJsonAt(config.descriptorPath, { version: 1, keys: {} }));
    plans.push(planJsonAt(config.snapshotPath, { default: {} }));
    plans.push(planJsonAt(CONFIG_FILE, htmlConfigProjection(config)));
  } else {
    // The starter descriptor and its snapshot ship as package assets: inlining
    // them here would put `target` literals in `cli/`, which the conformance
    // guard forbids, and the snapshot has to populate every declared key or
    // init's own completion check would error on currency.
    const starterDescriptor = readJson(join(packageRoot(), 'templates', 'starter-descriptor.json'));
    const starterDefaults = readJson(join(packageRoot(), 'templates', 'starter-defaults.json'));
    const descriptor = loadDescriptorWithWarnings(starterDescriptor).descriptor;
    const snapshot = loadSnapshot(starterDefaults);
    const { keysTs, dts } = generateRegistry(descriptor);

    plans.push(
      planJsonAt(config.descriptorPath, starterDescriptor),
      planJsonAt(config.snapshotPath, starterDefaults),
      plan(config.codegen.registry, keysTs),
      plan(config.codegen.dts, dts),
      plan(config.codegen.defaults, generateDefaultsModule(snapshot)),
      plan(
        config.readPath.file,
        // An Astro host takes the react-free scaffold whether or not react is
        // declared: an island's React tree is not the site's layout, and
        // `stet/react`'s server accessor is a Next server-component tool.
        readPathModule(config, join(target, config.readPath.file), target, storeBacked, hasReact && router !== 'astro'),
      ),
    );
    for (const migration of migrations()) {
      plans.push(plan(join(HOST_MIGRATIONS, migration.name), readFileSync(migration.path, 'utf8')));
    }
    if (config.mountRoute !== undefined) {
      plans.push(plan(config.mountRoute, routeModule(config, join(target, config.mountRoute), target)));
    }
    plans.push(planJsonAt(CONFIG_FILE, config));
  }

  // typescript parses the layout for the ONE mount edit. Load it BEFORE any
  // write, so its absence degrades that edit to a printed snippet rather than
  // leaving a half-adopted repo — the writes commit, then the mount can't parse
  // (P3-12). The read path and codegen writes need no typescript. An html host
  // has no layout and no read path, so it never asks for the compiler.
  const ts = isHtml ? null : await loadTypescriptOrNull();

  const { written, unchanged } = writePlanned(plans, {
    refusal: (labels) =>
      `refusing to overwrite ${labels.join(', ')} — the file in this repo differs from the one stet init would write. ` +
      'Nothing was written. Diff them and delete the local copy if the generated version is the one you want',
  });
  for (const name of unchanged) report.line(`${name}: already present, identical`);
  for (const name of written) report.line(`wrote ${name}`);

  // The mount exists to give CLIENT components an accessor through React
  // context. Two hosts have no provider to mount: one that declares no react,
  // and an Astro host, whose site layout is a `.astro` template rather than a
  // React tree — an island's React subtree is not the site's layout, and the
  // Astro reason wins whether or not react is declared. The step is skipped
  // whole and the read route it does have is named instead. The gate sits at
  // the CALL, which is what also silences every fallback inside: the wrap-point
  // miss and the layout-not-found branch both print a snippet importing
  // `@getstet/stet/react`, and on those hosts that import cannot load.
  const skipMount = (reason: string): void => {
    report.line(
      `no CopyProvider mount: ${reason} — read copy from '${config.readPath.import}', ` +
        "either copy('key') for text or copyMap.key by property",
    );
  };
  // On an html host the step is skipped WHOLE and silently: there is no
  // provider, no read path and no import — nothing the line could name.
  if (isHtml) {
    // nothing to mount
  } else if (rootLayout === undefined || router === 'astro') {
    skipMount('an Astro host has no root React layout');
  } else if (!hasReact) skipMount('this host declares no react');
  else await mountProvider({ io, target, config, rootLayout, router, yes, report, ts });
  // Outside the all-or-nothing batch above: that batch is over NEW files stet
  // owns, while the guidance append edits files it does not, under per-file
  // three-state semantics. Folding it in would let a host's edited CLAUDE.md
  // veto the descriptor write.
  await writeInitGuidance({ io, target, config, yes, report });

  // Where the Next-shaped mount route was not written, the endpoint is a hand
  // step and the report says so rather than leaving a store-backed host with
  // no server surface named.
  if (!isHtml && storeBacked && config.mountRoute === undefined) {
    report.line('mount route: not scaffolded on an Astro host — mount createStetHandler in an Astro endpoint by hand');
  }

  report.line('');
  check(config, target, report);
  report.line('');
  // A store-backed read path serves `config.bundlePath`, which `pull` writes and
  // `init` does not — so a fresh store host must `pull` before that path
  // resolves. Keyed on the STORE rather than on the mount route, which the read
  // path already is: an Astro store host writes no route and still carries an
  // accessor that throws until `pull` runs.
  if (isHtml) {
    // What the page holds, counted the way `scan` will report it — so the
    // operator sees the size of the adoption before running it. The hook is
    // named because `init` never writes one on any host.
    const set = proposeHtml(
      target,
      filesForGlobs(target, config.managedSurfaces),
      { version: 1, keys: {} },
      {},
    );
    const pages = set.documents.length;
    const elements = set.proposals.filter((p) => p.kind === 'element').length;
    const attributes = set.proposals.filter((p) => p.kind === 'attribute').length;
    report.line(
      `${pages} page${pages === 1 ? '' : 's'}, ${elements} text element${elements === 1 ? '' : 's'}, ` +
        `${attributes} attribute${attributes === 1 ? '' : 's'} — next: stet scan, then stet hook install`,
    );
  } else if (storeBacked) {
    report.line('next: stet pull (populate the store bundle the read path serves), then stet scan');
  } else {
    report.line('next: stet scan');
  }
  return report.emit(io);
}

// --- detection -------------------------------------------------------------

/** `'src/'` when the Next app lives under `src/`, `''` at the repo root. */
function detectSourceBase(target: string): '' | 'src/' {
  for (const router of ['app', 'pages']) {
    if (existsSync(join(target, 'src', router))) return 'src/';
  }
  return '';
}

/** The `astro.config.*` spellings Astro itself accepts, probed by name like every other arm. */
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.cjs', 'astro.config.mts'];

/**
 * The host's router, CONFIRMED by its route files — the same detector `stet
 * pages scan` proposes from, which reads names below each candidate root and
 * never `config.router`.
 *
 * A directory alone proves nothing: `src/pages` exists on every Astro site, and
 * reading it as Next's Pages Router is how the one real Astro host came to
 * carry `router: "pages"` with a `.tsx` glob matching nothing. The
 * `astro.config.*` probe is the same posture one step out — a content-collections
 * or Starlight site may carry no `.astro` file under `src/pages` at all, and
 * without it that host would take the directory fallback and record the very
 * lie this arm fixes.
 *
 * A host with no route file yet keeps the directory fallback, so a bare repo
 * still scaffolds as `app`. The evidence rides back so the report can say what
 * decided it.
 */
function detectLayout(target: string): {
  base: '' | 'src/';
  router: 'app' | 'pages' | 'astro';
  host: 'html' | undefined;
  evidence: string;
} {
  const roots = detectPagesRoots(target);
  if (roots.some((root) => root.arm === 'astro')) {
    return { base: 'src/', router: 'astro', host: undefined, evidence: 'src/pages carries .astro files' };
  }
  const astroConfig = ASTRO_CONFIGS.find((name) => existsSync(join(target, name)));
  if (astroConfig !== undefined) {
    return { base: 'src/', router: 'astro', host: undefined, evidence: `${astroConfig} at the root` };
  }
  const app = roots.find((root) => root.arm === 'next-app');
  if (app !== undefined) {
    return {
      base: app.root.startsWith('src/') ? 'src/' : '',
      router: 'app',
      host: undefined,
      evidence: `${app.root} carries a page file`,
    };
  }
  const pages = roots.find((root) => root.arm === 'next-pages');
  if (pages !== undefined) {
    return {
      base: pages.root.startsWith('src/') ? 'src/' : '',
      router: 'pages',
      host: undefined,
      evidence: `${pages.root} carries a page file`,
    };
  }
  const html = detectHtmlHost(target);
  if (html !== null) return { base: '', router: 'app', host: 'html', evidence: html };
  const base = detectSourceBase(target);
  return { base, router: detectRouter(target, base), host: undefined, evidence: 'default — no route files found' };
}

/**
 * The dependencies that mean a build stands between the source and the page. A
 * Vite SPA carries a root `index.html` too, so the MANIFEST is the deterministic
 * tell and the markup is not — `--host html` is the override where a host
 * declares one of these and means the page anyway.
 */
const BUNDLED_HOST_DEPS = [
  'next',
  'astro',
  'vite',
  'react',
  'react-dom',
  'vue',
  'svelte',
  '@sveltejs/kit',
  'nuxt',
  'gatsby',
  '@remix-run/react',
];

/**
 * The static-HTML host's evidence, or null. It reads the root directory's own
 * entries — names only, files only, one level — so an `.html` under `docs/` is
 * not a host and a DIRECTORY named `x.html` is not a page.
 */
function detectHtmlHost(target: string): string | null {
  let names: string[];
  try {
    names = readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  const first = names[0];
  if (first === undefined || !manifestDeclaresNone(target, BUNDLED_HOST_DEPS)) return null;
  return `${first} at the root, no framework in package.json`;
}

/**
 * Whether the manifest declares NONE of the given dependencies — read the way
 * `detectReact` reads react. A missing or unreadable manifest declares nothing,
 * which is the common shape of a hand-written site.
 */
function manifestDeclaresNone(target: string, names: string[]): boolean {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return true;
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = raw[field];
    if (typeof deps !== 'object' || deps === null) continue;
    if (names.some((name) => Object.hasOwn(deps, name))) return false;
  }
  return true;
}

/**
 * The config an html host WRITES: the paths and settings it uses, and nothing
 * else. No read path, codegen, router, root layout, API token or mount route —
 * `loadConfig` fills those in memory and no seam on this host reads them, so
 * writing them would put four lies in a stranger's repo.
 */
function htmlConfigProjection(config: StetConfig): Record<string, unknown> {
  return {
    project: config.project,
    host: 'html',
    ...(config.store === undefined ? {} : { store: config.store }),
    managedSurfaces: config.managedSurfaces,
    emailSurfaces: config.emailSurfaces,
    copyModules: config.copyModules,
    scan: config.scan,
    descriptorPath: config.descriptorPath,
    snapshotPath: config.snapshotPath,
    bundlePath: config.bundlePath,
    locales: config.locales,
  };
}

/** App Router unless only `pages/` exists. A bare repo defaults to app. */
function detectRouter(target: string, base: '' | 'src/'): 'app' | 'pages' {
  if (existsSync(join(target, base, 'app'))) return 'app';
  if (existsSync(join(target, base, 'pages'))) return 'pages';
  return 'app';
}

/**
 * The root-layout file the `CopyProvider` mounts into — probed for the extension
 * that actually exists (a JS host has `app/layout.js`), so the mount edit, the
 * register provider grep and the eject unwrap all address the real file. Falls
 * back to the `.tsx` default when nothing is on disk yet.
 */
function probeRootLayout(target: string, base: '' | 'src/', router: 'app' | 'pages'): string {
  const stem = router === 'app' ? join(base, 'app', 'layout') : join(base, 'pages', '_app');
  for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
    const rel = `${stem}.${ext}`;
    if (existsSync(join(target, rel))) return rel.split(sep).join('/');
  }
  return `${stem}.tsx`.split(sep).join('/');
}

/**
 * Whether the host declares `react` — dependencies or devDependencies, the
 * thing that decides whether `@getstet/stet/react` resolves at all. Not a framework
 * guess: a React host that does not declare react is already broken, and stet
 * matches the host's own reality rather than second-guessing it.
 */
function detectReact(target: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as Record<string, unknown>;
    // All THREE maps: a component library declares react as a peer, and
    // reading two of them called such a host react-less.
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) => {
      const deps = raw[field];
      return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, 'react');
    });
  } catch {
    // No manifest, or one that will not parse: nothing declares react.
    return false;
  }
}

/** A store exists when a config already declares one or a DB URL is in the env. */
function detectStore(target: string, env: NodeJS.ProcessEnv): boolean {
  const configPath = join(target, CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { store?: unknown };
      if (raw.store !== undefined && raw.store !== null) return true;
    } catch {
      // A malformed existing config is not a store signal.
    }
  }
  const url = env['STET_DATABASE_URL'];
  return typeof url === 'string' && url.trim() !== '';
}

// --- the two questions -----------------------------------------------------

/**
 * The pack question. Phase 1 ships one starter (core + the brand group + one
 * wrapper recipe) as a fixed asset, so the answer is recorded for the operator
 * and does not compose the descriptor — the pack catalogue expands in a later
 * release. Asked so the contract's two questions are both present.
 */
async function askPack(io: CliIo, report: Report): Promise<string> {
  const answer = io.ask ? await io.ask('What is this site?', ['core']) : 'core';
  report.line(
    io.ask ? `site: ${answer}` : 'site: core (default — the pack catalogue expands in a later release)',
  );
  return answer;
}

/** Whether the site sends email — gates the `lib/email` managed-surface glob. */
async function askEmail(io: CliIo, target: string, base: '' | 'src/', report: Report): Promise<boolean> {
  const detected = existsSync(join(target, base, 'lib', 'email'));
  const answer = io.confirm ? await io.confirm('Does this site send email?') : detected;
  report.line(io.confirm ? `sends email: ${answer}` : `sends email: ${answer} (detected)`);
  return answer;
}

// --- config ----------------------------------------------------------------

function buildConfig(d: {
  base: '' | 'src/';
  router: 'app' | 'pages' | 'astro';
  host: 'html' | undefined;
  rootLayout: string | undefined;
  storeBacked: boolean;
  sendsEmail: boolean;
  target: string;
  report: Report;
}): StetConfig {
  const config = defaultConfig();
  // The html arm returns FIRST, ahead of `resolveReadPathImport` — there is no
  // import to resolve on a host that writes no read path, and its alias note
  // would name a mapping nothing on this host ever reads.
  if (d.host === 'html') {
    config.host = 'html';
    // Every `.html` below the repository root: a page with no build has no
    // framework tree, so the root IS the layout.
    config.managedSurfaces = ['**/*.html'];
    config.emailSurfaces = [];
    config.copyModules = [];
    // A store block on an html host is legal and dormant — recorded where one
    // is detected, read by nothing until a later surface asks.
    if (d.storeBacked) config.store = defaultStoreBlock('pg');
    return config;
  }
  config.router = d.router;
  config.rootLayout = d.rootLayout;
  // A JS host (probed `app/layout.js`) writes a `.js` read path, and its
  // surfaces are `.jsx` AND `.js` — create-next-app in JS mode generates
  // `app/page.js`, so a `.tsx`/`.jsx`-only glob makes scan/register a silent
  // no-op there (P2-11). stet's glob matcher has no brace expansion, so the
  // widening is separate array entries, not `{tsx,jsx,js}`.
  const js = jsHost(d.rootLayout ?? '');
  const readPathFile = `${d.base}lib/content.${js ? 'js' : 'ts'}`;
  config.readPath = { file: readPathFile, import: resolveReadPathImport(d.target, d.base, readPathFile, d.report) };
  // Astro templates live in `pages/`, `layouts/` and `components/` alike, so
  // the surface is every `.astro` file below the source root. `**` and not a
  // brace list: stet's glob matcher has no brace expansion.
  const surfaceGlobs =
    d.router === 'astro'
      ? [`${d.base}**/*.astro`]
      : js
        ? [`${d.base}${d.router}/**/*.tsx`, `${d.base}${d.router}/**/*.jsx`, `${d.base}${d.router}/**/*.js`]
        : [`${d.base}${d.router}/**/*.tsx`];
  // `.tsx` belongs in the TypeScript host's email list as much as `.ts`: a
  // react-email template IS a `.tsx` component, and it is the shape the whole
  // ecosystem ships. Leaving it out made `stet email extract` with no arguments
  // walk right past a react-email project's entire template directory.
  const emailGlobs = d.sendsEmail
    ? js
      ? [`${d.base}lib/email/**/*.ts`, `${d.base}lib/email/**/*.js`, `${d.base}lib/email/**/*.jsx`]
      : [`${d.base}lib/email/**/*.ts`, `${d.base}lib/email/**/*.tsx`]
    : [];
  config.managedSurfaces = [...surfaceGlobs, ...emailGlobs];
  // The email surfaces are the target-derivation list `register` reads.
  config.emailSurfaces = emailGlobs;
  if (d.storeBacked) {
    config.store = defaultStoreBlock('pg');
    // The route handler is App-Router style (`{ GET, POST }`) and lives under
    // `app/` even on a Pages host, which Next serves alongside `pages/`. An
    // Astro host serves no such route: its endpoint is a hand step the report
    // names, so no `mountRoute` is recorded and `eject` looks for no file.
    if (d.router !== 'astro') config.mountRoute = `${d.base}app/api/stet/[...stet]/route.ts`;
  }
  return config;
}

/**
 * The module specifier `register` inserts for the server read path. It must be
 * depth-INDEPENDENT — `register` writes it verbatim into managed-surface files at
 * many depths — so a path ALIAS is used, never a relative import. The host's
 * tsconfig/jsconfig `compilerOptions.paths` is probed for the alias that maps to
 * the read-path file (its real prefix, `baseUrl`, and root-vs-`src/` target all
 * honored), and only when none is declared does the `@/lib/content` Next default
 * stand — with a printed note, since a relative specifier cannot be one
 * stored value correct across surfaces at differing depths (P2-10).
 */
function resolveReadPathImport(target: string, base: '' | 'src/', readPathFile: string, report: Report): string {
  const alias = probePathAlias(target, readPathFile);
  if (alias !== undefined) return alias;
  report.line(
    `note: no tsconfig/jsconfig path alias was found — readPath.import defaults to '@/lib/content', ` +
      `which assumes an '@/*' alias. Add one, or edit readPath.import in ${CONFIG_FILE}`,
  );
  return `@/${readPathFile.slice(base.length).replace(/\.(tsx?|jsx?)$/, '')}`;
}

/** The alias-prefixed specifier for `readPathFile` derived from a host `paths` mapping, or undefined. */
function probePathAlias(target: string, readPathFile: string): string | undefined {
  const mappings = pathAliasMappings(target);
  if (mappings === null) return undefined;
  const abs = join(target, readPathFile);
  for (const [pattern, dests] of Object.entries(mappings.paths)) {
    if (!pattern.endsWith('/*') || !Array.isArray(dests)) continue;
    const prefix = pattern.slice(0, -1); // '@/*' -> '@/'
    for (const dest of dests) {
      if (typeof dest !== 'string' || !dest.endsWith('/*')) continue;
      const destDir = join(target, mappings.baseUrl, dest.slice(0, -2)); // drop the trailing '/*'
      const rel = posixRelative(destDir, abs);
      if (rel.startsWith('..') || rel.startsWith('/')) continue; // the read path is not under this alias root
      return `${prefix}${rel.replace(/\.(tsx?|jsx?)$/, '')}`;
    }
  }
  return undefined;
}

// --- the scaffolded modules (pinned to compile in a Next host) --------------

/** A `/`-normalized, `./`-prefixed specifier from one file to a target path. */
function relImport(fromFile: string, toDiskPath: string, opts: { stripExt?: boolean } = {}): string {
  let spec = posixRelative(dirname(fromFile), toDiskPath);
  if (!spec.startsWith('.')) spec = `./${spec}`;
  if (opts.stripExt) spec = spec.replace(/\.(tsx?|jsx?|json)$/, '');
  return spec;
}

/**
 * The `createStetHandler` route, its body pinned to COMPILE: the factory from
 * `@getstet/stet/server`, the store from `@getstet/stet/store-pg` (there is no
 * `@getstet/stet/cli` export), the descriptor cast through `as unknown as
 * Descriptor` (a raw JSON import widens `shape`/`target` to `string`), and
 * `renderEmail` left commented since init cannot locate the host's render
 * function. Specifiers are relative, never `@/` aliases, which do not resolve
 * on a `src/` host.
 */
function routeModule(config: StetConfig, routeFile: string, target: string): string {
  const relConfig = relImport(routeFile, join(target, CONFIG_FILE));
  const relDescriptor = relImport(routeFile, join(target, config.descriptorPath));
  return `${[
    "import { createStetHandler } from '@getstet/stet/server';",
    "import { createPgStore } from '@getstet/stet/store-pg';",
    "import type { Descriptor } from '@getstet/stet';",
    '',
    `import config from '${relConfig}';`,
    `import descriptorJson from '${relDescriptor}';`,
    '',
    'const store = createPgStore({',
    "  connectionString: process.env[config.store.urlEnv] ?? '',",
    '  project: config.project,',
    '});',
    '',
    'export const { GET, POST } = createStetHandler({',
    '  store,',
    '  descriptor: descriptorJson as unknown as Descriptor,',
    '  auth: config.apiTokenEnv,',
    '  // renderEmail: <your render fn>,',
    '});',
  ].join('\n')}\n`;
}

/**
 * The server read-path module — the `copy` accessor `stet register` inserts an
 * import to. It reads the committed bundle (or the snapshot, snapshot-only) from
 * disk at request time, so it carries `node:` builtins and must never reach a
 * client bundle.
 *
 * It is built on whichever accessor the HOST can resolve: `createServerCopy`
 * from `@getstet/stet/react` where the host declares `react`, and the framework-free
 * `createAccessor` from the package root where it does not — `@getstet/stet/react`'s
 * index re-exports the provider, so a react-less host cannot even load the
 * subpath. The react-free form additionally exports the resolved map, because
 * an accessor is callable-only: property access on it returns `undefined`
 * silently, and a template reading `{copy.key}` would render nothing.
 */
function readPathModule(
  config: StetConfig,
  readPathFile: string,
  target: string,
  storeBacked: boolean,
  hasReact: boolean,
): string {
  const readFrom = storeBacked ? config.bundlePath : config.snapshotPath;
  // A JS host carries no TypeScript syntax: no `type` import, no cast, no `:`
  // annotation — else `next build` dies after init reported success (P1-3).
  const js = jsHost(readPathFile);
  // Shared tail: the on-disk read and the register-inserted specifier are the
  // same either way; only the accessor and what the module exports differ.
  const bundleRead = [
    '// The committed bundle (or the snapshot, snapshot-only), read at request',
    '// time so a published change is served without a rebuild.',
    'function currentBundle() {',
    `  const raw${js ? '' : ': unknown'} = JSON.parse(readFileSync(join(process.cwd(), '${readFrom}'), 'utf8'));`,
    '  return readBundle(raw);',
    '}',
    '',
    'const { resolved } = resolveAll(descriptor, currentBundle());',
    '',
    `// stet register inserts: import { copy } from '${config.readPath.import}'`,
  ];

  if (!hasReact) {
    // `.js`-suffixed, type-only: the extensionless form is a TS2835 error under
    // `moduleResolution: nodenext`, and the plain-Node TypeScript project is
    // exactly the host this branch is written for. Both resolutions accept it.
    const relRegistry = `${relImport(readPathFile, join(target, config.codegen.registry), { stripExt: true })}.js`;
    return `${[
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      '',
      js
        ? "import { createAccessor, readBundle, resolveAll } from '@getstet/stet';"
        : "import { createAccessor, readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
      ...(js ? [] : ['', `import type { StringKey } from '${relRegistry}';`]),
      '',
      '// The descriptor is READ, never imported: a JSON import needs an import',
      '// attribute under plain node, and a host with no bundler supplies none.',
      `const descriptor = JSON.parse(readFileSync(join(process.cwd(), '${config.descriptorPath}'), 'utf8'))${
        js ? '' : ' as Descriptor'
      };`,
      '',
      ...bundleRead,
      'export const copy = createAccessor(descriptor, resolved);',
      '',
      '// The accessor is callable only — `copy.some_key` on it is undefined with',
      '// no error, so a template that reads copy by property reads this map.',
      ...(js
        ? []
        : [
            '// String-shaped keys land here; number-, list- and record-shaped keys are',
            "// compile errors on this map — read them through the accessor's .get().",
          ]),
      js ? 'export const copyMap = resolved;' : 'export const copyMap = resolved as Record<StringKey, string>;',
    ].join('\n')}\n`;
  }

  const relDescriptor = relImport(readPathFile, join(target, config.descriptorPath));
  return `${[
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    "import { createServerCopy } from '@getstet/stet/react';",
    js ? "import { readBundle, resolveAll } from '@getstet/stet';" : "import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    '',
    `import descriptorJson from '${relDescriptor}';`,
    '',
    js ? 'const descriptor = descriptorJson;' : 'const descriptor = descriptorJson as unknown as Descriptor;',
    '',
    ...bundleRead,
    'export const copy = createServerCopy(descriptor, resolved);',
  ].join('\n')}\n`;
}

// --- the one edit: the root-layout CopyProvider mount ----------------------

async function mountProvider(args: {
  io: CliIo;
  target: string;
  config: StetConfig;
  /** `config.rootLayout`, narrowed by the caller: this step is not reached without one. */
  rootLayout: string;
  router: 'app' | 'pages';
  yes: boolean;
  report: Report;
  ts: typeof import('typescript') | null;
}): Promise<void> {
  const { io, target, config, rootLayout, router, yes, report, ts } = args;
  const layoutPath = join(target, rootLayout);
  const shown = posixRelative(io.cwd, layoutPath);

  if (!existsSync(layoutPath)) {
    report.line(`${shown}: not found — mount the CopyProvider by hand:`);
    printProviderSnippet(report, config, layoutPath, target, router);
    return;
  }
  if (ts === null) {
    report.line(`${shown}: 'typescript' is not installed, so the CopyProvider mount was skipped — install it (npm i -D typescript) or mount by hand:`);
    printProviderSnippet(report, config, layoutPath, target, router);
    return;
  }

  const source = readFileSync(layoutPath, 'utf8');
  const sf = ts.createSourceFile(layoutPath, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, layoutPath));

  if (importsCopyProvider(ts, sf)) {
    report.line(`${shown}: CopyProvider already mounted — no change`);
    return;
  }

  const wrap = locateWrapTarget(ts, sf, router);
  if (wrap === null) {
    report.line(`${shown}: could not locate the wrap point unambiguously — mount the CopyProvider by hand:`);
    printProviderSnippet(report, config, layoutPath, target, router);
    return;
  }

  const edited = applyFileEdits(source, providerEdits(ts, sf, source, layoutPath, target, config, wrap));
  report.line(`${shown}: the one edit to existing code — mount the CopyProvider:`);
  report.line(formatDiff(shown, source, edited));

  const apply = yes || (io.confirm ? await io.confirm(`Apply the CopyProvider mount to ${shown}?`) : false);
  if (!apply) {
    report.line(
      io.confirm && !yes
        ? `${shown}: not confirmed — left unchanged`
        : `${shown}: non-interactive — left unchanged (pass --yes to apply). Mount it by hand:`,
    );
    // The spec (adoption §: init) names the manual snippet on the skip path, so a
    // non-interactive run leaves the operator the exact edit, not just a diff.
    if (!(io.confirm && !yes)) printProviderSnippet(report, config, layoutPath, target, router);
    return;
  }
  writeText(layoutPath, edited);
  report.line(`${shown}: mounted CopyProvider`);
}

/** Already carries `import { CopyProvider } from '@getstet/stet/react'`? Then the mount is done. */
function importsCopyProvider(ts: typeof import('typescript'), sf: TS.SourceFile): boolean {
  return sf.statements.some((stmt) => {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) return false;
    if (stmt.moduleSpecifier.text !== '@getstet/stet/react') return false;
    const bindings = stmt.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((e) => e.name.text === 'CopyProvider')
    );
  });
}

/**
 * The node to wrap: the sole `{children}` expression in an App-Router layout, or
 * the sole `<Component … />` in a Pages `_app` (which has no `children` prop).
 * More than one candidate, or none, is ambiguous — the caller skips and prints
 * the snippet rather than guess.
 */
function locateWrapTarget(ts: typeof import('typescript'), sf: TS.SourceFile, router: 'app' | 'pages'): TS.Node | null {
  const hits: TS.Node[] = [];
  const visit = (node: TS.Node): void => {
    if (router === 'app') {
      if (ts.isJsxExpression(node) && node.expression !== undefined && ts.isIdentifier(node.expression) && node.expression.text === 'children') {
        hits.push(node);
      }
    } else if (ts.isJsxSelfClosingElement(node) && ts.isIdentifier(node.tagName) && node.tagName.text === 'Component') {
      hits.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits.length === 1 ? (hits[0] as TS.Node) : null;
}

/** The import block + resolved-map declaration, plus the wrap of the target node. */
function providerEdits(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  source: string,
  layoutFile: string,
  target: string,
  config: StetConfig,
  wrap: TS.Node,
): Edit[] {
  const relDescriptor = relImport(layoutFile, join(target, config.descriptorPath));
  const relDefaults = relImport(layoutFile, join(target, config.codegen.defaults), { stripExt: true });
  // A JS layout gets no TypeScript syntax — no `type` import, no `as` cast (P1-3).
  const js = jsHost(layoutFile);
  const descriptorExpr = js ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
  // The layout's OWN line ending: a `\n` inserted into a CRLF file leaves
  // mixed endings in a file stet did not write (P3-13, the same rule the
  // guidance append follows).
  const nl = dominantEol(source);
  const block = [
    "import { CopyProvider } from '@getstet/stet/react';",
    js ? "import { readBundle, resolveAll } from '@getstet/stet';" : "import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    `import descriptorJson from '${relDescriptor}';`,
    `import { DEFAULTS } from '${relDefaults}';`,
    '',
    `const { resolved } = resolveAll(${descriptorExpr}, readBundle(DEFAULTS));`,
  ].join(nl);

  const at = importInsertPos(ts, sf);
  const importEdit: Edit = { pos: at, end: at, text: at === 0 ? `${block}${nl}${nl}` : `${nl}${block}${nl}` };

  const inner = source.slice(wrap.getStart(sf), wrap.getEnd());
  const wrapped = `<CopyProvider descriptor={${descriptorExpr}} resolved={resolved}>${inner}</CopyProvider>`;
  const wrapEdit: Edit = { pos: wrap.getStart(sf), end: wrap.getEnd(), text: wrapped };

  return [importEdit, wrapEdit];
}

/** After the last import (or the directive prologue), never before `'use client'`. */
function importInsertPos(ts: typeof import('typescript'), sf: TS.SourceFile): number {
  let pos = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      pos = stmt.getEnd();
      continue;
    }
    if (
      pos === 0 &&
      ts.isExpressionStatement(stmt) &&
      ts.isStringLiteral(stmt.expression)
    ) {
      pos = stmt.getEnd(); // a leading directive such as 'use client'
    }
  }
  return pos;
}

function printProviderSnippet(
  report: Report,
  config: StetConfig,
  layoutFile: string,
  target: string,
  router: 'app' | 'pages',
): void {
  const relDescriptor = relImport(layoutFile, join(target, config.descriptorPath));
  const relDefaults = relImport(layoutFile, join(target, config.codegen.defaults), { stripExt: true });
  const wrapee = router === 'app' ? '{children}' : '<Component {...pageProps} />';
  const js = jsHost(layoutFile);
  const descriptorExpr = js ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
  for (const line of [
    "  import { CopyProvider } from '@getstet/stet/react';",
    js ? "  import { readBundle, resolveAll } from '@getstet/stet';" : "  import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    `  import descriptorJson from '${relDescriptor}';`,
    `  import { DEFAULTS } from '${relDefaults}';`,
    '',
    `  const { resolved } = resolveAll(${descriptorExpr}, readBundle(DEFAULTS));`,
    '',
    `  wrap ${wrapee} in:`,
    `  <CopyProvider descriptor={${descriptorExpr}} resolved={resolved}>…</CopyProvider>`,
  ]) {
    report.line(line);
  }
}

// --- small shared helpers --------------------------------------------------



/** A `.js`/`.jsx` file — a JS host, so the scaffold must carry no TypeScript syntax (P1-3). */
function jsHost(file: string): boolean {
  return /\.(js|jsx)$/.test(file);
}

/** typescript if the optional peer is installed, else null — the mount degrades rather than aborting (P3-12). */
async function loadTypescriptOrNull(): Promise<typeof import('typescript') | null> {
  try {
    return await loadTypescript();
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

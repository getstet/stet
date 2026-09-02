/**
 * `stet pages scan` — the machine that declares a host's static routes as pages.
 *
 * Pages are DECLARED, never inferred: no SEO rule reads a route nobody
 * confirmed. What this reads is not an inference — `src/pages/pricing.astro`
 * IS `/pricing` by Astro's own contract — so the walk PROPOSES from the
 * framework's static routing convention and `--apply` is the confirmation. A
 * route the reading cannot make deterministic, a dynamic segment above all,
 * lands in a named skip instead.
 *
 * The detector is filesystem probes over directory entries and file NAMES. No
 * file content is ever opened, so adoption's never-read boundary holds by
 * construction, and the tree walked is the framework's own rather than a glob's
 * — a glob gate would drop the very endpoints the taxonomy has to report.
 *
 * Two channels, the `email extract` discipline: a file the framework says is not
 * a page (a layout, a private folder, `_app`, `api/**`) is EXCLUDED silently,
 * while a route the walk read and refuses to propose is a REPORTED skip. The
 * skip taxonomy is exhaustive by construction — each arm states what proposes
 * positively and everything else falls to a named terminal — so a reason
 * outside the set means the walker guessed, which is the one thing it may not
 * do. Every reason is produced by a fixture.
 *
 * Nothing this command writes may land on top of something a human wrote. The
 * mint writes a key definition AND its copy, so a route skips where EITHER is
 * already there — the key declared in the descriptor, or a value sitting under
 * that name in the snapshot with no key at all, which is what an unfinished
 * draft looks like. Scaffolding over either one would overwrite a definition
 * and blank real copy at exit 0.
 *
 * `--apply` writes one batch: the page records, their two scaffolded SEO keys,
 * the empty defaults and the regenerated codegen trio. Atomicity here is
 * correctness rather than hygiene — a page record whose keys did not land makes
 * the descriptor unloadable, and so does a key naming a page record that did
 * not, so the whole host bricks at `descriptorOf` in either direction.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { route as normalizeRoute } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, type Descriptor, type PageDef } from '../src/types.js';
import { flag, parse, positionalsAround, refuseEnv } from './args.js';
import { asUpdate, planJson, planWrite, writePlanned, type WritePlan } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { loadConfig, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { CliError, Report, UsageError } from './report.js';

// --- The dirent walk --------------------------------------------------------

/** Directories a walk never descends into — a `**`-prefixed glob has an empty static prefix and would otherwise enumerate them. */
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', '.next']);

/**
 * Recursive directory walk over dirents — no file content is read. Shared with
 * `scan`, whose `filesForGlobs` walks each glob's static prefix through it.
 */
export function walk(dir: string, onFile: (absPath: string) => void): void {
  const entries = safeReaddir(dir);
  if (entries === null) return; // a static prefix that does not exist yet is empty
  for (const entry of entries) {
    if (entry.isDirectory() && WALK_SKIP.has(entry.name)) continue; // P3-17: never enumerate these
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, onFile);
    else if (entry.isFile()) onFile(abs);
  }
}

/** `readdirSync` with dirents, or null when the directory is absent. */
function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** A path below `from`, in the `/`-joined spelling every finding names. */
function repoRelative(from: string, abs: string): string {
  return relative(from, abs).split(sep).join('/');
}

// --- The name grammar -------------------------------------------------------

/** A descriptor key, and therefore a template, slot or page name. */
const NAME_PART = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * A descriptor name from arbitrary text, or `null` where the text makes none.
 * Shared with `email extract`, whose template names come through it: one key
 * grammar, so a page name and a slot name are the same kind of thing. The
 * single-underscore strictness is load-bearing — `__` is the slot separator,
 * and a page name goes on to carry `seo_<name>_title`.
 */
export function normalize(raw: string): string | null {
  const name = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return NAME_PART.test(name) ? name : null;
}

// --- The detector -----------------------------------------------------------

export type PagesArm = 'astro' | 'next-app' | 'next-pages';

export interface PagesRoot {
  arm: PagesArm;
  /** Repo-relative, `/`-joined — the tree this arm walks. */
  root: string;
}

/** Astro has no root-level `pages/` convention; a configured `srcDir` moves the whole tree. */
const ASTRO_ROOT = 'src/pages';
const NEXT_APP_ROOTS = ['app', 'src/app'];
const NEXT_PAGES_ROOTS = ['pages', 'src/pages'];

/** The exact names Next App serves a page from — an enumeration, never a `page.*` glob. */
const NEXT_APP_PAGE_FILES = new Set(['page.tsx', 'page.jsx', 'page.ts', 'page.js']);

/**
 * The two extensions Next's own file-conventions table names for a Route
 * Handler. A `route.tsx`/`.jsx` — resolvable under a widened `pageExtensions` —
 * falls to this arm's silent terminal instead: bounded residue, not a guess.
 */
const NEXT_APP_ROUTE_FILES = new Set(['route.ts', 'route.js']);

/** Next Pages' reserved files, which live at the tree's root and serve no route of their own. */
const NEXT_PAGES_RESERVED = new Set(['_app', '_document', '_error', '404', '500']);

/**
 * The routing roots this host actually has, CONFIRMED by their entries.
 *
 * A directory alone proves nothing — `init`'s directory-only probes are how the
 * one real Astro host came to record `router: "pages"` — so nothing here reads
 * `config.router` and every arm is confirmed by a file name below it. Arms may
 * coexist: Next serves `app/` and `pages/` concurrently, and both walk.
 *
 * Zero arms is not an error. The command says what it probed and exits 0; a
 * host whose Astro `srcDir` moves the tree lands here, which is the fail-safe
 * side of a bounded residue rather than a guess at where the pages went.
 */
export function detectPagesRoots(cwd: string): PagesRoot[] {
  const roots: PagesRoot[] = [];
  // Decisive, and therefore first: Next cannot serve `.astro`, so a `src/pages`
  // tree carrying one is Astro's and the Next Pages arm never claims it.
  const astro = containsFile(cwd, ASTRO_ROOT, (name) => name.endsWith('.astro'));
  if (astro) roots.push({ arm: 'astro', root: ASTRO_ROOT });
  for (const root of NEXT_APP_ROOTS) {
    if (containsFile(cwd, root, (name) => NEXT_APP_PAGE_FILES.has(name))) {
      roots.push({ arm: 'next-app', root });
    }
  }
  for (const root of NEXT_PAGES_ROOTS) {
    if (root === ASTRO_ROOT && astro) continue;
    if (containsFile(cwd, root, (name) => /\.(tsx|jsx)$/.test(name))) {
      roots.push({ arm: 'next-pages', root });
    }
  }
  return roots;
}

/** Whether any file below a candidate root answers the arm's own test. */
function containsFile(cwd: string, root: string, test: (name: string) => boolean): boolean {
  let found = false;
  walk(join(cwd, root), (abs) => {
    if (!found && test(abs.slice(abs.lastIndexOf(sep) + 1))) found = true;
  });
  return found;
}

// --- The taxonomy -----------------------------------------------------------

/**
 * Why a route was left to a human. Exhaustive: a reason outside this set means
 * the walk guessed, which is the one thing it may not do.
 */
export type PageSkipReason =
  | 'dynamic-route'
  | 'endpoint'
  | 'markdown-page'
  | 'unsupported-route-form'
  | 'unsupported-page-type'
  | 'unnameable'
  | 'name-collision'
  | 'already-declared'
  | 'key-collision';

export interface PageSkip {
  file: string;
  reason: PageSkipReason;
  detail: string;
  /** What to do about it — usually the hand-written record, which is first-class. */
  remedy: string;
  /**
   * The name the route would have taken, where naming had already happened.
   * Absent where naming itself failed, and what lets `--apply <name>` say a
   * name it cannot find was skipped rather than never walked.
   */
  name?: string;
}

export interface PageProposal {
  name: string;
  /** The RAW route — `/` for home, never the trailing-slash-trimmed compare form. */
  route: string;
  file: string;
  parent?: string;
}

export interface PageProposalSet {
  proposals: PageProposal[];
  skips: PageSkip[];
}

/** The remedy behind most skips: the descriptor is the registry, and a hand-written page is first-class. */
const HAND_DECLARED = 'declare this page by hand';

/** A character outside the ASCII key grammar — a transliteration would be a silent guess. */
const NON_ASCII = /[^\x20-\x7E]/;

/** A route TEMPLATE's segment: `[param]`, `[...catchAll]`, `[[...optional]]`. */
const DYNAMIC_SEGMENT = /\[.*\]/;

/** A well-formed Next route group, absent from the URL by contract. */
const ROUTE_GROUP = /^\([A-Za-z0-9_-]+\)$/;

/** What one file under a routing root is: a static route, a named skip, or the framework's own non-page. */
type RouteRead = { route: string } | { skip: Omit<PageSkip, 'file'> } | null;

/**
 * What the host already holds, as the walk needs to see it: the pages for the
 * `already-declared` skip and the parent lookup, and the names a scaffold key
 * would land on for the `key-collision` skip.
 *
 * That second half is TWO maps because the write is two writes. A key lives in
 * `descriptor.keys` and its copy lives in the default-locale snapshot, and
 * either one already being there is somebody's work: a snapshot value with no
 * descriptor entry is a warn-level orphan `stet check` stays green over, which
 * is exactly the shape a human's unfinished draft takes.
 *
 * All three are read raw — scan's caller has never validated its descriptor and
 * must not start here — and a caller that mints nothing passes empty maps.
 */
export interface DeclaredState {
  pages: Record<string, { route?: unknown; seo?: unknown }>;
  keys: Record<string, unknown>;
  values: Record<string, unknown>;
}

/**
 * The proposal set for a host's routing roots. Reads directory entries and file
 * names; writes nothing, opens nothing.
 */
export function proposePages(
  cwd: string,
  roots: PagesRoot[],
  declared: DeclaredState,
): PageProposalSet {
  // Every arm's files in ONE path-sorted union. Walk order is what decides
  // which of two colliding routes is the LATER one, so it has to be
  // deterministic across arms rather than per-arm.
  const files: Array<{ arm: PagesArm; file: string; rel: string }> = [];
  for (const root of roots) {
    const base = join(cwd, root.root);
    walk(base, (abs) => {
      files.push({ arm: root.arm, file: repoRelative(cwd, abs), rel: repoRelative(base, abs) });
    });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // The routes and names the descriptor already holds. `Object.hasOwn` on the
  // name side, never a bare `in`: this map is JSON-parsed and `/constructor`
  // normalizes to a perfectly ordinary name the prototype would answer for.
  const declaredRoutes = new Map<string, string>();
  for (const [name, def] of Object.entries(declared.pages)) {
    if (typeof def?.route === 'string') declaredRoutes.set(normalizeRoute(def.route), name);
  }

  const proposals: PageProposal[] = [];
  const skips: PageSkip[] = [];
  const proposedByRoute = new Map<string, PageProposal>();
  const proposedByName = new Map<string, PageProposal>();

  for (const { arm, file, rel } of files) {
    const read = arm === 'astro' ? readAstro(rel) : arm === 'next-app' ? readNextApp(rel) : readNextPages(rel);
    if (read === null) continue;
    if ('skip' in read) {
      skips.push({ file, ...read.skip });
      continue;
    }
    const { route } = read;
    const skip = (reason: PageSkipReason, detail: string, remedy: string, name?: string): void => {
      skips.push(name === undefined ? { file, reason, detail, remedy } : { file, reason, detail, remedy, name });
    };

    // The non-ASCII test comes BEFORE the normalizer, which would answer
    // `café` with `caf` — a lossy transliteration is a silent guess, and the
    // key grammar is ASCII.
    if (NON_ASCII.test(route)) {
      skip(
        'unnameable',
        `the route ${route} carries a character outside the ASCII key grammar, and transliterating it would rename the page silently`,
        'declare this page by hand under a name you choose',
      );
      continue;
    }
    const name = route === '/' ? 'home' : normalize(route);
    if (name === null) {
      skip(
        'unnameable',
        `the route ${route} makes no descriptor key`,
        'declare this page by hand under a name you choose',
      );
      continue;
    }

    const trimmed = normalizeRoute(route);
    const declaredAt = declaredRoutes.get(trimmed);
    if (declaredAt !== undefined) {
      skip(
        'already-declared',
        `page "${declaredAt}" already declares the route ${route}`,
        'nothing to declare — the page record is already there',
        name,
      );
      continue;
    }
    if (Object.hasOwn(declared.pages, name)) {
      skip(
        'already-declared',
        `the descriptor already declares a page named "${name}"`,
        'declare this route by hand under another name',
        name,
      );
      continue;
    }
    // The page is undeclared and a scaffold name is already taken — by a key
    // definition, by committed copy, or by both. Minting over it would blank a
    // host-authored definition (its limits, its label), overwrite the copy
    // under it, and re-point a key another page reads, all at exit 0. Refused,
    // named, and left to a human: the fail-safe posture, which never silently
    // corrupts what it did not write. The test covers the WRITE's whole domain,
    // keys and snapshot alike, because the write does.
    const scaffold = seoKeys(name);
    const existing = [scaffold.title, scaffold.description].find(
      (key) => Object.hasOwn(declared.keys, key) || Object.hasOwn(declared.values, key),
    );
    if (existing !== undefined) {
      const owner = seoOwner(declared.pages, existing);
      skip(
        'key-collision',
        !Object.hasOwn(declared.keys, existing)
          ? `the snapshot already carries copy under the key "${existing}", and scaffolding this page would blank it`
          : owner === undefined
            ? `the descriptor already declares the key "${existing}", and scaffolding this page would overwrite it`
            : `the descriptor already declares the key "${existing}", which page "${owner}" reads, and scaffolding ` +
              'this page would overwrite it',
        'declare this page by hand referencing the existing keys, or rename or remove the key',
        name,
      );
      continue;
    }
    const collision = proposedByRoute.get(trimmed) ?? proposedByName.get(name);
    if (collision !== undefined) {
      skip(
        'name-collision',
        `${collision.file} is already proposing ${collision.route} as "${collision.name}", and this route makes the same name`,
        'rename one of the two files, or declare this one by hand under another name',
        name,
      );
      continue;
    }

    const proposal: PageProposal = { name, route, file };
    proposals.push(proposal);
    proposedByRoute.set(trimmed, proposal);
    proposedByName.set(name, proposal);
  }

  // `parent` is the nearest ancestor route that IS a page, in this set or
  // already declared — directory nesting, deterministic. A second pass because
  // it needs the whole set: `docs/adopt.astro` sorts ahead of `docs/index.astro`.
  for (const proposal of proposals) {
    const parent = nearestParent(proposal.route, proposedByRoute, declaredRoutes);
    if (parent !== undefined) proposal.parent = parent;
  }

  return { proposals, skips };
}

/**
 * The declared page whose seo map reads this key, where one does — what turns
 * "that key exists" into "that key belongs to page X", which is the difference
 * between a name clash and somebody else's declaration.
 */
function seoOwner(pages: DeclaredState['pages'], key: string): string | undefined {
  for (const [page, def] of Object.entries(pages)) {
    const seo = def?.seo;
    if (typeof seo !== 'object' || seo === null) continue;
    if (Object.values(seo).includes(key)) return page;
  }
  return undefined;
}

/** The name of the nearest ancestor route that is a page, walking up the directory nesting. */
function nearestParent(
  route: string,
  proposed: Map<string, PageProposal>,
  declared: Map<string, string>,
): string | undefined {
  const segments = route.split('/').filter((segment) => segment !== '');
  for (let depth = segments.length - 1; depth >= 0; depth--) {
    const ancestor = normalizeRoute(`/${segments.slice(0, depth).join('/')}`);
    const name = proposed.get(ancestor)?.name ?? declared.get(ancestor);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** A route template, whose concrete pages come from data — the declared-not-inferred boundary itself. */
function dynamicSkip(route: string): { skip: Omit<PageSkip, 'file'> } {
  return {
    skip: {
      reason: 'dynamic-route',
      detail: `${route} is a route template, and its concrete pages come from data at build time`,
      remedy: 'declare the route pattern by hand — the host expands it',
    },
  };
}

/**
 * Astro's contract: every file below the root maps by its path minus the last
 * extension, an `index` file collapsing to its directory, and the EXTENSION
 * splits the classes. `.html` is a real Astro page type, and an endpoint keeps
 * every earlier dot — `features.md.ts` serves `/features.md`.
 */
function readAstro(rel: string): RouteRead {
  const ext = extensionOf(rel);
  const route = fileRoute(rel);
  if (ext === '.md' || ext === '.mdx') {
    return {
      skip: {
        reason: 'markdown-page',
        detail: `${route} is a markdown page, whose SEO fields live in its frontmatter`,
        remedy: HAND_DECLARED,
      },
    };
  }
  if (ext === '.ts' || ext === '.js') {
    return {
      skip: {
        reason: 'endpoint',
        detail: `${route} is served by an endpoint, which returns a document that is not a page`,
        remedy: HAND_DECLARED,
      },
    };
  }
  // The terminal default, and it is real: the site's own config manages
  // `src/pages/**/*.tsx` files that Astro serves no route for.
  if (ext !== '.astro' && ext !== '.html') {
    return {
      skip: {
        reason: 'unsupported-page-type',
        detail: `${ext === '' ? 'an extensionless' : `a ${ext}`} file under the Astro route tree is no page type this walk maps to a route`,
        remedy: HAND_DECLARED,
      },
    };
  }
  return isDynamic(route) ? dynamicSkip(route) : { route };
}

/**
 * Next App's contract: `page.{tsx,jsx,ts,js}` files ARE the routes, `route`
 * handlers are endpoints, and every OTHER file is colocation — which subsumes
 * the layout/loading/error family whole, `_private` folders included. The route
 * is the directory path with route groups removed, stripped BEFORE naming so
 * the key never carries a phantom segment.
 */
function readNextApp(rel: string): RouteRead {
  const segments = rel.split('/');
  const base = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  if (dirs.some((segment) => segment.startsWith('_'))) return null;
  const handler = NEXT_APP_ROUTE_FILES.has(base);
  if (!handler && !NEXT_APP_PAGE_FILES.has(base)) return null;

  // The group guard closes all four intercepting spellings — `(.)`, `(..)`,
  // `(..)(..)`, `(...)` — as a class rather than by enumeration, and refuses a
  // legitimately named group outside the grammar with them: one reported skip
  // is the conservative side of a route Next would not serve as written.
  const malformed = dirs.find(
    (segment) => segment.startsWith('@') || (segment.startsWith('(') && !ROUTE_GROUP.test(segment)),
  );
  if (malformed !== undefined) {
    return {
      skip: {
        reason: 'unsupported-route-form',
        detail: `the segment "${malformed}" is a parallel or intercepting route, and the URL Next serves it at is not the directory path`,
        remedy: HAND_DECLARED,
      },
    };
  }

  const route = `/${dirs.filter((segment) => !ROUTE_GROUP.test(segment)).join('/')}`;
  if (handler) {
    return {
      skip: {
        reason: 'endpoint',
        detail: `${route} is served by a route handler, which exports HTTP methods rather than a page`,
        remedy: HAND_DECLARED,
      },
    };
  }
  return isDynamic(route) ? dynamicSkip(route) : { route };
}

/**
 * Next Pages' contract: `.tsx`/`.jsx` files map by path with the same `index`
 * collapse Astro has, while the API zone and the five reserved root files are
 * the framework's own non-pages and say so themselves.
 */
function readNextPages(rel: string): RouteRead {
  const segments = rel.split('/');
  if (segments[0] === 'api') return null;
  const base = segments[segments.length - 1] ?? '';
  const ext = extensionOf(rel);
  if (segments.length === 1 && NEXT_PAGES_RESERVED.has(base.slice(0, base.length - ext.length))) return null;
  if (ext !== '.tsx' && ext !== '.jsx') {
    return {
      skip: {
        reason: 'unsupported-page-type',
        detail: `${ext === '' ? 'an extensionless' : `a ${ext}`} file under the Next Pages route tree is no page type this walk maps to a route`,
        remedy: HAND_DECLARED,
      },
    };
  }
  const route = fileRoute(rel);
  return isDynamic(route) ? dynamicSkip(route) : { route };
}

/** The last extension of a path, lowercased — `features.md.ts` yields `.ts`. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** The file-mapped route: the path minus its last extension, an `index` file collapsing to its directory. */
function fileRoute(rel: string): string {
  const segments = rel.slice(0, rel.length - extensionOf(rel).length).split('/');
  if (segments[segments.length - 1] === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

function isDynamic(route: string): boolean {
  return route.split('/').some((segment) => DYNAMIC_SEGMENT.test(segment));
}

// --- The command ------------------------------------------------------------

export async function runPagesScan(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'pages scan');
  const parsed = parse(args, { apply: 'boolean', json: 'boolean' });
  const json = flag(parsed.values, 'json');
  const apply = flag(parsed.values, 'apply');
  // `--apply` is optional-variadic: the names AFTER it select which pages to
  // declare, and nothing legally precedes it. `stet pages scan pricing` is a
  // name on the wrong side of the flag, and declaring every page where one was
  // asked for is the silent failure the refusal exists to prevent.
  const around = positionalsAround(parsed, 'apply');
  const stray = around.before[0];
  if (stray !== undefined) {
    throw new UsageError(`stet pages scan: selection names go after --apply — got "${stray}"`);
  }
  const names = around.after;

  const config = loadConfig(io.cwd);
  const report = new Report();
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io, { json });

  const roots = detectPagesRoots(io.cwd);
  if (roots.length === 0) {
    report.line('pages scan: no routing convention detected — expected src/pages, app/ or pages/');
    return report.emit(io, { json });
  }

  const set = proposePages(io.cwd, roots, {
    pages: descriptor.pages ?? {},
    keys: descriptor.keys,
    values: committedValues(io.cwd, config),
  });
  printPages(report, set);

  if (!apply) {
    report.line(
      set.proposals.length === 0
        ? 'pages scan: nothing to propose'
        : 'pages scan: run with --apply to declare these pages',
    );
    return report.emit(io, { json });
  }

  // The snapshot is read twice over, and the two readings want opposite
  // postures. The propose path took its default-locale NAMES leniently above,
  // where an unreadable file means no names and the run goes on. Here it is
  // about to be WRITTEN, so it loads strictly: a batch that serialized a
  // half-parsed snapshot would write the loss to disk.
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io, { json });
  applyPages(io, config, descriptor, snapshot, set, names, report);
  return report.emit(io, { json });
}

/**
 * The default-locale names the committed snapshot already carries, read
 * LENIENTLY: an absent, unreadable or malformed snapshot yields none.
 *
 * The propose path wants these only to REFUSE a name, so a strict read here
 * would kill a command that used to run — a bare host has no snapshot at all,
 * and `stet check` is what owns an unreadable one. The apply path loads the
 * same file through `snapshotOf`, strictly, because it is about to write it.
 */
function committedValues(cwd: string, config: StetConfig): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(cwd, config.snapshotPath), 'utf8'));
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const locale = config.locales.default;
  const block = Object.hasOwn(raw, locale) ? (raw as Record<string, unknown>)[locale] : undefined;
  return typeof block === 'object' && block !== null && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : {};
}

/** The two SEO keys a page scaffolds, named once for the print and the write alike. */
function seoKeys(name: string): { title: string; description: string } {
  return { title: `seo_${name}_title`, description: `seo_${name}_desc` };
}

/** The proposal set as a human report and as the `--json` payload. */
function printPages(report: Report, set: PageProposalSet): void {
  for (const proposal of set.proposals) {
    const keys = seoKeys(proposal.name);
    report.line(`${proposal.name} (${proposal.route})`);
    report.line(`  seo: ${keys.title}, ${keys.description} — scaffolded empty`);
  }
  for (const skip of set.skips) {
    report.warn('pages', `${skip.file}: skipped (${skip.reason}) — ${skip.detail}; ${skip.remedy}`);
  }
  report.data('pages', set.proposals);
  report.data('skips', set.skips);
}

/**
 * The proposals `--apply` was pointed at. A named page that produced no
 * proposal is a usage error naming what DID happen to it — a name that skipped
 * and a name that was never walked are different mistakes with different fixes.
 *
 * `email extract`'s selector is MIRRORED rather than imported: it is file-local
 * there and recovers a missed name from a file STEM, which a route-derived page
 * name has no use for. This one matches skips by the name they would have
 * taken.
 */
function selectPages(set: PageProposalSet, names: string[]): PageProposal[] {
  if (names.length === 0) return set.proposals;
  const byName = new Map(set.proposals.map((p) => [p.name, p]));
  const chosen: PageProposal[] = [];
  for (const name of new Set(names)) {
    const proposal = byName.get(name);
    if (proposal !== undefined) {
      chosen.push(proposal);
      continue;
    }
    const skip = set.skips.find((s) => s.name === name);
    const proposed = [...byName.keys()];
    throw new UsageError(
      `--apply ${name}: nothing was proposed under that name` +
        (skip === undefined ? '' : ` — ${skip.file} was skipped (${skip.reason})`) +
        (proposed.length === 0 ? '' : `; proposed: ${proposed.join(', ')}`),
    );
  }
  return chosen;
}

/**
 * The selected pages written, as ONE batch: the records, their two scaffolded
 * keys, the empty defaults and the regenerated codegen trio.
 *
 * All-or-nothing because a half-landed batch BRICKS the host, both ways: a page
 * record whose seo keys are missing and a key naming a page that is not
 * declared each make `loadDescriptorWithWarnings` throw, so `descriptorOf`
 * returns null and check, seo check, register, remove, doctor and eject all
 * stop. The codegen trio rides along for two reasons at once — the new keys
 * must typecheck in the host's editor without an intervening `stet upgrade`,
 * and `generateRegistry` stamps the WHOLE descriptor's source hash, so even a
 * page record alone would leave `stet check`'s currency gate red without it.
 */
function applyPages(
  io: CliIo,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  set: PageProposalSet,
  names: string[],
  report: Report,
): void {
  const chosen = selectPages(set, names);
  const values = (snapshot[config.locales.default] ??= {});
  const pages = (descriptor.pages ??= {});

  // The records that actually LANDED. The plans are built from this list, so a
  // batch that declared nothing writes nothing at all rather than restaling the
  // codegen over an empty change.
  const landed: PageProposal[] = [];
  const records = new Map<string, PageDef>();
  for (const proposal of chosen) {
    const keys = seoKeys(proposal.name);
    // `locales` is omitted deliberately: the rule site defaults to `['default']`
    // and naming it here would be a second place for that default to live.
    const record: PageDef = {
      route: proposal.route,
      seo: { title: keys.title, description: keys.description },
    };
    pages[proposal.name] = record;
    records.set(proposal.name, record);
    for (const key of [keys.title, keys.description]) {
      // `pages: [name]` costs nothing and is not decorative: without it the
      // key's page span in the changeset preview is silently empty.
      descriptor.keys[key] = { shape: 'text', target: DEFAULT_TARGET, pages: [proposal.name] };
      // Empty, never invented copy. Derivation would be the other honest
      // answer, and it needs a `tmpl` — which is invented copy too.
      values[key] = '';
    }
    landed.push(proposal);
  }

  // The parent was decided over the whole PROPOSAL set; it is re-checked here
  // against what this run actually declared. `pages` now holds exactly
  // (declared ∪ landed), so a selection that left the ancestor out records no
  // parent at all — nothing validates the field, so a pointer at a page nobody
  // declared would be silent residue of the class this command exists to refuse.
  for (const proposal of landed) {
    const parent = proposal.parent;
    const record = records.get(proposal.name);
    if (record !== undefined && parent !== undefined && Object.hasOwn(pages, parent)) record.parent = parent;
  }

  if (landed.length === 0) {
    report.line('pages scan: nothing to propose');
    return;
  }

  let written: string[] = [];
  let unchanged: string[] = [];
  try {
    const at = (rel: string): string => join(io.cwd, rel);
    const { keysTs, dts } = generateRegistry(descriptor);
    const plans: WritePlan[] = [
      asUpdate(planJson(at(config.descriptorPath), descriptor, config.descriptorPath)),
      asUpdate(planJson(at(config.snapshotPath), snapshot, config.snapshotPath)),
      asUpdate(planWrite(at(config.codegen.registry), keysTs, config.codegen.registry)),
      asUpdate(planWrite(at(config.codegen.dts), dts, config.codegen.dts)),
      asUpdate(planWrite(at(config.codegen.defaults), generateDefaultsModule(snapshot), config.codegen.defaults)),
    ];
    ({ written, unchanged } = writePlanned(plans));
  } catch (error) {
    // A refusal already says what it refused and that nothing was written; an
    // I/O failure says neither, and the batch's whole promise is that a failure
    // left nothing behind.
    if (error instanceof CliError || error instanceof UsageError) throw error;
    const path = (error as { path?: string }).path;
    throw new CliError(
      `pages scan --apply: the write batch failed${path === undefined ? '' : ` at ${path}`} — ` +
        `${(error as Error).message}. Every file this run had already written was put back.`,
    );
  }

  for (const label of unchanged) report.line(`${label}: already current`);
  for (const label of written) report.line(`wrote ${label}`);
  report.line(`declared ${landed.length} page(s), scaffolded ${landed.length * 2} key(s); next: stet seo check`);
  // The red this run just created, announced rather than met at the next
  // command: every scaffolded description is empty, and an empty description is
  // exactly what the `missing-description` rule reports at error severity. The
  // count is ADDITIONS — a partially declared host already carries its own.
  report.line(
    `seo check will now report ${landed.length} more missing descriptions — the scaffolded values are empty; ` +
      'write them and re-run stet seo check',
  );
}

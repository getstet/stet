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
 * The detector reads directory entries and file names; under `pages scan`, a
 * markdown page's frontmatter block is the one content read, and only when
 * seeding is on. Adoption's never-read boundary holds where it is stated —
 * `scan`'s drift warn calls the detector with no seed option — and the tree
 * walked is the framework's own rather than a glob's: a glob gate would drop
 * the very endpoints the taxonomy has to report.
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

import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { route as normalizeRoute } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, type Descriptor, type PageDef } from '../src/types.js';
import { flag, parse, positionalsAround, refuseEnv } from './args.js';
import { planRepoForms, rethrowBatchFailure, writePlanned } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { isHtmlHost, loadConfig, type StetConfig } from './config.js';
import { filesForGlobs, walk } from './files.js';
import { proposeHtml } from './html-host.js';
import type { CliIo } from './main.js';
import { clip, plural, posixRelative, CliError, Report, UsageError } from './report.js';

// --- The dirent walk --------------------------------------------------------

/**
 * The walk lives in `cli/files.ts` now that `html-host` reads file lists too.
 * Re-exported here because `eject` and `email extract` reach it by this name.
 */
export { walk };

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

export type PagesArm = 'astro' | 'next-app' | 'next-pages' | 'html';

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
 * A directory alone proves nothing — `init` detects the router through this
 * same detector — so nothing here reads `config.router` and every arm is
 * confirmed by a file name below it. Arms may coexist: Next serves `app/` and
 * `pages/` concurrently, and both walk.
 *
 * Zero arms is not an error. The command says what it probed and exits 0; a
 * host whose Astro `srcDir` moves the tree lands here, which is the fail-safe
 * side of a bounded residue rather than a guess at where the pages went.
 */
export function detectPagesRoots(cwd: string, options: { html?: boolean } = {}): PagesRoot[] {
  // The ONE arm the CONFIG selects rather than a directory probe, and the
  // stated exception to this detector's never-`config.router` rule: a
  // static-HTML host has no framework tree to probe, and `host: "html"` is the
  // developer's own declaration, confirmed by `init`. The root is the
  // repository root, and the managed surfaces name the files.
  if (options.html === true) return [{ arm: 'html', root: '' }];
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
  /** A markdown page's frontmatter title and description, where seeding is on and the block yields either. */
  seed?: { title?: string; description?: string };
  /**
   * The keys an html page's `<title>` and meta description are already MARKED
   * with, under `bind`. A field with no mark is absent, and the apply scaffolds
   * nothing for it.
   */
  bound?: { title?: string; description?: string };
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
 * names; under `pages scan`, a markdown page's frontmatter block is the one
 * content read, and only when seeding is on.
 */
export function proposePages(
  cwd: string,
  roots: PagesRoot[],
  declared: DeclaredState,
  options: {
    seed?: boolean;
    /** Read each html page's MARKS and bind its title and description to them. */
    bind?: boolean;
    config?: Pick<StetConfig, 'managedSurfaces'>;
  } = {},
): PageProposalSet {
  // Every arm's files in ONE path-sorted union. Walk order is what decides
  // which of two colliding routes is the LATER one, so it has to be
  // deterministic across arms rather than per-arm.
  const files: Array<{ arm: PagesArm; file: string; rel: string }> = [];
  for (const root of roots) {
    // The html arm's files come from the managed surfaces rather than a walk of
    // the root: the glob's own walk already skips `node_modules`, `.git` and
    // `dist`, and every non-`.html` file is silent by construction.
    if (root.arm === 'html') {
      for (const rel of filesForGlobs(cwd, options.config?.managedSurfaces ?? [])) {
        if (rel.endsWith('.html')) files.push({ arm: 'html', file: rel, rel });
      }
      continue;
    }
    const base = join(cwd, root.root);
    walk(base, (abs) => {
      files.push({ arm: root.arm, file: posixRelative(cwd, abs), rel: posixRelative(base, abs) });
    });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // The arm's ONE content read: which key each page's `<title>` and meta
  // description already carry. Computed once, over the html files alone.
  const bound =
    options.bind === true && files.some((f) => f.arm === 'html')
      ? boundFields(
          cwd,
          files.filter((f) => f.arm === 'html').map((f) => f.file),
        )
      : new Map<string, { title?: string; description?: string }>();

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
    const read =
      arm === 'html'
        ? { route: fileRoute(rel) }
        : arm === 'astro'
          ? readAstro(rel)
          : arm === 'next-app'
            ? readNextApp(rel)
            : readNextPages(rel);
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
      // The seed rides the same read on the page that OWNS this route: a file
      // and the key it seeded diverging is the one thing a seed can hide, so
      // the skip names the difference rather than passing over it.
      let detail = `page "${declaredAt}" already declares the route ${route}`;
      for (const [field, value] of driftedFields(cwd, file, declared, declaredAt, options)) {
        detail += ` — frontmatter ${field} differs from ${value}'s default`;
      }
      skip('already-declared', detail, 'nothing to declare — the page record is already there', name);
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
    if (options.seed === true && isMarkdown(proposal.file)) {
      const seed = readFrontmatter(join(cwd, proposal.file));
      if (seed) proposal.seed = seed;
    }
    // Always set on the html arm, empty included: its presence is what tells
    // the print and the apply that this page binds rather than scaffolds.
    if (arm === 'html') proposal.bound = bound.get(file) ?? {};
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
 * Which key each html page's `<title>` and `<meta name="description">` already
 * carry — the html arm's ONE content read.
 *
 * The mark is the binding: a field with no mark yields nothing, because
 * scaffolding a key no element renders would trip `check`'s unmarked-key warn
 * on every later run. The honest red is `seo check`'s own missing-field rule.
 */
function boundFields(
  cwd: string,
  files: string[],
): Map<string, { title?: string; description?: string }> {
  const bound = new Map<string, { title?: string; description?: string }>();
  const set = proposeHtml(cwd, files);
  for (const mark of set.claimed) {
    const field =
      mark.kind === 'element' && mark.tag === 'title'
        ? 'title'
        : mark.kind === 'attribute' &&
            mark.attr === 'content' &&
            mark.element.attrs.some((a) => a.name === 'name' && a.value === 'description')
          ? 'description'
          : null;
    if (field === null) continue;
    const entry = bound.get(mark.file) ?? {};
    // The FIRST marked one wins, the rule an HTML parser follows: a document
    // with two `<title>` elements renders the first, so binding the second
    // would name a key the browser never shows. Marks arrive in document order.
    if (entry[field] !== undefined) continue;
    entry[field] = mark.key;
    bound.set(mark.file, entry);
  }
  return bound;
}

/** A markdown page — the one file type whose contents this command opens. */
function isMarkdown(path: string): boolean {
  const ext = extensionOf(path);
  return ext === '.md' || ext === '.mdx';
}

/**
 * A markdown page's frontmatter title and description, where the block yields
 * either — the ONE content read this command makes, and only under seeding.
 *
 * No YAML: the block is line-oriented and two top-level one-line scalars are
 * the whole grammar, so a folded or nested value simply yields no seed rather
 * than a parse this package would have to carry a dependency for. Every shape
 * outside the grammar fails toward no seed, which scaffolds empty — the
 * behaviour a markdown page had before it seeded at all.
 */
function readFrontmatter(abs: string): { title?: string; description?: string } | undefined {
  const lines = readFileSync(abs, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined; // an unterminated block is not a block

  const seed: { title?: string; description?: string } = {};
  const seen = new Set<string>();
  for (let i = 1; i < end; i++) {
    const match = FRONTMATTER_FIELD.exec(lines[i] ?? '');
    if (match === null) continue;
    const field = match[1] as 'title' | 'description';
    if (seen.has(field)) continue; // the first occurrence per field wins
    seen.add(field);
    const value = scalarValue(match[2] ?? '');
    if (value !== undefined) seed[field] = value;
  }
  return seed.title === undefined && seed.description === undefined ? undefined : seed;
}

/** A top-level one-line `title:` or `description:` in a frontmatter block. */
const FRONTMATTER_FIELD = /^(title|description):[ \t]*(.*)$/;

/**
 * One frontmatter scalar, or `undefined` where the value is not one this reads.
 *
 * A quoted value seeds only when its closing quote is the LAST character: a
 * trailing YAML comment after a quoted scalar would otherwise land inside the
 * seed, and stripping it would be a parse. An unquoted value is cut at its
 * first ` #`, which is YAML's own comment boundary for a plain scalar.
 */
function scalarValue(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '' || value.startsWith('>') || value.startsWith('|')) return undefined;
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    return value.length >= 2 && value.endsWith(quote) ? value.slice(1, -1) : undefined;
  }
  const comment = value.indexOf(' #');
  const cut = (comment === -1 ? value : value.slice(0, comment)).trim();
  return cut === '' ? undefined : cut;
}

/**
 * The seeded fields whose frontmatter value differs from the key's committed
 * default, on the page that already declares this route — each yielded as its
 * field name and the key whose default it disagrees with.
 */
function driftedFields(
  cwd: string,
  file: string,
  declared: DeclaredState,
  declaredAt: string,
  options: { seed?: boolean },
): Array<[string, string]> {
  if (options.seed !== true || !isMarkdown(file)) return [];
  const seed = readFrontmatter(join(cwd, file));
  const seo = declared.pages[declaredAt]?.seo;
  if (seed === undefined || typeof seo !== 'object' || seo === null) return [];
  const record = seo as Record<string, unknown>;
  const drifted: Array<[string, string]> = [];
  for (const field of ['title', 'description'] as const) {
    const value = seed[field];
    const key = record[field];
    if (value === undefined || typeof key !== 'string') continue;
    const current = Object.hasOwn(declared.values, key) ? declared.values[key] : undefined;
    if (typeof current === 'string' && current !== value) drifted.push([field, key]);
  }
  return drifted;
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
 * splits the classes into three: `.astro`/`.html`/`.md`/`.mdx` are pages,
 * `.ts`/`.js` are endpoints, and everything else is a type this walk maps to no
 * route. An endpoint keeps every earlier dot — `features.md.ts` serves
 * `/features.md`.
 */
function readAstro(rel: string): RouteRead {
  const ext = extensionOf(rel);
  const route = fileRoute(rel);
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
  if (ext !== '.astro' && ext !== '.html' && ext !== '.md' && ext !== '.mdx') {
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

  const set = proposeForHost(io.cwd, config, descriptor);
  if (set === null) {
    report.line('pages scan: no routing convention detected — expected src/pages, app/ or pages/');
    return report.emit(io, { json });
  }
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
  applyPages(io.cwd, config, descriptor, snapshot, set, names, report);
  return report.emit(io, { json });
}

/**
 * The host's own routing convention as a proposal set, seeded and bound —
 * `pages scan`'s propose half, cut out so the local dashboard's Declare button
 * runs the same walk rather than a second one. `null` where the host carries no
 * routing convention at all; the caller says so in its own words.
 */
export function proposeForHost(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
): PageProposalSet | null {
  const roots = detectPagesRoots(cwd, { html: isHtmlHost(config) });
  if (roots.length === 0) return null;
  return proposePages(
    cwd,
    roots,
    {
      pages: descriptor.pages ?? {},
      keys: descriptor.keys,
      values: committedValues(cwd, config),
    },
    { seed: true, bind: true, config },
  );
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

/** How much of a seeded value the plan shows before the apply writes it whole. */
const SEED_EXCERPT = 80;

/** The two SEO keys a page scaffolds, named once for the print and the write alike. */
function seoKeys(name: string): { title: string; description: string } {
  return { title: `seo_${name}_title`, description: `seo_${name}_desc` };
}

/** The proposal set as a human report and as the `--json` payload. */
function printPages(report: Report, set: PageProposalSet): void {
  for (const proposal of set.proposals) {
    const keys = seoKeys(proposal.name);
    report.line(`${proposal.name} (${proposal.route})`);
    // On the html arm the two fields are reported one by one: each is either
    // bound to the key its element carries, or absent with `register` named.
    if (proposal.bound !== undefined) {
      for (const field of ['title', 'description'] as const) {
        const key = proposal.bound[field];
        report.line(
          key === undefined
            ? `  ${field}: no marked ${field === 'title' ? '<title>' : 'meta description'} — run stet register first, or declare it by hand`
            : `  ${field}: bound to ${key}`,
        );
      }
      continue;
    }
    const origin = proposal.seed === undefined ? 'scaffolded empty' : 'seeded from frontmatter';
    report.line(`  seo: ${keys.title}, ${keys.description} — ${origin}`);
    // The value the apply is about to write, shown before it lands: a seed is
    // the host's own copy, and copy stet is about to commit is copy the
    // operator gets to read first.
    for (const field of ['title', 'description'] as const) {
      const value = proposal.seed?.[field];
      if (value !== undefined) report.line(`  ${field}: "${clip(value, SEED_EXCERPT)}"`);
    }
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
 *
 * It takes the checkout PATH rather than an io: the working directory was the
 * only thing it read from one, and the local dashboard's Declare route holds a
 * path with no terminal behind it.
 */
export function applyPages(
  cwd: string,
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
    // The html arm BINDS: the record references the keys the page's own
    // elements are marked with, and only those. It mints nothing — a scaffolded
    // key no element marks would trip `check`'s unmarked-key warn forever, so
    // the honest red for a missing field is `seo check`'s own.
    if (proposal.bound !== undefined) {
      const seo: PageDef['seo'] = {};
      if (proposal.bound.title !== undefined) seo.title = proposal.bound.title;
      if (proposal.bound.description !== undefined) seo.description = proposal.bound.description;
      const record: PageDef = { route: proposal.route };
      if (Object.keys(seo).length > 0) record.seo = seo;
      pages[proposal.name] = record;
      records.set(proposal.name, record);
      // The bound key gains the page in its `pages` array — the reverse index a
      // scaffolded key gets, without which the changeset preview's page span is
      // silently empty.
      for (const key of Object.values(seo)) {
        const def = descriptor.keys[key];
        if (def === undefined) continue;
        const listed = def.pages ?? [];
        if (!listed.includes(proposal.name)) def.pages = [...listed, proposal.name];
      }
      landed.push(proposal);
      continue;
    }
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
    }
    // Empty, never invented copy — a markdown page's frontmatter seed is the
    // host's own copy rather than a guess. Derivation would be the other honest
    // answer for the rest, and it needs a `tmpl` — which is invented copy too.
    values[keys.title] = proposal.seed?.title ?? '';
    values[keys.description] = proposal.seed?.description ?? '';
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

  // The BACKFILL, over the full declared set and before the empty-landing
  // return: `parent` was computed over one run's proposal set, so a page whose
  // ancestor was declared later kept none forever. A present `parent` is the
  // developer's word and is never rewritten; a run that lands nothing but fills
  // one still writes, which is why this sits above the return.
  const declaredRoutes = new Map<string, string>();
  for (const [name, record] of Object.entries(pages)) {
    declaredRoutes.set(normalizeRoute(record.route), name);
  }
  let backfilled = 0;
  for (const [name, record] of Object.entries(pages)) {
    if (record.parent !== undefined) continue;
    const parent = nearestParent(record.route, new Map(), declaredRoutes);
    if (parent !== undefined && parent !== name) {
      record.parent = parent;
      backfilled += 1;
    }
  }

  if (landed.length === 0 && backfilled === 0) {
    report.line('pages scan: nothing to propose');
    return;
  }

  let written: string[] = [];
  let unchanged: string[] = [];
  try {
    ({ written, unchanged } = writePlanned(planRepoForms(cwd, config, descriptor, snapshot, report)));
  } catch (error) {
    rethrowBatchFailure('pages scan --apply', error);
  }

  for (const label of unchanged) report.line(`${label}: already current`);
  for (const label of written) report.line(`wrote ${label}`);
  if (backfilled > 0) report.line(`backfilled parent on ${backfilled} page(s)`);
  if (landed.length === 0) return;
  // The html arm's own close: this run scaffolded nothing and seeded nothing,
  // so today's two lines would both be zero. What matters instead is how many
  // fields bound and how many pages still lack one.
  if (landed.every((proposal) => proposal.bound !== undefined)) {
    const fields = landed.reduce(
      (total, proposal) => total + Object.keys(proposal.bound ?? {}).length,
      0,
    );
    const short = landed.filter(
      (proposal) => proposal.bound?.title === undefined || proposal.bound?.description === undefined,
    ).length;
    report.line(
      `declared ${plural(landed.length, 'page')}, ` +
        `bound ${plural(fields, 'field')}; ` +
        `${plural(short, 'page')} lack a marked title or description — stet seo check names them`,
    );
    return;
  }
  report.line(`declared ${landed.length} page(s), scaffolded ${landed.length * 2} key(s); next: stet seo check`);
  // The red this run just created, announced rather than met at the next
  // command: a scaffolded value left empty is exactly what the `missing-title`
  // and `missing-description` rules report at error severity. The counts are
  // ADDITIONS — a partially declared host already carries its own — and they
  // are counted per field off what was actually written, so a frontmatter seed
  // that filled one field and not the other makes the two differ.
  const empty = (field: 'title' | 'description'): number =>
    landed.filter((proposal) => values[seoKeys(proposal.name)[field]] === '').length;
  const titles = empty('title');
  const descriptions = empty('description');
  report.line(
    titles === 0 && descriptions === 0
      ? 'seo check will report nothing new — the scaffolded values were seeded from frontmatter'
      : `seo check will now report ${titles} more missing titles and ${descriptions} more missing descriptions — ` +
        'write the empty values and re-run stet seo check',
  );
}

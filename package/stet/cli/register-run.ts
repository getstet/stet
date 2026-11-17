/**
 * The JSX run's first pass and its names, shared by `register` and `scan`: every
 * managed surface parsed and classified, the copy modules walked for the names
 * they reserve, each literal a declared key already holds given that key, and
 * the rest named by role and numbered across the run. `register` adopts what
 * this returns; `scan` prints the same names, so the name scan proposes is the
 * key register adds.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { keyDefOf, pageKeyReferences } from '../src/descriptor.js';
import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, EMAIL_TARGET, type Descriptor, type Target } from '../src/types.js';
import { astroEdits, componentCache, planAstroFile, readableAs, rereadsClean, type AstroPlan } from './astro-rewrite.js';
import type { StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { heldTextOf } from './html-host.js';
import { isHeadKind, numberNames } from './key-names.js';
import { pageOfFile, routeOfFile } from './pages.js';
import { planMount, type MountPlan } from './provider-mount.js';
import { lineCol, type Report } from './report.js';
import { applyFileEdits, jsxReads, jsxRichClean, planRewrite } from './rewrite.js';
import {
  componentName,
  dialectOf,
  isJsxFile,
  loadTypescript,
  matchGlob,
  nonCopyProp,
  scanModule,
  scanSource,
  type LocatedLiteral,
  type ModuleScanResult,
  type ScanResult,
} from './source-scan.js';
import { validateUnnamed } from './validate.js';

/** App-Router files that are server components by default — every other .tsx is ambiguous without a directive. */
const ROUTE_FILES = new Set([
  'page',
  'layout',
  'template',
  'default',
  'loading',
  'error',
  'global-error',
  'not-found',
  'route',
]);

/**
 * The descriptor as RAW parsed JSON, as `scan` reads it — `stet check` owns an
 * unreadable descriptor, so the adoption verdict validates nothing.
 */
interface RawDescriptor {
  keys?: unknown;
}

/** The snapshot as raw parsed JSON — only the `default` block, which is what a seeded default lives in. */
interface RawSnapshot {
  default?: unknown;
}

/** Whether a copy module's literal is already adopted, has drifted from what was adopted, or is new. */
export type Adoption = 'adopted' | 'diverged' | 'unadopted';

/**
 * The ONE adoption verdict, over the whole name space, shared by `scan`'s
 * copy-module loop and `register`'s. Idempotence is TRUE rather than asserted
 * because both ask this: run two classifies everything `adopted` and adds
 * nothing, and scan says nothing about it.
 *
 * `unadopted` — no own descriptor key of that name. `diverged` — a key exists,
 * and the snapshot default is absent or not byte-equal to what the module says;
 * that is exactly the drift the gate exists to name, so it is reported and never
 * adopted over. `adopted` — an own key, an own default, byte-equal.
 *
 * Membership is `Object.hasOwn` on BOTH maps. These are JSON-parsed objects and
 * `constructor` is a perfectly ordinary copy-module property name that passes
 * the key grammar; a bare lookup answers it from the prototype and reads a key
 * that was never declared.
 */
export function classifyAdoption(
  descriptor: RawDescriptor | null,
  snapshot: RawSnapshot | null,
  key: string,
  text: string,
): Adoption {
  const keys = descriptor?.keys;
  if (!isRecord(keys) || !Object.hasOwn(keys, key)) return 'unadopted';
  const defaults = snapshot?.default;
  if (!isRecord(defaults) || !Object.hasOwn(defaults, key)) return 'diverged';
  const stored = defaults[key];
  if (typeof stored !== 'string') return 'diverged';
  return Buffer.from(stored, 'utf8').equals(Buffer.from(text, 'utf8')) ? 'adopted' : 'diverged';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value a literal seeds its key with: a sentence key's tagged value, else its text (D16). */
export function seedOf(literal: LocatedLiteral): string {
  return literal.rich?.value ?? literal.text;
}

/**
 * The keys each text is held by, sorted by name: every web `text` key with a literal default-locale
 * value, no `tags`, no template slot, no `brand__` prefix, and no page SEO or JSON-LD reference —
 * the keys a literal or a save may share with.
 */
export function sharedTextIndex(descriptor: Descriptor, snapshot: Snapshot): Map<string, string[]> {
  const notShared = new Set(pageKeyReferences(descriptor).map((ref) => ref.key));
  for (const [template, def] of Object.entries(descriptor.templates ?? {})) {
    for (const slot of def.slots) notShared.add(`${template}__${slot}`);
  }
  const index = new Map<string, string[]>();
  for (const key of Object.keys(descriptor.keys).sort()) {
    const text = heldTextOf(descriptor, snapshot, key);
    const def = keyDefOf(descriptor, key);
    if (text === null || def === undefined || def.tags !== undefined) continue;
    if (notShared.has(key) || key.startsWith('brand__')) continue;
    index.set(text, [...(index.get(text) ?? []), key]);
  }
  return index;
}

export interface JsxRun {
  /** The files pass one parsed, by path — scan's loop reads these instead of parsing again. */
  parsed: Map<string, ScanResult | null>;
  /** The files it adopts from, with their literals, as register's pass two reads them; an `.astro` file carries its plan. */
  adoptable: Array<{ file: string; source: string; literals: LocatedLiteral[]; target: Target; kind: 'server' | 'client'; astro?: AstroPlan }>;
  /** The name each adoptable literal takes, numbered or reused (D2). */
  nameOf: Map<LocatedLiteral, string>;
  /** Literals that reuse a declared key (D2); their name is in `nameOf`. */
  reused: Set<LocatedLiteral>;
  /**
   * Each literal whose text a leading literal of the run carries — the same
   * target, both visible text or both head texts — and that leading literal
   * (`leadingOrder`): one key, the leader's. A leader may be one the run refused, which leaves
   * its followers unadopted with it; a follower's name, where its leader has
   * one, is the leader's in `nameOf`.
   */
  sharedWith: Map<LocatedLiteral, LocatedLiteral>;
  refusals: string[];
  /** Template-dialect files in the managed surfaces other than `.astro`: read by scan's dialect walk, never parsed or rewritten here. */
  dialectFiles: string[];
  /** The texts this pass does not rewrite (an `.astro` file's findings, a JSX sentence or a tag attribute inside one), each with its reason, in run order. */
  skips: Array<{ file: string; line: number; text: string; reason: string }>;
  /** Each `application/ld+json` script of an `.astro` file: listed, never rewritten. */
  structured: Array<{ file: string; line: number }>;
  /** Display strings in the module-scope data of JSX files: reported, never rewritten. */
  dataFindings: Array<{ file: string; line: number; text: string }>;
  /** The copy-module walk's results and property names, which the naming reserves. */
  modules: Map<string, ModuleScanResult>;
  propertyNames: Map<string, string>;
  /** The CopyProvider mount the run's client rewrites need, where the layout does not carry it yet. */
  mount?: MountPlan;
  /** A client file met a layout whose mount could not be located: its literals took the fallback warn. */
  mountUnlocated?: true;
}

export async function planJsxRun(input: {
  cwd: string;
  config: StetConfig;
  descriptor: Descriptor;
  snapshot: Snapshot;
  report: Report;
  forcedKind?: 'server' | 'client';
}): Promise<JsxRun> {
  const { cwd, config, descriptor, snapshot, report, forcedKind } = input;

  // What the JSX walk parsed and CLAIMED, per file. A file both declarations
  // match is parsed once and every literal is owned by exactly one
  // classification; `null` marks a file the parser refused, which the module
  // loop then leaves alone rather than refusing it a second time.
  const parsed = new Map<string, ScanResult | null>();

  // ONE collection across BOTH loops, flushed below the adopted lines: a dialect
  // host refuses the same files in the surface loop that the module loop would
  // meet, and the parsed map above already yields a single refusal per file.
  const refusals: string[] = [];
  const dialectFiles: string[] = [];
  const dataFindings: JsxRun['dataFindings'] = [];
  const skips: JsxRun['skips'] = [];
  const structured: JsxRun['structured'] = [];
  const components = componentCache();
  let ts: typeof import('typescript') | undefined;

  // The text each declared web `text` key holds, as the descriptor stood before
  // the run: a literal whose text a key already holds reads that key rather
  // than taking a numbered name beside it — the html host's first-pass rule,
  // the first key by name winning. `heldTextOf` answers web keys alone, so an
  // email literal never reads one.
  const index = sharedTextIndex(descriptor, snapshot);
  const reuseOf = new Map<LocatedLiteral, string>();
  // The declared key a literal reads in place of a new one: web text only, and
  // never for a head text, which a visible key's edit must not retitle (R32),
  // or for a sentence key, whose tags no declared key carries (D16).
  const reuseFor = (literal: LocatedLiteral, target: Target): string | undefined =>
    target === DEFAULT_TARGET && !isHeadLiteral(literal) && literal.rich === undefined ? index.get(literal.text)?.[0] : undefined;

  // Pass one: every surface parsed and classified before any literal is named,
  // so a role that repeats across the run is numbered across it. Every literal
  // located is kept in run order, adopted or not, for the share rule below.
  const adoptable: JsxRun['adoptable'] = [];
  const located: Array<{ literal: LocatedLiteral; target: Target }> = [];
  let mount: 'mounted' | MountPlan | null | undefined;
  for (const file of filesForGlobs(cwd, config.managedSurfaces)) {
    if (dialectOf(file) === 'astro') {
      // An Astro file is read by its own rewriter: what it proves safe joins the run, the rest is listed.
      parsed.set(file, null);
      ts ??= await loadTypescript();
      const source = readFileSync(join(cwd, file), 'utf8');
      const page = pageOfFile(cwd, file, descriptor.pages);
      const { literals: found, plan } = planAstroFile({ ts, cwd, config, file, source, page, cache: components });
      const listed = (literal: { pos: number; text: string }, reason: string): void => {
        skips.push({ file, line: lineCol(source, literal.pos).line, text: literal.text, reason });
      };
      for (const skip of plan.skips) listed(skip, skip.reason);
      for (const pos of plan.structured) structured.push({ file, line: lineCol(source, pos).line });
      const target = targetFor(file, config);
      // A key that is no identifier cannot be read as `copy.<key>`: that literal alone is listed.
      const candidates = found.filter((literal) => {
        const key = reuseFor(literal, target) ?? literal.proposedKey;
        if (readableAs(key, plan.form)) return true;
        listed(literal, `${key} cannot be read as copy.${key}`);
        return false;
      });
      for (const literal of candidates) located.push({ literal, target });
      const literals = candidates.filter((literal) => {
        if (reuseFor(literal, target) !== undefined) return true;
        return validateUnnamed({
          descriptor,
          snapshot,
          placeholder: '\u0001',
          def: { shape: 'text', target, ...(literal.rich === undefined ? {} : { tags: literal.rich.tags }) },
          stored: literal.text,
          value: literal.text,
          report,
          name: literal.proposedKey,
          keep: false,
        });
      });
      if (literals.length === 0) continue;
      // The whole file read back with the names this pass gives; any doubt keeps every byte.
      const { edits, reads, moved } = astroEdits(source, plan, literals.map((literal) => ({ literal, key: reuseFor(literal, target) ?? literal.proposedKey })));
      let clean: boolean;
      try {
        clean = rereadsClean(ts, file, source, applyFileEdits(source, edits), reads, moved);
      } catch {
        clean = false;
      }
      if (!clean) {
        for (const literal of literals) listed(literal, 'the rewrite did not read back cleanly');
        continue;
      }
      for (const literal of literals) {
        const reuse = reuseFor(literal, target);
        if (reuse !== undefined) reuseOf.set(literal, reuse);
      }
      adoptable.push({ file, source, literals, target, kind: 'server', astro: plan });
      continue;
    }
    if (dialectOf(file) !== null) {
      // A template dialect is read by scan's dialect walk and never rewritten: its copy is placed by hand.
      dialectFiles.push(file);
      parsed.set(file, null);
      continue;
    }
    const source = readFileSync(join(cwd, file), 'utf8');
    const page = pageOfFile(cwd, file, descriptor.pages);
    const result = await scanSource(file, source, {
      readPathImport: config.readPath.import,
      ...(page === undefined ? {} : { page }),
    });
    if (result.parseErrors) {
      refusals.push(`${file}: could not be parsed cleanly — reported, not adopted`);
      parsed.set(file, null);
      continue;
    }
    // Recorded BEFORE the early returns below: this walk classified the file's
    // JSX positions whether or not it went on to adopt any of them.
    parsed.set(file, result);
    for (const found of result.data) dataFindings.push({ file, line: lineCol(source, found.pos).line, text: found.text });
    const listed = (literal: { pos: number; text: string }, reason: string): void => {
      skips.push({ file, line: lineCol(source, literal.pos).line, text: literal.text, reason });
    };
    // A sentence kept as written, and a copy attribute on a tag a sentence key copies, are listed (D16).
    for (const item of result.listed) listed(item, item.reason);
    // A component's prop that carries words no visitor reads (`aria-*`, a test id, an event name) is
    // reported and left, and it takes no part in the run: no name, no key to share.
    const candidates = result.literals.filter((literal) => {
      if (literal.context !== 'jsx-attr' || literal.place?.attr === undefined || !componentName(literal.place.tag) || !nonCopyProp(literal.place.attr)) return true;
      report.warn('scan', `${file}: ${JSON.stringify(literal.proposedKey)} ${skipReason('non-copy-prop')} — adopt by hand`);
      return false;
    });
    if (candidates.length === 0) continue;

    const target = targetFor(file, config);
    for (const literal of candidates) located.push({ literal, target });
    const kind = kindFor(file, result.hasUseClient, config, forcedKind);
    if (kind === null) {
      report.warn('scan', `${file}: ambiguous — an un-directived App-Router component; re-run with --kind server|client`);
      continue;
    }
    // The first client-kind file asks for the mount once; the answer holds for the run.
    if (kind === 'client' && mount === undefined) mount = await planMount(cwd, config);
    if (kind === 'client' && mount === null) {
      for (const literal of candidates) {
        report.warn(
          'scan',
          `${file}: ${JSON.stringify(literal.proposedKey)} needs a client rewrite, but the CopyProvider mount could not be located in ` +
            `${config.rootLayout ?? 'the root layout'} — mount it by hand, then run stet register again`,
        );
      }
      continue;
    }
    // A literal the gate or the rewrite would refuse is reported here and takes
    // no name, so a run's numbers have no gaps. Neither depends on the key's name.
    // A literal a declared key already holds skips the gate — its value is
    // declared — and only its rewrite is proven.
    const literals = candidates.filter((literal) => {
      const reuse = reuseFor(literal, target);
      if (reuse === undefined) {
        const passed = validateUnnamed({
          descriptor,
          snapshot,
          placeholder: '\u0001',
          def: { shape: 'text', target, ...(literal.rich === undefined ? {} : { tags: literal.rich.tags }) },
          stored: seedOf(literal),
          value: seedOf(literal),
          report,
          name: literal.proposedKey,
          keep: false,
        });
        if (!passed) return false;
      }
      const planned = planRewrite(source, literal, reuse ?? literal.proposedKey, kind, config.readPath.import);
      if (planned.skipped === undefined) {
        if (reuse !== undefined) reuseOf.set(literal, reuse);
        return true;
      }
      report.warn('scan', `${file}: ${JSON.stringify(literal.proposedKey)} ${skipReason(planned.skipped)} — adopt by hand`);
      return false;
    });
    // A file holding a sentence is read back with the names this pass gives; any doubt keeps every byte (D16).
    if (literals.some((literal) => literal.context === 'jsx-rich')) {
      const landed = literals.map((literal) => ({ literal, key: reuseFor(literal, target) ?? literal.proposedKey }));
      const edits = landed.flatMap(({ literal, key }) => planRewrite(source, literal, key, kind, config.readPath.import).edits);
      let clean: boolean;
      try {
        ts ??= await loadTypescript();
        clean = await jsxRichClean(ts, file, source, applyFileEdits(source, edits), jsxReads(edits, landed));
      } catch {
        clean = false;
      }
      if (!clean) {
        for (const literal of literals) {
          reuseOf.delete(literal);
          listed(literal, 'the rewrite did not read back cleanly');
        }
        continue;
      }
    }
    if (literals.length > 0) adoptable.push({ file, source, literals, target, kind });
  }

  // The copy modules, walked once here for their own names — which no JSX name
  // may take — and again by register for adoption.
  const modules = new Map<string, ModuleScanResult>();
  const propertyNames = new Map<string, string>();
  for (const file of filesForGlobs(cwd, config.copyModules)) {
    const handoff = parsed.get(file);
    if (handoff === null) continue;
    const result = await scanModule(file, readFileSync(join(cwd, file), 'utf8'), handoff);
    modules.set(file, result);
    for (const literal of result.literals) {
      if (literal.shape === 'property' || literal.shape === 'plain') propertyNames.set(literal.proposedKey, file);
    }
  }

  // Identical text within the run is one key (stage-0 finding 14): the leading
  // literal carrying it is named, and each other one reads that key. A head text never shares with visible text, and a literal a declared
  // key already holds reads that key instead.
  const sharedWith = new Map<LocatedLiteral, LocatedLiteral>();
  const first = new Map<string, LocatedLiteral>();
  // The leader names the key: the one on the home page first, then on the
  // shallowest route, then in a file serving none; the file path breaks a tie,
  // and run order the rest.
  const byLeading = leadingOrder(cwd);
  const leading = [...located].sort((a, b) => byLeading(a.literal.file, b.literal.file));
  for (const { literal, target } of leading) {
    if (reuseOf.has(literal) || reuseFor(literal, target) !== undefined) continue;
    const head = isHeadLiteral(literal);
    // A sentence key shares only with an identical sentence: its value's tags mean nothing to a plain text.
    const slot = `${target}\u0000${head ? 'head' : 'body'}\u0000${literal.rich === undefined ? 'text' : 'rich'}\u0000${seedOf(literal)}`;
    const leader = first.get(slot);
    if (leader === undefined) first.set(slot, literal);
    else sharedWith.set(literal, leader);
  }

  // The names: the rule's, numbered across the run past every key declared
  // before it and every copy-module name; a reused literal takes its key and
  // no number, and a follower its leader's.
  const fresh = adoptable.flatMap((f) => f.literals).filter((literal) => !reuseOf.has(literal) && !sharedWith.has(literal));
  const before = new Set(Object.keys(descriptor.keys));
  const numbered = numberNames(
    fresh.map((l) => l.proposedKey),
    (name) => before.has(name) || propertyNames.has(name),
  );
  const nameOf = new Map<LocatedLiteral, string>([...reuseOf, ...fresh.map((literal, i) => [literal, numbered[i] as string] as const)]);
  for (const [literal, leader] of sharedWith) {
    const name = nameOf.get(leader);
    if (name !== undefined) nameOf.set(literal, name);
  }
  return {
    parsed,
    adoptable,
    nameOf,
    reused: new Set(reuseOf.keys()),
    sharedWith,
    refusals,
    dialectFiles,
    skips,
    structured,
    dataFindings,
    modules,
    propertyNames,
    ...(typeof mount === 'object' && mount !== null ? { mount } : {}),
    ...(mount === null ? { mountUnlocated: true as const } : {}),
  };
}

/**
 * The order a shared key's leader is chosen in, over two files: the home page
 * first, then the shallowest route, then a file that serves none, the file path
 * breaking a tie. `register` meets files in this order, so a leader's key has
 * landed when its followers are met.
 */
export function leadingOrder(cwd: string): (a: string, b: string) => number {
  const ranks = new Map<string, number>();
  const rankOf = (file: string): number => {
    let rank = ranks.get(file);
    if (rank === undefined) {
      const route = routeOfFile(cwd, file);
      // The depth is a count of segments, far below the tier's weight.
      rank = route === undefined ? 2e6 : route === '/' ? 0 : 1e6 + route.split('/').filter(Boolean).length;
      ranks.set(file, rank);
    }
    return rank;
  };
  return (a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Whether a literal is a head text: its place names one, or the Astro rewriter found it in `<head>`. */
export function isHeadLiteral(literal: LocatedLiteral): boolean {
  return (literal.place !== undefined && isHeadKind(literal.place)) || literal.inHead === true;
}

/** The accessor kind, or null when an un-directived App-Router component is ambiguous. */
function kindFor(
  file: string,
  hasUseClient: boolean,
  config: StetConfig,
  forced: string | undefined,
): 'server' | 'client' | null {
  // A non-JSX file (a `.ts`/`.js` mailer) has no client-component form on ANY
  // router — checked FIRST, so a Pages host's email mailer is still server (and
  // reaches EMAIL_TARGET), not client-skipped for want of a provider.
  if (!isJsxFile(file)) return 'server';
  // `pages` and `vite` force the client form: a Pages-Router file and a Vite SPA's
  // component are client-rendered with no directive to detect them by. `app` and
  // `astro` both fall through to the directive and the route-file test.
  if (config.router === 'pages' || config.router === 'vite' || hasUseClient) return 'client';
  if (isRouteFile(file)) return 'server';
  if (forced === 'server' || forced === 'client') return forced;
  return null;
}

function isRouteFile(file: string): boolean {
  return ROUTE_FILES.has(basename(file).replace(/\.(tsx|jsx|ts|js)$/, ''));
}

/**
 * The target a file's keys take. Derived from the SURFACE the file matched — an
 * email surface gets email rules — never from a send-arg heuristic, which
 * misfires on `res.send`/`socket.send`. A copy module declared into the email
 * surfaces takes the email target and its validation rules by the same rule.
 */
export function targetFor(file: string, config: StetConfig): Target {
  return config.emailSurfaces.some((g) => matchGlob(g, file)) ? EMAIL_TARGET : DEFAULT_TARGET;
}

function skipReason(skip: 'no-component-body' | 'copy-collision' | 'non-copy-prop'): string {
  if (skip === 'non-copy-prop') return 'is a prop stet does not rewrite (aria-*, testid, event)';
  return skip === 'copy-collision'
    ? 'a foreign `copy` is already bound in scope'
    : 'a client literal with no enclosing component body';
}

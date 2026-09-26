/**
 * The JSX run's first pass and its names, shared by `register` and `scan`: every
 * managed surface parsed and classified, the copy modules walked for the names
 * they reserve, each literal a declared key already holds given that key, and
 * the rest named by role and numbered across the run. `register` adopts what
 * this returns; `scan` prints the same names, so the name scan proposes is the
 * key register adds.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { keyDefOf, pageKeyReferences } from '../src/descriptor.js';
import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, EMAIL_TARGET, type Descriptor, type Target } from '../src/types.js';
import type { StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { heldTextOf } from './html-host.js';
import { numberNames } from './key-names.js';
import { pageOfFile } from './pages.js';
import type { Report } from './report.js';
import { planRewrite } from './rewrite.js';
import {
  isJsxFile,
  matchGlob,
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

export interface JsxRun {
  /** The files pass one parsed, by path — scan's loop reads these instead of parsing again. */
  parsed: Map<string, ScanResult | null>;
  /** The files it adopts from, with their literals, as register's pass two reads them. */
  adoptable: Array<{ file: string; source: string; literals: LocatedLiteral[]; target: Target; kind: 'server' | 'client' }>;
  /** The name each adoptable literal takes, numbered or reused (D2). */
  nameOf: Map<LocatedLiteral, string>;
  /** Literals that reuse a declared key (D2); their name is in `nameOf`. */
  reused: Set<LocatedLiteral>;
  refusals: string[];
  /** The copy-module walk's results and property names, which the naming reserves. */
  modules: Map<string, ModuleScanResult>;
  propertyNames: Map<string, string>;
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

  // The text each declared web `text` key holds, as the descriptor stood before
  // the run, by target: a literal whose text a key already holds reads that key
  // rather than taking a numbered name beside it — the html host's first-pass
  // rule, the first key by name winning. A key with `tags` holds placeholder
  // markup no JSX literal carries. A key a page's SEO or JSON-LD reads is the
  // head text the html host never shares onto visible text; a template's slot
  // key belongs to its template, and a `brand__` key to the brand group.
  const heldBy = new Map<string, string>();
  const notShared = new Set(pageKeyReferences(descriptor).map((ref) => ref.key));
  for (const [template, def] of Object.entries(descriptor.templates ?? {})) {
    for (const slot of def.slots) notShared.add(`${template}__${slot}`);
  }
  for (const key of Object.keys(descriptor.keys).sort()) {
    const text = heldTextOf(descriptor, snapshot, key);
    const def = keyDefOf(descriptor, key);
    if (text === null || def === undefined || def.tags !== undefined) continue;
    if (notShared.has(key) || key.startsWith('brand__')) continue;
    const slot = `${def.target}\u0000${text}`;
    if (!heldBy.has(slot)) heldBy.set(slot, key);
  }
  const reuseOf = new Map<LocatedLiteral, string>();

  // Pass one: every surface parsed and classified before any literal is named,
  // so a role that repeats across the run is numbered across it.
  const adoptable: JsxRun['adoptable'] = [];
  for (const file of filesForGlobs(cwd, config.managedSurfaces)) {
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
    if (result.literals.length === 0) continue;

    const target = targetFor(file, config);
    const kind = kindFor(file, result.hasUseClient, config, forcedKind);
    if (kind === null) {
      report.warn('scan', `${file}: ambiguous — an un-directived App-Router component; re-run with --kind server|client`);
      continue;
    }
    if (kind === 'client' && !providerMounted(cwd, config)) {
      for (const literal of result.literals) {
        report.warn(
          'scan',
          `${file}: ${JSON.stringify(literal.proposedKey)} needs a client rewrite, but no CopyProvider is mounted — ` +
            'mount CopyProvider in the root layout first (stet init can do it)',
        );
      }
      continue;
    }
    // A literal the gate or the rewrite would refuse is reported here and takes
    // no name, so a run's numbers have no gaps. Neither depends on the key's name.
    // A literal a declared key already holds skips the gate — its value is
    // declared — and only its rewrite is proven.
    const literals = result.literals.filter((literal) => {
      const reuse = heldBy.get(`${target}\u0000${literal.text}`);
      if (reuse === undefined) {
        const passed = validateUnnamed({
          descriptor,
          snapshot,
          placeholder: '\u0001',
          def: { shape: 'text', target },
          stored: literal.text,
          value: literal.text,
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

  // The names: the rule's, numbered across the run past every key declared
  // before it and every copy-module name; a reused literal takes its key and
  // no number.
  const fresh = adoptable.flatMap((f) => f.literals).filter((literal) => !reuseOf.has(literal));
  const before = new Set(Object.keys(descriptor.keys));
  const numbered = numberNames(
    fresh.map((l) => l.proposedKey),
    (name) => before.has(name) || propertyNames.has(name),
  );
  const nameOf = new Map<LocatedLiteral, string>([...reuseOf, ...fresh.map((literal, i) => [literal, numbered[i] as string] as const)]);
  return { parsed, adoptable, nameOf, reused: new Set(reuseOf.keys()), refusals, modules, propertyNames };
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
  // Only `pages` forces the client form: a Pages-Router file is client-rendered
  // with no directive to detect it by. `app` and `astro` both fall through to
  // the directive and the route-file test.
  if (config.router === 'pages' || hasUseClient) return 'client';
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

/** The live grep P1-H uses: a `CopyProvider` import from `@getstet/stet/react` in the root layout. */
function providerMounted(cwd: string, config: StetConfig): boolean {
  // No recorded root layout is no layout, and no layout is no provider — an
  // Astro host, whose site layout is a `.astro` template.
  if (config.rootLayout === undefined) return false;
  const path = join(cwd, config.rootLayout);
  if (!existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');
  return /import\s*\{[^}]*\bCopyProvider\b[^}]*\}\s*from\s*['"]@getstet\/stet\/react['"]/.test(source);
}

function skipReason(skip: 'no-component-body' | 'copy-collision'): string {
  return skip === 'copy-collision'
    ? 'a foreign `copy` is already bound in scope'
    : 'a client literal with no enclosing component body';
}

/**
 * `stet scan` — the drift gate. It parses the files named by the managed-surface
 * globs (and ONLY those — nothing outside is ever opened) and reports every
 * unkeyed copy literal as a warning with its file, position and a proposed key.
 * It defaults to `warn` (exit 0) so a fresh install never fails a stranger's
 * commit; `scan.severity: 'fail'` opts into exit 1.
 *
 * The baseline is POSITION-FREE — a literal is suppressed by `{ file, context,
 * text }`, so inserting a line above it does not re-warn the whole file and
 * storm the hook. `--baseline` (re)writes it from the current findings, so an
 * existing repo starts at zero. i18n copy is reported as info, never a key.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type * as TS from 'typescript';

import { flag, noPositionals, parse, refuseEnv } from './args.js';
import { writeJsonDeterministic } from './artifacts.js';
import { isHtmlHost, loadConfig, type StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { proposeHtml } from './html-host.js';
import type { CliIo } from './main.js';
import { detectPagesRoots, proposePages } from './pages.js';
import { CliError, clip, lineCol, posixRelative, Report } from './report.js';
import {
  dialectOf,
  isJsxFile,
  loadTypescript,
  matchGlob,
  mentionsToken,
  rendersToken,
  scanDialect,
  scanModule,
  scanSource,
  type LocatedLiteral,
  type Span,
} from './source-scan.js';

/** Enough of an unkeyed literal to recognize it by its opening words. */
const LITERAL_EXCERPT = 60;

interface BaselineEntry {
  file: string;
  /** A literal's own context, plus `'dialect'` — the text detector's, which no `LocatedLiteral` can carry. */
  context: LocatedLiteral['context'] | 'dialect' | 'html';
  text: string;
}

/**
 * The descriptor as RAW parsed JSON. `scan` reads it for two questions — which
 * slots a pointered template declares, and which module keys are already
 * adopted — and validates neither: `stet check` owns an unreadable descriptor,
 * and a scan that failed on one would fail the bare host it was written for.
 */
interface RawDescriptor {
  keys?: unknown;
  pages?: unknown;
  templates?: Record<string, { slots?: string[]; render?: { file?: unknown } }>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The snapshot's own default for a key, as a string — `undefined` where there
 * is none to compare. Own-property only, for the reason the classifier is: a
 * key named `constructor` is answered from the prototype by a bare index, and
 * the value that comes back is a function whose source would be printed as
 * though the host had written it.
 */
function ownDefault(snapshot: RawSnapshot | null, key: string): string | undefined {
  const defaults = snapshot?.default;
  if (!isRecord(defaults) || !Object.hasOwn(defaults, key)) return undefined;
  const stored = defaults[key];
  return typeof stored === 'string' ? stored : undefined;
}

/** Parsed JSON at a path, or null where the file is absent or unreadable — the report-free read. */
function readJsonOrNull<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** A value read at most once, however many times it is asked for — and never where nothing asks. */
function lazy<T>(read: () => T): () => T {
  let cell: { value: T } | null = null;
  return () => (cell ??= { value: read() }).value;
}

export async function runScan(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'scan');
  const { values, positionals } = parse(args, { baseline: 'boolean', json: 'boolean' });
  noPositionals(positionals, 'scan');
  const rewriteBaseline = flag(values, 'baseline');

  const config = loadConfig(io.cwd);
  const report = new Report();

  const suppressed = rewriteBaseline ? new Set<string>() : loadBaseline(io.cwd, config);
  const collected: BaselineEntry[] = [];
  let warned = 0;

  // Per GLOB, not aggregate: a config whose `.tsx` glob is dead while its
  // `.astro` glob matches 29 files must name the dead one, and an aggregate
  // count never can. `filesForGlobs` already walks once per glob, so asking it
  // one glob at a time adds no walk.
  // Declared globs are DEDUPED first: the same dead glob twice is one dead
  // glob, and warning about it twice reads as two problems. The two declared
  // lists share the dead-glob and nothing-scanned rules — a copy-module glob
  // that matches nothing is a dead glob exactly as a surface glob is.
  const surfaceGlobs = [...new Set(config.managedSurfaces)];
  const moduleGlobs = [...new Set(config.copyModules)];
  const declared = [...new Set([...surfaceGlobs, ...moduleGlobs])];
  const perGlob = declared.map((glob) => ({ glob, matched: filesForGlobs(io.cwd, [glob]) }));
  const files = [...new Set(perGlob.flatMap((entry) => entry.matched))].sort();

  // Each read at most once, and only where something asks. The descriptor is
  // shared — the slot check reads it and so does the adoption verdict, so it is
  // opened once rather than twice — while the snapshot is the verdict's alone
  // and a host with no copy modules never opens it. Never `descriptorOf`/
  // `snapshotOf`: those report an ENOENT as an error, which would flip a bare
  // host's scan from 0 to 1 and break "never failing by default".
  const descriptorOnce = lazy(() => readJsonOrNull<RawDescriptor>(join(io.cwd, config.descriptorPath)));
  const snapshotOnce = lazy(() => readJsonOrNull<RawSnapshot>(join(io.cwd, config.snapshotPath)));

  // The compiler is resolved ONCE, ahead of the walk, and a refusal is HELD in
  // a local rather than thrown: the throw escapes before `report.emit` and
  // takes every accumulated warn — the dead-glob lines included — with it. The
  // finding it becomes is raised below, and only where a file needed it.
  let compilerRefusal: string | null = null;
  try {
    await loadTypescript();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    compilerRefusal = error.message;
  }
  let neededCompiler = false;

  const i18nLines = (file: string, source: string, skips: { pos: number }[]): void => {
    for (const skip of skips) {
      const { line } = lineCol(source, skip.pos);
      report.line(`${file}:${line}: i18n copy — outside stet's v1 scope, not a key`);
    }
  };
  /** A finding on the baseline path: collected, suppressed, or the caller's to warn. */
  const baselined = (entry: BaselineEntry): boolean => {
    if (rewriteBaseline) {
      collected.push(entry);
      return true;
    }
    return suppressed.has(entryKey(entry));
  };

  // The static-HTML host's whole walk, computed ONCE ahead of the loop over the
  // same files: the locator reads each document once, and the loop reports what
  // it found per file. The lazy readers stay report-free, so a bare html host
  // with no descriptor yet scans against an empty one rather than failing.
  // The forms are handed in EMPTY: the locator's only read is the document's
  // own marks, so scan's raw descriptor and snapshot — which it deliberately
  // never validates — have nothing to contribute and are not converted here.
  const html = isHtmlHost(config) ? proposeHtml(io.cwd, files, { version: 1, keys: {} }, {}) : null;

  let refused = 0;
  for (const file of files) {
    const source = readFileSync(join(io.cwd, file), 'utf8');

    // The dialect branch sits at the TOP, ahead of every compiler-needing call.
    // These are the files a typescript-less host still has, and the detector is
    // pure text — a branch placed downstream of the compiler would never run on
    // the very hosts it exists for.
    const dialect = dialectOf(file);
    // On an html host a `.html` file goes further than the text detector: the
    // locator found the ELEMENT behind each run, so the warn carries a proposed
    // key the way the JSX line does. A claimed mark is silent — whether its text
    // still equals the snapshot is `stet check`'s question, never scan's.
    if (dialect === 'html' && html !== null) {
      for (const proposal of html.proposals.filter((p) => p.file === file)) {
        if (baselined({ file, context: 'html', text: proposal.value })) continue;
        const suffix =
          proposal.kind !== 'attribute'
            ? ''
            : proposal.metaName === undefined
              ? ` (${proposal.attr})`
              : ` (meta ${proposal.metaName})`;
        report.warn(
          'scan',
          `${file}:${proposal.line} possible copy ${JSON.stringify(clip(proposal.value, LITERAL_EXCERPT))}${suffix} — ` +
            `propose key ${proposal.proposedKey}`,
        );
        warned += 1;
      }
      // A skip is text stet could not adopt, so it counts as unkeyed too.
      for (const skip of html.skips.filter((s) => s.file === file)) {
        report.warn('scan', `${file}:${skip.line} skipped (${skip.reason}) — ${skip.detail}; ${skip.remedy}`);
        warned += 1;
      }
      continue;
    }
    if (dialect !== null) {
      for (const found of scanDialect(file, source, dialect)) {
        if (baselined({ file, context: 'dialect', text: found.text })) continue;
        const { line } = lineCol(source, found.pos);
        // No proposed key: nothing text-level can tell an attribute from
        // content, and a guessed key poisons the registry register would trust.
        report.warn('scan', `${file}:${line} possible copy ${JSON.stringify(clip(found.text, LITERAL_EXCERPT))}`);
        warned += 1;
      }
      continue;
    }

    if (compilerRefusal !== null) {
      neededCompiler = true;
      // Not the parse-refusal line and not the `refused` counter: an absence is
      // not a parse. The error finding below is what makes the run loud.
      report.line(`${file}: not scanned — typescript is unavailable`);
      continue;
    }

    const isSurface = surfaceGlobs.some((glob) => matchGlob(glob, file));
    const isModule = moduleGlobs.some((glob) => matchGlob(glob, file));

    // What the JSX walk parsed and what it claimed, handed to the module walk
    // where both declarations match the file. Undefined on a module-only file,
    // where no JSX walk ran and the module walk parses for itself.
    let handoff: { sourceFile: TS.SourceFile; claimed: Span[] } | undefined;

    if (isSurface) {
      const result = await scanSource(file, source, { readPathImport: config.readPath.import });
      if (result.parseErrors) {
        report.line(`${file}: could not be parsed cleanly — reported, not scanned`);
        refused += 1;
        continue;
      }
      handoff = { sourceFile: result.sourceFile, claimed: result.claimed };
      i18nLines(file, source, result.i18nSkips);
      for (const literal of result.literals) {
        if (baselined({ file, context: literal.context, text: literal.text })) continue;
        const { line, col } = lineCol(source, literal.pos);
        report.warn(
          'scan',
          `${file}:${line}:${col} unkeyed copy ${JSON.stringify(clip(literal.text, LITERAL_EXCERPT))} — propose key ${literal.proposedKey}`,
          literal.proposedKey,
        );
        warned += 1;
      }
    }

    // A file both lists match is parsed once and walked by both
    // classifications, neither of them twice: the JSX walk above owns every
    // position it classified, and the module walk covers what it leaves.
    if (isModule) {
      const result = await scanModule(file, source, handoff);
      if (result.parseErrors) {
        report.line(`${file}: could not be parsed cleanly — reported, not scanned`);
        refused += 1;
        continue;
      }
      // A copy module the JSX walk does not cover is read for its own literals,
      // but its JSX side stays dark — and saying so is the difference between a
      // half-read file and a clean bill over one. BELOW the parse gate: a file
      // nothing could read must not be handed a remedy that would have refused
      // it in exactly the same way.
      if (!isSurface && isJsxFile(file)) {
        report.warn('scan', `${file}: JSX not scanned — the file is a copy module only; add it to managedSurfaces`);
      }
      i18nLines(file, source, result.i18nSkips);
      const descriptor = descriptorOnce();
      const snapshot = snapshotOnce();
      for (const literal of result.literals) {
        const { line, col } = lineCol(source, literal.pos);
        const at = `${file}:${line}:${col}`;
        // A template carries no key, so there is nothing to classify: it is
        // named as possible copy and never proposed.
        if (literal.shape === 'template') {
          if (baselined({ file, context: literal.context, text: literal.text })) continue;
          report.warn('scan', `${at} possible copy ${JSON.stringify(clip(literal.text, LITERAL_EXCERPT))}`);
          warned += 1;
          continue;
        }
        const verdict = classifyAdoption(descriptor, snapshot, literal.proposedKey, literal.text);
        // Adopted is SILENT — the module's literal IS the snapshot default.
        if (verdict === 'adopted') continue;
        if (verdict === 'diverged') {
          // Never a baseline entry: a divergence is a state mismatch resolved by
          // editing one side, and `--baseline` must not be able to switch the
          // drift gate off. Which side wins is the operator's.
          //
          // The stored value is read by OWN property, like the verdict itself: a
          // bare index answers a key named `constructor` with a function and
          // prints its source as though it were somebody's copy. Absent — and a
          // default too malformed to compare — reads as absent.
          const stored = ownDefault(snapshot, literal.proposedKey);
          // No `key` on the finding: a diverged key must never read as
          // adoptable to whatever consumes `--json` next.
          report.warn(
            'scan',
            `${at} ${literal.proposedKey} diverged from the snapshot default — ` +
              `module ${JSON.stringify(clip(literal.text, LITERAL_EXCERPT))}, ` +
              (stored === undefined
                ? 'snapshot has no default'
                : `snapshot ${JSON.stringify(clip(stored, LITERAL_EXCERPT))}`),
          );
          continue;
        }
        if (baselined({ file, context: literal.context, text: literal.text })) continue;
        // One line per finding, never two: a note about the property's name
        // REPLACES the unkeyed line rather than joining it.
        const note = result.notes.get(literal.pos);
        report.warn(
          'scan',
          note === undefined
            ? `${at} unkeyed copy ${JSON.stringify(clip(literal.text, LITERAL_EXCERPT))} — propose key ${literal.proposedKey}`
            : `${at} ${note}`,
          literal.proposedKey,
        );
        warned += 1;
      }
      // One comment reaching a whole statement silences every property under it,
      // and a module silenced that way is otherwise indistinguishable from a
      // clean one. It prints on the LINE channel and `warned` does not move: a
      // summary is not a finding, and the opt-out this gate itself sanctions
      // must never be what fails a `fail` posture.
      for (const summary of result.ignoreSummaries) {
        report.line(`${file}:${summary.line}: one stet-ignore comment silenced ${summary.count} literals`);
      }
    }
  }

  // The refusal, delivered THROUGH the report: the message and the nonzero exit
  // survive, and every dialect and glob warn is emitted rather than discarded.
  // Only where a file actually needed the compiler — a bare repo and a
  // dialect-only host stay compiler-free, and exit 0.
  if (compilerRefusal !== null && neededCompiler) report.error('scan', compilerRefusal);

  await unrenderedSlots(io.cwd, config, report, descriptorOnce());
  uncoveredRoutes(io.cwd, config, report, descriptorOnce());

  // A run that scanned nothing must never read as a clean bill. Ahead of the
  // `--baseline` return, so a baseline written over nothing warns too; silent
  // where NOTHING is declared, which is the bare repo's own contract.
  for (const { glob, matched } of perGlob) {
    if (matched.length === 0) report.warn('scan', `glob matched no files: ${glob}`);
  }
  if (perGlob.length > 0 && files.length === 0) {
    report.warn('scan', 'the declared globs matched no files — nothing was scanned');
  }
  // The second zero-shape, the same class: files MATCHED and the parser
  // refused every one, so the run scanned nothing while looking like a pass.
  if (files.length > 0 && refused === files.length) {
    report.warn('scan', `all ${files.length} matched file(s) were refused by the parser — nothing was scanned`);
  }

  if (rewriteBaseline) {
    const entries = dedupeEntries(collected);
    writeJsonDeterministic(join(io.cwd, config.scan.baseline), entries);
    report.line(`wrote ${config.scan.baseline}: ${entries.length} baselined`);
    // The warns above print here too, but the severity promotion does NOT
    // apply: `--baseline` is the run that ACCEPTS the findings, and failing it
    // under a `fail` posture would block the only workflow that clears them.
    return report.emit(io, { json: flag(values, 'json') });
  }

  if (html !== null) {
    // The structured records the local dashboard reads. `insertAt` is an
    // internal offset the mark edit uses and no consumer of the payload needs.
    report.data('html', {
      proposals: html.proposals.map(({ insertAt: _insertAt, ...rest }) => rest),
      skips: html.skips,
    });
  }

  report.line(
    `scan: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ` +
      `${warned} unkeyed ${warned === 1 ? 'literal' : 'literals'}`,
  );
  report.data('scan', { files: files.length, warned });
  // `fail` severity promotes the warnings to errors (exit 1); `warn` keeps exit 0.
  if (config.scan.severity === 'fail') report.promoteWarnings();
  return report.emit(io, { json: flag(values, 'json') });
}

/**
 * A declared slot whose flattened key the file that renders it never READS
 * (operator-ruled 2026-08-26). A name in the props type is a declaration, not a
 * render — and `--apply`'s own rewrite puts every slot name there.
 *
 * Deleting the `props.welcome__headline` line disconnects a field the dashboard
 * still offers an editor — they type, they save, and nothing reaches the send.
 * Nothing in the repo notices, and the dashboard never looks at the repo. This
 * check rides SCAN rather than doctor because scan rides the pre-commit hook:
 * the warn lands at the very commit that breaks the slot, rather than whenever
 * somebody next runs a command by hand.
 *
 * File-level, with no import chasing: a slot passed through to an imported
 * component still names its flattened prop in the pointer's own file.
 */
async function unrenderedSlots(
  cwd: string,
  config: StetConfig,
  report: Report,
  descriptor: RawDescriptor | null,
): Promise<void> {
  // `stet check` owns an unreadable descriptor; scan reports literals.
  if (descriptor === null) return;
  const templates = descriptor.templates ?? {};

  // Parsed where the compiler is there, grepped where it is not. The parse is
  // what tells a rendered slot from a declared one, and a host without
  // typescript still gets the coarser answer rather than none.
  let ts: typeof import('typescript') | null = null;
  try {
    ts = await loadTypescript();
  } catch {
    ts = null;
  }

  for (const name of Object.keys(templates).sort()) {
    const entry = Object.hasOwn(templates, name) ? templates[name] : undefined;
    const file = entry?.render?.file;
    // Pointerless entries are exempt: there is no file to look in, which is a
    // complete state rather than a fault.
    if (entry === undefined || typeof file !== 'string') continue;
    // Only files the managed-surface walk covers — the same boundary every
    // other part of scan respects, so nothing outside the surfaces is opened.
    if (!config.managedSurfaces.some((glob) => matchGlob(glob, file))) continue;
    let source: string;
    try {
      source = readFileSync(join(cwd, file), 'utf8');
    } catch {
      continue; // `stet email verify` is where a missing pointer target fails
    }
    for (const slot of entry.slots ?? []) {
      const key = `${name}__${slot}`;
      const rendered = ts === null
        ? mentionsToken(source, key)
        : rendersToken(ts, join(cwd, file), source, key);
      if (rendered) continue;
      report.warn(
        'scan',
        `${file}: ${key} is declared as a slot of ${name}, and the file that renders it never reads the value — ` +
          'an editor can still change this copy in the dashboard, and the change will not reach the send',
        key,
      );
    }
  }
}

/**
 * A static route the host's routing convention serves that no declared page
 * claims. It rides SCAN for the reason the unrendered-slot warn does: the hook
 * runs scan, so the warn lands at the very commit that adds the route file
 * rather than whenever somebody next runs a command by hand.
 *
 * GATED on the host having declared at least one page. A host that never
 * declared one is not drifting, it is unopted — and that case belongs to `seo
 * check`'s zero-pages warn, which names the command to run. The gate is doing
 * more work than it looks: `templates/starter-descriptor.json` declares no
 * pages, so every init-scaffolded fixture in the suite stays silent here.
 *
 * The descriptor is scan's own lazy read, so it is UNVALIDATED — hence the
 * narrowing. `pages: "todo"` would otherwise yield four phantom pages through
 * `Object.keys`, and an entry whose `route` is a number would crash the trim
 * inside a command whose whole contract is never failing by default.
 *
 * A route the taxonomy owns — a dynamic segment, an endpoint, an unsupported
 * form or type — never warns: those are the taxonomy's subjects rather than
 * drift, and scan does not re-report them. Scan calls the detector with no seed
 * option, so it reads names only.
 */
function uncoveredRoutes(
  cwd: string,
  config: StetConfig,
  report: Report,
  descriptor: RawDescriptor | null,
): void {
  if (descriptor === null) return;
  const raw = descriptor.pages;
  if (!isRecord(raw)) return;
  const declared: Array<[string, { route: string }]> = [];
  for (const [name, def] of Object.entries(raw)) {
    if (!isRecord(def)) continue;
    const route = def['route'];
    if (typeof route === 'string') declared.push([name, { route }]);
  }
  if (declared.length === 0) return;

  const roots = detectPagesRoots(cwd, { html: isHtmlHost(config) });
  if (roots.length === 0) return;
  // Built through `fromEntries`, never by assignment: a page legitimately named
  // `__proto__` would otherwise replace this object's prototype rather than
  // becoming a member of it.
  //
  // The key and value maps are EMPTY on purpose. They exist to stop the apply
  // minting over somebody's work, and scan mints nothing — an undeclared route
  // whose scaffold name is taken is still an undeclared route, and this warn's
  // job is to say so.
  // `bind: false` by omission — scan's drift warn reads file names alone and
  // mints nothing, on this host as on every other.
  const set = proposePages(
    cwd,
    roots,
    { pages: Object.fromEntries(declared), keys: {}, values: {} },
    { config },
  );
  for (const proposal of set.proposals) {
    report.warn('scan', `route ${proposal.route} (${proposal.file}) has no page record — run stet pages scan`);
  }
}

/** The baseline as a suppression set, or empty when the file is absent. */
function loadBaseline(cwd: string, config: StetConfig): Set<string> {
  const path = join(cwd, config.scan.baseline);
  if (!existsSync(path)) return new Set();
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const set = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = item as Partial<BaselineEntry>;
      if (typeof entry.file === 'string' && typeof entry.context === 'string' && typeof entry.text === 'string') {
        set.add(entryKey(entry as BaselineEntry));
      }
    }
  }
  return set;
}

/** Position-free identity: the same string twice in one file collapses to one entry. */
function entryKey(entry: BaselineEntry): string {
  return JSON.stringify([entry.file, entry.context, entry.text]);
}

function dedupeEntries(entries: BaselineEntry[]): BaselineEntry[] {
  const seen = new Set<string>();
  const out: BaselineEntry[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The surface walker lives in `cli/files.ts` now that `html-host` lists files
 * too. Re-exported here because `register`, `remove`, `eject` and
 * `email extract` reach it by this name.
 */
export { filesForGlobs };


/**
 * `stet register --from scan` — adopt scanned literals: add the descriptor key,
 * seed its default through the save gate, and rewrite the consuming leaf to the
 * ambient accessor. It ONLY ADDS keys — it never reads or writes the store and
 * never alters a published value, so a branch run cannot damage what is live.
 *
 * It re-scans (so a leaf already rewritten to an accessor call is a no-op —
 * idempotent), names each new key by its role (page, section, role, and a
 * number where the role repeats in the run), and refuses to
 * rewrite what it cannot do safely: a client leaf with no `CopyProvider` mounted
 * (which would throw at render), a scope that already binds a foreign `copy`, a
 * client literal with no component body, or an ambiguous un-directived
 * App-Router component. The descriptor and default are written either way; the
 * host source edit is gated on `--write` and shown as a diff first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';

import type * as TS from 'typescript';

import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, EMAIL_TARGET, type Descriptor, type Target } from '../src/types.js';
import { parse, flag, text as argText, noPositionals } from './args.js';
import {
  asUpdate,
  planJson,
  planRepoForms,
  planWrite,
  rethrowBatchFailure,
  writePlanned,
  writeText,
} from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import {
  CONFIG_FILE,
  isHtmlHost,
  loadConfig,
  normalizeNoExt,
  pathAliasMappings,
  resolveSpecifier,
  type StetConfig,
} from './config.js';
import { filesForGlobs } from './files.js';
import { planHtmlRegister, type ChosenName, type HtmlRegisterPlan } from './html-host.js';
import { kindOf, numberNames, type Place } from './key-names.js';
import { fileHash, planProblems, planText, readPlan, refusePlan, type NamingPlan, type PlanEntry } from './key-plan.js';
import { pageOfFile } from './pages.js';
import type { CliIo } from './main.js';
import { clip, collapseLines, plural, CliError, HostTextReport, Report, UsageError } from './report.js';
import { applyFileEdits, formatDiff, planRewrite, type Edit } from './rewrite.js';
import {
  isJsxFile,
  matchGlob,
  scanModule,
  scanSource,
  type LocatedLiteral,
  type Span,
} from './source-scan.js';
import { classifyAdoption } from './scan.js';
import { validateUnnamed, validateValue } from './validate.js';

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

export async function runRegister(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    from: 'string',
    write: 'boolean',
    kind: 'string',
    verbose: 'boolean',
    plan: 'string',
    'plan-out': 'string',
  });
  noPositionals(positionals, 'register');
  if (argText(values, 'from') !== 'scan') {
    throw new UsageError('stet register --from scan [--plan FILE | --plan-out FILE] [--write] [--kind server|client] [--verbose]');
  }
  const forcedKind = argText(values, 'kind');
  if (forcedKind !== undefined && forcedKind !== 'server' && forcedKind !== 'client') {
    throw new UsageError('stet register --kind must be "server" or "client"');
  }
  const write = flag(values, 'write');
  const verbose = flag(values, 'verbose');
  const planIn = argText(values, 'plan');
  const planOut = argText(values, 'plan-out');
  if (planIn !== undefined && planOut !== undefined) {
    throw new UsageError('stet register takes --plan or --plan-out, not both');
  }
  if (planOut !== undefined && write) {
    throw new UsageError('stet register --plan-out writes the plan alone — run --plan with --write to apply it');
  }
  const naming: Naming = { ...(planIn === undefined ? {} : { planIn }), ...(planOut === undefined ? {} : { planOut }) };

  const config = loadConfig(io.cwd);
  const report = new HostTextReport();
  if (planOut !== undefined) refusePlanOut(io.cwd, planOut);

  // The html branch runs FIRST — ahead of the alias guard, which throws on the
  // defaulted `@/lib/content` of a config that writes no read path, and ahead of
  // the surface loop, which would hand every `.html` to a compiler that refuses
  // it. Nothing on this path loads `typescript`, and `--kind` selects nothing.
  if (isHtmlHost(config)) {
    const htmlDescriptor = descriptorOf(config, io.cwd, report);
    if (!htmlDescriptor) return report.emit(io);
    const htmlSnapshot = snapshotOf(config, io.cwd, report);
    if (!htmlSnapshot) return report.emit(io);
    return registerHtml({ io, config, descriptor: htmlDescriptor, snapshot: htmlSnapshot, write, report, naming });
  }

  // Before ANY write, the descriptor and snapshot included: a rewrite that
  // inserts an import the host cannot resolve breaks every file it touched.
  if (write) refuseUnresolvableAlias(io.cwd, config);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  let added = 0;
  // Leaf rewrites shown but not applied — the only thing `--write` has left to
  // do. A module-shaped adoption completes on the plain run, so a run that
  // adopted only modules has nothing pending and must not say it has.
  let printedDiffs = 0;

  // What the JSX walk parsed and CLAIMED, per file. A file both declarations
  // match is parsed once and every literal is owned by exactly one
  // classification; `null` marks a file the parser refused, which the module
  // loop then leaves alone rather than refusing it a second time.
  const walked = new Map<string, { sourceFile: TS.SourceFile; claimed: Span[] } | null>();

  // ONE collection across BOTH loops, flushed below the adopted lines: a dialect
  // host refuses the same files in the surface loop that the module loop would
  // meet, and the walked map above already yields a single refusal per file.
  const refusals: string[] = [];

  // Pass one: every surface parsed and classified before any literal is named,
  // so a role that repeats across the run is numbered across it.
  const adoptable: Array<{
    file: string;
    source: string;
    literals: LocatedLiteral[];
    target: Target;
    kind: 'server' | 'client';
  }> = [];
  for (const file of filesForGlobs(io.cwd, config.managedSurfaces)) {
    const source = readFileSync(join(io.cwd, file), 'utf8');
    const page = pageOfFile(io.cwd, file, descriptor.pages);
    const result = await scanSource(file, source, {
      readPathImport: config.readPath.import,
      ...(page === undefined ? {} : { page }),
    });
    if (result.parseErrors) {
      refusals.push(`${file}: could not be parsed cleanly — reported, not adopted`);
      walked.set(file, null);
      continue;
    }
    // Recorded BEFORE the early returns below: this walk classified the file's
    // JSX positions whether or not it went on to adopt any of them.
    walked.set(file, { sourceFile: result.sourceFile, claimed: result.claimed });
    if (result.literals.length === 0) continue;

    const target = targetFor(file, config);
    const kind = kindFor(file, result.hasUseClient, config, forcedKind);
    if (kind === null) {
      report.warn('scan', `${file}: ambiguous — an un-directived App-Router component; re-run with --kind server|client`);
      continue;
    }
    if (kind === 'client' && !providerMounted(io.cwd, config)) {
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
    const literals = result.literals.filter((literal) => {
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
      const planned = planRewrite(source, literal, literal.proposedKey, kind, config.readPath.import);
      if (planned.skipped === undefined) return true;
      report.warn('scan', `${file}: ${JSON.stringify(literal.proposedKey)} ${skipReason(planned.skipped)} — adopt by hand`);
      return false;
    });
    if (literals.length > 0) adoptable.push({ file, source, literals, target, kind });
  }

  // The copy modules, walked once here for their own names — which no JSX name
  // may take — and again below for adoption.
  const modules = new Map<string, Awaited<ReturnType<typeof scanModule>>>();
  const propertyNames = new Map<string, string>();
  for (const file of filesForGlobs(io.cwd, config.copyModules)) {
    const handoff = walked.get(file);
    if (handoff === null) continue;
    const result = await scanModule(file, readFileSync(join(io.cwd, file), 'utf8'), handoff);
    modules.set(file, result);
    for (const literal of result.literals) {
      if (literal.shape === 'property' || literal.shape === 'plain') propertyNames.set(literal.proposedKey, file);
    }
  }

  // The names: the rule's, numbered across the run past every key declared
  // before it and every copy-module name; then, under --plan, the plan's.
  const run = adoptable.flatMap((f) => f.literals);
  const before = new Set(Object.keys(descriptor.keys));
  const numbered = numberNames(
    run.map((l) => l.proposedKey),
    (name) => before.has(name) || propertyNames.has(name),
  );
  const nameOf = new Map(run.map((literal, i) => [literal, numbered[i] as string]));
  const resolved = resolveNaming({
    io,
    report,
    config,
    descriptor,
    naming,
    files: [...new Set([...filesForGlobs(io.cwd, config.managedSurfaces), ...filesForGlobs(io.cwd, config.copyModules)])],
    mints: run.map((literal) => ({
      proposed: nameOf.get(literal) as string,
      sectionWord: literal.sectionWord ?? null,
      places: literal.place === undefined ? [] : [literal.place],
      text: literal.text,
    })),
    // A copy module's property adopts under its own name, so a plan's name may not take it.
    also: (plan) =>
      plan.keys
        .filter((e) => e.adopt !== false && propertyNames.has(e.key))
        .map((e) => `${e.proposed as string}: "${e.key}" is a property of ${propertyNames.get(e.key) as string}, which adopts under its own name`),
  });
  if ('exit' in resolved) return resolved.exit;
  const { chosen } = resolved;
  // A plan run shows what it will do and writes nothing until --write, as on the static-HTML host.
  const planOnly = naming.planIn !== undefined && !write;

  // Pass two: each file's literals keyed and rewritten.
  for (const { file, source, literals, target, kind } of adoptable) {
    const edits: Edit[] = [];
    for (const literal of literals) {
      const proposed = nameOf.get(literal) as string;
      const choice = chosen?.(proposed);
      if (choice?.adopt === false) continue;
      const key = choice?.key ?? proposed;
      const section = (choice?.section === undefined ? literal.sectionWord : choice.section) ?? undefined;
      // Tentatively add so the save gate can read the key's rules; revert on any refusal.
      descriptor.keys[key] = {
        shape: 'text',
        target,
        ...(section === undefined ? {} : { section }),
        ...(choice?.label === undefined ? {} : { label: choice.label }),
        ...(choice?.help === undefined ? {} : { help: choice.help }),
      };
      (snapshot['default'] ??= {})[key] = literal.text;
      // Pass one gated the text and proved the rewrite; neither reads the name.
      const planned = planRewrite(source, literal, key, kind, config.readPath.import);
      edits.push(...planned.edits);
      added += 1;
    }

    if (edits.length === 0) continue;
    const edited = applyFileEdits(source, edits);
    printedDiffs += 1;
    report.line(formatDiff(file, source, edited));
    if (write && !planOnly) {
      writeText(join(io.cwd, file), edited);
      report.line(`${file}: rewrote ${plural(edits.length, 'edit')}`);
    }
  }

  // The SECOND loop: the declared copy modules. `register` re-walks the host
  // itself and never consumes scan's output, so these files are unreachable
  // without it. It reuses the descriptor-entry and seeded-default machinery
  // above and the shared write block below, and NOTHING else — no component
  // kind, no provider check, no import insertion, and above all no rewrite. A
  // copy module is adopted as RECORD: it keeps its literals, and byte-equality
  // against the snapshot is what the drift gate then watches.
  for (const [file, result] of modules) {
    // The walk ran before the surface pass's own `--write` may have rewritten
    // this file, over the tree the JSX walk handed it. That is safe rather than
    // merely tolerated: `scanModule` reads the TREE's own text wherever it reads
    // by position, so its offsets and its bytes always come from the same
    // document. Re-walking instead would be worse — the rewrite just wrote fresh
    // `copy('key')` calls whose key arguments would need fresh claims,
    // re-opening the accessor-key leak on exactly the files most likely to have
    // one.
    if (result.parseErrors) {
      refusals.push(`${file}: could not be parsed cleanly — reported, not adopted`);
      continue;
    }
    const target = targetFor(file, config);

    for (const literal of result.literals) {
      // A template-shaped finding carries no key to trust, and nothing else
      // reaches the descriptor write.
      if (literal.shape !== 'property' && literal.shape !== 'plain') continue;

      // OWN NAME ONLY — a module shape is never numbered. A
      // suffixed key forks the registry from the module it was read out of,
      // silently, and every later comparison is against a name the module does
      // not use.
      const key = literal.proposedKey;
      const verdict = classifyAdoption(descriptor, snapshot, key, literal.text);
      // Idempotence, mechanized rather than asserted: run two classifies
      // everything adopted and adds nothing.
      if (verdict === 'adopted') continue;
      if (verdict === 'diverged') {
        // Reported, never adopted and never written. `register` only ADDS keys,
        // and with no number taken the assignment below would otherwise replace
        // an existing definition outright — these verdicts are the only guard.
        report.warn(
          'scan',
          `${file}: ${key} diverged from the snapshot default — register only adds keys; resolve the difference by hand`,
        );
        continue;
      }

      // Tentatively add so the save gate can read the key's rules; revert on any refusal.
      descriptor.keys[key] = { shape: 'text', target };
      (snapshot['default'] ??= {})[key] = literal.text;
      if (!validateValue(descriptor, snapshot, key, literal.text, 'default', report)) {
        delete descriptor.keys[key];
        delete snapshot['default']?.[key];
        continue;
      }
      // One line per adopted key, never a diff: there is no source edit to show.
      report.line(`adopted ${key} = ${clip(literal.text, ADOPTED_EXCERPT)}`);
      added += 1;
    }
  }

  for (const line of collapseLines(
    refusals,
    `${refusals.length} file(s) could not be parsed cleanly — reported, not adopted; run with --verbose to list them`,
    verbose,
  )) {
    report.line(line);
  }

  if (added > 0 && planOnly) {
    report.line('register: run with --write to apply the plan');
    return report.emit(io);
  }
  if (added > 0) {
    // ONE batch, with rollback: the descriptor, the snapshot and the codegen
    // modules land together or not at all. The codegen regenerates here so the
    // `copy('new_key')` leaf register just wrote typechecks immediately — the
    // Accessor sig is narrow (`ContentKey`), so a stale `.d.ts` would red the
    // host tsc until a separate `stet upgrade`.
    try {
      writePlanned(planRepoForms(io.cwd, config, descriptor, snapshot, report));
    } catch (error) {
      rethrowBatchFailure('stet register', error);
    }
    report.line(`wrote ${config.descriptorPath}, ${config.snapshotPath} and the codegen modules: ${plural(added, 'key')} added`);
  }
  // The closing line turns on whether there were LEAF EDITS, not on `--write`:
  // a `--write` run that adopted only module shapes applied nothing, and
  // "applied" is the very confusion the record line exists to remove.
  report.line(
    added === 0
      ? 'register: nothing to adopt'
      : printedDiffs === 0
        ? 'register: adopted as record — there are no source edits to apply'
        : write
          ? 'register: applied'
          : 'register: run with --write to apply the leaf edits',
  );
  return report.emit(io);
}

/**
 * The import `register` is about to write into host source has to resolve.
 * `init` records `readPath.import` from a probe that may have found no alias at
 * all and defaulted to `@/lib/content`; applying a rewrite around that
 * specifier leaves every touched file importing a path that maps nowhere, and
 * the host learns at its next build. The diff-only path never guards — a
 * printed diff misleads nobody.
 */
function refuseUnresolvableAlias(cwd: string, config: StetConfig): void {
  const spec = config.readPath.import;
  // Alias-shaped only: an `@scope/pkg` npm name starts with `@` but not `@/`,
  // and relative and bare specifiers resolve without any mapping.
  if (!spec.startsWith('@/') && !spec.startsWith('~/')) return;
  // Covered means RESOLVED ONTO THE READ PATH, never merely prefix-matched: a
  // host declaring `@/*: ['./src/*']` with its read path at `lib/content.ts`
  // matches the prefix and lands somewhere else entirely, and every rewritten
  // file would import a module that is not there.
  const target = normalizeNoExt(join(cwd, config.readPath.file));
  if (resolveSpecifier(spec, config.readPath.file, cwd, pathAliasMappings(cwd)).includes(target)) return;
  throw new CliError(
    `readPath.import is '${spec}', but no tsconfig/jsconfig path mapping in this project resolves it to ` +
      `${config.readPath.file} (extends not followed) — every rewritten file would import a path that ` +
      `resolves nowhere. Declare the alias in the project file, or edit readPath.import in ${CONFIG_FILE}`,
  );
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

/** Enough of an adopted default to recognize it on the line that reports it. */
const ADOPTED_EXCERPT = 60;

/**
 * `register` on the static-HTML host: every located proposal becomes a key and
 * a mark, in one batch with the descriptor and the snapshot.
 *
 * The plain run writes NOTHING — a departure from the JavaScript branch, whose
 * descriptor and snapshot land either way. A descriptor entry written without
 * its mark is half a batch, and the next `check` would report every such key as
 * marked in no document.
 */
function registerHtml(d: {
  io: CliIo;
  config: StetConfig;
  descriptor: Descriptor;
  snapshot: Snapshot;
  write: boolean;
  report: Report;
  naming: Naming;
}): number {
  const { io, config, descriptor, snapshot, write, report, naming } = d;
  const files = filesForGlobs(io.cwd, config.managedSurfaces);
  const pageOf = (file: string): string => pageOfFile(io.cwd, file, descriptor.pages, { html: true }) ?? 'page';
  const run = (
    forms: { descriptor: Descriptor; snapshot: Snapshot },
    runReport: Report,
    chosen?: (proposed: string) => ChosenName | undefined,
  ): HtmlRegisterPlan =>
    planHtmlRegister({
      cwd: io.cwd,
      files,
      descriptor: forms.descriptor,
      snapshot: forms.snapshot,
      report: runReport,
      pageOf,
      ...(chosen === undefined ? {} : { chosen }),
    });

  // The naming plan: the run as the rule would make it, on copies of the forms,
  // so nothing a plan decides depends on anything but the tree it was made from.
  let chosen: ((proposed: string) => ChosenName | undefined) | undefined;
  if (naming.planOut !== undefined || naming.planIn !== undefined) {
    const probe = run({ descriptor: structuredClone(descriptor), snapshot: structuredClone(snapshot) }, new Report());
    const resolved = resolveNaming({
      io,
      report,
      config,
      descriptor,
      naming,
      files,
      mints: probe.minted,
      // A key the plan leaves out may not be what an adopted key derives from.
      also: (plan) => {
        const out = new Set(plan.keys.filter((e) => e.adopt === false).map((e) => e.proposed as string));
        return [...probe.derived, ...probe.converted]
          .filter((derivation) => out.has(derivation.source) && !out.has(derivation.key))
          .map((derivation) => `${derivation.source}: ${derivation.key} derives from it — adopt both or neither`);
      },
    });
    if ('exit' in resolved) return resolved.exit;
    chosen = resolved.chosen;
  }

  const plan = run({ descriptor, snapshot }, report, chosen);
  for (const document of plan.edited) {
    if (document.diff !== '') report.line(document.diff);
  }
  const derivations = [...plan.derived, ...plan.converted].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const derivation of derivations) {
    report.line(
      `${derivation.file}:${derivation.line} ${derivation.key} derives from ${derivation.source} ` +
        `through ${JSON.stringify(derivation.tmpl)}`,
    );
  }
  const converted = plan.converted.length;
  if (plan.marked === 0 && converted === 0) {
    report.line('register: nothing to adopt');
    return report.emit(io);
  }
  if (!write) {
    const parts = [
      ...(plan.marked === 0
        ? []
        : [`apply ${plural(plan.marked, 'mark')} across ${plural(plan.edited.length, 'document')}`]),
      ...(converted === 0 ? [] : [`derive ${plural(converted, 'key')} from the page's visible text`]),
    ];
    report.line(`register: run with --write to ${parts.join(' and ')}`);
    return report.emit(io);
  }
  try {
    writePlanned([
      asUpdate(planJson(join(io.cwd, config.descriptorPath), descriptor, config.descriptorPath)),
      asUpdate(planJson(join(io.cwd, config.snapshotPath), snapshot, config.snapshotPath)),
      ...plan.edited.map((e) => asUpdate(planWrite(e.abs, e.text, e.rel))),
    ]);
  } catch (error) {
    rethrowBatchFailure('stet register --write', error);
  }
  if (plan.marked > 0) {
    report.line(
      `wrote ${config.descriptorPath}, ${config.snapshotPath} and ` +
        `${plural(plan.edited.length, 'document')}: ${plural(plan.added, 'key')} added, ` +
        `${plan.shared} shared`,
    );
  }
  if (converted > 0) {
    report.line(
      `wrote ${config.descriptorPath} and ${config.snapshotPath}: ` +
        `${plural(converted, 'key')} now derived from the page's visible text; their documents are unchanged`,
    );
  }
  report.line('register: applied');
  return report.emit(io);
}

/** A proposed key as a naming plan lists it. */
interface Mint {
  proposed: string;
  sectionWord: string | null;
  places: Place[];
  text: string;
}

/**
 * The naming plan's half of a register run, shared by both hosts. `--plan-out`
 * writes the plan and ends the run (`exit`); `--plan` reads it and answers the
 * choice per proposal, or refuses it and ends the run; neither answers no choice.
 */
function resolveNaming(d: {
  io: CliIo;
  report: Report;
  config: StetConfig;
  descriptor: Descriptor;
  naming: Naming;
  files: string[];
  mints: Mint[];
  also?: (plan: NamingPlan) => string[];
}): { exit: number } | { chosen?: (proposed: string) => ChosenName | undefined } {
  const { io, report, config, descriptor, naming, files, mints } = d;
  if (naming.planOut === undefined && naming.planIn === undefined) return {};
  const made = madeHashes(io.cwd, config, files);
  if (naming.planOut !== undefined) {
    const plan: NamingPlan = {
      plan: 'stet register',
      version: 1,
      made,
      keys: mints.map((mint) => ({
        proposed: mint.proposed,
        key: mint.proposed,
        label: null,
        help: null,
        section: mint.sectionWord,
        adopt: true,
        kind: mint.places[0] === undefined ? 'text' : kindOf(mint.places[0]),
        places: mint.places.map(placeLine),
        text: mint.text,
      })),
    };
    try {
      writeText(resolvePath(io.cwd, naming.planOut), planText(plan));
    } catch (error) {
      throw new CliError(`--plan-out ${naming.planOut}: the plan cannot be written there — ${(error as Error).message}`);
    }
    report.line(
      `wrote ${naming.planOut}: the naming plan for ${plural(plan.keys.length, 'key')} — edit key, label and help, ` +
        `then run stet register --from scan --plan ${naming.planOut}`,
    );
    return { exit: report.emit(io) };
  }
  const file = naming.planIn as string;
  const plan = readPlan(io.cwd, file, 'stet register');
  const problems = planProblems(plan, file, descriptor, mints.map((m) => m.proposed), { hashes: made });
  problems.push(...(d.also?.(plan) ?? []));
  if (problems.length > 0) return { exit: refusePlan(io, report, 'stet register', file, problems) };
  const byProposed = new Map<string, PlanEntry>(plan.keys.map((e) => [e.proposed as string, e]));
  return {
    chosen: (proposed) => {
      const e = byProposed.get(proposed);
      if (e === undefined) return undefined;
      if (e.adopt === false) return { adopt: false, key: e.key };
      return {
        key: e.key,
        ...(e.label === null || e.label === undefined ? {} : { label: e.label }),
        ...(e.help === null || e.help === undefined ? {} : { help: e.help }),
        ...(e.section === undefined ? {} : { section: e.section }),
      };
    },
  };
}

/**
 * `--plan-out` names a new file or an earlier plan. Any other file that exists
 * is refused — the descriptor, the snapshot, the config, a managed file, a copy
 * module, a codegen or read-path file, under whatever spelling a
 * case-insensitive disk or a link gives it — because the check reads the file
 * itself, never its name.
 */
function refusePlanOut(cwd: string, planOut: string): void {
  const target = resolvePath(cwd, planOut);
  if (!existsSync(target)) return;
  let marker: unknown;
  try {
    marker = (JSON.parse(readFileSync(target, 'utf8')) as { plan?: unknown } | null)?.plan;
  } catch {
    marker = undefined;
  }
  if (marker === 'stet register' || marker === 'stet rename') return;
  throw new CliError(`--plan-out ${planOut}: the file exists and is not a stet plan — name a new file, or an earlier plan to replace`);
}

/** What `--plan` and `--plan-out` asked of this run. */
interface Naming {
  planIn?: string;
  planOut?: string;
}

/** A place as a plan lists it: `index.html:467 <h1>`, `index.html:9 <meta> og:description`. */
function placeLine(place: { file: string; line: number; tag?: string; attr?: string; meta?: string }): string {
  const what = place.tag === undefined ? '' : ` <${place.tag}>`;
  const attr = place.attr === undefined ? '' : place.meta === undefined ? ` ${place.attr}` : ` ${place.meta}`;
  return `${place.file}:${place.line}${what}${attr}`;
}

/** The `made` map of a register plan: every file the run reads, hashed. */
function madeHashes(cwd: string, config: StetConfig, files: string[]): Record<string, string> {
  const made: Record<string, string> = {};
  for (const rel of [config.descriptorPath, config.snapshotPath, ...files].sort()) {
    if (existsSync(join(cwd, rel))) made[rel] = fileHash(cwd, rel);
  }
  return made;
}


/**
 * The target a file's keys take. Derived from the SURFACE the file matched — an
 * email surface gets email rules — never from a send-arg heuristic, which
 * misfires on `res.send`/`socket.send`. A copy module declared into the email
 * surfaces takes the email target and its validation rules by the same rule.
 */
function targetFor(file: string, config: StetConfig): Target {
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

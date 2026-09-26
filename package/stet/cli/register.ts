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
 * App-Router component. The run without `--write` shows the diffs and writes
 * nothing; `--write` lands the descriptor, the default, the codegen and every
 * leaf edit in one batch.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
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
import { kindOf, type Place } from './key-names.js';
import { fileHash, planProblems, planText, readPlan, refusePlan, type NamingPlan, type PlanEntry } from './key-plan.js';
import { htmlPageOf } from './pages.js';
import type { CliIo } from './main.js';
import { clip, collapseLines, plural, CliError, HostTextReport, Report, UsageError } from './report.js';
import { applyFileEdits, formatDiff, planRewrite, type Edit } from './rewrite.js';
import { classifyAdoption, planJsxRun, targetFor } from './register-run.js';
import { validateValue } from './validate.js';

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

  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  let added = 0;
  // Literals that read a key the descriptor already held: no entry, no value.
  let reused = 0;
  // Files whose leaf rewrites were shown. A run that adopted only module shapes
  // has no source edit, and its closing line must not say it has.
  let printedDiffs = 0;
  // Each edited file's text, written in the one batch with the repo forms.
  const edited: Array<{ abs: string; rel: string; text: string; edits: number }> = [];

  // Pass one, the copy modules' own names and the run's names: the naming pass
  // `scan` previews with. Then, under --plan, the plan's names.
  const { adoptable, nameOf, reused: reusedLiterals, refusals, modules, propertyNames } = await planJsxRun({
    cwd: io.cwd,
    config,
    descriptor,
    snapshot,
    report,
    ...(forcedKind === undefined ? {} : { forcedKind }),
  });
  // A naming plan lists only the keys the run adds: a reused literal is never an entry.
  const run = adoptable.flatMap((f) => f.literals).filter((literal) => !reusedLiterals.has(literal));
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
  // Only a run that applies writes anything: without it, every host writes nothing.
  const applying = write && !planOnly;

  // Pass two: each file's literals keyed and rewritten.
  for (const { file, source, literals, target, kind } of adoptable) {
    const edits: Edit[] = [];
    for (const literal of literals) {
      const proposed = nameOf.get(literal) as string;
      if (reusedLiterals.has(literal)) {
        // No entry, no value: the key already holds this text.
        edits.push(...planRewrite(source, literal, proposed, kind, config.readPath.import).edits);
        reused += 1;
        report.line(`${file}: reuses ${proposed} = ${clip(literal.text, ADOPTED_EXCERPT)}`);
        continue;
      }
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
    const text = applyFileEdits(source, edits);
    printedDiffs += 1;
    report.line(formatDiff(file, source, text));
    edited.push({ abs: join(io.cwd, file), rel: file, text, edits: edits.length });
  }

  // The SECOND loop: the declared copy modules. `register` re-walks the host
  // itself and never consumes scan's output, so these files are unreachable
  // without it. It reuses the descriptor-entry and seeded-default machinery
  // above and the shared write block below, and NOTHING else — no component
  // kind, no provider check, no import insertion, and above all no rewrite. A
  // copy module is adopted as RECORD: it keeps its literals, and byte-equality
  // against the snapshot is what the drift gate then watches.
  for (const [file, result] of modules) {
    // The walk ran over the tree the JSX walk handed it, before the batch below
    // writes this file's leaf edits. That is safe rather than merely tolerated:
    // `scanModule` reads the TREE's own text wherever it reads by position, so
    // its offsets and its bytes always come from the same document. Re-walking
    // instead would be worse — the rewrite plans fresh `copy('key')` calls whose
    // key arguments would need fresh claims, re-opening the accessor-key leak on
    // exactly the files most likely to have one.
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
      report.line(`${applying ? 'adopted' : 'adopts'} ${key} = ${clip(literal.text, ADOPTED_EXCERPT)}`);
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

  if (added + reused === 0) {
    report.line('register: nothing to adopt');
    return report.emit(io);
  }
  // The run without `--write` writes NOTHING, as on the static-HTML host: a
  // descriptor entry landed without its leaf edit is a key no source reads, and
  // the next `--write` would number a second one beside it.
  if (!applying) {
    report.line(pendingLine({ planOnly, added, printedDiffs }));
    return report.emit(io);
  }
  // Before ANY write, the descriptor and snapshot included: a rewrite that
  // inserts an import the host cannot resolve breaks every file it touched. Every
  // write is in the batch below, and a run that applies no leaf edit writes no import.
  if (edited.length > 0) refuseUnresolvableAlias(io.cwd, config);
  // ONE batch, with rollback: the descriptor, the snapshot, the codegen modules
  // and every leaf edit land together or not at all. The codegen regenerates
  // here so the `copy('new_key')` leaf register just wrote typechecks
  // immediately — the Accessor sig is narrow (`ContentKey`), so a stale `.d.ts`
  // would red the host tsc until a separate `stet upgrade`.
  try {
    writePlanned([
      ...planRepoForms(io.cwd, config, descriptor, snapshot, report),
      ...edited.map((e) => asUpdate(planWrite(e.abs, e.text, e.rel))),
    ]);
  } catch (error) {
    rethrowBatchFailure('stet register', error);
  }
  for (const e of edited) report.line(`${e.rel}: rewrote ${plural(e.edits, 'edit')}`);
  if (added > 0) {
    report.line(
      `wrote ${config.descriptorPath}, ${config.snapshotPath} and the codegen modules: ${plural(added, 'key')} added` +
        (reused > 0 ? `, ${reused} reused` : ''),
    );
  }
  // The closing line turns on whether there were LEAF EDITS: a `--write` run
  // that adopted only module shapes applied nothing, and "applied" is the very
  // confusion the record line exists to remove.
  report.line(
    printedDiffs === 0 ? 'register: adopted as record — there are no source edits to apply' : 'register: applied',
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

/** The closing line of a JavaScript run that does not apply: what `--write` would do. */
function pendingLine(run: { planOnly: boolean; added: number; printedDiffs: number }): string {
  if (run.planOnly) return 'register: run with --write to apply the plan';
  if (run.added === 0) return 'register: run with --write to apply the leaf edits';
  const edits = run.printedDiffs > 0 ? ' and apply the leaf edits' : '';
  return `register: run with --write to add ${plural(run.added, 'key')}${edits}`;
}

/** Enough of an adopted default to recognize it on the line that reports it. */
const ADOPTED_EXCERPT = 60;

/**
 * `register` on the static-HTML host: every located proposal becomes a key and
 * a mark, in one batch with the descriptor and the snapshot.
 *
 * The plain run writes NOTHING, as on the JavaScript branch. A descriptor entry
 * written without its mark is half a batch, and the next `check` would report
 * every such key as marked in no document.
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
  const pageOf = (file: string): string => htmlPageOf(io.cwd, file, descriptor.pages);
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

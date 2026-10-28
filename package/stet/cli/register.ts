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

import { join, resolve as resolvePath } from 'node:path';

import { headLimitsFor } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { parse, flag, text as argText, noPositionals } from './args.js';
import { astroEdits, readableAs, rereadsClean } from './astro-rewrite.js';
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
import { isHtmlHost, loadConfig, refuseUnresolvableAlias, type StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { planHtmlRegister, type ChosenName, type HtmlRegisterPlan } from './html-host.js';
import { isHeadKind, kindOf, roleOf, type Place } from './key-names.js';
import {
  madeHashes,
  placeLine,
  planProblems,
  planText,
  readPlan,
  refusePlan,
  refusePlanOut,
  type NamingPlan,
  type PlanEntry,
} from './key-plan.js';
import { htmlPageOf } from './pages.js';
import type { CliIo } from './main.js';
import { clip, collapseLines, lineCol, plural, CliError, HostTextReport, Report, UsageError } from './report.js';
import { applyFileEdits, formatDiff, planRewrite, type Edit } from './rewrite.js';
import { printProviderSnippet } from './provider-mount.js';
import { classifyAdoption, leadingOrder, planJsxRun, targetFor } from './register-run.js';
import { loadTypescript, type LocatedLiteral } from './source-scan.js';
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
  // Literals that read the key an earlier literal of this run added.
  let shared = 0;
  // Files whose leaf rewrites were shown. A run that adopted only module shapes
  // has no source edit, and its closing line must not say it has.
  let printedDiffs = 0;
  // Each edited file's text, written in the one batch with the repo forms.
  const edited: Array<{ abs: string; rel: string; text: string; edits: number }> = [];

  // Pass one, the copy modules' own names and the run's names: the naming pass
  // `scan` previews with. Then, under --plan, the plan's names.
  const jsxRun = await planJsxRun({
    cwd: io.cwd,
    config,
    descriptor,
    snapshot,
    report,
    ...(forcedKind === undefined ? {} : { forcedKind }),
  });
  const { adoptable, nameOf, reused: reusedLiterals, sharedWith, refusals, dialectFiles, astroSkips, structured, dataFindings, modules, propertyNames, mount } = jsxRun;
  // The fallback warns named the layout; the snippet names the edit, once.
  if (jsxRun.mountUnlocated && config.rootLayout !== undefined && config.router !== 'astro') {
    report.line(`${config.rootLayout}: could not locate the wrap point unambiguously — mount the CopyProvider by hand:`);
    printProviderSnippet(report, config, join(io.cwd, config.rootLayout), io.cwd, config.router);
  }
  // A naming plan lists only the keys the run adds: a reused literal is never an
  // entry, and a follower is a place of its leader's entry.
  const run = adoptable.flatMap((f) => f.literals).filter((literal) => !reusedLiterals.has(literal) && !sharedWith.has(literal));
  const followersOf = new Map<LocatedLiteral, LocatedLiteral[]>();
  for (const [literal, leader] of sharedWith) followersOf.set(leader, [...(followersOf.get(leader) ?? []), literal]);
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
      places: [literal, ...(followersOf.get(literal) ?? [])].flatMap((l) => (l.place === undefined ? [] : [l.place])),
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

  // Pass two: each file's literals keyed and rewritten. Files are met in the
  // order a shared key's leader is chosen in, so the key a leader lands under
  // is known when its followers are met; a leader that did not land leaves its
  // followers unrewritten. Every file's edits are built before any diff prints
  // (the mount joins the layout's list only where a client rewrite landed), and
  // the entries return to run order.
  const landed = new Map<LocatedLiteral, string>();
  const built: Array<{ index: number; entry: { file: string; source: string; edits: Edit[]; lines: string[] }; skipped: string[] }> = [];
  const byLeading = leadingOrder(io.cwd);
  const met = adoptable.map((item, index) => ({ item, index })).sort((a, b) => byLeading(a.item.file, b.item.file) || a.index - b.index);
  // The texts pass two leaves as written, each with its reason, after pass one's.
  const notRewritten = astroSkips.map((s) => notRewrittenLine(s.file, s.line, s.text, s.reason));
  let clientEdited = 0;
  let serverEdited = 0;
  for (const {
    item: { file, source, literals, target, kind, astro },
    index,
  } of met) {
    const edits: Edit[] = [];
    const lines: string[] = [];
    const skipped: string[] = [];
    // An Astro file's literals land together: their edits and the read-back are the file's.
    const astroLanded: Array<{ literal: LocatedLiteral; key: string }> = [];
    const leaf = (literal: LocatedLiteral, key: string): void => {
      if (astro === undefined) edits.push(...planRewrite(source, literal, key, kind, config.readPath.import).edits);
      else astroLanded.push({ literal, key });
    };
    const unreadable = (literal: LocatedLiteral, key: string): boolean => {
      if (astro === undefined || readableAs(key, astro.form)) return false;
      skipped.push(notRewrittenLine(file, lineCol(source, literal.pos).line, literal.text, `${key} cannot be read as copy.${key}`));
      return true;
    };
    for (const literal of literals) {
      const proposed = nameOf.get(literal) as string;
      const leader = sharedWith.get(literal);
      if (leader !== undefined) {
        const key = landed.get(leader);
        if (key === undefined) {
          skipped.push(notRewrittenLine(file, lineCol(source, literal.pos).line, literal.text, 'the text it shares was not rewritten'));
          continue;
        }
        if (unreadable(literal, key)) continue;
        leaf(literal, key);
        shared += 1;
        lines.push(`${file}: shares ${key} = ${clip(literal.text, ADOPTED_EXCERPT)}`);
        continue;
      }
      if (reusedLiterals.has(literal)) {
        // No entry, no value: the key already holds this text.
        leaf(literal, proposed);
        reused += 1;
        lines.push(`${file}: reuses ${proposed} = ${clip(literal.text, ADOPTED_EXCERPT)}`);
        continue;
      }
      const choice = chosen?.(proposed);
      if (choice?.adopt === false) continue;
      const key = choice?.key ?? proposed;
      if (unreadable(literal, key)) continue;
      const section = (choice?.section === undefined ? literal.sectionWord : choice.section) ?? undefined;
      // A head text carries its SEO bound as an advisory limit.
      const limits = literal.place !== undefined && isHeadKind(literal.place) ? headLimitsFor([roleOf(literal.place)]) : undefined;
      // Tentatively add so the save gate can read the key's rules; revert on any refusal.
      descriptor.keys[key] = {
        shape: 'text',
        target,
        ...(literal.rich === undefined ? {} : { tags: literal.rich.tags }),
        ...(section === undefined ? {} : { section }),
        ...(limits === undefined ? {} : { limits }),
        ...(choice?.label === undefined ? {} : { label: choice.label }),
        ...(choice?.help === undefined ? {} : { help: choice.help }),
      };
      (snapshot['default'] ??= {})[key] = literal.text;
      // Pass one gated the text and proved the rewrite; neither reads the name.
      leaf(literal, key);
      added += 1;
      landed.set(literal, key);
    }
    if (astro !== undefined) {
      const planned = astroEdits(source, astro, astroLanded);
      edits.push(...planned.edits);
      // Pass one read the file back with its own names; a failure with the final ones is stet's.
      if (planned.edits.length > 0 && !rereadsClean(await loadTypescript(), file, source, applyFileEdits(source, planned.edits), planned.reads, planned.moved)) {
        throw new CliError(`stet internal: ${file} did not read back cleanly after register planned it — nothing written`);
      }
    }

    if (edits.length > 0 && kind === 'client') clientEdited += 1;
    // Only a file that imports the read path needs the specifier to resolve.
    if (edits.length > 0 && kind === 'server' && (astro === undefined || astro.insert !== null)) serverEdited += 1;
    built.push({ index, entry: { file, source, edits, lines }, skipped });
  }
  built.sort((a, b) => a.index - b.index);
  const entries = built.map((b) => b.entry);
  notRewritten.push(...built.flatMap((b) => b.skipped));
  // The mount, where a client rewrite landed: into the layout's own list where
  // the run rewrites the layout too, else a list of its own in file order.
  if (mount !== undefined && clientEdited > 0) {
    const own = entries.find((e) => e.file === mount.layout);
    if (own !== undefined) own.edits.push(...mount.edits);
    else {
      const at = entries.findIndex((e) => e.file > mount.layout);
      entries.splice(at === -1 ? entries.length : at, 0, { file: mount.layout, source: mount.source, edits: mount.edits, lines: [] });
    }
  }
  const mounted = mount !== undefined && clientEdited > 0;
  for (const { file, source, edits, lines } of entries) {
    for (const line of lines) report.line(line);
    if (edits.length === 0) continue;
    const text = applyFileEdits(source, edits);
    printedDiffs += 1;
    if (mounted && file === mount.layout) report.line(`${file}: the one edit to existing code — mount the CopyProvider:`);
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

  const extensions = [...new Set(dialectFiles.map((f) => f.slice(f.lastIndexOf('.'))))].sort();
  for (const line of collapseLines(
    dialectFiles.map((f) => `${f}: ${f.slice(f.lastIndexOf('.'))} is not rewritten — place copy('<key>') by hand`),
    `${dialectFiles.length} files are not rewritten (${extensions.join(', ')}) — place copy('<key>') by hand; run with --verbose to list them`,
    verbose,
  )) {
    report.line(line);
  }
  for (const line of collapseLines(
    notRewritten,
    `${notRewritten.length} texts not rewritten — adopt by hand; run with --verbose to list them`,
    verbose,
  )) {
    report.line(line);
  }
  for (const { file, line } of structured) report.line(`${file}:${line}: structured data — edit it in the file`);
  for (const line of collapseLines(
    dataFindings.map((f) => `${f.file}:${f.line}: ${JSON.stringify(clip(f.text, ADOPTED_EXCERPT))} sits in data — place copy('<key>') by hand`),
    `${dataFindings.length} strings in data (arrays and objects) are not rewritten — place copy('<key>') by hand; run with --verbose to list them`,
    verbose,
  )) {
    report.line(line);
  }
  for (const line of collapseLines(
    refusals,
    `${refusals.length} file(s) could not be parsed cleanly — reported, not adopted; run with --verbose to list them`,
    verbose,
  )) {
    report.line(line);
  }

  if (added + reused + shared === 0) {
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
  // write is in the batch below. Only a server-kind rewrite imports the read path:
  // a run of client rewrites and the mount alone (every Vite run) writes none.
  if (serverEdited > 0) refuseUnresolvableAlias(io.cwd, config);
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
  if (mounted) report.line(`${mount.layout}: mounted CopyProvider`);
  if (added > 0) {
    report.line(
      `wrote ${config.descriptorPath}, ${config.snapshotPath} and the codegen modules: ${plural(added, 'key')} added` +
        (reused > 0 ? `, ${reused} reused` : '') +
        (shared > 0 ? `, ${shared} shared` : ''),
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

/** The closing line of a JavaScript run that does not apply: what `--write` would do. */
function pendingLine(run: { planOnly: boolean; added: number; printedDiffs: number }): string {
  if (run.planOnly) return 'register: run with --write to apply the plan';
  if (run.added === 0) return 'register: run with --write to apply the leaf edits';
  const edits = run.printedDiffs > 0 ? ' and apply the leaf edits' : '';
  return `register: run with --write to add ${plural(run.added, 'key')}${edits}`;
}

/** Enough of an adopted default to recognize it on the line that reports it. */
const ADOPTED_EXCERPT = 60;

/** A text register leaves as written, with the rule that left it. */
function notRewrittenLine(file: string, line: number, text: string, reason: string): string {
  return `${file}:${line} ${JSON.stringify(clip(text, ADOPTED_EXCERPT))} not rewritten (${reason}) — adopt by hand`;
}

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
  for (const { key, max } of plan.limited) report.line(`${key}: limit ${max} added`);
  const converted = plan.converted.length;
  const limited = plan.limited.length;
  if (plan.marked === 0 && converted === 0 && limited === 0) {
    report.line('register: nothing to adopt');
    return report.emit(io);
  }
  if (!write) {
    const parts = [
      ...(plan.marked === 0
        ? []
        : [`apply ${plural(plan.marked, 'mark')} across ${plural(plan.edited.length, 'document')}`]),
      ...(converted === 0 ? [] : [`derive ${plural(converted, 'key')} from the page's visible text`]),
      ...(limited === 0 ? [] : [`add the SEO limit to ${plural(limited, 'key')}`]),
    ];
    const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) as string}` : (parts[0] as string);
    report.line(`register: run with --write to ${listed}`);
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
  if (limited > 0) report.line(`wrote ${config.descriptorPath}: the SEO limit added to ${plural(limited, 'key')}`);
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

/** What `--plan` and `--plan-out` asked of this run. */
interface Naming {
  planIn?: string;
  planOut?: string;
}

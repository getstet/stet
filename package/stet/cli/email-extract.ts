/**
 * `stet email extract` — the machine that writes a template's declaration.
 *
 * The descriptor is the template registry; this is only one way to fill it. So
 * every host-facing ambiguity is a SKIP with its reason named, never a guess: a
 * file it cannot read is written by hand and is indistinguishable downstream
 * from an extracted one. Nothing is written without `--apply`.
 *
 * What it proposes per file: the `templates` entry (class and trigger defaulted
 * FOR REVIEW), one slot per text run of the file's own markup, the seeded value
 * and key definition per flattened `template__slot` key, a `render` pointer with
 * a sample-props stub read off the export's signature, and the shell rewrite
 * that turns each extracted run into ONE interpolation of its slot prop.
 *
 * The two shapes it reads are the two that exist in the wild: a function
 * returning markup-interleaved template literals (or an object of them —
 * `{ subject, html }`), and a component returning JSX. Both segment into the
 * same run model, so the naming, the lifting rule and the one-expression-per-gap
 * shell rewrite are written once.
 *
 * `--apply` writes one batch: the descriptor entries and their key definitions,
 * the seeded defaults, the regenerated codegen trio, the shell rewrites and the
 * surface lists. It lands whole or not at all — a descriptor declaring slots
 * whose shell was never rewritten renders `undefined` into a real send.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type * as TS from 'typescript';

import type { Snapshot } from '../src/snapshot.js';
import { opensMarkupTag } from '../src/targets/html-email.js';
import { EMAIL_TARGET, type Descriptor, type KeyDef, type TemplateDef } from '../src/types.js';
import { validateSave } from '../src/validate.js';
import { flag, parse, positionalsAround, refuseEnv } from './args.js';
import { asUpdate, planJson, planRepoForms, planWrite, rethrowBatchFailure, writePlanned, type WritePlan } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { CONFIG_FILE, defaultConfig, loadConfig, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { normalize } from './pages.js';
import { clip, CliError, Report, UsageError } from './report.js';
import { applyFileEdits, dominantEol, formatDiff, type Edit } from './rewrite.js';
import { filesForGlobs } from './scan.js';
import {
  decodeEntities,
  isI18nCall,
  jsxTextSuppression,
  loadTypescript,
  scriptKindFor,
  type JsxTextSuppression,
} from './source-scan.js';

/**
 * Why a file was left to a human. Exhaustive: a reason outside this set means
 * extract guessed, which is the one thing it may not do.
 */
export type SkipReason =
  | 'no-template-export'
  | 'ambiguous-exports'
  | 'unliftable-interpolation'
  | 'interleaved-markup'
  | 'i18n-copy'
  | 'unresolvable-prop-type'
  | 'unsupported-import-alias'
  | 'already-declared'
  | 'name-collision'
  | 'unwritable-props-type';

export interface ExtractSkip {
  file: string;
  reason: SkipReason;
  detail: string;
  /**
   * What to do about it. Usually the hand-written entry, which is first-class —
   * but not always, and a remedy that names the wrong fix costs the reader the
   * time it takes to try it.
   */
  remedy: string;
  /**
   * What was left as shell along the way. A file that skips for want of any
   * liftable run has to say WHY each run was passed over, or its reason reads
   * as "there was no copy here" when there was.
   */
  notes: string[];
}

/** The remedy behind almost every skip: the descriptor is the registry. */
const HAND_WRITTEN = 'declare this template by hand';

export interface SlotProposal {
  slot: string;
  /** The flattened key — how the slot lives in the store and the snapshot. */
  key: string;
  /** The seeded value, with each lifted interpolation as `{{name}}`. */
  value: string;
  /** Exactly the variables this slot lifted — the key definition's whitelist. */
  vars: string[];
}

export interface TemplateProposal {
  name: string;
  file: string;
  entry: TemplateDef;
  slots: SlotProposal[];
  /** The flattened key definitions, keyed as they land in the descriptor. */
  keys: Record<string, KeyDef>;
  source: string;
  edited: string;
  /** Runs left as shell, with the reason — reported, never silently dropped. */
  notes: string[];
}

export interface ProposalSet {
  proposals: TemplateProposal[];
  skips: ExtractSkip[];
  /** The globs named on the command line — what `--apply` persists to config. */
  globs: string[];
}

/**
 * `class` and `trigger` have no mechanical source, so they are defaulted to the
 * safest pair and PRINTED as review items. A guessed `marketing` would put a
 * template through the unsubscribe gate it never asked for; a guessed
 * `transactional` on real marketing would skip it.
 */
const DEFAULTED_ENTRY: Pick<TemplateDef, 'class' | 'trigger'> = { class: 'transactional', trigger: 'manual' };

/**
 * Elements that wrap text INSIDE a sentence. A run that sits in one of these
 * while its neighbours sit outside is the interleaved case (`Hello
 * <strong>Ada</strong>, welcome`): lifting it would cut one sentence into
 * several slots. The void ones are deliberately absent — `<br>` and `<img>`
 * separate copy rather than wrapping it, and treating every line break as
 * interleaving would refuse most real email markup.
 */
const INLINE_WRAPPERS = new Set([
  'a', 'abbr', 'b', 'cite', 'code', 'del', 'em', 'font', 'i', 'ins', 'mark',
  'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u',
]);

/** A slot name proposed from the element the run sits in. Review keeps naming. */
const SLOT_BY_TAG: Record<string, string> = {
  h1: 'headline', h2: 'headline', h3: 'headline', h4: 'headline', h5: 'headline', h6: 'headline',
  heading: 'headline',
  title: 'subject',
  preheader: 'preheader',
  p: 'body', text: 'body', div: 'body', td: 'body', li: 'body',
  a: 'cta_label', button: 'cta_label', link: 'cta_label',
};

/** The fallback when a run's element says nothing about what the copy is. */
const DEFAULT_SLOT = 'body';

/**
 * Elements whose CONTENT is code or metadata rather than copy. A run inside one
 * is never a slot: a stylesheet does not belong in an editor's dashboard, and a
 * `<script>` body lifted into a stored value would be JavaScript that an editor
 * types and every send executes.
 */
const CODE_ELEMENTS = new Set(['style', 'script', 'noscript']);

const IGNORE_MARKER = 'stet-ignore-next-line';

/** What `{{name}}` accepts (`src/validate.ts`'s whitelist regex), as one name. */
const VARIABLE_NAME = /^[a-zA-Z0-9_]+$/;

/** Enough of a replaced snapshot value to recognize the copy that was there. */
const HELD_EXCERPT = 80;

export async function runEmailExtract(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'email extract');
  const parsed = parse(args, { apply: 'boolean', json: 'boolean' });
  const json = flag(parsed.values, 'json');
  const apply = flag(parsed.values, 'apply');
  // `--apply` is optional-variadic: the positionals before it are the paths to
  // walk, the ones after are the templates to write.
  const around = positionalsAround(parsed, 'apply');
  // A blank PATH is dropped, because an empty glob would walk from the repo
  // root. A blank NAME is refused, because dropping it changes what gets
  // WRITTEN: `--apply "$TEMPLATE"` with the variable unset would go from naming
  // one template to applying every one of them, and do it at exit 0, where a
  // name stet cannot find is a refusal.
  const globs = around.before.filter((g) => g.trim() !== '');
  const names = around.after;
  if (names.some((n) => n.trim() === '')) {
    throw new UsageError('--apply was given a blank template name');
  }

  const config = loadConfig(io.cwd);
  const report = new Report();
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io, { json });

  const walk = globs.length > 0 ? globs : config.emailSurfaces;
  if (walk.length === 0) {
    report.line(
      'email extract: nothing to walk — name the template paths, or list them in emailSurfaces in stet.config.json',
    );
    return report.emit(io, { json });
  }

  const set = await proposeTemplates(io, config, descriptor, walk, globs);
  printProposals(report, set);

  if (!apply) {
    report.line(
      set.proposals.length === 0
        ? 'email extract: nothing to propose'
        : 'email extract: run with --apply to write these declarations',
    );
    return report.emit(io, { json });
  }

  // The snapshot is loaded only to WRITE it: a propose-only run reads the
  // descriptor and the host's own files, and nothing else.
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io, { json });
  applyProposals(io, config, descriptor, snapshot, set, names, report);
  return report.emit(io, { json });
}

/**
 * The proposals written, as ONE batch: the descriptor entries with their
 * flattened key definitions, the seeded defaults, the regenerated codegen trio,
 * the shell rewrites and the surface lists. Every write is shown and the batch
 * lands whole or not at all, because a descriptor declaring slots whose shell
 * was never rewritten is a project that renders `undefined` into somebody's
 * email.
 */
function applyProposals(
  io: CliIo,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  set: ProposalSet,
  names: string[],
  report: Report,
): void {
  const chosen = selectProposals(set, names);
  const locale = config.locales.default;
  const values = (snapshot[locale] ??= {});
  const templates = (descriptor.templates ??= {});

  // The entries that actually LANDED. The shell plans are built from this list
  // rather than from `chosen`, so a template whose entry was held back cannot
  // have its host file rewritten anyway — the mirror image of the half-written
  // batch, and closed by construction rather than by the two loops agreeing.
  const landed: TemplateProposal[] = [];
  for (const proposal of chosen) {
    // The second gate on the same rule the `already-declared` skip enforces at
    // proposal time: a hand-written entry survives every apply, whatever a walk
    // proposes for its name.
    if (Object.hasOwn(templates, proposal.name)) {
      report.warn('email', `${proposal.file}: ${JSON.stringify(proposal.name)} is already declared — left untouched`);
      continue;
    }
    templates[proposal.name] = proposal.entry;
    for (const [key, def] of Object.entries(proposal.keys)) descriptor.keys[key] = def;
    for (const slot of proposal.slots) {
      // A value already sitting under the flattened name is REPLACED: the
      // custody proof compares the source text, so the seed has to be what the
      // file says. Saying which value went is what lets an operator put their
      // own copy back once the migration has been proven.
      const held = Object.hasOwn(values, slot.key) ? values[slot.key] : undefined;
      if (held !== undefined && held !== slot.value) {
        report.warn(
          'email',
          `${slot.key}: the snapshot already held ${JSON.stringify(clip(String(held), HELD_EXCERPT))}, and the seed ` +
            `from ${proposal.file} replaced it — the seed has to match the source for the custody proof to pass; ` +
            'restore your own copy once verify is green',
          slot.key,
        );
      }
      values[slot.key] = slot.value;
    }
    landed.push(proposal);
  }

  // The ordering the custody proof depends on, said at the moment it is broken.
  // `verify` reads the file at HEAD; a template git has never seen has nothing
  // there, so the rewrite this run writes leaves no before at all.
  for (const file of untrackedAmong(io, landed.map((p) => p.file))) {
    report.warn(
      'email',
      `${file}: git does not track this file, so the text before the rewrite is in no commit — stet email ` +
        'verify has no before to compare against. Commit template files before extract --apply rewrites them',
      file,
    );
  }

  let written: string[] = [];
  let unchanged: string[] = [];
  try {
    const at = (rel: string): string => join(io.cwd, rel);
    const plans: WritePlan[] = [];
    if (landed.length > 0) {
      // The five repo forms, and the codegen trio among them rides the key add
      // exactly as `register` regenerates it: the slot keys this run wrote must
      // typecheck in the host's editor without an intervening `stet upgrade`.
      plans.push(...planRepoForms(io.cwd, config, descriptor, snapshot));
      for (const proposal of landed) {
        plans.push(asUpdate(planWrite(at(proposal.file), proposal.edited, proposal.file)));
      }
    }
    // The surfaces persist on their own. A walk where every file skipped still
    // told stet where the email lives, and those globs are what puts the files
    // in front of `scan` and the declared-but-unrendered-slot warn — the paths
    // a hand-written entry needs covered most.
    const surfaces = surfacePlan(io.cwd, set.globs);
    if (surfaces !== null) plans.push(surfaces);

    if (plans.length === 0) {
      report.line('email extract --apply: nothing to write');
      return;
    }
    ({ written, unchanged } = writePlanned(plans));
  } catch (error) {
    rethrowBatchFailure('email extract --apply', error);
  }

  for (const label of unchanged) report.line(`${label}: already current`);
  for (const label of written) report.line(`wrote ${label}`);
  // `--json` printed the PROPOSALS; a run that wrote them has to say which ones
  // landed, or a script reads an apply as if it were a dry run.
  report.data('applied', { templates: landed.map((p) => p.name), files: written });
  if (landed.length === 0) {
    report.line(`email extract --apply: recorded ${surfaceCount(set.globs)}; nothing else to write`);
    return;
  }
  report.line(
    `email extract --apply: ${landed.length} template${landed.length === 1 ? '' : 's'} declared ` +
      `(${landed.reduce((n, p) => n + p.slots.length, 0)} slots)`,
  );
  // The state the run just put the host in, stated as the fact it is. The
  // rewrite widens each export's props type with its slot members and touches
  // no CALL SITE, so every caller stops typechecking — and the lab found an
  // adopter can finish the printed recipe with a red build, because the next
  // step that was printed passes.
  report.line(
    'the rewrite added the slot props to each template’s props type and changed no call site: every caller of ' +
      'these exports fails to typecheck until it passes the resolved slot values',
  );
  // The migration recipe's own next steps, printed rather than remembered: the
  // custody proof is what says the rewrite changed nothing, and the callers are
  // what makes the host build again.
  report.line('next: stet email verify');
  report.line('then: pass the resolved slot values at every call site your typecheck names');
}

/**
 * Which of these paths git does not track, in ONE batch.
 *
 * `git ls-files -- <paths>` prints the tracked ones, so the difference is the
 * answer — one spawn for a whole walk rather than one per file. A project
 * without git, or a git that cannot be run, yields nothing: the warning is a
 * courtesy about ordering, and a project that does not use git has no ordering
 * to get wrong.
 */
function untrackedAmong(io: CliIo, files: string[]): string[] {
  if (files.length === 0) return [];
  const child = spawnSync('git', ['ls-files', '-z', '--', ...files], {
    cwd: io.cwd,
    // `git ls-files` prints paths relative to the cwd it is run in, which is
    // the same app root these paths are relative to.
    env: { ...io.env, LC_ALL: 'C' },
  });
  if (child.error !== undefined || child.status !== 0) return [];
  const tracked = new Set(child.stdout.toString('utf8').split('\0').filter((path) => path !== ''));
  return files.filter((file) => !tracked.has(file));
}

function surfaceCount(globs: string[]): string {
  return `${globs.length} email surface${globs.length === 1 ? '' : 's'}`;
}

/**
 * The proposals `--apply` was pointed at. A named template that produced no
 * proposal is a usage error naming what DID happen to it — a name that skipped
 * and a name that was never walked are different mistakes with different fixes.
 */
function selectProposals(set: ProposalSet, names: string[]): TemplateProposal[] {
  if (names.length === 0) return set.proposals;
  const byName = new Map(set.proposals.map((p) => [p.name, p]));
  const chosen: TemplateProposal[] = [];
  for (const name of new Set(names)) {
    const proposal = byName.get(name);
    if (proposal !== undefined) {
      chosen.push(proposal);
      continue;
    }
    const skip = set.skips.find((s) => templateName(s.file, '') === name);
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
 * The named globs persisted into BOTH surface lists — a glob in one alone is
 * either never scanned or never email-typed.
 *
 * The file is edited as RAW JSON rather than as the parsed config: `loadConfig`
 * fills in every default and ignores the fields later changes own, so writing
 * its result back would rewrite settings this command never read and delete
 * settings it cannot see. A project with no config file gets one, defaults and
 * both lists. `null` where the walk came from config and there is nothing new
 * to record.
 */
function surfacePlan(cwd: string, globs: string[]): WritePlan | null {
  if (globs.length === 0) return null;
  const path = join(cwd, CONFIG_FILE);
  const raw: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : { ...defaultConfig() };

  // `Object.hasOwn`, not a bare index: the config is JSON-parsed, so a
  // `"__proto__"` member is an own property and every other name would answer
  // from the prototype as if it had been declared.
  const declared = (field: string): string[] => {
    const value = Object.hasOwn(raw, field) ? raw[field] : undefined;
    return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : [];
  };
  // A Set keeps first-seen order, so a re-run of the same globs is a no-op.
  raw['managedSurfaces'] = [...new Set([...declared('managedSurfaces'), ...globs])];
  raw['emailSurfaces'] = [...new Set([...declared('emailSurfaces'), ...globs])];
  return asUpdate(planJson(path, raw, CONFIG_FILE));
}

/**
 * The proposal set for a walk. Reads host files and the descriptor; writes
 * nothing. `globs` is what the caller NAMED (empty when the walk came from
 * config), because `--apply` persists exactly those into the surface lists.
 */
export async function proposeTemplates(
  io: CliIo,
  config: StetConfig,
  descriptor: Descriptor,
  walk: string[],
  globs: string[] = [],
): Promise<ProposalSet> {
  const ts = await loadTypescript();
  const aliases = aliasPrefixes(ts, io.cwd);
  const proposals: TemplateProposal[] = [];
  const skips: ExtractSkip[] = [];
  // Name → the file that claimed it, or `null` for a name the descriptor
  // already declares. Which of the two it is decides what the skip says and
  // what it tells the reader to do about it.
  const taken = new Map<string, string | null>(Object.keys(descriptor.templates ?? {}).map((name) => [name, null]));

  for (const file of filesForGlobs(io.cwd, walk)) {
    const source = readFileSync(join(io.cwd, file), 'utf8');
    const outcome = proposeFile(ts, { config, descriptor, file, source, aliases, taken });
    if ('reason' in outcome) {
      skips.push(outcome);
      continue;
    }
    taken.set(outcome.name, outcome.file);
    proposals.push(outcome);
  }

  return { proposals, skips, globs };
}

interface FileContext {
  config: StetConfig;
  descriptor: Descriptor;
  file: string;
  source: string;
  aliases: AliasPrefix[];
  /** Template names already spoken for — declared, or proposed earlier in this walk. */
  taken: Map<string, string | null>;
}

function proposeFile(ts: typeof import('typescript'), ctx: FileContext): TemplateProposal | ExtractSkip {
  const { file, source } = ctx;
  const notes: string[] = [];
  const skip = (reason: SkipReason, detail: string, remedy = HAND_WRITTEN): ExtractSkip =>
    ({ file, reason, detail, remedy, notes });
  const typed = !/\.(js|jsx)$/.test(file);

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const diagnostics = (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    return skip('no-template-export', 'the compiler could not parse this file cleanly, so nothing in it is readable');
  }

  // The import check comes first, before any of the body is read: a file whose
  // specifiers the renderer cannot resolve has no verifiable declaration to
  // propose, however readable its markup is.
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (isRelative(spec) || isBarePackage(spec) || ctx.aliases.some((a) => spec.startsWith(a.prefix))) continue;
    return skip(
      'unsupported-import-alias',
      `the import ${JSON.stringify(spec)} is neither relative, a package name, nor a single-wildcard tsconfig alias — ` +
        'the renderer would not resolve it',
    );
  }

  const candidates = templateExports(ts, sf);
  if (candidates.length === 0) return skip('no-template-export', 'no exported function returns markup');
  const chosen = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.isDefault);
  if (chosen === undefined) {
    const names = candidates.map((c) => c.name).join(', ');
    return skip('ambiguous-exports', `several exports return markup (${names}) and none is the default`);
  }
  if (chosen.branches > 1) {
    // Rewriting one branch and leaving the others as literals would hand back a
    // template whose copy is editable on some code paths and frozen on others.
    return skip(
      'ambiguous-exports',
      `${chosen.name} returns markup from ${chosen.branches} branches — extract never claims a template it can only partly rewrite`,
    );
  }

  const name = templateName(file, chosen.name);
  if (name === null) return skip('no-template-export', `neither the file name nor the export ${chosen.name} makes a key`);
  if (ctx.taken.has(name)) {
    // Two names, two reasons. `already-declared` is exclusively the DESCRIPTOR
    // declaring it — a hand-written entry every apply leaves alone. Two files of
    // one walk proposing the same stem is a collision between proposals, and the
    // fix is deciding which file is `welcome`, not writing an entry by hand.
    const claimant = ctx.taken.get(name);
    return claimant === null || claimant === undefined
      ? skip('already-declared', `the descriptor already declares a template named ${JSON.stringify(name)}`)
      : skip(
          'name-collision',
          `${claimant} is already proposing the name ${JSON.stringify(name)} — two files in this walk make the same ` +
            'template name from their file stems',
          'rename one of the two files, or declare this one by hand under another name',
        );
  }

  const props = propsOf(ts, sf, chosen.fn, typed);
  if (props === null) {
    // The reason splits three ways and each has a different fix. A frame taking
    // `(content: string, …)` is not a template whose props stet can widen at
    // all — telling its author their members "cannot be read to primitives"
    // sends them looking at members they never wrote.
    const param = chosen.fn.parameters[0];
    const declared = param?.type;
    const positional =
      declared !== undefined && !ts.isTypeLiteralNode(declared) && !ts.isTypeReferenceNode(declared);
    return skip(
      'unresolvable-prop-type',
      positional
        ? `the export takes ${param?.getText(sf) ?? 'a positional parameter'} — a positional parameter rather than ` +
            'one object of named props, so there is no props member a slot could become'
        : declared === undefined
          ? 'the export’s first parameter carries no type, so there are no members to read'
          : 'the export’s first parameter names a type this file does not declare, or one whose members are not ' +
            'primitives — resolution is structural and this file only',
    );
  }
  if (props.unwritable) {
    // A JavaScript file cannot declare the props contract the slots need, and
    // stet does not write a type annotation into one.
    return skip(
      'unwritable-props-type',
      'this is a JavaScript file whose export takes no props, so there is no props contract the slots can be added to — ' +
        'give the export a props parameter, or declare the template by hand',
    );
  }

  const chunks = chunksOf(ts, sf, ctx.source, chosen, notes);
  if (chunks === null) return skip('interleaved-markup', 'a text run carries a numbered placeholder — the catalog form');
  const grouped = runsFromChunks(chunks.chunks);

  const slots: SlotProposal[] = [];
  const keys: Record<string, KeyDef> = {};
  const edits: Edit[] = [];
  const used = new Map<string, number>();

  for (const run of grouped.runs) {
    // An interpolation with no copy around it — a between-tags segment holding
    // only `${…}` — stays shell, and skips nothing: the lifting rule applies to
    // interpolations INSIDE a text run, and there is no text run here.
    if (!run.pieces.some((p) => p.kind === 'text' && p.text.trim() !== '')) continue;
    // A sentence inline markup splits stays shell, with the reason recorded.
    // The refusal is the run's, not the file's: the templates this met in the
    // lab carry one such line — a footer's `<a>Unsubscribe</a> from …` — beside
    // paragraphs that lift perfectly well.
    if (run.interleaved) {
      notes.push(
        `the run at offset ${run.pos} is part of a sentence split by inline markup — left as shell, because one ` +
          'slot per fragment would put three lines in the dashboard where an editor sees one',
      );
      continue;
    }
    // A `<style>`, `<script>` or `<noscript>` body is code and metadata, never
    // copy. Lifting one puts a stylesheet in the dashboard, and the script case
    // is worse: the shell interpolates the stored value straight back inside the
    // `<script>` tag, so an editor typing into that field is writing JavaScript
    // into every send. It also displaces the naming — the CSS took `body` and the
    // real paragraph became `body_2` — which heals by refusing the run BEFORE a
    // name is claimed (stage-5 ruling 2026-08-27).
    if (CODE_ELEMENTS.has(run.tag)) {
      notes.push(
        `the run at offset ${run.pos} is the content of a <${run.tag}> element — code, not copy, so it stays shell`,
      );
      continue;
    }
    const seeded = seedRun(run, props);
    if (seeded === null) {
      return skip('unliftable-interpolation', 'a text run interpolates something that is not a prop of the export’s first parameter');
    }
    if (seeded.value.trim() === '') continue;
    if (seeded.unknownEntity !== undefined) {
      notes.push(
        `the run at offset ${run.pos} carries the entity ${seeded.unknownEntity}, which stet does not decode — left as shell`,
      );
      continue;
    }

    const ranked = Object.hasOwn(SLOT_BY_TAG, run.tag) ? SLOT_BY_TAG[run.tag] : undefined;
    const base = run.memberName ?? ranked ?? DEFAULT_SLOT;
    const slot = freeSlot(base, used);
    const key = `${name}__${slot}`;
    // `Object.hasOwn`, not `in`: the descriptor is JSON-parsed, so a bare
    // membership test answers for `constructor` and `__proto__` as if declared.
    if (Object.hasOwn(ctx.descriptor.keys, key) || props.members.has(key)) {
      return skip('name-collision', `the flattened key ${JSON.stringify(key)} is already a descriptor key or a prop of this export`);
    }

    const def: KeyDef = seeded.vars.length === 0
      ? { shape: 'text', target: EMAIL_TARGET }
      : { shape: 'text', target: EMAIL_TARGET, vars: seeded.vars };
    // The save gate, at proposal time. Extract must never print a seed its own
    // offline check would reject — a run carrying markup the construct rule
    // blocks, or a `{{token}}` the host already had and this key never declared,
    // stays shell with the validator's own words as the reason.
    const rejection = firstRejection(key, def, seeded.value);
    if (rejection !== null) {
      notes.push(`${key} was left as shell — ${rejection}`);
      // The name went unused, so the next run of the same rank takes it.
      used.set(base, (used.get(base) ?? 1) - 1);
      continue;
    }

    slots.push({ slot, key, value: seeded.value, vars: seeded.vars });
    keys[key] = def;
    // ONE expression per gap. Adjacent text children render with comment-node
    // separators under the host's hydrating paths, and the static render this
    // change verifies with would never show it. A run that IS a member's whole
    // value replaces the value outright — `subject: props.welcome__subject`,
    // never a template literal wrapping one interpolation.
    const read = props.reference(key);
    const replacement = run.memberName !== undefined ? read : run.jsx ? `{${read}}` : `\${${read}}`;
    edits.push({ pos: run.pos, end: run.end, text: replacement });
  }

  if (slots.length === 0) {
    return skip(...noSlotReason(chunks.suppressions, notes, grouped.runs.some((run) => run.interleaved)));
  }

  edits.push(...widenProps(sf, props, slots, typed));

  const entry: TemplateDef = {
    ...DEFAULTED_ENTRY,
    slots: slots.map((s) => s.slot),
    // The MODULE's export name, which is `default` for a default export whatever
    // the function is called in source: `export default function Digest` becomes
    // `exports.default` under the CommonJS transpile the runner loads through, so
    // a pointer naming `Digest` would fail every render.
    render: { file, export: chosen.isDefault ? 'default' : chosen.name, sampleProps: props.sample },
  };

  return { name, file, entry, slots, keys, source, edited: applyFileEdits(source, edits), notes };
}

/**
 * The offline save gate, run over a proposal before it is printed.
 *
 * Extract seeds values that later reach `stet check` and every editor save, so a
 * seed its own validator rejects is a proposal that cannot be applied — the
 * markup a construct rule blocks, or a `{{token}}` the host's copy already
 * carried which this key never declared. Answering with the validator's OWN
 * message keeps one explanation of the rule rather than a second paraphrase.
 */
function firstRejection(key: string, def: KeyDef, value: string): string | null {
  const descriptor: Descriptor = { version: 1, keys: Object.fromEntries([[key, def]]) };
  const failing = validateSave(descriptor, { key, value }).findings.find((f) => f.severity === 'error');
  return failing === undefined ? null : failing.message;
}

/**
 * Why a candidate with markup in it produced no slot. Each path says what it
 * actually met: a file whose copy is a catalog's is not a file with no template
 * export, and telling an adopter the second sends them looking for the wrong
 * thing.
 */
function noSlotReason(
  suppressions: JsxTextSuppression[],
  notes: string[],
  interleaved: boolean,
): [SkipReason, string] {
  // The file takes the interleaved reason only here, where nothing lifted: a
  // template with one split sentence and four clean paragraphs is a proposal
  // with a note, not a refusal.
  if (interleaved) {
    return ['interleaved-markup', `no run could be lifted: ${notes.join('; ')}`];
  }
  if (suppressions.includes('i18n')) {
    return [
      'i18n-copy',
      "this template's copy lives in a message catalog — outside stet's v1 i18n scope, so it is reported and never " +
        'rewritten; declare the entry by hand, with the catalog message as the slot value',
    ];
  }
  if (notes.length > 0) {
    return ['no-template-export', `no run could be lifted: ${notes.join('; ')}`];
  }
  if (suppressions.includes('ignored')) {
    return ['no-template-export', 'every text run in this template is opted out at the source with an ignore marker'];
  }
  return ['no-template-export', 'the export renders no text of its own'];
}

// --- The export finder ------------------------------------------------------

interface Candidate {
  name: string;
  isDefault: boolean;
  fn: TS.SignatureDeclaration & { body?: TS.Node };
  /** The expression the body yields: a template literal, an object of them, or JSX. */
  yields: TS.Expression;
  /** How many of the body's returns yield markup — more than one is ambiguous. */
  branches: number;
}

/**
 * Every exported function whose body yields markup. An object of FUNCTIONS is
 * not one: the template literals inside it belong to nested functions, and the
 * search below never descends into those.
 */
function templateExports(ts: typeof import('typescript'), sf: TS.SourceFile): Candidate[] {
  const found: Candidate[] = [];
  const isExported = (node: TS.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: TS.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  const consider = (name: string, fn: TS.Node, defaulted: boolean): void => {
    if (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return;
    const yielded = markupReturns(ts, fn);
    const first = yielded[0];
    if (first === undefined) return;
    found.push({ name, isDefault: defaulted, fn, yields: first, branches: yielded.length });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && isExported(stmt)) {
      consider(stmt.name?.text ?? 'default', stmt, isDefault(stmt));
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
        consider(decl.name.text, decl.initializer, false);
      }
    } else if (ts.isExportAssignment(stmt) && stmt.isExportEquals !== true) {
      consider('default', stmt.expression, true);
    }
  }
  return found;
}

/**
 * Every expression this body returns that carries markup — an arrow's own
 * expression, or each top-level `return` whose value is markup.
 *
 * The set is what matters, not the first one: a `return ''` guard is not a
 * branch and must not stop the walk, while two markup returns ARE two branches
 * and rewriting one of them would leave a template whose copy is editable on
 * some code paths and frozen on others.
 */
function markupReturns(ts: typeof import('typescript'), fn: TS.Node): TS.Expression[] {
  const body = (fn as { body?: TS.Node }).body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) {
    const expr = unwrap(ts, body as TS.Expression);
    return isMarkup(ts, expr) ? [expr] : [];
  }

  const found: TS.Expression[] = [];
  const look = (node: TS.Node): void => {
    // Never into a nested function: its returns are its own.
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const expr = unwrap(ts, node.expression);
      if (isMarkup(ts, expr)) found.push(expr);
      return;
    }
    ts.forEachChild(node, look);
  };
  ts.forEachChild(body, look);
  return found;
}

function unwrap(ts: typeof import('typescript'), expr: TS.Expression): TS.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/**
 * JSX, or anything carrying a template literal of its own — `baseTemplate(…)`
 * and `frame(…) + footer()` are the shapes real mailers return, and requiring
 * the literal to be the whole returned expression would call most of them
 * unreadable. An object of FUNCTIONS still is not one: the search never
 * descends into a nested function, so their literals are not this export's.
 */
function isMarkup(ts: typeof import('typescript'), expr: TS.Expression): boolean {
  return isJsx(ts, expr) || containsTemplate(ts, expr);
}

function isJsx(ts: typeof import('typescript'), expr: TS.Expression): boolean {
  return ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr);
}

/** A template literal somewhere in this expression, never inside a nested function. */
function containsTemplate(ts: typeof import('typescript'), expr: TS.Node): boolean {
  let found = false;
  const look = (node: TS.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, look);
  };
  look(expr);
  return found;
}

// --- The chunk stream -------------------------------------------------------

type Chunk =
  | { kind: 'text'; text: string; pos: number; end: number; jsx: boolean; memberName?: string }
  | { kind: 'var'; expr: TS.Expression; pos: number; end: number }
  | { kind: 'tag'; name: string; closing: boolean; selfClosing: boolean; numbered?: boolean }
  /** A whole-initializer slot: this run replaces the member's value outright. */
  | { kind: 'member'; name: string; pos: number; end: number };

/**
 * The candidate's markup as one linear stream of tags and content, whichever
 * shape it came in. Both segmentations meet here, so run grouping, slot naming,
 * the lifting rule and the shell rewrite are written once.
 */
function chunksOf(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  source: string,
  candidate: Candidate,
  notes: string[],
): { chunks: Chunk[]; suppressions: JsxTextSuppression[] } | null {
  const chunks: Chunk[] = [];
  const suppressions: JsxTextSuppression[] = [];
  const yields = candidate.yields;

  if (isJsx(ts, yields)) {
    emitJsx(ts, sf, yields, chunks, notes, suppressions);
    return { chunks, suppressions };
  }

  // Each literal is its own markup document: a tag left open at the end of one
  // must not leak into the next, so a separator sits between them.
  const emit = (expr: TS.Expression, member: string | undefined): boolean => {
    // A catalog tagged template (`` t`Hello ${name}` ``) carries the message,
    // not markup — reported and passed over, exactly as the call form is.
    for (const literal of i18nTemplates(ts, expr)) {
      suppressions.push('i18n');
      notes.push(`a catalog template at offset ${literal.getStart(sf)} supplies this copy — reported, never lifted`);
    }
    const literals = templateLiterals(ts, expr);
    // A member whose whole value IS one literal becomes one slot, replacing the
    // initializer outright rather than its inner text.
    const whole = literals.length === 1 && (ts.isTemplateExpression(expr) || ts.isNoSubstitutionTemplateLiteral(expr));
    for (const literal of literals) {
      chunks.push({ kind: 'tag', name: '', closing: false, selfClosing: true });
      const emitted = emitTemplate(ts, sf, source, literal, notes, whole ? member : undefined);
      if (emitted === null) return false;
      chunks.push(...emitted);
    }
    return true;
  };

  if (ts.isObjectLiteralExpression(yields)) {
    for (const prop of yields.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const member = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
      if (!emit(prop.initializer, member)) return null;
    }
    return { chunks, suppressions };
  }

  return emit(yields, undefined) ? { chunks, suppressions } : null;
}

/**
 * Every template literal in an expression, in source order, never inside a
 * nested function and never a message catalog's — a tagged catalog template
 * holds the message, and lifting it would rewrite copy stet promised to leave
 * alone.
 */
function templateLiterals(
  ts: typeof import('typescript'),
  expr: TS.Node,
): Array<TS.TemplateExpression | TS.NoSubstitutionTemplateLiteral> {
  const out: Array<TS.TemplateExpression | TS.NoSubstitutionTemplateLiteral> = [];
  const look = (node: TS.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isTaggedTemplateExpression(node) && isI18nCall(ts, node)) return;
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node);
      return; // its own spans are handled by the emitter, not re-walked here
    }
    ts.forEachChild(node, look);
  };
  look(expr);
  return out;
}

/** The catalog tagged templates in an expression — reported, never lifted. */
function i18nTemplates(ts: typeof import('typescript'), expr: TS.Node): TS.TemplateLiteral[] {
  const out: TS.TemplateLiteral[] = [];
  const look = (node: TS.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isTaggedTemplateExpression(node) && isI18nCall(ts, node)) {
      out.push(node.template);
      return;
    }
    ts.forEachChild(node, look);
  };
  look(expr);
  return out;
}

/**
 * One template literal, scanned into tags and content.
 *
 * The scan runs over the RAW source of each literal part, and a part whose raw
 * text differs from its cooked text — an escape sequence — contributes no slots:
 * the offsets a rewrite needs and the characters a render produces stop lining
 * up there, and a slot proposed on a guessed offset is exactly the corruption
 * the fail-safe rule forbids. It is reported, never silently dropped.
 */
function emitTemplate(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  source: string,
  node: TS.TemplateExpression | TS.NoSubstitutionTemplateLiteral,
  notes: string[],
  memberName: string | undefined,
): Chunk[] | null {
  interface Part {
    kind: 'text' | 'expr';
    text: string;
    pos: number;
    end: number;
    expr?: TS.Expression;
  }
  const parts: Part[] = [];
  let escaped: number | null = null;
  const textPart = (lit: TS.LiteralLikeNode, trailing: number): void => {
    const start = lit.getStart(sf) + 1;
    const end = lit.end - trailing;
    const raw = source.slice(start, end);
    // Raw and cooked stop lining up at an escape sequence, and every offset a
    // rewrite needs comes from the raw side. The WHOLE literal goes shell —
    // proposing from the parts before the escape would leave the rest of the
    // sentence stranded in markup with no slot naming it.
    if (raw !== lit.text) escaped ??= start;
    parts.push({ kind: 'text', text: raw, pos: start, end });
  };

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    textPart(node, 1);
  } else {
    textPart(node.head, 2);
    for (const span of node.templateSpans) {
      // The `${` and `}` are the span's own delimiters, not the expression's:
      // `.pos` is the offset just past `${` whatever whitespace follows, and the
      // closing brace is where the next literal token starts.
      parts.push({
        kind: 'expr',
        text: '',
        pos: span.expression.pos - 2,
        end: span.literal.getStart(sf) + 1,
        expr: span.expression,
      });
      const tail = span.literal.kind === ts.SyntaxKind.TemplateTail ? 1 : 2;
      textPart(span.literal, tail);
    }
  }

  if (escaped !== null) {
    notes.push(
      `the template literal at offset ${escaped} carries a backslash escape, so its text offsets and its rendered ` +
        'characters do not line up — the whole literal was left as shell; declare this template by hand to lift it',
    );
    return [];
  }

  const whole = parts.length > 0
    ? { pos: (parts[0] as Part).pos - 1, end: node.end }
    : { pos: node.getStart(sf), end: node.end };

  const chunks: Chunk[] = [];
  let inTag = false;
  let quote = '';
  let buffer = '';

  for (const part of parts) {
    if (part.kind === 'expr' && part.expr !== undefined) {
      if (!inTag) chunks.push({ kind: 'var', expr: part.expr, pos: part.pos, end: part.end });
      continue;
    }
    let textStart = 0;
    for (let i = 0; i < part.text.length; i++) {
      const c = part.text.charAt(i);
      if (inTag) {
        if (quote !== '') {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          inTag = false;
          chunks.push(tagChunk(buffer));
          textStart = i + 1;
          continue;
        }
        buffer += c;
        continue;
      }
      if (c !== '<') continue;
      // A `<` opens markup only where a tag plausibly follows. `only if 5 < 6`
      // is prose, and treating its `<` as a boundary would truncate the
      // sentence into a slot that reads "only if 5 " with the rest stranded in
      // what the segmenter called a tag. The vocabulary is the construct rule's
      // own, so a `<` this leaves inside a value is a `<` that rule will not
      // call markup when the value reaches the save gate.
      const rest = part.text.slice(i);
      const comment = rest.startsWith('<!--');
      if (!comment && !rest.startsWith('<!') && !opensMarkupTag(rest)) continue;
      if (i > textStart) {
        chunks.push({ kind: 'text', text: part.text.slice(textStart, i), pos: part.pos + textStart, end: part.pos + i, jsx: false });
      }
      // A comment runs to `-->`, not to the first `>`: Outlook's conditional
      // comments carry whole tables, and splitting one at a `>` inside it would
      // propose a slot out of markup.
      const commentEnd = comment ? part.text.indexOf('-->', i + 4) : -1;
      if (commentEnd !== -1) {
        chunks.push({ kind: 'tag', name: '', closing: false, selfClosing: true });
        i = commentEnd + 2;
        textStart = i + 1;
        continue;
      }
      inTag = true;
      quote = '';
      buffer = '';
      textStart = part.text.length;
    }
    if (!inTag && textStart < part.text.length) {
      chunks.push({
        kind: 'text',
        text: part.text.slice(textStart),
        pos: part.pos + textStart,
        end: part.end,
        jsx: false,
      });
    }
  }

  // A numbered placeholder is a message catalog's stand-in for an element the
  // runtime substitutes — not markup, so the segmenter leaves it in the text,
  // and the sentence around it needs the token-plus-sibling-slot design phase 2
  // owns. Checked on the TEXT, which is where it now lands.
  if (chunks.some((c) => c.kind === 'text' && /<\/?\d+>/.test(c.text))) return null;

  const hasTag = chunks.some((c) => c.kind === 'tag');

  // The whole initializer is this member's copy — one run, no markup — so it is
  // replaced outright and the shell reads `subject: props.welcome__subject`
  // rather than a template literal wrapping a single interpolation. A literal
  // that carries markup segments into runs like any other.
  if (memberName !== undefined) {
    return hasTag ? chunks : [{ kind: 'member', name: memberName, pos: whole.pos, end: whole.end }, ...chunks];
  }

  // A literal with no markup in it and no member naming it is not a template's
  // copy: it is the id, the CSS, or the URL that the markup literal beside it
  // was passed along with. Lifting it would put a stylesheet in the dashboard.
  if (!hasTag) {
    notes.push(
      `the literal at offset ${whole.pos} carries no markup and names no template member — left as shell, ` +
        'since a bare string argument is an id, a style or a URL rather than copy',
    );
    return [];
  }
  return chunks;
}

/** A tag's name and shape from the text between its angle brackets. */
function tagChunk(buffer: string): Chunk {
  const match = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)/.exec(buffer);
  return {
    kind: 'tag',
    name: (match?.[2] ?? '').toLowerCase(),
    closing: match?.[1] === '/',
    selfClosing: buffer.trimEnd().endsWith('/'),
  };
}

/**
 * A JSX subtree as the same stream. Only `children` are walked — an element's
 * attributes are never entered, which is what keeps `alt`, `title` and
 * `placeholder` shell in this shape as they are in the other.
 *
 * What is out of scope is decided by `jsxTextSuppression`, the scanner's own
 * rule: a `<Trans>` sentence scan promises never to rewrite must not be lifted
 * into a slot by the tool that runs next, and an author's ignore marker means
 * the same thing to both. A suppressed node becomes a BOUNDARY, so the runs on
 * either side of it stay separate rather than merging across the gap.
 */
function emitJsx(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  node: TS.Node,
  chunks: Chunk[],
  notes: string[],
  suppressions: JsxTextSuppression[],
): void {
  const tagOf = (el: TS.JsxOpeningElement | TS.JsxSelfClosingElement): string =>
    el.tagName.getText(sf).replace(/^.*\./, '').toLowerCase();
  const boundary = (): void => {
    chunks.push({ kind: 'tag', name: '', closing: false, selfClosing: true });
  };

  const walk = (current: TS.Node): void => {
    if (ts.isJsxSelfClosingElement(current)) {
      chunks.push({ kind: 'tag', name: tagOf(current), closing: false, selfClosing: true });
      return;
    }
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) {
      const name = ts.isJsxElement(current) ? tagOf(current.openingElement) : '';
      chunks.push({ kind: 'tag', name, closing: false, selfClosing: false });
      for (const child of current.children) {
        if (ts.isJsxText(child)) {
          const suppression = child.containsOnlyTriviaWhiteSpaces ? null : jsxTextSuppression(ts, sf, child);
          if (suppression !== null) {
            suppressions.push(suppression);
            notes.push(
              suppression === 'i18n'
                ? `a text run at offset ${child.pos} is a message catalog's — reported, never lifted`
                : `a text run at offset ${child.pos} carries the ignore marker — left as shell`,
            );
            boundary();
            continue;
          }
          chunks.push({ kind: 'text', text: sf.text.slice(child.pos, child.end), pos: child.pos, end: child.end, jsx: true });
          continue;
        }
        if (ts.isJsxExpression(child)) {
          const expr = child.expression;
          // A comment container holds no copy either way; the marker inside one
          // is read by `jsxTextSuppression` from the node it precedes.
          if (expr === undefined) {
            boundary();
            continue;
          }
          if (isI18nCall(ts, expr)) {
            suppressions.push('i18n');
            notes.push(`a catalog call at offset ${child.getStart(sf)} supplies this run's copy — reported, never lifted`);
            boundary();
            continue;
          }
          chunks.push({ kind: 'var', expr, pos: child.getStart(sf), end: child.end });
          continue;
        }
        // An element whose own subtree is a catalog's is skipped whole: its text
        // belongs to the catalog, and `jsxTextSuppression` would say so for
        // every node inside it anyway.
        walk(child);
      }
      chunks.push({ kind: 'tag', name, closing: true, selfClosing: false });
      return;
    }
    // Anything else between children (a call, a map) is a boundary, not copy.
    boundary();
  };
  walk(node);
}

// --- Runs -------------------------------------------------------------------

interface Run {
  pieces: Chunk[];
  pos: number;
  end: number;
  /** The innermost element the run sits in — what proposes its slot name. */
  tag: string;
  /** An object-literal member name, where the run IS that member's whole value. */
  memberName?: string;
  jsx: boolean;
  inlineDepth: number;
  adjacentBefore: boolean;
  /** Part of a sentence that inline markup splits — reported, never lifted. */
  interleaved: boolean;
}

/**
 * The stream grouped into runs — maximal stretches of content between tags.
 *
 * Interleaving is decided per SENTENCE rather than per file. Runs with no block
 * element between them are one sentence: `Hello <strong>Ada</strong>, welcome`
 * is three runs of one sentence, and lifting them separately would put three
 * slots where an editor sees one line. So a group of adjacent runs carrying any
 * inline-wrapped run is marked whole, and every run in it stays shell — while
 * the rest of the file proposes normally.
 */
function runsFromChunks(chunks: Chunk[]): { runs: Run[] } {
  const runs: Run[] = [];
  const stack: string[] = [];
  let inlineDepth = 0;
  let blockSince = true;
  let current: Chunk[] = [];
  let runTag = '';
  let runDepth = 0;
  let runMember: string | undefined;
  let pendingMember: { name: string; pos: number; end: number } | undefined;

  const flush = (): void => {
    const meaningful = current.some((c) => c.kind !== 'text' || c.text.trim() !== '');
    if (!meaningful) {
      current = [];
      return;
    }
    const first = current[0] as Chunk & { pos: number };
    const last = current[current.length - 1] as Chunk & { end: number };
    runs.push({
      pieces: current,
      pos: pendingMember?.pos ?? first.pos,
      end: pendingMember?.end ?? last.end,
      tag: runTag,
      ...(runMember === undefined ? {} : { memberName: runMember }),
      jsx: current.some((c) => c.kind === 'text' && c.jsx),
      inlineDepth: runDepth,
      adjacentBefore: !blockSince && runs.length > 0,
      interleaved: false,
    });
    current = [];
    blockSince = false;
    pendingMember = undefined;
    runMember = undefined;
  };

  for (const chunk of chunks) {
    if (chunk.kind === 'member') {
      pendingMember = { name: chunk.name, pos: chunk.pos, end: chunk.end };
      runMember = chunk.name;
      continue;
    }
    if (chunk.kind !== 'tag') {
      if (current.length === 0) {
        runTag = stack[stack.length - 1] ?? '';
        runDepth = inlineDepth;
      }
      current.push(chunk);
      continue;
    }
    flush();
    const inline = INLINE_WRAPPERS.has(chunk.name);
    if (!inline) blockSince = true;
    if (chunk.selfClosing) continue;
    if (chunk.closing) {
      if (stack[stack.length - 1] === chunk.name) stack.pop();
      if (inline && inlineDepth > 0) inlineDepth -= 1;
    } else {
      stack.push(chunk.name);
      if (inline) inlineDepth += 1;
    }
  }
  flush();
  markInterleaved(runs);
  return { runs };
}

/**
 * One sentence's runs, marked together.
 *
 * A group runs from a run with nothing adjacent before it up to the last run
 * that follows without a block element between. Marking the WHOLE group is the
 * point: the inline-wrapped run is only half the harm, and lifting the halves
 * on either side of it would cut the sentence just as surely.
 */
function markInterleaved(runs: Run[]): void {
  let start = 0;
  for (let i = 1; i <= runs.length; i++) {
    if (i < runs.length && runs[i]?.adjacentBefore === true) continue;
    const group = runs.slice(start, i);
    // A lone run inside an inline wrapper is a whole sentence of its own — a
    // link that is the entire line, which lifts as its own slot.
    if (group.length > 1 && group.some((run) => run.inlineDepth > 0)) {
      for (const run of group) run.interleaved = true;
    }
    start = i;
  }
}

// --- Seeding ----------------------------------------------------------------

interface Seeded {
  value: string;
  vars: string[];
  /** An entity outside stet's table — the run stays shell rather than mis-seed. */
  unknownEntity?: string;
}

/**
 * A run's stored value. JSX text is cooked as the emitter cooks it and decoded,
 * because React escapes what an expression renders; template-literal text is
 * taken RAW, because the host concatenates it into HTML and an entity there is
 * already the character the client will show.
 */
function seedRun(run: Run, props: PropsShape): Seeded | null {
  let value = '';
  const vars: string[] = [];
  let unknownEntity: string | undefined;

  for (const piece of run.pieces) {
    if (piece.kind === 'text') {
      if (!piece.jsx) {
        value += piece.text;
        continue;
      }
      const unknown = undecodedEntity(piece.text);
      if (unknown !== undefined) unknownEntity ??= unknown;
      const cooked = jsxCooked(piece.text);
      if (cooked !== undefined) value += cooked;
      continue;
    }
    if (piece.kind !== 'var') continue;
    const lifted = liftedName(piece.expr, props);
    if (lifted === null) return null;
    if (!vars.includes(lifted)) vars.push(lifted);
    value += `{{${lifted}}}`;
  }

  return unknownEntity === undefined ? { value, vars } : { value, vars, unknownEntity };
}

/**
 * The variable a run's interpolation lifts to, or `null` where it lifts to
 * nothing this proposer will guess at. Exactly a first-parameter member
 * reference — so `verify`'s substitution finds the name in the sample props.
 */
function liftedName(expr: TS.Expression, props: PropsShape): string | null {
  const name = props.readMember(expr);
  if (name === null || !VARIABLE_NAME.test(name)) return null;
  return props.members.has(name) ? name : null;
}

/**
 * A JSXText node's characters as the TypeScript emitter produces them: lines
 * carrying content are joined with ONE space, the first line keeps its leading
 * whitespace (it is same-line and significant), the last keeps its trailing
 * whitespace, and a line of nothing but whitespace disappears. Entities decode
 * per line, as they do there. `undefined` where the node is pure trivia.
 *
 * The scanner's display normalization is deliberately NOT used: it rewrites a
 * non-breaking space to an ordinary one and squeezes same-line runs the emitter
 * preserves, and either rewrite breaks the byte proof.
 */
function jsxCooked(text: string): string | undefined {
  let acc: string | undefined;
  let first = 0;
  let last = -1;
  const add = (line: string): void => {
    const decoded = decodeEntities(line);
    acc = acc === undefined ? decoded : `${acc} ${decoded}`;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isLineBreak(c)) {
      if (first !== -1 && last !== -1) add(text.substring(first, last + 1));
      first = -1;
      last = -1;
    } else if (!isSingleLineWhitespace(c)) {
      last = i;
      if (first === -1) first = i;
    }
  }
  if (first !== -1 && last !== -1) add(text.substring(first));
  return acc;
}

function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

/** The emitter's own single-line whitespace set, non-breaking space included. */
function isSingleLineWhitespace(c: number): boolean {
  return (
    c === 0x20 || c === 0x09 || c === 0x0b || c === 0x0c || c === 0xa0 || c === 0x85 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200b) || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The first `&name;` the entity table does not know, where there is one. */
function undecodedEntity(text: string): string | undefined {
  for (const match of text.matchAll(/&[a-zA-Z][a-zA-Z0-9]*;/g)) {
    const entity = match[0];
    if (decodeEntities(entity) === entity) return entity;
  }
  return undefined;
}

// --- Props ------------------------------------------------------------------

interface PropsShape {
  members: Set<string>;
  sample: Record<string, unknown>;
  /** The type's member list closing brace, where a slot member can be appended. */
  insertPos: number | null;
  /** Just inside the parameter list, where an export that takes none gains one. */
  paramsPos: number | null;
  /** Where a slot name is bound into the destructuring pattern. */
  patternPos: number | null;
  /** That position is a REST element's start, not the pattern's closing brace. */
  beforeRest: boolean;
  indent: string;
  /** No props contract can be written here at all — a JS export taking none. */
  unwritable: boolean;
  /** The variable a member reference names, or `null` where the shape is not one. */
  readMember(expr: TS.Expression): string | null;
  /** How the shell reads a slot: through the parameter, or the bound name itself. */
  reference(key: string): string;
}

/**
 * The export's first parameter, resolved to primitive members and a sample-props
 * stub. Resolution is structural and THIS FILE ONLY — there is no type checker
 * here, so a props type that arrives from an import is a skip rather than a
 * guessed stub.
 */
function propsOf(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  fn: TS.SignatureDeclaration,
  typed: boolean,
): PropsShape | null {
  const param = fn.parameters[0];
  const never = (): string | null => null;
  if (param === undefined) {
    // A static template takes no props today and needs one to receive its slots.
    // In TypeScript the shell gains the whole parameter; in JavaScript there is
    // no props contract to write and stet never emits an annotation into a `.js`
    // file, so the entry is written by hand.
    return {
      members: new Set(),
      sample: {},
      insertPos: null,
      paramsPos: typed ? fn.parameters.pos : null,
      patternPos: null,
      beforeRest: false,
      indent: '',
      unwritable: !typed,
      readMember: never,
      reference: (key) => `props.${key}`,
    };
  }
  const literal = typeLiteralOf(ts, sf, param.type);
  if (literal === null) return null;

  const members = new Set<string>();
  // Built through `fromEntries`, never `sample[name] = …`: a prop legitimately
  // named `__proto__` would otherwise set this object's PROTOTYPE instead of a
  // member, and the stub would reach the renderer as a spawn argument.
  const entries: Array<[string, unknown]> = [];
  for (const member of literal.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) return null;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
    if (name === undefined) return null;
    const stub = sampleFor(ts, name, member.type);
    if (stub === undefined) return null;
    members.add(name);
    entries.push([name, stub]);
  }
  const sample = Object.fromEntries(entries);

  const closing = literal.getEnd() - 1;
  const indent = indentOf(sf.text, literal.members[0]?.getStart(sf) ?? closing);

  // `props.name` where the parameter is an identifier; a bare `name` where it
  // was destructured. Both name a first-parameter member, which is the whole
  // rule — anything else is the unliftable case. The parameter's OWN name is
  // what the shell reads through: a template whose parameter is `p` gets
  // `p.welcome__headline`, and a destructured one gets the bare slot name it
  // will also be bound under.
  const paramName = ts.isIdentifier(param.name) ? param.name.text : undefined;
  const destructured = paramName === undefined;
  const readMember = (expr: TS.Expression): string | null => {
    if (destructured) return ts.isIdentifier(expr) ? expr.text : null;
    if (!ts.isPropertyAccessExpression(expr)) return null;
    if (!ts.isIdentifier(expr.expression) || expr.expression.text !== paramName) return null;
    return ts.isIdentifier(expr.name) ? expr.name.text : null;
  };

  // Where a slot binds into a destructuring pattern: in front of a rest element
  // where there is one (it must stay last), otherwise at the closing brace.
  const pattern = ts.isObjectBindingPattern(param.name) ? param.name : null;
  const rest = pattern?.elements.find((el) => el.dotDotDotToken !== undefined);

  return {
    members,
    sample,
    insertPos: typed ? closing : null,
    paramsPos: null,
    patternPos: pattern === null ? null : (rest?.getStart(sf) ?? pattern.getEnd() - 1),
    beforeRest: rest !== undefined,
    indent,
    unwritable: false,
    readMember,
    reference: (key) => (destructured ? key : `${paramName}.${key}`),
  };
}

/** The declared type literal behind a parameter's annotation, in this file. */
function typeLiteralOf(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  type: TS.TypeNode | undefined,
): TS.TypeLiteralNode | TS.InterfaceDeclaration | null {
  if (type === undefined) return null;
  if (ts.isTypeLiteralNode(type)) return type;
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return null;
  const name = type.typeName.text;
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name && ts.isTypeLiteralNode(stmt.type)) return stmt.type;
  }
  return null;
}

/** A sample value for one prop, or `undefined` where the type is not a primitive. */
function sampleFor(ts: typeof import('typescript'), name: string, type: TS.TypeNode): unknown {
  switch (type.kind) {
    case ts.SyntaxKind.StringKeyword:
      return /url|href|link/i.test(name) ? `https://example.com/${name}` : `sample-${name}`;
    case ts.SyntaxKind.NumberKeyword:
      return 1;
    case ts.SyntaxKind.BooleanKeyword:
      return false;
    default:
      return undefined;
  }
}

function indentOf(text: string, pos: number): string {
  let start = pos;
  while (start > 0 && text.charAt(start - 1) !== '\n') start -= 1;
  const line = text.slice(start, pos);
  return /^\s*$/.test(line) ? line : '  ';
}

/**
 * The slot members appended to the declared props type, as one edit. A last
 * member with no trailing separator gets one — a single-line `{ name: string }`
 * would otherwise become two members with nothing between them.
 */
function widenProps(sf: TS.SourceFile, props: PropsShape, slots: SlotProposal[], typed: boolean): Edit[] {
  const edits: Edit[] = [];

  // A destructured parameter binds each slot by name, because that is what the
  // shell reads. Without this the rewrite emits `props.welcome__headline` into
  // a function whose parameter is `{ name }` and there is no `props` at all.
  if (props.patternPos !== null) {
    const bound = slots.map((s) => s.key).join(', ');
    if (props.beforeRest) {
      // A rest element must stay LAST (TS1180), and object-pattern member order
      // carries no meaning, so the bindings go in front of it. The text there
      // already ends in `{ ` or `, `, so nothing before it is disturbed.
      edits.push({ pos: props.patternPos, end: props.patternPos, text: `${bound}, ` });
    } else {
      const before = sf.text.slice(0, props.patternPos).replace(/\s+$/, '');
      // A pattern already ending in a comma — Prettier writes one by default on
      // a multi-line pattern — takes no second one. `{ name,, x }` is TS1180,
      // and `transpileModule` error-recovers past it, so verify would render a
      // shell the host's own tsc refuses.
      const lead = before.endsWith('{') || before.endsWith(',') ? ' ' : ', ';
      // Replaces the whitespace before the brace rather than writing past it, so
      // the pattern reads `{ name, welcome__headline }` and not `{ name , … }`.
      edits.push({ pos: before.length, end: props.patternPos, text: `${lead}${bound} ` });
    }
  }

  if (!typed) return edits;

  if (props.insertPos === null) {
    if (props.paramsPos === null) return edits;
    const members = slots.map((s) => `${s.key}: string`).join('; ');
    edits.push({ pos: props.paramsPos, end: props.paramsPos, text: `props: { ${members} }` });
    return edits;
  }

  const raw = sf.text.slice(0, props.insertPos);
  const before = raw.replace(/\s+$/, '');
  const separator = before === '' || before.endsWith(';') || before.endsWith(',') || before.endsWith('{') ? '' : ';';
  // A single-line type stays single-line: a newline inserted into
  // `{ name: string }` leaves a closing brace stranded on its own line.
  if (!/\n/.test(raw.slice(raw.lastIndexOf('{')))) {
    const members = slots.map((s) => ` ${s.key}: string;`).join('');
    // The trailing space before the brace is REPLACED, not written past: an
    // insert at the brace leaves `{ name: string ; welcome__subject: string; }`.
    edits.push({ pos: before.length, end: props.insertPos, text: `${separator}${members} ` });
    return edits;
  }
  // The file's OWN line ending: a shell whose new members are LF-joined inside
  // a CRLF file is a mixed-ending file, which shows up as a whole-file diff in
  // the review this rewrite is meant to be read in.
  const eol = dominantEol(sf.text);
  const lead = separator === '' && /\n[ \t]*$/.test(raw) ? '' : `${separator}${eol}`;
  const added = slots.map((s) => `${props.indent}${s.key}: string;`).join(eol);
  edits.push({ pos: props.insertPos, end: props.insertPos, text: `${lead}${added}${eol}` });
  return edits;
}

// --- Names ------------------------------------------------------------------

/** A template's name — the file's stem, or the export where the stem says nothing. */
function templateName(file: string, exportName: string): string | null {
  const stem = normalize(basename(file).replace(/\.(tsx|ts|jsx|js)$/, ''));
  if (stem !== null && stem !== 'index') return stem;
  return normalize(exportName);
}

/** `body`, then `body_2`, `body_3` — a repeat is numbered, never overwritten. */
function freeSlot(base: string, used: Map<string, number>): string {
  const seen = (used.get(base) ?? 0) + 1;
  used.set(base, seen);
  return seen === 1 ? base : `${base}_${seen}`;
}

// --- Module resolution ------------------------------------------------------

interface AliasPrefix {
  prefix: string;
}

/**
 * The alias prefixes the renderer maps — a single-wildcard, single-candidate
 * `paths` entry in the app's own tsconfig, and nothing richer. The runner
 * applies the same rule at resolution time (`templates/email-runner.cjs`); it is
 * a shipped `.cjs` asset and cannot import this, so the two are kept honest by
 * the render tests, which drive both forms through the real resolver.
 */
function aliasPrefixes(ts: typeof import('typescript'), cwd: string): AliasPrefix[] {
  const path = join(cwd, 'tsconfig.json');
  if (!existsSync(path)) return [];
  const read = ts.readConfigFile(path, (p) => readFileSync(p, 'utf8'));
  if (read.error !== undefined) return [];
  // `readConfigFile` BUILDS its result by assignment, so a tsconfig with a
  // `"__proto__"` member replaces this object's prototype rather than adding a
  // key — and a bare `.compilerOptions` would then read the attacker's. Every
  // step is an own-property read (executed: the polluted config maps `@/*` to a
  // directory the file never named).
  const paths = ownRecord(ownRecord(read.config, 'compilerOptions'), 'paths');
  if (paths === null) return [];

  const out: AliasPrefix[] = [];
  for (const pattern of Object.keys(paths)) {
    const candidates = paths[pattern];
    if (!Array.isArray(candidates) || candidates.length !== 1) continue;
    const target = candidates[0];
    if (typeof target !== 'string' || !loneWildcard(pattern) || !loneWildcard(target)) continue;
    out.push({ prefix: pattern.slice(0, -1) });
  }
  return out;
}

function loneWildcard(pattern: string): boolean {
  return pattern.endsWith('*') && pattern.indexOf('*') === pattern.length - 1;
}

/** One own object member of a parsed-JSON value, or `null` — never the prototype's. */
function ownRecord(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, field)) return null;
  const member = (value as Record<string, unknown>)[field];
  return member !== null && typeof member === 'object' && !Array.isArray(member)
    ? (member as Record<string, unknown>)
    : null;
}

function isRelative(spec: string): boolean {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
}

/** `react`, `node:fs`, `@scope/name` — but not `@/lib/x`, whose scope is empty. */
function isBarePackage(spec: string): boolean {
  return spec.startsWith('@') ? /^@[^/\s]+\/[^/\s]/.test(spec) : /^[A-Za-z0-9_]/.test(spec);
}

// --- Reporting --------------------------------------------------------------

/** The proposal set as a human report and as the `--json` payload. */
export function printProposals(report: Report, set: ProposalSet): void {
  for (const proposal of set.proposals) {
    report.line('');
    report.line(`${proposal.name} (${proposal.file})`);
    report.line(`  class: ${proposal.entry.class} — review`);
    report.line(`  trigger: ${proposal.entry.trigger} — review`);
    report.line(`  render: ${proposal.entry.render?.export} — sampleProps ${JSON.stringify(proposal.entry.render?.sampleProps)}`);
    for (const slot of proposal.slots) {
      const vars = slot.vars.length === 0 ? '' : ` — vars ${slot.vars.join(', ')}`;
      report.line(`  ${slot.key}: ${JSON.stringify(slot.value)}${vars}`);
    }
    for (const note of proposal.notes) report.line(`  note: ${note}`);
    const diff = formatDiff(proposal.file, proposal.source, proposal.edited);
    if (diff !== '') report.line(diff);
  }

  for (const skip of set.skips) {
    report.warn('email', `${skip.file}: skipped (${skip.reason}) — ${skip.detail}; ${skip.remedy}`);
  }

  report.data('templates', set.proposals.map((p) => ({
    name: p.name,
    file: p.file,
    entry: p.entry,
    keys: p.keys,
    values: Object.fromEntries(p.slots.map((s) => [s.key, s.value])),
    notes: p.notes,
  })));
  report.data('skips', set.skips);
}

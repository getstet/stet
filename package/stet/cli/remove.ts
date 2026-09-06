/**
 * `stet remove` — a key out of every repo form, in one all-or-nothing batch.
 *
 * The `register` posture inverted: register only ever ADDS to the descriptor,
 * the snapshot and the generated files, and remove only ever deletes from
 * them. Neither touches the store, so a removed key's rows, history and rename
 * audit survive as exactly what `audit` already names — an orphan, reported
 * never deleted.
 *
 * What the command owns: `keys`, the derivation declarations pointing at them
 * (baked into plain values before the pointer goes) and the page references to
 * them (dropped, an emptied `seo` record or `jsonLd` block with them). No other
 * section is edited, and the validator's structural refusal remains the gate
 * for any reference class a later schema adds.
 *
 * Offline by contract: the loading path is `check`'s own, never `loadProject`,
 * which constructs an adapter. There is no store to select and no store to
 * damage, which is what makes a removal safe to run on a branch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkDescriptorStructure,
  DescriptorError,
  type DescriptorWarning,
} from '../src/descriptor.js';
import { resolve } from '../src/resolve.js';
import { checkCurrency, type Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { flag, parse, refuseEnv } from './args.js';
import { planRepoForms, rethrowBatchFailure, writePlanned } from './artifacts.js';
import { checkValues, descriptorOf, snapshotOf } from './check.js';
import { isHtmlHost, loadConfig, type StetConfig } from './config.js';
import { proposeHtml, stripMarks } from './html-host.js';
import type { CliIo } from './main.js';
import { clip, CliError, Report, UsageError } from './report.js';
import { filesForGlobs } from './files.js';
import { mentionsToken } from './source-scan.js';
import { isStoreBacked } from './store.js';

/** How much of a leaving value the plan quotes — the `scan`/`register` excerpt width. */
const REMOVE_EXCERPT = 60;

export async function runRemove(args: string[], io: CliIo): Promise<number> {
  // Before `parse`, the offline column's order: an unknown option reads as a
  // misplaced value and would teach the wrong thing entirely.
  refuseEnv(args, 'remove');
  const { values, positionals } = parse(args, { write: 'boolean' });
  if (positionals.length === 0) throw new UsageError('stet remove <key> [<key>...]');
  // Named twice is named once: the whole run is one validation and one batch.
  const keys = [...new Set(positionals)];

  // The report is built FIRST because the loaders report into it: they answer
  // null and push the finding rather than throwing, so the emit below is what
  // prints check's own error string.
  const report = new Report();
  const config = loadConfig(io.cwd);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  const { cleaned, cleanedSnapshot } = planRemoval(io.cwd, config, descriptor, snapshot, keys, report);

  if (!flag(values, 'write')) {
    report.line('plan only — run with --write to apply');
    return report.emit(io);
  }

  apply(io, config, cleaned, cleanedSnapshot, report);
  report.line(`removed ${keys.length} key(s); run stet check`);
  return report.emit(io);
}

/**
 * The removal's PLAN: the post-removal forms, and every line and warning the
 * command prints about them. Split out of `runRemove` so the local dashboard's
 * Remove control shows the terminal's own plan rather than a second rendering
 * of it, and applies the same cleaned forms.
 *
 * It prints into the report it is handed and writes nothing. The one line it
 * does NOT print is `plan only — run with --write to apply`, which belongs to
 * the command's flag rather than to the plan.
 */
export function planRemoval(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  keys: string[],
  report: Report,
): { cleaned: Descriptor; cleanedSnapshot: Snapshot } {
  // All-or-nothing begins at the arguments: one unknown key refuses the whole
  // run, with nothing printed as removable. `hasOwn` rather than `in`, because
  // the key name arrives off the command line and `constructor` is the one
  // prototype name the schema's key grammar admits.
  const removing: { key: string; def: KeyDef }[] = [];
  for (const key of keys) {
    const def = Object.hasOwn(descriptor.keys, key) ? descriptor.keys[key] : undefined;
    if (def === undefined) throw new CliError(`"${key}" is not a key in ${config.descriptorPath}`);
    removing.push({ key, def });
  }

  const cleaned = structuredClone(descriptor);
  for (const key of keys) delete cleaned.keys[key];
  const cleanedSnapshot = withoutKeys(snapshot, keys);
  // The POST-REMOVAL forms, computed before anything prints as removable and
  // before the gate reads them: the gate's job is the reference classes bake
  // and drop do not cover, so it must see what they left.
  const removed = new Set(keys);
  const bakes = bakeDerivations(descriptor, snapshot, cleaned, cleanedSnapshot, removed);
  const drops = dropPageReferences(cleaned, removed);
  const warnings = refuseDanglingReferences(cleaned);

  // The plan, on the LINE channel: a plan is scriptable output, not findings.
  const surfaces = surfaceSources(cwd, config);
  for (const { key, def } of removing) {
    report.line(`remove ${key} (${def.shape}, ${def.target})`);
    for (const locale of Object.keys(snapshot).sort()) {
      const block = snapshot[locale] ?? {};
      // Only the blocks that CARRY it. A non-default locale holds the keys that
      // were translated and no others, so indexing every locale for every key
      // reads absences and quotes values that are not there.
      if (!Object.hasOwn(block, key)) continue;
      const value = block[key];
      // `clip` calls `String.replace` unguarded, so a number or a record would
      // throw, and `String(v)` renders a record as `[object Object]` — useless
      // for review. `brand__radius` is a starter key, so this is the ordinary
      // path rather than an edge.
      report.line(
        `  ${locale}: ${clip(typeof value === 'string' ? value : JSON.stringify(value), REMOVE_EXCERPT)}`,
      );
    }
    // Every bake this removal will perform, one line per dependent with the
    // value each locale receives — shown before `--write`, because a baked
    // value is copy the command is about to commit on the operator's behalf.
    const baked = new Map<string, BakeNote[]>();
    for (const note of bakes.filter((n) => n.source === key)) {
      baked.set(note.dep, [...(baked.get(note.dep) ?? []), note]);
    }
    for (const [dep, notes] of baked) {
      report.line(
        `  ${dep} derives from it — baked: ` +
          `${notes.map((n) => `${n.locale}: ${clip(n.value, REMOVE_EXCERPT)}`).join(', ')}; derivation dropped`,
      );
    }
    for (const drop of drops.filter((d) => d.key === key)) {
      if (drop.kind === 'seo') {
        // A dropped title or description arms the rule that reports the page,
        // which is the red this removal creates. An emptied record is named the
        // same way an emptied JSON-LD block is: the drop took the whole record,
        // and a plan that said only "reference dropped" would read as a
        // field-level edit.
        report.line(
          `  pages/${drop.page}/seo/${drop.field} — reference dropped` +
            (drop.field === 'title' || drop.field === 'description'
              ? `; seo check will report missing-${drop.field}`
              : '') +
            (drop.emptied ? '; the emptied record removed' : ''),
        );
        continue;
      }
      report.line(
        `  pages/${drop.page}/jsonLd/bindings/${drop.field} — binding dropped` +
          (drop.emptied ? '; the emptied block removed' : ''),
      );
    }
    for (const { file, source } of surfaces) {
      if (!mentionsToken(source, key)) continue;
      report.line(
        `  ${file} mentions "${key}" — un-wire the read first, or the regenerated types surface it ` +
          `at the host's typecheck`,
      );
    }
  }

  // Whether the removal ALSO turns `stet check` red is answered by the gate,
  // never by a hand condition: the same value pass check runs, over the cleaned
  // forms, and every finding the cleaned forms produce that the current ones do
  // not. The gate's own text names both heals, so the caution never restates
  // them, and it prints exactly when true.
  const held = findingsOver(descriptor, snapshot);
  for (const message of findingsOver(cleaned, cleanedSnapshot)) {
    if (held.has(message)) continue;
    report.line(`  after this removal, stet check will report: ${message}`);
  }
  // The currency gap the value pass cannot see: `checkValues` iterates SNAPSHOT
  // keys, so a dependent whose source resolved to nothing — baking no row —
  // leaves a declared key with no value that only `checkCurrency` reports. The
  // string is check.ts's own, so the caution never restates it.
  const beforeMissing = new Set(checkCurrency(descriptor, snapshot).missing);
  for (const key of checkCurrency(cleaned, cleanedSnapshot).missing) {
    if (beforeMissing.has(key)) continue;
    report.line(`  after this removal, stet check will report: ${key}: declared in the descriptor with no value in the snapshot`);
  }

  // On the static-HTML host a key's repo form includes its MARKS, so the plan
  // names each one the batch will strip. The text stays where it is; only the
  // attribute goes.
  if (isHtmlHost(config)) {
    const set = proposeHtml(cwd, filesForGlobs(cwd, config.managedSurfaces));
    const marks = set.claimed.filter((mark) => keys.includes(mark.key));
    if (marks.length > 0) {
      for (const mark of marks) {
        report.line(`  ${mark.file}:${mark.line} the mark is removed and the text stays`);
      }
      report.line('  every other mark is regenerated in the same write');
    }
  }

  // A config-level test over the default block and every declared environment:
  // a host with a snapshot default and a pg prod block still has live rows to
  // care about. The command never dials — structurally it cannot.
  if ([config.store, ...Object.values(config.environments ?? {})].some(isStoreBacked)) {
    report.line(
      'store rows for removed keys are kept — audit names them as orphans; ' +
        'an open draft for a removed key still publishes with its change — discard it first',
    );
  }

  // NEW warnings only. A slot warn the descriptor already carried has printed
  // once, bare, through `descriptorOf`'s fold, and re-printing it with a remedy
  // this removal did not earn misattributes it. Slot indices are stable across
  // a key removal, so path equality is exact.
  const standing = new Set(checkDescriptorStructure(descriptor).map((w) => w.path));
  for (const warning of warnings) {
    if (standing.has(warning.path)) continue;
    report.warn('config', slotRemedy(cleaned, warning));
  }

  return { cleaned, cleanedSnapshot };
}

/**
 * The five repo forms, written as ONE batch. A mid-batch failure puts back
 * every file the run had already written, so a removal either lands whole or
 * leaves the project exactly as it found it.
 *
 * The bundle is not among them: the next `pull` regenerates it from the cleaned
 * snapshot base, and every descriptor-driven read path is blind to the stale
 * entry meanwhile.
 *
 * The caller's report goes through because the batch reports as it plans: on
 * the static-HTML host it names each mark it strips as it regenerates.
 */
function apply(
  io: CliIo,
  config: StetConfig,
  cleaned: Descriptor,
  snapshot: Snapshot,
  report: Report,
): void {
  try {
    writePlanned(planRepoForms(io.cwd, config, cleaned, snapshot, report));
  } catch (error) {
    rethrowBatchFailure('stet remove --write', error);
  }
}

/** One baked derivation: the source that left, the dependent that kept its value, and the value per locale. */
interface BakeNote {
  source: string;
  dep: string;
  locale: string;
  value: string;
}

/** One dropped page reference: where it lived, and whether its containing block went with it. */
interface DropNote {
  key: string;
  page: string;
  field: string;
  kind: 'seo' | 'jsonLd';
  emptied: boolean;
}

/**
 * A surviving key that derives from a removed one, BAKED: it keeps the value it
 * resolved to and becomes a plain key.
 *
 * The oracle is the resolver itself, over the ORIGINAL forms — `resolve(d, s,
 * null, { key: dep, locale })` returns the dependent's finished value with
 * `source === 'derived'`, so a derived-of-derived source bakes fully resolved
 * and no template is re-applied outside the one place that applies templates.
 * Extracting a `deriveValue` helper would be a second derivation.
 *
 * Every locale where the SOURCE carries its own row, plus `default` always:
 * that is the set the source could differ across, and derived keys carry no
 * snapshot rows today, so the bake creates rows rather than overwriting any. A
 * source that resolves to nothing bakes nothing — the resulting currency gap is
 * `checkCurrency.missing`'s to report, and the caution prints it.
 *
 * `derivesFrom` and `tmpl` leave TOGETHER: the schema's `dependentRequired`
 * makes them both-or-neither. Every other field — `limits`, `pages`, the label
 * — stays, because the key is the same key.
 */
function bakeDerivations(
  descriptor: Descriptor,
  snapshot: Snapshot,
  cleaned: Descriptor,
  cleanedSnapshot: Snapshot,
  removed: Set<string>,
): BakeNote[] {
  const notes: BakeNote[] = [];
  for (const [dep, def] of Object.entries(cleaned.keys)) {
    // The `tmpl` test is the type narrowing as much as the guard: `KeyDef.tmpl`
    // is independently optional, so a `derivesFrom` without one is not a
    // derivation this can bake.
    if (def.derivesFrom === undefined || def.tmpl === undefined || !removed.has(def.derivesFrom)) continue;
    for (const locale of Object.keys(snapshot).sort()) {
      if (locale !== 'default' && !Object.hasOwn(snapshot[locale] ?? {}, def.derivesFrom)) continue;
      const r = resolve(descriptor, snapshot, null, { key: dep, locale });
      if (r.source !== 'derived') continue;
      (cleanedSnapshot[locale] ??= {})[dep] = r.value;
      notes.push({ source: def.derivesFrom, dep, locale, value: String(r.value) });
    }
    delete def.derivesFrom;
    delete def.tmpl;
  }
  return notes;
}

/**
 * A page `seo` field or JSON-LD binding naming a removed key, DROPPED — and an
 * `seo` record or `jsonLd` block the drop empties removed with it.
 *
 * `bindings` has no `minProperties`, so an empty block would validate and emit
 * nothing: a JSON-LD declaration that produces no JSON-LD is worse than none.
 * A page `seo` record emptied the same way goes the same way.
 *
 * Keyed by string membership, like the bake — which is what makes a declared
 * key named `constructor` handled by construction rather than by a backstop.
 */
function dropPageReferences(cleaned: Descriptor, removed: Set<string>): DropNote[] {
  const notes: DropNote[] = [];
  for (const [page, def] of Object.entries(cleaned.pages ?? {})) {
    if (def.seo !== undefined) {
      // `PageSeo` has no index signature, so the delete goes through a local
      // indexable copy and the narrowed record is reassigned.
      const seo: Record<string, string | undefined> = { ...def.seo };
      let dropped = false;
      for (const [field, key] of Object.entries(seo)) {
        if (key === undefined || !removed.has(key)) continue;
        delete seo[field];
        dropped = true;
        notes.push({ key, page, field, kind: 'seo', emptied: Object.keys(seo).length === 0 });
      }
      // Only where THIS run dropped something: a record the removal never
      // touched stays exactly as the developer wrote it, empty or not.
      if (dropped) {
        def.seo = seo;
        if (Object.keys(seo).length === 0) delete def.seo;
      }
    }
    const bindings = def.jsonLd?.bindings;
    if (bindings !== undefined) {
      let dropped = false;
      for (const [field, key] of Object.entries(bindings)) {
        if (!removed.has(key)) continue;
        delete bindings[field];
        dropped = true;
        notes.push({ key, page, field, kind: 'jsonLd', emptied: Object.keys(bindings).length === 0 });
      }
      if (dropped && Object.keys(bindings).length === 0) delete def.jsonLd;
    }
  }
  return notes;
}

/** The snapshot with the named keys gone from EVERY locale block, enabled or not. */
function withoutKeys(snapshot: Snapshot, keys: string[]): Snapshot {
  const cleaned: Snapshot = {};
  for (const [locale, block] of Object.entries(snapshot)) {
    // An emptied block keeps its `{}`: the currency check reads orphans over
    // every locale, so a block left behind uncleaned is a permanent stale warn.
    const kept = { ...block };
    for (const key of keys) delete kept[key];
    cleaned[locale] = kept;
  }
  return cleaned;
}

/**
 * Every managed surface, email surface and declared copy module, read once.
 *
 * The three lists are walked as ONE set — the walker dedupes, so the union is
 * free — because an email template is the file most likely to read a leaving
 * slot key, and a hand-written config may list it under `emailSurfaces` alone.
 * A template's `render` pointer file and its import closure are in no glob
 * list: the probe's stated residue.
 */
function surfaceSources(cwd: string, config: StetConfig): { file: string; source: string }[] {
  const globs = [...config.managedSurfaces, ...config.emailSurfaces, ...config.copyModules];
  const found: { file: string; source: string }[] = [];
  const html = isHtmlHost(config);
  for (const file of filesForGlobs(cwd, globs)) {
    try {
      const text = readFileSync(join(cwd, file), 'utf8');
      // On this host a document's marks are the very thing the batch strips, so
      // a `data-stet="<key>"` is not a read to un-wire and naming it would put a
      // caution on every page the removal already handles. The mark goes; a
      // mention of the key in prose or in a script is left to be found.
      found.push({ file, source: html && file.endsWith('.html') ? stripMarks(text) : text });
    } catch {
      // A file the walk listed and this read cannot open mentions nothing.
    }
  }
  return found;
}

/**
 * Every finding `check`'s own value pass produces over these forms, as the set
 * the caution diffs against — so the class gate is RE-RUN rather than
 * re-implemented and the caution can quote its message verbatim.
 */
function findingsOver(descriptor: Descriptor, snapshot: Snapshot): Set<string> {
  const scratch = new Report();
  checkValues(descriptor, snapshot, scratch);
  return new Set(scratch.findings.map((f) => f.message));
}

/**
 * A post-removal structure warning with its remedy INSIDE the message. The
 * report flushes every line before every finding, so a remedy printed as its
 * own line could never follow the warn it belongs to.
 *
 * The remedy is slot-scoped and says so: dropping the slot retires the slot
 * DECLARATION and heals this warn, and nothing else.
 */
function slotRemedy(cleaned: Descriptor, warning: DescriptorWarning): string {
  // `templates/<template>/slots/<i>`, the one path this validator warns on.
  const parts = warning.path.split('/');
  const template = parts[1] ?? '';
  const templates = cleaned.templates ?? {};
  // Own-property, like every other membership test in this file: the name comes
  // out of a JSON-parsed map, where a bare index answers from the prototype.
  const declared = Object.hasOwn(templates, template) ? templates[template] : undefined;
  const slot = declared?.slots[Number(parts[3])];
  if (slot === undefined) return warning.message;
  return `${warning.message}; drop "${slot}" from templates.${template}.slots to retire the slot`;
}

/**
 * The dangling-reference gate: the descriptor's own structural validation, run
 * over the post-removal copy.
 *
 * A thrown `DescriptorError` refuses, because the descriptor this removal would
 * leave behind does not load at all and nothing downstream runs on a rejected
 * one. Bake and drop consume every reference class today's schema carries, so
 * this is the gate for the classes a LATER schema adds: the reference judgment
 * is the validator's whole, never re-enumerated here, and the refusal names the
 * site IT named. The remedy is a hand edit of the referencing block.
 *
 * Exported for the gate test, which builds a cleaned descriptor carrying a
 * reference bake and drop cannot reach and asserts the throw.
 *
 * Warnings are handed back rather than raised: a template slot losing its key
 * degrades that slot and does not break the project, which is the same
 * judgment `check` inherits.
 */
export function refuseDanglingReferences(cleaned: Descriptor): DescriptorWarning[] {
  let warnings: DescriptorWarning[];
  try {
    warnings = checkDescriptorStructure(cleaned);
  } catch (error) {
    // One validation over the whole set, and the throw is first-failure: the
    // error names the REFERENCING site, so the refusal carries no per-key
    // attribution and exactly one path prints per run.
    if (error instanceof DescriptorError) throw cannotRemove(error.path, error.message);
    throw error;
  }
  return warnings;
}

function cannotRemove(path: string, message: string): CliError {
  return new CliError(`cannot remove: ${path} — ${message}; edit the reference, then re-run`);
}

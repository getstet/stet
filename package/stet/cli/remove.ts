/**
 * `stet remove` — a key out of every repo form, in one all-or-nothing batch.
 *
 * The `register` posture inverted: register only ever ADDS to the descriptor,
 * the snapshot and the generated files, and remove only ever deletes from
 * them. Neither touches the store, so a removed key's rows, history and rename
 * audit survive as exactly what `audit` already names — an orphan, reported
 * never deleted.
 *
 * Offline by contract: the loading path is `check`'s own, never `loadProject`,
 * which constructs an adapter. There is no store to select and no store to
 * damage, which is what makes a removal safe to run on a branch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import {
  checkDescriptorStructure,
  DescriptorError,
  type DescriptorWarning,
} from '../src/descriptor.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { flag, parse, refuseEnv } from './args.js';
import { asUpdate, planJson, planWrite, writePlanned, type WritePlan } from './artifacts.js';
import { checkValues, descriptorOf, snapshotOf } from './check.js';
import { loadConfig, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { clip, CliError, Report, UsageError } from './report.js';
import { filesForGlobs } from './scan.js';
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
  const warnings = refuseDanglingReferences(cleaned, keys);

  // The plan, on the LINE channel: a plan is scriptable output, not findings.
  const surfaces = surfaceSources(io.cwd, config);
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

  if (!flag(values, 'write')) {
    report.line('plan only — run with --write to apply');
    return report.emit(io);
  }

  apply(io, config, cleaned, cleanedSnapshot);
  report.line(`removed ${keys.length} key(s); run stet check`);
  return report.emit(io);
}

/**
 * The five repo forms, written as ONE batch. A mid-batch failure puts back
 * every file the run had already written, so a removal either lands whole or
 * leaves the project exactly as it found it.
 *
 * Every plan is `asUpdate`: each file's new text was computed FROM its current
 * contents, so `differs` is the ordinary case here rather than a host edit, and
 * refusing it would refuse every removal. Each is labeled with the
 * REPO-RELATIVE path, because a refusal that names a temp directory teaches
 * nothing. The bundle is not among them: the next `pull` regenerates it from
 * the cleaned snapshot base, and every descriptor-driven read path is blind to
 * the stale entry meanwhile.
 */
function apply(io: CliIo, config: StetConfig, cleaned: Descriptor, snapshot: Snapshot): void {
  try {
    const at = (rel: string): string => join(io.cwd, rel);
    const { keysTs, dts } = generateRegistry(cleaned);
    const plans: WritePlan[] = [
      asUpdate(planJson(at(config.descriptorPath), cleaned, config.descriptorPath)),
      asUpdate(planJson(at(config.snapshotPath), snapshot, config.snapshotPath)),
      asUpdate(planWrite(at(config.codegen.registry), keysTs, config.codegen.registry)),
      // MANDATORY: a stale ambient union keeps `copy('removed_key')` compiling
      // in the host, and it is the residue a removal that outran its codegen
      // leaves behind.
      asUpdate(planWrite(at(config.codegen.dts), dts, config.codegen.dts)),
      asUpdate(planWrite(at(config.codegen.defaults), generateDefaultsModule(snapshot), config.codegen.defaults)),
    ];
    writePlanned(plans);
  } catch (error) {
    // A refusal already says what it refused and that nothing was written; an
    // I/O failure says neither, and the batch's whole promise is that a failure
    // left nothing behind.
    if (error instanceof CliError || error instanceof UsageError) throw error;
    const path = (error as { path?: string }).path;
    throw new CliError(
      `stet remove --write: the write batch failed${path === undefined ? '' : ` at ${path}`} — ` +
        `${(error as Error).message}. Every file this run had already written was put back.`,
    );
  }
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
  for (const file of filesForGlobs(cwd, globs)) {
    try {
      found.push({ file, source: readFileSync(join(cwd, file), 'utf8') });
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
 * A thrown `DescriptorError` — another key's `derivesFrom`, a page's SEO field,
 * a JSON-LD binding — refuses, because the descriptor this removal would leave
 * behind does not load at all and nothing downstream runs on a rejected one.
 * The remedy is a hand edit of the referencing block: this command owns `keys`
 * and no other section. The reference judgment is the validator's whole,
 * never re-enumerated here — the refusal names the site IT named.
 *
 * Warnings are handed back rather than raised: a template slot losing its key
 * degrades that slot and does not break the project, which is the same
 * judgment `check` inherits.
 */
function refuseDanglingReferences(cleaned: Descriptor, removed: string[]): DescriptorWarning[] {
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
  refuseShadowedReferences(cleaned, removed);
  return warnings;
}

/**
 * The one reference class the validator structurally cannot judge.
 *
 * Its membership tests are `in`, and `'constructor' in copy.keys` is still true
 * after the own property is deleted — so a DECLARED key named `constructor`
 * would take its references down with it invisibly, and the broken descriptor
 * would even reload clean. For exactly the removed keys still visible through
 * the prototype, the surviving references are compared by string; every
 * ordinary name stays the validator's to judge.
 */
function refuseShadowedReferences(cleaned: Descriptor, removed: string[]): void {
  if (!removed.some((key) => key in cleaned.keys)) return;
  const gone = new Set(removed);

  for (const [key, def] of Object.entries(cleaned.keys)) {
    if (def.derivesFrom !== undefined && gone.has(def.derivesFrom)) {
      throw cannotRemove(
        `keys/${key}/derivesFrom`,
        `key "${key}" derives from "${def.derivesFrom}", which is not a key in this descriptor`,
      );
    }
  }
  for (const [page, def] of Object.entries(cleaned.pages ?? {})) {
    for (const [field, key] of Object.entries(def.seo ?? {})) {
      if (key !== undefined && gone.has(key)) {
        throw cannotRemove(
          `pages/${page}/seo/${field}`,
          `page "${page}" references SEO field "${field}" through "${key}", which is not a key in this descriptor`,
        );
      }
    }
    for (const [field, key] of Object.entries(def.jsonLd?.bindings ?? {})) {
      if (gone.has(key)) {
        throw cannotRemove(
          `pages/${page}/jsonLd/bindings/${field}`,
          `page "${page}" binds JSON-LD field "${field}" to "${key}", which is not a key in this descriptor`,
        );
      }
    }
  }
}

function cannotRemove(path: string, message: string): CliError {
  return new CliError(`cannot remove: ${path} — ${message}; edit the reference, then re-run`);
}

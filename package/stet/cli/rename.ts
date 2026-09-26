/**
 * `stet rename` — a key moves to a new name in every form stet owns, in every
 * read of it the host's source holds that stet can prove, and in every store
 * the config declares. One pair, or a plan of many; plan first, `--write` to
 * apply.
 *
 * The order is the plan's (§5): the store half, then the code half. The store
 * half re-keys each key's rows through `rename_content_key`, one transaction per
 * key per environment, after a read-only pass that finds every store reachable
 * and every new name free. The code half is one all-or-nothing batch: the
 * descriptor, the snapshot in every locale, the codegen trio or the marked
 * documents, and the host files whose reads it rewrites.
 *
 * A run that writes to a store first writes a pending record — the pairs, the
 * plan's hash, the keys each environment has renamed, whether the code half
 * landed — in `.stet/rename-pending.json`, committed with the code half while
 * an environment is left. A failure part-way leaves the record and the code as
 * they stand, and the same command run again reads the record to finish, a
 * code half the stop left part-written included; the record goes once the code
 * and every store-backed environment are done. A new name
 * with rows and an old name with none is done only where the record names the
 * pair; anywhere else those rows are someone else's and the run refuses.
 *
 * What moves with a key: its whole entry; its value in every locale; another
 * key's `derivesFrom`, a page's `seo` field and a JSON-LD binding naming it. A
 * slot key and a `brand__` key are refused, from and to: a slot key follows its
 * template, and the brand group is core's.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isNotSupported, isStoreError } from '../adapters/store-shared.js';
import { DescriptorError, loadDescriptorWithWarnings, pageKeyReferences } from '../src/descriptor.js';
import type { Snapshot } from '../src/snapshot.js';
import type { StoreAdapter } from '../src/store.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { ENV_OPTION, flag, parse, text as argText } from './args.js';
import {
  asUpdate,
  planJson,
  planRepoForms,
  planWrite,
  rethrowBatchFailure,
  writePlanned,
  writeText,
  type WritePlan,
} from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import {
  isHtmlHost,
  loadConfig,
  normalizeNoExt,
  pathAliasMappings,
  resolveSpecifier,
  selectStoreBlock,
  type StetConfig,
} from './config.js';
import { filesForGlobs } from './files.js';
import { gitData } from './git.js';
import { lineIndex, proposeHtml } from './html-host.js';
import { planProblems, readPlan, refusePlan, type NamingPlan, type PlanEntry } from './key-plan.js';
import { planReadRenames, type Occurrence } from './key-reads.js';
import type { CliIo } from './main.js';
import { renameRecorded } from './meta.js';
import { injectedFor } from './project.js';
import { HostTextReport, plural, Report, UsageError } from './report.js';
import { applyFileEdits, formatDiff } from './rewrite.js';
import { dialectOf, loadTypescript, matchGlob } from './source-scan.js';
import { isStoreBacked, resolveStore } from './store.js';
import { resolveEditor } from './write.js';

const USAGE = 'stet rename <old> <new> | --plan FILE [--write] [--env NAME] [--editor E]';

/**
 * The pending record, beside the bundle. While an environment is left it is
 * committed with the code half, so a fresh clone or another machine finishes
 * the rename from it; the commit that finishes the rename removes it.
 */
const PENDING_PATH = '.stet/rename-pending.json';

/** A store half in progress: what `rename` reads to finish a run that stopped. */
interface Pending {
  version: 1;
  /** `sha256` of the pairs, in plan order. */
  plan: string;
  pairs: Array<[string, string]>;
  /** Per environment, the old names renamed there. */
  done: Record<string, string[]>;
  /** Per environment, the old names whose rename was called, logged before each call. */
  attempted: Record<string, string[]>;
  /** Whether the code half landed. */
  code: boolean;
}

export async function runRename(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    plan: 'string',
    write: 'boolean',
    editor: 'string',
    ...ENV_OPTION,
  });
  const planFile = argText(values, 'plan');
  if ((planFile === undefined) === (positionals.length === 0) || (planFile === undefined && positionals.length !== 2)) {
    throw new UsageError(USAGE);
  }
  const write = flag(values, 'write');
  const editor = resolveEditor(argText(values, 'editor'));
  const only = argText(values, 'env');

  const report = new HostTextReport();
  const config = loadConfig(io.cwd);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  const pair = planFile === undefined ? { old: positionals[0] as string, key: positionals[1] as string } : null;
  if (pair !== null && pair.old === pair.key) {
    return refusePlan(io, report, 'stet rename', undefined, [`${pair.old}: the new name is the old name — nothing to rename`]);
  }
  const plan: NamingPlan =
    pair !== null
      ? { plan: 'stet rename', version: 1, keys: [{ old: pair.old, key: pair.key, label: null, help: null }] }
      : readPlan(io.cwd, planFile as string, 'stet rename');

  const moves = plan.keys.filter((e) => e.old !== e.key);
  const renames = new Map(moves.map((e) => [e.old as string, e.key]));
  const planHash = `sha256:${createHash('sha256').update(JSON.stringify([...renames])).digest('hex')}`;
  const pending = readPending(io.cwd);
  if (pending !== null && pending.plan !== planHash) {
    report.error(
      'store',
      `a rename is pending in ${PENDING_PATH} (${pending.pairs.map(([a, b]) => `${a} → ${b}`).join(', ')}) — ` +
        'run that plan again to finish it before another',
    );
    return report.emit(io);
  }
  // An entry the descriptor already holds under its new name.
  const moved = (e: PlanEntry): boolean =>
    !Object.hasOwn(descriptor.keys, e.old as string) && Object.hasOwn(descriptor.keys, e.key);
  // A plan whose every move has landed in the code, with no record left, is a
  // rename that has finished: one line per cause, never one per key.
  if (pending === null && moves.length > 0 && moves.every(moved)) {
    return refusePlan(io, report, 'stet rename', planFile, [
      `${moves.map((e) => e.old as string).join(', ')}: not keys in the descriptor`,
      `${moves.map((e) => e.key).join(', ')}: already keys in the descriptor — the rename has landed`,
    ]);
  }
  // A run whose code half landed renames the stores alone, from its own record.
  // A record whose code half has not landed resumes it from the files as they
  // stand: a stop inside the batch can leave any of its files renamed, so the
  // descriptor alone never says the code landed.
  const storeOnly = pending !== null && pending.code;

  // Every store-backed environment, or the one --env names, the others each
  // named as left for a later run.
  const declared = ['default', ...Object.keys(config.environments ?? {}).sort()].filter((env) =>
    isStoreBacked(selectStoreBlock(config, env).block),
  );
  const selected = only === undefined ? declared : declared.filter((env) => env === selectStoreBlock(config, only).name);

  if (!storeOnly) {
    // A resumed run judges only the entries its stop left under their old names.
    const open = pending === null ? plan : { ...plan, keys: plan.keys.filter((e) => !moved(e)) };
    const problems = planProblems(open, planFile ?? 'the pair', descriptor, Object.keys(descriptor.keys), {
      refusal: slotOrBrand(descriptor),
    });
    // A store renames one key at a time, so a name one entry leaves and another
    // takes would meet rows still under it.
    if (declared.length > 0) {
      for (const e of moves) {
        if (renames.has(e.key)) {
          problems.push(
            `${e.old as string}: "${e.key}" is another entry's old name — a store renames one key at a time, ` +
              'so rename through a temporary name in two plans',
          );
        }
      }
    }
    if (problems.length > 0) return refusePlan(io, report, 'stet rename', planFile, problems);
  }

  // The code half, planned — and checked whole before any store is touched.
  const words = new Map(plan.keys.map((e) => [e.old as string, e]));
  const forms = storeOnly ? null : renamedForms(descriptor, snapshot, renames, words);
  if (forms !== null) {
    try {
      loadDescriptorWithWarnings(structuredClone(forms.descriptor));
    } catch (error) {
      if (!(error instanceof DescriptorError)) throw error;
      report.error('config', `cannot rename: ${error.path} — ${error.message}; nothing written`);
      return report.emit(io);
    }
  }
  const host = storeOnly ? null : isHtmlHost(config) ? markRenames(io.cwd, config, renames) : await readRenames(io.cwd, config, renames);
  const plans: WritePlan[] =
    forms === null || host === null
      ? []
      : [
          ...(isHtmlHost(config)
            ? [
                asUpdate(planJson(join(io.cwd, config.descriptorPath), forms.descriptor, config.descriptorPath)),
                asUpdate(planJson(join(io.cwd, config.snapshotPath), forms.snapshot, config.snapshotPath)),
              ]
            : planRepoForms(io.cwd, config, forms.descriptor, forms.snapshot, report)),
          ...host.edited.map((e) => asUpdate(planWrite(join(io.cwd, e.rel), e.text, e.rel))),
        ];
  // Only the forms whose bytes change are written, and named.
  const changed = plans.filter((p) => p.status !== 'unchanged');
  const files = changed.map((p) => p.label);

  const flight = await preflight({ io, report, config, snapshot, renames, pending, declared, selected });
  if (flight === null) return report.emit(io);
  const { stores, left } = flight;

  if (storeOnly && stores.every((s) => s.done.size === renames.size)) {
    // The nothing-to-do line only where no environment is left.
    if (left.length === 0) {
      finishPending(io.cwd, report, renames.size);
      report.line('rename: every key already carries its new name in the code and in every store — nothing to do');
    }
    return report.emit(io);
  }

  for (const [old, next] of renames) {
    report.line(`rename ${old} → ${next}`);
    for (const line of forms?.follows.get(old) ?? []) report.line(`  ${line}`);
    for (const occ of host?.rewritten.filter((o) => o.key === old) ?? []) {
      report.line(isHtmlHost(config) ? `  ${occ.file}:${occ.line} the mark is renamed` : `  ${occ.file}:${occ.line} ${occ.text}`);
    }
    const mentioned = new Set((host?.mentions.filter((o) => o.key === old) ?? []).map((o) => `${o.file}:${o.line}`));
    for (const at of mentioned) report.line(`  ${at} mentions "${old}" in text — left as it is`);
    for (const occ of host?.blocked.filter((o) => o.key === old) ?? []) {
      report.line(`  ${occ.file}:${occ.line} reads "${old}" in a form stet cannot rewrite — edit it to the new name by hand, then re-run`);
    }
    for (const occ of host?.unparsed.filter((o) => o.key === old) ?? []) {
      report.line(`  ${occ.file}:${occ.line} an expression stet cannot parse — edit "${old}" in this file to the new name by hand, then re-run`);
    }
  }
  if (host !== null && !isHtmlHost(config)) {
    report.line(
      'stet cannot see reads outside the declared surfaces: other repositories, a Python reader of the bundle, ' +
        'or an agent calling the API by the old name',
    );
  }
  const blocked = host?.blocked.length ?? 0;
  if (blocked > 0) report.error('scan', `cannot rename: ${plural(blocked, 'read')} stet cannot rewrite — nothing written`);
  const unparsed = host?.unparsed.length ?? 0;
  if (unparsed > 0) report.error('scan', `cannot rename: ${plural(unparsed, 'expression')} stet cannot parse — nothing written`);
  if (blocked > 0 || unparsed > 0) return report.emit(io);

  if (!write) {
    report.line(
      storeOnly
        ? `rename: run with --write to rename ${plural(renames.size, 'key')} in ${stores.map((s) => `store (${s.env})`).join(', ')}`
        : `rename: run with --write to rename ${plural(renames.size, 'key')} across ${files.join(', ')}`,
    );
    return report.emit(io);
  }

  // The record first, so a stop anywhere after it is finished by the same command.
  const record: Pending = pending ?? {
    version: 1,
    plan: planHash,
    pairs: [...renames],
    done: {},
    attempted: {},
    code: false,
  };
  if (declared.length > 0) writePending(io.cwd, record);

  if (!(await storeHalf({ io, report, renames, editor, stores, record }))) return report.emit(io);
  const everyStore = declared.every((env) => doneIn(record.done, env).length === renames.size);
  if (!storeOnly) codeHalf({ io, report, renames, changed, files, record, declared, everyStore });
  else if (everyStore) finishPending(io.cwd, report, renames.size);
  else {
    writePending(io.cwd, record);
    report.line(recordCommitLine(renames.size));
  }
  return report.emit(io);
}

/** A store the store half renames in, and the old names already renamed there. */
interface RenameStore {
  env: string;
  store: StoreAdapter;
  done: Set<string>;
}

/**
 * The pre-flight: every declared environment, read-only, whatever --env narrows
 * the write to — each store reachable, and each new name free or explained as
 * this rename's own. Answers the selected stores and the environments left for
 * a later run, or null once it has reported why the run stops.
 */
async function preflight(d: {
  io: CliIo;
  report: Report;
  config: StetConfig;
  snapshot: Snapshot;
  renames: ReadonlyMap<string, string>;
  pending: Pending | null;
  declared: string[];
  selected: string[];
}): Promise<{ stores: RenameStore[]; left: string[] } | null> {
  const { io, report, config, snapshot, renames, pending, declared, selected } = d;
  const stores: RenameStore[] = [];
  const left: string[] = [];
  for (const env of declared) {
    const store = await resolveStore(config, io.env, injectedFor(io, env), env);
    const done = new Set(doneIn(pending?.done, env));
    const attempted = new Set(doneIn(pending?.attempted, env));
    for (const [old, next] of renames) {
      if (done.has(old)) continue;
      const had = await hasRows(store, old);
      const has = await hasRows(store, next);
      if (had === null || has === null) {
        report.error('store', `store (${env}) is not reachable — nothing written`);
        return null;
      }
      if (has && had) {
        report.error('store', `cannot rename ${old}: "${next}" already has rows in store (${env})`);
        return null;
      }
      if (has) {
        // Renamed by this plan's own call in this environment, which stopped
        // before its record did; or by this rename run from another checkout,
        // which the store's own rename log holds — or rows under the new name
        // that are no rename's.
        const logged = attempted.has(old) || (await recorded(io, config, env, store, old, next));
        if (logged === null) {
          report.error('store', `store (${env}) is not reachable — nothing written`);
          return null;
        }
        if (logged) {
          done.add(old);
          continue;
        }
        report.error(
          'store',
          `cannot rename ${old}: "${next}" already has rows in store (${env}) that no pending rename of ${old} explains — ` +
            'a removed key leaves its rows in the store (stet audit lists them); choose another name',
        );
        return null;
      }
    }
    if (!selected.includes(env)) {
      if (done.size < renames.size) left.push(env);
      continue;
    }
    stores.push({ env, store, done });
    // The window between the store half and the renamed code's deploy: the
    // site, still reading the old names, finds no row and serves the snapshot.
    const rows = await store.read({ keys: [...renames.keys()] });
    if (!isStoreError(rows)) {
      for (const row of rows) {
        if (row.status !== 'published' || row.is_active !== true || row.locale !== 'default') continue;
        // The snapshot holds the key under its old name, or — on a store-only run — its new one.
        const block = snapshot['default'] ?? {};
        const name = Object.hasOwn(block, row.key) ? row.key : (renames.get(row.key) ?? row.key);
        const committed = Object.hasOwn(block, name) ? block[name] : undefined;
        if (JSON.stringify(committed) !== JSON.stringify(row.value)) {
          report.line(
            `store (${env}): ${row.key}'s published value differs from the snapshot — run stet pull first, ` +
              'so the site serves the published value until the renamed code deploys',
          );
        }
      }
    }
  }
  for (const env of left) {
    report.line(`store (${env}): not renamed in this run — run the same command with --env ${env} to finish`);
  }
  return { stores, left };
}

/** Whether a store's rename log holds the pair; null where the store did not answer. */
async function recorded(io: CliIo, config: StetConfig, env: string, store: StoreAdapter, old: string, next: string): Promise<boolean | null> {
  try {
    return await renameRecorded(config, io.env, env, store, { oldKey: old, newKey: next }, io.fetchImpl);
  } catch {
    return null;
  }
}

/**
 * The store half, one key at a time, stopping at the first failure. A key with
 * no rows is called too: the RPC records every rename in `stet_renames`.
 * Answers false once it has reported the stop.
 */
async function storeHalf(d: {
  io: CliIo;
  report: Report;
  renames: ReadonlyMap<string, string>;
  editor: string;
  stores: RenameStore[];
  record: Pending;
}): Promise<boolean> {
  const { io, report, renames, editor, stores, record } = d;
  for (const { env, store, done } of stores) {
    let count = 0;
    const already = done.size;
    for (const [old, next] of renames) {
      if (done.has(old)) continue;
      // Logged before the call, so a call that lands and never answers is still
      // this plan's on the next run.
      record.attempted[env] = [...new Set([...doneIn(record.attempted, env), old])];
      writePending(io.cwd, record);
      const answer = await store.rename({ oldKey: old, newKey: next, editor });
      if (isStoreError(answer) || isNotSupported(answer)) {
        const why = isStoreError(answer) ? answer.message : 'the store answered that it cannot rename keys';
        report.error(
          'store',
          `store (${env}): ${count} of ${plural(renames.size - already, 'key')} re-keyed before ${why} — ` +
            'this run wrote no code; run the same command again to finish',
        );
        return false;
      }
      count += 1;
      done.add(old);
      record.done[env] = [...done];
      writePending(io.cwd, record);
    }
    record.done[env] = [...done];
    const skipped = already > 0 ? `, ${already} already renamed` : '';
    report.line(`store (${env}): ${plural(count, 'key')} re-keyed${skipped}; their history stays linked under the new names`);
  }
  return true;
}

/**
 * The code half, one batch, of only the files whose bytes change. While an
 * environment is left, the record goes into the same commit, so any clone of
 * the repository finishes the rename.
 */
function codeHalf(d: {
  io: CliIo;
  report: Report;
  renames: ReadonlyMap<string, string>;
  changed: WritePlan[];
  files: string[];
  record: Pending;
  declared: string[];
  everyStore: boolean;
}): void {
  const { io, report, renames, changed, files, record, declared, everyStore } = d;
  try {
    writePlanned(changed);
  } catch (error) {
    rethrowBatchFailure('stet rename --write', error);
  }
  record.code = true;
  const keep = declared.length > 0 && !everyStore;
  if (keep) writePending(io.cwd, record);
  else if (declared.length > 0) clearPending(io.cwd);
  const named = keep ? [...files, PENDING_PATH] : files;
  // A resumed run whose stop had already written every file names nothing.
  if (named.length > 0) {
    report.line(`wrote ${named.join(', ')}: ${plural(renames.size, 'key')} renamed`);
    report.line(`commit them together: git commit -m "stet: rename ${plural(renames.size, 'key')}" -- ${named.join(' ')}`);
  }
}

/** The commit line for the record alone, updated or removed by a store-only run. */
function recordCommitLine(count: number): string {
  return `commit the rename record: git commit -m "stet: rename ${plural(count, 'key')}" -- ${PENDING_PATH}`;
}

/**
 * The rename is finished in every store and in the code: the record goes, and
 * where a commit carried it, its removal is committed too.
 */
function finishPending(cwd: string, report: Report, count: number): void {
  const tracked = gitData(cwd, ['ls-files', '--error-unmatch', '--', PENDING_PATH]).code === 0;
  clearPending(cwd);
  if (tracked) report.line(recordCommitLine(count));
}

/**
 * Whether a key has any row in a store — published, draft or scheduled, in any
 * locale — the test `rename_content_key` refuses an occupied target by; `null`
 * where the store did not answer. History carries every published version and
 * a preview read every draft.
 */
async function hasRows(store: StoreAdapter, key: string): Promise<boolean | null> {
  const history = await store.history({ key, limit: 1 });
  if (isStoreError(history)) return null;
  if (!isNotSupported(history) && history.rows.length > 0) return true;
  const rows = await store.read({ keys: [key], preview: true });
  if (isStoreError(rows)) return null;
  return rows.some((row) => row.key === key);
}

/** The pending record, or null where none is; a record stet cannot read is a refusal, never a guess. */
function readPending(cwd: string): Pending | null {
  const path = join(cwd, PENDING_PATH);
  if (!existsSync(path)) return null;
  let raw: Pending | undefined;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Pending;
  } catch {
    raw = undefined;
  }
  const isMap = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (raw?.version !== 1 || !Array.isArray(raw.pairs) || typeof raw.plan !== 'string' || !isMap(raw.done) || !isMap(raw.attempted)) {
    throw new UsageError(`${PENDING_PATH} is not a rename record stet wrote — remove it once every store is checked`);
  }
  return raw;
}

/** The old names a record lists for one environment. Own properties only: the record is parsed JSON. */
function doneIn(map: Record<string, string[]> | undefined, env: string): string[] {
  return map !== undefined && Object.hasOwn(map, env) ? (map[env] as string[]) : [];
}

function writePending(cwd: string, record: Pending): void {
  mkdirSync(join(cwd, dirname(PENDING_PATH)), { recursive: true });
  writeText(join(cwd, PENDING_PATH), `${JSON.stringify(record, null, 2)}\n`);
}

function clearPending(cwd: string): void {
  rmSync(join(cwd, PENDING_PATH), { force: true });
  // `.stet` too, where the record was all it held.
  try {
    rmdirSync(join(cwd, dirname(PENDING_PATH)));
  } catch {
    // It holds the bundle or the baseline, or is already gone.
  }
}

/** An entry naming a slot key or a `brand__` key, from or to: its one refusal line. */
function slotOrBrand(descriptor: Descriptor): (entry: PlanEntry) => string | undefined {
  const slots = new Map<string, { template: string; slot: string }>();
  for (const [template, def] of Object.entries(descriptor.templates ?? {})) {
    for (const slot of def.slots) slots.set(`${template}__${slot}`, { template, slot });
  }
  return (e) => {
    const old = e.old as string;
    for (const name of [old, e.key]) {
      const slot = slots.get(name);
      if (slot !== undefined) {
        return `cannot rename ${old}: ${name} is the ${slot.slot} slot of the ${slot.template} template — a slot key follows its template`;
      }
    }
    if (old.startsWith('brand__') || e.key.startsWith('brand__')) return `cannot rename ${old}: brand__ keys belong to the brand group`;
    return undefined;
  };
}

/**
 * The descriptor and snapshot with every key under its new name, the words a
 * plan gave, and every reference followed; per leaving key, the lines naming
 * what followed. The inputs are copied, never changed.
 */
export function renamedForms(
  descriptor: Descriptor,
  snapshot: Snapshot,
  renames: ReadonlyMap<string, string>,
  words: ReadonlyMap<string, { label: string | null; help: string | null }>,
): { descriptor: Descriptor; snapshot: Snapshot; follows: Map<string, string[]> } {
  const follows = new Map<string, string[]>();
  const follow = (old: string, line: string): void => {
    follows.set(old, [...(follows.get(old) ?? []), line]);
  };
  const to = (key: string): string => renames.get(key) ?? key;

  const out = structuredClone(descriptor);
  const keys: Record<string, KeyDef> = {};
  for (const [key, def] of Object.entries(out.keys)) {
    const w = words.get(key);
    const next: KeyDef = {
      ...def,
      ...(w?.label === null || w?.label === undefined ? {} : { label: w.label }),
      ...(w?.help === null || w?.help === undefined ? {} : { help: w.help }),
    };
    if (def.derivesFrom !== undefined && renames.has(def.derivesFrom)) {
      follow(def.derivesFrom, `${to(key)} derives from it and follows`);
      next.derivesFrom = to(def.derivesFrom);
    }
    keys[to(key)] = next;
  }
  out.keys = keys;
  for (const ref of pageKeyReferences(out)) {
    if (!renames.has(ref.key)) continue;
    const def = (out.pages ?? {})[ref.page];
    if (def === undefined) continue;
    if (ref.kind === 'seo') {
      follow(ref.key, `pages/${ref.page}/seo/${ref.field} follows`);
      def.seo = { ...def.seo, [ref.field]: to(ref.key) };
    } else {
      follow(ref.key, `pages/${ref.page}/jsonLd/bindings/${ref.field} follows`);
      (def.jsonLd as { bindings: Record<string, string> }).bindings[ref.field] = to(ref.key);
    }
  }

  const oldOf = new Map([...renames].map(([old, next]) => [next, old]));
  // A key with a value under its old name in any locale has not moved, so a
  // value already under its new name (check's "not in the descriptor") is stale
  // in every locale. Where no locale holds the old name, a stop moved the whole
  // snapshot and the values under the new name are the key's own.
  const unmoved = new Set([...renames.keys()].filter((old) => Object.values(snapshot).some((b) => Object.hasOwn(b, old))));
  const snap: Snapshot = {};
  for (const [locale, block] of Object.entries(snapshot)) {
    const moved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block)) {
      const old = renames.has(key) ? undefined : oldOf.get(key);
      if (old !== undefined && unmoved.has(old)) continue;
      moved[to(key)] = value;
    }
    snap[locale] = moved;
  }
  return { descriptor: out, snapshot: snap, follows };
}

/** What a rename does to the host's files, and what it leaves. */
interface HostRenames {
  edited: Array<{ rel: string; text: string; diff: string }>;
  rewritten: Occurrence[];
  blocked: Occurrence[];
  mentions: Occurrence[];
  /** Brace expressions that do not parse, in files holding a leaving key (`planReadRenames`). */
  unparsed: Occurrence[];
}

/**
 * The static-HTML host: every `data-stet` and `data-stet-<attr>` naming a leaving
 * key, its value replaced. The mark is the only read on this host, so nothing
 * is blocked and nothing is a mention.
 */
function markRenames(cwd: string, config: StetConfig, renames: ReadonlyMap<string, string>): HostRenames {
  const set = proposeHtml(cwd, filesForGlobs(cwd, config.managedSurfaces));
  const out: HostRenames = { edited: [], rewritten: [], blocked: [], mentions: [], unparsed: [] };
  for (const document of set.documents) {
    const edits: Array<{ pos: number; end: number; text: string }> = [];
    for (const mark of set.claimed.filter((m) => m.document === document && renames.has(m.key))) {
      const name = mark.kind === 'element' ? 'data-stet' : `data-stet-${mark.attr as string}`;
      const attr = mark.element.attrs.find((a) => a.name === name && a.value === mark.key);
      if (attr === undefined) continue;
      edits.push({ pos: attr.valueStart, end: attr.valueEnd, text: renames.get(mark.key) as string });
      out.rewritten.push({ file: mark.file, line: mark.line, at: attr.valueStart, key: mark.key, text: '' });
    }
    // A mark the walk skipped still names the key; left behind, it would mark
    // nothing. It is blocked, so the write is refused until it is edited by hand.
    const lineAt = lineIndex(document.source);
    for (const [old] of renames) {
      const mark = new RegExp(`\\sdata-stet(?:-[a-z][a-z0-9-]*)?\\s*=\\s*(["']?)${old}\\1(?![\\w-])`, 'g');
      for (const m of document.source.matchAll(mark)) {
        const at = m.index + m[0].length - old.length - (m[1] as string).length;
        if (edits.some((e) => e.pos === at)) continue;
        out.blocked.push({ file: document.file, line: lineAt(at), at, key: old, text: m[0].trim() });
      }
    }
    if (edits.length === 0) continue;
    const text = applyFileEdits(document.source, edits);
    out.edited.push({ rel: document.file, text, diff: formatDiff(document.file, document.source, text) });
  }
  return out;
}

/**
 * A JavaScript host: every file in the managed surfaces, the email surfaces and
 * the copy modules — the generated files and the read path excepted, since the
 * batch writes the first and the second names no key — sorted by
 * `planReadRenames`.
 */
async function readRenames(cwd: string, config: StetConfig, renames: ReadonlyMap<string, string>): Promise<HostRenames> {
  const ts = await loadTypescript();
  const mappings = pathAliasMappings(cwd);
  const own = new Set([config.codegen.registry, config.codegen.dts, config.codegen.defaults, config.readPath.file]);
  const modules = filesForGlobs(cwd, config.copyModules);
  const stetTargets = new Set([config.readPath.file, ...modules].map((rel) => normalizeNoExt(join(cwd, rel))));
  const out: HostRenames = { edited: [], rewritten: [], blocked: [], mentions: [], unparsed: [] };
  const files = filesForGlobs(cwd, [...config.managedSurfaces, ...config.emailSurfaces, ...config.copyModules]);
  for (const rel of files) {
    if (own.has(rel)) continue;
    let source: string;
    try {
      source = readFileSync(join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    const found = planReadRenames({
      ts,
      file: rel,
      source,
      dialect: dialectOf(rel),
      renames,
      isStetModule: (spec) => resolveSpecifier(spec, rel, cwd, mappings).some((target) => stetTargets.has(target)),
      copyModule: config.copyModules.some((glob) => matchGlob(glob, rel)),
    });
    out.rewritten.push(...found.rewritten);
    out.blocked.push(...found.blocked);
    out.mentions.push(...found.mentions);
    out.unparsed.push(...found.unparsed);
    if (found.edits.length > 0) {
      const text = applyFileEdits(source, found.edits);
      out.edited.push({ rel, text, diff: formatDiff(rel, source, text) });
    }
  }
  return out;
}

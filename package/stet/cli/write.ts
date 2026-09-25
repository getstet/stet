/**
 * The write half: `draft`, `publish` (including `--due`) and `seed`.
 *
 * Every write goes through the `StoreAdapter` methods and nothing else — no
 * SQL, no HTTP of the CLI's own (§13.5: the CLI talks to the store through the
 * adapter directly, so a store-backed host with no API mount still has a full
 * write path from the terminal). Attribution is never optional: every write
 * carries an editor, and an empty one is a usage error before anything runs.
 */

import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve as resolvePath } from 'node:path';

import { isNotSupported, isRefusal, isStoreError } from '../adapters/store-shared.js';
import type { StoreRow } from '../src/resolve.js';
import { keyDefOf } from '../src/descriptor.js';
import type { Shape } from '../src/types.js';
import { ENV_OPTION, flag, noPositionals, parse, required, text } from './args.js';
import type { CliIo } from './main.js';
import { stampDescriptorVersion } from './meta.js';
import { loadProject, refuseAbsence, type LoadedProject } from './project.js';
import { CliError, Report, UsageError } from './report.js';
import { validateValue } from './validate.js';

/** The shapes whose values are text. Everything else arrives as JSON. */
const TEXT_SHAPES: readonly Shape[] = ['text', 'richtext', 'media'];

/**
 * `--editor`, or `cli:<os user>`. `userInfo()` throws when the uid has no
 * passwd entry — `docker run -u 1234` is the ordinary case — so the fallback
 * is a name, never a crash. An empty editor is a usage error: §13.5's
 * invariant is that a write without attribution is rejected, and the terminal
 * enforces it like every other surface.
 */
export function resolveEditor(flagValue: string | undefined): string {
  const editor = flagValue ?? `cli:${osUser()}`;
  if (editor.trim() === '') {
    throw new UsageError('--editor cannot be empty: every write records who made it');
  }
  return editor;
}

/**
 * Who the operating system says is running this. Exported because the local
 * dashboard attributes its store writes the same way the terminal does —
 * `dashboard:<os user>` beside `cli:<os user>` — and one reader is what keeps
 * the two spellings of "who" from drifting.
 */
export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

export async function runDraft(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...ENV_OPTION,
    value: 'string',
    'value-file': 'string',
    locale: 'string',
    label: 'string',
    note: 'string',
    'publish-at': 'string',
    editor: 'string',
    force: 'boolean',
  });
  const key = required(positionals, 'draft', 'key');
  const editor = resolveEditor(text(values, 'editor'));
  const locale = text(values, 'locale') ?? 'default';
  const publishAt = stamp(text(values, 'publish-at'));

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    // Own property, never a bare index: the key comes off the command line, and
    // `keys['constructor']` answers with a function from the prototype — which
    // has no `shape`, so the value would reach `shapeSchema` and fall past every
    // switch arm as an uncaught TypeError.
    const def = keyDefOf(project.descriptor, key);
    if (!def) throw new CliError(`"${key}" is not a key in ${project.config.descriptorPath}`);

    const value = parseValue(io, def.shape, key, text(values, 'value'), text(values, 'value-file'));

    // Validate BEFORE any store call, shape first. A value that fails never
    // reaches saveDraft — the store records no call at all.
    const report = new Report();
    report.environment(project.environment.name);
    const ok = validateValue(project.descriptor, project.snapshot, key, value, locale, report);
    if (!ok) return report.emit(io);

    const answer = await project.store.saveDraft({
      key,
      value,
      target: def.target,
      editor,
      locale,
      label: text(values, 'label'),
      note: text(values, 'note'),
      publishAt,
      force: flag(values, 'force'),
    });

    if (isRefusal(answer)) {
      report.error(
        'store',
        `${key}: a draft by ${answer.incumbentEditor} has been held since ${answer.heldSince} — ` +
          'read it first (stet diff) and re-run with --force to replace it',
        key,
      );
    } else if (isNotSupported(answer)) {
      report.error('store', snapshotOnly('draft'), key);
    } else if (isStoreError(answer)) {
      report.error('store', `${key}: ${answer.message}`, key);
    } else {
      report.line(`drafted ${key} (${locale}) as ${editor} — draft ${answer.draftId}`);
    }
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

export async function runPublish(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...ENV_OPTION,
    locale: 'string',
    editor: 'string',
    due: 'boolean',
  });
  const editor = resolveEditor(text(values, 'editor'));
  const env = text(values, 'env');
  if (flag(values, 'due')) {
    noPositionals(positionals, 'publish --due');
    return publishDue(io, editor, env);
  }

  const key = required(positionals, 'publish', 'key');
  const locale = text(values, 'locale') ?? 'default';
  const project = await loadProject(io, { env });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    // Own property: a bare `in` lets `publish constructor` past the gate and
    // issues a real RPC for a key the descriptor never declared.
    if (!Object.hasOwn(project.descriptor.keys, key)) {
      throw new CliError(`"${key}" is not a key in ${project.config.descriptorPath}`);
    }

    const answer = await project.store.publish({ key, editor, locale });
    if (isNotSupported(answer)) report.error('store', snapshotOnly('publish'), key);
    else if (isStoreError(answer)) report.error('store', `${key}: ${answer.message}`, key);
    else report.line(`published ${key} (${locale}) as ${editor} — version ${answer.versionId}`);
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

/**
 * The clock's leg of the one publish path (§4). Due drafts are enumerated
 * through `read({preview: true})` — the stamp rides the row, so no second
 * query surface exists — and each publishes through the same RPC a click or an
 * agent would call.
 *
 * The inherited TOCTOU seam, stated: the RPC publishes the key's CURRENT
 * draft, so an edit landing between this enumeration and the publish ships the
 * edited value.
 */
async function publishDue(io: CliIo, editor: string, env: string | undefined): Promise<number> {
  const project = await loadProject(io, { env });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    const answer = await project.readRows({ preview: true });
    // A compare-read: due-publishing against an absent store would publish
    // nothing and report success.
    refuseAbsence(answer, 'publish --due');

    const now = Date.now();
    const due = answer.rows.filter(
      (row) =>
        row.status === 'draft' &&
        row.publishAt !== null &&
        row.publishAt !== undefined &&
        Date.parse(row.publishAt) <= now,
    );

    // Split by the row's own membership — the stamp and the change ref both
    // ride the read, so there is still no second query surface.
    const ungrouped = due.filter((row) => row.changesetId === null || row.changesetId === undefined);
    const grouped = due.filter((row) => row.changesetId !== null && row.changesetId !== undefined);

    let published = 0;
    for (const row of ungrouped) {
      // The descriptor gate every other publish path has — the interactive one
      // above, the mount's own. A due draft whose key has left the descriptor is
      // skipped rather than published silently, at ERROR level like the leg's
      // other per-row failures: the exit goes nonzero so the clock's caller sees
      // the anomaly, and the loop continues so one skip strands nothing.
      if (!Object.hasOwn(project.descriptor.keys, row.key)) {
        report.error(
          'config',
          `${row.key} (${row.locale}): due draft skipped — the key is no longer in the descriptor; ` +
            'restore the key or discard the draft',
          row.key,
        );
        continue;
      }
      const result = await project.store.publish({ key: row.key, editor, locale: row.locale });
      // One failure does not strand the rest: a clock run publishes what it can
      // and reports what it could not.
      if (isNotSupported(result)) report.error('store', snapshotOnly('publish'), row.key);
      else if (isStoreError(result)) report.error('store', `${row.key} (${row.locale}): ${result.message}`, row.key);
      else {
        published += 1;
        report.line(`published ${row.key} (${row.locale}) — version ${result.versionId}, due ${row.publishAt}`);
      }
    }

    published += await publishDueChanges(project, editor, grouped, report);
    const demoted = await demoteEmptyChanges(project, due, now, report);

    // All three counts, so a run that published nothing but demoted something
    // still says what it did. The demotion sweep runs even with nothing due —
    // a change whose members were all discarded is exactly the case it exists
    // for, and it has no due member by definition.
    // "published FROM due", not "N of M": a torn-schedule change can flip more
    // members than there were due drafts, and `2 of 1 due drafts published`
    // reads as a bug in the counter rather than the state it is reporting.
    const tail = demoted === 0 ? '' : `, ${demoted} scheduled change(s) demoted`;
    report.line(
      due.length === 0
        ? `0 due${tail}`
        : `${published} published from ${due.length} due draft(s)${tail}`,
    );
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

/**
 * The grouped leg: due member drafts publish through their CHANGE, once per
 * distinct change and atomically, never one key at a time. A member conflict
 * leaves the whole change scheduled to retry whole on the next run.
 */
async function publishDueChanges(
  project: LoadedProject,
  editor: string,
  grouped: StoreRow[],
  report: Report,
): Promise<number> {
  let published = 0;
  const changeIds = [...new Set(grouped.map((row) => row.changesetId as number))];
  for (const changeId of changeIds) {
    const found = await project.store.changesets.get({ changeId });
    // Grouping requires the capability, so a store with due grouped drafts
    // cannot lack it — handled as the standard store path anyway.
    if (isNotSupported(found)) {
      report.error('store', snapshotOnly('publish'), String(changeId));
      continue;
    }
    if (isStoreError(found)) {
      report.error('store', `change ${changeId}: ${found.message}`, String(changeId));
      continue;
    }
    const { change } = found;
    if (change.status !== 'scheduled') {
      // Residue: a due-stamped member inside a change nobody scheduled. Never
      // solo-published — that would publish a member out of its group — and
      // never silently skipped either.
      for (const row of grouped.filter((r) => r.changesetId === changeId)) {
        report.line(
          `${row.key} (${row.locale}) is grouped in ${change.status} change "${change.name}" — ` +
            'schedule or publish the change',
        );
      }
      continue;
    }

    const flipped = await project.store.changesets.publishChange({ changeId, editor });
    if (isNotSupported(flipped)) {
      report.error('store', snapshotOnly('publish'), String(changeId));
      continue;
    }
    if (isStoreError(flipped)) {
      // The RPC's raise already names the failing key. Nothing published, the
      // change stays scheduled, and the next run retries it whole.
      report.error(
        'store',
        `change "${change.name}" held: ${flipped.message} — retries next run`,
        String(changeId),
      );
      continue;
    }
    for (const member of flipped.published) {
      published += 1;
      report.line(
        `published ${member.key} (${member.locale}) — version ${member.versionId}, change "${change.name}"`,
      );
    }
  }
  return published;
}

/**
 * The demotion sweep: a scheduled change whose stamp has passed but which has
 * no due member left — its members were solo-published away, discarded, or a
 * torn schedule never stamped them. Demoted to open and REPORTED, so it is
 * never a silent skip and never a phantom retry every minute forever.
 *
 * The demotion reuses the cancel path (`schedule` with a null stamp) — one
 * mechanism, two callers: the operator's cancel and this.
 */
async function demoteEmptyChanges(
  project: LoadedProject,
  due: StoreRow[],
  now: number,
  report: Report,
): Promise<number> {
  const dueChangeIds = new Set(
    due.map((row) => row.changesetId).filter((id): id is number => id !== null && id !== undefined),
  );
  let demoted = 0;
  // Keyset paging: a single call caps at PAGE_DEFAULT and would silently leave
  // the rest of a long backlog un-demoted, retrying forever.
  let beforeId: number | undefined;
  for (;;) {
    const page = await project.store.changesets.list({ status: 'scheduled', beforeId });
    // Reached on every snapshot-only `publish --due` run: that store answers
    // rows (zero of them) rather than going down, so the command proceeds this
    // far and the capability refuses here. Silent on purpose — a store with no
    // changesets has no scheduled change to demote, and reporting it would fail
    // a run that had nothing to do.
    if (isNotSupported(page)) return demoted;
    if (isStoreError(page)) {
      report.error('store', `listing scheduled changes: ${page.message}`);
      return demoted;
    }
    for (const change of page.changes) {
      if (change.publishAt === null || Date.parse(change.publishAt) > now) continue;
      if (dueChangeIds.has(change.id)) continue;
      const cancelled = await project.store.changesets.schedule({ changeId: change.id, publishAt: null });
      if (isNotSupported(cancelled) || isStoreError(cancelled)) {
        report.error(
          'store',
          `demoting change "${change.name}": ${isStoreError(cancelled) ? cancelled.message : 'not supported'}`,
          String(change.id),
        );
        continue;
      }
      demoted += 1;
      report.line(`demoted "${change.name}" to open — nothing left to publish`);
    }
    if (page.nextBeforeId === null) return demoted;
    beforeId = page.nextBeforeId;
  }
}

export async function runSeed(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION });
  noPositionals(positionals, 'seed');
  const project = await loadProject(io, { env: text(values, 'env') });
  try {
      const report = new Report();
      report.environment(project.environment.name);
      await seed(io, project, report);
      return report.emit(io);
  } finally {
    await project.dispose();
  }
}

interface SeedTotals {
  seeded: number;
  recovered: number;
  skippedHistory: number;
  skippedForeignDraft: number;
  skippedDerived: number;
}

/**
 * Every non-derived descriptor key × the default locale, written as version 1
 * through saveDraft → publish with editor `stet:seed` — no new write path, so
 * every integrity guarantee the RPCs make holds here too (§13.6 C).
 *
 * Derived keys are skipped: a derived key has no snapshot value by design, and
 * `saveDraft(undefined)` would raise at the database. The completeness check
 * skips them for the same reason.
 *
 * Ownership is decided by the REFUSAL, not by inspection: the interface
 * exposes no draft author — `StoreRow` carries none — so the non-forced save
 * IS the test. Refused means another editor's work (skip and report, never
 * force); accepted means the draft was absent or `stet:seed`'s own, and gets
 * published. One code path serves a fresh seed and the repair of a crashed one.
 *
 * Shared with `stet upgrade --store`, which seeds as its last step.
 */
export async function seed(
  io: CliIo,
  project: LoadedProject,
  report: Report,
  opts: { stamp?: boolean } = {},
): Promise<void> {
  const answer = await project.readRows({ preview: true });
  refuseAbsence(answer, 'seed');

  const totals: SeedTotals = {
    seeded: 0,
    recovered: 0,
    skippedHistory: 0,
    skippedForeignDraft: 0,
    skippedDerived: 0,
  };
  const locale = project.config.locales.default;
  const committed = project.snapshot[locale] ?? {};

  for (const key of Object.keys(project.descriptor.keys).sort()) {
    const def = project.descriptor.keys[key];
    if (!def) continue;
    if (def.derivesFrom !== undefined) {
      totals.skippedDerived += 1;
      continue;
    }

    // Re-read this key immediately before writing it. The upfront read is the
    // reachability gate and the picture; a run of any length would act on a
    // picture that has aged, and the model is key×locale — a key holding rows
    // only in another locale still needs its default seeded, so the skip is
    // judged at the default locale alone.
    const fresh = await project.readRows({ keys: [key], locale, preview: true });
    refuseAbsence(fresh, 'seed');
    // `read({locale})` hands back the fallback CHAIN, by contract — the rows a
    // resolution at this locale may reach — so the rows are narrowed to the one
    // locale being judged before the skip is decided.
    const rows = fresh.rows.filter((r) => r.key === key && r.locale === locale);
    if (rows.some((r) => r.status !== 'draft')) {
      totals.skippedHistory += 1;
      report.line(`skip ${key} — already has history`);
      continue;
    }

    const value = committed[key];
    if (value === undefined) {
      report.error('config', `${key}: no snapshot value to seed — run stet check`, key);
      continue;
    }

    const crashed = rows.some((r) => r.status === 'draft');
    const saved = await project.store.saveDraft({
      key,
      value,
      target: def.target,
      editor: 'stet:seed',
      locale,
      force: false,
    });

    if (isRefusal(saved)) {
      totals.skippedForeignDraft += 1;
      report.line(`skip ${key} — a draft by ${saved.incumbentEditor} is open since ${saved.heldSince}`);
      continue;
    }
    if (isNotSupported(saved)) {
      report.error('store', snapshotOnly('seed'), key);
      return;
    }
    if (isStoreError(saved)) {
      report.error('store', `${key}: ${saved.message}`, key);
      continue;
    }

    const published = await project.store.publish({ key, editor: 'stet:seed', locale });
    if (isNotSupported(published)) {
      report.error('store', snapshotOnly('seed'), key);
      return;
    }
    if (isStoreError(published)) {
      report.error('store', `${key}: ${published.message}`, key);
      continue;
    }
    if (crashed) totals.recovered += 1;
    else totals.seeded += 1;
  }

  // `upgrade` stamps with its apply and passes `stamp: false`, so the operator
  // reads one descriptor_version line per command, not two.
  if (opts.stamp !== false && totals.seeded + totals.recovered > 0) {
    const stamped = await stampDescriptorVersion(
      project.config,
      io.env,
      String(project.descriptor.version),
      project.environment.name,
      io.fetchImpl,
    );
    report.line(
      stamped === 'unsupported'
        ? 'descriptor_version: not stamped (adapter has no stet_meta)'
        : `descriptor_version: ${stamped} (${project.descriptor.version})`,
    );
  }

  report.line(
    `seeded ${totals.seeded} · recovered ${totals.recovered} · skipped ${totals.skippedHistory} with history, ` +
      `${totals.skippedForeignDraft} held by another editor, ${totals.skippedDerived} derived`,
  );
  report.data('totals', totals);
}

/**
 * A value arrives shape-directed, never JSON-first. `--value 16` on a text key
 * would parse as the number 16, pass every save check (they skip non-strings)
 * and quarantine at read time behind a successful save — a failure the
 * operator sees days later on the page, not at the terminal.
 */
function parseValue(
  io: CliIo,
  shape: Shape,
  key: string,
  inline: string | undefined,
  file: string | undefined,
): unknown {
  if (inline !== undefined && file !== undefined) {
    throw new UsageError('--value and --value-file are alternatives, not a pair');
  }
  let raw: string;
  if (inline !== undefined) raw = inline;
  else if (file !== undefined) {
    try {
      // `resolve`, not `join`: an absolute path is the operator's own and must
      // not be re-rooted under the project directory.
      raw = readFileSync(resolvePath(io.cwd, file), 'utf8');
    } catch {
      throw new CliError(`cannot read --value-file ${file}`);
    }
  } else {
    throw new UsageError(`stet draft ${key} needs --value=… or --value-file <path>`);
  }

  // A text-shaped key takes the string exactly as given, newlines and all.
  if (TEXT_SHAPES.includes(shape)) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new UsageError(
      `${key} declares shape: ${shape}, so its value must be JSON — got ${JSON.stringify(raw.slice(0, 40))}`,
    );
  }
}

/** An unparseable `--publish-at` is a usage mistake, caught before the write. */
/**
 * The schedule stamp, NORMALIZED to an ISO instant rather than passed through.
 * `Date.parse` accepts far more than ISO — `"1"` parses as the year 2001, so a
 * typo would schedule a publish in the past and the clock would fire it on its
 * next run — and an ambiguous form like `"03/04/2026"` is month-first here but
 * reads differently to Postgres under another DateStyle. Storing the resolved
 * instant means every reader agrees on which moment was meant.
 */
function stamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    throw new UsageError(`--publish-at must be an ISO timestamp, got ${JSON.stringify(value)}`);
  }
  return new Date(at).toISOString();
}

function snapshotOnly(what: string): string {
  return (
    `this project is snapshot-only, so ${what} has nothing to write to — ` +
    'the edit path is the committed snapshot file plus a commit (publish = commit). ' +
    'Add a store block to stet.config.json to get drafts, versions and history'
  );
}

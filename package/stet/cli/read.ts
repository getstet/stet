/**
 * The read half of the terminal surface: `list`, `get`, `diff`.
 *
 * All three resolve through `content-read`'s one path — `resolve` over the
 * store's rows and the committed snapshot, and the exported `activeRow` where
 * a version id is wanted. Nothing here re-derives which row is live.
 *
 * `list` and `get` read to RENDER, so an unreachable store degrades to the
 * snapshot with a warning and exit 0. `diff` reads to COMPARE, so the same
 * absence is a failure: a diff against nothing reports nonsense.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { activeRow, localeChain, resolve, type StoreRow } from '../src/resolve.js';
import { ENV_OPTION, flag, noPositionals, parse, required, text } from './args.js';
import { keyUsage, type KeyUsage, type UsageState } from './key-usage.js';
import type { CliIo } from './main.js';
import { loadProject, refuseAbsence, type LoadedProject } from './project.js';
import { CliError, Report } from './report.js';
import { loadStatus, statusOf, type KeyStatus, type StatusFile } from './status.js';
import { isStoreBacked } from './store.js';

interface ListRow {
  key: string;
  source: string;
  version: number | null;
  draft: boolean;
  /** `--json` only: what the unread-key scan says of a judged key. */
  badge?: UsageState;
  /** A snapshot-only project whose status file exists: the key's approval. */
  status?: KeyStatus;
}

export async function runList(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION, locale: 'string', json: 'boolean' });
  noPositionals(positionals, 'list');
  const locale = text(values, 'locale') ?? 'default';

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    const answer = await project.readRows({ preview: true, locale });
    // A render-read: absence, not failure. Every key still answers, from the
    // committed snapshot, and the exit code stays 0.
    if (answer.storeDown) {
      report.warn('store', `the configured store was unreachable — resolving from the snapshot (${answer.message ?? 'unreachable'})`);
    }

    // The unread-key scan, under --json alone: the text output stays as it was.
    // Without the compiler the rows carry no badge and `usage` is null.
    const json = flag(values, 'json');
    let usage: KeyUsage | null = null;
    if (json) {
      try {
        usage = await keyUsage(io.cwd, project.config, project.descriptor);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        report.warn('scan', error.message);
      }
    }

    // The status column belongs to a snapshot-only project that tracks approval: its file exists.
    // A checkout reading its copy from another shows the owner's.
    const forms = project.owner ?? { path: io.cwd, config: project.config };
    const approvals: StatusFile | null =
      !isStoreBacked(project.environment.block) && existsSync(join(forms.path, forms.config.statusPath)) ? loadStatus(forms.path, forms.config) : null;

    const rows: ListRow[] = [];
    for (const key of Object.keys(project.descriptor.keys).sort()) {
      const resolution = resolve(project.descriptor, project.snapshot, answer.rows, { key, locale });
      const candidates = answer.rows.filter((r) => r.key === key);
      const live = firstActive(candidates, locale);
      rows.push({
        key,
        source: resolution.source,
        version: live?.version ?? null,
        draft: candidates.some((r) => r.status === 'draft' && localeChain(locale).includes(r.locale)),
        ...(usage !== null && Object.hasOwn(usage.keys, key) ? { badge: usage.keys[key]?.state } : {}),
        ...(approvals === null ? {} : { status: statusOf(approvals, key) }),
      });
    }

    const width = rows.reduce((w, r) => Math.max(w, r.key.length), 0);
    const tracked = approvals !== null;
    report.line(`${'key'.padEnd(width)}  source    version  ${tracked ? 'draft  ' : 'draft'}${tracked ? '  status' : ''}`);
    for (const row of rows) {
      const draft = row.draft ? 'pending' : '—';
      const approval = row.status === undefined ? '' : row.status.status === 'approved' ? `approved${row.status.at ? ` ${row.status.at}` : ''}` : 'proposed';
      report.line(
        `${row.key.padEnd(width)}  ${row.source.padEnd(8)}  ${String(row.version ?? '—').padStart(7)}  ${
          tracked ? `${draft.padEnd(7)}  ${approval}` : draft
        }`,
      );
    }
    report.data('locale', locale);
    report.data('rows', rows);
    if (json) {
      report.data('usage', usage === null ? null : { prefixes: usage.prefixes, causes: usage.causes, files: usage.files, root: usage.root });
    }
    return report.emit(io, { json });
  } finally {
    await project.dispose();
  }
}

export async function runGet(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION, locale: 'string', json: 'boolean' });
  const key = required(positionals, 'get', 'key');
  const locale = text(values, 'locale') ?? 'default';

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    known(project, key);

    const answer = await project.readRows({ keys: [key], locale });
    if (answer.storeDown) {
      report.warn('store', `the configured store was unreachable — resolving from the snapshot (${answer.message ?? 'unreachable'})`);
    }

    const resolution = resolve(project.descriptor, project.snapshot, answer.rows, { key, locale });
    for (const warning of resolution.warnings) {
      report.warn('config', `${warning.key} (${warning.locale}): ${warning.reason}`, warning.key);
    }
    if (resolution.value === undefined) {
      report.error('config', `${key}: no stored, derived or committed value in ${locale}`, key);
    } else {
      report.line(print(resolution.value));
    }

    report.data('key', key);
    report.data('locale', locale);
    report.data('source', resolution.source);
    report.data('value', resolution.value ?? null);
    return report.emit(io, { json: flag(values, 'json') });
  } finally {
    await project.dispose();
  }
}

export async function runDiff(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION, locale: 'string' });
  const key = required(positionals, 'diff', 'key');
  const locale = text(values, 'locale') ?? 'default';

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    known(project, key);

    const answer = await project.readRows({ keys: [key], locale, preview: true });
    // A compare-read: a diff against absence would report every value as new.
    refuseAbsence(answer, 'diff');

    const chain = localeChain(locale);
    const draft = answer.rows.find(
      (r) => r.key === key && r.status === 'draft' && chain.includes(r.locale),
    );
    // The active value resolves without preview, so a pending draft cannot
    // stand in for it.
    const active = resolve(project.descriptor, project.snapshot, answer.rows, { key, locale });

    report.line(`${key} (${locale})`);
    report.line(`  active [${active.source}]: ${print(active.value)}`);
    report.line(draft === undefined ? '  draft: none' : `  draft: ${print(draft.value)}`);
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

/** The active row for a locale, walking the same chain resolution walks. */
function firstActive(candidates: StoreRow[], locale: string): StoreRow | undefined {
  for (const loc of localeChain(locale)) {
    const row = activeRow(candidates, loc);
    if (row) return row;
  }
  return undefined;
}

/**
 * The key is DECLARED — tested by own property, because the name arrives off
 * the command line and a JSON-parsed map answers `constructor` from the
 * prototype. Serves `get` and `diff` both.
 */
function known(project: LoadedProject, key: string): void {
  if (!Object.hasOwn(project.descriptor.keys, key)) {
    throw new CliError(`"${key}" is not a key in ${project.config.descriptorPath}`);
  }
}

/** A string prints as itself; every other shape prints as JSON. */
export function print(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

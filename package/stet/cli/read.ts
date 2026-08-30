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

import { activeRow, localeChain, resolve, type StoreRow } from '../src/resolve.js';
import { ENV_OPTION, flag, noPositionals, parse, required, text } from './args.js';
import type { CliIo } from './main.js';
import { loadProject, refuseAbsence, type LoadedProject } from './project.js';
import { CliError, Report } from './report.js';

interface ListRow {
  key: string;
  source: string;
  version: number | null;
  draft: boolean;
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
      });
    }

    const width = rows.reduce((w, r) => Math.max(w, r.key.length), 0);
    report.line(`${'key'.padEnd(width)}  source    version  draft`);
    for (const row of rows) {
      report.line(
        `${row.key.padEnd(width)}  ${row.source.padEnd(8)}  ${String(row.version ?? '—').padStart(7)}  ${
          row.draft ? 'pending' : '—'
        }`,
      );
    }
    report.data('locale', locale);
    report.data('rows', rows);
    return report.emit(io, { json: flag(values, 'json') });
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

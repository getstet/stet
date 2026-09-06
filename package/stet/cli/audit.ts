/**
 * `stet audit` — the descriptor against the store's rows, at release time.
 *
 * Three findings (§5's table): a registered key with no row, a row whose key
 * the descriptor no longer declares, and a stored `target` that has drifted
 * from the descriptor's. Reported, never repaired — an orphan row holds the
 * history of copy that was live once, and deleting it to make a report clean
 * is not a trade anyone asked for.
 *
 * Exit 0 by default: this is a report an operator reads, not a gate. `--strict`
 * is the gate, for a release script that wants one.
 */

import { ENV_OPTION, flag, noPositionals, parse, text } from './args.js';
import type { CliIo } from './main.js';
import { loadProject, refuseAbsence } from './project.js';
import { plural, Report } from './report.js';

export async function runAudit(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION, strict: 'boolean', json: 'boolean' });
  noPositionals(positionals, 'audit');

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    const answer = await project.readRows({ preview: true });
    // A compare-read: an audit against absence would report every key as
    // unseeded and every orphan as gone.
    refuseAbsence(answer, 'audit');

    const declared = project.descriptor.keys;
    const rows = answer.rows;

    // The finding is judged at the DEFAULT locale, which is what `stet seed`
    // writes: a key holding rows only in `de` is still unwritable at default,
    // and a key-scoped check would call that clean.
    const defaultLocale = project.config.locales.default;
    const noRow: string[] = [];
    for (const key of Object.keys(declared).sort()) {
      // A derived key has no row BY DESIGN — it computes from another key's
      // value, and `stet seed` skips it for exactly that reason. Reporting it
      // here would be advice nobody can take, on a report that could then never
      // go clean.
      if (declared[key]?.derivesFrom !== undefined) continue;
      if (!rows.some((r) => r.key === key && r.locale === defaultLocale)) {
        noRow.push(key);
        report.warn(
          'config',
          `${key}: registered, not yet editable at ${defaultLocale}; run \`stet seed\``,
          key,
        );
      }
    }

    // Own property: a row keyed `constructor` answers a bare `in` from the
    // prototype and vanishes from the report entirely — the one finding kind
    // whose whole job is to name rows the descriptor no longer declares.
    const orphans = [...new Set(rows.filter((r) => !Object.hasOwn(declared, r.key)).map((r) => r.key))].sort();
    for (const key of orphans) {
      report.warn('config', `${key}: in the store, not in the descriptor — an orphan, reported never deleted`, key);
    }

    const drift: { key: string; stored: string; declared: string }[] = [];
    for (const row of rows) {
      const target = declared[row.key]?.target;
      if (target === undefined || row.target === undefined || row.target === target) continue;
      drift.push({ key: row.key, stored: row.target, declared: target });
      report.warn(
        'config',
        `${row.key} (${row.locale}): stored target ${row.target} has drifted from the descriptor's ${target}`,
        row.key,
      );
    }

    report.line(
      `audit: ${noRow.length} unseeded · ${plural(orphans.length, 'orphan')} · ${drift.length} target drift`,
    );
    report.data('unseeded', noRow);
    report.data('orphans', orphans);
    report.data('drift', drift);

    // The flag promotes; nothing else about the report changes, so a strict run
    // and a plain one report identically and differ only in their exit code.
    if (flag(values, 'strict')) report.promoteWarnings();
    return report.emit(io, { json: flag(values, 'json') });
  } finally {
    await project.dispose();
  }
}

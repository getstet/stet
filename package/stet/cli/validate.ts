/**
 * One value against its key's declared rules, reported.
 *
 * `check` runs it over every committed value, and `draft` runs it over the
 * incoming one before any store call. The rules themselves are
 * `src/value-check.ts`, shared with the mounted API.
 */

import type { StoreRow } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { checkValue } from '../src/value-check.js';
import { Report, type FindingLocation } from './report.js';

/**
 * A value checked for a key that has no name yet: declared under `placeholder`
 * with `def` — and held in the snapshot as `stored`, where it holds one — so the
 * gate reads the key's own rules, and each finding reported with the
 * placeholder replaced by `name`. The placeholder stays declared where the
 * value passes and `keep` asks, and is taken back out otherwise. The one gate
 * `register`'s JSX pass and the static-HTML host's mint share.
 */
export function validateUnnamed(d: {
  descriptor: Descriptor;
  snapshot: Snapshot;
  placeholder: string;
  def: KeyDef;
  stored: unknown;
  value: unknown;
  report: Report;
  name: string;
  at?: FindingLocation;
  keep: boolean;
}): boolean {
  const { descriptor, snapshot, placeholder, report } = d;
  descriptor.keys[placeholder] = d.def;
  if (d.stored !== null) (snapshot['default'] ??= {})[placeholder] = d.stored;
  const gate = new Report();
  const passed = validateValue(descriptor, snapshot, placeholder, d.value, 'default', gate);
  for (const finding of gate.findings) {
    const message = finding.message.split(placeholder).join(d.name);
    if (finding.level === 'error') report.error(finding.kind, message, undefined, d.at);
    else report.warn(finding.kind, message, undefined, d.at);
  }
  if (!passed || !d.keep) {
    delete descriptor.keys[placeholder];
    delete snapshot['default']?.[placeholder];
  }
  return passed;
}

/**
 * One value checked and reported: the findings of `checkValue`, the one gate
 * every save surface shares, land in the report at their own level.
 *
 * Answers whether the value may be saved: warnings are reported and do not
 * block, errors are reported and do. `rows` are the store's rows read for
 * preview, for a stored draft judged with its siblings' drafts in scope.
 */
export function validateValue(
  descriptor: Descriptor,
  snapshot: Snapshot,
  key: string,
  value: unknown,
  locale: string,
  report: Report,
  rows?: StoreRow[],
): boolean {
  const verdict = checkValue(descriptor, snapshot, key, value, locale, rows);
  for (const finding of verdict.findings) {
    if (finding.level === 'error') report.error(finding.kind, finding.message, finding.key);
    else report.warn(finding.kind, finding.message, finding.key);
  }
  return verdict.ok;
}

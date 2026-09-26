/**
 * One value against its key's declared rules, reported.
 *
 * Two consumers, so it lives in one place: `check` runs it over every
 * committed value, and `draft` runs it over the incoming one before any store
 * call. Both need the same two steps in the same order, and both would get the
 * class gate wrong the same way without the sibling slots.
 */

import { resolve } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { shapeSchema, templateOf, validateSave } from '../src/validate.js';
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
 * The shape check FIRST and separately: `validateSave`'s rules read a value
 * through the key's DECLARED shape, so a value of the wrong shape offers them
 * nothing to check. A list stored where text was declared yields no strings to
 * limit and no string to estimate, passes every save rule, and would save
 * cleanly to quarantine at read time — on the page, days later, instead of
 * here.
 *
 * Answers whether the value may be saved: warnings are reported and do not
 * block, errors are reported and do.
 */
export function validateValue(
  descriptor: Descriptor,
  snapshot: Snapshot,
  key: string,
  value: unknown,
  locale: string,
  report: Report,
): boolean {
  const shape = shapeSchema(descriptor, key).safeParse(value);
  if (!shape.success) {
    report.error(
      'shape',
      `${key} (${locale}): fails the declared ${descriptor.keys[key]?.shape} shape — ${
        shape.error.issues[0]?.message ?? 'invalid'
      }`,
      key,
    );
    return false;
  }

  const verdict = validateSave(
    descriptor,
    { key, value, locale },
    siblingsOf(descriptor, snapshot, key, locale),
  );
  for (const finding of verdict.findings) {
    const message = `${finding.message} (${locale})`;
    if (finding.severity === 'error') report.error(finding.rule, message, finding.key);
    else report.warn(finding.rule, message, finding.key);
  }
  return verdict.ok;
}

/**
 * The scope the class gate sees: the template's other slot values, so a subject
 * checked alone does not report a missing `{{unsubscribe_url}}` that the body
 * is carrying, plus the brand's postal line, which the marketing class rule
 * reads the same way. Both are resolved through the same read rule.
 *
 * A key that belongs to no template has no siblings, and `validateSave` merges
 * the candidate in itself.
 */
function siblingsOf(
  descriptor: Descriptor,
  snapshot: Snapshot,
  key: string,
  locale: string,
): Record<string, unknown> {
  const template = templateOf(descriptor, key);
  if (template === null) return {};
  const siblings: Record<string, unknown> = {};
  for (const slot of descriptor.templates?.[template]?.slots ?? []) {
    const slotKey = `${template}__${slot}`;
    siblings[slotKey] = resolve(descriptor, snapshot, null, { key: slotKey, locale }).value;
  }
  siblings['brand__footer_address'] = resolve(descriptor, snapshot, null, {
    key: 'brand__footer_address',
    locale,
  }).value;
  return siblings;
}

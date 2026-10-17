/**
 * One value against its key's declared rules, as findings.
 *
 * The one gate every surface that accepts a value runs: the CLI's `draft` and
 * `check`, the local dashboard's save, and the mounted API's draft and publish
 * routes. It answers in plain findings so each surface reports them its own way
 * and none keeps a second rule set.
 */

import { resolve, type StoreRow } from './resolve.js';
import type { Snapshot } from './snapshot.js';
import type { Descriptor } from './types.js';
import { shapeSchema, templateOf, validateSave, type FindingRule } from './validate.js';

export interface ValueFinding {
  level: 'error' | 'warn';
  kind: 'shape' | FindingRule;
  message: string;
  key: string;
}

export interface ValueVerdict {
  /** Whether the value may be saved: warnings are reported and do not block, errors do. */
  ok: boolean;
  findings: ValueFinding[];
}

/**
 * The shape check FIRST and separately: `validateSave`'s rules read a value
 * through the key's DECLARED shape, so a value of the wrong shape offers them
 * nothing to check. A list stored where text was declared yields no strings to
 * limit and no string to estimate, passes every save rule, and would save
 * cleanly to quarantine at read time — on the page, days later, instead of
 * here.
 *
 * `rows` are the store's rows read for preview: the siblings then resolve
 * through the drafts a store holds, as the publish would. Omitted, they resolve
 * through the snapshot alone.
 */
export function checkValue(
  descriptor: Descriptor,
  snapshot: Snapshot,
  key: string,
  value: unknown,
  locale: string,
  rows?: StoreRow[],
): ValueVerdict {
  const shape = shapeSchema(descriptor, key).safeParse(value);
  if (!shape.success) {
    return {
      ok: false,
      findings: [
        {
          level: 'error',
          kind: 'shape',
          message: `${key} (${locale}): fails the declared ${descriptor.keys[key]?.shape} shape — ${
            shape.error.issues[0]?.message ?? 'invalid'
          }`,
          key,
        },
      ],
    };
  }

  const verdict = validateSave(
    descriptor,
    { key, value, locale },
    siblingsOf(descriptor, snapshot, key, locale, rows),
  );
  return {
    ok: verdict.ok,
    findings: verdict.findings.map((finding) => ({
      level: finding.severity === 'error' ? 'error' : 'warn',
      kind: finding.rule,
      message: `${finding.message} (${locale})`,
      key: finding.key,
    })),
  };
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
  rows: StoreRow[] | undefined,
): Record<string, unknown> {
  const template = templateOf(descriptor, key);
  if (template === null) return {};
  const read = (slotKey: string): unknown =>
    resolve(descriptor, snapshot, rows ?? null, { key: slotKey, locale, preview: rows !== undefined }).value;
  const siblings: Record<string, unknown> = {};
  for (const slot of descriptor.templates?.[template]?.slots ?? []) {
    const slotKey = `${template}__${slot}`;
    siblings[slotKey] = read(slotKey);
  }
  siblings['brand__footer_address'] = read('brand__footer_address');
  return siblings;
}

/**
 * The store keys a check of `keys` reads: the keys themselves, and for a
 * template slot the template's other slots and the brand's postal line, which
 * `siblingsOf` resolves. A read narrowed to these answers the check exactly.
 * A key that belongs to no template needs no rows beyond its own.
 */
export function scopeKeys(descriptor: Descriptor, keys: string[]): string[] {
  const scope = new Set(keys);
  for (const key of keys) {
    const template = templateOf(descriptor, key);
    if (template === null) continue;
    for (const slot of descriptor.templates?.[template]?.slots ?? []) scope.add(`${template}__${slot}`);
    scope.add('brand__footer_address');
  }
  return [...scope];
}

/**
 * The rows as they will stand once `ships` have published: every active row,
 * and of the drafts only those being shipped. A publish judged against drafts
 * it does not ship would pass a slot on the strength of a sibling that never
 * goes live.
 */
export function shippedScope(rows: StoreRow[], ships: Array<{ key: string; locale: string }>): StoreRow[] {
  return rows.filter(
    (row) => row.status !== 'draft' || ships.some((s) => s.key === row.key && s.locale === row.locale),
  );
}

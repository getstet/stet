import type { Descriptor, Warning } from './types.js';

/**
 * The committed snapshot: loading, the descriptor-vs-snapshot currency check,
 * and the smells. Types are its only import.
 */

/**
 * The committed values, per locale. `default` is required and is the only
 * locale v1 populates; the rest of the chain is dormant schema-honoring
 * behavior (locale is part of key identity and cannot be retrofitted).
 */
export type Snapshot = Record<string, Record<string, unknown>>;

/**
 * Structural load only. A value whose shape is wrong is not rejected here —
 * quarantine happens at read time, so a bad committed value degrades one key
 * rather than taking down every read.
 */
export function loadSnapshot(raw: unknown): Snapshot {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('snapshot must be an object keyed by locale');
  }
  const snapshot = raw as Record<string, unknown>;
  for (const [locale, values] of Object.entries(snapshot)) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error(`snapshot locale "${locale}" must be an object keyed by content key`);
    }
  }
  if (!('default' in snapshot)) {
    throw new Error('snapshot must carry the "default" locale');
  }
  return snapshot as Snapshot;
}

export interface CurrencyReport {
  /** Non-derived descriptor keys with no `default`-locale value — failures. */
  missing: string[];
  /** Snapshot keys the descriptor no longer declares — reported, never deleted. */
  orphans: string[];
  warnings: Warning[];
}

/**
 * Descriptor against snapshot, both directions, as OWN properties of each map.
 *
 * Both maps are JSON-parsed, so a bare `in` answers from the prototype: a
 * descriptor key named `constructor` with no snapshot row read as present, and
 * a snapshot `constructor` row with no descriptor entry read as declared.
 */
export function checkCurrency(d: Descriptor, s: Snapshot): CurrencyReport {
  const defaults = s['default'] ?? {};
  const missing = Object.keys(d.keys)
    .filter((key) => d.keys[key]?.derivesFrom === undefined)
    .filter((key) => !Object.hasOwn(defaults, key))
    .sort();

  const seen = new Set<string>();
  for (const values of Object.values(s)) for (const key of Object.keys(values)) seen.add(key);
  const orphans = [...seen].filter((key) => !Object.hasOwn(d.keys, key)).sort();

  return { missing, orphans, warnings: snapshotSmells(s) };
}

const CONTACT_FIELDS = ['email', 'consent', 'phone'];

/**
 * People never enter the snapshot. Exclusion is by construction — nothing but
 * descriptor-declared content has a path into the artifact — so this is a smell
 * report on what is already committed, never a block. It fires only on a record
 * carrying TWO OR MORE contact markers (operator, 2026-08-18): a labels record
 * legitimately holds an `email` field, so one marker is site copy — two reads
 * as a person. A smell check that cries wolf gets ignored.
 */
export function snapshotSmells(s: Snapshot): Warning[] {
  const warnings: Warning[] = [];
  for (const locale of Object.keys(s).sort()) {
    const values = s[locale] ?? {};
    for (const key of Object.keys(values).sort()) {
      const value = values[key];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const fields = CONTACT_FIELDS.filter((f) => f in (value as Record<string, unknown>));
      if (fields.length >= 2) {
        warnings.push({
          code: 'contact_record_smell',
          key,
          locale,
          reason: `looks like a contact record (carries ${fields.join(', ')}) — people never enter the snapshot, §13.1e`,
        });
      }
    }
  }
  return warnings;
}

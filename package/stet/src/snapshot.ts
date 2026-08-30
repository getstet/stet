import { embeddedHash, generatedBody, generatedHeader, sourceHash } from './codegen.js';
import type { Descriptor, Warning } from './types.js';

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

/**
 * `defaults.ts` from `defaults.json`. Locales and keys sort, so a one-value
 * change is a one-line diff; regeneration from the same JSON is byte-identical.
 */
export function generateDefaultsModule(s: Snapshot): string {
  const sorted: Snapshot = {};
  for (const locale of Object.keys(s).sort()) {
    const values = s[locale] ?? {};
    const sortedValues: Record<string, unknown> = {};
    for (const key of Object.keys(values).sort()) sortedValues[key] = values[key];
    sorted[locale] = sortedValues;
  }
  return (
    generatedHeader('defaults.json', sourceHash(s)) +
    '\n' +
    `export const DEFAULTS = ${JSON.stringify(sorted, null, 2)} as const;\n`
  );
}

export interface CurrencyReport {
  /** Non-derived descriptor keys with no `default`-locale value — failures. */
  missing: string[];
  /** Snapshot keys the descriptor no longer declares — reported, never deleted. */
  orphans: string[];
  warnings: Warning[];
}

/** Descriptor against snapshot, both directions. */
export function checkCurrency(d: Descriptor, s: Snapshot): CurrencyReport {
  const defaults = s['default'] ?? {};
  const missing = Object.keys(d.keys)
    .filter((key) => d.keys[key]?.derivesFrom === undefined)
    .filter((key) => !(key in defaults))
    .sort();

  const seen = new Set<string>();
  for (const values of Object.values(s)) for (const key of Object.keys(values)) seen.add(key);
  const orphans = [...seen].filter((key) => !(key in d.keys)).sort();

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

export type GeneratedState = 'current' | 'staleSource' | 'handEdited';

export interface GeneratedCheck {
  status: GeneratedState;
  /** The hash the file carries, or null when it carries no stet header. */
  embedded: string | null;
  /** The hash the source produces now. */
  fresh: string;
}

/**
 * Two distinct states, because they need two distinct fixes. `staleSource`: the
 * source moved and the file did not — regenerate. `handEdited`: the hashes
 * agree and the body does not, which a hash alone cannot see — the mechanism is
 * regenerate-and-byte-compare.
 */
export function checkGeneratedCurrent<T>(
  fileText: string,
  source: T,
  generate: (source: T) => string,
): GeneratedCheck {
  const embedded = embeddedHash(fileText);
  const fresh = sourceHash(source);
  if (embedded !== fresh) return { status: 'staleSource', embedded, fresh };
  if (generatedBody(fileText) !== generatedBody(generate(source))) {
    return { status: 'handEdited', embedded, fresh };
  }
  return { status: 'current', embedded, fresh };
}

import type { Snapshot } from './snapshot.js';
import type { Descriptor, Warning } from './types.js';
import { shapeSchema } from './validate.js';

/**
 * A row as an adapter hands it over. No `project` field: adapters are
 * project-scoped at construction and return only their own project's rows, so
 * the core trusts its input.
 */
export interface StoreRow {
  key: string;
  locale: string;
  status: 'draft' | 'published';
  is_active?: boolean;
  value: unknown;
  version?: number;
  /** The draft row's schedule stamp; null on a published row. The scheduler
   * enumerates due drafts through this read rather than a second query. */
  publishAt?: string | null;
  /** The stored target, which `stet audit` compares against the descriptor's.
   * Already in every adapter's select — carried, not newly queried. */
  target?: string;
  /** The change a draft or published row belongs to; null when ungrouped. The
   * `--due` split reads it to publish grouped drafts through their change, and
   * a review surface derives its grouped card from it — carried on this same
   * read, not newly queried. */
  changesetId?: number | null;
}

export type ResolutionSource = 'draft' | 'active' | 'derived' | 'snapshot';

export interface Resolution {
  value: unknown;
  source: ResolutionSource;
  warnings: Warning[];
}

export interface ResolveQuery {
  key: string;
  locale?: string;
  /** Drafts resolve only in an explicitly requested preview context. */
  preview?: boolean;
}

/**
 * One resolution order, honored identically in every host mode: preview draft →
 * active stored version → derived → snapshot, each stored step walking the
 * locale chain (requested locale, then `default`).
 *
 * Pure: it takes rows rather than fetching them, which is what makes
 * request-time, build-time and no-store the same code path and the offline
 * guarantee structural. `rows` of `null` is a project with no store at all, not
 * an error state.
 */
export function resolve(
  d: Descriptor,
  s: Snapshot,
  rows: StoreRow[] | null,
  q: ResolveQuery,
): Resolution {
  const warnings: Warning[] = [];
  const resolved = resolveWith(d, s, rows, q, new Set(), warnings);
  return { ...resolved, warnings };
}

function resolveWith(
  d: Descriptor,
  s: Snapshot,
  rows: StoreRow[] | null,
  q: ResolveQuery,
  seen: Set<string>,
  warnings: Warning[],
): { value: unknown; source: ResolutionSource } {
  const locale = q.locale ?? 'default';
  const chain = localeChain(locale);
  const def = d.keys[q.key];
  const candidates = (rows ?? []).filter((row) => row.key === q.key);

  if (q.preview) {
    for (const loc of chain) {
      const row = candidates.find((r) => r.locale === loc && r.status === 'draft');
      if (row && parses(d, q.key, row, warnings)) return { value: row.value, source: 'draft' };
    }
  }

  for (const loc of chain) {
    const row = activeRow(candidates, loc);
    if (row && parses(d, q.key, row, warnings)) return { value: row.value, source: 'active' };
  }

  if (def?.derivesFrom !== undefined && def.tmpl !== undefined) {
    if (seen.has(q.key)) {
      warnings.push({
        code: 'derivation_cycle',
        key: q.key,
        locale,
        reason: `derivation cycle through "${def.derivesFrom}" — falling back to the snapshot`,
      });
    } else {
      seen.add(q.key);
      const from = resolveWith(
        d,
        s,
        rows,
        { key: def.derivesFrom, locale, preview: q.preview },
        seen,
        warnings,
      );
      if (from.value !== undefined) {
        return { value: def.tmpl.replace('{v}', String(from.value)), source: 'derived' };
      }
    }
  }

  for (const loc of chain) {
    const value = s[loc]?.[q.key];
    if (value !== undefined) return { value, source: 'snapshot' };
  }

  warnings.push({
    code: 'no_value',
    key: q.key,
    locale,
    reason: 'no stored, derived or committed value — the snapshot is incomplete for this key',
  });
  return { value: undefined, source: 'snapshot' };
}

/**
 * The requested locale, then `default`. Exported for the adapters: a store
 * reading one locale must hand over every row this walk may reach, or a value
 * stored under `default` would be invisible to a page rendering in `de`.
 */
export function localeChain(locale: string): string[] {
  return locale === 'default' ? ['default'] : [locale, 'default'];
}

/**
 * The active row among a key's candidates, for one locale — the same selection
 * resolution makes. Exported because `stet pull` stamps the bundle's version
 * metadata from it: a second implementation of "which row is live" is exactly
 * the parallel lookup the read path forbids.
 */
export function activeRow(candidates: StoreRow[], locale: string): StoreRow | undefined {
  return candidates
    .filter((r) => r.locale === locale && r.status === 'published' && r.is_active !== false)
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
}

/**
 * A stored value that fails its declared shape is treated as absent and the
 * event is observable. Never silent (the surface would blank), never fatal (the
 * store would take the page down with it).
 */
function parses(d: Descriptor, key: string, row: StoreRow, warnings: Warning[]): boolean {
  const parsed = shapeSchema(d, key).safeParse(row.value);
  if (parsed.success) return true;
  warnings.push({
    code: 'malformed_value',
    key,
    locale: row.locale,
    reason: `stored value fails the declared ${d.keys[key]?.shape ?? 'unknown'} shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
  });
  return false;
}

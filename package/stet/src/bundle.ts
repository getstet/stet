import { resolve, type Resolution, type ResolveQuery } from './resolve.js';
import type { Snapshot } from './snapshot.js';
import type { Descriptor, Warning } from './types.js';

/**
 * The read bundle: the resolved key→value map, plus version metadata where a
 * store produced it. Plain JSON, readable in any language with no JS runtime —
 * the non-JS host's first-class floor, not an apology.
 */
export interface Bundle {
  values: Record<string, Record<string, unknown>>;
  /** Per key × locale, matching key identity. Absent on a snapshot-only host. */
  meta?: Record<string, Record<string, { version: number }>>;
}

/**
 * Both forms. A snapshot-only project commits `defaults.json` and that file
 * *is* the bundle — no separate artifact, and no version metadata, because no
 * version exists. The full form is detected by its `values` wrapper.
 */
export function readBundle(raw: unknown): Bundle {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('bundle must be an object');
  }
  const candidate = raw as Record<string, unknown>;
  const wrapper = candidate['values'];

  if (wrapper !== undefined) {
    if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
      throw new Error('bundle "values" must be an object keyed by locale');
    }
    const meta = candidate['meta'];
    if (meta !== undefined && (meta === null || typeof meta !== 'object' || Array.isArray(meta))) {
      throw new Error('bundle "meta" must be an object keyed by locale');
    }
    return meta === undefined
      ? { values: wrapper as Bundle['values'] }
      : { values: wrapper as Bundle['values'], meta: meta as Bundle['meta'] };
  }

  return { values: candidate as Bundle['values'] };
}

/**
 * Reading the bundle takes the same path as reading the snapshot: the bundle is
 * already resolved, so what remains is the locale chain and derivation for a
 * key the producer did not materialize. Equal to direct resolution over the
 * same inputs by construction, not by a parallel implementation.
 *
 * Version metadata is not part of the resolution — a caller that needs it reads
 * `bundle.meta[locale][key]`.
 */
export function resolveFromBundle(d: Descriptor, b: Bundle, q: ResolveQuery): Resolution {
  return resolve(d, b.values as Snapshot, null, q);
}

/**
 * Every declared key resolved once — the map an accessor takes. The read
 * boundary (a `CopyProvider` mount, a server component, a story decorator)
 * calls it and hands `resolved` on, which is what keeps the accessor
 * pre-resolved exactly as `access.ts` requires.
 *
 * It wraps `resolveFromBundle` rather than resolving in parallel, so the order,
 * the locale chain and derivation are the one implementation. A key the bundle
 * carries no value for is ABSENT from the map and its `no_value` warning rides
 * the return — never a placeholder token, which would render as copy.
 */
export function resolveAll(
  d: Descriptor,
  bundle: Bundle,
  q: { locale?: string; preview?: boolean } = {},
): { resolved: Record<string, unknown>; warnings: Warning[] } {
  const resolved: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const key of Object.keys(d.keys)) {
    const r = resolveFromBundle(d, bundle, { key, locale: q.locale, preview: q.preview });
    if (r.value !== undefined) resolved[key] = r.value;
    warnings.push(...r.warnings);
  }
  return { resolved, warnings };
}

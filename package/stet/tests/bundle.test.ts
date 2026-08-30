import { describe, expect, it } from 'vitest';

import { miniBundle, miniDescriptor, miniRows, miniSnapshot, readFixture } from '../conformance/fixture.js';
import { readBundle, resolve, resolveAll, resolveFromBundle } from '../src/index.js';
import type { Bundle, Snapshot } from '../src/index.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();
const rows = miniRows();
const bundle = miniBundle();

const locales = Object.keys(snapshot);
const keys = Object.keys(descriptor.keys);

/** What `stet pull` will emit: the resolved map, one entry per key × locale. */
function bundleFromResolution(): Bundle {
  const values: Bundle['values'] = {};
  const meta: NonNullable<Bundle['meta']> = {};
  for (const locale of locales) {
    values[locale] = {};
    meta[locale] = {};
    for (const key of keys) {
      const r = resolve(descriptor, snapshot, rows, { key, locale });
      if (r.value !== undefined) values[locale]![key] = r.value;
      if (r.source === 'active') meta[locale]![key] = { version: 3 };
    }
  }
  return { values, meta };
}

describe('readBundle', () => {
  it('reads the full form', () => {
    expect(Object.keys(bundle.values)).toEqual(locales);
    expect(bundle.meta?.['default']?.['hero_headline']?.version).toBe(3);
  });

  it('reads a bare defaults.json as the bundle, because on a snapshot-only host it is', () => {
    const bare = readBundle(readFixture('defaults.json'));
    expect(bare.values).toEqual(snapshot);
    expect(bare.meta).toBeUndefined();
  });

  it('rejects something that is not a bundle at all', () => {
    expect(() => readBundle([1, 2, 3])).toThrowError(/object/);
    expect(() => readBundle({ values: 'nope' })).toThrowError(/values/);
  });
});

describe('resolveFromBundle', () => {
  it('equals direct resolution over the same values, for every key and locale', () => {
    const bare = readBundle(readFixture('defaults.json'));
    for (const locale of locales) {
      for (const key of keys) {
        expect(resolveFromBundle(descriptor, bare, { key, locale })).toEqual(
          resolve(descriptor, snapshot, null, { key, locale }),
        );
      }
    }
  });

  it('equals the resolution a store-backed host performed, when the bundle came from one', () => {
    const emitted = bundleFromResolution();
    for (const locale of locales) {
      for (const key of keys) {
        expect(resolveFromBundle(descriptor, emitted, { key, locale }).value).toEqual(
          resolve(descriptor, snapshot, rows, { key, locale }).value,
        );
      }
    }
  });

  it('derives a key the producer did not materialize', () => {
    const partial: Bundle = { values: { default: { hero_headline: 'A pulled headline.' } } };
    expect(resolveFromBundle(descriptor, partial, { key: 'seo_home_title' })).toMatchObject({
      value: 'A pulled headline. — Mirra',
      source: 'derived',
    });
  });

  it('carries no version metadata where no version exists', () => {
    const bare = readBundle(readFixture('defaults.json') as Snapshot);
    expect(bare.meta).toBeUndefined();
  });
});

describe('resolveAll', () => {
  it('is exactly resolveFromBundle over every declared key — never a parallel resolution', () => {
    const { resolved, warnings } = resolveAll(descriptor, bundle, { locale: 'default' });
    for (const key of keys) {
      const r = resolveFromBundle(descriptor, bundle, { key, locale: 'default' });
      if (r.value !== undefined) expect(resolved[key]).toEqual(r.value);
      else expect(key in resolved).toBe(false);
    }
    // The returned warnings are the per-key warnings concatenated in key order.
    const perKey = keys.flatMap(
      (key) => resolveFromBundle(descriptor, bundle, { key, locale: 'default' }).warnings,
    );
    expect(warnings).toEqual(perKey);
  });

  it('a declared key with no value warns no_value and is absent from the map — never a token', () => {
    // Only the hero is supplied; the rest have no stored, derived or committed value.
    const partial: Bundle = { values: { default: { hero_headline: 'Just the hero.' } } };
    const { resolved, warnings } = resolveAll(descriptor, partial, { locale: 'default' });
    expect(resolved['hero_headline']).toBe('Just the hero.');

    const missing = keys.find((key) => !(key in resolved));
    expect(missing).toBeDefined();
    expect(warnings.some((w) => w.code === 'no_value' && w.key === missing)).toBe(true);

    // No placeholder token ever reaches the resolved map.
    for (const value of Object.values(resolved)) {
      expect(typeof value === 'string' ? value : '').not.toContain('{{');
    }
  });
});

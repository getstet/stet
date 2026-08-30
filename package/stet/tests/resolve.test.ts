import { describe, expect, it } from 'vitest';

import { miniDescriptor, miniRows, miniSnapshot, mutable } from '../conformance/fixture.js';
import { resolve } from '../src/index.js';
import type { Descriptor, Snapshot, StoreRow } from '../src/index.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();
const rows = miniRows();

describe('the resolution order', () => {
  it('serves the active published row over the snapshot', () => {
    const r = resolve(descriptor, snapshot, rows, { key: 'hero_headline' });
    expect(r).toEqual({
      value: 'Mirror your X posts to Telegram.',
      source: 'active',
      warnings: [],
    });
  });

  it('ignores a superseded row: is_active decides, not row order', () => {
    const r = resolve(descriptor, snapshot, rows, { key: 'hero_headline' });
    expect(r.value).not.toBe('An older headline, superseded.');
  });

  it('serves a draft only in a preview context', () => {
    expect(resolve(descriptor, snapshot, rows, { key: 'hero_headline' }).source).toBe('active');
    const preview = resolve(descriptor, snapshot, rows, { key: 'hero_headline', preview: true });
    expect(preview).toMatchObject({ value: 'A headline still in progress.', source: 'draft' });
  });

  it('derives a key that has no stored value, from whatever its source resolved to', () => {
    const stored = resolve(descriptor, snapshot, rows, { key: 'seo_home_title' });
    expect(stored).toMatchObject({
      value: 'Mirror your X posts to Telegram. — Mirra',
      source: 'derived',
    });

    const committed = resolve(descriptor, snapshot, null, { key: 'seo_home_title' });
    expect(committed).toMatchObject({
      value: 'Never miss a post again. — Mirra',
      source: 'derived',
    });
  });

  it('prefers a stored value over derivation when one exists', () => {
    const overridden: StoreRow[] = [
      ...rows,
      {
        key: 'seo_home_title',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'A hand-written title',
        version: 1,
      },
    ];
    expect(resolve(descriptor, snapshot, overridden, { key: 'seo_home_title' })).toMatchObject({
      value: 'A hand-written title',
      source: 'active',
    });
  });

  it('warns and falls back rather than looping on a derivation cycle', () => {
    const looped = mutable(descriptor);
    looped.keys['loop_a'] = {
      shape: 'text',
      target: 'web',
      derivesFrom: 'loop_b',
      tmpl: 'a:{v}',
    };
    looped.keys['loop_b'] = {
      shape: 'text',
      target: 'web',
      derivesFrom: 'loop_a',
      tmpl: 'b:{v}',
    };
    const r = resolve(looped, snapshot, null, { key: 'loop_a' });
    expect(r.value).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).toContain('derivation_cycle');
  });
});

describe('the snapshot fallback', () => {
  it('renders the page when there is no store at all', () => {
    const r = resolve(descriptor, snapshot, null, { key: 'hero_headline' });
    expect(r).toEqual({ value: 'Never miss a post again.', source: 'snapshot', warnings: [] });
  });

  it('takes the identical path when the store is reachable but has no row for the key', () => {
    const withStore = resolve(descriptor, snapshot, rows, { key: 'farewell_notice' });
    const withoutStore = resolve(descriptor, snapshot, null, { key: 'farewell_notice' });
    expect(withStore).toEqual(withoutStore);
    expect(withStore.source).toBe('snapshot');
  });

  it('resolves every fixture key to something, with or without a store', () => {
    for (const key of Object.keys(descriptor.keys)) {
      expect(resolve(descriptor, snapshot, rows, { key }).value).toBeDefined();
      expect(resolve(descriptor, snapshot, null, { key }).value).toBeDefined();
    }
  });
});

describe('quarantine', () => {
  it('treats a malformed stored value as absent and says so', () => {
    const r = resolve(descriptor, snapshot, rows, { key: 'brand__primary' });
    expect(r.value).toBe('#1d4ed8');
    expect(r.source).toBe('snapshot');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      code: 'malformed_value',
      key: 'brand__primary',
      locale: 'default',
    });
    expect(r.warnings[0]?.reason).toContain('color');
  });

  it('cannot blank a text key either', () => {
    const broken: StoreRow[] = [
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: { headline: 'an object where a string belongs' },
        version: 9,
      },
    ];
    const r = resolve(descriptor, snapshot, broken, { key: 'hero_headline' });
    expect(r.value).toBe('Never miss a post again.');
    expect(r.warnings[0]?.code).toBe('malformed_value');
  });
});

describe('the locale chain', () => {
  it('serves the requested locale where it exists', () => {
    expect(resolve(descriptor, snapshot, null, { key: 'hero_headline', locale: 'de' })).toMatchObject(
      { value: 'Verpasse nie wieder einen Post.', source: 'snapshot' },
    );
  });

  it('serves the default language rather than nothing for an untranslated key', () => {
    const r = resolve(descriptor, snapshot, null, { key: 'farewell_notice', locale: 'de' });
    expect(r.value).toBe('This channel is closing. Thanks for reading.');
  });

  it('walks rows before the snapshot at every step of the chain', () => {
    const localized: StoreRow[] = [
      {
        key: 'farewell_notice',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'Stored, default locale.',
        version: 1,
      },
    ];
    const r = resolve(descriptor, snapshot, localized, { key: 'farewell_notice', locale: 'de' });
    expect(r).toMatchObject({ value: 'Stored, default locale.', source: 'active' });
  });
});

describe('the three host modes', () => {
  /** A build-time host reads the same descriptor, snapshot and rows — through a copy. */
  function buildTime(d: Descriptor, s: Snapshot, r: StoreRow[]) {
    return { d: mutable(d), s: mutable(s), r: mutable(r) };
  }

  it('resolves every key identically at request time and at build time', () => {
    const build = buildTime(descriptor, snapshot, rows);
    for (const key of Object.keys(descriptor.keys)) {
      for (const locale of ['default', 'de']) {
        expect(resolve(build.d, build.s, build.r, { key, locale })).toEqual(
          resolve(descriptor, snapshot, rows, { key, locale }),
        );
      }
    }
  });

  it('needs no mode-specific branch: the no-store call is the same call', () => {
    for (const key of Object.keys(descriptor.keys)) {
      const noStore = resolve(descriptor, snapshot, null, { key });
      const emptyStore = resolve(descriptor, snapshot, [], { key });
      expect(emptyStore).toEqual(noStore);
    }
  });
});

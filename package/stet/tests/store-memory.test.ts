/**
 * The memory adapter's test hooks. The conformance suite drives the adapter
 * through the store interface; these cover the two hooks that exist only for
 * tests — preloading rows, and reading them back as data — plus the guard that
 * keeps a preloaded state legal.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryDb, createMemoryStore } from '../adapters/store-memory.js';

describe('the memory store’s test hooks', () => {
  it('seeds rows with the column defaults, and dumps them back as data', () => {
    const store = createMemoryStore({ project: 'seeded' });
    store.seed([
      { key: 'hero_headline', value: 'live wording' },
      { key: 'hero_headline', value: 'in progress', state: 'draft', editor: 'neil' },
      { key: 'farewell_notice', value: 'auf Wiedersehen', locale: 'de', target: 'telegram-md2' },
    ]);

    const rows = store.dump();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: 1,
      project: 'seeded',
      key: 'hero_headline',
      locale: 'default',
      target: 'web',
      state: 'published',
      is_active: true,
    });
    // A draft is never active, and it carries no publish stamp.
    expect(rows[1]).toMatchObject({ state: 'draft', is_active: false, published_at: null });
    expect(rows[2]).toMatchObject({ locale: 'de', target: 'telegram-md2' });

    // dump is a copy: a test that mutates it cannot reach the store.
    rows[0]!.value = 'mutated';
    expect(store.dump()[0]?.value).toBe('live wording');
  });

  it('refuses a seed the partial unique indexes would reject', () => {
    const store = createMemoryStore({ project: 'seeded' });
    store.seed([{ key: 'hero_headline', value: 'live' }]);
    // Two active rows for one project×key×locale is the state the database
    // makes unrepresentable; the reference must not accept it either.
    expect(() => store.seed([{ key: 'hero_headline', value: 'also live' }])).toThrowError(
      /partial unique index/,
    );
    expect(() => store.seed([{ key: 'hero_headline', value: 'superseded', is_active: false }])).not.toThrow();

    store.seed([{ key: 'hero_headline', value: 'draft', state: 'draft' }]);
    expect(() => store.seed([{ key: 'hero_headline', value: 'other draft', state: 'draft' }])).toThrowError(
      /partial unique index/,
    );
    // Another locale is another key identity, so it is not a clash.
    expect(() => store.seed([{ key: 'hero_headline', value: 'auf Deutsch', locale: 'de' }])).not.toThrow();
  });

  it('seeded rows are visible through the interface, and the id sequence continues', async () => {
    const db = createMemoryDb();
    const store = createMemoryStore({ project: 'seeded', db });
    store.seed([{ key: 'hero_headline', value: 'live wording' }]);

    const rows = await store.read();
    // The whole row, exactly: `target`, `publishAt` and `changesetId` ride
    // every read, which is what lets the audit compare stored targets and the
    // scheduler find due drafts AND split them grouped from ungrouped, all
    // without a second query surface.
    expect(rows).toEqual([
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'live wording',
        version: 1,
        target: 'web',
        publishAt: null,
        changesetId: null,
      },
    ]);

    const saved = await store.saveDraft({
      key: 'hero_headline',
      value: 'next',
      target: 'web',
      editor: 'neil',
    });
    expect(saved).toEqual({ draftId: 2 });

    // The seed lands in the shared db, so another project's adapter still sees
    // nothing of it.
    expect(await createMemoryStore({ project: 'elsewhere', db }).read()).toEqual([]);
  });
});

/**
 * The group-revert enumeration's ABORT branches — the two paths the conformance
 * suite cannot reach, because both need a failure injected mid-walk and the
 * suite runs against real adapters that do not fail on command.
 *
 * Both matter for the same reason: a partial revert reported as a whole one
 * would leave the operator believing every member was put back. The walk stops
 * at the first non-stale failure and does NOT stamp `reverted_at`, so a re-run
 * is the recovery — and re-running is safe, because every member already
 * restored refuses on its own guard.
 */
import { describe, expect, it } from 'vitest';

import { revertChange } from '../adapters/changesets.js';
import { createMemoryStore, type MemoryStore } from '../adapters/store-memory.js';
import { createSnapshotStore } from '../adapters/store-snapshot.js';
import { isNotSupported, isStoreError } from '../adapters/store-shared.js';
import type { StoreAdapter } from '../src/store.js';
import { ok } from '../conformance/store.suite.js';

/** A published change over three keys, each already holding one live version. */
async function publishedTrio(store: MemoryStore): Promise<number> {
  const keys = ['hero_headline', 'hero_body', 'farewell_notice'];
  for (const key of keys) {
    ok(await store.saveDraft({ key, value: `${key} v1`, target: 'web', editor: 'neil' }));
    ok(await store.publish({ key, editor: 'neil' }));
  }
  const { changeId } = ok(await store.changesets.open({ name: 'three members' }));
  for (const key of keys) {
    ok(await store.saveDraft({ key, value: `${key} v2`, target: 'web', editor: 'neil', change: changeId }));
  }
  ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
  return changeId;
}

describe('the group revert’s abort branches', () => {
  it('a transport failure mid-walk aborts and leaves the change unstamped', async () => {
    const store = createMemoryStore({ project: 'abort' });
    const changeId = await publishedTrio(store);

    let reverts = 0;
    const flaky: StoreAdapter = {
      ...store,
      revert: (p) => {
        reverts += 1;
        // The SECOND member's write fails as a transport failure rather than a
        // stale guard. A stale member is a skip; this is not, and treating it
        // as one would report a partial revert as a complete one.
        if (reverts === 2) store.failNext = 'write';
        return store.revert(p);
      },
    };

    const answer = await revertChange(flaky, { changeId, editor: 'sam' });
    expect(isStoreError(answer)).toBe(true);
    expect((answer as { code: string }).code).toBe('unreachable');

    // It stopped AT the failure: two calls, never the third member's.
    expect(reverts).toBe(2);
    // And it did not stamp — the event record would otherwise claim a group
    // revert that never finished.
    expect(ok(await store.changesets.get({ changeId })).change.revertedAt).toBeNull();
    // The first member really did restore; the walk is fail-safe per member,
    // not transactional, so what landed stays landed.
    expect(ok(await store.read()).find((r) => r.key === 'hero_headline')?.value).toBe('hero_headline v1');
    // The third was never attempted.
    expect(ok(await store.read()).find((r) => r.key === 'farewell_notice')?.value).toBe('farewell_notice v2');

    // Re-running is the recovery, and it is safe: the restored member refuses
    // on its own guard, the untouched one restores, and the stamp lands.
    const again = ok(await revertChange(store, { changeId, editor: 'sam' }));
    expect(again.reverted.map((m) => m.key)).toEqual(['hero_body', 'farewell_notice']);
    expect(again.skipped.map((s) => s.reason)).toEqual(['stale_active']);
    expect(ok(await store.changesets.get({ changeId })).change.revertedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('an adapter without the capability answers NotSupported, never a false success', async () => {
    // The snapshot adapter reaches the enumeration through the same route a
    // real store would; `changesets.get` refuses first, and the refusal is
    // RETURNED rather than swallowed into an empty result that would read as
    // "nothing needed reverting".
    const answer = await revertChange(createSnapshotStore({ project: 'none' }), {
      changeId: 1,
      editor: 'sam',
    });
    expect(isNotSupported(answer)).toBe(true);
    expect((answer as { method: string }).method).toBe('changesets.get');
  });

  it('a change that never published is refused in the one conflict vocabulary', async () => {
    const store = createMemoryStore({ project: 'never_published' });
    const { changeId } = ok(await store.changesets.open({ name: 'still open' }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));

    const answer = await revertChange(store, { changeId, editor: 'sam' });
    expect(isStoreError(answer)).toBe(true);
    // Built from the shared marker, so a caller reads one vocabulary rather
    // than a phrasing invented in this file.
    expect((answer as { message: string }).message).toContain('change_closed:');
    expect((answer as { code: string }).code).toBe('conflict');
  });
});

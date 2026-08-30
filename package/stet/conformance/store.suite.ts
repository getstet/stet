/**
 * The store conformance suite: one set of assertions every adapter passes with
 * identical observable behavior. The memory adapter is the reference, the SQL
 * adapters must match it, and this suite is the referee — a divergence is a bug
 * in one of them, never a licence for either.
 *
 * Tests isolate themselves by project rather than by truncating tables, because
 * project scoping is a guarantee under test: every case names its own project,
 * so the same database serves the whole suite exactly as a monorepo's apps
 * share one store.
 *
 * An adapter whose write half answers `NotSupported` (the snapshot adapter)
 * passes by answering that way everywhere — the suite probes once and takes the
 * read-only path.
 */
import { describe, expect, it, type TestContext } from 'vitest';

import { resolve } from '../src/index.js';
import { revertChange } from '../adapters/changesets.js';
import { isNotSupported, isRefusal, isStoreError } from '../adapters/store-shared.js';
import type { DraftRefusal, NotSupported, StoreAdapter, StoreError, VersionRow } from '../src/index.js';
import { miniDescriptor, miniSnapshot } from './fixture.js';

export type MakeAdapter = (project: string) => StoreAdapter | Promise<StoreAdapter>;

// The four answers are told apart in one place — `adapters/store-shared.ts`,
// beside the vocabulary that builds them. The suite re-exports them so a test
// file reads them from the suite it is written against.
export { isNotSupported, isRefusal, isStoreError } from '../adapters/store-shared.js';

/** The happy answer, or a failure naming what came back instead. */
export function ok<T extends object>(answer: T | DraftRefusal | NotSupported | StoreError): T {
  if (isStoreError(answer) || isRefusal(answer) || isNotSupported(answer)) {
    throw new Error(`expected success, got ${JSON.stringify(answer)}`);
  }
  return answer as T;
}

function conflictOf(answer: unknown): StoreError {
  if (!isStoreError(answer)) throw new Error(`expected a StoreError, got ${JSON.stringify(answer)}`);
  return answer;
}

export function runStoreConformance(name: string, makeAdapter: MakeAdapter): void {
  describe(`store conformance — ${name}`, () => {
    /** Every case gets its own project, so nothing needs cleaning between them. */
    let seq = 0;
    const scope = async (): Promise<StoreAdapter> => makeAdapter(`conf_${name}_${++seq}`);

    /**
     * Whether this adapter's write half exists at all — asked once, on a
     * project of its own, so the probe's draft never lands in a case's scope.
     */
    let writes: boolean | null = null;
    async function writable(): Promise<boolean> {
      if (writes === null) {
        const probe = await makeAdapter(`conf_${name}_probe`);
        const answer = await probe.saveDraft({
          key: 'probe_key',
          value: 'probe',
          target: 'web',
          editor: 'suite',
        });
        writes = !isNotSupported(answer);
      }
      return writes;
    }

    /**
     * The write half, or a visible skip. An adapter that answers `NotSupported`
     * reports these cases as skipped rather than as quiet passes: the read-only
     * cases below are what a snapshot-only project actually proves, and the
     * count should say so.
     */
    async function needsWrites(ctx: TestContext): Promise<void> {
      ctx.skip(!(await writable()), 'the write half answers NotSupported');
    }

    /**
     * Whether this adapter groups at all — the same one-probe posture as
     * `writable`, on a project of its own so the probe's change never lands in
     * a case's scope.
     */
    let grouping: boolean | null = null;
    async function changesetsSupported(): Promise<boolean> {
      if (grouping === null) {
        const probe = await makeAdapter(`conf_${name}_changeprobe`);
        grouping = !isNotSupported(await probe.changesets.open({ name: 'capability probe' }));
      }
      return grouping;
    }

    /** The capability, or a VISIBLE skip — never a quiet pass. */
    async function needsChangesets(ctx: TestContext): Promise<void> {
      ctx.skip(!(await changesetsSupported()), 'the changesets capability answers NotSupported');
    }

    /** A published change over `keys`, each already holding one published version. */
    async function publishedChange(
      store: StoreAdapter,
      keys: string[],
      firstPublish: string[] = [],
    ): Promise<number> {
      for (const key of keys) {
        ok(await store.saveDraft({ key, value: `${key} v1`, target: 'web', editor: 'neil' }));
        ok(await store.publish({ key, editor: 'neil' }));
      }
      const { changeId } = ok(await store.changesets.open({ name: 'grouped edit' }));
      for (const key of [...keys, ...firstPublish]) {
        ok(
          await store.saveDraft({ key, value: `${key} v2`, target: 'web', editor: 'neil', change: changeId }),
        );
      }
      ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
      return changeId;
    }

    it('an adapter is scoped to one project, at construction', async () => {
      const store = await scope();
      expect(typeof store.project).toBe('string');
      expect(store.project.length).toBeGreaterThan(0);
      // The flag answers without touching the database.
      expect(typeof store.canApplyDDL).toBe('boolean');
    });

    it('read returns rows, never resolved values', async () => {
      const store = await scope();
      const rows = ok(await store.read());
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toEqual([]);

      if (!(await writable())) {
        // The snapshot adapter: zero rows is the whole read half, and every
        // write answers NotSupported rather than pretending.
        expect(ok(await store.read({ preview: true }))).toEqual([]);
        return;
      }

      ok(await store.saveDraft({ key: 'probe_key', value: 'probe', target: 'web', editor: 'suite' }));
      ok(await store.publish({ key: 'probe_key', editor: 'suite' }));
      const after = ok(await store.read());
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        key: 'probe_key',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'probe',
      });
      expect(typeof after[0]?.version).toBe('number');
    });

    it('NotSupported where declared, never a fake success', async () => {
      const store = await scope();
      if (await writable()) {
        // A writable adapter answers NotSupported nowhere — not even where it
        // has nothing to do.
        expect(isNotSupported(await store.publish({ key: 'never_saved', editor: 'suite' }))).toBe(false);
        expect(isNotSupported(await store.recent())).toBe(false);
        return;
      }
      const answers = [
        ['saveDraft', await store.saveDraft({ key: 'k', value: 'v', target: 'web', editor: 'e' })],
        ['publish', await store.publish({ key: 'k', editor: 'e' })],
        ['revert', await store.revert({ versionId: 1, editor: 'e' })],
        ['rename', await store.rename({ oldKey: 'k', newKey: 'n', editor: 'e' })],
        ['history', await store.history({ key: 'k' })],
        ['recent', await store.recent()],
        // The capability answers the same way its write half does: an answer
        // naming the method, so a surface renders the grouping affordance
        // honestly disabled rather than guessing at its absence.
        ['changesets.open', await store.changesets.open({ name: 'n' })],
        ['changesets.list', await store.changesets.list()],
        ['changesets.get', await store.changesets.get({ changeId: 1 })],
        ['changesets.schedule', await store.changesets.schedule({ changeId: 1, publishAt: null })],
        ['changesets.publishChange', await store.changesets.publishChange({ changeId: 1, editor: 'e' })],
        ['changesets.abandon', await store.changesets.abandon({ changeId: 1 })],
        ['changesets.discardDraft', await store.changesets.discardDraft({ key: 'k' })],
        ['changesets.markReverted', await store.changesets.markReverted({ changeId: 1 })],
      ] as const;
      for (const [method, answer] of answers) {
        expect(isNotSupported(answer)).toBe(true);
        expect((answer as NotSupported).method).toBe(method);
      }
      // NotSupported is an answer, not an error path: nothing threw, and the
      // caller can render the project read-only.
      expect(answers.every(([, a]) => !isStoreError(a))).toBe(true);
    });

    it('ten saves, one draft — the table records publishes, not keystrokes', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      for (let i = 1; i <= 10; i += 1) {
        ok(
          await store.saveDraft({
            key: 'hero_headline',
            value: `draft ${i}`,
            target: 'web',
            editor: 'neil',
          }),
        );
      }
      const rows = ok(await store.read({ preview: true }));
      const drafts = rows.filter((r) => r.status === 'draft');
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.value).toBe('draft 10');
      // Nothing was published, so nothing is active.
      expect(rows.filter((r) => r.is_active)).toHaveLength(0);
    });

    it('a save refuses a different editor’s draft, and force names the incumbent', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      const first = ok(
        await store.saveDraft({ key: 'hero_body', value: 'human wording', target: 'web', editor: 'neil' }),
      );

      const refusal = await store.saveDraft({
        key: 'hero_body',
        value: 'agent wording',
        target: 'web',
        editor: 'agent:claude',
      });
      expect(isRefusal(refusal)).toBe(true);
      if (!isRefusal(refusal)) throw new Error('unreachable');
      expect(refusal.incumbentEditor).toBe('neil');
      // ISO UTC by construction, whatever the server's session settings.
      expect(refusal.heldSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // The proposal was reported, never queued: the draft still holds the human's words.
      const held = ok(await store.read({ preview: true })).find((r) => r.key === 'hero_body');
      expect(held?.value).toBe('human wording');

      // The same editor saving again is never a refusal.
      ok(await store.saveDraft({ key: 'hero_body', value: 'human, revised', target: 'web', editor: 'neil' }));

      // force is the dashboard's path — after showing what it replaces.
      const forced = ok(
        await store.saveDraft({
          key: 'hero_body',
          value: 'agent wording',
          target: 'web',
          editor: 'agent:claude',
          force: true,
        }),
      );
      expect(forced.draftId).toBe(first.draftId);
      const now = ok(await store.read({ preview: true })).find((r) => r.key === 'hero_body');
      expect(now?.value).toBe('agent wording');
    });

    it('the draft row is the full draft state, not a patch', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(
        await store.saveDraft({
          key: 'hero_headline',
          value: 'with a label',
          target: 'web',
          editor: 'neil',
          label: 'v2 idea',
          note: 'shorter',
        }),
      );
      ok(await store.saveDraft({ key: 'hero_headline', value: 'bare', target: 'web', editor: 'neil' }));
      const id = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      const row = ok(await store.history({ key: 'hero_headline' })).rows.find((r) => r.id === id);
      expect(row?.label).toBeNull();
      expect(row?.note).toBeNull();
    });

    it('publish clears and flips — exactly one active version, always', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
      const v1 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      ok(await store.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
      const v2 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;

      expect(v2).toBeGreaterThan(v1);
      const rows = ok(await store.read());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ value: 'second', is_active: true, version: v2 });

      // The publish consumed the draft; there is nothing left to publish.
      expect(ok(await store.read({ preview: true })).filter((r) => r.status === 'draft')).toHaveLength(0);
      const again = conflictOf(await store.publish({ key: 'hero_headline', editor: 'neil' }));
      expect(again.code).toBe('conflict');
      expect(again.message).toContain('hero_headline');

      // History keeps both, newest first, ids unchanged.
      const history = ok(await store.history({ key: 'hero_headline' }));
      expect(history.rows.map((r) => r.id)).toEqual([v2, v1]);
      expect(history.rows.map((r) => r.value)).toEqual(['second', 'first']);
      expect(history.rows[0]?.publishedAt).toBeTruthy();
      expect(history.rows[0]?.createdAt).toBeTruthy();
    });

    it('publish keeps the draft author and stamps who made it live', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'hero_body', value: 'a human’s wording', target: 'web', editor: 'neil' }));
      const id = ok(await store.publish({ key: 'hero_body', editor: 'agent:claude' })).versionId;

      const row = ok(await store.history({ key: 'hero_body' })).rows.find((r) => r.id === id);
      // Two facts, never one: history answers "who wrote this wording" and "who
      // made it live" separately, and publishing does not rewrite authorship.
      expect(row?.editor).toBe('neil');
      expect(row?.publishedBy).toBe('agent:claude');
      expect(row?.revertedFrom).toBeNull();
    });

    it('revert mints a new row and never touches the draft', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
      const v1 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      ok(await store.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
      ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
      ok(await store.saveDraft({ key: 'hero_headline', value: 'work in progress', target: 'web', editor: 'neil' }));

      const reverted = ok(await store.revert({ versionId: v1, editor: 'neil' })).versionId;
      expect(reverted).toBeGreaterThan(v1);

      const active = ok(await store.read());
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ value: 'first', version: reverted, is_active: true });

      // The operator's unpublished wording survived untouched.
      const draft = ok(await store.read({ preview: true })).find((r) => r.status === 'draft');
      expect(draft?.key).toBe('hero_headline');
      expect(draft?.value).toBe('work in progress');

      // Values and ids are immutable: the original row is still there, unchanged.
      const history = ok(await store.history({ key: 'hero_headline' }));
      expect(history.rows.find((r) => r.id === v1)?.value).toBe('first');
      expect(history.rows).toHaveLength(3);
    });

    it('a revert row records the version it restored', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
      const v1 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      ok(await store.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
      const v2 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      const reverted = ok(await store.revert({ versionId: v1, editor: 'sam' })).versionId;

      const rows = ok(await store.history({ key: 'hero_headline' })).rows;
      // Without this, a revert is indistinguishable from someone coincidentally
      // re-entering an old value.
      expect(rows.find((r) => r.id === reverted)?.revertedFrom).toBe(v1);
      expect(rows.find((r) => r.id === v2)?.revertedFrom).toBeNull();
      expect(rows.find((r) => r.id === v1)?.revertedFrom).toBeNull();
      // Every row made live records who made it live: the reverter published
      // this one, and the restored wording keeps its own author.
      expect(rows.find((r) => r.id === reverted)?.publishedBy).toBe('sam');
    });

    it('a revert of an absent or unpublished version is a conflict', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      expect(conflictOf(await store.revert({ versionId: 999_999_999, editor: 'neil' })).code).toBe('conflict');
      const draft = ok(
        await store.saveDraft({ key: 'hero_headline', value: 'unpublished', target: 'web', editor: 'neil' }),
      );
      expect(conflictOf(await store.revert({ versionId: draft.draftId, editor: 'neil' })).code).toBe('conflict');
    });

    it('rename re-keys whole, refuses an occupied target, and history stays linked', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'old_key', value: 'first', target: 'web', editor: 'neil' }));
      const v1 = ok(await store.publish({ key: 'old_key', editor: 'neil' })).versionId;
      ok(await store.saveDraft({ key: 'old_key', value: 'second', target: 'web', editor: 'neil' }));
      const v2 = ok(await store.publish({ key: 'old_key', editor: 'neil' })).versionId;
      ok(await store.saveDraft({ key: 'taken_key', value: 'occupant', target: 'web', editor: 'neil' }));

      // Merging histories is not a thing rename does.
      const refused = conflictOf(await store.rename({ oldKey: 'old_key', newKey: 'taken_key', editor: 'neil' }));
      expect(refused.code).toBe('conflict');
      expect(refused.message).toContain('taken_key');
      expect(ok(await store.history({ key: 'old_key' })).rows.map((r) => r.id)).toEqual([v2, v1]);

      ok(await store.rename({ oldKey: 'old_key', newKey: 'new_key', editor: 'neil' }));
      const moved = ok(await store.history({ key: 'new_key' }));
      expect(moved.rows.map((r) => r.id)).toEqual([v2, v1]);
      expect(moved.rows.map((r) => r.value)).toEqual(['second', 'first']);
      expect(ok(await store.history({ key: 'old_key' })).rows).toEqual([]);
      // No runtime aliasing: the old name resolves to nothing at all.
      expect(ok(await store.read()).map((r) => r.key)).not.toContain('old_key');
    });

    it('history and recent order by id and page by keyset cursor', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      const ids: number[] = [];
      for (let i = 1; i <= 6; i += 1) {
        ok(await store.saveDraft({ key: 'paged_key', value: `v${i}`, target: 'web', editor: 'neil' }));
        ids.push(ok(await store.publish({ key: 'paged_key', editor: 'neil' })).versionId);
      }
      const newestFirst = [...ids].reverse();

      const first = ok(await store.recent({ limit: 2 }));
      expect(first.rows.map((r) => r.id)).toEqual(newestFirst.slice(0, 2));
      expect(first.nextBeforeId).toBe(newestFirst[1]);

      // Rows land between the two page reads. The cursor is an id, not an
      // offset, so the boundary neither duplicates nor skips.
      ok(await store.saveDraft({ key: 'paged_key', value: 'v7', target: 'web', editor: 'neil' }));
      const v7 = ok(await store.publish({ key: 'paged_key', editor: 'neil' })).versionId;

      const second = ok(await store.recent({ beforeId: first.nextBeforeId ?? undefined, limit: 2 }));
      expect(second.rows.map((r) => r.id)).toEqual(newestFirst.slice(2, 4));
      expect(second.rows.map((r) => r.id)).not.toContain(v7);
      expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(4);

      // The last page comes up short and says so.
      const tail = ok(await store.recent({ beforeId: newestFirst[4], limit: 50 }));
      expect(tail.rows.map((r) => r.id)).toEqual([newestFirst[5]]);
      expect(tail.nextBeforeId).toBeNull();

      // recent is published-only and project-wide; history is one key's.
      expect(ok(await store.recent()).rows.every((r) => r.status === 'published')).toBe(true);
      const perKey = ok(await store.history({ key: 'paged_key', limit: 3 }));
      expect(perKey.rows.map((r) => r.id)).toEqual([v7, ...newestFirst.slice(0, 2)]);
      expect(perKey.nextBeforeId).toBe(newestFirst[1]);
    });

    it('a page size is clamped, never unbounded', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      for (let i = 0; i < 201; i += 1) {
        ok(await store.saveDraft({ key: 'big_key', value: `v${i}`, target: 'web', editor: 'neil' }));
        ok(await store.publish({ key: 'big_key', editor: 'neil' }));
      }
      const page = ok(await store.recent({ limit: 5000 }));
      expect(page.rows).toHaveLength(200);
      expect(page.nextBeforeId).toBe(page.rows[199]?.id);
      // A nonsense limit still returns a usable page rather than nothing.
      expect(ok(await store.recent({ limit: 0 })).rows).toHaveLength(1);
    }, 60_000);

    it('two projects share a store without sharing keys', async (ctx) => {
      await needsWrites(ctx);
      const mine = await scope();
      const theirs = await makeAdapter(`${mine.project}_other`);

      ok(await mine.saveDraft({ key: 'hero_headline', value: 'ours', target: 'web', editor: 'neil' }));
      const ourVersion = ok(await mine.publish({ key: 'hero_headline', editor: 'neil' })).versionId;

      // Reads do not cross.
      expect(ok(await theirs.read())).toEqual([]);
      expect(ok(await theirs.history({ key: 'hero_headline' })).rows).toEqual([]);
      expect(ok(await theirs.recent()).rows).toEqual([]);

      // Writes do not cross: the same key name is a different key.
      ok(await theirs.saveDraft({ key: 'hero_headline', value: 'theirs', target: 'web', editor: 'sam' }));
      ok(await theirs.publish({ key: 'hero_headline', editor: 'sam' }));
      expect(ok(await mine.read())[0]?.value).toBe('ours');
      expect(ok(await theirs.read())[0]?.value).toBe('theirs');

      // Version ids are global, so revert is the one write that could reach
      // across projects. It refuses instead.
      const crossed = conflictOf(await theirs.revert({ versionId: ourVersion, editor: 'sam' }));
      expect(crossed.code).toBe('conflict');
      expect(crossed.message).toContain('wrong_project');
      expect(ok(await mine.read())[0]?.value).toBe('ours');

      // A rename in one project cannot move the other's rows.
      ok(await theirs.rename({ oldKey: 'hero_headline', newKey: 'renamed_here', editor: 'sam' }));
      expect(ok(await mine.read()).map((r) => r.key)).toEqual(['hero_headline']);
    });

    it('the error-code table is the same table for every adapter', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'occupied_key', value: 'x', target: 'web', editor: 'neil' }));
      const publishedId = ok(await store.publish({ key: 'occupied_key', editor: 'neil' })).versionId;

      const cases: [string, StoreError][] = [
        ['no_draft:', conflictOf(await store.publish({ key: 'never_saved', editor: 'neil' }))],
        [
          'target_occupied:',
          conflictOf(await store.rename({ oldKey: 'nothing_here', newKey: 'occupied_key', editor: 'neil' })),
        ],
        ['no_version:', conflictOf(await store.revert({ versionId: 999_999_999, editor: 'neil' }))],
      ];
      for (const [marker, error] of cases) {
        expect(error.code).toBe('conflict');
        expect(error.message).toContain(marker);
      }
      // The raw server text always rides along, whatever the code.
      expect(conflictOf(await store.publish({ key: 'never_saved', editor: 'neil' })).message.length)
        .toBeGreaterThan(0);
      // A successful revert of that published id proves the fixture was sound.
      ok(await store.revert({ versionId: publishedId, editor: 'neil' }));
    });

    it('locale is part of key identity, and a read hands over the chain', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'farewell_notice', value: 'default wording', target: 'web', editor: 'neil' }));
      ok(await store.publish({ key: 'farewell_notice', editor: 'neil' }));
      ok(
        await store.saveDraft({
          key: 'farewell_notice',
          value: 'deutsche Fassung',
          target: 'web',
          editor: 'neil',
          locale: 'de',
        }),
      );
      ok(await store.publish({ key: 'farewell_notice', editor: 'neil', locale: 'de' }));

      // Same key, two locales, both live — the indexes are per locale.
      expect(ok(await store.read()).map((r) => r.value).sort()).toEqual(['default wording', 'deutsche Fassung']);
      // A `de` read carries `default` too, or the resolver's fallback could not fire.
      const de = ok(await store.read({ locale: 'de' }));
      expect(de.map((r) => r.locale).sort()).toEqual(['de', 'default']);
      expect(ok(await store.read({ locale: 'default' })).map((r) => r.locale)).toEqual(['default']);
      // history filters to one locale when asked, all of them when not.
      expect(ok(await store.history({ key: 'farewell_notice', locale: 'de' })).rows).toHaveLength(1);
      expect(ok(await store.history({ key: 'farewell_notice' })).rows).toHaveLength(2);
    });

    it('reads narrow by key when asked', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      for (const key of ['hero_headline', 'hero_body']) {
        ok(await store.saveDraft({ key, value: `${key} value`, target: 'web', editor: 'neil' }));
        ok(await store.publish({ key, editor: 'neil' }));
      }
      expect(ok(await store.read({ keys: ['hero_body'] })).map((r) => r.key)).toEqual(['hero_body']);
      expect(ok(await store.read()).map((r) => r.key).sort()).toEqual(['hero_body', 'hero_headline']);
    });

    it('its rows resolve through the one path, and its absence serves the snapshot', async () => {
      const store = await scope();
      const descriptor = miniDescriptor();
      const snapshot = miniSnapshot();
      const keys = Object.keys(descriptor.keys);

      // Nothing stored yet: every key of the fixture project renders from the
      // committed snapshot, through the identical code path.
      const empty = ok(await store.read());
      for (const key of keys) {
        // A derived key derives even with no rows; what matters is that
        // nothing resolves from the store.
        const resolution = resolve(descriptor, snapshot, empty, { key });
        expect(['snapshot', 'derived']).toContain(resolution.source);
        expect(resolution.value).toBeDefined();
      }
      // A read-only store's whole proof is above this line — it passes here,
      // rather than reporting a skip over assertions that ran.
      if (!(await writable())) return;

      ok(
        await store.saveDraft({
          key: 'hero_headline',
          value: 'Stored, and live.',
          target: 'web',
          editor: 'neil',
        }),
      );
      ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
      const rows = ok(await store.read());

      expect(resolve(descriptor, snapshot, rows, { key: 'hero_headline' })).toMatchObject({
        value: 'Stored, and live.',
        source: 'active',
      });
      // Everything else still comes from the snapshot: the store supplies rows,
      // never resolution.
      expect(resolve(descriptor, snapshot, rows, { key: 'hero_body' }).source).toBe('snapshot');
      // A derived key derives from the stored value, not the committed one.
      expect(resolve(descriptor, snapshot, rows, { key: 'seo_home_title' })).toMatchObject({
        value: 'Stored, and live. — Mirra',
        source: 'derived',
      });
    });

    it('a history row carries its version metadata', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(
        await store.saveDraft({
          key: 'hero_headline',
          value: 'with metadata',
          target: 'web',
          editor: 'neil',
          label: 'launch wording',
          note: 'shorter, warmer',
        }),
      );
      const id = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      const row = ok(await store.history({ key: 'hero_headline' })).rows[0] as VersionRow;
      expect(row.id).toBe(id);
      // id IS the version: both fields, always equal.
      expect(row.version).toBe(row.id);
      expect(row).toMatchObject({
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        editor: 'neil',
        label: 'launch wording',
        note: 'shorter, warmer',
      });
      expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('a save’s target and schedule stamp are not write-only', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(
        await store.saveDraft({
          key: 'farewell_notice',
          value: 'auf Wiedersehen',
          target: 'telegram-md2',
          editor: 'neil',
          publishAt: '2026-09-01T09:00:00.000Z',
        }),
      );
      const id = ok(await store.publish({ key: 'farewell_notice', editor: 'neil' })).versionId;

      const row = ok(await store.history({ key: 'farewell_notice' })).rows.find((r) => r.id === id);
      // target rode the save through to the published row — the descriptor is
      // authoritative for shape, and a row that lost it could not render.
      expect(row?.target).toBe('telegram-md2');
      // publish consumed the schedule stamp: a null publish_at means
      // publish-now, and this row is live.
      expect(row?.publishAt).toBeNull();
    });

    it('a draft’s schedule stamp and target read back through the read path', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(
        await store.saveDraft({
          key: 'farewell_notice',
          value: 'scheduled',
          target: 'telegram-md2',
          editor: 'neil',
          publishAt: '2026-09-01T09:00:00.000Z',
        }),
      );

      // The scheduler's whole query: one preview read, with the stamp and the
      // target on the draft row it saved them to. Nothing else exists to ask,
      // and nothing else needs to.
      const draft = ok(await store.read({ preview: true })).find((r) => r.key === 'farewell_notice');
      expect(draft?.status).toBe('draft');
      expect(draft?.publishAt).toBe('2026-09-01T09:00:00.000Z');
      expect(draft?.target).toBe('telegram-md2');

      // A published row carries no stamp — publish consumed it — and still
      // carries its target, which is what `stet audit` compares.
      ok(await store.publish({ key: 'farewell_notice', editor: 'neil' }));
      const live = ok(await store.read()).find((r) => r.key === 'farewell_notice');
      expect(live?.publishAt).toBeNull();
      expect(live?.target).toBe('telegram-md2');
    });

    it('a refusal’s heldSince is the incumbent draft’s createdAt, by value', async (ctx) => {
      await needsWrites(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'hero_body', value: 'human wording', target: 'web', editor: 'neil' }));

      const answer = await store.saveDraft({
        key: 'hero_body',
        value: 'agent wording',
        target: 'web',
        editor: 'agent:claude',
      });
      if (!isRefusal(answer)) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);

      // The draft's createdAt is invisible through `read` — StoreRow carries no
      // metadata — so the proof publishes the incumbent and reads the value
      // back off the published row. `created_at` is never overwritten (§4), so
      // publish preserves exactly the timestamp the refusal reported.
      const id = ok(await store.publish({ key: 'hero_body', editor: 'neil' })).versionId;
      const published = ok(await store.history({ key: 'hero_body' })).rows.find((r) => r.id === id);
      expect(answer.heldSince).toBe(published?.createdAt);
      expect(answer.incumbentEditor).toBe('neil');
    });

    // ── The changesets capability ───────────────────────────────────────────

    it('the change ref attaches, a re-save keeps it, and an explicit null detaches', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const { changeId } = ok(await store.changesets.open({ name: 'spring refresh' }));

      ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));
      const member = async (): Promise<number | null | undefined> =>
        ok(await store.read({ preview: true })).find((r) => r.key === 'hero_headline')?.changesetId;
      // The read row is where membership becomes visible — the `--due` split
      // and a queue's grouped card need no second query.
      expect(await member()).toBe(changeId);

      // An autosave omits the ref. A member that quietly left the group here
      // would be published alone by the next click.
      ok(await store.saveDraft({ key: 'hero_headline', value: 'b', target: 'web', editor: 'neil' }));
      expect(await member()).toBe(changeId);

      ok(await store.saveDraft({ key: 'hero_headline', value: 'c', target: 'web', editor: 'neil', change: null }));
      expect(await member()).toBeNull();
    });

    it('no unvalidated change ref ever reaches a draft', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      // The gate is "not the sentinel", never a positivity test: 0 and
      // negatives find no change and are refused, rather than slipping past
      // validation into a phantom membership. `-1` is in this list because it
      // is the SQL's spelling of "argument absent" — the TS contract has no
      // sentinel, so a caller passing it must be refused like any other
      // non-existent id, never silently read as "leave membership alone".
      for (const change of [0, -1, -5, 999_999_999]) {
        const refused = conflictOf(
          await store.saveDraft({ key: 'hero_headline', value: 'x', target: 'web', editor: 'neil', change }),
        );
        expect(refused.code).toBe('conflict');
        expect(refused.message).toContain('no_change:');
      }
      expect(ok(await store.read({ preview: true }))).toEqual([]);
    });

    it('a grouped draft cannot carry a schedule of its own', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const { changeId } = ok(await store.changesets.open({ name: 'grouped' }));
      ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));

      // A personally stamped member would be due outside its change — exactly
      // the state the clock's demotion sweep exists to clean.
      const refused = conflictOf(
        await store.saveDraft({
          key: 'hero_headline',
          value: 'b',
          target: 'web',
          editor: 'neil',
          publishAt: '2030-01-01T00:00:00.000Z',
        }),
      );
      expect(refused.message).toContain('grouped_schedule:');
    });

    it('the group flip publishes every member keeping its change, and a solo publish drops it', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const { changeId } = ok(await store.changesets.open({ name: 'two members' }));
      for (const key of ['hero_headline', 'hero_body']) {
        ok(await store.saveDraft({ key, value: `${key} grouped`, target: 'web', editor: 'neil', change: changeId }));
      }

      const flipped = ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
      expect(flipped.published.map((m) => m.key).sort()).toEqual(['hero_body', 'hero_headline']);
      // Pinned before the `every`: an empty array satisfies `every` vacuously,
      // so the length is what makes the claim below say anything.
      expect(flipped.published).toHaveLength(2);
      expect(flipped.published.every((m) => m.versionId > 0)).toBe(true);

      // The minted rows KEEP the tag: it is what the before-state derivation,
      // the revert guard and the grouped history all read.
      const live = ok(await store.read());
      expect(live).toHaveLength(2);
      expect(live.every((r) => r.changesetId === changeId)).toBe(true);
      expect(ok(await store.changesets.get({ changeId })).change.status).toBe('published');

      // D1: the same key through the per-key door drops out of its group.
      const solo = ok(await store.changesets.open({ name: 'solo' }));
      ok(
        await store.saveDraft({
          key: 'farewell_notice',
          value: 'alone',
          target: 'web',
          editor: 'neil',
          change: solo.changeId,
        }),
      );
      ok(await store.publish({ key: 'farewell_notice', editor: 'sam' }));
      const minted = ok(await store.read()).find((r) => r.key === 'farewell_notice');
      expect(minted?.changesetId).toBeNull();
      // …and the group no longer counts it as a member.
      expect(ok(await store.changesets.get({ changeId: solo.changeId })).members).toEqual([]);
    });

    it('an empty change cannot publish, and a published one cannot publish again', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const empty = ok(await store.changesets.open({ name: 'nothing in it' }));
      // An open change MAY hold zero members; publishing one may not.
      expect(
        conflictOf(await store.changesets.publishChange({ changeId: empty.changeId, editor: 'sam' })).message,
      ).toContain('no_members:');
      expect(
        conflictOf(await store.changesets.publishChange({ changeId: 999_999_999, editor: 'sam' })).message,
      ).toContain('no_change:');

      const done = ok(await store.changesets.open({ name: 'already out' }));
      ok(
        await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: done.changeId }),
      );
      ok(await store.changesets.publishChange({ changeId: done.changeId, editor: 'sam' }));
      expect(
        conflictOf(await store.changesets.publishChange({ changeId: done.changeId, editor: 'sam' })).message,
      ).toContain('change_closed:');
      // A published change takes no new members either.
      expect(
        conflictOf(
          await store.saveDraft({
            key: 'hero_body',
            value: 'b',
            target: 'web',
            editor: 'neil',
            change: done.changeId,
          }),
        ).message,
      ).toContain('change_closed:');
    });

    it('scheduling stamps the change and its members, and cancel clears both', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const { changeId } = ok(await store.changesets.open({ name: 'scheduled' }));
      ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));

      const when = '2030-06-01T09:00:00.000Z';
      expect(ok(await store.changesets.schedule({ changeId, publishAt: when })).status).toBe('scheduled');
      const change = ok(await store.changesets.get({ changeId })).change;
      expect(change.publishAt).toBe(when);
      // The member drafts carry the stamp too, so migration 1's scheduler index
      // still enumerates them — while the change's column stays authoritative.
      const stampOf = async (key: string): Promise<string | null | undefined> =>
        ok(await store.read({ preview: true })).find((r) => r.key === key)?.publishAt;
      expect(await stampOf('hero_headline')).toBe(when);

      // A member joining a scheduled change inherits the stamp at save.
      ok(await store.saveDraft({ key: 'hero_body', value: 'b', target: 'web', editor: 'neil', change: changeId }));
      expect(await stampOf('hero_body')).toBe(when);

      // Cancel returns it to open and clears every stamp.
      expect(ok(await store.changesets.schedule({ changeId, publishAt: null })).status).toBe('open');
      expect(ok(await store.changesets.get({ changeId })).change.publishAt).toBeNull();
      expect(await stampOf('hero_headline')).toBeNull();
      expect(await stampOf('hero_body')).toBeNull();
    });

    it('a stamp needs a member, a cancel does not, and a published change takes neither', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const empty = ok(await store.changesets.open({ name: 'empty' }));
      // A schedule with nothing to publish is the demotion sweep's food.
      expect(
        conflictOf(
          await store.changesets.schedule({ changeId: empty.changeId, publishAt: '2030-01-01T00:00:00.000Z' }),
        ).message,
      ).toContain('no_members:');
      // The CANCEL arm carries no member requirement — the sweep demotes empty
      // changes through this exact path.
      expect(ok(await store.changesets.schedule({ changeId: empty.changeId, publishAt: null })).status).toBe('open');

      const done = ok(await store.changesets.open({ name: 'published' }));
      ok(
        await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: done.changeId }),
      );
      ok(await store.changesets.publishChange({ changeId: done.changeId, editor: 'sam' }));
      for (const publishAt of ['2030-01-01T00:00:00.000Z', null]) {
        expect(
          conflictOf(await store.changesets.schedule({ changeId: done.changeId, publishAt })).message,
        ).toContain('change_closed:');
      }
    });

    it('abandon hard-deletes an unpublished change, and refuses a published one', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      // A key with published history, so "no version history is lost" is a real
      // claim rather than a vacuous one.
      ok(await store.saveDraft({ key: 'hero_headline', value: 'live', target: 'web', editor: 'neil' }));
      const liveId = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;

      const { changeId } = ok(await store.changesets.open({ name: 'abandoned' }));
      for (const key of ['hero_headline', 'hero_body']) {
        ok(await store.saveDraft({ key, value: `${key} draft`, target: 'web', editor: 'neil', change: changeId }));
      }
      const dropped = ok(await store.changesets.abandon({ changeId }));
      expect(dropped).toEqual({ abandoned: true, droppedDrafts: 2 });
      expect(conflictOf(await store.changesets.get({ changeId })).message).toContain('no_change:');
      // Drafts are not versions: every published row and the active version are
      // exactly where they were.
      expect(ok(await store.read({ preview: true })).filter((r) => r.status === 'draft')).toEqual([]);
      expect(ok(await store.read()).map((r) => r.version)).toEqual([liveId]);

      // A published change is never deleted: its row is the group revert's and
      // the before-preview's read.
      const done = ok(await store.changesets.open({ name: 'published' }));
      ok(await store.saveDraft({ key: 'hero_body', value: 'b', target: 'web', editor: 'neil', change: done.changeId }));
      ok(await store.changesets.publishChange({ changeId: done.changeId, editor: 'sam' }));
      expect(conflictOf(await store.changesets.abandon({ changeId: done.changeId })).message).toContain(
        'change_closed:',
      );
      const still = ok(await store.changesets.get({ changeId: done.changeId }));
      expect(still.change.status).toBe('published');
      expect(still.members.map((m) => m.key)).toEqual(['hero_body']);
    });

    it('discard drops the draft alone, and a second discard is the conflict', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      ok(await store.saveDraft({ key: 'hero_headline', value: 'live', target: 'web', editor: 'neil' }));
      const liveId = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
      const proposal = ok(
        await store.saveDraft({ key: 'hero_headline', value: 'a proposal', target: 'web', editor: 'agent:claude' }),
      );

      // Unconditional and unattributed: the Reject path discards another
      // author's proposal by design.
      const dropped = ok(await store.changesets.discardDraft({ key: 'hero_headline' }));
      // `discarded` is the DELETED DRAFT'S ID, not a count — a count would be
      // the constant 1 forever, and the RPC already returns the id. Asserted
      // here so every write adapter answers it identically.
      expect(dropped.discarded).toBe(proposal.draftId);
      expect(ok(await store.read({ preview: true })).filter((r) => r.status === 'draft')).toEqual([]);
      expect(ok(await store.read()).map((r) => r.version)).toEqual([liveId]);
      expect(conflictOf(await store.changesets.discardDraft({ key: 'hero_headline' })).message).toContain(
        'no_draft:',
      );
      // The one-draft index has nothing left to collide with.
      ok(await store.saveDraft({ key: 'hero_headline', value: 'a fresh one', target: 'web', editor: 'neil' }));
    });

    it('get serves the revert and the preview from one read', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const changeId = await publishedChange(store, ['hero_headline'], ['hero_body']);

      const { change, members } = ok(await store.changesets.get({ changeId }));
      expect(change.status).toBe('published');
      const headline = members.find((m) => m.key === 'hero_headline');
      const body = members.find((m) => m.key === 'hero_body');

      // The member that replaced something carries what it replaced — the id
      // the group revert writes back, and the value the before-preview renders.
      expect(headline?.beforeVersionId).toBeGreaterThan(0);
      expect(headline?.beforeValue).toBe('hero_headline v1');
      expect(headline?.versionId).toBeGreaterThan(headline?.beforeVersionId ?? 0);
      // The first-publish member replaced nothing, and says so.
      expect(body?.beforeVersionId).toBeNull();
      // …and carries no before VALUE at all — absent, never null. The preview
      // resolver reads the absence as "no override row for this key", which is
      // what makes a first-publish member resolve from the snapshot instead of
      // rendering a null.
      expect(body === undefined ? false : 'beforeValue' in body).toBe(false);
    });

    it('a list pages by keyset and filters by status', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const ids: number[] = [];
      for (let i = 1; i <= 4; i += 1) {
        ids.push(ok(await store.changesets.open({ name: `change ${i}` })).changeId);
      }
      ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: ids[0] }));
      ok(await store.changesets.schedule({ changeId: ids[0] as number, publishAt: '2030-01-01T00:00:00.000Z' }));

      const newestFirst = [...ids].reverse();
      const first = ok(await store.changesets.list({ limit: 2 }));
      expect(first.changes.map((c) => c.id)).toEqual(newestFirst.slice(0, 2));
      expect(first.nextBeforeId).toBe(newestFirst[1]);
      const second = ok(await store.changesets.list({ beforeId: first.nextBeforeId ?? undefined, limit: 2 }));
      expect(second.changes.map((c) => c.id)).toEqual(newestFirst.slice(2, 4));
      // The cursor goes null only once a page comes up SHORT — the same rule
      // the version-row pager follows, so a full last page still hands one back.
      const tail = ok(await store.changesets.list({ beforeId: second.nextBeforeId ?? undefined, limit: 2 }));
      expect(tail.changes).toEqual([]);
      expect(tail.nextBeforeId).toBeNull();

      // The clock's own query: the scheduled ones, and only those.
      const scheduled = ok(await store.changesets.list({ status: 'scheduled' }));
      expect(scheduled.changes.map((c) => c.id)).toEqual([ids[0]]);
      expect(scheduled.changes[0]?.publishAt).toBe('2030-01-01T00:00:00.000Z');
      expect(scheduled.changes[0]?.authorKind).toBe('human');
    });

    it('a group revert restores what it can, skips what it cannot, and says which', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      // hero_headline and hero_body have a prior version; farewell_notice's
      // group publish is its key's FIRST, so it has nothing to restore to.
      const changeId = await publishedChange(store, ['hero_headline', 'hero_body'], ['farewell_notice']);

      // Someone publishes over one member after the group went live.
      ok(await store.saveDraft({ key: 'hero_body', value: 'newer still', target: 'web', editor: 'neil' }));
      ok(await store.publish({ key: 'hero_body', editor: 'neil' }));

      const result = ok(await revertChange(store, { changeId, editor: 'sam' }));
      expect(result.reverted.map((m) => m.key)).toEqual(['hero_headline']);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          { key: 'hero_body', locale: 'default', reason: 'stale_active' },
          { key: 'farewell_notice', locale: 'default', reason: 'no_prior_version' },
        ]),
      );
      expect(result.skipped).toHaveLength(2);

      const live = ok(await store.read());
      // The restored member is back to its pre-change wording, as a NEW row.
      expect(live.find((r) => r.key === 'hero_headline')?.value).toBe('hero_headline v1');
      // The newer value on the stale member stayed live — the revert did not
      // trample it.
      expect(live.find((r) => r.key === 'hero_body')?.value).toBe('newer still');
      // And nothing tried a zero-active state on the first-publish member.
      expect(live.find((r) => r.key === 'farewell_notice')?.value).toBe('farewell_notice v2');

      // The group event is stamped — a record, not a claim over current rows.
      expect(ok(await store.changesets.get({ changeId })).change.revertedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Re-running a torn revert is safe: every restored member's active id has
      // moved, so the guard skips it, and the stamp still lands.
      const again = ok(await revertChange(store, { changeId, editor: 'sam' }));
      expect(again.reverted).toEqual([]);
      expect(again.skipped.map((s) => s.reason).sort()).toEqual([
        'no_prior_version',
        'stale_active',
        'stale_active',
      ]);
      expect(ok(await store.read()).find((r) => r.key === 'hero_headline')?.value).toBe('hero_headline v1');
    });

    it('a group revert refuses a change that never published', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const { changeId } = ok(await store.changesets.open({ name: 'still open' }));
      ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));
      // An open change's members are drafts; they were never live, so there is
      // no before-state to restore to.
      expect(conflictOf(await revertChange(store, { changeId, editor: 'sam' })).message).toContain(
        'change_closed:',
      );
    });

    it('a per-key restore never cascades to the change’s other members', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      const changeId = await publishedChange(store, ['hero_headline', 'hero_body']);
      const { members } = ok(await store.changesets.get({ changeId }));
      const one = members.find((m) => m.key === 'hero_headline');

      // The ordinary per-key history restore, unguarded exactly as before.
      ok(await store.revert({ versionId: one?.beforeVersionId as number, editor: 'sam' }));

      const live = ok(await store.read());
      expect(live.find((r) => r.key === 'hero_headline')?.value).toBe('hero_headline v1');
      // The `changeset_id` a published row carries is provenance, not a leash.
      expect(live.find((r) => r.key === 'hero_body')?.value).toBe('hero_body v2');
      expect(ok(await store.changesets.get({ changeId })).change.revertedAt).toBeNull();
    });

    it('runs the whole lifecycle at a non-default locale, leaving the default alone', async (ctx) => {
      await needsChangesets(ctx);
      const store = await scope();
      // Locale is part of key identity everywhere else in this suite; a
      // capability that dropped a locale predicate would be invisible to every
      // other case here, because every other case runs at `default`.
      //
      // hero_headline is live in BOTH locales and the change touches only `de`;
      // hero_body is a `de`-only first publish.
      ok(await store.saveDraft({ key: 'hero_headline', value: 'the English one', target: 'web', editor: 'neil' }));
      ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
      ok(
        await store.saveDraft({
          key: 'hero_headline',
          locale: 'de',
          value: 'die deutsche v1',
          target: 'web',
          editor: 'neil',
        }),
      );
      ok(await store.publish({ key: 'hero_headline', locale: 'de', editor: 'neil' }));

      const { changeId } = ok(await store.changesets.open({ name: 'German refresh' }));
      for (const [key, value] of [
        ['hero_headline', 'die deutsche v2'],
        ['hero_body', 'der neue Text'],
      ] as const) {
        ok(
          await store.saveDraft({
            key,
            locale: 'de',
            value,
            target: 'web',
            editor: 'neil',
            change: changeId,
          }),
        );
      }

      // The grouped draft carries both halves of its identity on the read.
      const drafts = ok(await store.read({ preview: true })).filter((r) => r.status === 'draft');
      expect(drafts.map((r) => `${r.key}/${r.locale}`).sort()).toEqual(['hero_body/de', 'hero_headline/de']);
      expect(drafts.every((r) => r.changesetId === changeId)).toBe(true);
      expect(drafts).toHaveLength(2);

      ok(await store.changesets.schedule({ changeId, publishAt: '2030-01-01T00:00:00.000Z' }));
      ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));

      // Each member is identified by (key, locale), and the before-state is the
      // same key's previous row IN THAT LOCALE — never the default's.
      const { change, members } = ok(await store.changesets.get({ changeId }));
      expect(change.status).toBe('published');
      expect(members.map((m) => `${m.key}/${m.locale}`).sort()).toEqual([
        'hero_body/de',
        'hero_headline/de',
      ]);
      const headline = members.find((m) => m.key === 'hero_headline');
      expect(headline?.beforeValue).toBe('die deutsche v1');
      const body = members.find((m) => m.key === 'hero_body');
      expect(body?.beforeVersionId).toBeNull();
      expect(body === undefined ? false : 'beforeValue' in body).toBe(false);

      // The English row never moved.
      const liveDefault = ok(await store.read({ locale: 'default' }));
      expect(liveDefault.find((r) => r.key === 'hero_headline')?.value).toBe('the English one');
      expect(liveDefault.find((r) => r.key === 'hero_body')).toBeUndefined();

      // And the group revert restores the German one alone.
      const result = ok(await revertChange(store, { changeId, editor: 'sam' }));
      expect(result.reverted.map((m) => `${m.key}/${m.locale}`)).toEqual(['hero_headline/de']);
      expect(result.skipped).toEqual([{ key: 'hero_body', locale: 'de', reason: 'no_prior_version' }]);
      const after = ok(await store.read({ locale: 'de' }));
      expect(after.find((r) => r.key === 'hero_headline' && r.locale === 'de')?.value).toBe('die deutsche v1');
      expect(after.find((r) => r.key === 'hero_headline' && r.locale === 'default')?.value).toBe(
        'the English one',
      );
    });
  });
}

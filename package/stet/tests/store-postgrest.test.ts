/**
 * The two failure modes that cannot be proven against a healthy server: a write
 * whose response is lost, and a read that never answers. Both run offline —
 * `fetchImpl` is injected, so the default suite never touches the network.
 *
 * The dropped-write case is the reason `store-postgrest` has no retry wrapper.
 * A truncated response to a write that actually landed would duplicate the row,
 * so the fake applies the write for real (into an in-process memory store),
 * counts the call, and then throws on the way back.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import {
  createPostgrestStore,
  readStetMeta,
  writeDescriptorVersion,
} from '../adapters/store-postgrest.js';
import { isStoreError } from '../conformance/store.suite.js';

const URL_BASE = 'http://postgrest.test';

describe('store-postgrest, offline fault cases', () => {
  it('a dropped write response surfaces an error and is never retried', async () => {
    const landed = createMemoryStore({ project: 'faults' });
    let rpcCalls = 0;

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rpc/save_content_draft')) {
        rpcCalls += 1;
        const args = JSON.parse(String(init?.body)) as { p_key: string; p_value: unknown };
        // The write lands, exactly as it would on the server…
        await landed.saveDraft({
          key: args.p_key,
          value: args.p_value,
          target: 'web',
          editor: 'neil',
        });
        // …and the response is lost on the way home.
        throw new TypeError('fetch failed: socket hang up');
      }
      // The follow-up read goes to the same in-process store, handing back raw
      // rows the way the database would — the adapter does the mapping.
      return new Response(JSON.stringify(landed.dump()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'faults',
      fetchImpl,
    });

    const answer = await store.saveDraft({
      key: 'hero_headline',
      value: 'landed but unacknowledged',
      target: 'web',
      editor: 'neil',
    });

    expect(isStoreError(answer)).toBe(true);
    if (!isStoreError(answer)) throw new Error('unreachable');
    expect(answer.code).toBe('unreachable');
    expect(answer.message).toContain('socket hang up');

    // One request, one transaction, no second attempt.
    expect(rpcCalls).toBe(1);

    // And exactly one draft row — which is what a retry would have doubled.
    const rows = await store.read({ preview: true });
    if (isStoreError(rows)) throw new Error('expected rows');
    expect(rows.filter((r) => r.status === 'draft')).toHaveLength(1);
    expect(landed.dump().filter((r) => r.state === 'draft')).toHaveLength(1);
  });

  it('a failed read is an absence: a typed error carrying no partial rows', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as typeof globalThis.fetch;

    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'faults',
      fetchImpl,
    });

    const answer = await store.read();
    expect(answer).toEqual({
      storeError: true,
      code: 'unreachable',
      message: 'fetch failed: ECONNREFUSED',
    });
    // No rows at all — a caller cannot mistake a partial read for the truth,
    // and resolution falls back to the committed snapshot.
    expect(Array.isArray(answer)).toBe(false);
  });

  it('a server raise crosses HTTP with its code and its text intact', async () => {
    const body = (message: string, status = 400): Response =>
      new Response(JSON.stringify({ code: 'P0001', details: null, hint: null, message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    const answers: Record<string, Response> = {};
    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'faults',
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        const key = Object.keys(answers).find((fn) => url.includes(fn));
        return key ? answers[key]!.clone() : new Response('[]', { status: 200 });
      }) as typeof globalThis.fetch,
    });

    answers['publish_content_version'] = body('no_draft:hero_headline (default)');
    const noDraft = await store.publish({ key: 'hero_headline', editor: 'neil' });
    expect(noDraft).toMatchObject({ storeError: true, code: 'conflict' });

    answers['rename_content_key'] = body('target_occupied:taken_key');
    // The server's own text first, its SQLSTATE appended: the marker still
    // starts the message, which is what the code table reads.
    expect(await store.rename({ oldKey: 'a', newKey: 'taken_key', editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'conflict',
      message: 'target_occupied:taken_key — code: P0001',
    });

    // The refusal rides its own channel, and its payload survives a colon in
    // the editor name and another three in the timestamp.
    answers['save_content_draft'] = body(
      'draft_held:{"editor":"agent:claude","heldSince":"2026-08-18T09:41:02.117Z"}',
    );
    expect(
      await store.saveDraft({ key: 'k', value: 'v', target: 'web', editor: 'neil' }),
    ).toEqual({
      refused: true,
      incumbentEditor: 'agent:claude',
      heldSince: '2026-08-18T09:41:02.117Z',
    });

    // An unrecognised raise is `unknown`, never silently a conflict.
    answers['publish_content_version'] = body('relation "content_versions" does not exist', 400);
    expect(await store.publish({ key: 'k', editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'unknown',
    });

    // A non-2xx with no parseable server body is a store that did not answer.
    answers['publish_content_version'] = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    expect(await store.publish({ key: 'k', editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'unreachable',
    });

    // A server shutting down mid-deploy answers with a message no table names.
    // SQLSTATE class 57 (and 08) say what it is: an absence, not a mystery —
    // so resolution falls back to the snapshot instead of surfacing a fault.
    answers['publish_content_version'] = new Response(
      JSON.stringify({ code: '57P03', details: null, hint: null, message: 'cannot connect now' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
    expect(await store.publish({ key: 'k', editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'unreachable',
      message: 'cannot connect now — code: 57P03',
    });
  });

  it('the request it builds is the request PostgREST expects', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const store = createPostgrestStore({
      url: `${URL_BASE}/`,
      token: 'test-token',
      project: 'site',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), init });
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof globalThis.fetch,
    });

    await store.read({ keys: ['hero_headline'], locale: 'de', preview: true });
    const read = seen[0]!;
    expect(read.url).toContain(`${URL_BASE}/content_versions?`);
    expect(decodeURIComponent(read.url)).toContain('project=eq."site"');
    expect(decodeURIComponent(read.url)).toContain('or=(is_active.is.true,state.eq.draft)');
    expect(decodeURIComponent(read.url)).toContain('key=in.("hero_headline")');
    // The locale chain, not the locale alone: a `default` row must reach the resolver.
    expect(decodeURIComponent(read.url)).toContain('locale=in.("de","default")');
    expect((read.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');

    await store.recent({ beforeId: 40, limit: 5000 });
    const recent = decodeURIComponent(seen[1]!.url);
    expect(recent).toContain('order=id.desc');
    expect(recent).toContain('id=lt.40');
    // Capped, never unbounded.
    expect(recent).toContain('limit=200');

    // And a limit that is not a number falls back to the default rather than
    // reaching the wire as `limit=NaN`.
    await store.recent({ limit: Number.NaN });
    expect(decodeURIComponent(seen[2]!.url)).toContain('limit=50');

    // RPCs are called by named argument, one POST each.
    await store.saveDraft({
      key: 'hero_headline',
      value: 'v',
      target: 'web',
      editor: 'neil',
      publishAt: '2026-09-01T09:00:00.000Z',
    });
    const save = seen[3]!;
    expect(save.url).toBe(`${URL_BASE}/rpc/save_content_draft`);
    expect(save.init?.method).toBe('POST');
    expect(JSON.parse(String(save.init?.body))).toEqual({
      p_key: 'hero_headline',
      p_value: 'v',
      p_target: 'web',
      p_editor: 'neil',
      p_locale: 'default',
      p_project: 'site',
      p_label: null,
      p_note: null,
      p_publish_at: '2026-09-01T09:00:00.000Z',
      p_force: false,
    });
  });
  it('a 200 that is not rows is a broken contract, never an empty read', async () => {
    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'faults',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'hello from a proxy' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof globalThis.fetch,
    });

    // Reading this as zero rows would leave resolution serving the snapshot
    // for a project that has a database, with nothing warned anywhere.
    const answer = await store.read();
    expect(answer).toMatchObject({ storeError: true, code: 'unknown' });
    expect((answer as { message: string }).message).toContain('unexpected read body');
  });

  it('an RPC that answers with nothing is an error, never version zero', async () => {
    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'faults',
      // The shape a proxy produces when it flushes headers and drops the body.
      fetchImpl: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    const saved = await store.saveDraft({ key: 'k', value: 'v', target: 'web', editor: 'neil' });
    expect(saved).toMatchObject({ storeError: true });
    expect((saved as { message: string }).message).toContain('unexpected RPC answer');

    const published = await store.publish({ key: 'k', editor: 'neil' });
    expect(published).toMatchObject({ storeError: true });

    // A void RPC, though, answers with nothing by design.
    expect(await store.rename({ oldKey: 'a', newKey: 'b', editor: 'neil' })).toEqual({ renamed: true });
  });

  it('an error body arrives whole — the remedy lives in hint and details', async () => {
    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'faults',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            code: 'PGRST202',
            details: 'Searched for the function public.save_content_draft with parameters …',
            hint: 'Perhaps you meant to call another function. Reload the schema cache.',
            message: 'Could not find the function public.save_content_draft in the schema cache',
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )) as typeof globalThis.fetch,
    });

    const answer = await store.saveDraft({ key: 'k', value: 'v', target: 'web', editor: 'neil' });
    expect(answer).toMatchObject({ storeError: true, code: 'unknown' });
    // This adapter documents `notify pgrst, 'reload schema'` as its post-DDL
    // contract; discarding the field that names the remedy would leave the one
    // failure it predicts unactionable.
    const { message } = answer as { message: string };
    expect(message).toContain('Could not find the function');
    expect(message).toContain('PGRST202');
    expect(message).toContain('Reload the schema cache');
  });

  it('a filter value cannot end its own filter', async () => {
    const seen: string[] = [];
    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'site,other',
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(decodeURIComponent(String(input)));
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof globalThis.fetch,
    });

    await store.read({ keys: [String.raw`odd\key`, 'quoted"key'] });
    // Backslashes double first, then quotes escape — the other order would
    // leave an escaped quote's own backslash unescaped.
    expect(seen[0]).toContain(String.raw`key=in.("odd\\key","quoted\"key")`);
    // Project scoping rests on the same quoting: a comma in a project id would
    // otherwise scope the read to two projects that do not exist.
    expect(seen[0]).toContain('project=eq."site,other"');

    await store.history({ key: 'quoted"key', locale: 'de' });
    expect(seen[1]).toContain(String.raw`key=eq."quoted\"key"`);
    expect(seen[1]).toContain('locale=eq."de"');
  });
});

/**
 * The install-time module exports. They are what `stet upgrade` reads and
 * stamps through, they are not interface methods, and every case here runs
 * offline against an injected fetch — the same posture the adapter's own
 * fault cases take.
 */
describe('store-postgrest, the stet_meta helpers', () => {
  it('reads the installed versions off the one row', async () => {
    const seen: string[] = [];
    const meta = await readStetMeta({
      url: URL_BASE,
      token: 'test-token',
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(decodeURIComponent(String(input)));
        return new Response(JSON.stringify([{ schema_version: 1, descriptor_version: '3' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });

    expect(meta).toEqual({ schemaVersion: 1, descriptorVersion: '3' });
    expect(seen[0]).toContain('/stet_meta?id=eq.1');
  });

  it('reports an unversioned database as null rather than as a failure', async () => {
    const missing = { code: 'PGRST205', message: 'Could not find the table' };
    // The table is not there at all: migration 1 has never been applied, which
    // `upgrade` turns into "migration 1 pending", never into "up to date".
    for (const response of [
      new Response(JSON.stringify(missing), { status: 404 }),
      new Response('[]', { status: 200 }),
    ]) {
      const meta = await readStetMeta({
        url: URL_BASE,
        token: 'test-token',
        fetchImpl: (async () => response.clone()) as typeof globalThis.fetch,
      });
      expect(meta).toBeNull();
    }
  });

  it('a stamp that changed no row is a failure, never a quiet success', async () => {
    // Row level security is enabled on stet_meta, and a blocked role's PATCH
    // returns 204 having changed nothing. `Prefer: return=representation` is
    // what makes that visible, and a row count other than 1 is the failure.
    let sentPrefer: string | undefined;
    const blocked = writeDescriptorVersion(
      {
        url: URL_BASE,
        token: 'test-token',
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          sentPrefer = (init?.headers as Record<string, string> | undefined)?.['Prefer'];
          return new Response('[]', { status: 200 });
        }) as typeof globalThis.fetch,
      },
      '3',
    );
    await expect(blocked).rejects.toThrow(/row level security|expected 1/);
    expect(sentPrefer).toBe('return=representation');

    let body: string | undefined;
    await writeDescriptorVersion(
      {
        url: URL_BASE,
        token: 'test-token',
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          body = String(init?.body);
          return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
        }) as typeof globalThis.fetch,
      },
      '3',
    );
    expect(body).toContain('"descriptor_version":"3"');
    // REST has no now(), and a column default fires only on insert.
    expect(body).toContain('"updated_at"');
  });
});

/**
 * The wire itself. These are the claims no other adapter can make for this one:
 * PostgREST calls functions by NAME, which is what lets an absent argument be
 * genuinely omitted, and the two-statement writes have a pinned ORDER whose
 * reversal is a real bug the conformance suite cannot see — both orders look
 * identical in a store where nothing interleaves.
 */
describe('store-postgrest, the wire shapes', () => {
  interface Sent {
    url: string;
    method: string;
    body: unknown;
    prefer?: string;
  }

  /** Records every request, answering each with a canned body chosen by path. */
  function recorder(answers: (url: string) => unknown): {
    store: ReturnType<typeof createPostgrestStore>;
    sent: Sent[];
  } {
    const sent: Sent[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        ...(headers['Prefer'] === undefined ? {} : { prefer: headers['Prefer'] }),
      });
      return new Response(JSON.stringify(answers(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    return {
      store: createPostgrestStore({
        url: URL_BASE,
        token: 'test-token',
        project: 'wire',
        fetchImpl,
      }),
      sent,
    };
  }

  /** A change row as the table hands it over, with the project the read checks. */
  function changeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 5,
      name: 'spring',
      note: null,
      status: 'open',
      author_kind: 'human',
      publish_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      reverted_at: null,
      project: 'wire',
      ...over,
    };
  }

  it('omits p_change entirely when the caller left membership alone', async () => {
    const { store, sent } = recorder(() => 7);
    await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil' });
    // Absent must not travel as null: null DETACHES, and a save that silently
    // detached on every autosave would empty a change key by key.
    expect('p_change' in (sent[0]?.body as Record<string, unknown>)).toBe(false);

    // An explicit null does travel, because it means something different.
    await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: null });
    expect((sent[1]?.body as Record<string, unknown>)['p_change']).toBeNull();

    await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: 4 });
    expect((sent[2]?.body as Record<string, unknown>)['p_change']).toBe(4);
  });

  it('omits the revert guard unless the group revert set it', async () => {
    const { store, sent } = recorder(() => 9);
    await store.revert({ versionId: 3, editor: 'neil' });
    expect('p_expect_active' in (sent[0]?.body as Record<string, unknown>)).toBe(false);
    await store.revert({ versionId: 3, editor: 'neil', expectActive: 11 });
    expect((sent[1]?.body as Record<string, unknown>)['p_expect_active']).toBe(11);
  });

  it('schedules the change row before the member stamps, and cancels in the same order', async () => {
    const { store, sent } = recorder((url) =>
      url.includes('/content_versions') ? [{ id: 1 }] : [changeRow()],
    );

    await store.changesets.schedule({ changeId: 5, publishAt: '2030-01-01T00:00:00.000Z' });
    const writes = sent.filter((s) => s.method === 'PATCH');
    // The change row FIRST. Reversed, a member attaching between the two
    // requests inherits a stamp the operator just cancelled, and the clock
    // publishes a cancelled change.
    expect(writes[0]?.url).toContain('/changesets?id=eq.5');
    expect(writes[1]?.url).toContain('/content_versions');
    expect(writes[1]?.url).toContain('changeset_id=eq.5');
    expect(writes[1]?.url).toContain('state=eq.draft');
    // Both writes read back what they touched, so a row-level-security block
    // cannot pass as a quiet success.
    expect(writes.every((w) => w.prefer === 'return=representation')).toBe(true);

    sent.length = 0;
    await store.changesets.schedule({ changeId: 5, publishAt: null });
    const cancel = sent.filter((s) => s.method === 'PATCH');
    expect(cancel[0]?.url).toContain('/changesets?id=eq.5');
    expect(cancel[0]?.body).toEqual({ status: 'open', publish_at: null });
    expect(cancel[1]?.url).toContain('/content_versions');
    expect(cancel[1]?.body).toEqual({ publish_at: null });
  });

  it('abandons the member drafts before the change row', async () => {
    const { store, sent } = recorder((url) =>
      url.includes('/content_versions') ? [{ id: 1 }, { id: 2 }] : [changeRow({ id: 6 })],
    );

    expect(await store.changesets.abandon({ changeId: 6 })).toEqual({
      abandoned: true,
      droppedDrafts: 2,
    });
    const deletes = sent.filter((s) => s.method === 'DELETE');
    // Drafts first, so a torn abandon leaves an empty open change — harmless
    // and re-abandonable — never drafts pointing at a row that is gone.
    expect(deletes[0]?.url).toContain('/content_versions');
    expect(deletes[1]?.url).toContain('/changesets?id=eq.6');
  });

  it('carries the published guard in the write itself, not only in the read before it', async () => {
    // Over HTTP the guard read is a whole round-trip from the write, so a
    // publish_change committing in between would let these resurrect or delete
    // a published change. The predicate travels WITH the write.
    const { store, sent } = recorder((url) =>
      url.includes('/content_versions') ? [{ id: 1 }] : [changeRow({ id: 7 })],
    );

    await store.changesets.schedule({ changeId: 7, publishAt: '2030-01-01T00:00:00.000Z' });
    await store.changesets.schedule({ changeId: 7, publishAt: null });
    await store.changesets.abandon({ changeId: 7 });

    const guarded = sent.filter(
      (s) => (s.method === 'PATCH' || s.method === 'DELETE') && s.url.includes('/changesets?'),
    );
    expect(guarded).toHaveLength(3);
    for (const write of guarded) {
      expect(`${write.method} ${write.url}`).toContain('status=neq.published');
    }
  });

  it('reads a zero-row guarded write as the change_closed conflict, never as success', async () => {
    // PostgREST answers a predicate that matched nothing with an empty array
    // and a 200. Taken as success, `abandoned: true` would be a lie about a
    // change that is still there — and a resurrected change would report a new
    // status it never took.
    const { store } = recorder((url) =>
      url.includes('/content_versions') ? [{ id: 1 }] : url.includes('status=neq.published') ? [] : [changeRow({ id: 7 })],
    );

    for (const answer of [
      await store.changesets.schedule({ changeId: 7, publishAt: '2030-01-01T00:00:00.000Z' }),
      await store.changesets.schedule({ changeId: 7, publishAt: null }),
      await store.changesets.abandon({ changeId: 7 }),
    ]) {
      expect(answer).toMatchObject({ storeError: true, code: 'conflict' });
      expect((answer as { message: string }).message).toContain('change_closed:7');
    }
  });

  it('calls publish_change by name and maps its row set', async () => {
    const { store, sent } = recorder(() => [
      { o_key: 'hero_headline', o_locale: 'default', o_version_id: 12 },
      { o_key: 'hero_body', o_locale: 'de', o_version_id: 13 },
    ]);
    const answer = await store.changesets.publishChange({ changeId: 5, editor: 'sam' });
    expect(sent[0]?.url).toContain('/rpc/publish_change');
    expect(sent[0]?.body).toEqual({ p_change: 5, p_editor: 'sam', p_project: 'wire' });
    // A row set, not a scalar: the minted member per row, so a surface fires
    // its per-member events with no second read.
    expect(answer).toEqual({
      published: [
        { key: 'hero_headline', locale: 'default', versionId: 12 },
        { key: 'hero_body', locale: 'de', versionId: 13 },
      ],
    });
  });

  it('reads each published member’s before with a bounded limit=1 query', async () => {
    const { store, sent } = recorder((url) => {
      if (url.includes('/changesets')) return [changeRow({ id: 7, status: 'published' })];
      if (url.includes('order=id.desc')) return [{ id: 40, value: 'the old wording' }];
      return [{ id: 41, key: 'hero_headline', locale: 'default' }];
    });

    expect(await store.changesets.get({ changeId: 7 })).toEqual({
      change: expect.objectContaining({ id: 7, status: 'published' }),
      members: [
        {
          key: 'hero_headline',
          locale: 'default',
          versionId: 41,
          beforeVersionId: 40,
          beforeValue: 'the old wording',
        },
      ],
    });
    // §6.1's selection, spelled on the wire: the key's previous published row
    // below the minted id. N+1 and bounded by member count — stated in the
    // design rather than optimized away.
    const before = sent.find((s) => s.url.includes('order=id.desc'));
    expect(before?.url).toContain('state=eq.published');
    expect(before?.url).toContain('id=lt.41');
    expect(before?.url).toContain('limit=1');
  });

  it('keeps both scoping filters on a destructive write when the project name is hostile', async () => {
    // `filterValue` quotes a value; it does NOT percent-encode it. A `#` in an
    // interpolated query string starts the URL fragment and truncates
    // everything after it — here that is `changeset_id` and `state`, leaving a
    // PATCH and a DELETE scoped to almost nothing. Both are built through
    // URLSearchParams for exactly this reason.
    const sent: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(
        JSON.stringify(
          String(input).includes('/changesets?id=')
            ? [changeRow({ id: 8, project: 'a#b&c=d' })]
            : [{ id: 1 }],
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    const store = createPostgrestStore({
      url: URL_BASE,
      token: 'test-token',
      project: 'a#b&c=d',
      fetchImpl,
    });

    await store.changesets.schedule({ changeId: 8, publishAt: '2030-01-01T00:00:00.000Z' });
    await store.changesets.abandon({ changeId: 8 });

    const destructive = sent.filter(
      (s) => s.startsWith('PATCH https://') || s.startsWith('DELETE https://') || s.includes('/content_versions'),
    );
    const writes = destructive.filter((s) => s.startsWith('PATCH ') || s.startsWith('DELETE '));
    const scoped = writes.filter((s) => s.includes('/content_versions'));
    expect(scoped).toHaveLength(2);
    for (const request of scoped) {
      // No raw `#` or `&` survives into the query: the fragment cannot start
      // and no extra parameter can be injected.
      const query = request.slice(request.indexOf('?') + 1);
      expect(query).not.toContain('#');
      expect(query).toContain('changeset_id=eq.8');
      expect(query).toContain('state=eq.draft');
      expect(query).toContain('project=eq.');
      // The hostile characters travel percent-encoded.
      expect(query).toContain('%23');
      expect(query).toContain('%26');
    }
  });

  it('maps discard_content_draft’s returned id straight through', async () => {
    const { store, sent } = recorder(() => 77);
    // The third write adapter's half of the same claim the conformance suite
    // makes for memory and pg: `discarded` is the deleted draft's ID, never a
    // count. A count here would be the constant 1 forever.
    expect(await store.changesets.discardDraft({ key: 'hero_headline', locale: 'de' })).toEqual({
      discarded: 77,
    });
    expect(sent[0]?.url).toContain('/rpc/discard_content_draft');
    expect(sent[0]?.body).toEqual({ p_key: 'hero_headline', p_locale: 'de', p_project: 'wire' });
  });

  it('carries changeset_id in every content_versions select', async () => {
    const { store, sent } = recorder(() => []);
    await store.read();
    await store.history({ key: 'hero_headline' });
    await store.recent();
    // Silent by nature: a select that forgot the column would hand back rows
    // whose membership reads undefined, and the `--due` split would treat every
    // grouped draft as ungrouped.
    for (const request of sent) expect(request.url).toContain('changeset_id');
  });
});

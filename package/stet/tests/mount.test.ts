/**
 * `createStetHandler` — the Bearer-authenticated HTTP mount. A typed spy
 * StoreAdapter records the RPC each route delegates to (and with what params),
 * so these assert routing, the auth surface, the undeclared-key/editor guards,
 * the descriptor-sourced `target`, and the render/test-send edges — the store's
 * own behavior is proven in the store suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { createSnapshotStore } from '../adapters/store-snapshot.js';
import { validateValue } from '../cli/validate.js';
import { Report } from '../cli/report.js';
import { miniDescriptor } from '../conformance/fixture.js';
import { bearerMatches, createStetHandler, type PublishEvent } from '../server/mount.js';
import type {
  ChangesetOps,
  ChangesetRow,
  DraftRefusal,
  NotSupported,
  StoreAdapter,
  StoreError,
} from '../src/store.js';
import type { StoreRow } from '../src/resolve.js';

const TOKEN_ENV = 'STET_MOUNT_TEST_TOKEN';
const TOKEN = 'sekret-token';
const descriptor = miniDescriptor();

beforeEach(() => {
  process.env[TOKEN_ENV] = TOKEN;
});
afterEach(() => {
  delete process.env[TOKEN_ENV];
});

interface Recorded {
  method: string;
  arg: unknown;
}
/** A change row the spy hands back, so `get` and `list` have something shaped. */
const A_CHANGE: ChangesetRow = {
  id: 3,
  name: 'spring copy',
  note: null,
  status: 'published',
  authorKind: 'human',
  publishAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  revertedAt: null,
};

/** The saveDraft calls among the recorded ones: the draft route reads the store for its content gate first. */
const saves = (calls: Recorded[]): Recorded[] => calls.filter((c) => c.method === 'saveDraft');

function makeStore(
  over: Partial<StoreAdapter> = {},
  changesetsOver: Partial<ChangesetOps> = {},
): { store: StoreAdapter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  /**
   * The recorder wraps whichever implementation WON — default or override — so
   * a test supplying its own is still recorded. Wrapping before the merge (the
   * obvious shape) silently drops recording for exactly the cases that override,
   * which is where the interesting assertions live.
   */
  const wrap = <A, R>(method: string, impl: (a: A) => Promise<R>): ((a: A) => Promise<R>) => {
    return async (a: A): Promise<R> => {
      calls.push({ method, arg: a });
      return impl(a);
    };
  };
  const recordAll = <T extends Record<string, (a: never) => Promise<unknown>>>(
    prefix: string,
    impls: T,
  ): T =>
    Object.fromEntries(
      Object.entries(impls).map(([name, fn]) => [name, wrap(`${prefix}${name}`, fn as (a: never) => Promise<unknown>)]),
    ) as T;

  // The capability is recorded method by method, so a route that reached the
  // wrong one is a failed assertion rather than a passing test.
  const changesets = recordAll('changesets.', {
    open: async () => ({ changeId: 3 }),
    list: async () => ({ changes: [A_CHANGE], nextBeforeId: null }),
    get: async () => ({ change: A_CHANGE, members: [] }),
    schedule: async (p: { publishAt: string | null }) => ({
      status: p.publishAt === null ? ('open' as const) : ('scheduled' as const),
    }),
    publishChange: async () => ({ published: [] }),
    abandon: async () => ({ abandoned: true as const, droppedDrafts: 2 }),
    discardDraft: async () => ({ discarded: 5 }),
    markReverted: async () => ({ revertedAt: '2026-02-02T00:00:00.000Z' }),
    ...changesetsOver,
  } as unknown as Record<string, (a: never) => Promise<unknown>>) as unknown as ChangesetOps;

  const core = recordAll('', {
    read: async () => [],
    saveDraft: async () => ({ draftId: 1 }),
    publish: async () => ({ versionId: 7 }),
    revert: async () => ({ versionId: 8 }),
    rename: async () => ({ renamed: true as const }),
    history: async () => ({ rows: [], nextBeforeId: null }),
    recent: async () => ({ rows: [], nextBeforeId: null }),
    ...over,
  } as unknown as Record<string, (a: never) => Promise<unknown>>);

  const store: StoreAdapter = {
    project: 'test',
    canApplyDDL: false,
    ...(core as unknown as Pick<
      StoreAdapter,
      'read' | 'saveDraft' | 'publish' | 'revert' | 'rename' | 'history' | 'recent'
    >),
    changesets,
    contacts: createSnapshotStore({ project: 'test' }).contacts,
  };
  return { store, calls };
}

/** A response's JSON body as a record — `Response.json()` hands back `unknown`. */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const get = (path: string, auth: string | null = `Bearer ${TOKEN}`): Request =>
  new Request(`https://host${path}`, { headers: auth === null ? {} : { authorization: auth } });
const post = (path: string, body: unknown, auth: string | null = `Bearer ${TOKEN}`): Request =>
  new Request(`https://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
    body: JSON.stringify(body),
  });

describe('auth', () => {
  it('rejects a wrong or absent Bearer with 401 before any store call', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.GET(get('/api/stet/keys', 'Bearer wrong'))).status).toBe(401);
    expect((await h.GET(get('/api/stet/keys', null))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects when the configured env var is unset or empty, even with an empty Bearer', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    delete process.env[TOKEN_ENV];
    expect((await h.GET(get('/api/stet/keys', 'Bearer '))).status).toBe(401);
    process.env[TOKEN_ENV] = '';
    expect((await h.GET(get('/api/stet/keys', 'Bearer '))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('a multibyte length-mismatch is a clean 401, never a thrown 500', async () => {
    // 6 chars, 7 bytes (the last char is 2 bytes) vs a 6-char/6-byte Bearer:
    // guarding on BYTE length keeps timingSafeEqual from throwing on unequal buffers.
    process.env[TOKEN_ENV] = `aaaaa${String.fromCharCode(233)}`;
    const { store } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.GET(get('/api/stet/keys', 'Bearer aaaaaa'));
    expect(res.status).toBe(401);
  });

  it('P2-5 — a trailing newline in the configured token is trimmed, so a .env token still authenticates', async () => {
    // A secret file / `.env` value carries a trailing newline the HTTP layer
    // strips from the header; an untrimmed compare fails on the byte-length guard.
    process.env[TOKEN_ENV] = `${TOKEN}\n`;
    const { store } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.GET(get('/api/stet/keys', `Bearer ${TOKEN}`))).status).toBe(200);
  });

  it('P3-15 — a token with internal spaces authenticates, and the Bearer scheme is case-insensitive', async () => {
    const spacey = 'tok en with spaces';
    process.env[TOKEN_ENV] = spacey;
    const { store } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.GET(get('/api/stet/keys', `Bearer ${spacey}`))).status).toBe(200);
    expect((await h.GET(get('/api/stet/keys', `bearer ${spacey}`))).status).toBe(200);
  });

  /**
   * The compare itself, called directly — the mount's cases above reach it
   * through a handler, and the local dashboard's server reaches it on its own.
   * The SAME-LENGTH wrong token is the case that tells a constant-time compare
   * from a byte-length test: nothing else here would notice the difference.
   */
  it('bearerMatches refuses a same-length wrong token, a length mismatch and an empty expected', () => {
    expect(bearerMatches(get('/api/stet/keys', `Bearer ${TOKEN}`), TOKEN)).toBe(true);
    // A trailing newline on the EXPECTED side is trimmed — the secret-file shape.
    expect(bearerMatches(get('/api/stet/keys', `Bearer ${TOKEN}`), `${TOKEN}\n`)).toBe(true);
    expect(bearerMatches(get('/api/stet/keys', 'Bearer sekret-tokeM'), TOKEN)).toBe(false);
    expect(bearerMatches(get('/api/stet/keys', 'Bearer short'), TOKEN)).toBe(false);
    expect(bearerMatches(get('/api/stet/keys', 'Bearer '), '')).toBe(false);
    expect(bearerMatches(get('/api/stet/keys', 'Bearer x'), undefined)).toBe(false);
    expect(bearerMatches(get('/api/stet/keys', null), TOKEN)).toBe(false);
  });
});

describe('POST writes', () => {
  it('draft forwards the full body incl. force, with target from the descriptor', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.POST(
      post('/api/stet/draft', {
        key: 'hero_headline',
        value: 'Hi',
        editor: 'ada',
        locale: 'default',
        label: 'L',
        note: 'N',
        publishAt: '2026-01-01T00:00:00Z',
        force: true,
      }),
    );
    expect(res.status).toBe(200);
    const call = calls.find((c) => c.method === 'saveDraft');
    expect(call?.arg).toEqual({
      key: 'hero_headline',
      value: 'Hi',
      target: descriptor.keys['hero_headline']?.target,
      editor: 'ada',
      locale: 'default',
      label: 'L',
      note: 'N',
      publishAt: '2026-01-01T00:00:00Z',
      force: true,
    });
  });

  it('publish forwards locale and fires onPublish with the descriptor target', async () => {
    const events: PublishEvent[] = [];
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const res = await h.POST(post('/api/stet/publish', { key: 'hero_headline', editor: 'ada', locale: 'default' }));
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === 'publish')?.arg).toEqual({ key: 'hero_headline', editor: 'ada', locale: 'default' });
    expect(events).toEqual([{ key: 'hero_headline', target: descriptor.keys['hero_headline']?.target, versionId: 7 }]);
  });

  it('revert reads key from its body, checks it against the version, and fires onPublish', async () => {
    const events: PublishEvent[] = [];
    const { store, calls } = makeStore({
      history: async () => ({ rows: [{ id: 3, key: 'hero_headline' }], nextBeforeId: null }) as never,
    });
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const res = await h.POST(post('/api/stet/revert', { key: 'hero_headline', versionId: 3, editor: 'ada' }));
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === 'history')?.arg).toEqual({ key: 'hero_headline', beforeId: 4, limit: 1 });
    expect(calls.find((c) => c.method === 'revert')?.arg).toEqual({ versionId: 3, editor: 'ada' });
    expect(events).toEqual([{ key: 'hero_headline', target: descriptor.keys['hero_headline']?.target, versionId: 8 }]);
  });

  it("refuses a revert whose key is not the version's own, writing nothing (F76)", async () => {
    // Two keys, each published twice, in a real store: the body's key decides
    // nothing but the event, so a mismatch must never reach the revert write.
    const store = createMemoryStore({ project: 'test' });
    const ids: Record<string, number[]> = { hero_headline: [], hero_body: [] };
    for (const value of ['first', 'second']) {
      for (const key of ['hero_body', 'hero_headline']) {
        await store.saveDraft({ key, value: `${key} ${value}`, target: 'web', editor: 'ada' });
        const published = await store.publish({ key, editor: 'ada' });
        ids[key]?.push((published as { versionId: number }).versionId);
      }
    }
    const events: PublishEvent[] = [];
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const older = ids['hero_headline']?.[0] as number;
    const before = await store.read();
    const res = await h.POST(post('/api/stet/revert', { key: 'hero_body', versionId: older, editor: 'ada' }));
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: `version ${older} is not a published version of hero_body` });
    expect(await store.read()).toEqual(before);
    expect(events).toEqual([]);
    const right = await h.POST(post('/api/stet/revert', { key: 'hero_headline', versionId: older, editor: 'ada' }));
    expect(right.status).toBe(200);
    const restored = (await bodyOf(right))['versionId'];
    expect(events).toEqual([{ key: 'hero_headline', target: 'web', versionId: restored }]);
    expect(((await store.read()) as StoreRow[]).find((row) => row.key === 'hero_headline')?.value).toBe('hero_headline first');
  });

  it('refuses a revert naming a draft or a version that does not exist, writing nothing and firing nothing', async () => {
    const store = createMemoryStore({ project: 'test' });
    await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'ada' });
    await store.publish({ key: 'hero_headline', editor: 'ada' });
    const draft = (await store.saveDraft({ key: 'hero_headline', value: 'unpublished', target: 'web', editor: 'ada' })) as { draftId: number };
    const events: PublishEvent[] = [];
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const before = await store.read();
    for (const versionId of [draft.draftId, 999]) {
      const res = await h.POST(post('/api/stet/revert', { key: 'hero_headline', versionId, editor: 'ada' }));
      expect({ versionId, status: res.status }).toEqual({ versionId, status: 400 });
      expect(await bodyOf(res)).toEqual({ error: `version ${versionId} is not a published version of hero_headline` });
      expect(await store.read()).toEqual(before);
      expect(events).toEqual([]);
    }
  });

  it('rejects an undeclared key on draft/publish/revert with 400, RPC never called', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    for (const [path, extra] of [
      ['/api/stet/draft', { value: 'x' }],
      ['/api/stet/publish', {}],
      ['/api/stet/revert', { versionId: 1 }],
    ] as const) {
      const res = await h.POST(post(path, { key: 'nope_not_a_key', editor: 'ada', ...extra }));
      expect(res.status).toBe(400);
    }
    expect(calls.some((c) => ['saveDraft', 'publish', 'revert'].includes(c.method))).toBe(false);
  });

  it('rejects a write with no editor with 400 before the RPC', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    for (const path of ['/api/stet/draft', '/api/stet/publish', '/api/stet/revert']) {
      const res = await h.POST(post(path, { key: 'hero_headline', versionId: 1, value: 'x' }));
      expect(res.status).toBe(400);
    }
    expect(calls.some((c) => ['saveDraft', 'publish', 'revert'].includes(c.method))).toBe(false);
  });

  it('P2-6 — a whitespace-only editor is rejected 400 before the RPC (never recorded)', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    for (const path of ['/api/stet/draft', '/api/stet/publish', '/api/stet/revert']) {
      const res = await h.POST(post(path, { key: 'hero_headline', versionId: 1, value: 'x', editor: '   ' }));
      expect(res.status).toBe(400);
    }
    expect(calls.some((c) => ['saveDraft', 'publish', 'revert'].includes(c.method))).toBe(false);
  });
});

describe('the shared HTTP pieces', () => {
  it('reads an array body as {} and refuses its first missing field', async () => {
    // `readJson` is server/http.ts' one lenient reader now: an array is not an
    // object, so a draft posted as one names what it lacks.
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.POST(post('/api/stet/draft', [{ key: 'hero_headline', value: 'x', editor: 'ada' }]));
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'editor is required' });
    expect(calls.some((c) => c.method === 'saveDraft')).toBe(false);
  });

  it('never lets a reply be cached', async () => {
    const { store } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.GET(get('/api/stet/recent'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('test-send', () => {
  it('renders the template draft and sends it', async () => {
    const rendered: Array<{ template: string; hasOverride: boolean }> = [];
    const sent: Array<{ html: string; to: string }> = [];
    const { store } = makeStore();
    const h = createStetHandler({
      store,
      descriptor,
      auth: TOKEN_ENV,
      renderEmail: async (template, o) => (rendered.push({ template, hasOverride: !!o?.override }), '<html>hi</html>'),
      sendTest: async (html, to) => void sent.push({ html, to }),
    });
    const res = await h.POST(post('/api/stet/test-send', { template: 'welcome', to: 'a@b.co' }));
    expect(res.status).toBe(200);
    expect(rendered).toEqual([{ template: 'welcome', hasOverride: true }]);
    expect(sent).toEqual([{ html: '<html>hi</html>', to: 'a@b.co' }]);
  });

  it('400s an unknown template before any render or send', async () => {
    let rendered = false;
    const { store } = makeStore();
    const h = createStetHandler({
      store,
      descriptor,
      auth: TOKEN_ENV,
      renderEmail: async () => ((rendered = true), ''),
      sendTest: async () => {},
    });
    const res = await h.POST(post('/api/stet/test-send', { template: 'ghost', to: 'a@b.co' }));
    expect(res.status).toBe(400);
    expect(rendered).toBe(false);
  });

  it('501s when sendTest is unwired and 400s when to is missing', async () => {
    const { store } = makeStore();
    const noSend = createStetHandler({ store, descriptor, auth: TOKEN_ENV, renderEmail: async () => '' });
    expect((await noSend.POST(post('/api/stet/test-send', { template: 'welcome', to: 'a@b.co' }))).status).toBe(501);
    const wired = createStetHandler({ store, descriptor, auth: TOKEN_ENV, renderEmail: async () => '', sendTest: async () => {} });
    expect((await wired.POST(post('/api/stet/test-send', { template: 'welcome' }))).status).toBe(400);
  });

  it('P2-8 — a recipient containing a CR/LF is rejected 400 before any send (header injection)', async () => {
    let sent = false;
    const { store } = makeStore();
    const h = createStetHandler({
      store,
      descriptor,
      auth: TOKEN_ENV,
      renderEmail: async () => '<html>hi</html>',
      sendTest: async () => void (sent = true),
    });
    const res = await h.POST(post('/api/stet/test-send', { template: 'welcome', to: 'a@b.co\r\nBcc: evil@x.co' }));
    expect(res.status).toBe(400);
    expect(sent).toBe(false);
  });
});

describe('GET reads', () => {
  it('keys returns the descriptor and does a PREVIEW read (its sole duty)', async () => {
    const { store, calls } = makeStore({
      read: async () => [
        {
          key: 'hero_headline',
          locale: 'default',
          status: 'draft' as const,
          value: 'grouped',
          version: 4,
          target: 'web',
          publishAt: null,
          changesetId: 3,
        },
      ],
    });
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.GET(get('/api/stet/keys'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      descriptor: { version: number };
      rows: { changesetId: number | null }[];
    };
    expect(body.descriptor.version).toBe(descriptor.version);
    expect(Array.isArray(body.rows)).toBe(true);
    // The rows pass straight through, so a dashboard receives `changesetId`
    // for free — the §2.3 ledger's one silent consumer on this route.
    expect(body.rows[0]?.changesetId).toBe(3);
    expect(calls.find((c) => c.method === 'read')?.arg).toEqual({ preview: true });
  });

  it('history requires a key and forwards keyset paging', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.GET(get('/api/stet/history'))).status).toBe(400);
    const res = await h.GET(get('/api/stet/history?key=hero_headline&locale=default&beforeId=10&limit=5'));
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === 'history')?.arg).toEqual({ key: 'hero_headline', locale: 'default', beforeId: 10, limit: 5 });
  });

  it('recent delegates and forwards paging', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.GET(get('/api/stet/recent?beforeId=20&limit=2'))).status).toBe(200);
    expect(calls.find((c) => c.method === 'recent')?.arg).toEqual({ beforeId: 20, limit: 2 });
  });

  it('render proxies renderEmail; 400 on absent/non-numeric params; 501 when unwired', async () => {
    const { store } = makeStore();
    const rendered: Array<{ template: string; version: number | undefined }> = [];
    const h = createStetHandler({
      store,
      descriptor,
      auth: TOKEN_ENV,
      renderEmail: async (template, o) => (rendered.push({ template, version: o?.version }), '<p>mail</p>'),
    });
    const ok = await h.GET(get('/api/stet/render?template=welcome&version=3'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<p>mail</p>');
    expect(rendered).toEqual([{ template: 'welcome', version: 3 }]);
    expect((await h.GET(get('/api/stet/render'))).status).toBe(400); // no template
    expect((await h.GET(get('/api/stet/render?template=welcome&version=abc'))).status).toBe(400); // non-numeric

    const unwired = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await unwired.GET(get('/api/stet/render?template=welcome'))).status).toBe(501);
  });

  it('P2-7 — render 400s a template not in the descriptor, before renderEmail is called', async () => {
    let rendered = false;
    const { store } = makeStore();
    const h = createStetHandler({
      store,
      descriptor,
      auth: TOKEN_ENV,
      renderEmail: async () => ((rendered = true), '<p>x</p>'),
    });
    const res = await h.GET(get('/api/stet/render?template=ghost'));
    expect(res.status).toBe(400);
    expect(rendered).toBe(false);
  });
});

describe('hooks and store-result mapping', () => {
  const refusal: DraftRefusal = { refused: true, incumbentEditor: 'bob', heldSince: '2026-01-01T00:00:00Z' };
  const storeErr = (code: StoreError['code']): StoreError => ({ storeError: true, code, message: 'boom' });
  const notSupported: NotSupported = { notSupported: true, method: 'publish' };

  it('an async onPublish that rejects never crashes the host; publish still returns 200', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown): void => void seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { store } = makeStore();
      const h = createStetHandler({
        store,
        descriptor,
        auth: TOKEN_ENV,
        onPublish: async () => {
          throw new Error('digest boom');
        },
      });
      const res = await h.POST(post('/api/stet/publish', { key: 'hero_headline', editor: 'ada' }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0)); // give any escaped rejection a macrotask to surface
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('onPublish does NOT fire when publish returns a StoreError', async () => {
    const events: PublishEvent[] = [];
    const { store } = makeStore({ publish: async () => storeErr('conflict') });
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const res = await h.POST(post('/api/stet/publish', { key: 'hero_headline', editor: 'ada' }));
    expect(res.status).toBe(409);
    expect(events).toEqual([]);
  });

  it('a draft DraftRefusal maps to 409', async () => {
    const { store } = makeStore({ saveDraft: async () => refusal });
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada' }));
    expect(res.status).toBe(409);
  });

  it('StoreError codes map: conflict→409, unreachable→503, unknown→502', async () => {
    for (const [code, status] of [
      ['conflict', 409],
      ['unreachable', 503],
      ['unknown', 502],
    ] as const) {
      const { store } = makeStore({ saveDraft: async () => storeErr(code) });
      const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
      const res = await h.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada' }));
      expect(res.status).toBe(status);
    }
  });

  it('a NotSupported result maps to 501', async () => {
    const { store } = makeStore({ publish: async () => notSupported });
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.POST(post('/api/stet/publish', { key: 'hero_headline', editor: 'ada' }));
    expect(res.status).toBe(501);
  });

  it("a StoreError or NotSupported from revert's ownership read maps as it does from a write, and nothing is reverted", async () => {
    for (const [answer, status] of [
      [storeErr('unreachable'), 503],
      [{ notSupported: true, method: 'history' } as NotSupported, 501],
    ] as const) {
      const { store, calls } = makeStore({ history: async () => answer as never });
      const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
      const res = await h.POST(post('/api/stet/revert', { key: 'hero_headline', versionId: 3, editor: 'ada' }));
      expect(res.status).toBe(status);
      expect(calls.some((c) => c.method === 'revert')).toBe(false);
    }
  });
});

describe('the changeset routes', () => {
  const h = (over: Partial<StoreAdapter> = {}, changesetsOver: Partial<ChangesetOps> = {}) => {
    const made = makeStore(over, changesetsOver);
    return {
      ...made,
      handler: createStetHandler({ store: made.store, descriptor, auth: TOKEN_ENV }),
    };
  };

  it('each route delegates to its capability method', async () => {
    const { handler, calls } = h();
    expect((await handler.GET(get('/api/stet/changes?status=open&limit=2'))).status).toBe(200);
    expect((await handler.POST(post('/api/stet/changes', { name: 'spring', editor: 'ada' }))).status).toBe(200);
    expect(
      (await handler.POST(post('/api/stet/schedule-change', { change: 3, editor: 'ada', publishAt: null }))).status,
    ).toBe(200);
    expect((await handler.POST(post('/api/stet/publish-change', { change: 3, editor: 'ada' }))).status).toBe(200);
    expect((await handler.POST(post('/api/stet/abandon-change', { change: 3, editor: 'ada' }))).status).toBe(200);
    expect(
      (await handler.POST(post('/api/stet/discard', { key: 'hero_headline', editor: 'ada' }))).status,
    ).toBe(200);

    expect(calls.map((c) => c.method)).toEqual([
      'changesets.list',
      'changesets.open',
      'changesets.schedule',
      'changesets.get',
      'changesets.publishChange',
      'changesets.abandon',
      'changesets.discardDraft',
    ]);
    expect(calls[0]?.arg).toEqual({ status: 'open', beforeId: undefined, limit: 2 });
    expect(calls[1]?.arg).toEqual({ name: 'spring', note: undefined, authorKind: 'human' });
    expect(calls[2]?.arg).toEqual({ changeId: 3, publishAt: null });
    expect(calls[4]?.arg).toEqual({ changeId: 3, editor: 'ada' });
    expect(calls[6]?.arg).toEqual({ key: 'hero_headline', locale: undefined });
  });

  it('schedule-change treats an absent publishAt and an explicit null differently', async () => {
    const { handler, calls } = h();
    // Absence must NEVER read as cancel — that would silently unschedule a
    // change on a malformed request.
    const absent = await handler.POST(post('/api/stet/schedule-change', { change: 3, editor: 'ada' }));
    expect(absent.status).toBe(400);
    expect(calls).toHaveLength(0);

    const cancel = await handler.POST(
      post('/api/stet/schedule-change', { change: 3, editor: 'ada', publishAt: null }),
    );
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ status: 'open' });

    const stamped = await handler.POST(
      post('/api/stet/schedule-change', { change: 3, editor: 'ada', publishAt: '2030-01-01T00:00:00.000Z' }),
    );
    expect(await stamped.json()).toEqual({ status: 'scheduled' });

    // A non-null value must parse as a date.
    expect(
      (await handler.POST(post('/api/stet/schedule-change', { change: 3, editor: 'ada', publishAt: 'soon' })))
        .status,
    ).toBe(400);
  });

  it('publish-change fires onPublish once per member, with each key’s descriptor target', async () => {
    const published: PublishEvent[] = [];
    const made = makeStore({}, {
      publishChange: async () => ({
        published: [
          { key: 'hero_headline', locale: 'default', versionId: 11 },
          { key: 'hero_body', locale: 'default', versionId: 12 },
        ],
      }),
    });
    const handler = createStetHandler({
      store: made.store,
      descriptor,
      auth: TOKEN_ENV,
      onPublish: (e) => published.push(e),
    });
    const res = await handler.POST(post('/api/stet/publish-change', { change: 3, editor: 'ada' }));
    expect(res.status).toBe(200);
    // The event stays PER KEY: one store transaction does not coalesce it.
    expect(published).toEqual([
      { key: 'hero_headline', target: descriptor.keys['hero_headline']?.target, versionId: 11 },
      { key: 'hero_body', target: descriptor.keys['hero_body']?.target, versionId: 12 },
    ]);
  });

  it('a member whose key has left the descriptor gets no event, and the flip is unaffected', async () => {
    const published: PublishEvent[] = [];
    const made = makeStore({}, {
      publishChange: async () => ({
        published: [
          { key: 'hero_headline', locale: 'default', versionId: 11 },
          { key: 'gone_from_descriptor', locale: 'default', versionId: 12 },
        ],
      }),
    });
    const handler = createStetHandler({
      store: made.store,
      descriptor,
      auth: TOKEN_ENV,
      onPublish: (e) => published.push(e),
    });
    const res = await handler.POST(post('/api/stet/publish-change', { change: 3, editor: 'ada' }));
    // The response still carries BOTH minted members — the orphan edge costs an
    // event, never a flip.
    expect((await bodyOf(res))['published']).toHaveLength(2);
    expect(published.map((e) => e.key)).toEqual(['hero_headline']);
  });

  it('an async-rejecting onPublish neither crashes nor fails the response', async () => {
    const made = makeStore({}, {
      publishChange: async () => ({
        published: [{ key: 'hero_headline', locale: 'default', versionId: 11 }],
      }),
    });
    const handler = createStetHandler({
      store: made.store,
      descriptor,
      auth: TOKEN_ENV,
      // An un-awaited async rejection would otherwise reach
      // `unhandledRejection` and terminate the host on Node 15+.
      onPublish: () => Promise.reject(new Error('hook exploded')) as unknown as void,
    });
    const res = await handler.POST(post('/api/stet/publish-change', { change: 3, editor: 'ada' }));
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('revert-change returns both lists and fires only for the restored', async () => {
    const published: PublishEvent[] = [];
    // revert-change runs the shared enumeration, so the spy answers the calls
    // that enumeration makes rather than a route-shaped stub.
    const made = makeStore({ revert: async () => ({ versionId: 21 }) }, {
      get: async () => ({
        change: { ...A_CHANGE, status: 'published' as const },
        members: [
          { key: 'hero_headline', locale: 'default', versionId: 11, beforeVersionId: 5, beforeValue: 'old' },
          { key: 'hero_body', locale: 'default', versionId: 12, beforeVersionId: null },
        ],
      }),
    });
    const handler = createStetHandler({
      store: made.store,
      descriptor,
      auth: TOKEN_ENV,
      onPublish: (e) => published.push(e),
    });
    const res = await handler.POST(post('/api/stet/revert-change', { change: 3, editor: 'ada' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reverted: [{ key: 'hero_headline', locale: 'default', versionId: 21 }],
      skipped: [{ key: 'hero_body', locale: 'default', reason: 'no_prior_version' }],
    });
    // Only the restored member's live copy changed; firing for the skipped one
    // would report a change that never happened.
    expect(published.map((e) => e.key)).toEqual(['hero_headline']);
    // The enumeration was handed THIS change, and stamped THIS change.
    expect(made.calls.find((c) => c.method === 'changesets.get')?.arg).toEqual({ changeId: 3 });
    expect(made.calls.find((c) => c.method === 'changesets.markReverted')?.arg).toEqual({ changeId: 3 });
  });

  it('discard reaches a key that has left the descriptor', async () => {
    const { handler, calls } = h();
    // Unlike draft/publish/revert, cleanup has no `target` to source and must
    // reach an orphaned draft.
    const res = await handler.POST(post('/api/stet/discard', { key: 'gone_from_descriptor', editor: 'ada' }));
    expect(res.status).toBe(200);
    expect(calls[0]?.arg).toEqual({ key: 'gone_from_descriptor', locale: undefined });
  });

  it('discard trims its key and refuses a locale it cannot use', async () => {
    const { handler, calls } = h();
    // This is a DELETE. A non-string locale dropped to undefined would discard
    // the DEFAULT-locale draft — a row the caller never named.
    const res = await handler.POST(
      post('/api/stet/discard', { key: 'hero_headline', editor: 'ada', locale: 3 }),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);

    // The key is trimmed like every other route's, so a stray space cannot
    // aim the delete at a key that does not exist.
    await handler.POST(post('/api/stet/discard', { key: '  hero_headline  ', editor: 'ada' }));
    expect(calls[0]?.arg).toEqual({ key: 'hero_headline', locale: undefined });
    // A whitespace-only key is nothing to delete.
    expect((await handler.POST(post('/api/stet/discard', { key: '   ', editor: 'ada' }))).status).toBe(400);
  });

  it('a store refusal surfaces as the marker’s 409', async () => {
    const { handler } = h({}, {
      abandon: async () => ({ storeError: true, code: 'conflict', message: 'change_closed:3' }),
    });
    const res = await handler.POST(post('/api/stet/abandon-change', { change: 3, editor: 'ada' }));
    expect(res.status).toBe(409);
    expect((await bodyOf(res))['error']).toContain('change_closed:');
  });

  it('every changeset route 401s without the Bearer and 501s on a snapshot store', async () => {
    const { handler, calls } = h();
    const posts: [string, unknown][] = [
      ['changes', { name: 'x', editor: 'ada' }],
      ['schedule-change', { change: 3, editor: 'ada', publishAt: null }],
      ['publish-change', { change: 3, editor: 'ada' }],
      ['revert-change', { change: 3, editor: 'ada' }],
      ['discard', { key: 'hero_headline', editor: 'ada' }],
      ['abandon-change', { change: 3, editor: 'ada' }],
    ];
    for (const [path, body] of posts) {
      expect((await handler.POST(post(`/api/stet/${path}`, body, null))).status).toBe(401);
    }
    expect((await handler.GET(get('/api/stet/changes', null))).status).toBe(401);
    expect(calls).toHaveLength(0);

    // The capability's absence is a 501 naming the method, not a lie.
    const snapshot = createStetHandler({
      store: createSnapshotStore({ project: 'none' }),
      descriptor,
      auth: TOKEN_ENV,
    });
    // Each route names the DISTINCT method it refused — a shared prefix would
    // pass even if every route reached the same capability method.
    const expected: Record<string, string> = {
      changes: 'changesets.open',
      'schedule-change': 'changesets.schedule',
      'publish-change': 'changesets.publishChange',
      'revert-change': 'changesets.get',
      discard: 'changesets.discardDraft',
      'abandon-change': 'changesets.abandon',
    };
    for (const [path, body] of posts) {
      const res = await snapshot.POST(post(`/api/stet/${path}`, body));
      expect({ path, status: res.status }).toEqual({ path, status: 501 });
      expect({ path, error: (await bodyOf(res))['error'] }).toEqual({
        path,
        error: `not supported: ${expected[path]}`,
      });
    }
    const listed = await snapshot.GET(get('/api/stet/changes'));
    expect(listed.status).toBe(501);
    expect((await bodyOf(listed))['error']).toBe('not supported: changesets.list');
  });

  it('a changeset write with no editor is rejected before the store', async () => {
    const { handler, calls } = h();
    for (const [path, body] of [
      ['changes', { name: 'x' }],
      ['schedule-change', { change: 3, publishAt: null }],
      ['publish-change', { change: 3 }],
      ['revert-change', { change: 3 }],
      ['discard', { key: 'hero_headline' }],
      ['abandon-change', { change: 3 }],
    ] as [string, unknown][]) {
      const res = await handler.POST(post(`/api/stet/${path}`, { ...(body as object), editor: '   ' }));
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it('POST changes validates the name and the author kind', async () => {
    const { handler, calls } = h();
    expect((await handler.POST(post('/api/stet/changes', { name: '  ', editor: 'ada' }))).status).toBe(400);
    expect(
      (await handler.POST(post('/api/stet/changes', { name: 'x', editor: 'ada', authorKind: 'robot' }))).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    // 'agent' is accepted here; the discriminator that SETS it is add-mcp's.
    expect(
      (await handler.POST(post('/api/stet/changes', { name: 'x', editor: 'ada', authorKind: 'agent' }))).status,
    ).toBe(200);
    expect(calls[0]?.arg).toMatchObject({ authorKind: 'agent' });
  });

  it('the change-shaped routes require a numeric change', async () => {
    const { handler, calls } = h();
    for (const path of ['schedule-change', 'publish-change', 'revert-change', 'abandon-change']) {
      const res = await handler.POST(post(`/api/stet/${path}`, { editor: 'ada', publishAt: null }));
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it('the list route rejects a status it cannot mean', async () => {
    const { handler, calls } = h();
    expect((await handler.GET(get('/api/stet/changes?status=nonsense'))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('the descriptor guards are own-property lookups', () => {
  // Every one of these resolves through a bare `descriptor.keys[name]` or
  // `name in descriptor.templates`, so without an own-property guard the
  // undeclared-key 400 is a door and `target` becomes an inherited function.
  const INHERITED = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'isPrototypeOf'];

  it('refuses every inherited name as an undeclared key on the write routes', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    for (const key of INHERITED) {
      for (const [path, extra] of [
        ['draft', { value: 'x' }],
        ['publish', {}],
        ['revert', { versionId: 1 }],
      ] as [string, object][]) {
        const res = await h.POST(post(`/api/stet/${path}`, { key, editor: 'ada', ...extra }));
        expect({ path, key, status: res.status }).toEqual({ path, key, status: 400 });
      }
    }
    // The spec's "no undeclared-key write ever mutates the store" — proven by
    // the store never being reached, not by the response alone.
    expect(calls).toHaveLength(0);
  });

  it('refuses every inherited name as an unknown template on render and test-send', async () => {
    const { store } = makeStore();
    let rendered = 0;
    let sent = 0;
    const h = createStetHandler({
      store,
      descriptor,
      auth: TOKEN_ENV,
      renderEmail: async () => {
        rendered += 1;
        return '<p>rendered</p>';
      },
      sendTest: async () => {
        sent += 1;
      },
    });
    for (const template of INHERITED) {
      expect((await h.GET(get(`/api/stet/render?template=${encodeURIComponent(template)}`))).status).toBe(400);
      // Without the guard this one is a 500: `templates['constructor']` is a
      // function, and `def.slots.map` throws out of draftOverride.
      const res = await h.POST(post('/api/stet/test-send', { template, to: 'a@b.test' }));
      expect({ template, status: res.status }).toEqual({ template, status: 400 });
    }
    expect({ rendered, sent }).toEqual({ rendered: 0, sent: 0 });
  });

  it('a key legitimately NAMED constructor still resolves', async () => {
    // The fix must not cost a real declaration: `constructor` matches the
    // descriptor's key-name pattern, so it is a legal key and an own property.
    const withOwn = {
      ...descriptor,
      keys: { ...descriptor.keys, constructor: { ...descriptor.keys['hero_headline']! } },
    };
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor: withOwn, auth: TOKEN_ENV });
    const res = await h.POST(post('/api/stet/draft', { key: 'constructor', value: 'x', editor: 'ada' }));
    expect(res.status).toBe(200);
    expect((saves(calls)[0]?.arg as Record<string, unknown>)['target']).toBe(descriptor.keys['hero_headline']?.target);
  });

  it('an orphaned member fires no event at all, never one with an undefined target', async () => {
    const published: PublishEvent[] = [];
    const made = makeStore({}, {
      publishChange: async () => ({
        published: [{ key: 'constructor', locale: 'default', versionId: 12 }],
      }),
    });
    const h = createStetHandler({
      store: made.store,
      descriptor,
      auth: TOKEN_ENV,
      onPublish: (e) => published.push(e),
    });
    await h.POST(post('/api/stet/publish-change', { change: 3, editor: 'ada' }));
    // `PublishEvent.target` is never widened, so an event with an inherited
    // value on it is worse than no event.
    expect(published).toEqual([]);
  });
});

describe('id fields are integers, not merely finite', () => {
  it('rejects a fractional or out-of-range id on every change-carrying route', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    for (const bad of [1.5, 1e20]) {
      for (const path of ['schedule-change', 'publish-change', 'revert-change', 'abandon-change']) {
        const res = await h.POST(post(`/api/stet/${path}`, { change: bad, editor: 'ada', publishAt: null }));
        expect({ path, bad, status: res.status }).toEqual({ path, bad, status: 400 });
      }
      // The draft route's `change` takes the same gate.
      const draft = await h.POST(
        post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada', change: bad }),
      );
      expect({ bad, status: draft.status }).toEqual({ bad, status: 400 });
      // …and so does revert's versionId, through the same helper.
      const revert = await h.POST(
        post('/api/stet/revert', { key: 'hero_headline', editor: 'ada', versionId: bad }),
      );
      expect({ bad, status: revert.status }).toEqual({ bad, status: 400 });
    }
    // Nothing reached the store: these would diverge by adapter if they did.
    expect(calls).toHaveLength(0);
  });

  it('still admits 0 and negatives, whose refusal is the store’s to make', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    await h.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada', change: 0 }));
    expect((saves(calls)[0]?.arg as Record<string, unknown>)['change']).toBe(0);
  });
});

describe('the schedule stamp is normalized, not passed through', () => {
  it('forwards the resolved instant for a non-ISO input', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    // `"1"` parses as the year 2001 — a typo that would schedule the group in
    // the PAST, and the clock would publish it on its next run.
    await h.POST(post('/api/stet/schedule-change', { change: 3, editor: 'ada', publishAt: '1' }));
    const forwarded = (calls[0]?.arg as { publishAt: string }).publishAt;
    expect(forwarded).toBe(new Date(Date.parse('1')).toISOString());
    expect(forwarded).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // An already-ISO stamp survives unchanged.
    await h.POST(
      post('/api/stet/schedule-change', { change: 3, editor: 'ada', publishAt: '2030-06-01T09:00:00.000Z' }),
    );
    expect((calls[1]?.arg as { publishAt: string }).publishAt).toBe('2030-06-01T09:00:00.000Z');
  });
});

describe('the draft route’s change forwarding', () => {
  it('forwards absent, null and a number as three distinct intents', async () => {
    const { store, calls } = makeStore();
    const handler = createStetHandler({ store, descriptor, auth: TOKEN_ENV });

    await handler.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada' }));
    // ABSENT must not travel as null: null detaches, and a save that silently
    // detached on every autosave would empty a change key by key.
    expect('change' in (saves(calls)[0]?.arg as Record<string, unknown>)).toBe(false);

    await handler.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada', change: null }));
    expect((saves(calls)[1]?.arg as Record<string, unknown>)['change']).toBeNull();

    await handler.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada', change: 4 }));
    expect((saves(calls)[2]?.arg as Record<string, unknown>)['change']).toBe(4);
  });

  it('rejects a string-typed change rather than coercing it', async () => {
    const { store, calls } = makeStore();
    const handler = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    // A coerced "3" would attach the draft to whatever change 3 happens to be.
    const res = await handler.POST(
      post('/api/stet/draft', { key: 'hero_headline', value: 'x', editor: 'ada', change: '3' }),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('unknown paths', () => {
  it('rename, preview, and media are 404, not 500', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.POST(post('/api/stet/rename', { oldKey: 'a', newKey: 'b', editor: 'x' }))).status).toBe(404);
    expect((await h.GET(get('/api/stet/preview'))).status).toBe(404);
    expect((await h.GET(get('/api/stet/media'))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('the content gate on the draft and publish routes', () => {
  const ADDRESS = '1 Main Street, Springfield';
  // Each case breaks one rule `stet draft` enforces: a hard limit, a variable a
  // marketing template must carry, and markup an email slot may not hold.
  const INVALID: Array<[string, string, string, RegExp]> = [
    ['over a hard limit', 'welcome__subject', 'x'.repeat(61), /60-character limit/],
    ['a required {{var}} dropped', 'newsletter__body', 'No way out of this list.', /unsubscribe_url/],
    ['<script> in an html-email slot', 'welcome__body', 'Hi <script>alert(1)</script>', /HTML element open in html-email content/],
  ];

  /** A memory store with the brand's postal line published, so only the case's own rule can fail. */
  async function seeded(): Promise<StoreAdapter> {
    const store = createMemoryStore({ project: 'test' });
    await store.saveDraft({ key: 'brand__footer_address', value: ADDRESS, target: 'html-email', editor: 'ada' });
    await store.publish({ key: 'brand__footer_address', editor: 'ada' });
    return store;
  }

  it.each(INVALID)('draft refuses %s with 422, the validator’s message, and writes nothing', async (_name, key, value, message) => {
    const store = await seeded();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const before = await store.read({ preview: true });
    const res = await h.POST(post('/api/stet/draft', { key, value, editor: 'ada' }));
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(String(body['error'])).toMatch(message);
    expect(await store.read({ preview: true })).toEqual(before);

    // The same words `stet draft` prints: one function, one rule set.
    const report = new Report();
    validateValue(descriptor, { default: { brand__footer_address: ADDRESS } }, key, value, 'default', report);
    const printed = report.findings.filter((f) => f.level === 'error').map((f) => f.message);
    expect(printed.length).toBeGreaterThan(0);
    expect(String(body['error'])).toBe(printed.join('; '));
  });

  it('draft refuses a value that dropped a required variable with 422, its line ending in the locale (journey B4)', async () => {
    const store = await seeded();
    const required = miniDescriptor();
    required.keys['welcome__body'] = { ...required.keys['welcome__body']!, requires: ['handle'] };
    const h = createStetHandler({ store, descriptor: required, auth: TOKEN_ENV });
    const before = await store.read({ preview: true });
    const res = await h.POST(post('/api/stet/draft', { key: 'welcome__body', value: 'Welcome aboard.', editor: 'ada' }));
    expect(res.status).toBe(422);
    expect(String((await bodyOf(res))['error'])).toBe('welcome__body: {{handle}} is required and the value no longer carries it (default)');
    expect(await store.read({ preview: true })).toEqual(before);
  });

  it('draft saves a valid value with 200', async () => {
    const store = await seeded();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    const res = await h.POST(post('/api/stet/draft', { key: 'newsletter__body', value: 'Leave any time: {{unsubscribe_url}}', editor: 'ada' }));
    expect(res.status).toBe(200);
    const rows = (await store.read({ preview: true })) as StoreRow[];
    expect(rows.find((r) => r.key === 'newsletter__body')?.value).toBe('Leave any time: {{unsubscribe_url}}');
  });

  it('draft judges a slot with its siblings’ drafts in scope', async () => {
    const store = await seeded();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    // The body alone lacks the unsubscribe variable; the drafted subject carries it.
    await store.saveDraft({ key: 'newsletter__subject', value: '{{unsubscribe_url}}', target: 'html-email', editor: 'ada' });
    const res = await h.POST(post('/api/stet/draft', { key: 'newsletter__body', value: 'Hello again.', editor: 'ada' }));
    expect(res.status).toBe(200);
  });

  it('a warning alone does not refuse a draft', async () => {
    const store = await seeded();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    // hero_headline's limit is advisory: over it is a warning.
    const res = await h.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'x'.repeat(80), editor: 'ada' }));
    expect(res.status).toBe(200);
  });

  it.each(INVALID)('publish refuses a stored draft with %s, publishing nothing', async (_name, key, value, message) => {
    const store = await seeded();
    // Written past the route, as an earlier release or another client could.
    await store.saveDraft({ key, value, target: 'html-email', editor: 'ada' });
    const events: PublishEvent[] = [];
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const before = await store.read({ preview: true });
    const res = await h.POST(post('/api/stet/publish', { key, editor: 'ada' }));
    expect(res.status).toBe(422);
    expect(String((await bodyOf(res))['error'])).toMatch(message);
    expect(await store.read({ preview: true })).toEqual(before);
    expect(events).toEqual([]);
  });

  it('publish still ships a valid stored draft', async () => {
    const store = await seeded();
    await store.saveDraft({ key: 'hero_headline', value: 'Ship it', target: 'web', editor: 'ada' });
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    expect((await h.POST(post('/api/stet/publish', { key: 'hero_headline', editor: 'ada' }))).status).toBe(200);
  });

  it('publish-change refuses the whole group when one member draft is invalid, publishing none', async () => {
    const store = await seeded();
    const opened = (await store.changesets.open({ name: 'spring' })) as { changeId: number };
    await store.saveDraft({ key: 'hero_headline', value: 'Fine', target: 'web', editor: 'ada', change: opened.changeId });
    await store.saveDraft({ key: 'welcome__subject', value: 'x'.repeat(61), target: 'html-email', editor: 'ada', change: opened.changeId });
    const events: PublishEvent[] = [];
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV, onPublish: (e) => events.push(e) });
    const before = await store.read({ preview: true });
    const res = await h.POST(post('/api/stet/publish-change', { change: opened.changeId, editor: 'ada' }));
    expect(res.status).toBe(422);
    expect(String((await bodyOf(res))['error'])).toMatch(/60-character limit/);
    expect(await store.read({ preview: true })).toEqual(before);
    expect(events).toEqual([]);

    // Corrected, the same group publishes whole.
    await store.saveDraft({ key: 'welcome__subject', value: 'Welcome', target: 'html-email', editor: 'ada', change: opened.changeId, force: true });
    const ok = await h.POST(post('/api/stet/publish-change', { change: opened.changeId, editor: 'ada' }));
    expect(ok.status).toBe(200);
    expect(events.map((e) => e.key).sort()).toEqual(['hero_headline', 'welcome__subject']);
  });

  // The template's subject also declares the unsubscribe variable, so either
  // slot can carry it for the other.
  const carrying = {
    ...descriptor,
    keys: {
      ...descriptor.keys,
      newsletter__subject: { ...descriptor.keys['newsletter__subject']!, vars: ['unsubscribe_url'] },
    },
  };

  /** Live: a body that carries the variable and a plain subject. */
  async function liveNewsletter(): Promise<StoreAdapter> {
    const store = await seeded();
    for (const [key, value] of [['newsletter__body', 'Bye: {{unsubscribe_url}}'], ['newsletter__subject', 'News']] as const) {
      await store.saveDraft({ key, value, target: 'html-email', editor: 'ada' });
      await store.publish({ key, editor: 'ada' });
    }
    return store;
  }

  it('publish judges a slot without the drafts it does not ship', async () => {
    const store = await liveNewsletter();
    const h = createStetHandler({ store, descriptor: carrying, auth: TOKEN_ENV });
    // Each draft passes at the draft route, the subject carrying the variable
    // for the body; only the body is published, so the subject never goes live.
    expect((await h.POST(post('/api/stet/draft', { key: 'newsletter__subject', value: 'News {{unsubscribe_url}}', editor: 'ada' }))).status).toBe(200);
    expect((await h.POST(post('/api/stet/draft', { key: 'newsletter__body', value: 'Hello again.', editor: 'ada' }))).status).toBe(200);
    const res = await h.POST(post('/api/stet/publish', { key: 'newsletter__body', editor: 'ada' }));
    expect(res.status).toBe(422);
    expect(String((await bodyOf(res))['error'])).toContain('unsubscribe_url');
    const live = ((await store.read()) as StoreRow[]).find((r) => r.key === 'newsletter__body');
    expect(live?.value).toBe('Bye: {{unsubscribe_url}}');
  });

  it('publish-change judges the group without a draft outside it', async () => {
    const store = await liveNewsletter();
    const h = createStetHandler({ store, descriptor: carrying, auth: TOKEN_ENV });
    const opened = (await store.changesets.open({ name: 'body only' })) as { changeId: number };
    await store.saveDraft({ key: 'newsletter__subject', value: 'News {{unsubscribe_url}}', target: 'html-email', editor: 'ada' });
    await store.saveDraft({ key: 'newsletter__body', value: 'Hello again.', target: 'html-email', editor: 'ada', change: opened.changeId });
    const res = await h.POST(post('/api/stet/publish-change', { change: opened.changeId, editor: 'ada' }));
    expect(res.status).toBe(422);
    expect(String((await bodyOf(res))['error'])).toContain('unsubscribe_url');
  });

  it('publish passes a slot whose sibling ships with it in the same change', async () => {
    const store = await liveNewsletter();
    const h = createStetHandler({ store, descriptor: carrying, auth: TOKEN_ENV });
    const opened = (await store.changesets.open({ name: 'both' })) as { changeId: number };
    await store.saveDraft({ key: 'newsletter__subject', value: 'News {{unsubscribe_url}}', target: 'html-email', editor: 'ada', change: opened.changeId });
    await store.saveDraft({ key: 'newsletter__body', value: 'Hello again.', target: 'html-email', editor: 'ada', change: opened.changeId });
    expect((await h.POST(post('/api/stet/publish-change', { change: opened.changeId, editor: 'ada' }))).status).toBe(200);
  });

  it('reads only the keys a check uses, and nothing for a key with no template', async () => {
    const { store, calls } = makeStore();
    const h = createStetHandler({ store, descriptor, auth: TOKEN_ENV });
    await h.POST(post('/api/stet/draft', { key: 'hero_headline', value: 'Hi', editor: 'ada' }));
    expect(calls.filter((c) => c.method === 'read')).toHaveLength(0);
    await h.POST(post('/api/stet/draft', { key: 'newsletter__body', value: 'Bye {{unsubscribe_url}}', editor: 'ada' }));
    expect(calls.filter((c) => c.method === 'read').map((c) => c.arg)).toEqual([
      { keys: ['newsletter__body', 'newsletter__subject', 'brand__footer_address'], preview: true },
    ]);
    await h.POST(post('/api/stet/publish', { key: 'hero_headline', editor: 'ada' }));
    expect(calls.filter((c) => c.method === 'read').at(-1)?.arg).toEqual({ keys: ['hero_headline'], preview: true });
  });
});

describe('GET changes?id (8.2, stage 5)', () => {
  const h = () => {
    const made = makeStore();
    return { ...made, handler: createStetHandler({ store: made.store, descriptor, auth: TOKEN_ENV }) };
  };

  it('answers a published change with each member’s before version and value (journey B24)', async () => {
    const store = createMemoryStore({ project: 'before' });
    await store.saveDraft({ key: 'hero_headline', value: 'Buy', target: 'web', editor: 'ada' });
    const first = (await store.publish({ key: 'hero_headline', editor: 'ada' })) as { versionId: number };
    const opened = (await store.changesets.open({ name: 'Spring pricing' })) as { changeId: number };
    await store.saveDraft({ key: 'hero_headline', value: 'Buy now', target: 'web', editor: 'ada', change: opened.changeId });
    await store.changesets.publishChange({ changeId: opened.changeId, editor: 'ada' });
    const handler = createStetHandler({ store, descriptor, auth: TOKEN_ENV });

    const res = await handler.GET(get(`/api/stet/changes?id=${opened.changeId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change: { id: number; name: string }; members: Record<string, unknown>[] };
    expect(body.change).toMatchObject({ id: opened.changeId, name: 'Spring pricing', status: 'published' });
    expect(body.members).toEqual([
      expect.objectContaining({ key: 'hero_headline', locale: 'default', beforeVersionId: first.versionId, beforeValue: 'Buy' }),
    ]);
  });

  it('is authenticated: no Bearer answers 401 and id=abc 400, and neither reads the store', async () => {
    const { handler, calls } = h();
    expect((await handler.GET(get('/api/stet/changes?id=3', null))).status).toBe(401);
    const bad = await handler.GET(get('/api/stet/changes?id=abc'));
    expect(bad.status).toBe(400);
    expect(await bodyOf(bad)).toEqual({ error: 'id must be an integer' });
    expect(calls).toEqual([]);
  });

  it('a 20-digit id answers 400 and reaches no store, as do a sign, a fraction and an empty id', async () => {
    const { handler, calls } = h();
    for (const id of ['12345678901234567890', '9007199254740992', '-1', '1.5', '', '1e3', ' 3']) {
      const res = await handler.GET(get(`/api/stet/changes?id=${encodeURIComponent(id)}`));
      expect({ id, status: res.status }).toEqual({ id, status: 400 });
    }
    expect(calls).toEqual([]);
    // The largest safe id is an id.
    expect((await handler.GET(get('/api/stet/changes?id=9007199254740991'))).status).toBe(200);
    expect(calls.map((c) => [c.method, c.arg])).toEqual([['changesets.get', { changeId: 9007199254740991 }]]);
  });

  it('an unknown id answers the store’s no_change conflict, 409', async () => {
    const handler = createStetHandler({ store: createMemoryStore({ project: 'unknown' }), descriptor, auth: TOKEN_ENV });
    const res = await handler.GET(get('/api/stet/changes?id=41'));
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: 'no_change:41', code: 'conflict' });
  });

  it('the snapshot store answers 501 naming changesets.get', async () => {
    const handler = createStetHandler({ store: createSnapshotStore({ project: 'none' }), descriptor, auth: TOKEN_ENV });
    const res = await handler.GET(get('/api/stet/changes?id=3'));
    expect(res.status).toBe(501);
    expect(await bodyOf(res)).toEqual({ error: 'not supported: changesets.get' });
  });

  it('without an id the route lists changes as it does', async () => {
    const { handler, calls } = h();
    expect((await handler.GET(get('/api/stet/changes?status=open'))).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['changesets.list']);
  });
});


/**
 * `createStetFormsHandler` — the public join and unsubscribe routes, over the
 * memory reference. Requests are plain `Request` objects and no server runs.
 * The join route's checks are asserted one row of design D5's table at a time,
 * in its order, each refusal also asserting that nothing was written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryDb, createMemoryStore, type MemoryDb, type MemoryStore } from '../adapters/store-memory.js';
import { createSnapshotStore } from '../adapters/store-snapshot.js';
import { ok } from '../conformance/store.suite.js';
import {
  createStetFormsHandler,
  JOIN_BODY_MAX,
  routeOf,
  type FormsHandlerOptions,
  type JoinEvent,
  type UnsubscribeEvent,
} from '../server/forms.js';
import { mintUnsubscribeToken } from '../server/unsubscribe-token.js';
import { mintPreviewToken } from '../src/preview-token.js';
import type { GroupProperty, StoreAdapter } from '../src/store.js';

const SECRET = 'a-forms-secret';
const SITE = 'https://getstet.xyz';
const BASE = 'https://forms.getstet.xyz/api/stet';
const TIERS: GroupProperty[] = [
  { name: 'tier', type: 'enum', values: ['solo', 'team', 'business'], required: true },
  { name: 'use_case', type: 'text' },
];

interface Harness {
  db: MemoryDb;
  store: MemoryStore;
  forms: ReturnType<typeof createStetFormsHandler>;
  joins: JoinEvent[];
  unsubscribes: UnsubscribeEvent[];
  errors: [unknown, string][];
  guardCalls: () => number;
}

/** The website's two groups, a guard that refuses `bad` and throws on `boom`, and recording hooks. */
async function harness(over: Partial<FormsHandlerOptions> = {}): Promise<Harness> {
  const db = createMemoryDb();
  const store = createMemoryStore({ project: 'default', db });
  ok(await store.contacts.addGroup({ key: 'cloud-waitlist', name: 'stet Cloud', properties: TIERS }));
  ok(await store.contacts.addGroup({ key: 'managed-sending', name: 'Managed sending', properties: [] }));
  const joins: JoinEvent[] = [];
  const unsubscribes: UnsubscribeEvent[] = [];
  const errors: [unknown, string][] = [];
  let guardCalls = 0;
  const forms = createStetFormsHandler({
    store,
    secret: SECRET,
    unsubscribeBase: BASE,
    allowedOrigins: [SITE],
    honeypot: 'website',
    guard: (_req, body) => {
      guardCalls += 1;
      if (body['token'] === 'bad') return { status: 403, error: 'challenge_failed' };
      if (body['token'] === 'boom') throw new Error('the challenge service is down');
      return true;
    },
    onJoin: (e) => {
      joins.push(e);
    },
    onUnsubscribe: (e) => {
      unsubscribes.push(e);
    },
    onError: (error, where) => {
      errors.push([error, where]);
    },
    ...over,
  });
  return { db, store, forms, joins, unsubscribes, errors, guardCalls: () => guardCalls };
}

function joinRequest(
  group: string,
  body: unknown,
  opts: { origin?: string | null; type?: string; referer?: string; url?: string; raw?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': opts.type ?? 'application/json' };
  const origin = opts.origin === undefined ? SITE : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  if (opts.referer !== undefined) headers['referer'] = opts.referer;
  return new Request(opts.url ?? `${BASE}/join/${group}`, {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

/** A body with no declared length (or a lying one), arriving in chunks. */
function streamedJoin(size: number, declared?: number): Request {
  const bytes = new TextEncoder().encode(`{"email":"${'x'.repeat(size)}"}`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 1024) controller.enqueue(bytes.slice(at, at + 1024));
      controller.close();
    },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: SITE };
  if (declared !== undefined) headers['content-length'] = String(declared);
  return new Request(`${BASE}/join/cloud-waitlist`, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit);
}

const WORKED = { email: 'Ana@Lightfield.co', properties: { tier: 'team' }, form: 'waitlist-page', page: `${SITE}/waitlist` };

async function answered(res: Response): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

function nothingWritten(h: Harness): void {
  expect({ contacts: h.db.contacts.length, memberships: h.db.memberships.length, joins: h.joins.length }).toEqual({
    contacts: 0,
    memberships: 0,
    joins: 0,
  });
}

async function membership(h: Harness, email: string): Promise<{ form: string | null; page: string | null; properties: Record<string, string>; joinedAt: string } | undefined> {
  const record = ok(await h.store.contacts.contact({ email }));
  return record.record?.memberships[0];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the join route, check by check (D5, in order)', () => {
  it('1 — an Origin neither its own nor listed is refused 403 origin_refused', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('cloud-waitlist', WORKED, { origin: 'https://evil.example' }));
    expect(await answered(res)).toEqual({ status: 403, body: { ok: false, error: 'origin_refused' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    nothingWritten(h);
  });

  it('2 — a body that is not application/json is refused 415 unsupported_media_type', async () => {
    const h = await harness();
    const res = await h.forms.POST(
      joinRequest('cloud-waitlist', null, { type: 'application/x-www-form-urlencoded', raw: 'email=ana%40lightfield.co' }),
    );
    expect(await answered(res)).toEqual({ status: 415, body: { ok: false, error: 'unsupported_media_type' } });
    nothingWritten(h);
  });

  it('3 — a body past 16 KiB is refused 413 body_too_large', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, pad: 'x'.repeat(JOIN_BODY_MAX) }));
    expect(await answered(res)).toEqual({ status: 413, body: { ok: false, error: 'body_too_large' } });
    nothingWritten(h);
  });

  it('4 — a body that does not parse to a JSON object is refused 400 invalid_body', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('cloud-waitlist', null, { raw: '{"email":' }));
    expect(await answered(res)).toEqual({ status: 400, body: { ok: false, error: 'invalid_body' } });
    nothingWritten(h);
  });

  it('5 — a filled honeypot is answered ok and dropped, before the guard', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, website: 'http://spam.example' }));
    expect(await answered(res)).toEqual({ status: 200, body: { ok: true } });
    expect(h.guardCalls()).toBe(0);
    nothingWritten(h);
  });

  it('6 — the guard’s own refusal is the answer, and a guard that throws is 503 guard_unavailable', async () => {
    const h = await harness();
    const refused = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, token: 'bad' }));
    expect(await answered(refused)).toEqual({ status: 403, body: { ok: false, error: 'challenge_failed' } });
    const thrown = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, token: 'boom' }));
    expect(await answered(thrown)).toEqual({ status: 503, body: { ok: false, error: 'guard_unavailable' } });
    expect(h.errors.map(([, where]) => where)).toEqual(['guard']);
    nothingWritten(h);
  });

  it('7 — an address not shaped like one is refused 400 invalid_email', async () => {
    const h = await harness();
    for (const email of ['ana', ' ', `${'a'.repeat(250)}@b.co`, 42]) {
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, email }));
      expect(await answered(res)).toEqual({ status: 400, body: { ok: false, error: 'invalid_email' } });
    }
    nothingWritten(h);
  });

  it('8 — a key outside the group grammar is answered as an unknown group', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('Cloud', WORKED));
    expect(await answered(res)).toEqual({ status: 404, body: { ok: false, error: 'unknown_group' } });
    nothingWritten(h);
  });

  it('9 — a form name outside its pattern is refused 400 invalid_field', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, form: 'has space' }));
    expect(await answered(res)).toEqual({ status: 400, body: { ok: false, error: 'invalid_field', field: 'form' } });
    nothingWritten(h);
  });

  it('10 — the group read: missing 404, closed 409, no capability 501, no answer 503', async () => {
    const h = await harness();
    const missing = await h.forms.POST(joinRequest('nope', WORKED));
    expect(await answered(missing)).toEqual({ status: 404, body: { ok: false, error: 'unknown_group' } });

    ok(await h.store.contacts.setGroupState({ key: 'cloud-waitlist', state: 'closed' }));
    const closed = await h.forms.POST(joinRequest('cloud-waitlist', WORKED));
    expect(await answered(closed)).toEqual({ status: 409, body: { ok: false, error: 'group_closed' } });
    ok(await h.store.contacts.setGroupState({ key: 'cloud-waitlist', state: 'open' }));

    h.store.failNext = 'read';
    const down = await h.forms.POST(joinRequest('cloud-waitlist', WORKED));
    expect(await answered(down)).toEqual({ status: 503, body: { ok: false, error: 'store_unavailable' } });
    nothingWritten(h);

    const snapshot = await harness({ store: createSnapshotStore({ project: 'default' }) });
    const unsupported = await snapshot.forms.POST(joinRequest('cloud-waitlist', WORKED));
    expect(await answered(unsupported)).toEqual({ status: 501, body: { ok: false, error: 'not_supported' } });
  });

  it('11 — answers the group does not ask, missing or malformed are refused naming the property', async () => {
    const h = await harness();
    const cases: [unknown, number, Record<string, unknown>][] = [
      [{ tier: 'enterprise' }, 400, { ok: false, error: 'invalid_property', property: 'tier' }],
      [JSON.parse('{"tier":"team","constructor":"x"}'), 400, { ok: false, error: 'invalid_property', property: 'constructor' }],
      [{}, 400, { ok: false, error: 'missing_property', property: 'tier' }],
      [['team'], 400, { ok: false, error: 'invalid_body' }],
    ];
    for (const [properties, status, body] of cases) {
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, properties }));
      expect(await answered(res)).toEqual({ status, body });
    }
    nothingWritten(h);
  });

  it('12 — the join writes and answers ok; a close or delete racing the read maps back', async () => {
    const h = await harness();
    const res = await h.forms.POST(joinRequest('cloud-waitlist', WORKED));
    expect(await answered(res)).toEqual({ status: 200, body: { ok: true } });
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(await membership(h, 'ana@lightfield.co')).toMatchObject({
      form: 'waitlist-page',
      page: `${SITE}/waitlist`,
      properties: { tier: 'team' },
    });
    expect(h.joins).toEqual([
      expect.objectContaining({ group: 'cloud-waitlist', email: 'ana@lightfield.co', isNew: true, suppressed: false }),
    ]);
    expect(h.joins[0]?.unsubscribeUrl).toMatch(/\/unsubscribe\?token=e\./);

    // The group read said open; the write then finds it closed, or gone.
    const raced = (change: (s: MemoryStore) => Promise<unknown>): StoreAdapter => ({
      ...h.store,
      contacts: {
        ...h.store.contacts,
        join: async (p) => {
          await change(h.store);
          return h.store.contacts.join(p);
        },
      },
    });
    const closing = await harness({
      store: raced((s) => s.contacts.setGroupState({ key: 'managed-sending', state: 'closed' })),
    });
    const late = await closing.forms.POST(joinRequest('managed-sending', { email: 'sam@x.co' }));
    expect(await answered(late)).toEqual({ status: 409, body: { ok: false, error: 'group_closed' } });
    // A conflict the route answers is no failure: nothing is reported.
    expect(closing.errors).toEqual([]);

    const vanishing = await harness({
      store: raced(async () => {
        h.db.groups = h.db.groups.filter((g) => g.key !== 'cloud-waitlist');
      }),
    });
    const gone = await vanishing.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, email: 'sam@x.co' }));
    expect(await answered(gone)).toEqual({ status: 404, body: { ok: false, error: 'unknown_group' } });
  });
});

describe('the join route', () => {
  it('answers a new member, a returning one and a suppressed address with the same bytes', async () => {
    const h = await harness();
    ok(await h.store.contacts.suppress({ email: 'objector@x.co', scope: 'marketing', source: 'one-click' }));
    const snap = async (res: Response): Promise<{ status: number; headers: [string, string][]; body: string }> => ({
      status: res.status,
      headers: [...res.headers.entries()],
      body: await res.text(),
    });
    const fresh = await snap(await h.forms.POST(joinRequest('cloud-waitlist', WORKED)));
    const returning = await snap(await h.forms.POST(joinRequest('cloud-waitlist', WORKED)));
    const suppressed = await snap(await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, email: 'objector@x.co' })));
    expect(returning).toEqual(fresh);
    expect(suppressed).toEqual(fresh);
    expect(h.joins.map((e) => [e.isNew, e.suppressed])).toEqual([
      [true, false],
      [false, false],
      [true, true],
    ]);
  });

  it('a re-join replaces the answers and keeps the first join’s time, form and page', async () => {
    const h = await harness();
    await h.forms.POST(joinRequest('cloud-waitlist', WORKED));
    const first = await membership(h, 'ana@lightfield.co');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    const res = await h.forms.POST(
      joinRequest('cloud-waitlist', { ...WORKED, properties: { tier: 'business' }, form: 'footer', page: `${SITE}/pricing` }),
    );
    expect(await answered(res)).toEqual({ status: 200, body: { ok: true } });
    expect(await membership(h, 'ana@lightfield.co')).toMatchObject({
      properties: { tier: 'business' },
      joinedAt: first?.joinedAt,
      form: 'waitlist-page',
      page: `${SITE}/waitlist`,
    });
    expect(h.joins[1]).toMatchObject({
      isNew: false,
      properties: { tier: 'business' },
      joinedAt: first?.joinedAt,
      form: 'waitlist-page',
      page: `${SITE}/waitlist`,
    });
  });

  it('stores a page as its origin and path, and only from a trusted origin', async () => {
    const h = await harness();
    const stored = async (email: string, body: object, referer?: string): Promise<string | null | undefined> => {
      const res = await h.forms.POST(joinRequest('managed-sending', { email, ...body }, { referer }));
      expect(res.status).toBe(200);
      return (await membership(h, email))?.page;
    };
    expect(await stored('a@x.co', { page: 'https://evil.example/x' })).toBeNull();
    expect(await stored('b@x.co', {}, `${SITE}/waitlist?ref=1`)).toBe(`${SITE}/waitlist`);
    expect(await stored('c@x.co', { page: 'https://user:pw@getstet.xyz/waitlist?utm=x&t=secret#top' })).toBe(
      `${SITE}/waitlist`,
    );
    expect(await stored('d@x.co', {}, 'https://evil.example/waitlist')).toBeNull();
    // A blob URL's origin is the trusted page that made it; its path is a whole URL.
    expect(await stored('e@x.co', { page: `blob:${SITE}/5b1c-4e2a` })).toBeNull();
    expect(await stored('f@x.co', {}, `blob:${SITE}/5b1c-4e2a`)).toBeNull();
  });

  it('keeps a trusted page of 2000 characters and stores one of 2001 as null', async () => {
    const h = await harness();
    const long = (n: number): string => `${SITE}/${'p'.repeat(n - SITE.length - 1)}`;
    for (const [email, page, stored] of [
      ['a@x.co', long(2000), long(2000)],
      ['b@x.co', long(2001), null],
    ] as const) {
      const res = await h.forms.POST(joinRequest('managed-sending', { email, page }));
      expect(res.status).toBe(200);
      expect((await membership(h, email))?.page).toBe(stored);
    }
    expect(long(2001)).toHaveLength(2001);
  });

  it('takes its own origin from unsubscribeBase, never from the request’s URL', async () => {
    const h = await harness({ unsubscribeBase: `${SITE}/api/stet`, allowedOrigins: [] });
    const url = 'http://localhost:3000/api/stet/join/cloud-waitlist';
    const accepted = await h.forms.POST(joinRequest('cloud-waitlist', WORKED, { url }));
    expect(accepted.status).toBe(200);
    expect((await membership(h, 'ana@lightfield.co'))?.page).toBe(`${SITE}/waitlist`);
    const refused = await h.forms.POST(
      joinRequest('cloud-waitlist', { ...WORKED, email: 'sam@x.co' }, { url, origin: 'http://localhost:3000' }),
    );
    expect(await answered(refused)).toEqual({ status: 403, body: { ok: false, error: 'origin_refused' } });
  });

  it('refuses a control character in an address or an answer, and keeps a line feed', async () => {
    const h = await harness();
    for (const email of ['ana\u001b]8;;https://x/\u0007@x.co', 'ana\u009b@x.co']) {
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, email }));
      expect(await answered(res)).toEqual({ status: 400, body: { ok: false, error: 'invalid_email' } });
    }
    for (const use_case of ['x\u001b[2Jy', 'a\r\nb']) {
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, properties: { tier: 'team', use_case } }));
      expect(await answered(res)).toEqual({ status: 400, body: { ok: false, error: 'invalid_property', property: 'use_case' } });
    }
    nothingWritten(h);

    const res = await h.forms.POST(
      joinRequest('cloud-waitlist', { ...WORKED, properties: { tier: 'team', use_case: 'line one\nline two' } }),
    );
    expect(res.status).toBe(200);
    expect((await membership(h, 'ana@lightfield.co'))?.properties).toEqual({ tier: 'team', use_case: 'line one\nline two' });
  });

  it('refuses text that is not well-formed in an address or an answer', async () => {
    const h = await harness();
    const email = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, email: 'ana\uD800@x.co' }));
    expect(await answered(email)).toEqual({ status: 400, body: { ok: false, error: 'invalid_email' } });
    const answer = await h.forms.POST(
      joinRequest('cloud-waitlist', { ...WORKED, properties: { tier: 'team', use_case: 'docs \uDFFF' } }),
    );
    expect(await answered(answer)).toEqual({ status: 400, body: { ok: false, error: 'invalid_property', property: 'use_case' } });
    nothingWritten(h);
  });

  it('traps true, a non-zero number or non-blank text in the honeypot, and nothing else', async () => {
    for (const website of [true, 1, -1, 'x']) {
      const h = await harness();
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, website }));
      expect(`${JSON.stringify(website)}: ${JSON.stringify(await answered(res))}`).toBe(
        `${JSON.stringify(website)}: {"status":200,"body":{"ok":true}}`,
      );
      expect(h.guardCalls()).toBe(0);
      nothingWritten(h);
    }
    // An empty field, and an unchecked box sent as false or 0, is a person's join.
    for (const website of [null, '', ' \n\t', false, 0, {}, []]) {
      const h = await harness();
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, website }));
      expect(res.status).toBe(200);
      expect(`${JSON.stringify(website)}: ${h.joins.length} ${h.db.memberships.length}`).toBe(`${JSON.stringify(website)}: 1 1`);
    }
  });

  it('reports a store that does not answer to onError as store', async () => {
    const read = await harness();
    read.store.failNext = 'read';
    expect((await read.forms.POST(joinRequest('cloud-waitlist', WORKED))).status).toBe(503);
    const write = await harness();
    write.store.failNext = 'write';
    expect((await write.forms.POST(joinRequest('cloud-waitlist', WORKED))).status).toBe(503);
    for (const h of [read, write]) {
      expect(h.errors.map(([error, where]) => [where, (error as { storeError?: boolean }).storeError])).toEqual([['store', true]]);
    }
  });

  it('refuses a bad form, a missing required answer and an array body', async () => {
    const h = await harness();
    const form = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, form: 'has space' }));
    expect(await answered(form)).toEqual({ status: 400, body: { ok: false, error: 'invalid_field', field: 'form' } });
    const missing = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, properties: { use_case: 'x' } }));
    expect(await answered(missing)).toEqual({ status: 400, body: { ok: false, error: 'missing_property', property: 'tier' } });
    const array = await h.forms.POST(joinRequest('cloud-waitlist', [WORKED]));
    expect(await answered(array)).toEqual({ status: 400, body: { ok: false, error: 'invalid_body' } });
    nothingWritten(h);
  });

  it('a hook that throws or rejects never fails the join', async () => {
    for (const onJoin of [
      (): void => {
        throw new Error('sync');
      },
      async (): Promise<void> => {
        throw new Error('async');
      },
    ]) {
      const h = await harness({ onJoin });
      const res = await h.forms.POST(joinRequest('cloud-waitlist', WORKED));
      expect(await answered(res)).toEqual({ status: 200, body: { ok: true } });
      expect(h.db.memberships).toHaveLength(1);
      expect(h.errors.map(([error, where]) => [(error as Error).message, where])).toEqual([
        [onJoin.constructor.name === 'AsyncFunction' ? 'async' : 'sync', 'onJoin'],
      ]);
    }
  });

  it('hands the hook to defer unstarted, so a new address answers as fast as a returning one', async () => {
    const queued: (() => Promise<void>)[] = [];
    let ran = 0;
    const h = await harness({
      defer: (run) => {
        queued.push(run);
      },
      onJoin: (e) => {
        if (e.isNew) {
          const until = Date.now() + 50;
          while (Date.now() < until) {
            // 50 ms of synchronous work on a new address alone
          }
        }
        ran += 1;
      },
    });
    const timed = async (email: string): Promise<number> => {
      const started = performance.now();
      const res = await h.forms.POST(joinRequest('cloud-waitlist', { ...WORKED, email }));
      expect(res.status).toBe(200);
      return performance.now() - started;
    };
    await timed('warm@x.co');
    const returning = await timed('warm@x.co');
    const fresh = await timed('new@x.co');
    expect(Math.abs(fresh - returning)).toBeLessThan(10);
    expect(queued).toHaveLength(3);
    expect(ran).toBe(0);
    for (const run of queued) await run();
    expect(ran).toBe(3);

    // Without defer the hook is awaited: it has finished when the answer comes.
    let finished = false;
    const awaited = await harness({
      onJoin: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished = true;
      },
    });
    await awaited.forms.POST(joinRequest('cloud-waitlist', WORKED));
    expect(finished).toBe(true);
  });

  it('builds the event’s unsubscribe link on unsubscribeBase', async () => {
    const h = await harness();
    await h.forms.POST(joinRequest('cloud-waitlist', WORKED));
    const token = mintUnsubscribeToken('ana@lightfield.co', SECRET);
    expect(h.joins[0]?.unsubscribeUrl).toBe(`${BASE}/unsubscribe?token=${encodeURIComponent(token)}`);
  });

  it('routes on the last two segments, join first', () => {
    expect(routeOf('https://x.co/join/g')).toEqual({ kind: 'join', group: 'g' });
    expect(routeOf('https://x.co/api/stet/join/g')).toEqual({ kind: 'join', group: 'g' });
    expect(routeOf('https://x.co/api/stet/join/unsubscribe')).toEqual({ kind: 'join', group: 'unsubscribe' });
    expect(routeOf('https://x.co/api/stet/unsubscribe')).toEqual({ kind: 'unsubscribe' });
    expect(routeOf('https://x.co/api/stet/join')).toBeNull();
    expect(routeOf('https://x.co/api/stet/keys')).toBeNull();
    expect(routeOf('https://x.co/join/%E0%A4%A')).toBeNull();
  });

  it('answers a GET on a join 405 and a path it does not name 404', async () => {
    const h = await harness();
    const get = await h.forms.GET(new Request(`${BASE}/join/cloud-waitlist`));
    expect(await answered(get)).toEqual({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    const keys = await h.forms.POST(joinRequest('x', {}, { url: `${BASE}/keys` }));
    expect(await answered(keys)).toEqual({ status: 404, body: { ok: false, error: 'not_found' } });
    const read = await h.forms.GET(new Request(`${BASE}/keys`));
    expect(read.status).toBe(404);
    // `/join/draft` is a join to a group named draft: never the mount's route.
    const draft = await h.forms.POST(joinRequest('draft', WORKED));
    expect(await answered(draft)).toEqual({ status: 404, body: { ok: false, error: 'unknown_group' } });
  });

  it('caps a body with no declared length, and one that lies about it', async () => {
    const h = await harness();
    const unsized = await h.forms.POST(streamedJoin(17 * 1024));
    expect(await answered(unsized)).toEqual({ status: 413, body: { ok: false, error: 'body_too_large' } });
    const lying = await h.forms.POST(streamedJoin(17 * 1024, 100));
    expect(await answered(lying)).toEqual({ status: 413, body: { ok: false, error: 'body_too_large' } });
    nothingWritten(h);
  });

  it('answers a preflight for a listed origin alone', async () => {
    const h = await harness();
    const preflight = (origin: string): Request =>
      new Request(`${BASE}/join/cloud-waitlist`, { method: 'OPTIONS', headers: { origin } });
    const listed = await h.forms.OPTIONS(preflight(SITE));
    expect(listed.status).toBe(204);
    expect(listed.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(listed.headers.get('access-control-allow-methods')).toBe('POST');
    expect(listed.headers.get('access-control-allow-headers')).toBe('content-type');
    const unlisted = await h.forms.OPTIONS(preflight('https://evil.example'));
    expect(unlisted.status).toBe(403);
    expect(unlisted.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses to be built without a secret, a guard or a usable unsubscribeBase', async () => {
    const store = createMemoryStore({ project: 'default' });
    const make = (over: Partial<FormsHandlerOptions>): unknown =>
      createStetFormsHandler({ store, secret: SECRET, unsubscribeBase: BASE, guard: 'none', ...over });
    for (const secret of ['', ' \n']) {
      expect(() => make({ secret })).toThrowError(
        'createStetFormsHandler: `secret` is empty — set the forms secret (stet.config.json formsSecretEnv)',
      );
    }
    expect(() => make({ guard: undefined as unknown as 'none' })).toThrowError(
      "createStetFormsHandler: `guard` is required — a function, or 'none' written knowingly",
    );
    for (const unsubscribeBase of [
      undefined,
      'http://getstet.xyz/api/stet',
      'https://getstet.xyz/api/stet?x=1',
      'https://getstet.xyz/api/stet#f',
      'https://getstet.xyz/api/stet?',
      'https://getstet.xyz/api/stet#',
      'https://u:p@getstet.xyz/api/stet',
      'https://@getstet.xyz/api/stet',
      'getstet.xyz/api/stet',
      'https:u:p@getstet.xyz/api/stet',
      'https:/u@getstet.xyz/api/stet',
    ]) {
      expect(() => make({ unsubscribeBase: unsubscribeBase as string })).toThrowError(
        "createStetFormsHandler: `unsubscribeBase` must be the forms mount's public https URL, https://<site>/api/stet, " +
          'with no query, fragment or credentials (http is accepted on localhost)',
      );
    }
    expect(() => make({ unsubscribeBase: 'http://localhost:3000/api/stet' })).not.toThrow();
    expect(() => make({ unsubscribeBase: 'http://127.0.0.1:8787/api/stet' })).not.toThrow();
  });
});

describe('the unsubscribe route', () => {
  const token = mintUnsubscribeToken('ana@lightfield.co', SECRET);
  const link = `${BASE}/unsubscribe?token=${encodeURIComponent(token)}`;
  const post = (body: BodyInit | null, type?: string): Request =>
    new Request(link, { method: 'POST', headers: type === undefined ? {} : { 'content-type': type }, body });

  function pageHeaders(res: Response): void {
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  }

  it('a GET shows the button and writes nothing', async () => {
    const h = await harness();
    const res = await h.forms.GET(new Request(link));
    expect(res.status).toBe(200);
    pageHeaders(res);
    const html = await res.text();
    expect(html).toContain('<title>Unsubscribe</title>');
    expect(html).toContain('<p>Unsubscribe ana@lightfield.co from marketing email?</p>');
    expect(html).toContain('<button type="submit">Unsubscribe</button>');
    expect(h.db.suppressions).toEqual([]);
    expect(h.unsubscribes).toEqual([]);
  });

  it('a one-click POST, form-encoded or multipart, records one-click', async () => {
    const h = await harness();
    const res = await h.forms.POST(post('List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(200);
    pageHeaders(res);
    expect(await res.text()).toContain('<p>ana@lightfield.co is unsubscribed from marketing email.</p>');
    expect(h.db.suppressions.map((s) => [s.email, s.scope, s.source])).toEqual([['ana@lightfield.co', 'marketing', 'one-click']]);

    const form = new FormData();
    form.set('List-Unsubscribe', 'One-Click');
    const multi = await harness();
    await multi.forms.POST(new Request(link, { method: 'POST', body: form }));
    expect(multi.unsubscribes).toEqual([{ email: 'ana@lightfield.co', source: 'one-click', newlySuppressed: true }]);

    // A mail client's hand-built body, its boundary holding capitals.
    const built = await harness();
    const body =
      '--AbCdEfBoundary\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--AbCdEfBoundary--\r\n';
    await built.forms.POST(post(body, 'multipart/form-data; boundary=AbCdEfBoundary'));
    expect(built.unsubscribes.map((e) => e.source)).toEqual(['one-click']);
  });

  it('any other POST is the page’s button', async () => {
    const plain = await harness();
    await plain.forms.POST(post('List-Unsubscribe=One-Click', 'text/plain'));
    expect(plain.unsubscribes.map((e) => e.source)).toEqual(['page']);
    const button = await harness();
    await button.forms.POST(post('confirm=yes', 'application/x-www-form-urlencoded'));
    expect(button.unsubscribes.map((e) => e.source)).toEqual(['page']);
  });

  it('a second POST answers 200 and writes nothing new', async () => {
    const h = await harness();
    await h.forms.POST(post('List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded'));
    const again = await h.forms.POST(post('List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded'));
    expect(again.status).toBe(200);
    expect(h.db.suppressions).toHaveLength(1);
    expect(h.unsubscribes.map((e) => e.newlySuppressed)).toEqual([true, false]);
  });

  it('an invalid link says so and writes nothing', async () => {
    const h = await harness();
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [
      flipped,
      mintUnsubscribeToken('ana@lightfield.co', 'another-secret'),
      mintPreviewToken({ kind: 'draft', key: 'hero_headline' }, SECRET, 1_700_000_000_000),
    ]) {
      const res = await h.forms.POST(
        new Request(`${BASE}/unsubscribe?token=${encodeURIComponent(bad)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        }),
      );
      expect(res.status).toBe(400);
      pageHeaders(res);
      expect(await res.text()).toContain('<p>This unsubscribe link is not valid.</p>');
    }
    expect(h.db.suppressions).toEqual([]);
  });

  it('a store that does not answer is the failed page, reported to onError as store', async () => {
    const h = await harness();
    h.store.failNext = 'write';
    const res = await h.forms.POST(post('List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(503);
    pageHeaders(res);
    expect(await res.text()).toContain('<p>Unsubscribing did not go through. Try the link again later.</p>');
    expect(h.errors.map(([, where]) => where)).toEqual(['store']);
  });

  it('escapes the address it prints', async () => {
    const h = await harness();
    const hostile = mintUnsubscribeToken('"><script>x</script>@a.co', SECRET);
    const res = await h.forms.GET(new Request(`${BASE}/unsubscribe?token=${encodeURIComponent(hostile)}`));
    expect(res.status).toBe(200);
    pageHeaders(res);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;x&lt;/script&gt;@a.co');
  });

  it('renders the host’s own page where it passes one', async () => {
    const h = await harness({ renderPage: (p) => `<p>${p.state} for ${p.email ?? 'nobody'}</p>` });
    const res = await h.forms.GET(new Request(link));
    expect(await res.text()).toBe('<p>confirm for ana@lightfield.co</p>');
    pageHeaders(res);
  });
});

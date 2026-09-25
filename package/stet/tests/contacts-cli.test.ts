/**
 * `stet contacts` through `runCli`, over a memory store injected under the
 * contacts name (a `contacts.store` project) or as the content store (a
 * store-backed one). Every line D9 pins is asserted as printed, and the
 * contacts spec's CLI scenarios word for word.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryDb, createMemoryStore, type MemoryStore } from '../adapters/store-memory.js';
import { parseCsv } from '../cli/contacts.js';
import { cleanupCliHosts, makeCliHost, type CliHost } from '../conformance/cli-host.js';
import { ok } from '../conformance/store.suite.js';

afterAll(cleanupCliHosts);
afterEach(() => {
  vi.useRealTimers();
});

const CONTACTS_CONFIG = { contacts: { store: { adapter: 'pg', urlEnv: 'STET_CONTACTS_DATABASE_URL' } } };
const TIERS = [
  { name: 'tier', type: 'enum' as const, values: ['solo', 'team', 'business'], required: true },
  { name: 'use_case', type: 'text' as const },
];

interface Run {
  code: number;
  out: string;
  err: string;
}

/** One project; each call answers its own output alone. */
function project(opts: { store?: MemoryStore; config?: Record<string, unknown>; backed?: boolean } = {}): {
  host: CliHost;
  store: MemoryStore;
  run: (...argv: string[]) => Promise<Run>;
} {
  const store = opts.store ?? createMemoryStore({ project: 'default', db: createMemoryDb() });
  const host =
    opts.backed === true
      ? makeCliHost({ config: { store: { adapter: 'memory' } }, store })
      : makeCliHost({ config: opts.config ?? CONTACTS_CONFIG, stores: { contacts: store } });
  const run = async (...argv: string[]): Promise<Run> => {
    const outAt = host.out.length;
    const errAt = host.err.length;
    const code = await host.run('contacts', ...argv);
    return { code, out: host.out.slice(outAt).join('\n'), err: host.err.slice(errAt).join('\n') };
  };
  return { host, store, run };
}

/** The website's group with three members joined a minute apart from 14:02 UTC, Ana unsubscribed. */
async function website(store: MemoryStore): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T14:02:00.000Z'));
  ok(await store.contacts.addGroup({ key: 'cloud-waitlist', name: 'stet Cloud', properties: TIERS }));
  ok(
    await store.contacts.join({
      group: 'cloud-waitlist',
      email: 'ana@lightfield.co',
      properties: { tier: 'team' },
      form: 'waitlist-page',
      page: 'https://getstet.xyz/waitlist',
    }),
  );
  vi.setSystemTime(new Date('2026-10-02T14:03:00.000Z'));
  ok(await store.contacts.join({ group: 'cloud-waitlist', email: 'sam@x.co', properties: { tier: 'solo' }, form: null, page: null }));
  vi.setSystemTime(new Date('2026-10-02T14:04:00.000Z'));
  ok(await store.contacts.join({ group: 'cloud-waitlist', email: 'lee@x.co', properties: { tier: 'business' } }));
  vi.setSystemTime(new Date('2026-10-03T09:30:00.000Z'));
  ok(await store.contacts.suppress({ email: 'ana@lightfield.co', scope: 'marketing', source: 'one-click' }));
  vi.useRealTimers();
}

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
}

describe('stet contacts group', () => {
  it('adds a group with its questions and prints the join path and body', async () => {
    const { run } = project();
    const added = await run('group', 'add', 'cloud-waitlist', '--name', 'stet Cloud', '--property', 'tier=solo,team,business', '--required', 'tier');
    expect(added).toEqual({
      code: 0,
      out: [
        'group cloud-waitlist: created, open — 1 property: tier (solo | team | business, required)',
        'join endpoint: POST <your forms mount>/join/cloud-waitlist',
        'body: {"email": "…", "properties": {"tier": "…"}, "form": "…", "page": "…"}',
      ].join('\n'),
      err: '',
    });
    expect(await run('group', 'add', 'cloud-waitlist')).toEqual({ code: 1, out: '', err: 'error: group cloud-waitlist already exists' });

    // Both flags repeat: every occurrence is read.
    const two = await run('group', 'add', 'launch', '--property', 'tier=solo,team', '--property', 'use_case', '--required', 'tier', '--required', 'use_case');
    expect(two.out.split('\n')[0]).toBe('group launch: created, open — 2 properties: tier (solo | team, required), use_case (required)');
    expect(two.out.split('\n')[2]).toBe('body: {"email": "…", "properties": {"tier": "…", "use_case": "…"}, "form": "…", "page": "…"}');

    const none = await run('group', 'add', 'managed-sending');
    expect(none.out).toBe(
      [
        'group managed-sending: created, open — no properties',
        'join endpoint: POST <your forms mount>/join/managed-sending',
        'body: {"email": "…", "properties": {}, "form": "…", "page": "…"}',
      ].join('\n'),
    );
  });

  it('refuses a bad key, a bad value list, an undeclared --required and a repeated --property', async () => {
    const { run } = project();
    expect(await run('group', 'add', 'Bad')).toEqual({
      code: 2,
      out: '',
      err: 'usage: Bad: a group key is lowercase letters, digits and -, up to 64 characters',
    });
    expect((await run('group', 'add', 'g', '--property', 'tier=a,a')).err).toBe(
      'usage: --property tier: the values are a list with no blanks or repeats',
    );
    expect((await run('group', 'add', 'g', '--property', 'tier=a,,b')).code).toBe(2);
    expect((await run('group', 'add', 'g', '--required', 'tier')).err).toBe('usage: --required tier: not a --property of this group');
    expect((await run('group', 'add', 'g', '--property', 'use_case', '--property', 'use_case')).err).toBe(
      'usage: --property use_case is given twice',
    );
    expect((await run('group', 'add', 'g', '--property', 'Tier')).err).toBe(
      'usage: --property Tier: a name is lowercase letters, digits and _, starting with a letter',
    );
    expect((await run('groups')).out).toBe('no groups — stet contacts group add <key> creates one');
  });

  it('closes and opens a group, and refuses a key it does not have', async () => {
    const { run, store } = project();
    await website(store);
    expect(await run('group', 'close', 'cloud-waitlist')).toEqual({ code: 0, out: 'group cloud-waitlist: closed', err: '' });
    expect((await run('groups')).out).toBe('cloud-waitlist   closed   3 members   tier (solo | team | business), use_case');
    expect(await run('group', 'open', 'cloud-waitlist')).toEqual({ code: 0, out: 'group cloud-waitlist: open', err: '' });
    expect(await run('group', 'close', 'nope')).toEqual({ code: 1, out: '', err: 'error: no group nope — stet contacts groups lists them' });
    expect((await run('group')).err).toBe('usage: stet contacts group add | open | close');
    expect((await run('group', 'wat')).err).toBe('usage: stet contacts group has add, open and close — got "wat"');
  });
});

describe('stet contacts groups, list and get', () => {
  it('reads the list the way the spec’s scenario words it', async () => {
    const { run, store } = project();
    await website(store);
    expect(await run('groups')).toEqual({
      code: 0,
      out: 'cloud-waitlist   open   3 members   tier (solo | team | business), use_case',
      err: '',
    });
    expect(await run('list', '--group', 'cloud-waitlist')).toEqual({
      code: 0,
      out: [
        'cloud-waitlist: 3 members',
        'ana@lightfield.co   joined 2 Oct 2026 14:02   tier=team   unsubscribed (marketing)',
        'sam@x.co   joined 2 Oct 2026 14:03   tier=solo',
        'lee@x.co   joined 2 Oct 2026 14:04   tier=business',
      ].join('\n'),
      err: '',
    });
    expect(await run('get', 'Ana@Lightfield.co')).toEqual({
      code: 0,
      out: [
        'ana@lightfield.co in project default — first seen 2 Oct 2026 14:02',
        '  cloud-waitlist   joined 2 Oct 2026 14:02 from https://getstet.xyz/waitlist (form waitlist-page)   tier=team',
        '  suppressed: marketing, 3 Oct 2026 09:30 (one-click)',
      ].join('\n'),
      err: '',
    });
  });

  it('answers --json with the same rows', async () => {
    const { run, store } = project();
    await website(store);
    const groups = JSON.parse((await run('groups', '--json')).out) as { ok: boolean; groups: { key: string; members: number }[] };
    expect(groups).toMatchObject({ ok: true, groups: [{ key: 'cloud-waitlist', members: 3 }] });
    const list = JSON.parse((await run('list', '--group', 'cloud-waitlist', '--json')).out) as {
      ok: boolean;
      group: string;
      members: { email: string; suppressed: boolean }[];
    };
    expect(list.ok).toBe(true);
    expect(list.group).toBe('cloud-waitlist');
    expect(list.members.map((m) => [m.email, m.suppressed])).toEqual([
      ['ana@lightfield.co', true],
      ['sam@x.co', false],
      ['lee@x.co', false],
    ]);
    const get = JSON.parse((await run('get', 'ana@lightfield.co', '--json')).out) as { ok: boolean; record: { email: string } };
    expect(get).toMatchObject({ ok: true, record: { email: 'ana@lightfield.co' } });
  });

  it('names a missing group, a person with a suppression alone, and nothing held', async () => {
    const { run, store } = project();
    await website(store);
    expect(await run('list', '--group', 'nope')).toEqual({ code: 1, out: '', err: 'error: no group nope — stet contacts groups lists them' });
    expect((await run('list')).err).toBe('usage: stet contacts list --group <key>');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T08:00:00.000Z'));
    ok(await store.contacts.suppress({ email: 'objector@x.co', scope: 'transactional', source: 'operator' }));
    vi.useRealTimers();
    expect((await run('get', 'objector@x.co')).out).toBe(
      ['objector@x.co in project default — no contact row', '  suppressed: transactional, 4 Oct 2026 08:00 (operator)'].join('\n'),
    );
    expect((await run('get', 'nobody@x.co')).out).toBe('nobody@x.co: nothing held in project default');
    expect((await run('get', 'not-an-address')).err).toBe('usage: not-an-address: not an email address');
  });

  it('reads the content store where no contacts block is declared', async () => {
    const { run, store } = project({ backed: true });
    await website(store);
    expect((await run('groups')).out).toBe('cloud-waitlist   open   3 members   tier (solo | team | business), use_case');
  });

  it('prints a stored control sequence inert, and --json byte-faithful', async () => {
    const db = createMemoryDb();
    const store = createMemoryStore({ project: 'default', db });
    await website(store);
    const hostile = 'x\u001b[2Jy \u009b31m \u001b]0;title\u0007';
    const ana = db.memberships[0]!;
    ana.properties = { tier: 'team', use_case: hostile };
    ana.page = `https://getstet.xyz/${hostile}`;
    const { run } = project({ store });

    for (const argv of [['get', 'ana@lightfield.co'], ['list', '--group', 'cloud-waitlist']]) {
      const printed = await run(...argv);
      expect(printed.code).toBe(0);
      // No C0 or C1 control byte reaches the terminal; each one reads U+FFFD.
      expect(printed.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(printed.out).toContain('x�[2Jy �31m �]0;title�');
    }
    const json = JSON.parse((await run('get', 'ana@lightfield.co', '--json')).out) as {
      record: { memberships: { page: string; properties: Record<string, string> }[] };
    };
    expect(json.record.memberships[0]?.properties['use_case']).toBe(hostile);
    expect(json.record.memberships[0]?.page).toBe(`https://getstet.xyz/${hostile}`);
  });
});

describe('stet contacts export', () => {
  it('prints the whole record to standard output', async () => {
    const { run, store } = project();
    await website(store);
    const printed = await run('export', 'ana@lightfield.co');
    expect(printed.code).toBe(0);
    expect(JSON.parse(printed.out)).toEqual(ok(await store.contacts.contact({ email: 'ana@lightfield.co' })).record);
    // Nothing held is still one document.
    expect(JSON.parse((await run('export', 'nobody@x.co')).out)).toEqual({
      email: 'nobody@x.co',
      contact: null,
      memberships: [],
      suppressions: [],
    });
  });

  it('writes --out only as a new file git does not track, mode 0600', async () => {
    const { run, store, host } = project();
    await website(store);
    git(host.cwd, 'init', '-q');
    expect(await run('export', 'ana@lightfield.co', '--out', 'ana.json')).toEqual({
      code: 1,
      out: '',
      err:
        'error: ana.json would be tracked by git — contacts never enter version control; write it outside the repository, ' +
        'or to a path .gitignore names and git does not track',
    });
    expect(existsSync(join(host.cwd, 'ana.json'))).toBe(false);

    writeFileSync(join(host.cwd, '.gitignore'), 'ana.json\nsecret-*.json\n');
    expect(await run('export', 'ana@lightfield.co', '--out', 'ana.json')).toEqual({ code: 0, out: 'wrote ana.json', err: '' });
    expect(statSync(join(host.cwd, 'ana.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(host.cwd, 'ana.json'), 'utf8'))).toMatchObject({ email: 'ana@lightfield.co' });

    // An existing file is refused and left as it was.
    writeFileSync(join(host.cwd, 'secret-2.json'), 'keep me');
    expect(await run('export', 'ana@lightfield.co', '--out', 'secret-2.json')).toEqual({
      code: 1,
      out: '',
      err: 'error: secret-2.json already exists — export writes a new file; remove it or name another',
    });
    expect(readFileSync(join(host.cwd, 'secret-2.json'), 'utf8')).toBe('keep me');

    // A missing folder is named.
    const missing = await run('export', 'ana@lightfield.co', '--out', 'nofolder/c.json');
    expect(missing.code).toBe(1);
    expect(missing.err).toBe(`error: nofolder/c.json: the folder ${join(host.cwd, 'nofolder')} does not exist — create it first`);

    // A file the index holds is tracked whatever a pattern says: force-added,
    // then deleted, it would come back as a tracked change.
    writeFileSync(join(host.cwd, 'secret-1.json'), '{}');
    git(host.cwd, 'add', '-f', 'secret-1.json');
    rmSync(join(host.cwd, 'secret-1.json'));
    expect((await run('export', 'ana@lightfield.co', '--out', 'secret-1.json')).err).toBe(
      'error: secret-1.json would be tracked by git — contacts never enter version control; write it outside the repository, ' +
        'or to a path .gitignore names and git does not track',
    );
    expect(existsSync(join(host.cwd, 'secret-1.json'))).toBe(false);
  });

  it('writes --out outside any repository', async () => {
    const { run, store, host } = project();
    await website(store);
    mkdirSync(join(host.cwd, 'out'));
    expect(await run('export', 'sam@x.co', '--out', 'out/sam.json')).toEqual({ code: 0, out: 'wrote out/sam.json', err: '' });
    expect(statSync(join(host.cwd, 'out/sam.json')).mode & 0o777).toBe(0o600);
  });
});

describe('stet contacts erase and suppress', () => {
  it('plans, then erases, keeping the suppression, and an import is turned away', async () => {
    const { run, store } = project();
    await website(store);
    expect(await run('erase', 'ana@lightfield.co')).toEqual({
      code: 0,
      out: [
        'plan: delete ana@lightfield.co in project default — 1 contact row, 1 membership (cloud-waitlist); the marketing suppression stays; ' +
          'a one-way hash is recorded so an import cannot add the address back',
        'run with --write to apply',
      ].join('\n'),
      err: '',
    });
    expect(ok(await store.contacts.contact({ email: 'ana@lightfield.co' })).record?.contact).not.toBeNull();

    expect(await run('erase', 'ana@lightfield.co', '--write')).toEqual({
      code: 0,
      out: 'erased ana@lightfield.co in project default — 1 contact row and 1 membership deleted, the hash recorded',
      err: '',
    });
    expect((await run('get', 'ana@lightfield.co')).out).toBe(
      ['ana@lightfield.co in project default — no contact row', '  suppressed: marketing, 3 Oct 2026 09:30 (one-click)'].join('\n'),
    );
    expect(ok(await store.contacts.importMember({ group: 'cloud-waitlist', email: 'ana@lightfield.co', properties: {}, form: 'import:x' }))).toEqual({
      outcome: 'erased',
    });

    expect((await run('erase', 'nobody@x.co')).out.split('\n')[0]).toBe(
      'plan: nobody@x.co is not a contact in project default — a one-way hash is recorded so an import cannot add the address',
    );
    expect((await run('erase', 'nobody@x.co', '--write')).out).toBe('nobody@x.co was not a contact in project default — the hash is recorded');
  });

  it('names each suppression that stays by its scope', async () => {
    const { run, store } = project();
    ok(await store.contacts.suppress({ email: 't@x.co', scope: 'transactional', source: 'operator' }));
    expect((await run('erase', 't@x.co')).out.split('\n')[0]).toBe(
      'plan: t@x.co is not a contact in project default — the transactional suppression stays; a one-way hash is recorded so an import cannot add the address',
    );
    ok(await store.contacts.suppress({ email: 't@x.co', scope: 'marketing', source: 'operator' }));
    expect((await run('erase', 't@x.co')).out.split('\n')[0]).toBe(
      'plan: t@x.co is not a contact in project default — the marketing and transactional suppressions stay; a one-way hash is recorded so an import cannot add the address',
    );
  });

  it('suppresses at once, per scope', async () => {
    const { run, store } = project();
    expect(await run('suppress', 'Ana@X.co')).toEqual({ code: 0, out: 'suppressed ana@x.co (marketing)', err: '' });
    expect((await run('suppress', 'ana@x.co')).out).toBe('ana@x.co was already suppressed (marketing)');
    expect((await run('suppress', 'ana@x.co', '--scope', 'transactional')).out).toBe('suppressed ana@x.co (transactional)');
    expect(await run('suppress', 'ana@x.co', '--scope', 'x')).toEqual({ code: 2, out: '', err: 'usage: --scope is marketing or transactional' });
    expect(ok(await store.contacts.contact({ email: 'ana@x.co' })).record?.suppressions.map((s) => s.source)).toEqual([
      'operator',
      'operator',
    ]);
  });
});

describe('stet contacts import', () => {
  async function waitlist(): Promise<ReturnType<typeof project>> {
    const made = project();
    ok(await made.store.contacts.addGroup({ key: 'cloud-waitlist', name: 'stet Cloud', properties: TIERS }));
    return made;
  }

  it('names each invalid row, skips it, and writes the rest', async () => {
    const { run, store, host } = await waitlist();
    // A BOM, a quoted comma, a row with no address and an enum miss.
    writeFileSync(
      join(host.cwd, 'list.csv'),
      '﻿email,tier,use_case\r\nana@x.co,team,"docs, blog"\r\n,solo,\r\nsam@x.co,enterprise,\r\nlee@x.co,solo,\r\n',
    );
    expect(await run('import', '--group', 'cloud-waitlist', '--file', 'list.csv')).toEqual({
      code: 0,
      out: [
        'plan: 4 rows for cloud-waitlist — 2 valid, 2 invalid; addresses already in the group, erased or suppressed are skipped when written',
        'run with --write to apply',
      ].join('\n'),
      err: ['warn: row 2: no valid email', 'warn: row 3: tier must be one of solo, team, business'].join('\n'),
    });
    expect(ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows).toEqual([]);

    const written = await run('import', '--group', 'cloud-waitlist', '--file', 'list.csv', '--write');
    expect(written.out).toBe('imported 2 into cloud-waitlist — 0 already members, 0 erased, 0 suppressed, 2 invalid');
    const rows = ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows;
    expect(rows.map((r) => [r.email, r.form, r.properties])).toEqual([
      ['ana@x.co', 'import:list.csv', { tier: 'team', use_case: 'docs, blog' }],
      ['lee@x.co', 'import:list.csv', { tier: 'solo' }],
    ]);
  });

  it('reads a JSON array, and refuses a JSON object', async () => {
    const { run, host } = await waitlist();
    writeFileSync(join(host.cwd, 'list.json'), JSON.stringify([{ email: 'ana@x.co', tier: 'team' }]));
    expect((await run('import', '--group', 'cloud-waitlist', '--file', 'list.json', '--write')).out).toBe(
      'imported 1 into cloud-waitlist — 0 already members, 0 erased, 0 suppressed, 0 invalid',
    );
    writeFileSync(join(host.cwd, 'one.json'), JSON.stringify({ email: 'ana@x.co' }));
    expect(await run('import', '--group', 'cloud-waitlist', '--file', 'one.json')).toEqual({
      code: 1,
      out: '',
      err: `error: ${join(host.cwd, 'one.json')} must be a JSON array of objects, one per person`,
    });
    expect((await run('import', '--group', 'nope', '--file', 'list.json')).err).toBe(
      'error: no group nope — stet contacts groups lists them',
    );
    expect((await run('import', '--group', 'cloud-waitlist')).err).toBe('usage: stet contacts import --group <key> --file <json|csv>');
  });

  it('takes --joined-at only as a time with its zone', async () => {
    const { run, store, host } = await waitlist();
    writeFileSync(
      join(host.cwd, 'times.csv'),
      [
        'email,tier,created_at',
        'zoneless@x.co,solo,2026-09-01 10:00:00',
        'utc@x.co,solo,2026-09-01 10:00:00Z',
        'offset@x.co,solo,2026-09-01T10:00:00+02:00',
        'never@x.co,solo,yesterday',
      ].join('\n'),
    );
    const done = await run('import', '--group', 'cloud-waitlist', '--file', 'times.csv', '--joined-at', 'created_at', '--write');
    expect(done.err).toBe(
      [
        'warn: row 1: created_at 2026-09-01 10:00:00 has no time zone — append Z for UTC or an offset such as +02:00',
        'warn: row 4: created_at is not a date',
      ].join('\n'),
    );
    expect(done.out).toBe('imported 2 into cloud-waitlist — 0 already members, 0 erased, 0 suppressed, 2 invalid');
    const rows = ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows;
    expect(rows.map((r) => [r.email, r.joinedAt])).toEqual([
      ['utc@x.co', '2026-09-01T10:00:00.000Z'],
      ['offset@x.co', '2026-09-01T08:00:00.000Z'],
    ]);
  });

  it('reads Postgres’s own timestamp text, an hour-only offset, and a lowercase t and z', async () => {
    const { run, store, host } = await waitlist();
    writeFileSync(
      join(host.cwd, 'pg.csv'),
      [
        'email,tier,created_at',
        'pg@x.co,solo,2026-09-01 10:00:00.123456+00',
        'hour@x.co,solo,2026-09-01 12:00:00+02',
        'lower@x.co,solo,2026-09-01t10:00:00z',
      ].join('\n'),
    );
    const done = await run('import', '--group', 'cloud-waitlist', '--file', 'pg.csv', '--joined-at', 'created_at', '--write');
    expect(done).toMatchObject({ code: 0, err: '' });
    const rows = ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows;
    expect(rows.map((r) => [r.email, r.joinedAt])).toEqual([
      ['pg@x.co', '2026-09-01T10:00:00.123Z'],
      ['hour@x.co', '2026-09-01T10:00:00.000Z'],
      ['lower@x.co', '2026-09-01T10:00:00.000Z'],
    ]);
  });

  it('refuses a --joined-at day that does not exist, or one still to come', async () => {
    const { run, store, host } = await waitlist();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T14:00:00.000Z'));
    writeFileSync(
      join(host.cwd, 'days.csv'),
      [
        'email,tier,created_at',
        'feb30@x.co,solo,2026-02-30 10:00:00Z',
        'midnight@x.co,solo,2026-09-01T24:00:00Z',
        'later@x.co,solo,2026-10-02T14:00:01Z',
        'leap@x.co,solo,2024-02-29T10:00:00Z',
        'now@x.co,solo,2026-10-02T14:00:00Z',
      ].join('\n'),
    );
    const done = await run('import', '--group', 'cloud-waitlist', '--file', 'days.csv', '--joined-at', 'created_at', '--write');
    vi.useRealTimers();
    expect(done.err).toBe(
      [
        'warn: row 1: created_at is not a date',
        'warn: row 2: created_at is not a date',
        'warn: row 3: created_at 2026-10-02T14:00:01Z is in the future',
      ].join('\n'),
    );
    const rows = ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows;
    expect(rows.map((r) => [r.email, r.joinedAt])).toEqual([
      ['leap@x.co', '2024-02-29T10:00:00.000Z'],
      ['now@x.co', '2026-10-02T14:00:00.000Z'],
    ]);
  });

  it('refuses a file whose name cannot be the form it records, before any row', async () => {
    const { run, store, host } = await waitlist();
    const longest = `${'w'.repeat(88)}.json`;
    const tooLong = `${'w'.repeat(89)}.json`;
    for (const name of [longest, tooLong, 'waitlist export.json']) {
      writeFileSync(join(host.cwd, name), JSON.stringify([{ email: 'ana@x.co', tier: 'team' }]));
    }
    expect(await run('import', '--group', 'cloud-waitlist', '--file', tooLong, '--write')).toEqual({
      code: 1,
      out: '',
      err:
        'error: the file name is 94 characters — an import records it as the form import:<file name>, ' +
        'which holds at most 100, so the file name at most 93; rename the file',
    });
    expect(await run('import', '--group', 'cloud-waitlist', '--file', 'waitlist export.json')).toEqual({
      code: 1,
      out: '',
      err:
        'error: the file name waitlist export.json holds a character a form name cannot — an import records it as ' +
        'the form import:<file name>, made of letters, digits and . _ @ : -; rename the file',
    });
    expect(ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows).toEqual([]);
    expect((await run('import', '--group', 'cloud-waitlist', '--file', longest, '--write')).code).toBe(0);
    expect(ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows.map((r) => r.form)).toEqual([`import:${longest}`]);
  });

  it('plans, writes, and on a second write counts every row a member (the D1 export)', async () => {
    const { run, store, host } = await waitlist();
    const rows = Array.from({ length: 14 }, (_, i) => ({
      email: `person${i + 1}@example.com`,
      tier: ['solo', 'team', 'business'][i % 3],
      created_at: `2026-09-${String(i + 1).padStart(2, '0')} 10:00:00Z`,
    }));
    writeFileSync(join(host.cwd, 'waitlist.json'), JSON.stringify(rows));
    const args = ['import', '--group', 'cloud-waitlist', '--file', 'waitlist.json', '--joined-at', 'created_at'];
    expect((await run(...args)).out.split('\n')[0]).toBe(
      'plan: 14 rows for cloud-waitlist — 14 valid, 0 invalid; addresses already in the group, erased or suppressed are skipped when written',
    );
    expect((await run(...args, '--write')).out).toBe('imported 14 into cloud-waitlist — 0 already members, 0 erased, 0 suppressed, 0 invalid');
    const members = ok(await store.contacts.members({ group: 'cloud-waitlist' })).rows;
    expect(members.map((m) => m.joinedAt)).toEqual(rows.map((r) => new Date(r.created_at).toISOString()));
    expect((await run(...args, '--write')).out).toBe('imported 0 into cloud-waitlist — 14 already members, 0 erased, 0 suppressed, 0 invalid');

    // An erased address is counted erased, and no contact row comes back.
    expect((await run('erase', 'person1@example.com', '--write')).code).toBe(0);
    expect((await run(...args, '--write')).out).toBe('imported 0 into cloud-waitlist — 13 already members, 1 erased, 0 suppressed, 0 invalid');
    expect(ok(await store.contacts.contact({ email: 'person1@example.com' })).record).toBeNull();
  });

  it('parses RFC 4180 quoting', () => {
    expect(parseCsv('a,"b,c",d\r\n"x""y",,z')).toEqual([
      ['a', 'b,c', 'd'],
      ['x"y', '', 'z'],
    ]);
  });
});

describe('stet contacts, the refusals', () => {
  const COMMANDS: string[][] = [
    ['groups'],
    ['list', '--group', 'g'],
    ['get', 'a@b.co'],
    ['export', 'a@b.co'],
    ['erase', 'a@b.co'],
    ['suppress', 'a@b.co'],
    ['import', '--group', 'g', '--file', 'x.csv'],
    ['group', 'add', 'g'],
    ['group', 'open', 'g'],
    ['group', 'close', 'g'],
  ];

  it('tells a project with no store behind its contacts, for every command', async () => {
    const host = makeCliHost({ config: {} });
    for (const argv of COMMANDS) {
      const errAt = host.err.length;
      expect(`${argv.join(' ')}: ${await host.run('contacts', ...argv)}`).toBe(`${argv.join(' ')}: 1`);
      expect(host.err.slice(errAt)).toEqual(['error: stet contacts needs a store — see stet upgrade']);
    }
  });

  it('refuses an --env the contacts block does not declare', async () => {
    const { run } = project();
    expect(await run('groups', '--env', 'prod')).toEqual({
      code: 2,
      out: '',
      err: "usage: --env prod: the contacts block in stet.config.json declares no environments — only 'default', its store",
    });
  });

  it('answers a missing or unknown subcommand with the usage', async () => {
    const { run } = project();
    expect(await run()).toEqual({
      code: 2,
      out: '',
      err: 'usage: stet contacts groups | list | get | export | erase | suppress | import | group add | group open | group close',
    });
    expect((await run('wat')).err).toBe(
      'usage: stet contacts has groups | list | get | export | erase | suppress | import | group add | group open | group close — got "wat"',
    );
  });
});

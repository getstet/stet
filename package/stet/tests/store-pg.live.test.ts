/**
 * The live Postgres leg: the numbered migrations applied in order to a real
 * database, the whole conformance suite run against `store-pg`, and the
 * integrity claims that only a database can settle — the zero-active-versions
 * state is unobservable, each partial unique index rejects its illegal row with
 * application logic bypassed entirely, a group publish is all-or-nothing under
 * a concurrent writer, and the group revert's stale guard refuses inside the
 * write rather than in a caller that a racer could slip past.
 *
 * Gated on `STET_TEST_DATABASE_URL`, excluded from the default suite by the
 * `*.live.test.ts` name, and run through `npm run test:live`. A disposable
 * container is the intended harness:
 *
 *   docker run --rm -d -e POSTGRES_PASSWORD=stet -p 54329:5432 \
 *     --name stet-live-pg postgres:17
 *   STET_TEST_DATABASE_URL=postgresql://postgres:stet@localhost:54329/postgres \
 *     npm run test:live
 *
 * Everything lands in a schema of this file's own, dropped and recreated at the
 * start of the run. `public` is never touched, so a URL pointed somewhere real
 * loses nothing.
 */
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgStore, type PgStore } from '../adapters/store-pg.js';
import { ok, runStoreConformance } from '../conformance/store.suite.js';

const BASE = process.env['STET_TEST_DATABASE_URL'];
const SCHEMA = 'stet_live_test';
const MIGRATION = readFileSync(new URL('../migrations/001_content_cms.sql', import.meta.url), 'utf8');
const MIGRATION_2 = readFileSync(new URL('../migrations/002_changesets.sql', import.meta.url), 'utf8');

/** A connection pinned to this file's schema. Space and `=` must survive the URL. */
function scoped(base: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
}

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: scoped(BASE ?? '') });
  await c.connect();
  return c;
}

/** Every store this file opens, so the run can close its pools and exit. */
const opened: PgStore[] = [];
function store(project: string): PgStore {
  const made = createPgStore({ connectionString: scoped(BASE ?? ''), project });
  opened.push(made);
  return made;
}

const live = BASE ? describe : describe.skip;

// ── Raw-SQL helpers for the changeset legs ──────────────────────────────────
//
// The capability's adapter block is proven by the conformance suite; these
// cases go under it, to the SQL itself, because what they settle — the
// sentinel's three intents, the atomic flip, the guard inside the write — is
// the migration's contract, not a transport's.

/** A change row, opened directly: `open` is a table insert, not an RPC. */
async function openChange(c: pg.Client, project: string, name: string): Promise<number> {
  const row = await c.query<{ id: string }>(
    'insert into changesets (project, name) values ($1, $2) returning id',
    [project, name],
  );
  return Number(row.rows[0]?.id);
}

/**
 * One save at the SQL level. An absent `change` sends the TEN-argument call —
 * the sentinel's "leave membership alone" is the SQL default, and omitting the
 * argument is how every existing caller reaches it.
 */
async function save(
  c: pg.Client,
  p: {
    project: string;
    key: string;
    value: unknown;
    editor?: string;
    publishAt?: string | null;
    change?: number | null;
  },
): Promise<number> {
  const args: unknown[] = [
    p.key,
    JSON.stringify(p.value),
    'web',
    p.editor ?? 'neil',
    'default',
    p.project,
    null,
    null,
    p.publishAt ?? null,
    false,
  ];
  const grouped = 'change' in p;
  if (grouped) args.push(p.change);
  const row = await c.query<{ id: string }>(
    `select save_content_draft($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10${
      grouped ? ', $11' : ''
    }) as id`,
    args,
  );
  return Number(row.rows[0]?.id);
}

/** The draft row's own membership and stamp — no interface method returns them. */
async function draftRow(
  c: pg.Client,
  project: string,
  key: string,
): Promise<{ changeset_id: number | null; publish_at: Date | null } | undefined> {
  const row = await c.query<{ changeset_id: string | null; publish_at: Date | null }>(
    `select changeset_id, publish_at from content_versions
      where project = $1 and key = $2 and state = 'draft'`,
    [project, key],
  );
  const found = row.rows[0];
  if (found === undefined) return undefined;
  return {
    changeset_id: found.changeset_id === null ? null : Number(found.changeset_id),
    publish_at: found.publish_at,
  };
}

/** The message a raise carried, with a failure to raise at all reported as one. */
async function raised(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a raise, the call succeeded');
}

/** A promise's rejection as a value, so a blocked call can be awaited later. */
function settled(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (error: Error) => error,
  );
}

/** A refused statement's SQLSTATE — asserted by code, never by English text. */
function sqlstate(error: Error | null): string | undefined {
  return (error as (Error & { code?: string }) | null)?.code;
}

/** The grant case's own role password. Under trust auth any password connects;
 * under the password auth a real container uses, only this one does. */
const ROLE_PASSWORD = 'stet_grant_pw';

/**
 * A connection to the SAME server `BASE` names, as another user. Host, port and
 * database come from `BASE` so the case follows whatever container it is
 * pointed at; only the credentials are ours, and the password is never
 * inherited — `BASE` carries the superuser's, which is not this role's.
 */
function roleConnection(user: string, password: string): pg.ClientConfig {
  const base = new URL(BASE ?? '');
  return {
    host: base.hostname,
    port: base.port === '' ? 5432 : Number(base.port),
    database: base.pathname.replace(/^\//, '') || 'postgres',
    user,
    password,
  };
}

if (BASE) {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    await admin.end();

    // The migrations as a stranger's database receives them: each file whole,
    // in number order, on a vanilla Postgres with no anon/authenticated roles
    // to revoke from — 002 over a 001 that already holds rows is the upgrade
    // path every existing install walks.
    const c = await client();
    await c.query(MIGRATION);
    await c.query(MIGRATION_2);
    await c.end();
  }, 60_000);

  afterAll(async () => {
    for (const s of opened) await s.end();
  });

  // The same suite the memory adapter passes, against the real thing.
  runStoreConformance('pg', (project) => store(project));
}

live('the migrations, applied in order', () => {
  it('a copied migration knows its own version', async () => {
    const c = await client();
    const meta = await c.query<{ schema_version: number; descriptor_version: string }>(
      'select schema_version, descriptor_version from stet_meta',
    );
    expect(meta.rows).toHaveLength(1);
    // 002's last statement is the stamp, and it is an UPDATE of 001's row: the
    // counter walks, it is never re-inserted.
    expect(meta.rows[0]?.schema_version).toBe(2);
    // '' means not yet stamped: a static file cannot know the project's
    // descriptor version, and `stet upgrade`/`seed` stamp it later.
    expect(meta.rows[0]?.descriptor_version).toBe('');
    await c.end();
  });

  it('ships the columns that cannot be retrofitted, and no CHECK on target', async () => {
    const c = await client();
    const columns = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = 'content_versions'`,
      [SCHEMA],
    );
    const names = columns.rows.map((r) => r.column_name).sort();
    // `changeset_id` is 002's additive column — membership itself, with no
    // member table behind it.
    expect(names).toEqual([
      'changeset_id', 'created_at', 'editor', 'id', 'is_active', 'key', 'label', 'locale', 'note',
      'origin_env', 'origin_id', 'project', 'publish_at', 'published_at', 'published_by',
      'reverted_from', 'state', 'target', 'value',
    ]);

    // A CHECK on target would turn every new target into a migration.
    const checks = await c.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = $1::regclass and contype = 'c'`,
      [`${SCHEMA}.content_versions`],
    );
    expect(checks.rows.some((r) => r.definition.includes('target'))).toBe(false);
    expect(checks.rows.some((r) => r.definition.includes('state'))).toBe(true);

    // The three values live in a comment, and telegram-md2 ships now even
    // though its adapter is phase 2.
    expect(MIGRATION).toContain("'web' | 'html-email' | 'telegram-md2'");

    // The RPCs are security invoker, never definer. One row per SIGNATURE, so
    // this exact list is also the overload proof: 002 changes two signatures,
    // and a `create or replace` that minted a second one instead of replacing
    // would show the name twice here and every legacy call would then be
    // ambiguous.
    const functions = await c.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
        where pronamespace = $1::regnamespace order by proname`,
      [SCHEMA],
    );
    expect(functions.rows.map((r) => r.proname)).toEqual([
      'discard_content_draft',
      'publish_change',
      'publish_content_version',
      'rename_content_key',
      'revert_content_version',
      'save_content_draft',
      'stet_publish_flip',
    ]);
    expect(functions.rows.every((r) => r.prosecdef === false)).toBe(true);
    await c.end();
  });

  it('a 001-era call still resolves against the one signature 002 leaves behind', async () => {
    const c = await client();
    // The whole reason 002 drops before it creates. Ten arguments is the 001
    // form of save; three is the 001 form of revert. Against an overload pair
    // each would fail with "function is not unique" — the first call every
    // existing install would make after upgrading.
    const draft = await c.query<{ id: string }>(
      'select save_content_draft($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10) as id',
      ['legacy_key', '"legacy wording"', 'web', 'neil', 'default', 'legacy_call', null, null, null, false],
    );
    expect(Number(draft.rows[0]?.id)).toBeGreaterThan(0);
    const published = await c.query<{ id: string }>(
      'select publish_content_version($1, $2, $3, $4) as id',
      ['legacy_key', 'neil', 'default', 'legacy_call'],
    );
    const versionId = Number(published.rows[0]?.id);
    await c.query<{ id: string }>('select revert_content_version($1, $2, $3) as id', [
      versionId,
      'neil',
      'legacy_call',
    ]);
    await c.end();
  });

  it('a partial apply cannot claim migration 2', async () => {
    // The file's own begin/commit is the whole guarantee, and this is the mode
    // that tests it: `psql -f` without ON_ERROR_STOP runs a file statement by
    // statement with errors NON-FATAL, so position alone would let it skip the
    // failure and stamp anyway. Reproduced here by sending the doctored file in
    // three sends on ONE connection — the half through the injected failure,
    // the remainder (which the aborted transaction refuses statement by
    // statement, exactly as psql would), then the file's closing commit.
    //
    // Two injection points, because they roll back different things: after the
    // ALTER TABLE, where the table and the column are what must vanish; and
    // after the save_content_draft DROP, where the function itself has already
    // been dropped inside the transaction and must come BACK.
    const points: [string, string][] = [
      ['stet_partial_early', 'alter table content_versions add column changeset_id bigint;'],
      [
        'stet_partial_late',
        'drop function if exists save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean);',
      ],
    ];

    for (const [schema, marker] of points) {
      const c = new pg.Client({ connectionString: BASE ?? '' });
      await c.connect();
      await c.query(`drop schema if exists ${schema} cascade`);
      await c.query(`create schema ${schema}`);
      await c.query(`set search_path to ${schema}`);
      await c.query(MIGRATION);

      const cut = MIGRATION_2.indexOf(marker);
      expect({ schema, markerFound: cut >= 0 }).toEqual({ schema, markerFound: true });
      const at = cut + marker.length;

      // 22012 is division_by_zero — the injected statement, reached and run.
      const head = await settled(c.query(`${MIGRATION_2.slice(0, at)}\nselect 1/0;\n`));
      expect(sqlstate(head)).toBe('22012');
      // Every statement after the failure is refused rather than run (25P02,
      // in_failed_sql_transaction): this is what "errors non-fatal" cannot get
      // past, because the file opened a transaction of its own.
      const rest = await settled(c.query(MIGRATION_2.slice(at)));
      expect(sqlstate(rest)).toBe('25P02');
      // …and the closing commit rolls back instead of committing.
      expect((await c.query('commit')).command).toBe('ROLLBACK');

      const meta = await c.query<{ schema_version: number }>('select schema_version from stet_meta');
      expect(`${schema}: ${meta.rows[0]?.schema_version}`).toBe(`${schema}: 1`);

      const tables = await c.query<{ table_name: string }>(
        'select table_name from information_schema.tables where table_schema = $1 order by 1',
        [schema],
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        'content_versions',
        'stet_meta',
        'stet_renames',
      ]);

      const column = await c.query<{ n: number }>(
        `select count(*)::int as n from information_schema.columns
          where table_schema = $1 and table_name = 'content_versions' and column_name = 'changeset_id'`,
        [schema],
      );
      expect(`${schema}: ${column.rows[0]?.n}`).toBe(`${schema}: 0`);

      // 001's four functions, at their 001 arities — one signature of
      // save_content_draft, and it is the TEN-argument one. At the late
      // injection point this is the DROP itself rolling back.
      const functions = await c.query<{ proname: string; pronargs: number }>(
        'select proname, pronargs from pg_proc where pronamespace = $1::regnamespace order by proname',
        [schema],
      );
      expect(functions.rows.map((r) => `${r.proname}/${r.pronargs}`)).toEqual([
        'publish_content_version/4',
        'rename_content_key/4',
        'revert_content_version/3',
        'save_content_draft/10',
      ]);

      await c.query(`drop schema ${schema} cascade`);
      await c.end();
    }
  }, 60_000);

  it('carries a deployment’s own EXECUTE grants across the signature change', async () => {
    // The self-hosted operator who granted BY NAME — 001's own idiom — is the
    // deployment DROP+CREATE breaks: the ACL goes with the old signature and
    // the role's writes start failing with a bare permission error outside the
    // marker vocabulary. A frozen file gets no second chance, so 002 captures
    // the grants before the drops and replays them after the revokes.
    const schema = 'stet_grants_live';
    const role = 'stet_002_grantee';
    const admin = new pg.Client({ connectionString: BASE ?? '' });
    await admin.connect();
    await admin.query(`drop schema if exists ${schema} cascade`);
    // Idempotent from a dirty database: a previous run that failed mid-case
    // leaves the role behind, and `create role` on an existing name is an error.
    // `drop owned by` refuses a name that does not exist, hence the catch.
    await admin.query(`drop owned by ${role} cascade`).catch(() => undefined);
    await admin.query(`drop role if exists ${role}`);
    await admin.query(`create schema ${schema}`);
    await admin.query(`set search_path to ${schema}`);
    await admin.query(MIGRATION);

    try {
      // BYPASSRLS because 001's tables carry row level security with no policies:
      // this is the service credential a real deployment uses, not an end user.
      // The password is explicit and known to this case alone: under trust auth
      // any password would pass, but under the ordinary password auth a real
      // container uses, only a password we set here can.
      await admin.query(`create role ${role} login password '${ROLE_PASSWORD}' bypassrls`);
      await admin.query(`grant usage on schema ${schema} to ${role}`);
      await admin.query(`grant select, insert, update, delete on all tables in schema ${schema} to ${role}`);
      await admin.query(`grant usage, select on all sequences in schema ${schema} to ${role}`);
      // Granted BY NAME on the exact 001 signatures — the two about to be dropped
      // and the one that keeps its signature.
      for (const signature of [
        'save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean)',
        'revert_content_version(bigint, text, text)',
        'publish_content_version(text, text, text, text)',
      ]) {
        await admin.query(`grant execute on function ${signature} to ${role}`);
      }

      await admin.query(MIGRATION_2);

      // The replay landed on the NEW signatures, and on the helper that
      // publish_content_version's body now calls — a security-invoker caller
      // needs EXECUTE on its callee too, which is why the surviving ACL alone
      // would not have been enough.
      for (const signature of [
        'save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint)',
        'revert_content_version(bigint, text, text, bigint)',
        'stet_publish_flip(text, text, text, text, boolean)',
        'publish_content_version(text, text, text, text)',
      ]) {
        const granted = await admin.query<{ ok: boolean }>(
          'select has_function_privilege($1, $2, $3) as ok',
          [role, `${schema}.${signature}`, 'EXECUTE'],
        );
        expect(`${signature}: ${granted.rows[0]?.ok}`).toBe(`${signature}: true`);
      }

      // Driven AS the role: all three write paths still work after the upgrade.
      // Built field by field from the SAME server BASE names, never from a
      // hand-written URL — a hardcoded host and port reach some other database
      // where this role was never created, and Postgres reports a missing role as
      // "password authentication failed", so the mistake reads as a credentials
      // bug. Only user and password are ours; the password is never inherited
      // from BASE, which carries the superuser's.
      const asRole = new pg.Client({ ...roleConnection(role, ROLE_PASSWORD), options: `-c search_path=${schema}` });
      await asRole.connect();
      await asRole.query(
        'select save_content_draft($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)',
        ['hero_headline', JSON.stringify('v1'), 'web', 'neil', 'default', 'granted', null, null, null, false, -1],
      );
      const published = await asRole.query<{ id: string }>(
        'select publish_content_version($1, $2, $3, $4) as id',
        ['hero_headline', 'sam', 'default', 'granted'],
      );
      const versionId = Number(published.rows[0]?.id);
      expect(versionId).toBeGreaterThan(0);
      await asRole.query(
        'select save_content_draft($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)',
        ['hero_headline', JSON.stringify('v2'), 'web', 'neil', 'default', 'granted', null, null, null, false, -1],
      );
      await asRole.query('select publish_content_version($1, $2, $3, $4)', [
        'hero_headline',
        'sam',
        'default',
        'granted',
      ]);
      await asRole.query('select revert_content_version($1, $2, $3, $4)', [versionId, 'sam', 'granted', null]);
      await asRole.end();

      // The zero-grant arm: a database that granted nothing captures nothing and
      // replays nothing, and the apply is clean either way.
      const bare = 'stet_grants_none';
      await admin.query(`drop schema if exists ${bare} cascade`);
      await admin.query(`create schema ${bare}`);
      await admin.query(`set search_path to ${bare}`);
      await admin.query(MIGRATION);
      await admin.query(MIGRATION_2);
      const meta = await admin.query<{ schema_version: number }>(
        `select schema_version from ${bare}.stet_meta`,
      );
      expect(meta.rows[0]?.schema_version).toBe(2);
      // Nothing was invented for a role that was never granted anything here.
      const invented = await admin.query<{ ok: boolean }>(
        'select has_function_privilege($1, $2, $3) as ok',
        [role, `${bare}.save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint)`, 'EXECUTE'],
      );
      expect(invented.rows[0]?.ok).toBe(false);
    } finally {
      // A role outlives the schema and the connection, so it is dropped even
      // when an assertion above threw — otherwise the next run inherits it.
      for (const statement of [
        `drop schema if exists ${schema} cascade`,
        `drop schema if exists ${'stet_grants_none'} cascade`,
        `drop owned by ${role} cascade`,
        `drop role if exists ${role}`,
      ]) {
        await admin.query(statement).catch(() => undefined);
      }
      await admin.end();
    }
  }, 60_000);

  it('fails the apply fast rather than queueing the site behind its lock', async () => {
    // The ADD COLUMN needs ACCESS EXCLUSIVE on a table carrying live traffic,
    // and while that request queues, every later reader queues behind IT — a
    // slow apply takes the site's reads down with it. `set local lock_timeout`
    // turns that into the documented failed-apply state instead.
    const schema = 'stet_lock_live';
    const applier = new pg.Client({ connectionString: BASE ?? '' });
    await applier.connect();
    await applier.query(`drop schema if exists ${schema} cascade`);
    await applier.query(`create schema ${schema}`);
    await applier.query(`set search_path to ${schema}`);
    await applier.query(MIGRATION);

    // A perfectly ordinary reader, holding its transaction open.
    const reader = new pg.Client({ connectionString: BASE ?? '' });
    await reader.connect();
    await reader.query(`set search_path to ${schema}`);
    await reader.query('begin');
    await reader.query('select count(*) from content_versions');

    const started = Date.now();
    const blocked = await settled(applier.query(MIGRATION_2));
    const elapsed = Date.now() - started;
    // 55P03 is lock_not_available — the timeout firing, not a deadlock and not
    // a syntax error.
    expect(sqlstate(blocked)).toBe('55P03');
    // Fast is the whole point: the 3 s timeout, not the reader's lifetime.
    expect(elapsed).toBeLessThan(30_000);
    await applier.query('rollback');

    // The documented failed-apply state, exactly as the partial-apply case
    // asserts it: schema_version 1 and no 002 schema.
    const meta = await applier.query<{ schema_version: number }>('select schema_version from stet_meta');
    expect(meta.rows[0]?.schema_version).toBe(1);
    const tables = await applier.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = $1 and table_name = 'changesets'`,
      [schema],
    );
    expect(tables.rows[0]?.n).toBe(0);

    // And it applies once the reader lets go — the refusal was the lock, not
    // anything wrong with the file.
    await reader.query('rollback');
    await reader.end();
    await applier.query(MIGRATION_2);
    const after = await applier.query<{ schema_version: number }>('select schema_version from stet_meta');
    expect(after.rows[0]?.schema_version).toBe(2);

    await applier.query(`drop schema ${schema} cascade`);
    await applier.end();
  }, 60_000);

  it('the new table and the new functions are as locked down as 001s', async () => {
    const c = await client();
    // Row level security denies any unnamed anonymous role by default, exactly
    // as 001's three tables carry it.
    const rls = await c.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = $1::regclass`,
      [`${SCHEMA}.changesets`],
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);

    // Every function 002 created or recreated has EXECUTE revoked from public.
    // `publish_content_version` is the deliberate omission from 002's revoke
    // list — a same-signature `create or replace` retains the ACL 001 set, and
    // this proves the retention rather than assuming it.
    const names = [
      'stet_publish_flip',
      'publish_change',
      'save_content_draft',
      'revert_content_version',
      'discard_content_draft',
      'publish_content_version',
      'rename_content_key',
    ];
    for (const name of names) {
      const granted = await c.query<{ has: boolean }>(
        `select has_function_privilege('public', p.oid, 'execute') as has
           from pg_proc p where p.pronamespace = $1::regnamespace and p.proname = $2`,
        [SCHEMA, name],
      );
      expect({ name, has: granted.rows[0]?.has }).toEqual({ name, has: false });
    }
    await c.end();
  });
});

live('the integrity story, settled by the database', () => {
  it('a mid-publish failure leaves the previous version live', async () => {
    const s = store('proof_zero');
    await s.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' });
    const published = await s.publish({ key: 'hero_headline', editor: 'neil' });
    if (!('versionId' in published)) throw new Error(`publish failed: ${JSON.stringify(published)}`);
    await s.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' });

    const c = await client();
    // Fail the flip specifically — after the clear has already run. The trigger
    // is table-wide, so it comes off in a finally: a failed assertion here must
    // not poison every publish that follows it in this file.
    await c.query(
      `create function stet_test_fail() returns trigger language plpgsql as $$
         begin raise exception 'injected failure'; end $$`,
    );
    await c.query(
      `create trigger stet_test_publish_fail before update on content_versions
         for each row when (NEW.state = 'published' and OLD.state = 'draft')
         execute function stet_test_fail()`,
    );
    try {
      const failed = await s.publish({ key: 'hero_headline', editor: 'neil' });
      expect(failed).toMatchObject({ storeError: true, code: 'unknown' });
      expect((failed as { message: string }).message).toContain('injected failure');

      // The whole transaction rolled back: the previous version is still
      // active, there is exactly one active row, and the zero-active state was
      // never observable to any reader.
      // (A raw client, unlike the adapter's pool, hands bigints back as text.)
      const rows = await c.query<{ id: string; state: string; is_active: boolean }>(
        `select id, state, is_active from content_versions
          where project = 'proof_zero' and key = 'hero_headline' order by id`,
      );
      const active = rows.rows.filter((r) => r.is_active);
      expect(active).toHaveLength(1);
      expect(Number(active[0]?.id)).toBe(published.versionId);
      expect(rows.rows.filter((r) => r.state === 'draft')).toHaveLength(1);
    } finally {
      await c.query('drop trigger stet_test_publish_fail on content_versions');
      await c.query('drop function stet_test_fail()');
    }

    const second = await s.publish({ key: 'hero_headline', editor: 'neil' });
    expect(second).toMatchObject({ versionId: expect.any(Number) });
    const after = await s.read();
    expect(after).toEqual([
      expect.objectContaining({ key: 'hero_headline', value: 'second', is_active: true }),
    ]);
    await c.end();
  });

  it('the active index rejects a second live version, application logic bypassed', async () => {
    const s = store('proof_active');
    await s.saveDraft({ key: 'hero_headline', value: 'live', target: 'web', editor: 'neil' });
    expect(await s.publish({ key: 'hero_headline', editor: 'neil' })).toMatchObject({
      versionId: expect.any(Number),
    });

    const c = await client();
    // A direct insert — no RPC, no adapter, no application logic at all.
    await expect(
      c.query(
        `insert into content_versions (project, key, target, value, state, is_active)
         values ('proof_active', 'hero_headline', 'web', '"sneaked in"', 'published', true)`,
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const active = await c.query<{ count: string }>(
      `select count(*) from content_versions
        where project = 'proof_active' and key = 'hero_headline' and is_active`,
    );
    expect(active.rows[0]?.count).toBe('1');
    await c.end();
  });

  it('the draft index makes two concurrent first-saves one draft', async () => {
    const holder = await client();
    const racer = await client();
    // Parameterized, not spliced: an editor name is data, here as everywhere
    // else in this package.
    const save = (c: pg.Client, editor: string): Promise<unknown> =>
      c.query('select save_content_draft($1, $2::jsonb, $3, $4, $5, $6)', [
        'raced_key',
        JSON.stringify(editor),
        'web',
        editor,
        'default',
        'proof_draft',
      ]);

    // The holder saves inside an open transaction and does not commit, so the
    // racer's own SELECT sees nothing and it inserts — straight onto the
    // uncommitted index entry, where it waits.
    await holder.query('begin');
    await save(holder, 'holder');
    const raced = save(racer, 'racer').then(
      () => null,
      (error: Error) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query('commit');

    const failure = await raced;
    expect(failure).toBeInstanceOf(Error);
    // Surfaced, never retried: a retry of a write that landed would duplicate.
    expect(failure?.message).toContain('concurrent_save:raced_key');

    const drafts = await holder.query<{ count: string }>(
      `select count(*) from content_versions
        where project = 'proof_draft' and key = 'raced_key' and state = 'draft'`,
    );
    expect(drafts.rows[0]?.count).toBe('1');
    await holder.end();
    await racer.end();
  }, 30_000);

  it('a save masks the draft race and nothing else', async () => {
    const s = store('proof_discriminate');
    const c = await client();
    // A constraint this migration does not have. Its violation must travel
    // unmasked: reporting it as a save race would tell the caller to look at a
    // concurrent editor who does not exist.
    await c.query(
      `create unique index stet_test_one_note on content_versions (project, note) where note is not null`,
    );
    try {
      await s.saveDraft({ key: 'first_key', value: 'a', target: 'web', editor: 'neil', note: 'shared note' });
      const clashed = await s.saveDraft({
        key: 'second_key',
        value: 'b',
        target: 'web',
        editor: 'neil',
        note: 'shared note',
      });
      expect(clashed).toMatchObject({ storeError: true, code: 'unknown' });
      const { message } = clashed as { message: string };
      expect(message).toContain('stet_test_one_note');
      expect(message).not.toContain('concurrent_save');
    } finally {
      await c.query('drop index stet_test_one_note');
      await c.end();
    }
  });

  it('two renames onto one key serialize, and the loser is refused', async () => {
    const s = store('proof_rename');
    // The merge the partial unique indexes never catch: one source is
    // published-only, the other draft-only, so their rows never collide on
    // either index — an unlocked guard lets both renames through and two
    // histories become one.
    await s.saveDraft({ key: 'src_published', value: 'live wording', target: 'web', editor: 'neil' });
    await s.publish({ key: 'src_published', editor: 'neil' });
    await s.saveDraft({ key: 'src_draft', value: 'work in progress', target: 'web', editor: 'sam' });

    const first = await client();
    const second = await client();
    const rename = (c: pg.Client, oldKey: string, editor: string): Promise<unknown> =>
      c.query('select rename_content_key($1, $2, $3, $4)', [oldKey, 'merged_key', editor, 'proof_rename']);

    await first.query('begin');
    await rename(first, 'src_published', 'neil');

    // The second session takes the advisory lock's queue, not the guard: it
    // cannot see the uncommitted rows, so an unlocked check would pass.
    const blocked = rename(second, 'src_draft', 'sam').then(
      () => null,
      (error: Error) => error,
    );
    const pending = Symbol('pending');
    const early = await Promise.race([
      blocked,
      new Promise((resolve) => setTimeout(() => resolve(pending), 500)),
    ]);
    expect(early).toBe(pending);

    await first.query('commit');
    const refused = await blocked;
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain('target_occupied:merged_key');

    // One history under the new name, and the draft-only source never moved.
    const rows = await first.query<{ key: string; state: string }>(
      `select key, state from content_versions where project = 'proof_rename' order by id`,
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual(['merged_key', 'src_draft']);
    await first.end();
    await second.end();
  }, 30_000);

  it('a scheduled save carries its stamp to the row, and publish consumes it', async () => {
    const s = store('proof_schedule');
    await s.saveDraft({
      key: 'farewell_notice',
      value: 'scheduled wording',
      target: 'telegram-md2',
      editor: 'neil',
      publishAt: '2026-09-01T09:00:00.000Z',
    });

    // No interface method returns a draft row's metadata, so the parameter is
    // proven here: dropping p_publish_at from the adapter's call would leave
    // this null and every other test green.
    const c = await client();
    const draft = await c.query<{ publish_at: Date | null; target: string }>(
      `select publish_at, target from content_versions
        where project = $1 and key = $2 and state = 'draft'`,
      ['proof_schedule', 'farewell_notice'],
    );
    expect(draft.rows[0]?.publish_at?.toISOString()).toBe('2026-09-01T09:00:00.000Z');
    expect(draft.rows[0]?.target).toBe('telegram-md2');

    // A null publish_at means publish-now: publish nulls the stamp on its way
    // through, whether the trigger was a click or the clock.
    const published = await s.publish({ key: 'farewell_notice', editor: 'sam' });
    if (!('versionId' in published)) throw new Error(`publish failed: ${JSON.stringify(published)}`);
    const after = await c.query<{ publish_at: Date | null; editor: string; published_by: string }>(
      'select publish_at, editor, published_by from content_versions where id = $1',
      [published.versionId],
    );
    expect(after.rows[0]?.publish_at).toBeNull();
    // The draft's author survived a publish by someone else.
    expect(after.rows[0]?.editor).toBe('neil');
    expect(after.rows[0]?.published_by).toBe('sam');
    await c.end();
  });
});

live('the access posture, settled by the database', () => {
  it('a role the migration never heard of is denied by row level security', async () => {
    const seeded = store('proof_rls');
    await seeded.saveDraft({ key: 'hero_headline', value: 'live wording', target: 'web', editor: 'neil' });
    await seeded.publish({ key: 'hero_headline', editor: 'neil' });

    const c = await client();
    // A self-hosted PostgREST's anonymous role is whatever its operator called
    // it — the tutorial's web_anon — and it arrives holding the default grants
    // the revokes above only know how to take from anon/authenticated.
    await c.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'web_anon') then
        create role web_anon nologin;
      end if;
    end $$;`);
    await c.query(`grant usage on schema ${SCHEMA} to web_anon`);
    await c.query(`grant select, insert, update, delete on all tables in schema ${SCHEMA} to web_anon`);

    try {
      // The privilege really is granted: this is not a test of a role with
      // nothing to lose.
      const granted = await c.query<{ has: boolean }>(
        'select has_table_privilege($1, $2, $3) as has',
        ['web_anon', `${SCHEMA}.content_versions`, 'select'],
      );
      expect(granted.rows[0]?.has).toBe(true);

      const asOwner = await c.query<{ count: string }>('select count(*) from content_versions');
      expect(Number(asOwner.rows[0]?.count)).toBeGreaterThan(0);

      await c.query('set role web_anon');
      // Deny by default: rows exist, the privilege is held, and the read
      // returns nothing because no policy grants it anything.
      const asAnon = await c.query<{ count: string }>('select count(*) from content_versions');
      expect(asAnon.rows[0]?.count).toBe('0');
      await expect(
        c.query(`insert into content_versions (project, key, target, value, state)
                 values ('proof_rls', 'sneaked_in', 'web', '"x"', 'draft')`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('reset role');
      await c.query(`revoke all on all tables in schema ${SCHEMA} from web_anon`);
      await c.query(`revoke usage on schema ${SCHEMA} from web_anon`);
      await c.end();
    }
  });
});

live('the changeset semantics, settled by the database', () => {
  it('the sentinel keeps membership on a re-save and detaches on an explicit null', async () => {
    const c = await client();
    const project = 'cs_sentinel';
    const change = await openChange(c, project, 'copy tweaks');

    await save(c, { project, key: 'hero_headline', value: 'a', change });
    expect((await draftRow(c, project, 'hero_headline'))?.changeset_id).toBe(change);

    // An autosave omits the argument. A member that quietly left the group here
    // would be published alone by the next click.
    await save(c, { project, key: 'hero_headline', value: 'b' });
    expect((await draftRow(c, project, 'hero_headline'))?.changeset_id).toBe(change);

    await save(c, { project, key: 'hero_headline', value: 'c', change: null });
    expect((await draftRow(c, project, 'hero_headline'))?.changeset_id).toBeNull();
    await c.end();
  });

  it('no unvalidated change id ever reaches a draft row', async () => {
    const c = await client();
    const project = 'cs_gate';
    // The gate is `p_change <> -1`, never a positivity test: 0 and negatives
    // load-and-fail rather than bypassing validation into a phantom membership.
    for (const id of [0, -5, 999_999]) {
      const message = await raised(() =>
        save(c, { project, key: 'hero_headline', value: 'x', change: id }),
      );
      expect(message).toContain(`no_change:${id}`);
    }
    expect(await draftRow(c, project, 'hero_headline')).toBeUndefined();
    await c.end();
  });

  it('a change belonging to another project cannot take a draft', async () => {
    const c = await client();
    const foreign = await openChange(c, 'cs_other', 'someone elses change');
    const message = await raised(() =>
      save(c, { project: 'cs_cross', key: 'hero_headline', value: 'x', change: foreign }),
    );
    expect(message).toContain(
      `wrong_project:cs_cross (change ${foreign} belongs to project cs_other)`,
    );
    await c.end();
  });

  it('a grouped draft cannot carry a schedule of its own', async () => {
    const c = await client();
    const project = 'cs_stamp';
    const change = await openChange(c, project, 'grouped');
    await save(c, { project, key: 'hero_headline', value: 'a', change });

    // A personally stamped member would be due outside its change — the exact
    // state the clock's demotion sweep exists to clean. Loud beats silent.
    const message = await raised(() =>
      save(c, {
        project,
        key: 'hero_headline',
        value: 'b',
        publishAt: '2030-01-01T00:00:00.000Z',
      }),
    );
    expect(message).toContain('grouped_schedule:hero_headline');
    await c.end();
  });

  it('a member of a scheduled change inherits the change stamp', async () => {
    const c = await client();
    const project = 'cs_inherit';
    const change = await openChange(c, project, 'scheduled');
    await c.query('update changesets set status = $1, publish_at = $2 where id = $3', [
      'scheduled',
      '2030-06-01T09:00:00.000Z',
      change,
    ]);

    // Attaching after the schedule, and re-saving a member already attached,
    // both take the change's column — it stays authoritative.
    await save(c, { project, key: 'hero_headline', value: 'a', change });
    await save(c, { project, key: 'hero_sub', value: 'b', change });
    await save(c, { project, key: 'hero_sub', value: 'c' });
    for (const key of ['hero_headline', 'hero_sub']) {
      expect((await draftRow(c, project, key))?.publish_at?.toISOString()).toBe(
        '2030-06-01T09:00:00.000Z',
      );
    }
    await c.end();
  });

  it('the group flip publishes every member keeping changeset_id, and a solo publish clears it', async () => {
    const c = await client();
    const project = 'cs_flip';
    const change = await openChange(c, project, 'two members');
    await save(c, { project, key: 'hero_headline', value: 'a', change });
    await save(c, { project, key: 'hero_sub', value: 'b', change });

    const flipped = await c.query<{ o_key: string; o_locale: string; o_version_id: string }>(
      'select o_key, o_locale, o_version_id from publish_change($1, $2, $3)',
      [change, 'sam', project],
    );
    expect(flipped.rows.map((r) => r.o_key)).toEqual(['hero_headline', 'hero_sub']);
    expect(flipped.rows.every((r) => r.o_locale === 'default')).toBe(true);
    expect(flipped.rows.every((r) => Number(r.o_version_id) > 0)).toBe(true);

    // The minted rows KEEP the tag: it is what the before-state derivation, the
    // revert guard and the grouped history all read.
    const members = await c.query<{ count: string }>(
      `select count(*) from content_versions
        where project = $1 and changeset_id = $2 and state = 'published' and is_active`,
      [project, change],
    );
    expect(members.rows[0]?.count).toBe('2');
    const row = await c.query<{ status: string; publish_at: Date | null }>(
      'select status, publish_at from changesets where id = $1',
      [change],
    );
    expect(row.rows[0]).toMatchObject({ status: 'published', publish_at: null });

    // D1: the same key through the per-key door drops out of its group.
    const solo = await openChange(c, project, 'solo');
    await save(c, { project, key: 'footer_note', value: 'c', change: solo });
    await c.query('select publish_content_version($1, $2, $3, $4)', [
      'footer_note',
      'sam',
      'default',
      project,
    ]);
    const minted = await c.query<{ changeset_id: string | null }>(
      `select changeset_id from content_versions
        where project = $1 and key = 'footer_note' and is_active`,
      [project],
    );
    expect(minted.rows[0]?.changeset_id).toBeNull();
    await c.end();
  });

  it('the closed, empty and missing-change refusals name their marker', async () => {
    const c = await client();
    const project = 'cs_refusals';

    const empty = await openChange(c, project, 'nothing in it');
    expect(await raised(() => c.query('select * from publish_change($1, $2, $3)', [empty, 'sam', project])))
      .toContain(`no_members:${empty}`);
    expect(await raised(() => c.query('select * from publish_change($1, $2, $3)', [999_999, 'sam', project])))
      .toContain('no_change:999999');

    const done = await openChange(c, project, 'already out');
    await save(c, { project, key: 'hero_headline', value: 'a', change: done });
    await c.query('select * from publish_change($1, $2, $3)', [done, 'sam', project]);
    // Publishing it again, and attaching a new draft to it, refuse the same way.
    expect(await raised(() => c.query('select * from publish_change($1, $2, $3)', [done, 'sam', project])))
      .toContain(`change_closed:${done}`);
    expect(await raised(() => save(c, { project, key: 'hero_sub', value: 'b', change: done })))
      .toContain(`change_closed:${done}`);
    await c.end();
  });

  it('an orphaned member detaches on its next save rather than raising', async () => {
    const c = await client();
    const project = 'cs_orphan';
    const doomed = await openChange(c, project, 'abandoned mid-edit');
    await save(c, { project, key: 'hero_headline', value: 'a', change: doomed });
    // The interleaved-abandon state: the change row is gone, the draft still
    // points at it. Raising here would brick every later autosave of this key.
    await c.query('delete from changesets where id = $1', [doomed]);

    await save(c, {
      project,
      key: 'hero_headline',
      value: 'b',
      publishAt: '2031-01-01T00:00:00.000Z',
    });
    const after = await draftRow(c, project, 'hero_headline');
    expect(after?.changeset_id).toBeNull();
    // Detached, so the caller's own stamp is honored and the stale one is gone.
    expect(after?.publish_at?.toISOString()).toBe('2031-01-01T00:00:00.000Z');
    await c.end();
  });

  it('discard deletes the draft, refuses the second call, and the index admits a fresh one', async () => {
    const c = await client();
    const project = 'cs_discard';
    await save(c, { project, key: 'hero_headline', value: 'a' });
    await c.query('select publish_content_version($1, $2, $3, $4)', [
      'hero_headline',
      'sam',
      'default',
      project,
    ]);
    await save(c, { project, key: 'hero_headline', value: 'b' });

    const dropped = await c.query<{ id: string }>(
      'select discard_content_draft($1, $2, $3) as id',
      ['hero_headline', 'default', project],
    );
    expect(Number(dropped.rows[0]?.id)).toBeGreaterThan(0);
    expect(await draftRow(c, project, 'hero_headline')).toBeUndefined();

    // The published rows and the active version are untouched.
    const active = await c.query<{ count: string }>(
      `select count(*) from content_versions
        where project = $1 and key = 'hero_headline' and is_active`,
      [project],
    );
    expect(active.rows[0]?.count).toBe('1');

    expect(
      await raised(() =>
        c.query('select discard_content_draft($1, $2, $3)', ['hero_headline', 'default', project]),
      ),
    ).toContain('no_draft:hero_headline (default)');

    // The partial unique index has nothing left to collide with.
    await save(c, { project, key: 'hero_headline', value: 'c' });
    await c.end();
  });
});

live('the changeset races, settled by the database', () => {
  it('a concurrently solo-published member leaves the group and the rest publish without it', async () => {
    const holder = await client();
    const runner = await client();
    const project = 'cs_dropout';
    const change = await openChange(holder, project, 'two members');
    await save(holder, { project, key: 'a_key', value: 'a', change });
    await save(holder, { project, key: 'b_key', value: 'b', change });

    // The solo publish lands inside an open transaction, so publish_change's
    // pre-check still sees b_key's draft; the commit arrives while the member
    // loop waits on that row's lock.
    await holder.query('begin');
    await holder.query('select publish_content_version($1, $2, $3, $4)', [
      'b_key',
      'sam',
      'default',
      project,
    ]);
    const grouped = runner.query<{ o_key: string }>(
      'select o_key from publish_change($1, $2, $3)',
      [change, 'neil', project],
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query('commit');

    // The FOR UPDATE re-evaluation drops b_key: it left the group (D1), it did
    // not double-publish.
    expect((await grouped).rows.map((r) => r.o_key)).toEqual(['a_key']);
    const tags = await holder.query<{ key: string; changeset_id: string | null }>(
      `select key, changeset_id from content_versions
        where project = $1 and is_active order by key`,
      [project],
    );
    expect(tags.rows.map((r) => [r.key, r.changeset_id === null ? null : Number(r.changeset_id)])).toEqual([
      ['a_key', change],
      ['b_key', null],
    ]);
    // The change still completed: one member flipping is enough, so the
    // post-loop count does not fire and the change reads published. The
    // no_members arm below is the case where it flipped NOTHING.
    const row = await holder.query<{ status: string; publish_at: Date | null }>(
      'select status, publish_at from changesets where id = $1',
      [change],
    );
    expect(row.rows[0]).toMatchObject({ status: 'published', publish_at: null });
    await holder.end();
    await runner.end();
  }, 30_000);

  it('a member conflict aborts the whole group publish, naming the key', async () => {
    const holder = await client();
    const runner = await client();
    const project = 'cs_allornothing';
    await save(runner, { project, key: 'a_key', value: 'v1' });
    const first = await runner.query<{ id: string }>(
      'select publish_content_version($1, $2, $3, $4) as id',
      ['a_key', 'sam', 'default', project],
    );
    const restorable = Number(first.rows[0]?.id);
    await save(runner, { project, key: 'a_key', value: 'v2' });
    await runner.query('select publish_content_version($1, $2, $3, $4)', [
      'a_key',
      'sam',
      'default',
      project,
    ]);

    const change = await openChange(runner, project, 'both or neither');
    await save(runner, { project, key: 'a_key', value: 'v3', change });
    await save(runner, { project, key: 'b_key', value: 'b1', change });

    // A concurrent revert mints a_key's active row mid-flight: the group flip's
    // clear finds the row it meant to deactivate already gone and its own flip
    // collides with the newly live one.
    await holder.query('begin');
    await holder.query('select revert_content_version($1, $2, $3)', [restorable, 'sam', project]);
    const grouped = settled(
      runner.query('select * from publish_change($1, $2, $3)', [change, 'neil', project]),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query('commit');

    const failure = await grouped;
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('publish_conflict:a_key');

    // All-or-nothing: b_key never published, both drafts are intact, and the
    // change is still open. A half-published group is unobservable.
    const drafts = await holder.query<{ key: string }>(
      `select key from content_versions
        where project = $1 and state = 'draft' and changeset_id = $2 order by key`,
      [project, change],
    );
    expect(drafts.rows.map((r) => r.key)).toEqual(['a_key', 'b_key']);
    const published = await holder.query<{ count: string }>(
      `select count(*) from content_versions
        where project = $1 and key = 'b_key' and state = 'published'`,
      [project],
    );
    expect(published.rows[0]?.count).toBe('0');
    const row = await holder.query<{ status: string }>('select status from changesets where id = $1', [
      change,
    ]);
    expect(row.rows[0]?.status).toBe('open');
    await holder.end();
    await runner.end();
  }, 30_000);

  it('a member set emptied under the lock refuses no_members rather than publishing nothing', async () => {
    const holder = await client();
    const runner = await client();
    const project = 'cs_emptyloop';
    const change = await openChange(holder, project, 'one member');
    await save(holder, { project, key: 'only_key', value: 'a', change });

    await holder.query('begin');
    await holder.query('select publish_content_version($1, $2, $3, $4)', [
      'only_key',
      'sam',
      'default',
      project,
    ]);
    const grouped = settled(
      runner.query('select * from publish_change($1, $2, $3)', [change, 'neil', project]),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query('commit');

    // The exists pre-check passed — it ran before the commit — and the loop then
    // flipped nothing. Without the post-loop count the change would read
    // published having published none of its members.
    const failure = await grouped;
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(`no_members:${change}`);
    const row = await holder.query<{ status: string }>('select status from changesets where id = $1', [
      change,
    ]);
    expect(row.rows[0]?.status).toBe('open');
    // And the member is live EXACTLY once. The refusing transaction rolled back
    // whole, so the solo publish is the only one that landed — a second flip
    // here would be the double-publish the row lock exists to prevent.
    const published = await holder.query<{ count: string }>(
      `select count(*) from content_versions
        where project = $1 and key = 'only_key' and state = 'published'`,
      [project],
    );
    expect(published.rows[0]?.count).toBe('1');
    await holder.end();
    await runner.end();
  }, 30_000);

  it('the stale guard refuses inside the write once the active row has moved', async () => {
    const c = await client();
    const project = 'cs_guard';
    await save(c, { project, key: 'hero_headline', value: 'v1' });
    const first = await c.query<{ id: string }>(
      'select publish_content_version($1, $2, $3, $4) as id',
      ['hero_headline', 'sam', 'default', project],
    );
    const restorable = Number(first.rows[0]?.id);
    await save(c, { project, key: 'hero_headline', value: 'v2' });
    const second = await c.query<{ id: string }>(
      'select publish_content_version($1, $2, $3, $4) as id',
      ['hero_headline', 'sam', 'default', project],
    );
    const expected = Number(second.rows[0]?.id);

    const restored = await c.query<{ id: string }>(
      'select revert_content_version($1, $2, $3, $4) as id',
      [restorable, 'sam', project, expected],
    );
    expect(Number(restored.rows[0]?.id)).toBeGreaterThan(expected);

    // The identical call again: the active row has moved to the revert row, so
    // the deactivating update matches nothing and the write refuses itself. A
    // caller-side check could not close this gap — the skip has to be in the
    // write. This is exactly what a re-run of a torn group revert does.
    expect(
      await raised(() =>
        c.query('select revert_content_version($1, $2, $3, $4)', [
          restorable,
          'sam',
          project,
          expected,
        ]),
      ),
    ).toContain(`stale_active:hero_headline (expected active ${expected}, it has moved)`);

    // Nothing was cleared and nothing was minted.
    const active = await c.query<{ count: string }>(
      `select count(*) from content_versions
        where project = $1 and key = 'hero_headline' and is_active`,
      [project],
    );
    expect(active.rows[0]?.count).toBe('1');

    // An unguarded revert keeps 001's behavior.
    await c.query('select revert_content_version($1, $2, $3)', [restorable, 'sam', project]);
    await c.end();
  });
});

live('a caller-side guard racing publish_change', () => {
  /**
   * The three writes that read a change's status and then change it. Their
   * guard read is a separate statement, so `publish_change` can commit in the
   * window between — and then only a predicate carried by the write ITSELF can
   * still refuse.
   *
   * A held row lock makes the window deterministic instead of hopeful: the
   * adapter's write parks on the lock with its guard read already returned and
   * stale, the publish lands and commits, and the write re-evaluates its own
   * predicate as it wakes. Which row to lock differs by operation — abandon
   * reaches the member drafts first, schedule reaches the change row first — so
   * each case locks whichever row its target write blocks on.
   */
  async function raced(
    project: string,
    lockSql: string,
    act: (s: PgStore, changeId: number) => Promise<unknown>,
  ): Promise<{ answer: unknown; status: string; members: { key: string; state: string }[] }> {
    const s = store(project);
    const { changeId } = ok(await s.changesets.open({ name: 'raced' }));
    ok(
      await s.saveDraft({
        key: 'hero_headline',
        value: 'grouped',
        target: 'web',
        editor: 'neil',
        change: changeId,
      }),
    );

    const holder = await client();
    await holder.query('begin');
    await holder.query(lockSql, [project, changeId]);

    // The adapter's guard read runs and returns unblocked; its write then parks
    // on the lock above.
    const pending = act(s, changeId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await holder.query('select * from publish_change($1, $2, $3)', [changeId, 'sam', project]);
    await holder.query('commit');

    const answer = await pending;
    const row = await holder.query<{ status: string }>('select status from changesets where id = $1', [
      changeId,
    ]);
    const members = await holder.query<{ key: string; state: string }>(
      'select key, state from content_versions where project = $1 and changeset_id = $2 order by key',
      [project, changeId],
    );
    await holder.end();
    return { answer, status: row.rows[0]?.status ?? 'gone', members: members.rows };
  }

  const LOCK_CHANGE_ROW = 'select id from changesets where project = $1 and id = $2 for update';
  const LOCK_MEMBER_DRAFT =
    "select id from content_versions where project = $1 and changeset_id = $2 and state = 'draft' for update";

  it('refuses to abandon a change that published under it, and loses no history', async () => {
    // Unguarded this deletes the row of a published change: the answer reads
    // `{abandoned: true, droppedDrafts: 0}`, live rows dangle a changeset_id
    // pointing at nothing, and the group revert and the change-before preview
    // are gone with no way back.
    const { answer, status, members } = await raced('cs_race_abandon', LOCK_MEMBER_DRAFT, (s, id) =>
      s.changesets.abandon({ changeId: id }),
    );
    expect(answer).toMatchObject({ storeError: true, code: 'conflict' });
    expect((answer as { message: string }).message).toContain('change_closed:');
    // The change and its minted member are both still there to read.
    expect(status).toBe('published');
    expect(members).toEqual([{ key: 'hero_headline', state: 'published' }]);
  }, 30_000);

  it('refuses to cancel a change that published under it', async () => {
    // The demotion sweep runs unattended on the host's cron, so it races an
    // operator's publish on its own schedule. Unguarded, the cancel walks a
    // published change back to open and the group revert is refused forever.
    const { answer, status, members } = await raced('cs_race_cancel', LOCK_CHANGE_ROW, (s, id) =>
      s.changesets.schedule({ changeId: id, publishAt: null }),
    );
    expect(answer).toMatchObject({ storeError: true, code: 'conflict' });
    expect((answer as { message: string }).message).toContain('change_closed:');
    expect(status).toBe('published');
    // The refusal returns before the member stamps, so no stray publish_at was
    // written onto a row that is already live.
    expect(members).toEqual([{ key: 'hero_headline', state: 'published' }]);
  }, 30_000);

  it('refuses to reschedule a change that published under it', async () => {
    const { answer, status } = await raced('cs_race_reschedule', LOCK_CHANGE_ROW, (s, id) =>
      s.changesets.schedule({ changeId: id, publishAt: '2030-01-01T00:00:00.000Z' }),
    );
    expect(answer).toMatchObject({ storeError: true, code: 'conflict' });
    expect((answer as { message: string }).message).toContain('change_closed:');
    expect(status).toBe('published');
    const c = await client();
    // Not merely refused — nothing was stamped either.
    const stamp = await c.query<{ publish_at: Date | null }>(
      'select publish_at from changesets where id = (select max(id) from changesets where project = $1)',
      ['cs_race_reschedule'],
    );
    expect(stamp.rows[0]?.publish_at).toBeNull();
    await c.end();
  }, 30_000);

  it('leaves the uncontended paths exactly as they were', async () => {
    // The predicate must cost the ordinary path nothing: with no racer, all
    // three still do what they did.
    const s = store('cs_race_calm');
    const { changeId } = ok(await s.changesets.open({ name: 'calm' }));
    ok(
      await s.saveDraft({
        key: 'hero_headline',
        value: 'v1',
        target: 'web',
        editor: 'neil',
        change: changeId,
      }),
    );
    expect(ok(await s.changesets.schedule({ changeId, publishAt: '2030-01-01T00:00:00.000Z' }))).toEqual({
      status: 'scheduled',
    });
    expect(ok(await s.changesets.schedule({ changeId, publishAt: null }))).toEqual({ status: 'open' });
    expect(ok(await s.changesets.abandon({ changeId }))).toEqual({ abandoned: true, droppedDrafts: 1 });
    expect(await s.changesets.get({ changeId })).toMatchObject({ storeError: true });
  }, 30_000);
});

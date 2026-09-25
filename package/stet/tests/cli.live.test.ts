/**
 * The live CLI leg: the install path end to end against a real Postgres.
 *
 * Everything the offline suite proves with an injected store, proved here
 * against the thing itself — the migration applied by `stet upgrade --store
 * pg`, the seed writing version 1 through the real RPCs, the scheduler
 * publishing a due draft, `pull` reading version metadata off active rows, and
 * `stet_meta` carrying the stamp both commands promise.
 *
 * Gated on `STET_TEST_DATABASE_URL`, excluded from the default suite by the
 * `*.live.test.ts` name, and run through `npm run test:live`:
 *
 *   docker run --rm -d -e POSTGRES_PASSWORD=stet -p 54333:5432 postgres:17
 *   # wait with a HOST-side connect loop — `pg_isready` inside the container
 *   # reports ready during initdb's temporary-server phase and lies
 *   STET_TEST_DATABASE_URL=postgres://postgres:stet@localhost:54333/postgres \
 *     npm run test:live
 *
 * Two schemas of this file's own, dropped and recreated at the start of the
 * run: one the install writes into, one left bare so the unversioned-database
 * path is exercised against a real `42P01`.
 */
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applySql, createPgStore, readStetMeta } from '../adapters/store-pg.js';
import { cleanupCliHosts, makeCliHost, type CliHost } from '../conformance/cli-host.js';
import { loadDescriptor, readBundle } from '../src/index.js';

const BASE = process.env['STET_TEST_DATABASE_URL'];
const SCHEMA = 'stet_cli_live';
const BARE = 'stet_cli_live_bare';
const HALF = 'stet_cli_live_half';
/**
 * The environments leg's three schemas. §8.1 calls an environment "a different
 * database"; a schema-scoped connection satisfies that — it is a different
 * CONNECTION, with its own tables, which is the whole of what selection changes.
 */
const ENV_A = 'stet_env_a';
const ENV_B = 'stet_env_b';
const ENV_UNMIGRATED = 'stet_env_unmigrated';
/** Migration 3's legs: a host object colliding by kind, a first install, the grants, a contacts store. */
const COLLIDE = ['stet_c3_table', 'stet_c3_index', 'stet_c3_sequence', 'stet_c3_domain', 'stet_c3_function'];
const FIRST = 'stet_c3_first';
const GRANTS = 'stet_c3_grants';
const CONTACTS = 'stet_c3_contacts';
const CONTACTS_PROD = 'stet_c3_contacts_prod';
const CONTENT_STAGING = 'stet_c3_staging';

/** A connection pinned to a schema. Space and `=` must survive the URL. */
function scoped(schema: string): string {
  const base = BASE ?? '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/** A project whose store is the real thing, resolved from config, not injected. */
function liveHost(): CliHost {
  return makeCliHost({
    config: { store: { adapter: 'pg' } },
    env: { STET_DATABASE_URL: scoped(SCHEMA) },
  });
}

async function admin(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: BASE });
  await client.connect();
  return client;
}

/** Server-side connections this database is holding open, excluding our own. */
async function backends(): Promise<number> {
  const client = await admin();
  const answer = await client.query<{ count: string }>(
    'select count(*)::text as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
  );
  await client.end();
  return Number(answer.rows[0]?.count ?? '0');
}

const live = BASE ? describe : describe.skip;

if (BASE) {
  beforeAll(async () => {
    // The container may still be finishing initdb; a host-side connect loop is
    // the only honest readiness signal.
    let client: pg.Client | null = null;
    for (let attempt = 0; attempt < 30 && client === null; attempt += 1) {
      try {
        client = await admin();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (client === null) throw new Error('the database never accepted a connection');
    for (const schema of [
      SCHEMA, BARE, HALF, ENV_A, ENV_B, ENV_UNMIGRATED, ...COLLIDE, FIRST, GRANTS, CONTACTS, CONTACTS_PROD, CONTENT_STAGING,
    ]) {
      await client.query(`drop schema if exists ${schema} cascade`);
      await client.query(`create schema ${schema}`);
    }
    await client.end();
  }, 60_000);

  afterAll(cleanupCliHosts);
}

live('the install path, end to end', () => {
  it('upgrade --store pg writes, applies, stamps and seeds', async () => {
    const host = liveHost();
    expect(await host.run('upgrade', '--store', 'pg')).toBe(0);
    const output = host.stdout();

    // Every migration was emitted into the host repo at §4's path…
    expect(host.file('stet/migrations/001_content_cms.sql')).toContain('create table content_versions');
    expect(host.file('stet/migrations/002_changesets.sql')).toContain('create table changesets');
    // …an unversioned database reported both pending, never up to date, and
    // they applied in number order on the one fresh run…
    expect(output).toContain('installed 0, pending 1, 2');
    expect(output).toContain('applied 001_content_cms.sql');
    expect(output).toContain('applied 002_changesets.sql');
    expect(output.indexOf('applied 001_content_cms.sql')).toBeLessThan(
      output.indexOf('applied 002_changesets.sql'),
    );
    // …the config block was printed for the operator and never written — the
    // file still says only what the operator put in it…
    expect(output).toContain('"urlEnv": "STET_DATABASE_URL"');
    expect(host.file('stet.config.json')).not.toContain('urlEnv');
    // …and what landed in the repo is the package's own file, byte for byte.
    for (const name of ['001_content_cms.sql', '002_changesets.sql']) {
      expect(host.file(`stet/migrations/${name}`)).toBe(
        readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
      );
    }

    // stet_meta carries both versions: the schema's — walked to the newest
    // shipped migration — and the descriptor's, which migration 1 ships as ''
    // for exactly this command to fill in.
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    const meta = await readStetMeta(scoped(SCHEMA));
    expect(meta).toEqual({ schemaVersion: 3, descriptorVersion: String(descriptor.version) });
    expect(output).toContain('descriptor_version: stamped (1)');
    // Exactly one stamp line: the apply stamps, and the seed it hands off to
    // is told not to say it again.
    expect(output.split('\n').filter((line) => line.startsWith('descriptor_version:'))).toHaveLength(1);

    // Seed wrote every NON-derived key as version 1, attributed to stet:seed.
    const client = new pg.Client({ connectionString: scoped(SCHEMA) });
    await client.connect();
    const rows = await client.query<{ key: string; editor: string; state: string; is_active: boolean }>(
      'select key, editor, state, is_active from content_versions order by key',
    );
    await client.end();

    const nonDerived = Object.entries(descriptor.keys)
      .filter(([, def]) => def.derivesFrom === undefined)
      .map(([key]) => key)
      .sort();
    expect(rows.rows.map((r) => r.key)).toEqual(nonDerived);
    for (const row of rows.rows) {
      expect(`${row.key}: ${row.editor}`).toBe(`${row.key}: stet:seed`);
      expect(`${row.key}: ${row.state}`).toBe(`${row.key}: published`);
      expect(`${row.key}: ${row.is_active}`).toBe(`${row.key}: true`);
    }
  }, 60_000);

  it('list reports the seeded versions as active', async () => {
    const host = liveHost();
    expect(await host.run('list', '--json')).toBe(0);
    const rows = host.json<{ rows: { key: string; source: string; version: number | null }[] }>().rows;
    const headline = rows.find((r) => r.key === 'hero_headline');
    expect(headline?.source).toBe('active');
    expect(headline?.version).toBeGreaterThan(0);
    // The derived key resolves through derivation, from the stored value.
    expect(rows.find((r) => r.key === 'seo_home_title')?.source).toBe('derived');
  });

  it('a due draft publishes through the same RPC a click would call', async () => {
    const host = liveHost();
    expect(
      await host.run(
        'draft',
        'hero_headline',
        '--value=Scheduled and shipped',
        '--editor',
        'neil',
        '--publish-at',
        '2020-01-01T00:00:00.000Z',
      ),
    ).toBe(0);

    const clock = liveHost();
    expect(await clock.run('publish', '--due', '--editor', 'cron')).toBe(0);
    expect(clock.stdout()).toContain('1 published from 1 due draft(s)');

    const client = new pg.Client({ connectionString: scoped(SCHEMA) });
    await client.connect();
    const live = await client.query<{ value: string; editor: string; published_by: string; publish_at: string | null }>(
      "select value #>> '{}' as value, editor, published_by, publish_at from content_versions where key = 'hero_headline' and is_active",
    );
    await client.end();
    // The draft's author survives publish; the publisher is recorded
    // separately; the stamp was consumed.
    expect(live.rows[0]).toMatchObject({
      value: 'Scheduled and shipped',
      editor: 'neil',
      published_by: 'cron',
      publish_at: null,
    });
  });

  it('pull mirrors the live values with version metadata that matches the rows', async () => {
    const host = liveHost();
    expect(await host.run('pull')).toBe(0);

    const bundle = readBundle(JSON.parse(host.file('.stet/bundle.json')));
    expect(bundle.values['default']?.['hero_headline']).toBe('Scheduled and shipped');

    const client = new pg.Client({ connectionString: scoped(SCHEMA) });
    await client.connect();
    const active = await client.query<{ id: number }>(
      "select id from content_versions where key = 'hero_headline' and is_active",
    );
    await client.end();
    // This client has no int8 type override of its own — the adapter's pool is
    // where that lives — so the id arrives as text and is compared as a number.
    expect(bundle.meta?.['default']?.['hero_headline']).toEqual({
      version: Number(active.rows[0]?.id),
    });

    // The committed snapshot moved with it, and carries no derived key.
    expect(host.file('content/defaults.json')).toContain('Scheduled and shipped');
    expect(JSON.parse(host.file('content/defaults.json'))['default']['seo_home_title']).toBeUndefined();
  });

  it('audit is clean against a fully seeded store', async () => {
    const host = liveHost();
    expect(await host.run('audit', '--strict', '--json')).toBe(0);
    const answer = host.json<{ unseeded: string[]; orphans: string[]; drift: unknown[] }>();
    expect(answer).toMatchObject({ unseeded: [], orphans: [], drift: [] });
  });

  it('upgrade is idempotent: a second run has nothing pending', async () => {
    const host = liveHost();
    expect(await host.run('upgrade')).toBe(0);
    expect(host.stdout()).toContain('migrations: up to date at 3');
    // The stamp is compared before it is written, so a re-run reports it
    // unchanged rather than churning the row.
    expect(host.stdout()).toContain('descriptor_version: unchanged (1)');
  });

  it('doctor reports the store reachable and the versions installed', async () => {
    const host = liveHost();
    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain('store: configured (pg), reachable');
    expect(host.stdout()).toContain('meta: schema_version 3 · descriptor_version 1');
  });

  it('a command ends the pool it opened', async () => {
    // The review measured 9 server backends after 8 in-process calls: every
    // command was leaving its pool behind, which is a leak per call for the
    // consumers that call `runCli` in process rather than as a process.
    const before = await backends();
    for (let i = 0; i < 8; i += 1) {
      const host = liveHost();
      expect(await host.run('list')).toBe(0);
    }
    const after = await backends();
    expect(after).toBeLessThanOrEqual(before);
  }, 60_000);

  it('an unreachable host answers within the bound, not the TCP stack’s', async () => {
    // A black-holed address: packets are dropped, no RST comes back, and
    // without an explicit connect timeout the OS waits ~75 seconds. 192.0.2.0/24
    // is TEST-NET-1 (RFC 5737) and routes nowhere by definition.
    const blackHole = makeCliHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: 'postgresql://postgres:stet@192.0.2.1:5432/postgres' },
    });
    const started = Date.now();
    // A render-read degrades to the snapshot…
    expect(await blackHole.run('list')).toBe(0);
    const degraded = Date.now() - started;
    expect(blackHole.stderr()).toContain('unreachable');

    const mirrorStarted = Date.now();
    const mirror = makeCliHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: 'postgresql://postgres:stet@192.0.2.1:5432/postgres' },
    });
    // …and a mirror-read refuses. Both inside the bound, well under the 75
    // seconds an unbounded connect would take.
    expect(await mirror.run('pull')).toBe(1);
    const refused = Date.now() - mirrorStarted;

    expect(degraded).toBeLessThan(20_000);
    expect(refused).toBeLessThan(20_000);
  }, 90_000);

  it('a schema without its stet_meta row is diagnosed, not re-applied', async () => {
    // The half-existing install: the tables are there and the version row is
    // not, so `stet_meta` reads as unversioned and migration 1 looks pending.
    // Re-applying would abort at the first `create table` and change nothing;
    // the fix is the missing row.
    const host = makeCliHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: scoped(HALF) },
    });
    expect(await host.run('upgrade', '--store', 'pg')).toBe(0);

    const client = new pg.Client({ connectionString: scoped(HALF) });
    await client.connect();
    await client.query('delete from stet_meta');
    await client.end();

    const again = makeCliHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: scoped(HALF) },
    });
    expect(await again.run('upgrade')).toBe(1);
    expect(again.stderr()).toContain('appears to be already applied');
    expect(again.stderr()).toContain('insert into stet_meta');
    // The report survived the failure: the pending line is still there, and no
    // stack reached the operator.
    expect(again.stdout()).toContain('installed 0, pending 1, 2');
    expect(again.stderr()).not.toContain('    at ');
  }, 60_000);

  it('an unversioned database reads as null, not as an error', async () => {
    // The real 42P01 path: the schema exists and content_versions does not.
    expect(await readStetMeta(scoped(BARE))).toBeNull();

    const host = makeCliHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: scoped(BARE) },
    });
    expect(await host.run('upgrade', '--dry-run')).toBe(0);
    expect(host.stdout()).toContain('installed 0, pending 1, 2');
    expect(host.stdout()).toContain('would apply 001_content_cms.sql');
    expect(host.stdout()).toContain('would apply 002_changesets.sql');
    // A dry run applied nothing: the table is still absent.
    expect(await readStetMeta(scoped(BARE))).toBeNull();
  });
});

/**
 * Two environments against two real databases. The offline leg's per-env memory
 * stores are independent by construction, which proves the plumbing and not the
 * isolation; only a second connection proves that.
 */
live('two environments, two databases', () => {
  /** A project declaring `b` beside the bare store block, both real pg. */
  function envHost(): CliHost {
    return makeCliHost({
      config: {
        store: { adapter: 'pg' },
        environments: { b: { adapter: 'pg', urlEnv: 'STET_B_URL' } },
      },
      env: { STET_DATABASE_URL: scoped(ENV_A), STET_B_URL: scoped(ENV_B) },
    });
  }

  /** The live keys a schema is holding, so "which database took the write" is assertable. */
  async function activeKeys(schema: string): Promise<string[]> {
    const client = new pg.Client({ connectionString: scoped(schema) });
    await client.connect();
    const answer = await client.query<{ key: string }>(
      'select key from content_versions where is_active order by key',
    );
    await client.end();
    return answer.rows.map((r) => r.key);
  }

  it('the seed and the stamp land in the selected database alone', async () => {
    // Both schemas migrated out of band, so both carry migration 1's own
    // `descriptor_version: ''` — not yet stamped, in both, at the start.
    for (const schema of [ENV_A, ENV_B]) {
      for (const name of ['001_content_cms.sql', '002_changesets.sql']) {
        await applySql(scoped(schema), readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      }
    }
    expect(await readStetMeta(scoped(ENV_A))).toEqual({ schemaVersion: 2, descriptorVersion: '' });
    expect(await readStetMeta(scoped(ENV_B))).toEqual({ schemaVersion: 2, descriptorVersion: '' });

    const host = envHost();
    expect(await host.run('seed', '--env', 'b')).toBe(0);
    expect(host.stdout()).toContain('environment: b');

    // THE regression this whole change exists to prevent: with the selector
    // threaded to the adapter but not to the meta bridge, the content lands in
    // b and the stamp lands on the DEFAULT database. Both halves, asserted.
    expect(await readStetMeta(scoped(ENV_B))).toEqual({ schemaVersion: 2, descriptorVersion: '1' });
    expect(await readStetMeta(scoped(ENV_A))).toEqual({ schemaVersion: 2, descriptorVersion: '' });
    expect((await activeKeys(ENV_B)).length).toBeGreaterThan(0);
    expect(await activeKeys(ENV_A)).toEqual([]);

    // The other direction: the default run stamps and seeds its own database,
    // and b's rows are untouched by it.
    const bRows = await activeKeys(ENV_B);
    const plain = envHost();
    expect(await plain.run('seed')).toBe(0);
    expect(plain.stdout()).not.toContain('environment:');
    expect(await readStetMeta(scoped(ENV_A))).toEqual({ schemaVersion: 2, descriptorVersion: '1' });
    expect(await activeKeys(ENV_A)).toEqual(bRows);
    expect(await activeKeys(ENV_B)).toEqual(bRows);

    // Two environments, the same key, two rows in two databases — never two
    // rows in one, and nothing anywhere records an environment.
    const client = new pg.Client({ connectionString: scoped(ENV_B) });
    await client.connect();
    const columns = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'content_versions'",
    );
    const perKey = await client.query<{ count: string }>(
      "select count(*)::text as count from content_versions where key = 'hero_headline' and is_active",
    );
    await client.end();
    expect(columns.rows.map((r) => r.column_name)).not.toContain('environment');
    expect(perKey.rows[0]?.count).toBe('1');
  }, 60_000);

  it('pull --env b mirrors b’s truth into the repo, and says that it did', async () => {
    const here = envHost();
    expect(await here.run('draft', 'hero_headline', '--value=Default wording', '--editor', 'neil')).toBe(0);
    expect(await here.run('publish', 'hero_headline', '--editor', 'neil')).toBe(0);

    const there = envHost();
    expect(await there.run('draft', 'hero_headline', '--value=B wording', '--editor', 'neil', '--env', 'b')).toBe(0);
    expect(await there.run('publish', 'hero_headline', '--editor', 'neil', '--env', 'b')).toBe(0);

    const host = envHost();
    expect(await host.run('pull', '--env', 'b')).toBe(0);
    // b's active row is what landed in the committed artifacts, not the default
    // connection's — the two databases disagree, so this cannot pass by luck.
    expect(host.file('content/defaults.json')).toContain('B wording');
    expect(host.file('content/defaults.json')).not.toContain('Default wording');
    // Deliberate, warned, never refused (the carried ruling).
    expect(host.stderr()).toContain('b environment');
  }, 60_000);

  it('upgrade reads and prints the selected database, not the default one', async () => {
    // The default here points at a schema nothing has ever migrated, so "up to
    // date" and "pending 1, 2" are different answers and the assertions bite.
    function splitHost(): CliHost {
      return makeCliHost({
        config: {
          store: { adapter: 'pg' },
          environments: { b: { adapter: 'pg', urlEnv: 'STET_B_URL' } },
        },
        env: { STET_DATABASE_URL: scoped(ENV_UNMIGRATED), STET_B_URL: scoped(ENV_B) },
      });
    }

    const selected = splitHost();
    expect(await selected.run('upgrade', '--env', 'b')).toBe(0);
    // b was migrated to 2 by hand; migration 3 is the one it still lacks.
    expect(selected.stdout()).toContain('migrations: installed 2, pending 3');
    expect(selected.stdout()).toContain('applied 003_contacts.sql');
    expect(selected.stdout()).toContain('descriptor_version: unchanged (1)');

    // The same command without the selector reads the other database and finds
    // nothing applied — which is what makes the assertion above meaningful.
    const plain = splitHost();
    expect(await plain.run('upgrade', '--dry-run')).toBe(0);
    expect(plain.stdout()).toContain('installed 0, pending 1, 2');
    expect(await readStetMeta(scoped(ENV_UNMIGRATED))).toBeNull();

    // The printed install block names the variable of the database being
    // migrated — an operator pasting `STET_DATABASE_URL` here would apply the
    // migration to the wrong one.
    const printed = splitHost();
    expect(await printed.run('upgrade', '--dry-run', '--store', 'pg', '--env', 'b')).toBe(0);
    expect(printed.stdout()).toContain('"environments"');
    expect(printed.stdout()).toContain('"urlEnv": "STET_B_URL"');
    expect(printed.stdout()).not.toContain('STET_DATABASE_URL');

    // And a `--store` that contradicts the selection is refused before any of it.
    const clash = splitHost();
    expect(await clash.run('upgrade', '--store', 'postgrest', '--env', 'b')).toBe(2);
    expect(clash.stderr()).toContain('contradicts --env b');
  }, 60_000);
});

live('migration 3 through upgrade', () => {
  const MIGRATION_1 = readFileSync(new URL('../migrations/001_content_cms.sql', import.meta.url), 'utf8');
  const MIGRATION_2 = readFileSync(new URL('../migrations/002_changesets.sql', import.meta.url), 'utf8');

  function pgHost(schema: string): CliHost {
    return makeCliHost({ config: { store: { adapter: 'pg' } }, env: { STET_DATABASE_URL: scoped(schema) } });
  }

  async function sql(schema: string, statement: string): Promise<void> {
    await applySql(scoped(schema), statement);
  }

  async function relationExists(schema: string, name: string): Promise<boolean> {
    const client = await admin();
    const answer = await client.query<{ n: number }>(
      'select count(*)::int as n from pg_class where relnamespace = $1::regnamespace and relname = $2',
      [schema, name],
    );
    await client.end();
    return answer.rows[0]?.n === 1;
  }

  const words = (what: string, message: string): string =>
    `migration 3 changed nothing: ${what} (Postgres: ${message}). Rename or move that object, then run stet upgrade again`;

  it('a host object of one of its names is named by kind, and the stamp never suggested', async () => {
    const cases: [string, string, string, string][] = [
      ['stet_c3_table', 'create table stet_contacts (id int)', 'the table stet_contacts', 'relation "stet_contacts" already exists'],
      [
        'stet_c3_index',
        'create table stet_group_memberships_group_idx (id int)',
        'the index stet_group_memberships_group_idx',
        'relation "stet_group_memberships_group_idx" already exists',
      ],
      ['stet_c3_sequence', 'create sequence stet_contacts_id_seq', 'the sequence stet_contacts_id_seq', 'relation "stet_contacts_id_seq" already exists'],
      ['stet_c3_domain', 'create domain stet_contacts as text', 'the table stet_contacts', 'type "stet_contacts" already exists'],
      [
        'stet_c3_function',
        'create function stet_group_get(a text, b text) returns int language sql as $$ select 1 $$',
        'the function stet_group_get',
        'function "stet_group_get" already exists with same argument types',
      ],
    ];
    for (const [schema, host, kind, message] of cases) {
      await sql(schema, MIGRATION_1);
      await sql(schema, MIGRATION_2);
      await sql(schema, host);
      const run = pgHost(schema);
      expect(`${schema}: ${await run.run('upgrade')}`).toBe(`${schema}: 1`);
      expect(run.stderr()).toContain(words(`it creates ${kind}, and this database already has an object of that name`, message));
      expect(run.stderr()).not.toContain('stet_meta');
      expect(await readStetMeta(scoped(schema))).toMatchObject({ schemaVersion: 2 });
    }
  }, 60_000);

  it('a first install that collides at 3 applies 1 and 2 and is not told to stamp', async () => {
    await sql(FIRST, 'create table stet_contacts (id int)');
    const run = pgHost(FIRST);
    expect(await run.run('upgrade')).toBe(1);
    expect(run.stdout()).toContain('applied 001_content_cms.sql');
    expect(run.stdout()).toContain('applied 002_changesets.sql');
    expect(run.stderr()).toContain(
      words(
        'it creates the table stet_contacts, and this database already has an object of that name',
        'relation "stet_contacts" already exists',
      ),
    );
    expect(await readStetMeta(scoped(FIRST))).toMatchObject({ schemaVersion: 2 });
    expect(await relationExists(FIRST, 'stet_groups')).toBe(false);
  }, 60_000);

  it('a lost stamp is repaired by the stamp, word for word', async () => {
    // HALF was installed to the newest migration and lost its row in the case
    // above; its tables are all still there.
    const run = pgHost(HALF);
    expect(await run.run('upgrade')).toBe(1);
    expect(run.stderr()).toContain(
      'migration 1 appears to be already applied — its tables exist but the stet_meta row is missing. ' +
        "Restore the row (insert into stet_meta (id, schema_version, descriptor_version) values (1, 1, '')) " +
        'rather than re-applying the file',
    );
    expect(await readStetMeta(scoped(HALF))).toBeNull();
  }, 60_000);

  it('prints the grant lines after a run that applied 3, and none when nothing is pending', async () => {
    await sql(GRANTS, MIGRATION_1);
    await sql(GRANTS, MIGRATION_2);
    const applied = pgHost(GRANTS);
    expect(await applied.run('upgrade')).toBe(0);
    const output = applied.stdout();
    expect(output).toContain('applied 003_contacts.sql');
    expect(output).toContain(
      'migration 3 grants its tables and functions to every role holding EXECUTE on save_content_draft; a service role granted after it needs:',
    );
    expect(output).toContain(
      '  grant select, insert, update, delete on stet_groups, stet_contacts, stet_group_memberships, stet_suppressions, stet_erasures to <your service role>;',
    );
    expect(output).toContain('  grant usage, select on sequence stet_contacts_id_seq, stet_group_memberships_id_seq to <your service role>;');
    expect(output).toContain('  grant execute on function stet_normal_email(text), ');
    expect(output).toContain('and the service role must bypass row level security or own the tables:');
    expect(output).toContain('  alter role <your service role> bypassrls;');

    const again = pgHost(GRANTS);
    expect(await again.run('upgrade')).toBe(0);
    expect(again.stdout()).toContain('migrations: up to date at 3');
    expect(again.stdout()).not.toContain('grants its tables');
    expect(again.stdout()).not.toContain('bypassrls');
  }, 60_000);

  it('a snapshot-only site migrates its contacts store in the same run, and reads it', async () => {
    const site = (): CliHost =>
      makeCliHost({
        config: { contacts: { store: { adapter: 'pg', urlEnv: 'STET_CONTACTS_DATABASE_URL' } } },
        env: { STET_CONTACTS_DATABASE_URL: scoped(CONTACTS) },
      });

    const dry = site();
    expect(await dry.run('upgrade', '--dry-run')).toBe(0);
    const planned = dry.stdout();
    expect(planned).toContain('store: snapshot-only — there is no schema to migrate');
    expect(planned).toContain('contacts store (contacts.store in stet.config.json):');
    expect(planned).toContain('migrations: installed 0, pending 1, 2, 3');
    expect(planned).toContain('would apply 003_contacts.sql');
    expect(planned.indexOf('contacts store (')).toBeLessThan(planned.indexOf('would apply 001_content_cms.sql'));
    expect(dry.exists('stet/migrations/003_contacts.sql')).toBe(false);
    expect(await readStetMeta(scoped(CONTACTS))).toBeNull();

    const real = site();
    expect(await real.run('upgrade')).toBe(0);
    for (const name of ['001_content_cms.sql', '002_changesets.sql', '003_contacts.sql']) {
      expect(real.file(`stet/migrations/${name}`)).toBe(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    expect(real.stdout()).toContain('applied 003_contacts.sql');
    expect(real.stdout()).toContain('  alter role <your service role> bypassrls;');
    expect(await readStetMeta(scoped(CONTACTS))).toMatchObject({ schemaVersion: 3 });
    // The content stays snapshot-only: nothing was seeded into the contacts database.
    const client = new pg.Client({ connectionString: scoped(CONTACTS) });
    await client.connect();
    const content = await client.query<{ n: number }>('select count(*)::int as n from content_versions');
    await client.end();
    expect(content.rows[0]?.n).toBe(0);

    const add = site();
    expect(await add.run('contacts', 'group', 'add', 'cloud-waitlist', '--property', 'tier=solo,team,business', '--required', 'tier')).toBe(0);
    const read = site();
    expect(await read.run('contacts', 'groups')).toBe(0);
    expect(read.stdout()).toContain('cloud-waitlist   open   0 members   tier (solo | team | business)');

    // The operator reference's members query answers what `list` prints,
    // less the unsubscribed, in the same order.
    const joiner = createPgStore({ connectionString: scoped(CONTACTS), project: 'default' });
    for (const [email, tier] of [['ana@lightfield.co', 'team'], ['sam@x.co', 'solo'], ['lee@x.co', 'business']] as const) {
      expect(await joiner.contacts.join({ group: 'cloud-waitlist', email, properties: { tier } })).toMatchObject({ isNew: true });
    }
    expect(await joiner.contacts.suppress({ email: 'sam@x.co', scope: 'marketing', source: 'one-click' })).toEqual({ suppressed: true });
    await joiner.end();
    const listed = site();
    expect(await listed.run('contacts', 'list', '--group', 'cloud-waitlist')).toBe(0);
    const printed = listed.stdout().split('\n').filter((line) => line.includes('   joined '));
    expect(printed.map((line) => line.split('   ')[0])).toEqual(['ana@lightfield.co', 'sam@x.co', 'lee@x.co']);
    const reference = readFileSync(new URL('../../docs/operator/contacts.md', import.meta.url), 'utf8');
    const query = /### A group's members[\s\S]*?```sql\n([\s\S]*?)```/.exec(reference)?.[1];
    expect(query).toContain('from stet_group_memberships m');
    const reader = new pg.Client({ connectionString: scoped(CONTACTS) });
    await reader.connect();
    const answered = await reader.query<{ email: string }>(query ?? '');
    await reader.end();
    expect(answered.rows.map((r) => r.email)).toEqual(
      printed.filter((line) => !line.endsWith('unsubscribed (marketing)')).map((line) => line.split('   ')[0]),
    );
    expect(answered.rows.map((r) => r.email)).toEqual(['ana@lightfield.co', 'lee@x.co']);
  }, 60_000);

  it('a contacts environment is its own database, and an --env the block lacks leaves it alone', async () => {
    const prod = makeCliHost({
      config: {
        contacts: {
          store: { adapter: 'pg', urlEnv: 'STET_CONTACTS_DATABASE_URL' },
          environments: { prod: { adapter: 'pg', urlEnv: 'PROD_URL' } },
        },
      },
      env: { STET_CONTACTS_DATABASE_URL: scoped(BARE), PROD_URL: scoped(CONTACTS_PROD) },
    });
    expect(await prod.run('upgrade', '--env', 'prod')).toBe(0);
    expect(prod.stdout()).toContain('contacts store (contacts.environments.prod in stet.config.json):');
    expect(prod.stdout()).not.toContain('store: snapshot-only');
    expect(await readStetMeta(scoped(CONTACTS_PROD))).toMatchObject({ schemaVersion: 3 });
    expect(await readStetMeta(scoped(BARE))).toBeNull();

    const staging = makeCliHost({
      config: {
        store: { adapter: 'pg' },
        environments: { staging: { adapter: 'pg', urlEnv: 'STAGING_URL' } },
        contacts: { store: { adapter: 'pg', urlEnv: 'STET_CONTACTS_DATABASE_URL' } },
      },
      env: { STET_DATABASE_URL: scoped(BARE), STAGING_URL: scoped(CONTENT_STAGING), STET_CONTACTS_DATABASE_URL: scoped(BARE) },
    });
    expect(await staging.run('upgrade', '--env', 'staging')).toBe(0);
    expect(staging.stdout()).toContain('applied 003_contacts.sql');
    expect(staging.stdout()).toContain('contacts store: the contacts block declares no environment staging — not migrated');
    expect(await readStetMeta(scoped(CONTENT_STAGING))).toMatchObject({ schemaVersion: 3 });
    expect(await readStetMeta(scoped(BARE))).toBeNull();
  }, 60_000);
});

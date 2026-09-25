/**
 * The reference database store: plain `pg`, one connection pool, no ORM.
 * `canApplyDDL` is true — this adapter can run a migration file itself.
 *
 * `pg` is an OPTIONAL peer dependency. Only a host importing `@getstet/stet/store-pg`
 * loads it, so a snapshot-only install pulls no database driver.
 *
 * Two things this file deliberately does not have:
 *  - a retry wrapper. A truncated response to a write that actually landed
 *    would duplicate the row, so no write is ever re-issued. The absence is
 *    structural, not a policy comment.
 *  - a global type-parser mutation. `int8` is parsed as a number through a
 *    pool-local `TypeOverrides` instance, so ids cross as numbers here without
 *    changing how any other pool in the host process reads bigints. Ids beyond
 *    2^53 are out of scope.
 */

import pg from 'pg';

import { normalEmail } from '../src/contacts.js';
import { localeChain, type StoreRow } from '../src/resolve.js';
import type {
  ChangeMember,
  ChangesetOps,
  ChangesetRow,
  ChangesetStatus,
  ContactOps,
  DraftRefusal,
  SaveDraftParams,
  StoreAdapter,
  StoreError,
  VersionRow,
} from '../src/store.js';
import {
  asDraft,
  asErased,
  asImportOutcome,
  asJoin,
  asRenamed,
  asVoid,
  invalidDeclaration,
  mapContactRecord,
  mapGroupDef,
  mapGroupRow,
  memberPage,
  type GroupDefSqlRow,
  type GroupSqlRow,
  type MemberSqlRow,
  asVersion,
  changeClosed,
  expectNoRefusal,
  isError,
  mapChangesetRow,
  mapError,
  mapPage,
  mapRaise,
  mapRow,
  mapStetMetaRow,
  noChange,
  noMembers,
  pageLimit,
  type ChangesetSqlRow,
  type RaiseContext,
  type RpcAnswer,
  type SqlRow,
  type StetMeta,
  type StetMetaRow,
  wrongProjectChange,
} from './store-shared.js';

const ROW_COLUMNS =
  'id, key, locale, target, state, is_active, value, publish_at, editor, label, note, ' +
  'published_by, reverted_from, changeset_id, created_at, published_at';

/** The `changesets` columns, in one place for the same reason `ROW_COLUMNS` is. */
const CHANGE_COLUMNS = 'id, name, note, status, author_kind, publish_at, created_at, reverted_at';

export interface PgStore extends StoreAdapter {
  /** Close the pool. Tests own the lifetime; a long-lived host usually does not. */
  end(): Promise<void>;
}

/**
 * A pool's configuration, in one place so the factory and the install-time
 * helpers below cannot drift: `int8` parsed as a number through a pool-local
 * `TypeOverrides` (ids cross as numbers here without changing how any other
 * pool in the host process reads bigints), and `allowExitOnIdle`, which keeps a
 * one-shot consumer honest — a CLI command that has finished its work must not
 * be held open by an idle client waiting out a timeout. A long-lived host is
 * unaffected; its own listening socket is what keeps that process alive.
 *
 * `connectionTimeoutMillis` is the caller's to set and matters more than it
 * looks: a `connect_timeout` in the connection URL is parsed by `pg` and then
 * ignored by the pool, so without this a black-holed host waits out the OS TCP
 * stack — about 75 seconds — before anyone learns it is unreachable.
 */
export function poolConfig(opts: {
  connectionString: string;
  connectionTimeoutMillis?: number;
}): pg.PoolConfig {
  const types = new pg.TypeOverrides(pg.types);
  types.setTypeParser(20, Number);
  return {
    connectionString: opts.connectionString,
    types,
    allowExitOnIdle: true,
    ...(opts.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: opts.connectionTimeoutMillis }),
  };
}

function makePool(connectionString: string, connectionTimeoutMillis?: number): pg.Pool {
  return new pg.Pool(poolConfig({ connectionString, connectionTimeoutMillis }));
}

export function createPgStore(opts: {
  connectionString: string;
  project: string;
  connectionTimeoutMillis?: number;
}): PgStore {
  let pool: pg.Pool | null = null;

  function connect(): pg.Pool {
    if (pool) return pool;
    pool = makePool(opts.connectionString, opts.connectionTimeoutMillis);
    return pool;
  }

  async function query<T>(text: string, values: unknown[]): Promise<T[] | StoreError> {
    try {
      const result = await connect().query<T & pg.QueryResultRow>(text, values);
      return result.rows;
    } catch (error) {
      return failure(error, mapError);
    }
  }

  /** One RPC. The server's own answer travels back untouched. */
  async function call(text: string, values: unknown[]): Promise<RpcAnswer> {
    try {
      const result = await connect().query<{ id: unknown }>(text, values);
      return { body: result.rows[0]?.id ?? null };
    } catch (error) {
      return failure(error, mapRaise);
    }
  }

  return {
    project: opts.project,
    canApplyDDL: true,

    async read(q = {}): Promise<StoreRow[] | StoreError> {
      const rows = await query<SqlRow>(
        `select ${ROW_COLUMNS} from content_versions
          where project = $1
            and (is_active or ($2::boolean and state = 'draft'))
            and ($3::text[] is null or key = any($3))
            and ($4::text[] is null or locale = any($4))
          order by id`,
        [
          opts.project,
          q.preview === true,
          q.keys ?? null,
          q.locale === undefined ? null : localeChain(q.locale),
        ],
      );
      return isError(rows) ? rows : rows.map(mapRow);
    },

    async saveDraft(p: SaveDraftParams): Promise<{ draftId: number } | DraftRefusal | StoreError> {
      // `-1` is the SQL's sentinel for "argument absent", not a change id. The
      // TS contract has no sentinel — any number is an attach — so a caller
      // passing -1 must be REFUSED here rather than reaching the RPC, where it
      // would silently mean "leave membership alone". Ids start at 1, so this
      // refuses exactly what 0 and the negatives already refuse inside the SQL.
      if (p.change === -1) return mapError(noChange(-1));
      return asDraft(
        await call(
          'select save_content_draft($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11) as id',
          [
            p.key,
            JSON.stringify(p.value),
            p.target,
            p.editor,
            p.locale ?? 'default',
            opts.project,
            p.label ?? null,
            p.note ?? null,
            p.publishAt ?? null,
            p.force ?? false,
            // A positional call cannot omit an argument, so "absent" is sent as
            // the sentinel the SQL defaults to — observably identical to
            // omission. (PostgREST calls by NAME and omits it outright.)
            p.change === undefined ? -1 : p.change,
          ],
        ),
      );
    },

    async publish(p: {
      key: string;
      editor: string;
      locale?: string;
    }): Promise<{ versionId: number } | StoreError> {
      return asVersion(
        await call('select publish_content_version($1, $2, $3, $4) as id', [
          p.key,
          p.editor,
          p.locale ?? 'default',
          opts.project,
        ]),
        'publish',
      );
    },

    async revert(p: {
      versionId: number;
      editor: string;
      expectActive?: number;
    }): Promise<{ versionId: number } | StoreError> {
      // The adapter passes its own project: version ids are global, and the RPC
      // refuses `wrong_project` rather than reaching across. The guard is null
      // unless the group revert set it, which is 001's behavior exactly.
      return asVersion(
        await call('select revert_content_version($1, $2, $3, $4) as id', [
          p.versionId,
          p.editor,
          opts.project,
          p.expectActive ?? null,
        ]),
        'revert',
      );
    },

    async rename(p: {
      oldKey: string;
      newKey: string;
      editor: string;
    }): Promise<{ renamed: true } | StoreError> {
      return asRenamed(
        await call('select rename_content_key($1, $2, $3, $4) as id', [
          p.oldKey,
          p.newKey,
          p.editor,
          opts.project,
        ]),
        'rename',
      );
    },

    async history(q: {
      key: string;
      locale?: string;
      beforeId?: number;
      limit?: number;
    }): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | StoreError> {
      const limit = pageLimit(q.limit);
      const rows = await query<SqlRow>(
        `select ${ROW_COLUMNS} from content_versions
          where project = $1 and key = $2 and state = 'published'
            and ($3::text is null or locale = $3)
            and ($4::bigint is null or id < $4)
          order by id desc limit $5`,
        [opts.project, q.key, q.locale ?? null, q.beforeId ?? null, limit],
      );
      return isError(rows) ? rows : mapPage(rows, limit);
    },

    async recent(
      q: { beforeId?: number; limit?: number } = {},
    ): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | StoreError> {
      const limit = pageLimit(q.limit);
      const rows = await query<SqlRow>(
        `select ${ROW_COLUMNS} from content_versions
          where project = $1 and state = 'published'
            and ($2::bigint is null or id < $2)
          order by id desc limit $3`,
        [opts.project, q.beforeId ?? null, limit],
      );
      return isError(rows) ? rows : mapPage(rows, limit);
    },

    // The contacts capability: transport only. Every write and every read is
    // one migration-3 function, so this block and store-postgrest's call the
    // same SQL and hand the answers to the same mapping in store-shared.
    contacts: {
      async addGroup(p): Promise<{ created: true } | StoreError> {
        const invalid = invalidDeclaration(p.properties);
        if (invalid) return invalid;
        const done = asVoid(
          await call('select stet_group_add($1, $2, $3, $4::jsonb) as id', [
            opts.project,
            p.key,
            p.name,
            JSON.stringify(p.properties),
          ]),
          'contacts.addGroup',
        );
        return done === true ? { created: true } : done;
      },

      async setGroupState(p): Promise<{ state: 'open' | 'closed' } | StoreError> {
        const done = asVoid(
          await call('select stet_group_state($1, $2, $3) as id', [opts.project, p.key, p.state]),
          'contacts.setGroupState',
        );
        return done === true ? { state: p.state } : done;
      },

      async groups() {
        const rows = await query<GroupSqlRow>(
          'select key, name, state, properties, created_at, members from stet_group_list($1)',
          [opts.project],
        );
        return isError(rows) ? rows : { groups: rows.map(mapGroupRow) };
      },

      async group(p) {
        const rows = await query<GroupDefSqlRow>(
          'select key, name, state, properties, created_at from stet_group_get($1, $2)',
          [opts.project, p.key],
        );
        return isError(rows) ? rows : { group: rows[0] === undefined ? null : mapGroupDef(rows[0]) };
      },

      async join(p) {
        return asJoin(
          await call('select stet_join_group($1, $2, $3, $4::jsonb, $5, $6) as id', [
            opts.project,
            p.group,
            p.email,
            JSON.stringify(p.properties),
            p.form ?? null,
            p.page ?? null,
          ]),
        );
      },

      async importMember(p) {
        return asImportOutcome(
          await call('select stet_import_member($1, $2, $3, $4::jsonb, $5, $6) as id', [
            opts.project,
            p.group,
            p.email,
            JSON.stringify(p.properties),
            p.form,
            p.joinedAt ?? null,
          ]),
        );
      },

      async members(q) {
        const limit = pageLimit(q.limit);
        const rows = await query<MemberSqlRow>(
          `select id, contact_id, email, joined_at, form, page, properties, updated_at, suppressed
             from stet_group_members($1, $2, $3, $4)`,
          [opts.project, q.group, q.afterId ?? 0, limit],
        );
        return isError(rows) ? rows : memberPage(rows, q.group, limit);
      },

      async contact(p) {
        const answer = expectNoRefusal(
          await call('select stet_contact_record($1, $2) as id', [opts.project, p.email]),
          'contacts.contact',
        );
        return 'body' in answer ? mapContactRecord(answer.body) : answer;
      },

      // One row, so a direct upsert rather than a function: RETURNING yields
      // the row only when this statement inserted it.
      async suppress(p) {
        const rows = await query<{ ok: boolean }>(
          `insert into stet_suppressions (email, scope, source) values ($1, $2, $3)
           on conflict (email, scope) do nothing returning true as ok`,
          [normalEmail(p.email), p.scope, p.source],
        );
        return isError(rows) ? rows : { suppressed: rows.length > 0 };
      },

      async erase(p) {
        return asErased(await call('select stet_erase_contact($1, $2) as id', [opts.project, p.email]));
      },

      async suppressionCounts() {
        const rows = await query<{ scope: 'transactional' | 'marketing'; source: string; n: number | string }>(
          'select scope, source, n from stet_suppression_counts()',
          [],
        );
        return isError(rows) ? rows : { counts: rows.map((r) => ({ scope: r.scope, source: r.source, n: Number(r.n) })) };
      },
    } satisfies ContactOps,

    changesets: {
      async open(p): Promise<{ changeId: number } | StoreError> {
        const rows = await query<{ id: number }>(
          'insert into changesets (project, name, note, author_kind) values ($1, $2, $3, $4) returning id',
          [opts.project, p.name, p.note ?? null, p.authorKind ?? 'human'],
        );
        if (isError(rows)) return rows;
        const id = rows[0]?.id;
        return id === undefined ? mapError('insert into changesets returned no id') : { changeId: id };
      },

      async list(q = {}): Promise<{ changes: ChangesetRow[]; nextBeforeId: number | null } | StoreError> {
        // Keyset by id desc, exactly as `recent` pages the version rows.
        const limit = pageLimit(q.limit);
        const rows = await query<ChangesetSqlRow>(
          `select ${CHANGE_COLUMNS} from changesets
            where project = $1
              and ($2::text is null or status = $2)
              and ($3::bigint is null or id < $3)
            order by id desc limit $4`,
          [opts.project, q.status ?? null, q.beforeId ?? null, limit],
        );
        if (isError(rows)) return rows;
        const changes = rows.map(mapChangesetRow);
        return {
          changes,
          nextBeforeId: changes.length < limit ? null : (changes[changes.length - 1]?.id ?? null),
        };
      },

      async get(p): Promise<{ change: ChangesetRow; members: ChangeMember[] } | StoreError> {
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        // ONE read, two consumers: the group-revert enumeration takes the
        // minted id and the before id, the change-before preview takes the
        // before value. The before is a single lateral join, not a query per
        // member.
        const members = await query<{
          key: string;
          locale: string;
          version_id: number;
          before_id: number | null;
          before_value: unknown;
        }>(
          `select m.key, m.locale, m.id as version_id, b.id as before_id, b.value as before_value
             from content_versions m
             left join lateral (
               select id, value from content_versions p
                where p.project = m.project and p.key = m.key and p.locale = m.locale
                  and p.state = 'published' and p.id < m.id
                order by p.id desc limit 1
             ) b on true
            where m.project = $1 and m.changeset_id = $2 and m.state = $3
            order by m.id`,
          [opts.project, p.changeId, found.status === 'published' ? 'published' : 'draft'],
        );
        if (isError(members)) return members;
        return {
          change: mapChangesetRow(found.row),
          members: members.map((m) =>
            found.status === 'published'
              ? {
                  key: m.key,
                  locale: m.locale,
                  versionId: m.version_id,
                  beforeVersionId: m.before_id,
                  // ABSENT, not null, where there is no prior version: the left
                  // join hands back a null column, but a first-publish member
                  // has no before VALUE at all, and the preview resolver reads
                  // the property's absence as "no override row for this key".
                  // A null here would offer it an override of null to render.
                  ...(m.before_id === null ? {} : { beforeValue: m.before_value }),
                }
              : { key: m.key, locale: m.locale, versionId: m.version_id },
          ),
        };
      },

      async schedule(p): Promise<{ status: ChangesetStatus } | StoreError> {
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        if (found.status === 'published') return mapError(changeClosed(p.changeId));
        if (p.publishAt !== null) {
          // A stamp with nothing to publish is the demotion sweep's food. The
          // CANCEL arm carries no member requirement — the sweep cancels empty
          // changes by design.
          const members = await query<{ n: number }>(
            `select count(*)::int as n from content_versions
              where project = $1 and changeset_id = $2 and state = 'draft'`,
            [opts.project, p.changeId],
          );
          if (isError(members)) return members;
          if ((members[0]?.n ?? 0) === 0) return mapError(noMembers(p.changeId));
        }

        // The CHANGE ROW FIRST, then the member stamps — both arms. The reverse
        // order on cancel would let a member attaching between the two
        // statements inherit the still-standing stamp, and the clock would
        // publish a change the operator cancelled. A torn write either way
        // lands on a state the clock already handles.
        //
        // `status <> 'published'` is the guard of RECORD: the read above can go
        // stale while `publish_change` commits, and this UPDATE then blocks on
        // its row lock, re-evaluates, and would otherwise resurrect a published
        // change — back to open on the cancel arm (the demotion sweep runs
        // unattended, so it races an operator's publish on its own), or to
        // scheduled with a future stamp on the reschedule arm. Either way the
        // group revert is refused forever. Zero rows means it published under
        // us: the same refusal the read would have given.
        const status: ChangesetStatus = p.publishAt === null ? 'open' : 'scheduled';
        const head = await query<{ id: number }>(
          `update changesets set status = $1, publish_at = $2::timestamptz
            where id = $3 and status <> 'published' returning id`,
          [status, p.publishAt, p.changeId],
        );
        if (isError(head)) return head;
        if (head.length === 0) return mapError(changeClosed(p.changeId));
        const stamped = await query(
          `update content_versions set publish_at = $1::timestamptz
            where project = $2 and changeset_id = $3 and state = 'draft'`,
          [p.publishAt, opts.project, p.changeId],
        );
        if (isError(stamped)) return stamped;
        return { status };
      },

      async publishChange(p): Promise<{ published: { key: string; locale: string; versionId: number }[] } | StoreError> {
        // A row set, not a scalar: the RPC returns the minted member per row so
        // a surface can fire its per-member events with no second read.
        try {
          const result = await connect().query<{
            o_key: string;
            o_locale: string;
            o_version_id: number;
          }>('select o_key, o_locale, o_version_id from publish_change($1, $2, $3)', [
            p.changeId,
            p.editor,
            opts.project,
          ]);
          return {
            published: result.rows.map((r) => ({
              key: r.o_key,
              locale: r.o_locale,
              versionId: r.o_version_id,
            })),
          };
        } catch (error) {
          return expectError(failure(error, mapRaise));
        }
      },

      async abandon(p): Promise<{ abandoned: true; droppedDrafts: number } | StoreError> {
        // A published change is never deleted: its row is the group revert's
        // and the before-preview's read.
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        if (found.status === 'published') return mapError(changeClosed(p.changeId));
        // The drafts go FIRST, so a torn abandon leaves an empty open change —
        // harmless and re-abandonable — never drafts pointing at a deleted row.
        const dropped = await query<{ id: number }>(
          `delete from content_versions
            where project = $1 and changeset_id = $2 and state = 'draft' returning id`,
          [opts.project, p.changeId],
        );
        if (isError(dropped)) return dropped;
        // The guard rides IN the write, for the reason `schedule` states: a
        // `publish_change` committing between the read and this DELETE would
        // otherwise take the row with it, stranding two live rows pointing at a
        // change that no longer exists and destroying the group revert and the
        // change-before preview permanently. Zero rows deleted means published.
        const removed = await query<{ id: number }>(
          "delete from changesets where id = $1 and status <> 'published' returning id",
          [p.changeId],
        );
        if (isError(removed)) return removed;
        if (removed.length === 0) return mapError(changeClosed(p.changeId));
        return { abandoned: true, droppedDrafts: dropped.length };
      },

      async discardDraft(p): Promise<{ discarded: number } | StoreError> {
        return asDiscarded(
          await call('select discard_content_draft($1, $2, $3) as id', [
            p.key,
            p.locale ?? 'default',
            opts.project,
          ]),
        );
      },

      async markReverted(p): Promise<{ revertedAt: string } | StoreError> {
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        const rows = await query<{ reverted_at: Date | string }>(
          'update changesets set reverted_at = now() where id = $1 returning reverted_at',
          [p.changeId],
        );
        if (isError(rows)) return rows;
        const at = rows[0]?.reverted_at;
        return at === undefined
          ? mapError('marking the change reverted returned no stamp')
          : { revertedAt: at instanceof Date ? at.toISOString() : new Date(at).toISOString() };
      },
    } satisfies ChangesetOps,

    async end(): Promise<void> {
      await pool?.end();
      pool = null;
    },
  };

  /**
   * A change row this project may act on. The lookup is GLOBAL and the project
   * check follows, exactly as the SQL reads it: ids are global, so another
   * project's change is `wrong_project`, never "not found".
   */
  async function readChange(
    changeId: number,
  ): Promise<{ row: ChangesetSqlRow; status: string } | StoreError> {
    const rows = await query<ChangesetSqlRow & { project: string }>(
      `select ${CHANGE_COLUMNS}, project from changesets where id = $1`,
      [changeId],
    );
    if (isError(rows)) return rows;
    const row = rows[0];
    if (row === undefined) return mapError(noChange(changeId));
    if (row.project !== opts.project) {
      return mapError(wrongProjectChange(opts.project, changeId, row.project));
    }
    return { row, status: row.status };
  }
}

/** The discard RPC's answer: the deleted draft's id, or what replaced it. */
function asDiscarded(answer: RpcAnswer): { discarded: number } | StoreError {
  const checked = expectNoRefusal(answer, 'changesets.discardDraft');
  if (!('body' in checked)) return checked;
  return typeof checked.body === 'number'
    ? { discarded: checked.body }
    : mapError(`unexpected RPC answer: ${JSON.stringify(checked.body)}`);
}

/** A refusal cannot arrive from a changeset path; reported as a bug if it does. */
function expectError(answer: DraftRefusal | StoreError): StoreError {
  return 'refused' in answer
    ? mapError('unexpected draft refusal from changesets.publishChange')
    : answer;
}

// ── The install-time half ───────────────────────────────────────────────────
//
// `stet upgrade` needs to read the schema version, run DDL and stamp the
// descriptor version. None of that is a content operation, so none of it joins
// the `StoreAdapter` interface (§13.6 C freezes it at seven methods plus the
// flag): they are module exports beside the factory, reaching the database
// through the same pool configuration the adapter uses.
//
// These three THROW rather than returning a typed error. They run at install
// time with an operator watching, where a failure is the answer, not an
// absence to degrade past — `cli/meta.ts` is the one caller and reports them.

/**
 * The installed `stet_meta` row, or null when the table is not there at all
 * (SQLSTATE 42P01, undefined_table) — an unversioned database, which `upgrade`
 * reports as "migration 1 pending" rather than guessing at "up to date".
 */
export async function readStetMeta(connectionString: string): Promise<StetMeta | null> {
  const pool = makePool(connectionString);
  try {
    const result = await pool.query<StetMetaRow & pg.QueryResultRow>(
      'select schema_version, descriptor_version from stet_meta where id = 1',
    );
    const row = result.rows[0];
    return row === undefined ? null : mapStetMetaRow(row);
  } catch (error) {
    if (error instanceof pg.DatabaseError && error.code === '42P01') return null;
    throw error;
  } finally {
    await pool.end();
  }
}


/**
 * One migration file, applied as one query. The file carries its own
 * `begin`/`commit`, so a failed apply leaves nothing behind — this must not
 * wrap it in a second transaction, and does not.
 *
 * The atomicity is the FILE's, not this function's: sending the text as a
 * single simple-query message means Postgres runs it as one implicit
 * transaction only until the file's own `begin` takes over. A future migration
 * carrying a mid-file `commit;` would split into two transactions and a
 * failure after it would leave the first half applied. The guarantee lives in
 * how migrations are written, and every shipped file is checked for it.
 */
export async function applySql(connectionString: string, sql: string): Promise<void> {
  const pool = makePool(connectionString);
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

/** The descriptor-version stamp migration 1's `''` promises (§4). */
export async function writeDescriptorVersion(connectionString: string, v: string): Promise<void> {
  const pool = makePool(connectionString);
  try {
    await pool.query('update stet_meta set descriptor_version = $1, updated_at = now() where id = 1', [v]);
  } finally {
    await pool.end();
  }
}

/**
 * A server that answered hands over its own text and its SQLSTATE; a server
 * that did not is an absence. `map` decides what a raise means — the RPC paths
 * admit a refusal, the read paths do not.
 */
function failure<T>(
  error: unknown,
  map: (message: string, ctx: RaiseContext) => T,
): T | StoreError {
  if (error instanceof pg.DatabaseError && error.message) {
    return map(error.message, { sqlstate: error.code });
  }
  return mapError(error);
}

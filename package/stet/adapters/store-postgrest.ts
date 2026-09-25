/**
 * The HTTP store: PostgREST over the same schema `store-pg` talks to directly.
 * This is the reference install's transport — Supabase and the self-hosted
 * stack both speak it — and every constraint in the design follows from one
 * fact: PostgREST wraps each request in its own transaction. That is why every
 * multi-statement operation is a Postgres function rather than two calls.
 *
 * `canApplyDDL` is false. DDL runs out of band (the Management API, psql), and
 * this adapter's post-DDL contract is:
 *
 *   notify pgrst, 'reload schema';
 *
 * without which the new functions are invisible to the API until it restarts.
 * That failure arrives as PGRST202, whose remedy PostgREST puts in `hint` and
 * `details` — so an error's whole body reaches the caller's message, not just
 * its first line.
 *
 * No write is ever retried, and there is no retry wrapper in this file to
 * disable: a truncated response to a write that actually landed would duplicate
 * the row. One call is one request is one transaction.
 */

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
  eqFilter,
  listValue,
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
  type RpcAnswer,
  type SqlRow,
  type StetMeta,
  type StetMetaRow,
  wrongProjectChange,
} from './store-shared.js';

const SELECT =
  'id,key,locale,target,state,is_active,value,publish_at,editor,label,note,' +
  'published_by,reverted_from,changeset_id,created_at,published_at';

/** The `changesets` columns, for the same reason `SELECT` is written once. */
const CHANGE_SELECT = 'id,name,note,status,author_kind,publish_at,created_at,reverted_at';

type Fetch = typeof globalThis.fetch;

/** What the install-time helpers need to reach a PostgREST: the same three things. */
export interface PostgrestConnection {
  url: string;
  token: string;
  fetchImpl?: Fetch;
}

/** One trailing slash, removed once. Every path below is written with a leading one. */
function baseOf(url: string): string {
  return url.replace(/\/$/, '');
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function fetchOf(conn: { fetchImpl?: Fetch }): Fetch {
  return conn.fetchImpl ?? ((...args) => globalThis.fetch(...args));
}

export function createPostgrestStore(opts: {
  url: string;
  token: string;
  project: string;
  fetchImpl?: Fetch;
}): StoreAdapter {
  const base = baseOf(opts.url);
  const call: Fetch = fetchOf(opts);

  const headers = (): Record<string, string> => authHeaders(opts.token);

  /** One request. A failure to reach the server and a raise are different answers. */
  async function send(
    path: string,
    init?: { method: string; body?: string; prefer?: string },
  ): Promise<RpcAnswer> {
    let response: Response;
    try {
      const request: RequestInit = { headers: headers() };
      if (init !== undefined) {
        request.method = init.method;
        if (init.body !== undefined) request.body = init.body;
        // `return=representation`, where a write must read back what it
        // touched: a PATCH or DELETE blocked by row level security comes back
        // 204 having changed nothing, and a row count is the only honest check.
        if (init.prefer !== undefined) request.headers = { ...headers(), Prefer: init.prefer };
      }
      response = await call(`${base}${path}`, request);
    } catch (error) {
      return mapError(error);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return mapError(error);
    }
    if (!response.ok) {
      const answer = raised(text);
      return answer === null
        ? mapError(new Error(`${response.status} ${response.statusText}: ${text}`))
        : mapRaise(answer.message, { sqlstate: answer.sqlstate, detail: answer.detail });
    }
    try {
      return { body: text === '' ? null : JSON.parse(text) };
    } catch {
      return mapError(`unparseable response body: ${text}`);
    }
  }

  /** A `POST /rpc/<fn>` with named arguments — the way PostgREST calls functions. */
  async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcAnswer> {
    return send(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  }

  async function select(params: URLSearchParams): Promise<SqlRow[] | StoreError> {
    const answer = expectNoRefusal(await send(`/content_versions?${params.toString()}`), 'read');
    if (!('body' in answer)) return answer;
    // A 200 carrying something other than rows is a broken contract, never an
    // empty read: resolution would take zero rows for a snapshot-only project
    // and warn about nothing.
    return Array.isArray(answer.body)
      ? (answer.body as SqlRow[])
      : mapError(`unexpected read body: ${JSON.stringify(answer.body)}`);
  }

  function scoped(): URLSearchParams {
    const params = new URLSearchParams();
    params.set('select', SELECT);
    // Project scoping is a filter like any other, so it is quoted like any
    // other: an unquoted project carrying a comma would scope to nothing.
    params.set('project', eqFilter(opts.project));
    return params;
  }

  return {
    project: opts.project,
    canApplyDDL: false,

    async read(q = {}): Promise<StoreRow[] | StoreError> {
      const params = scoped();
      // Active rows always; drafts only under an explicitly requested preview.
      if (q.preview === true) params.set('or', '(is_active.is.true,state.eq.draft)');
      else params.set('is_active', 'is.true');
      if (q.keys !== undefined) params.set('key', `in.(${list(q.keys)})`);
      if (q.locale !== undefined) params.set('locale', `in.(${list(localeChain(q.locale))})`);
      params.set('order', 'id.asc');
      const rows = await select(params);
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
        await rpc('save_content_draft', {
          p_key: p.key,
          p_value: p.value,
          p_target: p.target,
          p_editor: p.editor,
          p_locale: p.locale ?? 'default',
          p_project: opts.project,
          p_label: p.label ?? null,
          p_note: p.note ?? null,
          p_publish_at: p.publishAt ?? null,
          p_force: p.force ?? false,
          // Named arguments, so "absent" is a genuinely OMITTED argument:
          // JSON.stringify drops an undefined value from the wire by itself,
          // and the SQL default (-1, the sentinel) then applies. The positional
          // pg call cannot do this and sends -1 explicitly instead.
          p_change: p.change,
        }),
      );
    },

    async publish(p: {
      key: string;
      editor: string;
      locale?: string;
    }): Promise<{ versionId: number } | StoreError> {
      return asVersion(
        await rpc('publish_content_version', {
          p_key: p.key,
          p_editor: p.editor,
          p_locale: p.locale ?? 'default',
          p_project: opts.project,
        }),
        'publish',
      );
    },

    async revert(p: {
      versionId: number;
      editor: string;
      expectActive?: number;
    }): Promise<{ versionId: number } | StoreError> {
      // The adapter passes its own project: version ids are global, and the RPC
      // refuses `wrong_project` rather than reaching across. The guard is
      // omitted unless the group revert set it, leaving 001's behavior.
      return asVersion(
        await rpc('revert_content_version', {
          p_version_id: p.versionId,
          p_editor: p.editor,
          p_project: opts.project,
          p_expect_active: p.expectActive,
        }),
        'revert',
      );
    },

    async rename(p: {
      oldKey: string;
      newKey: string;
      editor: string;
    }): Promise<{ renamed: true } | StoreError> {
      return asRenamed(
        await rpc('rename_content_key', {
          p_old_key: p.oldKey,
          p_new_key: p.newKey,
          p_editor: p.editor,
          p_project: opts.project,
        }),
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
      const params = scoped();
      params.set('key', eqFilter(q.key));
      params.set('state', 'eq.published');
      if (q.locale !== undefined) params.set('locale', eqFilter(q.locale));
      if (q.beforeId !== undefined) params.set('id', `lt.${q.beforeId}`);
      params.set('order', 'id.desc');
      params.set('limit', String(limit));
      const rows = await select(params);
      return isError(rows) ? rows : mapPage(rows, limit);
    },

    async recent(
      q: { beforeId?: number; limit?: number } = {},
    ): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | StoreError> {
      const limit = pageLimit(q.limit);
      const params = scoped();
      params.set('state', 'eq.published');
      if (q.beforeId !== undefined) params.set('id', `lt.${q.beforeId}`);
      params.set('order', 'id.desc');
      params.set('limit', String(limit));
      const rows = await select(params);
      return isError(rows) ? rows : mapPage(rows, limit);
    },

    // The contacts capability: transport only, over the same migration-3
    // functions store-pg calls. Table functions answer as rows, the jsonb and
    // scalar ones as one parsed body; the mapping is store-shared's.
    contacts: {
      async addGroup(p): Promise<{ created: true } | StoreError> {
        const invalid = invalidDeclaration(p.properties);
        if (invalid) return invalid;
        const done = asVoid(
          await rpc('stet_group_add', { p_project: opts.project, p_key: p.key, p_name: p.name, p_properties: p.properties }),
          'contacts.addGroup',
        );
        return done === true ? { created: true } : done;
      },

      async setGroupState(p): Promise<{ state: 'open' | 'closed' } | StoreError> {
        const done = asVoid(
          await rpc('stet_group_state', { p_project: opts.project, p_key: p.key, p_state: p.state }),
          'contacts.setGroupState',
        );
        return done === true ? { state: p.state } : done;
      },

      async groups() {
        const rows = await table<GroupSqlRow>('/rpc/stet_group_list', {
          method: 'POST',
          body: JSON.stringify({ p_project: opts.project }),
        });
        return isError(rows) ? rows : { groups: rows.map(mapGroupRow) };
      },

      async group(p) {
        const rows = await table<GroupDefSqlRow>('/rpc/stet_group_get', {
          method: 'POST',
          body: JSON.stringify({ p_project: opts.project, p_key: p.key }),
        });
        return isError(rows) ? rows : { group: rows[0] === undefined ? null : mapGroupDef(rows[0]) };
      },

      async join(p) {
        return asJoin(
          await rpc('stet_join_group', {
            p_project: opts.project,
            p_group: p.group,
            p_email: p.email,
            p_properties: p.properties,
            p_form: p.form ?? null,
            p_page: p.page ?? null,
          }),
        );
      },

      async importMember(p) {
        return asImportOutcome(
          await rpc('stet_import_member', {
            p_project: opts.project,
            p_group: p.group,
            p_email: p.email,
            p_properties: p.properties,
            p_form: p.form,
            p_joined_at: p.joinedAt ?? null,
          }),
        );
      },

      async members(q) {
        const limit = pageLimit(q.limit);
        const rows = await table<MemberSqlRow>('/rpc/stet_group_members', {
          method: 'POST',
          body: JSON.stringify({ p_project: opts.project, p_group: q.group, p_after_id: q.afterId ?? 0, p_limit: limit }),
        });
        return isError(rows) ? rows : memberPage(rows, q.group, limit);
      },

      async contact(p) {
        const answer = expectNoRefusal(
          await rpc('stet_contact_record', { p_project: opts.project, p_email: p.email }),
          'contacts.contact',
        );
        return 'body' in answer ? mapContactRecord(answer.body) : answer;
      },

      // One row, so a direct upsert rather than a function: with
      // ignore-duplicates PostgREST returns only the rows it inserted.
      async suppress(p) {
        const rows = await table<{ email: string }>('/stet_suppressions?on_conflict=email,scope', {
          method: 'POST',
          body: JSON.stringify({ email: normalEmail(p.email), scope: p.scope, source: p.source }),
          prefer: 'resolution=ignore-duplicates,return=representation',
        });
        return isError(rows) ? rows : { suppressed: rows.length > 0 };
      },

      async erase(p) {
        return asErased(await rpc('stet_erase_contact', { p_project: opts.project, p_email: p.email }));
      },

      async suppressionCounts() {
        const rows = await table<{ scope: 'transactional' | 'marketing'; source: string; n: number | string }>(
          '/rpc/stet_suppression_counts',
          { method: 'POST', body: '{}' },
        );
        return isError(rows) ? rows : { counts: rows.map((r) => ({ scope: r.scope, source: r.source, n: Number(r.n) })) };
      },
    } satisfies ContactOps,

    changesets: {
      async open(p): Promise<{ changeId: number } | StoreError> {
        const rows = await table<{ id: number }>('/changesets', {
          method: 'POST',
          body: JSON.stringify({
            project: opts.project,
            name: p.name,
            note: p.note ?? null,
            author_kind: p.authorKind ?? 'human',
          }),
          prefer: 'return=representation',
        });
        if (isError(rows)) return rows;
        const id = rows[0]?.id;
        return id === undefined ? mapError('opening a change returned no id') : { changeId: id };
      },

      async list(q = {}): Promise<{ changes: ChangesetRow[]; nextBeforeId: number | null } | StoreError> {
        const limit = pageLimit(q.limit);
        const params = changeScoped();
        if (q.status !== undefined) params.set('status', eqFilter(q.status));
        if (q.beforeId !== undefined) params.set('id', `lt.${q.beforeId}`);
        params.set('order', 'id.desc');
        params.set('limit', String(limit));
        const rows = await table<ChangesetSqlRow>(`/changesets?${params.toString()}`);
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
        const published = found.row.status === 'published';

        const params = new URLSearchParams();
        params.set('select', 'id,key,locale');
        params.set('project', eqFilter(opts.project));
        params.set('changeset_id', `eq.${p.changeId}`);
        params.set('state', published ? 'eq.published' : 'eq.draft');
        params.set('order', 'id.asc');
        const rows = await table<{ id: number; key: string; locale: string }>(
          `/content_versions?${params.toString()}`,
        );
        if (isError(rows)) return rows;

        const members: ChangeMember[] = [];
        for (const m of rows) {
          if (!published) {
            members.push({ key: m.key, locale: m.locale, versionId: m.id });
            continue;
          }
          // One `limit=1` query per member. N+1, and bounded by member count —
          // a changeset is a handful of keys — so it is stated rather than
          // optimized. (`store-pg` does it in one lateral join.)
          const before = await table<{ id: number; value: unknown }>(
            `/content_versions?${beforeParams(m).toString()}`,
          );
          if (isError(before)) return before;
          const prior = before[0];
          members.push({
            key: m.key,
            locale: m.locale,
            versionId: m.id,
            beforeVersionId: prior?.id ?? null,
            // ABSENT, not null and not present-but-undefined, where there is no
            // prior version: a first-publish member has no before VALUE at all,
            // and the preview resolver reads the property's absence as "no
            // override row for this key".
            ...(prior === undefined ? {} : { beforeValue: prior.value }),
          });
        }
        return { change: mapChangesetRow(found.row), members };
      },

      async schedule(p): Promise<{ status: ChangesetStatus } | StoreError> {
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        if (found.row.status === 'published') return mapError(changeClosed(p.changeId));
        if (p.publishAt !== null) {
          const params = new URLSearchParams();
          params.set('select', 'id');
          params.set('project', eqFilter(opts.project));
          params.set('changeset_id', `eq.${p.changeId}`);
          params.set('state', 'eq.draft');
          const members = await table<{ id: number }>(`/content_versions?${params.toString()}`);
          if (isError(members)) return members;
          // A stamp with nothing to publish is the demotion sweep's food; the
          // CANCEL arm carries no member requirement, because that sweep
          // cancels empty changes by design.
          if (members.length === 0) return mapError(noMembers(p.changeId));
        }

        // The CHANGE ROW FIRST, then the member stamps — both arms. The reverse
        // order on cancel would let a member attaching between the two requests
        // inherit the still-standing stamp, and the clock would publish a
        // change the operator cancelled. Each request is its own transaction
        // here, so a torn write lands on a state the clock already handles.
        //
        // `status=neq.published` is the guard of RECORD. The read above is a
        // whole HTTP round-trip away from this PATCH — a wider window than the
        // pg adapter's — so a `publish_change` committing in between would let
        // this resurrect a published change, back to open on the cancel arm
        // (the unattended demotion sweep races an operator's publish on its
        // own) or to scheduled on the reschedule arm, and the group revert
        // would be refused forever. Zero rows returned means it published under
        // us: the same refusal the read would have given.
        const status: ChangesetStatus = p.publishAt === null ? 'open' : 'scheduled';
        const head = await table<{ id: number }>(
          `/changesets?id=eq.${p.changeId}&status=neq.published`,
          {
            method: 'PATCH',
            body: JSON.stringify({ status, publish_at: p.publishAt }),
            prefer: 'return=representation',
          },
        );
        if (isError(head)) return head;
        if (head.length === 0) return mapError(changeClosed(p.changeId));
        const stamped = await table(`/content_versions?${memberDrafts(p.changeId).toString()}`, {
          method: 'PATCH',
          body: JSON.stringify({ publish_at: p.publishAt }),
          prefer: 'return=representation',
        });
        if (isError(stamped)) return stamped;
        return { status };
      },

      async publishChange(p): Promise<{ published: { key: string; locale: string; versionId: number }[] } | StoreError> {
        // The RPC returns a ROW SET, not a scalar: the minted member per row, so
        // a surface fires its per-member events with no second read.
        const answer = expectNoRefusal(
          await rpc('publish_change', {
            p_change: p.changeId,
            p_editor: p.editor,
            p_project: opts.project,
          }),
          'changesets.publishChange',
        );
        if (!('body' in answer)) return answer;
        if (!Array.isArray(answer.body)) {
          return mapError(`unexpected publish_change body: ${JSON.stringify(answer.body)}`);
        }
        return {
          published: (answer.body as { o_key: string; o_locale: string; o_version_id: number }[]).map(
            (r) => ({ key: r.o_key, locale: r.o_locale, versionId: r.o_version_id }),
          ),
        };
      },

      async abandon(p): Promise<{ abandoned: true; droppedDrafts: number } | StoreError> {
        // A published change is never deleted: its row is the group revert's
        // and the before-preview's read.
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        if (found.row.status === 'published') return mapError(changeClosed(p.changeId));
        // The drafts go FIRST, so a torn abandon leaves an empty open change —
        // harmless and re-abandonable — never drafts pointing at a deleted row.
        const dropped = await table<{ id: number }>(
          `/content_versions?${memberDrafts(p.changeId).toString()}`,
          { method: 'DELETE', prefer: 'return=representation' },
        );
        if (isError(dropped)) return dropped;
        // The guard rides IN the write, for the reason `schedule` states: a
        // `publish_change` committing between the read and this DELETE would
        // otherwise take the row with it, stranding live rows pointing at a
        // change that no longer exists and destroying the group revert and the
        // change-before preview permanently. Zero rows deleted means published.
        const removed = await table<{ id: number }>(
          `/changesets?id=eq.${p.changeId}&status=neq.published`,
          { method: 'DELETE', prefer: 'return=representation' },
        );
        if (isError(removed)) return removed;
        if (removed.length === 0) return mapError(changeClosed(p.changeId));
        return { abandoned: true, droppedDrafts: dropped.length };
      },

      async discardDraft(p): Promise<{ discarded: number } | StoreError> {
        const answer = expectNoRefusal(
          await rpc('discard_content_draft', {
            p_key: p.key,
            p_locale: p.locale ?? 'default',
            p_project: opts.project,
          }),
          'changesets.discardDraft',
        );
        if (!('body' in answer)) return answer;
        return typeof answer.body === 'number'
          ? { discarded: answer.body }
          : mapError(`unexpected RPC answer: ${JSON.stringify(answer.body)}`);
      },

      async markReverted(p): Promise<{ revertedAt: string } | StoreError> {
        const found = await readChange(p.changeId);
        if ('storeError' in found) return found;
        const rows = await table<{ reverted_at: string }>(`/changesets?id=eq.${p.changeId}`, {
          method: 'PATCH',
          // REST has no `now()`, and a column default fires only on insert.
          body: JSON.stringify({ reverted_at: new Date().toISOString() }),
          prefer: 'return=representation',
        });
        if (isError(rows)) return rows;
        const at = rows[0]?.reverted_at;
        return at === undefined
          ? mapError('marking the change reverted returned no stamp')
          : { revertedAt: new Date(at).toISOString() };
      },
    } satisfies ChangesetOps,
  };

  /** One table request whose body must be an array of rows. */
  async function table<T>(
    path: string,
    init?: { method: string; body?: string; prefer?: string },
  ): Promise<T[] | StoreError> {
    const answer = expectNoRefusal(await send(path, init), 'changesets');
    if (!('body' in answer)) return answer;
    return Array.isArray(answer.body)
      ? (answer.body as T[])
      : mapError(`unexpected table body: ${JSON.stringify(answer.body)}`);
  }

  function changeScoped(): URLSearchParams {
    const params = new URLSearchParams();
    params.set('select', CHANGE_SELECT);
    params.set('project', eqFilter(opts.project));
    return params;
  }

  /**
   * One change's member drafts, scoped to this project. Built through
   * `URLSearchParams` like every other filter here, never string-interpolated:
   * `eqFilter` leaves a value bare and does not PERCENT-ENCODE it, so a project
   * carrying a `#` would truncate the query at the fragment and a `&` would
   * inject a parameter — either way dropping the scoping filters off the two
   * destructive writes (the stamp PATCH and the abandon DELETE) that use this.
   */
  function memberDrafts(changeId: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set('project', eqFilter(opts.project));
    params.set('changeset_id', `eq.${changeId}`);
    params.set('state', 'eq.draft');
    return params;
  }

  /** §6.1's selection: the key's previous published row below the minted id. */
  function beforeParams(m: { id: number; key: string; locale: string }): URLSearchParams {
    const params = new URLSearchParams();
    params.set('select', 'id,value');
    params.set('project', eqFilter(opts.project));
    params.set('key', eqFilter(m.key));
    params.set('locale', eqFilter(m.locale));
    params.set('state', 'eq.published');
    params.set('id', `lt.${m.id}`);
    params.set('order', 'id.desc');
    params.set('limit', '1');
    return params;
  }

  /**
   * A change row this project may act on. The lookup is GLOBAL and the project
   * check follows, exactly as the SQL reads it: ids are global, so another
   * project's change is `wrong_project`, never "not found".
   */
  async function readChange(
    changeId: number,
  ): Promise<{ row: ChangesetSqlRow } | StoreError> {
    const rows = await table<ChangesetSqlRow & { project: string }>(
      `/changesets?id=eq.${changeId}&select=${CHANGE_SELECT},project`,
    );
    if (isError(rows)) return rows;
    const row = rows[0];
    if (row === undefined) return mapError(noChange(changeId));
    if (row.project !== opts.project) {
      return mapError(wrongProjectChange(opts.project, changeId, row.project));
    }
    return { row };
  }
}

// ── The install-time half ───────────────────────────────────────────────────
//
// The read side of what `stet upgrade` needs, and the descriptor-version stamp.
// DDL is not here and cannot be: `canApplyDDL` is false because DDL does not
// ride REST. These are module exports beside the factory, never interface
// methods (§13.6 C), and they throw rather than returning a typed error — at
// install time a failure is the answer, and `cli/meta.ts` reports it.

/** PostgREST's own codes for "the schema cache has never heard of this". */
const SCHEMA_CACHE_MISS = /^PGRST20\d$/;

/**
 * The installed `stet_meta` row, or null when the table is not there.
 *
 * Carried caveat (W1, unchanged): row level security is enabled on
 * `stet_meta`, and a role RLS blocks reads `[]` — indistinguishable here from
 * an absent table, so a blocked role reports as unversioned. The write below
 * is what catches that case honestly.
 */
export async function readStetMeta(conn: PostgrestConnection): Promise<StetMeta | null> {
  const response = await fetchOf(conn)(
    `${baseOf(conn.url)}/stet_meta?id=eq.1&select=schema_version,descriptor_version`,
    { headers: authHeaders(conn.token) },
  );
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404 || SCHEMA_CACHE_MISS.test(codeOf(text) ?? '')) return null;
    throw new Error(`stet_meta read failed: ${response.status} ${response.statusText}: ${text}`);
  }
  const rows = JSON.parse(text === '' ? '[]' : text) as StetMetaRow[];
  const row = rows[0];
  return row === undefined ? null : mapStetMetaRow(row);
}

/**
 * The descriptor-version stamp, over REST.
 *
 * `Prefer: return=representation` is load-bearing: RLS is enabled on
 * `stet_meta`, and a blocked role's PATCH comes back 204 having changed
 * nothing. A row count other than exactly 1 is therefore a failure, never a
 * quiet success. `updated_at` is sent explicitly because REST has no `now()`
 * and a column default fires only on insert.
 */
export async function writeDescriptorVersion(conn: PostgrestConnection, v: string): Promise<void> {
  const response = await fetchOf(conn)(`${baseOf(conn.url)}/stet_meta?id=eq.1`, {
    method: 'PATCH',
    headers: { ...authHeaders(conn.token), Prefer: 'return=representation' },
    body: JSON.stringify({ descriptor_version: v, updated_at: new Date().toISOString() }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`stet_meta stamp failed: ${response.status} ${response.statusText}: ${text}`);
  }
  const rows = JSON.parse(text === '' ? '[]' : text) as unknown[];
  if (rows.length !== 1) {
    throw new Error(
      `stet_meta stamp touched ${rows.length} rows, expected 1 — the role is blocked by row level security, or migration 1 has not been applied`,
    );
  }
}

/** PostgREST's error code, where the body carries one. */
function codeOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * PostgREST reports a raise as a JSON body carrying the server's own message,
 * its SQLSTATE in `code`, and — for PostgREST's own failures — the remedy in
 * `hint` and `details`. All three ride along, appended to the message rather
 * than mixed into it: a refusal's JSON payload is parsed from the message
 * alone.
 */
function raised(text: string): { message: string; sqlstate?: string; detail?: string } | null {
  let body: { message?: unknown; code?: unknown; hint?: unknown; details?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return null;
  }
  if (typeof body.message !== 'string') return null;
  const parts: string[] = [];
  for (const field of ['code', 'hint', 'details'] as const) {
    const value = body[field];
    if (typeof value === 'string' && value !== '') parts.push(`${field}: ${value}`);
  }
  return {
    message: body.message,
    sqlstate: typeof body.code === 'string' ? body.code : undefined,
    detail: parts.join(', '),
  };
}

/** An `in.(…)` list: every value quoted, so a comma in a key cannot end it. */
function list(values: string[]): string {
  return values.map(listValue).join(',');
}

/**
 * The conformance reference: the store's observable semantics in process, with
 * no database anywhere. Every later change can test against a real store
 * without infrastructure, and the SQL adapters must match this behavior
 * exactly — the conformance suite is the referee, and a divergence is a bug in
 * one of the two, never a licence for either.
 *
 * `canApplyDDL` is false: there is no schema here to migrate, and the reference
 * must not claim a capability the SQL adapters gate on.
 */

import { normalEmail } from '../src/contacts.js';
import { localeChain, type StoreRow } from '../src/resolve.js';
import type {
  ChangeMember,
  ChangesetOps,
  ChangesetRow,
  ChangesetStatus,
  ContactOps,
  ContactRecord,
  DraftRefusal,
  GroupDef,
  GroupProperty,
  GroupState,
  MemberRow,
  MembershipRow,
  NotSupported,
  SuppressionScope,
  SaveDraftParams,
  StoreAdapter,
  StoreError,
  VersionRow,
} from '../src/store.js';
import type { Target } from '../src/types.js';
import {
  changeClosed,
  groupClosed,
  groupExists,
  groupedSchedule,
  unknownGroup,
  invalidDeclaration,
  mapChangesetRow,
  mapError,
  mapPage,
  mapRow,
  noChange,
  noDraft,
  noMembers,
  noVersion,
  notPublished,
  pageLimit,
  refusal,
  staleActive,
  targetOccupied,
  wrongProject,
  wrongProjectChange,
} from './store-shared.js';

/** One row, the SQL columns this change writes. */
export interface MemoryRow {
  id: number;
  project: string;
  key: string;
  locale: string;
  target: Target;
  value: unknown;
  state: 'draft' | 'published';
  is_active: boolean;
  publish_at: string | null;
  label: string | null;
  note: string | null;
  editor: string | null;
  published_by: string | null;
  reverted_from: number | null;
  changeset_id: number | null;
  created_at: string;
  published_at: string | null;
}

/** One `changesets` row. Membership lives on the version row, not here. */
export interface MemoryChangeset {
  id: number;
  project: string;
  name: string;
  note: string | null;
  status: ChangesetStatus;
  author_kind: 'human' | 'agent';
  publish_at: string | null;
  created_at: string;
  reverted_at: string | null;
}

export interface RenameRecord {
  project: string;
  old_key: string;
  new_key: string;
  editor: string;
  renamed_at: string;
}

/**
 * The rows themselves, separable from the adapter that reads them: two adapters
 * on different projects share one `MemoryDb` the way two apps in a monorepo
 * share one database, which is what makes project scoping testable rather than
 * true by construction.
 */
export interface MemoryDb {
  rows: MemoryRow[];
  renames: RenameRecord[];
  changesets: MemoryChangeset[];
  nextId: number;
  /** `changesets.id` is its own bigserial — change ids never share the version sequence. */
  nextChangeId: number;
  /** Migration 3's tables, as the reference holds them. */
  groups: MemoryGroup[];
  contacts: MemoryContact[];
  memberships: MemoryMembership[];
  /** Store-wide, keyed (email, scope) — never by project. */
  suppressions: { email: string; scope: SuppressionScope; source: string; created_at: string }[];
  /**
   * `stet_erasures`, keyed by the normalized address itself: this store lives
   * in one process and persists nothing, and it imports no Node builtin, so it
   * keeps no hash. The SQL stores keep the salted hash (migration 003).
   */
  erasures: { project: string; email: string; erased_at: string }[];
  nextContactId: number;
  nextMembershipId: number;
}

export interface MemoryGroup {
  project: string;
  key: string;
  name: string;
  state: GroupState;
  properties: GroupProperty[];
  created_at: string;
  updated_at: string;
}

export interface MemoryContact {
  id: number;
  project: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryMembership {
  id: number;
  contact_id: number;
  project: string;
  group_key: string;
  joined_at: string;
  form: string | null;
  page: string | null;
  properties: Record<string, string>;
  updated_at: string;
}

export function createMemoryDb(): MemoryDb {
  return {
    rows: [],
    renames: [],
    changesets: [],
    nextId: 1,
    nextChangeId: 1,
    groups: [],
    contacts: [],
    memberships: [],
    suppressions: [],
    erasures: [],
    nextContactId: 1,
    nextMembershipId: 1,
  };
}

/** A row as a test declares it; everything unstated takes the column default. */
export interface SeedRow {
  key: string;
  value: unknown;
  project?: string;
  locale?: string;
  target?: Target;
  state?: 'draft' | 'published';
  is_active?: boolean;
  editor?: string | null;
  label?: string | null;
  note?: string | null;
  publish_at?: string | null;
}

export interface MemoryStore extends StoreAdapter {
  /** Preload rows. Refuses a seed the partial unique indexes would reject. */
  seed(rows: SeedRow[]): void;
  /** This project's rows, as data a test can assert over. */
  dump(): MemoryRow[];
  /** The next call of this kind answers `unreachable`, once. */
  failNext?: 'read' | 'write';
}

export function createMemoryStore(opts: { project: string; db?: MemoryDb }): MemoryStore {
  const db = opts.db ?? createMemoryDb();
  const project = opts.project;

  const mine = (): MemoryRow[] => db.rows.filter((r) => r.project === project);
  const draftOf = (key: string, locale: string): MemoryRow | undefined =>
    mine().find((r) => r.key === key && r.locale === locale && r.state === 'draft');
  const activeOf = (key: string, locale: string): MemoryRow | undefined =>
    mine().find((r) => r.key === key && r.locale === locale && r.is_active);
  /** This project's member drafts of one change, in id order — the SQL's member set. */
  const membersOf = (changeId: number): MemoryRow[] =>
    mine()
      .filter((r) => r.changeset_id === changeId && r.state === 'draft')
      .sort((a, b) => a.id - b.id);

  /**
   * A change by id, or the raise that replaces it. The lookup is GLOBAL and the
   * project check follows, exactly as the SQL reads it: ids are global, so
   * another project's change is `wrong_project`, never "not found".
   */
  function changeOr(changeId: number): MemoryChangeset | StoreError {
    const found = db.changesets.find((c) => c.id === changeId);
    if (!found) return mapError(noChange(changeId));
    if (found.project !== project) {
      return mapError(wrongProjectChange(project, changeId, found.project));
    }
    return found;
  }

  /** A change that must still accept writes — published takes no more of them. */
  function openChangeOr(changeId: number): MemoryChangeset | StoreError {
    const found = changeOr(changeId);
    if ('storeError' in found) return found;
    if (found.status === 'published') return mapError(changeClosed(changeId));
    return found;
  }

  /**
   * The clear-and-flip core both publish paths share — the reference's
   * `stet_publish_flip`. The two callers differ in ONE thing, deliberately: the
   * solo publish clears `changeset_id`, the group flip keeps it, because the
   * minted row's tag is what the before-state derivation, the revert guard and
   * the grouped history all read.
   *
   * In SQL this is one transaction, so no caller ever observes the key with
   * zero active versions; here nothing can interleave at all.
   */
  function flip(draft: MemoryRow, editor: string, keepChange: boolean): void {
    const active = activeOf(draft.key, draft.locale);
    if (active) active.is_active = false;
    draft.state = 'published';
    draft.is_active = true;
    // editor stays the draft's author; published_by records who made it live.
    draft.published_by = editor;
    draft.publish_at = null;
    draft.published_at = now();
    if (!keepChange) draft.changeset_id = null;
  }

  /** The key's previous published row below a minted id — §6.1's selection. */
  function beforeOf(minted: MemoryRow): MemoryRow | undefined {
    return mine()
      .filter(
        (r) =>
          r.key === minted.key &&
          r.locale === minted.locale &&
          r.state === 'published' &&
          r.id < minted.id,
      )
      .sort((a, b) => b.id - a.id)[0];
  }

  /** The next failure this store owes a caller, consumed on the way out. */
  function owed(kind: 'read' | 'write'): StoreError | null {
    if (store.failNext !== kind) return null;
    delete store.failNext;
    // A store that did not answer, built through the same table as a real one.
    return mapError(new Error(`memory store: simulated ${kind} failure`));
  }

  // ── Contacts: the reference for migration 3's functions ──────────────────

  const groupOf = (key: string): MemoryGroup | undefined =>
    db.groups.find((g) => g.project === project && g.key === key);
  const contactOf = (email: string): MemoryContact | undefined =>
    db.contacts.find((c) => c.project === project && c.email === normalEmail(email));
  const suppressedFor = (email: string): boolean =>
    db.suppressions.some((x) => x.email === normalEmail(email) && x.scope === 'marketing');
  const erased = (email: string): boolean => db.erasures.some((e) => e.project === project && e.email === normalEmail(email));

  /** `stet_contact_id`: the row for an address, created on first sight; a re-sight moves updated_at. */
  function contactIdFor(email: string): number {
    const found = contactOf(email);
    if (found) {
      found.updated_at = now();
      return found.id;
    }
    const at = now();
    const row: MemoryContact = { id: db.nextContactId++, project, email: normalEmail(email), created_at: at, updated_at: at };
    db.contacts.push(row);
    return row.id;
  }

  function groupDef(g: MemoryGroup): GroupDef {
    return { key: g.key, name: g.name, state: g.state, properties: g.properties.map((x) => ({ ...x })), createdAt: g.created_at };
  }

  function membershipRow(m: MemoryMembership): MembershipRow {
    return {
      id: m.id,
      group: m.group_key,
      joinedAt: m.joined_at,
      form: m.form,
      page: m.page,
      properties: { ...m.properties },
      updatedAt: m.updated_at,
    };
  }

  const contacts: ContactOps = {
    async addGroup(p) {
      const failed = owed('write');
      if (failed) return failed;
      const invalid = invalidDeclaration(p.properties);
      if (invalid) return invalid;
      if (groupOf(p.key)) return mapError(groupExists(p.key));
      const at = now();
      db.groups.push({ project, key: p.key, name: p.name, state: 'open', properties: p.properties.map((x) => ({ ...x })), created_at: at, updated_at: at });
      return { created: true };
    },

    async setGroupState(p) {
      const failed = owed('write');
      if (failed) return failed;
      const group = groupOf(p.key);
      if (!group) return mapError(unknownGroup(p.key));
      group.state = p.state;
      group.updated_at = now();
      return { state: p.state };
    },

    async groups() {
      const failed = owed('read');
      if (failed) return failed;
      const groups = db.groups
        .filter((g) => g.project === project)
        .sort((a, b) => (a.created_at === b.created_at ? (a.key < b.key ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
        .map((g) => ({
          ...groupDef(g),
          members: db.memberships.filter((m) => m.project === project && m.group_key === g.key).length,
        }));
      return { groups };
    },

    async group(p) {
      const failed = owed('read');
      if (failed) return failed;
      const g = groupOf(p.key);
      return { group: g === undefined ? null : groupDef(g) };
    },

    async join(p) {
      const failed = owed('write');
      if (failed) return failed;
      const group = groupOf(p.group);
      if (!group) return mapError(unknownGroup(p.group));
      if (group.state !== 'open') return mapError(groupClosed(p.group));
      const contactId = contactIdFor(p.email);
      const existing = db.memberships.find((m) => m.contact_id === contactId && m.group_key === p.group);
      if (existing) {
        existing.properties = { ...p.properties };
        existing.updated_at = now();
        return {
          contactId,
          isNew: false,
          suppressed: suppressedFor(p.email),
          joinedAt: existing.joined_at,
          form: existing.form,
          page: existing.page,
        };
      }
      const at = now();
      db.memberships.push({
        id: db.nextMembershipId++,
        contact_id: contactId,
        project,
        group_key: p.group,
        joined_at: at,
        form: p.form ?? null,
        page: p.page ?? null,
        properties: { ...p.properties },
        updated_at: at,
      });
      return { contactId, isNew: true, suppressed: suppressedFor(p.email), joinedAt: at, form: p.form ?? null, page: p.page ?? null };
    },

    async importMember(p) {
      const failed = owed('write');
      if (failed) return failed;
      if (!groupOf(p.group)) return mapError(unknownGroup(p.group));
      if (erased(p.email)) return { outcome: 'erased' };
      if (suppressedFor(p.email)) return { outcome: 'suppressed' };
      const contactId = contactIdFor(p.email);
      if (db.memberships.some((m) => m.contact_id === contactId && m.group_key === p.group)) return { outcome: 'present' };
      const joined = p.joinedAt ? new Date(p.joinedAt).toISOString() : now();
      db.memberships.push({
        id: db.nextMembershipId++,
        contact_id: contactId,
        project,
        group_key: p.group,
        joined_at: joined,
        form: p.form,
        page: null,
        properties: { ...p.properties },
        updated_at: now(),
      });
      return { outcome: 'joined' };
    },

    async members(q) {
      const failed = owed('read');
      if (failed) return failed;
      if (!groupOf(q.group)) return mapError(unknownGroup(q.group));
      const limit = pageLimit(q.limit);
      const rows: MemberRow[] = db.memberships
        .filter((m) => m.project === project && m.group_key === q.group && m.id > (q.afterId ?? 0))
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((m) => {
          const c = db.contacts.find((x) => x.id === m.contact_id) as MemoryContact;
          return { ...membershipRow(m), contactId: c.id, email: c.email, suppressed: suppressedFor(c.email) };
        });
      return { rows, nextAfterId: rows.length < limit ? null : (rows[rows.length - 1]?.id ?? null) };
    },

    async contact(p) {
      const failed = owed('read');
      if (failed) return failed;
      const c = contactOf(p.email);
      const suppressions = db.suppressions
        .filter((x) => x.email === normalEmail(p.email))
        .sort((a, b) => (a.scope < b.scope ? -1 : 1))
        .map((x) => ({ scope: x.scope, source: x.source, createdAt: x.created_at }));
      if (!c && suppressions.length === 0) return { record: null };
      const record: ContactRecord = {
        email: normalEmail(p.email),
        contact: c ? { id: c.id, properties: {}, createdAt: c.created_at, updatedAt: c.updated_at } : null,
        memberships: c
          ? db.memberships.filter((m) => m.contact_id === c.id).sort((a, b) => a.id - b.id).map(membershipRow)
          : [],
        suppressions,
      };
      return { record };
    },

    async suppress(p) {
      const failed = owed('write');
      if (failed) return failed;
      if (db.suppressions.some((x) => x.email === normalEmail(p.email) && x.scope === p.scope)) return { suppressed: false };
      db.suppressions.push({ email: normalEmail(p.email), scope: p.scope, source: p.source, created_at: now() });
      return { suppressed: true };
    },

    async erase(p) {
      const failed = owed('write');
      if (failed) return failed;
      const c = contactOf(p.email);
      let count = 0;
      if (c) {
        count = db.memberships.filter((m) => m.contact_id === c.id).length;
        db.memberships = db.memberships.filter((m) => m.contact_id !== c.id);
        db.contacts = db.contacts.filter((x) => x.id !== c.id);
      }
      if (!erased(p.email)) db.erasures.push({ project, email: normalEmail(p.email), erased_at: now() });
      return { existed: c !== undefined, memberships: count };
    },

    async suppressionCounts() {
      const failed = owed('read');
      if (failed) return failed;
      const tally = new Map<string, { scope: SuppressionScope; source: string; n: number }>();
      for (const x of db.suppressions) {
        const k = `${x.scope}\u0000${x.source}`;
        const t = tally.get(k) ?? { scope: x.scope, source: x.source, n: 0 };
        t.n += 1;
        tally.set(k, t);
      }
      const counts = [...tally.values()].sort((a, b) => (a.scope === b.scope ? (a.source < b.source ? -1 : 1) : a.scope < b.scope ? -1 : 1));
      return { counts };
    },
  };

  const store: MemoryStore = {
    project,
    canApplyDDL: false,
    contacts,

    seed(rows: SeedRow[]): void {
      for (const row of rows) {
        const state = row.state ?? 'published';
        const full: MemoryRow = {
          id: db.nextId++,
          project: row.project ?? project,
          key: row.key,
          locale: row.locale ?? 'default',
          target: row.target ?? 'web',
          value: row.value,
          state,
          is_active: row.is_active ?? state === 'published',
          publish_at: row.publish_at ?? null,
          label: row.label ?? null,
          note: row.note ?? null,
          editor: row.editor ?? null,
          published_by: null,
          reverted_from: null,
          // A seed declares rows, never memberships: grouping is a save-path
          // act, and the refusal path already guards a foreign draft.
          changeset_id: null,
          created_at: now(),
          published_at: state === 'published' ? now() : null,
        };
        const clash = db.rows.find(
          (r) =>
            r.project === full.project &&
            r.key === full.key &&
            r.locale === full.locale &&
            ((full.is_active && r.is_active) || (full.state === 'draft' && r.state === 'draft')),
        );
        // The partial unique indexes are the integrity story; a seed that would
        // need the database to reject it is a bug in the test.
        if (clash) throw new Error(`seed would break a partial unique index on ${full.key}`);
        db.rows.push(full);
      }
    },

    dump(): MemoryRow[] {
      return mine().map((r) => ({ ...r }));
    },

    async read(q = {}): Promise<StoreRow[] | StoreError> {
      const failure = owed('read');
      if (failure) return failure;
      const locales = q.locale === undefined ? null : localeChain(q.locale);
      return mine()
        .filter((r) => (r.is_active ? true : q.preview === true && r.state === 'draft'))
        .filter((r) => q.keys === undefined || q.keys.includes(r.key))
        .filter((r) => locales === null || locales.includes(r.locale))
        .map(mapRow);
    },

    async saveDraft(
      p: SaveDraftParams,
    ): Promise<{ draftId: number } | DraftRefusal | NotSupported | StoreError> {
      const failure = owed('write');
      if (failure) return failure;
      const locale = p.locale ?? 'default';
      const draft = draftOf(p.key, locale);

      // An explicit attach is validated BEFORE the draft is touched, as the SQL
      // validates it before its own row read. `undefined` means "leave
      // membership alone", `null` detaches, and any id is an attach — the gate
      // is never a positivity test, so 0 and negatives find no change and are
      // refused rather than reaching the row unvalidated.
      if (p.change !== undefined && p.change !== null) {
        const attaching = openChangeOr(p.change);
        if ('storeError' in attaching) return attaching;
      }

      let member: number | null =
        p.change === undefined ? (draft?.changeset_id ?? null) : p.change;
      // On the inherited path only, a membership pointing at a change row that
      // no longer exists — an interleaved abandon deleted it after the draft
      // attached — detaches rather than raising: a stale pointer is not a
      // caller error, and raising would brick every later autosave of this key.
      if (member !== null && p.change === undefined) {
        if (!db.changesets.some((c) => c.id === member)) member = null;
      }

      // A grouped draft's schedule is the change's alone.
      let publishAt: string | null;
      if (member !== null) {
        if (p.publishAt !== undefined && p.publishAt !== null) {
          return mapError(groupedSchedule(p.key));
        }
        publishAt = db.changesets.find((c) => c.id === member)?.publish_at ?? null;
      } else {
        publishAt = p.publishAt ?? null;
      }

      if (draft) {
        if (draft.editor !== p.editor && p.force !== true) {
          return refusal(draft.editor ?? '', draft.created_at);
        }
        // The draft row is the full draft state, not a patch: an omitted label
        // or note clears a previously set one. created_at stays untouched.
        draft.value = p.value;
        draft.target = p.target;
        draft.editor = p.editor;
        draft.label = p.label ?? null;
        draft.note = p.note ?? null;
        draft.publish_at = publishAt;
        // The ungrouped/grouped move is this same update.
        draft.changeset_id = member;
        return { draftId: draft.id };
      }

      const row: MemoryRow = {
        id: db.nextId++,
        project,
        key: p.key,
        locale,
        target: p.target,
        value: p.value,
        state: 'draft',
        is_active: false,
        publish_at: publishAt,
        label: p.label ?? null,
        note: p.note ?? null,
        editor: p.editor,
        published_by: null,
        reverted_from: null,
        changeset_id: member,
        created_at: now(),
        published_at: null,
      };
      db.rows.push(row);
      return { draftId: row.id };
    },

    async publish(p: {
      key: string;
      editor: string;
      locale?: string;
    }): Promise<{ versionId: number } | NotSupported | StoreError> {
      const failure = owed('write');
      if (failure) return failure;
      const locale = p.locale ?? 'default';
      const draft = draftOf(p.key, locale);
      if (!draft) return mapError(noDraft(p.key, locale));

      // The solo flip CLEARS the tag: publishing a member individually drops it
      // structurally from its group, so no published row is ever tagged to a
      // change that never published.
      flip(draft, p.editor, false);
      return { versionId: draft.id };
    },

    async revert(p: {
      versionId: number;
      editor: string;
      expectActive?: number;
    }): Promise<{ versionId: number } | NotSupported | StoreError> {
      const failure = owed('write');
      if (failure) return failure;
      // Version ids are global across projects: this is the one write that
      // would otherwise reach across them.
      const src = db.rows.find((r) => r.id === p.versionId);
      if (!src) return mapError(noVersion(p.versionId));
      if (src.project !== project) {
        return mapError(wrongProject(project, p.versionId, src.project));
      }
      if (src.state !== 'published') return mapError(notPublished(p.versionId));

      const active = activeOf(src.key, src.locale);
      // The group revert's guard. In SQL it is the deactivating update's own
      // predicate, so the refusal rides inside the write; here the equivalent
      // is checking before anything is cleared. Nothing is cleared and nothing
      // is minted when it fires.
      if (p.expectActive !== undefined && active?.id !== p.expectActive) {
        return mapError(staleActive(src.key, p.expectActive));
      }
      if (active) active.is_active = false;
      const row: MemoryRow = {
        id: db.nextId++,
        project,
        key: src.key,
        locale: src.locale,
        target: src.target,
        value: src.value,
        state: 'published',
        is_active: true,
        publish_at: null,
        label: null,
        note: null,
        editor: p.editor,
        // Every row made live records who made it live, publish and revert alike.
        published_by: p.editor,
        // revert's provenance, the way origin_* is promote's: which version
        // this row put back.
        reverted_from: p.versionId,
        // A revert row belongs to no group: the source row's membership is not
        // copied, as its label, note and stamp are not.
        changeset_id: null,
        created_at: now(),
        published_at: now(),
      };
      // The draft row is the operator's work in progress and is never read or
      // written here.
      db.rows.push(row);
      return { versionId: row.id };
    },

    async rename(p: {
      oldKey: string;
      newKey: string;
      editor: string;
    }): Promise<{ renamed: true } | NotSupported | StoreError> {
      const failure = owed('write');
      if (failure) return failure;
      if (mine().some((r) => r.key === p.newKey)) return mapError(targetOccupied(p.newKey));
      // A key renames whole — every locale at once. Values and ids never move.
      for (const row of mine()) if (row.key === p.oldKey) row.key = p.newKey;
      // Zero rows is a no-op that still writes the record: snapshot-only keys
      // have no rows, and the audit is what keeps them linked.
      db.renames.push({
        project,
        old_key: p.oldKey,
        new_key: p.newKey,
        editor: p.editor,
        renamed_at: now(),
      });
      return { renamed: true };
    },

    async history(q: {
      key: string;
      locale?: string;
      beforeId?: number;
      limit?: number;
    }): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | NotSupported | StoreError> {
      const failure = owed('read');
      if (failure) return failure;
      const rows = mine().filter(
        (r) =>
          r.state === 'published' && r.key === q.key && (q.locale === undefined || r.locale === q.locale),
      );
      return page(rows, q.beforeId, q.limit);
    },

    async recent(
      q: { beforeId?: number; limit?: number } = {},
    ): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | NotSupported | StoreError> {
      const failure = owed('read');
      if (failure) return failure;
      return page(mine().filter((r) => r.state === 'published'), q.beforeId, q.limit);
    },

    changesets: changesetOps(),
  };

  /**
   * The capability, in process. Every refusal is built from the shared marker
   * builders rather than a string literal, so the reference and the SQL cannot
   * word the same refusal two ways.
   */
  function changesetOps(): ChangesetOps {
    return {
      async open(p): Promise<{ changeId: number } | StoreError> {
        const row: MemoryChangeset = {
          id: db.nextChangeId++,
          project,
          name: p.name,
          note: p.note ?? null,
          status: 'open',
          author_kind: p.authorKind ?? 'human',
          publish_at: null,
          created_at: now(),
          reverted_at: null,
        };
        db.changesets.push(row);
        return { changeId: row.id };
      },

      async list(q = {}): Promise<{ changes: ChangesetRow[]; nextBeforeId: number | null } | StoreError> {
        const limit = pageLimit(q.limit);
        const window = db.changesets
          .filter((c) => c.project === project)
          .filter((c) => q.status === undefined || c.status === q.status)
          .filter((c) => q.beforeId === undefined || c.id < q.beforeId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
        const changes = window.map(mapChangesetRow);
        return {
          changes,
          nextBeforeId: changes.length < limit ? null : (changes[changes.length - 1]?.id ?? null),
        };
      },

      async get(p): Promise<{ change: ChangesetRow; members: ChangeMember[] } | StoreError> {
        const found = changeOr(p.changeId);
        if ('storeError' in found) return found;
        // ONE read serving two consumers: the group-revert enumeration needs
        // the minted id and the before id, the change-before preview needs the
        // before value. Neither issues a second member query.
        const members: ChangeMember[] =
          found.status === 'published'
            ? mine()
                .filter((r) => r.changeset_id === p.changeId && r.state === 'published')
                .sort((a, b) => a.id - b.id)
                .map((minted) => {
                  const before = beforeOf(minted);
                  return {
                    key: minted.key,
                    locale: minted.locale,
                    versionId: minted.id,
                    beforeVersionId: before?.id ?? null,
                    // ABSENT, not null and not present-but-undefined, where
                    // there is no prior version: a first-publish member has no
                    // before VALUE at all, and the preview resolver reads the
                    // property's absence as "no override row for this key".
                    ...(before === undefined ? {} : { beforeValue: before.value }),
                  };
                })
            : membersOf(p.changeId).map((draft) => ({
                key: draft.key,
                locale: draft.locale,
                versionId: draft.id,
              }));
        return { change: mapChangesetRow(found), members };
      },

      async schedule(p): Promise<{ status: ChangesetStatus } | StoreError> {
        const found = openChangeOr(p.changeId);
        if ('storeError' in found) return found;
        const members = membersOf(p.changeId);
        // Stamping needs something to publish; the CANCEL arm carries no member
        // requirement, because the clock's demotion sweep cancels empty changes
        // by design.
        if (p.publishAt !== null && members.length === 0) {
          return mapError(noMembers(p.changeId));
        }
        // The change row first, then the member stamps — the pinned order. A
        // member attaching between the two statements inherits from the change
        // row, so the reverse order would let a cancelled change publish.
        found.status = p.publishAt === null ? 'open' : 'scheduled';
        found.publish_at = p.publishAt;
        for (const draft of members) draft.publish_at = p.publishAt;
        return { status: found.status };
      },

      async publishChange(p): Promise<{ published: { key: string; locale: string; versionId: number }[] } | StoreError> {
        const found = openChangeOr(p.changeId);
        if ('storeError' in found) return found;
        const members = membersOf(p.changeId);
        // An open change may hold zero members; publishing one may not.
        if (members.length === 0) return mapError(noMembers(p.changeId));

        // Staged, then applied: the SQL's one transaction is all-or-nothing, so
        // no partial state is observable there, and none is observable here.
        const published = members.map((draft) => ({
          key: draft.key,
          locale: draft.locale,
          versionId: draft.id,
        }));
        // The group flip KEEPS changeset_id — the minted rows are the group's
        // marker. Unifying this with the solo flip would silently break the
        // group revert.
        for (const draft of members) flip(draft, p.editor, true);
        found.status = 'published';
        found.publish_at = null;
        return { published };
      },

      async abandon(p): Promise<{ abandoned: true; droppedDrafts: number } | StoreError> {
        // A published change is never deleted: its row is the group revert's
        // and the before-preview's read.
        const found = openChangeOr(p.changeId);
        if ('storeError' in found) return found;
        const members = membersOf(p.changeId);
        // The drafts go FIRST, so a torn abandon leaves an empty open change —
        // harmless and re-abandonable — never drafts pointing at a deleted row.
        // No version history is lost, because drafts are not versions.
        for (const draft of members) db.rows.splice(db.rows.indexOf(draft), 1);
        db.changesets.splice(db.changesets.indexOf(found), 1);
        return { abandoned: true, droppedDrafts: members.length };
      },

      async discardDraft(p): Promise<{ discarded: number } | StoreError> {
        const locale = p.locale ?? 'default';
        const draft = draftOf(p.key, locale);
        // Unconditional and unattributed: the explicitness IS the protection,
        // and a delete leaves no row to record an editor on.
        if (!draft) return mapError(noDraft(p.key, locale));
        db.rows.splice(db.rows.indexOf(draft), 1);
        return { discarded: draft.id };
      },

      async markReverted(p): Promise<{ revertedAt: string } | StoreError> {
        const found = changeOr(p.changeId);
        if ('storeError' in found) return found;
        // An event record, not a claim over the site's current rows.
        found.reverted_at = now();
        return { revertedAt: found.reverted_at };
      },
    };
  }

  return store;
}

/** Newest first, cursor exclusive — the same order and cut the SQL adapters use. */
function page(
  rows: MemoryRow[],
  beforeId: number | undefined,
  limit: number | undefined,
): { rows: VersionRow[]; nextBeforeId: number | null } {
  const size = pageLimit(limit);
  const window = rows
    .filter((r) => beforeId === undefined || r.id < beforeId)
    .sort((a, b) => b.id - a.id)
    .slice(0, size);
  return mapPage(window, size);
}

function now(): string {
  return new Date().toISOString();
}

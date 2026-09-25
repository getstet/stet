/**
 * The cross-adapter contracts, implemented once: how a stored row reaches a
 * caller, what an RPC's answer is allowed to be, what a failure is called, and
 * how the save path's refusal is read back off the wire. Every adapter imports
 * them and adds transport only — `store-pg` receives the server's text over a
 * socket, `store-postgrest` over HTTP, and `store-memory` produces the same
 * text in process, so "what a row looks like", "what counts as a conflict" and
 * the exact words of a raise cannot fork three ways.
 *
 * `id` IS the version — identity and sort order both (§4) — so `VersionRow`
 * carries `id` and the inherited `version` as the same number; `id` is
 * canonical. Timestamps cross as ISO UTC, the one form every adapter agrees on.
 */

import { checkDeclaration } from '../src/contacts.js';
import type { StoreRow } from '../src/resolve.js';
import type {
  ChangesetRow,
  ChangesetStatus,
  ContactRecord,
  DraftRefusal,
  GroupDef,
  GroupProperty,
  GroupRow,
  GroupState,
  ImportOutcome,
  JoinResult,
  MemberRow,
  MembershipRow,
  SuppressionRow,
  NotSupported,
  StoreError,
  VersionRow,
} from '../src/store.js';
import type { Target } from '../src/types.js';

/** The columns every adapter selects, however its transport spells them. */
export interface SqlRow {
  id: number;
  key: string;
  locale: string;
  target: Target;
  state: 'draft' | 'published';
  is_active: boolean;
  value: unknown;
  publish_at: Date | string | null;
  editor: string | null;
  label: string | null;
  note: string | null;
  published_by: string | null;
  reverted_from: number | null;
  changeset_id: number | null;
  created_at: Date | string;
  published_at: Date | string | null;
}

/**
 * One RPC's answer: the server's own scalar, the save path's refusal, or the
 * failure that replaced both. The transports hand the parsed body over
 * unchanged — deciding what a body is allowed to be happens here, once.
 */
export type RpcAnswer = { body: unknown } | DraftRefusal | StoreError;

// ── The read mapping ────────────────────────────────────────────────────────

export function mapRow(r: SqlRow): StoreRow {
  return {
    key: r.key,
    locale: r.locale,
    status: r.state,
    is_active: r.is_active,
    value: r.value,
    version: r.id,
    // All three columns are already in every adapter's select. Carrying them on
    // the read row is what lets the scheduler enumerate due drafts AND split
    // them grouped/ungrouped, and the audit compare stored targets, through
    // this one read, with no second query surface anywhere.
    target: r.target,
    publishAt: r.publish_at === null ? null : iso(r.publish_at),
    changesetId: r.changeset_id,
  };
}

export function mapVersionRow(r: SqlRow): VersionRow {
  return {
    ...mapRow(r),
    id: r.id,
    editor: r.editor,
    label: r.label,
    note: r.note,
    target: r.target,
    publishAt: r.publish_at === null ? null : iso(r.publish_at),
    publishedBy: r.published_by,
    revertedFrom: r.reverted_from,
    changesetId: r.changeset_id,
    createdAt: iso(r.created_at),
    publishedAt: r.published_at === null ? null : iso(r.published_at),
  };
}

// ── The changeset row mapping ───────────────────────────────────────────────

/** The `changesets` columns every adapter selects, however its transport spells them. */
export interface ChangesetSqlRow {
  id: number;
  name: string;
  note: string | null;
  status: string;
  author_kind: string;
  publish_at: Date | string | null;
  created_at: Date | string;
  reverted_at: Date | string | null;
}

export function mapChangesetRow(r: ChangesetSqlRow): ChangesetRow {
  return {
    id: Number(r.id),
    name: r.name,
    note: r.note,
    status: r.status as ChangesetStatus,
    authorKind: r.author_kind as 'human' | 'agent',
    publishAt: r.publish_at === null ? null : iso(r.publish_at),
    createdAt: iso(r.created_at),
    revertedAt: r.reverted_at === null ? null : iso(r.reverted_at),
  };
}

// ── The contacts mapping ────────────────────────────────────────────────────
//
// Both SQL adapters call the same migration-3 functions and hand their answers
// here: a table function arrives as rows (timestamps as `Date` over `pg`, as
// strings over PostgREST), a jsonb function as one parsed object (timestamps
// already strings). The memory reference builds the same shapes directly.

/**
 * A declaration `addGroup` refuses before it writes, or null: `checkDeclaration`
 * is the one rule, and the CLI's `group add` applies it too. A malformed list
 * stored would answer every join after it with a check nobody declared.
 */
export function invalidDeclaration(properties: unknown): StoreError | null {
  const fault = checkDeclaration(properties);
  return fault === null ? null : mapError(`invalid group declaration — ${fault}`);
}

/** `stet_group_get`'s columns; `stet_group_list` adds `members`. */
export interface GroupDefSqlRow {
  key: string;
  name: string;
  state: string;
  properties: unknown;
  created_at: Date | string;
}

export interface GroupSqlRow extends GroupDefSqlRow {
  members: number | string;
}

export function mapGroupDef(r: GroupDefSqlRow): GroupDef {
  return {
    key: r.key,
    name: r.name,
    state: r.state as GroupState,
    properties: Array.isArray(r.properties) ? (r.properties as GroupProperty[]) : [],
    createdAt: iso(r.created_at),
  };
}

export function mapGroupRow(r: GroupSqlRow): GroupRow {
  // count(*) is a bigint; PostgREST sends it as a number, `pg` as a number
  // through the pool's int8 parser.
  return { ...mapGroupDef(r), members: Number(r.members) };
}

/** A membership's columns, as the members read and the contact record both carry them. */
interface MembershipSqlRow {
  id: number;
  joined_at: Date | string;
  form: string | null;
  page: string | null;
  properties: unknown;
  updated_at: Date | string;
}

/** `stet_group_members`' columns. */
export interface MemberSqlRow extends MembershipSqlRow {
  contact_id: number;
  email: string;
  suppressed: boolean;
  /** Not a column of the members read: the one group they were read from. */
  group?: string;
}

/** One membership, the consent evidence, in the one shape every read answers it in. */
function mapMembership(m: MembershipSqlRow, group: string): MembershipRow {
  return {
    id: Number(m.id),
    group,
    joinedAt: iso(m.joined_at),
    form: m.form,
    page: m.page,
    properties: stringsOf(m.properties),
    updatedAt: iso(m.updated_at),
  };
}

export function mapMemberRow(r: MemberSqlRow, group: string): MemberRow {
  return { ...mapMembership(r, group), contactId: Number(r.contact_id), email: r.email, suppressed: r.suppressed === true };
}

/** One members page. The cursor for the next is the last id, or null once the page came up short. */
export function memberPage(rows: MemberSqlRow[], group: string, limit: number): { rows: MemberRow[]; nextAfterId: number | null } {
  const page = rows.map((r) => mapMemberRow(r, group));
  return { rows: page, nextAfterId: page.length < limit ? null : (page[page.length - 1]?.id ?? null) };
}

/** `stet_contact_record`'s object, or null when nothing is held. */
export function mapContactRecord(body: unknown): { record: ContactRecord | null } | StoreError {
  if (body === null || body === '') return { record: null };
  if (typeof body !== 'object' || Array.isArray(body)) return mapError(`unexpected contact record: ${JSON.stringify(body)}`);
  const b = body as {
    email: string;
    contact: { id: number; properties: unknown; created_at: string; updated_at: string } | null;
    memberships: (MembershipSqlRow & { group: string })[];
    suppressions: { scope: string; source: string; created_at: string }[];
  };
  const memberships = (b.memberships ?? []).map((m) => mapMembership(m, m.group));
  const suppressions: SuppressionRow[] = (b.suppressions ?? []).map((x) => ({
    scope: x.scope as SuppressionRow['scope'],
    source: x.source,
    createdAt: iso(x.created_at),
  }));
  return {
    record: {
      email: b.email,
      contact:
        b.contact === null
          ? null
          : {
              id: Number(b.contact.id),
              properties: (b.contact.properties ?? {}) as Record<string, unknown>,
              createdAt: iso(b.contact.created_at),
              updatedAt: iso(b.contact.updated_at),
            },
      memberships,
      suppressions,
    },
  };
}

/** `stet_join_group`'s object. */
export function asJoin(answer: RpcAnswer): JoinResult | StoreError {
  const checked = expectNoRefusal(answer, 'contacts.join');
  if (!('body' in checked)) return checked;
  const b = checked.body as
    | { contact_id?: unknown; is_new?: unknown; suppressed?: unknown; joined_at?: unknown; form?: unknown; page?: unknown }
    | null;
  if (b === null || typeof b !== 'object' || typeof b.is_new !== 'boolean' || typeof b.joined_at !== 'string') {
    return mapError(`unexpected RPC answer: ${JSON.stringify(checked.body)}`);
  }
  return {
    contactId: Number(b.contact_id),
    isNew: b.is_new,
    suppressed: b.suppressed === true,
    joinedAt: iso(b.joined_at),
    form: typeof b.form === 'string' ? b.form : null,
    page: typeof b.page === 'string' ? b.page : null,
  };
}

const OUTCOMES: readonly ImportOutcome[] = ['joined', 'present', 'erased', 'suppressed'];

/** `stet_import_member`'s one word. */
export function asImportOutcome(answer: RpcAnswer): { outcome: ImportOutcome } | StoreError {
  const checked = expectNoRefusal(answer, 'contacts.importMember');
  if (!('body' in checked)) return checked;
  return (OUTCOMES as readonly unknown[]).includes(checked.body)
    ? { outcome: checked.body as ImportOutcome }
    : mapError(`unexpected RPC answer: ${JSON.stringify(checked.body)}`);
}

/** `stet_erase_contact`'s object. */
export function asErased(answer: RpcAnswer): { existed: boolean; memberships: number } | StoreError {
  const checked = expectNoRefusal(answer, 'contacts.erase');
  if (!('body' in checked)) return checked;
  const b = checked.body as { existed?: unknown; memberships?: unknown } | null;
  return b !== null && typeof b === 'object' && typeof b.existed === 'boolean'
    ? { existed: b.existed, memberships: Number(b.memberships) }
    : mapError(`unexpected RPC answer: ${JSON.stringify(checked.body)}`);
}

/** A void RPC's answer (`stet_group_add`, `stet_group_state`). */
export function asVoid(answer: RpcAnswer, method: string): true | StoreError {
  const checked = expectNoRefusal(answer, method);
  if (!('body' in checked)) return checked;
  return checked.body === null || checked.body === '' ? true : mapError(`unexpected RPC answer: ${JSON.stringify(checked.body)}`);
}

/** A stored answers object, narrowed to its string members — the only kind a join stores. */
function stringsOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

function iso(at: Date | string): string {
  return at instanceof Date ? at.toISOString() : new Date(at).toISOString();
}

// ── The install-time metadata row ───────────────────────────────────────────
//
// `stet_meta` is one row (id = 1) recording what version of stet wrote this
// database. Two adapters read it and two write it, so the shape and its
// mapping live here rather than in either.

/** The row a `stet_meta` read hands back, in the caller's vocabulary. */
export interface StetMeta {
  schemaVersion: number;
  descriptorVersion: string;
}

/** The columns both transports select from `stet_meta`. */
export interface StetMetaRow {
  schema_version: number;
  descriptor_version: string;
}

export function mapStetMetaRow(row: StetMetaRow): StetMeta {
  return {
    schemaVersion: Number(row.schema_version),
    // Migration 1 stamps '' — not yet stamped, which `upgrade` and `seed` fix.
    descriptorVersion: String(row.descriptor_version ?? ''),
  };
}

// ── Telling the four answers apart ──────────────────────────────────────────
//
// Every caller that is not the adapter itself — the conformance suite, the
// CLI's write commands — has to distinguish a success from a refusal, a
// missing capability and a failure. One implementation of each, here, beside
// the vocabulary they belong to.

export function isStoreError(answer: unknown): answer is StoreError {
  return typeof answer === 'object' && answer !== null && 'storeError' in answer;
}

export function isRefusal(answer: unknown): answer is DraftRefusal {
  return typeof answer === 'object' && answer !== null && 'refused' in answer;
}

export function isNotSupported(answer: unknown): answer is NotSupported {
  return typeof answer === 'object' && answer !== null && 'notSupported' in answer;
}

/** The read paths' shape of the same question: the rows, or what replaced them. */
export function isError<T>(rows: T[] | StoreError): rows is StoreError {
  return isStoreError(rows);
}

// ── Keyset paging ───────────────────────────────────────────────────────────
//
// Order by `id` desc, `beforeId` exclusive, never an offset: rows inserted
// between two page reads can then neither duplicate nor hide a row at the
// boundary. The cap is the kind of number three transports drift on.

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

export function pageLimit(limit?: number): number {
  // A NaN reaching the wire as `limit=NaN` is a page nobody asked for.
  if (limit === undefined || !Number.isFinite(limit)) return PAGE_DEFAULT;
  return Math.min(Math.max(1, Math.floor(limit)), PAGE_MAX);
}

/** One page of history, already cut to `limit` by whatever fetched it. */
export function mapPage(
  rows: SqlRow[],
  limit: number,
): { rows: VersionRow[]; nextBeforeId: number | null } {
  const page = rows.map(mapVersionRow);
  // The cursor for the next page, or null once the page came up short.
  const nextBeforeId = page.length < limit ? null : (page[page.length - 1]?.id ?? null);
  return { rows: page, nextBeforeId };
}

// ── PostgREST filter quoting ────────────────────────────────────────────────

/**
 * An equality filter. PostgREST reads everything after `eq.` as the value,
 * verbatim — a double quote there is a character of the value, never a
 * delimiter (PostgREST 12.2.3 and 16.4, executed: a quoted value matched no
 * row, the bare value matched for a comma, a dot, a colon, parentheses, a
 * quote, a backslash, a space, `%` and `&`). So the value goes bare, and the
 * caller's `URLSearchParams` percent-encodes it.
 */
export function eqFilter(value: string): string {
  return `eq.${value}`;
}

/**
 * One value inside an `in.(…)` list, where commas and parentheses ARE syntax:
 * backslashes double first, quotes escape second, and the value is wrapped in
 * double quotes, which PostgREST parses inside a list.
 */
export function listValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── The conflict vocabulary ─────────────────────────────────────────────────
//
// The exact text the SQL raises and the memory reference mimics, written once.
// The prefix table is derived from the same markers, so no adapter can classify
// a message no raise produces, and no raise can carry a marker the table has
// never heard of.

const MARKERS = {
  noDraft: 'no_draft:',
  concurrentSave: 'concurrent_save:',
  publishConflict: 'publish_conflict:',
  targetOccupied: 'target_occupied:',
  noVersion: 'no_version:',
  notPublished: 'not_published:',
  wrongProject: 'wrong_project:',
  noChange: 'no_change:',
  changeClosed: 'change_closed:',
  noMembers: 'no_members:',
  staleActive: 'stale_active:',
  groupedSchedule: 'grouped_schedule:',
  unknownGroup: 'unknown_group:',
  groupClosed: 'group_closed:',
  groupExists: 'group_exists:',
} as const;

/** Publish found nothing to publish. */
export function noDraft(key: string, locale: string): string {
  return `${MARKERS.noDraft}${key} (${locale})`;
}

/** Two first-saves raced onto the one-draft index. Never retried. */
export function concurrentSave(key: string): string {
  return `${MARKERS.concurrentSave}${key}`;
}

/** A concurrent write minted this key's active row first; nothing was consumed. */
export function publishConflict(key: string): string {
  return `${MARKERS.publishConflict}${key}`;
}

/** Rename onto a key that already has rows: merging histories is not a thing rename does. */
export function targetOccupied(newKey: string): string {
  return `${MARKERS.targetOccupied}${newKey}`;
}

/** Revert of a version id that is not there at all. */
export function noVersion(versionId: number): string {
  return `${MARKERS.noVersion}${versionId}`;
}

/** Revert of a draft: only published rows are history. */
export function notPublished(versionId: number): string {
  return `${MARKERS.notPublished}${versionId}`;
}

/** Version ids are global; revert is the one write that would otherwise cross projects. */
export function wrongProject(project: string, versionId: number, sourceProject: string): string {
  return `${MARKERS.wrongProject}${project} (version ${versionId} belongs to project ${sourceProject})`;
}

/** The same marker, change-shaped: a change id is as global as a version id. */
export function wrongProjectChange(project: string, changeId: number, sourceProject: string): string {
  return `${MARKERS.wrongProject}${project} (change ${changeId} belongs to project ${sourceProject})`;
}

/** A change id naming nothing. Ids start at 1, so 0 and negatives land here. */
export function noChange(changeId: number): string {
  return `${MARKERS.noChange}${changeId}`;
}

/** The change is published: it takes no members, no schedule and no second publish. */
export function changeClosed(changeId: number): string {
  return `${MARKERS.changeClosed}${changeId}`;
}

/** Publishing or stamping a change with nothing in it — the demotion sweep's food. */
export function noMembers(changeId: number): string {
  return `${MARKERS.noMembers}${changeId}`;
}

/** The group revert's guard: this key's active row has moved since the group published. */
export function staleActive(key: string, expected: number): string {
  return `${MARKERS.staleActive}${key} (expected active ${expected}, it has moved)`;
}

/** A grouped draft's schedule is the change's alone — a member never carries its own. */
export function groupedSchedule(key: string): string {
  return `${MARKERS.groupedSchedule}${key}`;
}

/** A join or import naming no group of this project. */
export function unknownGroup(key: string): string {
  return `${MARKERS.unknownGroup}${key}`;
}

/** A join to a group that is not open. */
export function groupClosed(key: string): string {
  return `${MARKERS.groupClosed}${key}`;
}

/** `group add` over a key this project already has. */
export function groupExists(key: string): string {
  return `${MARKERS.groupExists}${key}`;
}

/** Which contacts marker a conflict carries, if any — the forms handler's status table reads it. */
export function contactsMarker(error: StoreError): 'unknown_group' | 'group_closed' | 'group_exists' | null {
  if (error.code !== 'conflict') return null;
  if (error.message.startsWith(MARKERS.unknownGroup)) return 'unknown_group';
  if (error.message.startsWith(MARKERS.groupClosed)) return 'group_closed';
  if (error.message.startsWith(MARKERS.groupExists)) return 'group_exists';
  return null;
}

// Derived from the markers, so a new raise is classified as a `conflict` with
// no edit here: the table cannot name a marker no raise produces, and no raise
// can carry a marker the table has never heard of.
const CONFLICTS: readonly string[] = Object.values(MARKERS);

// ── Failures → answers ──────────────────────────────────────────────────────

const REFUSAL_PREFIX = 'draft_held:';

/** What a transport knows about a failure beside its message. */
export interface RaiseContext {
  /** The server's SQLSTATE, where the transport carries one. */
  sqlstate?: string;
  /** Everything else the server reported — PostgREST's code, hint and details. */
  detail?: string;
}

/**
 * The code table, in one implementation. A `string` is text the server raised —
 * a conflict if the marker table names it, `unknown` otherwise. Anything else is
 * a transport failure the server never answered: `unreachable`, which callers
 * treat as an absence and resolve from the committed snapshot. A SQLSTATE of
 * class 08 (connection exception) or 57 (operator intervention — a shutdown
 * mid-deploy) is unreachable whatever its text says, so it is read before the
 * table. The raw server text rides along in every case.
 */
export function mapError(cause: unknown, ctx: RaiseContext = {}): StoreError {
  const message = withDetail(describe(cause), ctx.detail);
  if (unreachableState(ctx.sqlstate) || typeof cause !== 'string') {
    return { storeError: true, code: 'unreachable', message };
  }
  const code = CONFLICTS.some((marker) => cause.startsWith(marker)) ? 'conflict' : 'unknown';
  return { storeError: true, code, message };
}

function unreachableState(sqlstate: string | undefined): boolean {
  return sqlstate !== undefined && (sqlstate.startsWith('08') || sqlstate.startsWith('57'));
}

function withDetail(message: string, detail: string | undefined): string {
  return detail === undefined || detail === '' ? message : `${message} — ${detail}`;
}

/**
 * The refusal, built in one place. `store-pg` and `store-postgrest` reach it by
 * parsing the raise; `store-memory` has no message to parse and calls it
 * directly with the same two fields.
 */
export function refusal(incumbentEditor: string, heldSince: string): DraftRefusal {
  return { refused: true, incumbentEditor, heldSince };
}

/**
 * The save path's refusal, or null if this message is not one. The RPC raises
 * `draft_held:` followed by ONE JSON object, and the remainder after the FIRST
 * colon is parsed whole — never split on every colon, since editors like
 * `agent:claude` and ISO timestamps both contain them. Malformed JSON after the
 * prefix is not a refusal: it falls through to the error mapping rather than
 * inventing an incumbent.
 */
export function parseRefusal(message: string): DraftRefusal | null {
  if (!message.startsWith(REFUSAL_PREFIX)) return null;
  const payload = message.slice(message.indexOf(':') + 1);
  try {
    const parsed = JSON.parse(payload) as { editor?: unknown; heldSince?: unknown };
    if (typeof parsed.editor !== 'string' || typeof parsed.heldSince !== 'string') return null;
    return refusal(parsed.editor, parsed.heldSince);
  } catch {
    return null;
  }
}

/**
 * A raised message → a refusal if it is one, otherwise the code table's verdict.
 * The refusal is read from the message alone: a transport's decoration is
 * appended to failures, never to the JSON payload a refusal parses.
 */
export function mapRaise(message: string, ctx: RaiseContext = {}): DraftRefusal | StoreError {
  return parseRefusal(message) ?? mapError(message, ctx);
}

/**
 * Only the save path can be refused. A refusal arriving anywhere else is a bug
 * in the mapping, reported as one rather than swallowed.
 */
export function expectNoRefusal<T>(answer: T | DraftRefusal, method: string): T | StoreError {
  return isRefusal(answer) ? mapError(`unexpected draft refusal from ${method}`) : answer;
}

// ── An RPC's answer → the caller's result ───────────────────────────────────
//
// The transports hand the body over exactly as the server sent it. A missing or
// non-numeric body is a broken contract and says so: coercing it to an id would
// hand the caller a version that does not exist.

export function asVersion(answer: RpcAnswer, method: string): { versionId: number } | StoreError {
  const checked = expectNoRefusal(answer, method);
  if (!('body' in checked)) return checked;
  const id = asId(checked.body);
  return typeof id === 'number' ? { versionId: id } : id;
}

export function asDraft(answer: RpcAnswer): { draftId: number } | DraftRefusal | StoreError {
  if (!('body' in answer)) return answer;
  const id = asId(answer.body);
  return typeof id === 'number' ? { draftId: id } : id;
}

/**
 * A void RPC answers with nothing: PostgREST returns 204 with an empty body,
 * `pg` a null column. Anything else means the call did not do what it says.
 */
export function asRenamed(answer: RpcAnswer, method: string): { renamed: true } | StoreError {
  const checked = expectNoRefusal(answer, method);
  if (!('body' in checked)) return checked;
  const body = checked.body;
  return body === null || body === ''
    ? { renamed: true }
    : mapError(`unexpected RPC answer: ${JSON.stringify(body)}`);
}

function asId(body: unknown): number | StoreError {
  return typeof body === 'number' ? body : mapError(`unexpected RPC answer: ${JSON.stringify(body)}`);
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : JSON.stringify(cause);
}

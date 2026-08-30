/**
 * The store contract: one normative interface every adapter implements, and the
 * three tagged results that make a missing capability, a refusal and a transport
 * failure distinguishable without exceptions.
 *
 * Types only — the transports live in `adapters/`. Expected outcomes are
 * RETURNED, never thrown: an adapter throws on a bug in itself, not on anything
 * a caller could have caused.
 */

import type { StoreRow } from './resolve.js';
import type { Target } from './types.js';

/**
 * The honest answer of an adapter that cannot do this at all — never a fake
 * success, never a silent no-op. The snapshot adapter's whole write half is
 * `NotSupported`, and a surface reading it renders the project read-only.
 */
export type NotSupported = { readonly notSupported: true; readonly method: string };

/**
 * A transport or server failure. `unreachable` is an absence: resolution falls
 * back to the committed snapshot and the surface still renders complete.
 */
export type StoreError = {
  readonly storeError: true;
  readonly code: 'unreachable' | 'conflict' | 'unknown';
  readonly message: string;
};

/**
 * The save path's refusal: this key's draft belongs to someone else. The draft
 * is the one mutable row and nothing overwrites it implicitly — the caller
 * shows the incumbent and re-saves with `force`, or reports the proposal.
 */
export type DraftRefusal = {
  readonly refused: true;
  readonly incumbentEditor: string;
  readonly heldSince: string; // ISO UTC — the incumbent draft's created_at
};

/**
 * A history row. `id` is the version — identity and sort order both — so `id`
 * and the inherited `version` are always equal; `id` is canonical.
 *
 * Authorship is two facts, never one: `editor` is who wrote the wording and
 * survives publish, `publishedBy` is who made it live. Everything a save
 * accepts reads back here — a field a caller can set and never see again is a
 * field no test can prove.
 */
export interface VersionRow extends StoreRow {
  id: number;
  editor: string | null;
  label: string | null;
  note: string | null;
  target: Target;
  publishAt: string | null;      // the schedule stamp — readable, not write-only
  publishedBy: string | null;    // who made it live; editor keeps the draft author
  revertedFrom: number | null;   // set by revert: the version id this row restored
  /** The change this row belongs to; null when ungrouped. Required here — a
   * mapping that forgets it fails to compile rather than dropping it silently. */
  changesetId: number | null;
  createdAt: string;
  publishedAt: string | null;
}

/**
 * The draft row is the full draft state, not a patch: an omitted `label` or
 * `note` clears a previously set one. `target` is passed from the descriptor,
 * which stays authoritative for shape.
 */
export interface SaveDraftParams {
  key: string;
  value: unknown;
  target: Target;
  editor: string;
  locale?: string;
  label?: string;
  note?: string;
  publishAt?: string; // → p_publish_at
  force?: boolean;    // → p_force
  /**
   * → `p_change`: `undefined` leaves the draft's membership alone (an autosave
   * never silently detaches a member), `null` detaches it, an id attaches it.
   * The changesets capability owns the semantics; this is the ref.
   */
  change?: number | null;
}

// ── The changesets capability ───────────────────────────────────────────────
//
// An opt-in grouping of drafts, BESIDE the seven methods rather than inside
// them (§13.6 C): the block is a non-function property, so the interface's
// method list is still exactly the seven. An adapter that cannot group answers
// `NotSupported` from every method here, exactly as its write half does — an
// answer, never an absence, so a surface can render the affordance honestly
// disabled rather than guess.

export type ChangesetStatus = 'open' | 'scheduled' | 'published';

export interface ChangesetRow {
  id: number;
  name: string;
  note: string | null;
  status: ChangesetStatus;
  authorKind: 'human' | 'agent';
  publishAt: string | null;
  createdAt: string;
  revertedAt: string | null;
}

export interface ChangeMember {
  key: string;
  locale: string;
  /** open/scheduled: the member's draft id. published: the minted row's id. */
  versionId: number;
  /** published changes only: the version this member replaced, and its value. */
  beforeVersionId?: number | null;
  beforeValue?: unknown;
}

export interface ChangesetOps {
  open(p: { name: string; note?: string; authorKind?: 'human' | 'agent' }): Promise<{ changeId: number } | NotSupported | StoreError>;
  list(q?: { status?: ChangesetStatus; beforeId?: number; limit?: number }): Promise<{ changes: ChangesetRow[]; nextBeforeId: number | null } | NotSupported | StoreError>;
  get(p: { changeId: number }): Promise<{ change: ChangesetRow; members: ChangeMember[] } | NotSupported | StoreError>;
  schedule(p: { changeId: number; publishAt: string | null }): Promise<{ status: ChangesetStatus } | NotSupported | StoreError>;
  publishChange(p: { changeId: number; editor: string }): Promise<{ published: { key: string; locale: string; versionId: number }[] } | NotSupported | StoreError>;
  abandon(p: { changeId: number }): Promise<{ abandoned: true; droppedDrafts: number } | NotSupported | StoreError>;
  discardDraft(p: { key: string; locale?: string }): Promise<{ discarded: number } | NotSupported | StoreError>;
  markReverted(p: { changeId: number }): Promise<{ revertedAt: string } | NotSupported | StoreError>;
}

/**
 * `read` returns the store's rows, never resolved values: resolution is
 * `resolve()`'s one code path across every adapter. Drafts come back only under
 * `preview`. `history` and `recent` are published-only, ordered by `id desc`,
 * keyset-paged (`beforeId` exclusive) — never by timestamp, never by offset.
 *
 * No method takes a version id plus a replacement value: published rows are
 * immutable through this interface, and no write is ever retried by an adapter.
 */
export interface StoreAdapter {
  readonly project: string;      // fixed at construction — every read scopes to it, every write passes it
  readonly canApplyDDL: boolean;
  /**
   * The changesets capability — an object BESIDE the seven methods, never an
   * eighth method. Required, so no adapter can ship without an answer: the
   * snapshot adapter's block returns `NotSupported` from every method.
   */
  readonly changesets: ChangesetOps;
  read(q?: { keys?: string[]; locale?: string; preview?: boolean }): Promise<StoreRow[] | StoreError>;
  saveDraft(p: SaveDraftParams): Promise<{ draftId: number } | DraftRefusal | NotSupported | StoreError>;
  publish(p: { key: string; editor: string; locale?: string }): Promise<{ versionId: number } | NotSupported | StoreError>;
  /**
   * `expectActive` is the group revert's fail-safe guard (→ `p_expect_active`):
   * when set, the deactivating update requires that id, so a member whose
   * active row has moved is refused INSIDE the write rather than by a
   * caller-side check a concurrent publish could slip past. Omitted is
   * unguarded, which is what every per-key caller means.
   */
  revert(p: { versionId: number; editor: string; expectActive?: number }): Promise<{ versionId: number } | NotSupported | StoreError>;
  rename(p: { oldKey: string; newKey: string; editor: string }): Promise<{ renamed: true } | NotSupported | StoreError>;
  history(q: { key: string; locale?: string; beforeId?: number; limit?: number }): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | NotSupported | StoreError>;
  recent(q?: { beforeId?: number; limit?: number }): Promise<{ rows: VersionRow[]; nextBeforeId: number | null } | NotSupported | StoreError>;
}

/**
 * The group revert: ONE enumeration over the public store interface, shared by
 * every adapter and every surface that offers the action (the mount's
 * `revert-change` route now, the editor's preview-first confirmed revert
 * later). A per-adapter or per-surface re-implementation is exactly the drift
 * this file exists to forbid.
 *
 * It is deliberately NOT an RPC and NOT atomic. §6.1 defines the group revert
 * as fail-safe PER MEMBER: a member whose active row has moved since the group
 * published is refused inside the revert write and reported, while every other
 * member restores. Atomicity would be the wrong contract — one stale member
 * would block the rest from being put back.
 *
 * Re-running a torn revert is safe by construction: every member already
 * restored has a new active row, so its guard refuses on the second pass and it
 * is reported as skipped, while the stamp still lands.
 */

import type { NotSupported, StoreAdapter, StoreError } from '../src/store.js';
import { changeClosed, isNotSupported, isStoreError, mapError } from './store-shared.js';

/** Why a member was not restored. Both are reported, never silently dropped. */
export type SkipReason = 'stale_active' | 'no_prior_version';

export interface RevertChangeResult {
  reverted: { key: string; locale: string; versionId: number }[];
  skipped: { key: string; locale: string; reason: SkipReason }[];
}

export async function revertChange(
  store: StoreAdapter,
  p: { changeId: number; editor: string },
): Promise<RevertChangeResult | NotSupported | StoreError> {
  const found = await store.changesets.get({ changeId: p.changeId });
  if (isNotSupported(found) || isStoreError(found)) return found;

  // Only a published change has a before-state to restore to: an open change's
  // members are drafts, which were never live. Built from the shared marker so
  // callers get the one refusal vocabulary rather than a second phrasing.
  if (found.change.status !== 'published') return mapError(changeClosed(p.changeId));

  const reverted: RevertChangeResult['reverted'] = [];
  const skipped: RevertChangeResult['skipped'] = [];

  for (const member of found.members) {
    // There is no un-publish: zero active versions is unrepresentable, so a
    // member whose group publish was its key's FIRST published version has no
    // write to make. Skipped and reported, never a failed write.
    if (member.beforeVersionId === undefined || member.beforeVersionId === null) {
      skipped.push({ key: member.key, locale: member.locale, reason: 'no_prior_version' });
      continue;
    }
    const answer = await store.revert({
      versionId: member.beforeVersionId,
      editor: p.editor,
      // The minted row is what this member's revert expects to still be live.
      // The guard rides INSIDE the write, so a concurrent publish cannot slip
      // between a caller-side check and the update.
      expectActive: member.versionId,
    });
    if (isNotSupported(answer)) return answer;
    if (isStoreError(answer)) {
      // A stale member is a skip; anything else is a transport or server
      // failure, and walking on would report a partial revert as a whole one.
      if (isStale(answer)) {
        skipped.push({ key: member.key, locale: member.locale, reason: 'stale_active' });
        continue;
      }
      return answer;
    }
    reverted.push({ key: member.key, locale: member.locale, versionId: answer.versionId });
  }

  // The group event record — not a claim over the site's current rows, which is
  // why it lands even when every member was skipped.
  const stamped = await store.changesets.markReverted({ changeId: p.changeId });
  if (isNotSupported(stamped) || isStoreError(stamped)) return stamped;

  return { reverted, skipped };
}

function isStale(error: StoreError): boolean {
  return error.code === 'conflict' && error.message.startsWith('stale_active:');
}

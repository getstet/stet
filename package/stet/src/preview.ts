import type { Resolution, ResolveQuery, StoreRow } from './resolve.js';
import { resolve } from './resolve.js';
import type { Snapshot } from './snapshot.js';
import type { Descriptor } from './types.js';

/**
 * The preview seam: the three states a preview can name and the resolver that
 * renders one. The signed token that names a state is `preview-token.ts`,
 * which ships on `@getstet/stet/server`.
 *
 * The surfaces belong to `add-editor` — its signed-preview route (verify, then
 * resolve, then `X-Robots-Tag: noindex`) and its token issuance at draft-save.
 * This file ships the contract they consume and no route of its own. The
 * change-before override rows come from the store's changesets capability:
 * `changesets.get` returns each member's `beforeValue` on the same read the
 * group revert uses.
 *
 * Pure, like the rest of `src/`, and free of builtins: the root entry's
 * closure runs through this file.
 */

/** The three states a token can name. An open change's drafts-layered preview
 * composes from `resolvePreview` directly — its override rows are the member
 * drafts — so it needs no fourth state. */
export type PreviewState =
  | { kind: 'draft'; key: string; locale?: string }
  | { kind: 'version'; key: string; versionId: number }
  | { kind: 'change-before'; changeId: number };

/**
 * A preview state resolved as per-key overrides layered over the ordinary read:
 * the masked keys lose their base rows, the override rows take their place, and
 * `resolve` does the rest — the locale chain, derivation, quarantine and
 * warnings all arrive unchanged, because this is the one resolution path and
 * not a second one.
 *
 * The masked set is the UNION of the override rows' own identities and the
 * supplied `keys` pairs — a union, never a replacement: an override row left
 * out of `keys` still masks the identity it overrides, so it can never lose to
 * the live row on version and leave the preview showing current copy.
 *
 * Masking is per (key, locale), never key-wide. A change that touches the
 * `default` locale of a key says nothing about that key's `de` row, and blanking
 * it would serve the German page an English before-value.
 *
 * Passing the full pair set matters for a change-before preview: a member
 * published for the FIRST time in that change has no before-version, so it
 * contributes no override row — yet its identity must still be masked, or the
 * preview would render the post-change value it exists to show the site
 * without. Masked with no override, it resolves as it did before the change:
 * from the snapshot. The draft and version states pass rows alone and the set
 * derives itself.
 *
 * Override rows are layered as ACTIVE rows whatever they were stored as, so a
 * draft override renders without the caller having to ask for a preview read.
 */
export function resolvePreview(
  d: Descriptor,
  s: Snapshot,
  rows: StoreRow[] | null,
  overrides: { rows: StoreRow[]; keys?: { key: string; locale: string }[] },
  q: ResolveQuery,
): Resolution {
  const masked = new Set<string>();
  for (const row of overrides.rows) masked.add(identity(row));
  for (const pair of overrides.keys ?? []) masked.add(identity(pair));

  const base = (rows ?? []).filter((row) => !masked.has(identity(row)));
  const layered = overrides.rows.map((row) => ({
    ...row,
    status: 'published' as const,
    is_active: true,
  }));
  return resolve(d, s, [...base, ...layered], q);
}

/** The masking identity of a row or a member pair. Serialized rather than
 * joined on a separator, so no key or locale containing the separator can
 * collide with another pair. */
function identity(r: { key: string; locale: string }): string {
  return JSON.stringify([r.key, r.locale]);
}

/**
 * The pages a change touches: the deduped union of its members' declared
 * `pages`, first-seen order, derived at read time and never stored — dropping a
 * member shrinks the span with nothing to reconcile. A key that declares no page
 * (an email or telegram slot) contributes nothing, and neither does a member
 * whose key has left the descriptor, so an all-pageless change spans nothing at
 * all. The consumers are add-editor's editing panel, review card and preview
 * navigation; an empty span is theirs to render as "none" and preview per field.
 */
export function pageSpan(d: Descriptor, memberKeys: string[]): string[] {
  const span: string[] = [];
  for (const key of memberKeys) {
    const def = Object.hasOwn(d.keys, key) ? d.keys[key] : undefined;
    for (const page of def?.pages ?? []) {
      if (!span.includes(page)) span.push(page);
    }
  }
  return span;
}

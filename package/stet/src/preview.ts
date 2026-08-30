import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Resolution, ResolveQuery, StoreRow } from './resolve.js';
import { resolve } from './resolve.js';
import type { Snapshot } from './snapshot.js';
import type { Descriptor } from './types.js';

/**
 * The preview seam: the three states a preview can name, the signed token that
 * names one, and the resolver that renders it.
 *
 * The surfaces belong to `add-editor` — its signed-preview route (verify, then
 * resolve, then `X-Robots-Tag: noindex`) and its token issuance at draft-save.
 * This file ships the contract they consume and no route of its own. The
 * change-before override rows come from the store's changesets capability:
 * `changesets.get` returns each member's `beforeValue` on the same read the
 * group revert uses.
 *
 * Pure, like the rest of `src/`: the clock is a parameter on both token
 * functions, so the same inputs always give the same token and the same
 * verdict. `node:crypto` is the one permitted builtin.
 */

/** The three states a token can name. An open change's drafts-layered preview
 * composes from `resolvePreview` directly — its override rows are the member
 * drafts — so it needs no fourth state. */
export type PreviewState =
  | { kind: 'draft'; key: string; locale?: string }
  | { kind: 'version'; key: string; versionId: number }
  | { kind: 'change-before'; changeId: number };

const DAY_MS = 24 * 60 * 60 * 1000;

interface Payload {
  s: PreviewState;
  exp: number;
}

/**
 * A token naming one state, signed for `secret` and expiring `ttlMs` after
 * `now`: base64url(payload JSON) + `.` + base64url(HMAC-SHA256 of that same
 * base64url text). The signature covers the ENCODED payload rather than the
 * JSON, so verification never has to re-serialize — a second serializer would
 * be a second chance to disagree about key order.
 *
 * An empty secret throws. HMAC accepts an empty key perfectly happily, so an
 * unset environment variable arriving as `''` would otherwise mint tokens
 * anyone can forge, and mint them silently. The mint is the caller's own code
 * path, where a throw is a bug report; verification takes the attacker's path
 * and refuses instead.
 */
export function mintPreviewToken(
  state: PreviewState,
  secret: string,
  now: number,
  ttlMs = DAY_MS,
): string {
  if (secret === '') {
    throw new Error(
      'a preview token cannot be signed with an empty secret — the signing key is unset, and an ' +
        'empty HMAC key would sign tokens anyone could forge',
    );
  }
  const payload: Payload = { s: state, exp: now + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * The state a token names, or `null` — expired, tampered, minted under another
 * secret, or malformed in any way. Never throws: this runs on an attacker-shaped
 * request, and a thrown parse error would be a 500 where a 404 belongs.
 *
 * The signature is checked BEFORE the payload is read, so nothing downstream
 * ever sees an unverified state, and the compare is constant-time with a byte
 * length guard — the mount's posture, for the same reason.
 *
 * A token is live while `now` is below `exp`; at exactly `exp` it has expired.
 * A non-finite `now` expires everything: `NaN >= exp` is false, so a clock that
 * arrived as `NaN` would otherwise make every token immortal.
 *
 * An empty secret verifies nothing, for the reason the mint throws on one.
 */
export function verifyPreviewToken(token: string, secret: string, now: number): PreviewState | null {
  if (secret === '') return null;
  try {
    const dot = token.indexOf('.');
    if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
    const body = token.slice(0, dot);
    if (!sameSignature(token.slice(dot + 1), sign(body, secret))) return null;

    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!isPayload(payload)) return null;
    if (!Number.isFinite(now) || now >= payload.exp) return null;
    return payload.s;
  } catch {
    return null;
  }
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

function sameSignature(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function isPayload(v: unknown): v is Payload {
  if (typeof v !== 'object' || v === null) return false;
  const { s, exp } = v as { s?: unknown; exp?: unknown };
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  if (typeof s !== 'object' || s === null) return false;
  const state = s as { kind?: unknown; key?: unknown; locale?: unknown; versionId?: unknown; changeId?: unknown };
  if (state.kind === 'draft') {
    return typeof state.key === 'string' && (state.locale === undefined || typeof state.locale === 'string');
  }
  if (state.kind === 'version') {
    return typeof state.key === 'string' && typeof state.versionId === 'number';
  }
  if (state.kind === 'change-before') return typeof state.changeId === 'number';
  return false;
}

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

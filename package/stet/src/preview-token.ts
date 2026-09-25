import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PreviewState } from './preview.js';

/**
 * The token half of the preview seam: the signed token that names one preview
 * state, minted and verified here. It is the one signature in `src/`, and the
 * crypto builtin is here by design — this module ships on
 * `@getstet/stet/server`, the layer that holds the signing secret, and lies
 * outside the closure of both the root and the React entries, which reach no
 * builtin at all.
 *
 * Pure, like the rest of `src/`: the clock is a parameter on both token
 * functions, so the same inputs always give the same token and the same
 * verdict.
 */

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
 * An empty secret throws, and so does one of whitespace alone. HMAC accepts an
 * empty key perfectly happily, so an unset environment variable arriving as
 * `''` — or as the newline a secret file ends with — would otherwise mint
 * tokens anyone can forge, and mint them silently. The mint is the caller's own code
 * path, where a throw is a bug report; verification takes the attacker's path
 * and refuses instead.
 */
export function mintPreviewToken(
  state: PreviewState,
  secret: string,
  now: number,
  ttlMs = DAY_MS,
): string {
  if (secret.trim() === '') {
    throw new Error(
      'a preview token cannot be signed with an empty secret — the signing key is unset, and an ' +
        'empty HMAC key would sign tokens anyone could forge',
    );
  }
  const payload: Payload = { s: state, exp: now + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac('', body, secret)}`;
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
  if (secret.trim() === '') return null;
  try {
    const dot = token.indexOf('.');
    if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
    const body = token.slice(0, dot);
    if (!sameSignature(token.slice(dot + 1), hmac('', body, secret))) return null;

    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!isPayload(payload)) return null;
    if (!Number.isFinite(now) || now >= payload.exp) return null;
    return payload.s;
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 of `domain` followed by `body`, base64url: the one signer every
 * token uses. The preview token signs with no domain, so its bytes are what
 * they always were; the unsubscribe token signs under `stet-unsubscribe:`, so
 * neither ever verifies as the other, even under one shared secret. It lives
 * here beside the compare because `src/` may name `node:crypto` in two modules
 * only; `server/http.ts` re-exports both.
 */
export function hmac(domain: string, body: string, secret: string): string {
  return createHmac('sha256', secret).update(domain + body, 'utf8').digest('base64url');
}

/**
 * Two strings equal, compared in constant time over their UTF-8 bytes, with a
 * byte-length guard so a length mismatch is a clean false rather than a throw
 * out of `timingSafeEqual`. The one compare every credential check uses: the
 * preview token here, the unsubscribe token and the mount's Bearer on
 * `@getstet/stet/server`.
 */
export function sameSignature(provided: string, expected: string): boolean {
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

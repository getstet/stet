/**
 * The unsubscribe token: which address a one-click unsubscribe suppresses,
 * signed so nobody can suppress an address they were never mailed at.
 *
 * `e.<base64url(email)>.<base64url(HMAC-SHA256)>` — Mirra's email-keyed shape
 * and parse (`lib/email/campaign.ts`). The signature covers `stet-unsubscribe:`
 * plus the encoded address, so a preview token can never verify as one even
 * where an operator set both secrets to one value: three credential kinds exist
 * and none stands in for another (§13.5). It never expires, because delivered
 * mail keeps it for good; rotating the secret therefore breaks every delivered
 * link.
 *
 * Here on `@getstet/stet/server` beside the mount. The signer and the compare
 * are the shared ones, so this module names no Node builtin and `src/` keeps
 * its two-module `node:crypto` rule.
 */

import { normalEmail } from '../src/contacts.js';
import { hmac, sameSignature } from './http.js';

const PREFIX = 'e.';
const DOMAIN = 'stet-unsubscribe:';

/**
 * A token for `email`, trimmed and lowercased first. An empty secret — after
 * trimming, since a secret file's trailing newline is not a key — throws: HMAC
 * signs happily with an empty key, and an unset variable arriving as `''` would
 * mint links anyone can forge; the mint is the host's own code path, where a
 * throw is a bug report.
 */
export function mintUnsubscribeToken(email: string, secret: string): string {
  const key = secret.trim();
  if (key === '') {
    throw new Error(
      'an unsubscribe token cannot be signed with an empty secret — the forms secret is unset, and an ' +
        'empty HMAC key would sign links anyone could forge',
    );
  }
  const body = Buffer.from(normalEmail(email), 'utf8').toString('base64url');
  return `${PREFIX}${body}.${hmac(DOMAIN, body, key)}`;
}

/**
 * The address a token names, or null — tampered, minted under another secret,
 * or malformed in any way. Never throws: this runs on a stranger's request, so
 * a token that is not a string at all is null too. An empty secret verifies
 * nothing, for the reason the mint throws on one.
 */
export function verifyUnsubscribeToken(token: unknown, secret: string): string | null {
  if (typeof token !== 'string') return null;
  const key = secret.trim();
  if (key === '' || !token.startsWith(PREFIX)) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= PREFIX.length) return null;
  const body = token.slice(PREFIX.length, dot);
  if (!sameSignature(token.slice(dot + 1), hmac(DOMAIN, body, key))) return null;
  const email = Buffer.from(body, 'base64url').toString('utf8');
  // A signature over a body this module never produced is still a signature
  // over bytes: only a normalized address is an address.
  return email !== '' && email === normalEmail(email) && email.includes('@') ? email : null;
}

/**
 * The link a host puts in an email and its `List-Unsubscribe` header: the
 * base's origin and path with `/unsubscribe?token=` appended (one trailing
 * slash removed first), where the base is the forms mount's public URL —
 * `https://<site>/api/stet` in every recipe, so the link has the path §13.5
 * pins. The base is checked by `unsubscribeBase`, as the handler checks it.
 */
export function unsubscribeUrl(email: string, opts: { secret: string; base: string }): string {
  const base = unsubscribeBase(opts.base, 'unsubscribeUrl');
  const token = mintUnsubscribeToken(email, opts.secret);
  return `${base.origin}${base.pathname.replace(/\/$/, '')}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * The forms mount's public URL, parsed, or a throw naming `caller`: an
 * `https:` URL, or `http:` on `localhost` or `127.0.0.1` for local
 * development. The raw string may hold no `?`, no `#` and no credentials —
 * `new URL` drops an empty query or fragment and keeps credentials, and every
 * delivered link appends its own path and query to what is left. Credentials
 * are checked on the parsed URL as well, since the parser also finds them where
 * the raw test sees no `//` (`https:user@host`). The handler's own origin and
 * every link are read from the parsed URL alone.
 */
export function unsubscribeBase(raw: unknown, caller: string): URL {
  let url: URL | null = null;
  try {
    url = typeof raw === 'string' ? new URL(raw) : null;
  } catch {
    url = null;
  }
  const local = url !== null && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  const scheme = url !== null && (url.protocol === 'https:' || (url.protocol === 'http:' && local));
  const clean =
    typeof raw === 'string' &&
    !raw.includes('?') &&
    !raw.includes('#') &&
    !/^[^/]*\/\/[^/]*@/.test(raw) &&
    url !== null &&
    url.username === '' &&
    url.password === '';
  if (url === null || !scheme || !clean) {
    throw new Error(
      `${caller}: \`unsubscribeBase\` must be the forms mount's public https URL, https://<site>/api/stet, ` +
        'with no query, fragment or credentials (http is accepted on localhost)',
    );
  }
  return url;
}

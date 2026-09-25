/**
 * The unsubscribe token: signed by the forms secret alone, under its own
 * domain, over an address in its normal form. Verify runs on a stranger's
 * request, so every malformed input is null and nothing throws.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hmac } from '../server/http.js';
import { mintUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from '../server/unsubscribe-token.js';
import { mintPreviewToken } from '../src/preview-token.js';

const SECRET = 'a-forms-secret';

describe('the unsubscribe token', () => {
  it('names the normalized address and verifies under its own secret alone', () => {
    const token = mintUnsubscribeToken('Ana@Lightfield.co', SECRET);
    expect(token.startsWith('e.YW5hQGxpZ2h0ZmllbGQuY28.')).toBe(true);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe('ana@lightfield.co');
    expect(verifyUnsubscribeToken(token, 'another-secret')).toBeNull();
  });

  it('refuses every changed signature character and a changed body', () => {
    const token = mintUnsubscribeToken('ana@lightfield.co', SECRET);
    const dot = token.lastIndexOf('.');
    for (let i = dot + 1; i < token.length; i += 1) {
      // Always a DIFFERENT character: flipping `A` to `A` would test nothing.
      const flipped = `${token.slice(0, i)}${token[i] === 'A' ? 'B' : 'A'}${token.slice(i + 1)}`;
      expect(`${i}: ${verifyUnsubscribeToken(flipped, SECRET)}`).toBe(`${i}: null`);
    }
    const body = `e.${Buffer.from('sam@lightfield.co').toString('base64url')}${token.slice(dot)}`;
    expect(verifyUnsubscribeToken(body, SECRET)).toBeNull();
  });

  it('answers null for anything malformed and never throws', () => {
    for (const bad of ['e.x', 'e..sig', 'x.YWJj.sig', '', null, 123, undefined, {}]) {
      expect(() => verifyUnsubscribeToken(bad as unknown as string, SECRET)).not.toThrow();
      expect(verifyUnsubscribeToken(bad as unknown as string, SECRET)).toBeNull();
    }
  });

  it('parses at the last dot, as Mirra’s token does', () => {
    // base64url decoding skips a `.`, so a body holding one still names an
    // address: the signature must cover everything up to the LAST dot.
    const body = 'YW5h.QGIuY28';
    expect(Buffer.from(body, 'base64url').toString('utf8')).toBe('ana@b.co');
    expect(verifyUnsubscribeToken(`e.${body}.${hmac('stet-unsubscribe:', body, SECRET)}`, SECRET)).toBe('ana@b.co');
    expect(verifyUnsubscribeToken(`e.${body}.${hmac('stet-unsubscribe:', 'YW5h', SECRET)}`, SECRET)).toBeNull();
  });

  it('signs nothing and verifies nothing under an empty secret, a trailing newline being no key', () => {
    expect(() => mintUnsubscribeToken('ana@x.co', '')).toThrowError(/the forms secret is unset/);
    expect(() => mintUnsubscribeToken('ana@x.co', ' \n')).toThrowError(/the forms secret is unset/);
    expect(verifyUnsubscribeToken(mintUnsubscribeToken('ana@x.co', SECRET), '')).toBeNull();
    expect(verifyUnsubscribeToken(mintUnsubscribeToken('ana@x.co', 's3cret\n'), 's3cret')).toBe('ana@x.co');
  });

  it('refuses a signed body that is not an address in its normal form', () => {
    const body = Buffer.from('ANA@X.CO', 'utf8').toString('base64url');
    expect(verifyUnsubscribeToken(`e.${body}.${hmac('stet-unsubscribe:', body, SECRET)}`, SECRET)).toBeNull();
    // Normalized, and signed by the mint itself, but no address: no `@`.
    expect(verifyUnsubscribeToken(mintUnsubscribeToken('not-an-address', SECRET), SECRET)).toBeNull();
  });

  it('never takes another token kind signed under the same secret', () => {
    const preview = mintPreviewToken({ kind: 'draft', key: 'hero_headline' }, SECRET, 1_700_000_000_000);
    expect(verifyUnsubscribeToken(preview, SECRET)).toBeNull();
    // The same bytes signed without the domain, as another signer sharing the
    // secret would produce them.
    const body = Buffer.from('ana@x.co', 'utf8').toString('base64url');
    const undomained = createHmac('sha256', SECRET).update(body, 'utf8').digest('base64url');
    expect(verifyUnsubscribeToken(`e.${body}.${undomained}`, SECRET)).toBeNull();
  });
});

describe('unsubscribeUrl', () => {
  it('appends the route and the encoded token to the base’s origin and path', () => {
    const token = mintUnsubscribeToken('a@b.co', SECRET);
    expect(token.startsWith('e.YUBiLmNv.')).toBe(true);
    const link = `https://x.co/api/stet/unsubscribe?token=${encodeURIComponent(token)}`;
    expect(unsubscribeUrl('a@b.co', { secret: SECRET, base: 'https://x.co/api/stet/' })).toBe(link);
    expect(unsubscribeUrl('a@b.co', { secret: SECRET, base: 'https://X.co:443/api/stet/' })).toBe(link);
  });

  it('refuses a base the handler refuses, under its own name', () => {
    for (const base of [
      'https://x.co/api/stet?',
      'https://x.co/api/stet#',
      'https://u:p@x.co/api/stet',
      'https://@x.co/api/stet',
      'http://x.co/api/stet',
      // Credentials the parser finds where the raw string has no `//`.
      'https:u:p@x.co/api/stet',
      'https:/u@x.co/api/stet',
      'https:\\\\u@x.co/api/stet',
    ]) {
      expect(() => unsubscribeUrl('a@b.co', { secret: SECRET, base })).toThrowError(
        'unsubscribeUrl: `unsubscribeBase` must be the forms mount\'s public https URL, https://<site>/api/stet, ' +
          'with no query, fragment or credentials (http is accepted on localhost)',
      );
    }
  });
});

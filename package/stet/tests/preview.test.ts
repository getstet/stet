import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { miniDescriptor, miniRows, miniSnapshot, mutable } from '../conformance/fixture.js';
import { pageSpan, resolve, resolvePreview } from '../src/index.js';
import type { PreviewState, StoreRow } from '../src/index.js';
import { mintPreviewToken, verifyPreviewToken } from '../src/preview-token.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();

const SECRET = 'a-preview-signing-secret';
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A validly-signed token over an arbitrary payload — the same construction the
 * mint uses — so a test can present a signature the verifier accepts and a state
 * it still has to refuse. */
function signed(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', SECRET).update(body, 'utf8').digest('base64url')}`;
}

/** An active row, the shape a store hands over. */
function active(key: string, value: unknown, version: number, locale = 'default'): StoreRow {
  return { key, locale, status: 'published', is_active: true, value, version };
}

/** The fixture rows plus a clean second key, so a preview can override one key
 * and leave another to resolve the ordinary way. */
function rowsWithBody(): StoreRow[] {
  return [...miniRows(), active('hero_body', 'The body the site is serving.', 2)];
}

describe('the preview token', () => {
  it('round-trips each of the three states it can name', () => {
    const states: PreviewState[] = [
      { kind: 'draft', key: 'hero_headline' },
      { kind: 'draft', key: 'hero_headline', locale: 'de' },
      { kind: 'version', key: 'hero_headline', versionId: 3 },
      { kind: 'change-before', changeId: 42 },
    ];
    for (const state of states) {
      const token = mintPreviewToken(state, SECRET, NOW);
      expect(verifyPreviewToken(token, SECRET, NOW)).toEqual(state);
    }
  });

  it('expires at exactly its stamp, not a moment later', () => {
    const state: PreviewState = { kind: 'change-before', changeId: 7 };
    const token = mintPreviewToken(state, SECRET, NOW);
    expect(verifyPreviewToken(token, SECRET, NOW + DAY - 1)).toEqual(state);
    expect(verifyPreviewToken(token, SECRET, NOW + DAY)).toBeNull();
    expect(verifyPreviewToken(token, SECRET, NOW + DAY + 1)).toBeNull();
  });

  it('honors a caller-supplied lifetime, and the default is 24 hours', () => {
    const state: PreviewState = { kind: 'draft', key: 'hero_headline' };
    const short = mintPreviewToken(state, SECRET, NOW, 60_000);
    expect(verifyPreviewToken(short, SECRET, NOW + 59_999)).toEqual(state);
    expect(verifyPreviewToken(short, SECRET, NOW + 60_000)).toBeNull();
    expect(mintPreviewToken(state, SECRET, NOW)).toBe(mintPreviewToken(state, SECRET, NOW, DAY));
  });

  it('refuses a tampered payload, a wrong secret and anything malformed — never throwing', () => {
    const token = mintPreviewToken({ kind: 'version', key: 'hero_headline', versionId: 1 }, SECRET, NOW);
    const [body, signature] = token.split('.');

    // The payload rewritten to name another version, carrying the old signature.
    const forged = Buffer.from(
      JSON.stringify({ s: { kind: 'version', key: 'hero_headline', versionId: 99 }, exp: NOW + DAY }),
      'utf8',
    ).toString('base64url');
    expect(verifyPreviewToken(`${forged}.${signature ?? ''}`, SECRET, NOW)).toBeNull();

    expect(verifyPreviewToken(token, 'another-secret', NOW)).toBeNull();

    // A signature of the wrong byte length must be a clean refusal, not a throw
    // out of the constant-time compare.
    expect(verifyPreviewToken(`${body ?? ''}.${signature ?? ''}ff`, SECRET, NOW)).toBeNull();
    expect(verifyPreviewToken(`${body ?? ''}.`, SECRET, NOW)).toBeNull();

    for (const junk of ['', '.', 'no-dot-at-all', `${body ?? ''}`, `.${signature ?? ''}`, `${token}.extra`]) {
      expect(verifyPreviewToken(junk, SECRET, NOW)).toBeNull();
    }

    // Validly signed, but not a state the seam knows: a signature is not a
    // licence to skip the shape check.
    expect(verifyPreviewToken(signed({ s: { kind: 'whatever' }, exp: NOW + DAY }), SECRET, NOW)).toBeNull();
    expect(verifyPreviewToken(signed({ s: { kind: 'draft' }, exp: NOW + DAY }), SECRET, NOW)).toBeNull();
    expect(
      verifyPreviewToken(signed({ s: { kind: 'change-before', changeId: '4' }, exp: NOW + DAY }), SECRET, NOW),
    ).toBeNull();
    expect(verifyPreviewToken(signed({ s: { kind: 'change-before', changeId: 4 } }), SECRET, NOW)).toBeNull();
    expect(verifyPreviewToken(signed('not even an object'), SECRET, NOW)).toBeNull();
    expect(verifyPreviewToken(signed(null), SECRET, NOW)).toBeNull();
  });

  it('fails closed on an empty signing secret rather than signing with nothing', () => {
    const state: PreviewState = { kind: 'draft', key: 'hero_headline' };

    // An unset env var arrives as ''. HMAC would accept it as a key without
    // complaint, so the seam refuses at both ends: the mint throws on the
    // caller's own path, verification refuses on the attacker's.
    expect(() => mintPreviewToken(state, '', NOW)).toThrowError(/empty secret/);

    const real = mintPreviewToken(state, SECRET, NOW);
    expect(verifyPreviewToken(real, '', NOW)).toBeNull();

    // Including a token that WAS signed with the empty key, forged the way an
    // attacker would once they noticed the secret was unset.
    const forged = (() => {
      const body = Buffer.from(JSON.stringify({ s: state, exp: NOW + DAY }), 'utf8').toString('base64url');
      return `${body}.${createHmac('sha256', '').update(body, 'utf8').digest('base64url')}`;
    })();
    expect(verifyPreviewToken(forged, '', NOW)).toBeNull();
  });

  it('expires everything when the clock itself is not a number', () => {
    const token = mintPreviewToken({ kind: 'change-before', changeId: 3 }, SECRET, NOW);
    // NaN >= exp is false, so an unguarded comparison would make every token
    // immortal exactly when the caller's clock broke.
    expect(verifyPreviewToken(token, SECRET, Number.NaN)).toBeNull();
    expect(verifyPreviewToken(token, SECRET, Number.POSITIVE_INFINITY)).toBeNull();
    expect(verifyPreviewToken(token, SECRET, Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('resolvePreview', () => {
  it('overrides one key while every other key resolves the ordinary way', () => {
    const rows = rowsWithBody();
    const overrides = { rows: [active('hero_headline', 'The headline before the change.', 3)] };

    expect(resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_headline' })).toEqual({
      value: 'The headline before the change.',
      source: 'active',
      warnings: [],
    });
    expect(resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_body' })).toEqual({
      value: 'The body the site is serving.',
      source: 'active',
      warnings: [],
    });
  });

  it('reads byte-identically to what resolve would return had those versions still been live', () => {
    const rows = rowsWithBody();
    const before = active('hero_headline', 'The headline before the change.', 3);
    const asIfLive = [...rows.filter((r) => r.key !== 'hero_headline'), before];

    for (const key of Object.keys(descriptor.keys)) {
      expect(resolvePreview(descriptor, snapshot, rows, { rows: [before] }, { key })).toEqual(
        resolve(descriptor, snapshot, asIfLive, { key }),
      );
    }
  });

  it('masks a first-publish member so the snapshot serves it, never the post-change value', () => {
    const rows = rowsWithBody();
    const overrides = {
      rows: [active('hero_headline', 'The headline before the change.', 3)],
      keys: [
        { key: 'hero_headline', locale: 'default' },
        { key: 'hero_body', locale: 'default' },
      ],
    };

    // hero_body joined the site in this change: it has no before-version, so it
    // contributes no override row and must read as it did before — unpublished.
    expect(resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_body' })).toEqual({
      value: 'Follow {{handle}} without leaving Telegram.',
      source: 'snapshot',
      warnings: [],
    });

    // Without the pair set, the same call leaks exactly the value the preview
    // exists to hide.
    expect(
      resolvePreview(descriptor, snapshot, rows, { rows: overrides.rows }, { key: 'hero_body' }).value,
    ).toBe('The body the site is serving.');

    // The mask is per locale here too: a first-publish member masked in
    // `default` says nothing about the same key in `de`.
    const withGerman = [...rows, active('hero_body', 'Der Text, den die Seite zeigt.', 2, 'de')];
    expect(
      resolvePreview(descriptor, snapshot, withGerman, overrides, { key: 'hero_body', locale: 'de' }),
    ).toMatchObject({ value: 'Der Text, den die Seite zeigt.', source: 'active' });
  });

  it('masks per locale, so a change in one language never blanks another', () => {
    const rows = [
      ...rowsWithBody(),
      active('hero_headline', 'Die Schlagzeile, die live ist.', 5, 'de'),
    ];
    // The change touched only the default locale of hero_headline.
    const overrides = {
      rows: [active('hero_headline', 'The headline before the change.', 3)],
      keys: [{ key: 'hero_headline', locale: 'default' }],
    };

    // The untouched German row keeps resolving live, byte-identically to what a
    // plain resolve gives it — masking key-wide would serve the German page the
    // English before-value instead.
    expect(resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_headline', locale: 'de' })).toEqual(
      resolve(descriptor, snapshot, rows, { key: 'hero_headline', locale: 'de' }),
    );
    expect(
      resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_headline', locale: 'de' }).value,
    ).toBe('Die Schlagzeile, die live ist.');

    // And the locale the change did touch still previews its before-value.
    expect(
      resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_headline' }).value,
    ).toBe('The headline before the change.');
  });

  it('unions the pair set with the override rows own identities, never replacing them', () => {
    const rows = rowsWithBody();
    const before = active('hero_headline', 'The headline before the change.', 3);
    // `keys` names only the first-publish member; the override row's own
    // identity is absent from it.
    const overrides = { rows: [before], keys: [{ key: 'hero_body', locale: 'default' }] };

    // A replacement mask would leave the live version-3 row in play beside the
    // override, and the override would lose or win by version number rather
    // than by being the override.
    expect(
      resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_headline' }).value,
    ).toBe('The headline before the change.');
    expect(resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_body' }).source).toBe(
      'snapshot',
    );

    // Made concrete: the live row outranks the override on version, so only the
    // union mask can keep the preview correct.
    const outranked = [...rows, active('hero_headline', 'A newer live headline.', 99)];
    expect(
      resolvePreview(descriptor, snapshot, outranked, overrides, { key: 'hero_headline' }).value,
    ).toBe('The headline before the change.');
  });

  it('quarantines a malformed override the way a malformed stored value is quarantined', () => {
    const rows = rowsWithBody();
    const overrides = { rows: [active('hero_headline', { was: 'an object' }, 3)] };
    const r = resolvePreview(descriptor, snapshot, rows, overrides, { key: 'hero_headline' });

    expect(r.value).toBe('Never miss a post again.');
    expect(r.source).toBe('snapshot');
    expect(r.warnings.map((w) => w.code)).toEqual(['malformed_value']);
    expect(r.warnings[0]).toMatchObject({ key: 'hero_headline', locale: 'default' });
  });

  it('layers a draft override as live copy, with no preview read asked for', () => {
    const rows = rowsWithBody();
    const draft: StoreRow = {
      key: 'hero_headline',
      locale: 'default',
      status: 'draft',
      value: 'A headline still in progress.',
      version: 4,
    };
    expect(
      resolvePreview(descriptor, snapshot, rows, { rows: [draft] }, { key: 'hero_headline' }),
    ).toMatchObject({ value: 'A headline still in progress.', source: 'active' });
  });

  it('is the plain resolve when the override set is empty', () => {
    const rows = rowsWithBody();
    for (const key of Object.keys(descriptor.keys)) {
      for (const locale of ['default', 'de']) {
        expect(resolvePreview(descriptor, snapshot, rows, { rows: [] }, { key, locale })).toEqual(
          resolve(descriptor, snapshot, rows, { key, locale }),
        );
        expect(resolvePreview(descriptor, snapshot, null, { rows: [] }, { key, locale })).toEqual(
          resolve(descriptor, snapshot, null, { key, locale }),
        );
      }
    }
  });
});

describe('a change knows the pages it touches', () => {
  it('unions its members pages, each page once, in first-seen order', () => {
    expect(pageSpan(descriptor, ['footer_links', 'hero_headline'])).toEqual(['home', 'pricing']);
    expect(pageSpan(descriptor, ['hero_headline', 'footer_links'])).toEqual(['home', 'pricing']);
  });

  it('shrinks when a member is dropped — the span is derived, never stored', () => {
    expect(pageSpan(descriptor, ['footer_links', 'hero_headline'])).toEqual(['home', 'pricing']);
    expect(pageSpan(descriptor, ['hero_headline'])).toEqual(['home']);
    expect(pageSpan(descriptor, [])).toEqual([]);
  });

  it('spans nothing for an all-email change', () => {
    expect(pageSpan(descriptor, ['welcome__subject', 'welcome__body', 'brand__footer_address'])).toEqual(
      [],
    );
  });

  it('invents no page for a key the descriptor has never heard of', () => {
    expect(pageSpan(descriptor, ['gone_from_the_descriptor', 'constructor', 'toString'])).toEqual([]);
    expect(pageSpan(descriptor, ['constructor', 'hero_headline'])).toEqual(['home']);
  });

  it('reads the descriptor live: a key that gains a page widens the span', () => {
    const widened = mutable(descriptor);
    widened.keys['welcome__subject'] = { ...widened.keys['welcome__subject'], shape: 'text', target: 'html-email', pages: ['home'] };
    expect(pageSpan(widened, ['welcome__subject'])).toEqual(['home']);
    expect(pageSpan(descriptor, ['welcome__subject'])).toEqual([]);
  });
});

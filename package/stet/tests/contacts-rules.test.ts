/**
 * The contacts rules the join route and the CLI share: what an address is, what
 * a group key and a form name are, and whether a set of answers is what a group
 * asks. The route's refusals are proven through the handler in forms.test.ts;
 * these are the rules themselves.
 */
import { describe, expect, it } from 'vitest';

import { checkAnswers, checkDeclaration, FORM_KEY, GROUP_KEY, isEmail, normalEmail } from '../src/contacts.js';
import type { GroupProperty } from '../src/store.js';

describe('the address', () => {
  it('is trimmed and lowercased, of every whitespace trim() removes', () => {
    expect(normalEmail(' Ana@X.Co ')).toBe('ana@x.co');
    expect(normalEmail(' 　 Ana@X.co﻿\t')).toBe('ana@x.co');
  });

  it('is shaped like one, bounded, and free of control characters', () => {
    expect(isEmail('a@b.co')).toBe(true);
    for (const bad of [
      'a@b',
      'a b@c.co',
      '@b.co',
      `${'a'.repeat(250)}@b.co`,
      // An OSC hyperlink and a C1 CSI: a terminal acts on both when
      // `stet contacts` prints the address.
      'a\u001b]8;;x\u0007@b.co',
      'a\u009b31m@b.co',
    ]) {
      expect(`${JSON.stringify(bad)}: ${isEmail(bad)}`).toBe(`${JSON.stringify(bad)}: false`);
    }
    expect(`${'a'.repeat(250)}@b.co`).toHaveLength(255);
  });

  it('is well-formed text: a lone surrogate is refused, a paired one kept', () => {
    // Half a pair, as a JSON body's `"\ud800"` arrives: no encoding stores it.
    for (const bad of ['a\uD800@b.co', 'a@b\uDC00.co', 'a@b.co\uD83D']) {
      expect(`${JSON.stringify(bad)}: ${isEmail(bad)}`).toBe(`${JSON.stringify(bad)}: false`);
    }
    expect(isEmail('a\u{1F680}@b.co')).toBe(true);
  });
});

describe('the keys', () => {
  it('a group key is URL-shaped', () => {
    expect(GROUP_KEY.test('cloud-waitlist')).toBe(true);
    expect(GROUP_KEY.test('a'.repeat(64))).toBe(true);
    for (const bad of ['Cloud', '-x', 'a'.repeat(65)]) expect(GROUP_KEY.test(bad)).toBe(false);
  });

  it('a form name is a short token', () => {
    expect(FORM_KEY.test('waitlist-page')).toBe(true);
    expect(FORM_KEY.test('consent_label@v12')).toBe(true);
    for (const bad of ['has space', '', 'a'.repeat(101)]) expect(FORM_KEY.test(bad)).toBe(false);
  });
});

describe('the answers', () => {
  const declared: GroupProperty[] = [
    { name: 'tier', type: 'enum', values: ['solo', 'team', 'business'], required: true },
    { name: 'use_case', type: 'text' },
  ];

  it('keeps a declared answer, trimmed', () => {
    expect(checkAnswers(declared, { tier: 'team' })).toEqual({ ok: true, properties: { tier: 'team' } });
    expect(checkAnswers(declared, { tier: ' team ' })).toEqual({ ok: true, properties: { tier: 'team' } });
  });

  it('names what is wrong with an answer, and whether it was missing', () => {
    expect(checkAnswers(declared, {})).toEqual({ ok: false, property: 'tier', reason: 'is required', missing: true });
    expect(checkAnswers(declared, { tier: 'enterprise' })).toEqual({
      ok: false,
      property: 'tier',
      reason: 'must be one of solo, team, business',
      missing: false,
    });
    expect(checkAnswers(declared, { tier: 'team', use_case: 'x'.repeat(501) })).toEqual({
      ok: false,
      property: 'use_case',
      reason: 'longer than 500 characters',
      missing: false,
    });
    expect(checkAnswers(declared, { tier: 3 })).toEqual({ ok: false, property: 'tier', reason: 'must be text', missing: false });
    expect(checkAnswers(declared, { tier: 'team', use_case: 'x\u001b[2Jy' })).toEqual({
      ok: false,
      property: 'use_case',
      reason: 'holds a control character',
      missing: false,
    });
  });

  it('keeps the line feed a multi-line field sends, and refuses a carriage return', () => {
    expect(checkAnswers(declared, { tier: 'team', use_case: 'line one\nline two' })).toEqual({
      ok: true,
      properties: { tier: 'team', use_case: 'line one\nline two' },
    });
    expect(checkAnswers(declared, { tier: 'team', use_case: 'a\r\nb' })).toMatchObject({
      ok: false,
      property: 'use_case',
      reason: 'holds a control character',
    });
  });

  it('refuses an answer the group does not ask, own properties only', () => {
    for (const raw of ['{"constructor": "x"}', '{"__proto__": "x"}']) {
      expect(checkAnswers(declared, JSON.parse(raw))).toMatchObject({
        ok: false,
        reason: 'not a question this group asks',
        missing: false,
      });
    }
  });

  it('refuses answers that are not an object, and takes none as none', () => {
    for (const raw of [[], 'x']) {
      expect(checkAnswers(declared, raw)).toEqual({
        ok: false,
        property: null,
        reason: 'the answers must be an object',
        missing: false,
      });
    }
    const optional: GroupProperty[] = [{ name: 'use_case', type: 'text' }];
    expect(checkAnswers(optional, undefined)).toEqual({ ok: true, properties: {} });
    expect(checkAnswers(optional, null)).toEqual({ ok: true, properties: {} });
    expect(checkAnswers(optional, { use_case: '' })).toEqual({ ok: true, properties: {} });
  });

  it('answers in the declaration’s order', () => {
    const checked = checkAnswers(declared, { use_case: 'docs', tier: 'solo' });
    expect(checked.ok && Object.keys(checked.properties)).toEqual(['tier', 'use_case']);
  });

  it('refuses an answer that is not well-formed text, and keeps a paired surrogate', () => {
    expect(checkAnswers(declared, { tier: 'solo', use_case: 'docs \uD800' })).toEqual({
      ok: false,
      property: 'use_case',
      reason: 'is not well-formed text',
      missing: false,
    });
    expect(checkAnswers(declared, { tier: 'solo', use_case: 'docs \u{1F680}' })).toEqual({
      ok: true,
      properties: { tier: 'solo', use_case: 'docs \u{1F680}' },
    });
  });
});

describe('the declaration', () => {
  it('takes a list of named questions, enums with their values', () => {
    expect(checkDeclaration([])).toBeNull();
    expect(
      checkDeclaration([
        { name: 'tier', type: 'enum', values: ['solo', 'team'], required: true },
        { name: 'use_case', type: 'text' },
      ]),
    ).toBeNull();
  });

  it('names the first fault, in words a flag or a prefix reads', () => {
    const cases: [unknown, string][] = [
      [{ name: 'tier' }, 'the properties must be a list'],
      [[null], 'property 1 has no name'],
      [[{ type: 'text' }], 'property 1 has no name'],
      [[{ name: 'Tier', type: 'text' }], 'Tier: a name is lowercase letters, digits and _, starting with a letter'],
      [[{ name: 'a', type: 'text' }, { name: 'a', type: 'text' }], 'a is given twice'],
      [[{ name: 'tier', type: 'choice' }], 'tier: the type is enum or text'],
      [[{ name: 'tier', type: 'enum' }], 'tier: the values are a list with no blanks or repeats'],
      [[{ name: 'tier', type: 'enum', values: [] }], 'tier: the values are a list with no blanks or repeats'],
      [[{ name: 'tier', type: 'enum', values: ['a', 'a'] }], 'tier: the values are a list with no blanks or repeats'],
      [[{ name: 'tier', type: 'enum', values: ['a', ''] }], 'tier: the values are a list with no blanks or repeats'],
      [[{ name: 'tier', type: 'enum', values: [' a'] }], 'tier: the values are a list with no blanks or repeats'],
      [[{ name: 'tier', type: 'enum', values: [1] }], 'tier: the values are a list with no blanks or repeats'],
      [[{ name: 'note', type: 'text', values: ['x'] }], 'note: a text property lists no values'],
      [[{ name: 'note', type: 'text', required: 'yes' }], 'note: required is true or false'],
      [[{ name: 'tier', type: 'text', label: 'Tier' }], 'tier: label is not a field of a declaration (name, type, values, required)'],
      [[{ name: 'tier', type: 'enum', values: ['solo', 'te\u001b[2Jam'] }], 'tier: a value holds a control character'],
      [[{ name: 'tier', type: 'enum', values: ['solo\u009b'] }], 'tier: a value holds a control character'],
    ];
    for (const [declaration, fault] of cases) {
      expect(`${JSON.stringify(declaration)}: ${checkDeclaration(declaration)}`).toBe(`${JSON.stringify(declaration)}: ${fault}`);
    }
  });
});

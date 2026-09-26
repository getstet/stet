/**
 * The naming plan (cli/key-plan.ts): the reader, the writer, and the six
 * refusal rules register and rename share — every problem listed in one run,
 * each naming its entry.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { planProblems, planText, readPlan, type NamingPlan, type PlanEntry } from '../cli/key-plan.js';
import { CliError, sanitizeLine } from '../cli/report.js';
import { checkAnswers } from '../src/contacts.js';
import type { Descriptor } from '../src/types.js';

function dirWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-plan-'));
  writeFileSync(join(dir, 'p.json'), text, 'utf8');
  return dir;
}
const refusal = (text: string, command: 'stet register' | 'stet rename' = 'stet register'): string => {
  try {
    readPlan(dirWith(text), 'p.json', command);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return (error as Error).message;
  }
  throw new Error('the plan was read');
};

const DESCRIPTOR: Descriptor = {
  version: 1,
  keys: {
    home_taken: { shape: 'text', target: 'web' },
    a_key: { shape: 'text', target: 'web' },
    b_key: { shape: 'text', target: 'web' },
  },
};
const MADE = { 'content/defaults.json': 'sha256:aa', 'content/descriptor.json': 'sha256:bb', 'index.html': 'sha256:cc' };
const entry = (proposed: string, extra: Partial<PlanEntry> = {}): PlanEntry => ({
  proposed,
  key: proposed,
  label: null,
  help: null,
  section: null,
  adopt: true,
  ...extra,
});
const registerPlan = (keys: PlanEntry[], made: Record<string, string> = MADE): NamingPlan => ({
  plan: 'stet register',
  version: 1,
  made,
  keys,
});
const renamePlan = (keys: Array<Partial<PlanEntry> & { old: string; key: string }>): NamingPlan => ({
  plan: 'stet rename',
  version: 1,
  keys: keys.map((k) => ({ label: null, help: null, ...k })),
});

describe('readPlan', () => {
  it('refuses a file that is not JSON', () => {
    expect(refusal('{ not json')).toMatch(/^p\.json: not a readable JSON plan — /);
  });

  it("refuses a plan of the other command, another version, or one with no keys", () => {
    const line =
      'p.json: not a stet register plan — "plan": "stet register", "version": 1 and a "keys" list are required';
    expect(refusal(JSON.stringify({ plan: 'stet rename', version: 1, keys: [] }))).toBe(line);
    expect(refusal(JSON.stringify({ plan: 'stet register', version: 2, keys: [] }))).toBe(line);
    expect(refusal(JSON.stringify({ plan: 'stet register', version: 1 }))).toBe(line);
  });

  it('refuses an entry without its identity, naming it by number', () => {
    expect(refusal(JSON.stringify({ plan: 'stet register', version: 1, keys: [{ key: 'a' }] }))).toBe(
      'p.json: entry 1 needs "proposed" and "key" as strings',
    );
    expect(refusal(JSON.stringify({ plan: 'stet rename', version: 1, keys: [{ old: 'a', key: 'b' }, { key: 'c' }] }), 'stet rename')).toBe(
      'p.json: entry 2 needs "old" and "key" as strings',
    );
  });

  it('reads back what planText writes', () => {
    const plan = registerPlan([entry('home_top_headline', { kind: 'headline', places: ['index.html:3 <h1>'], text: 'Hi' })]);
    const text = planText(plan);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "plan": "stet register",\n');
    expect(readPlan(dirWith(text), 'p.json', 'stet register')).toEqual(plan);
  });
});

describe('planProblems — a register plan', () => {
  it('lists every problem in entry order, each entry’s together', () => {
    const ids = ['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e09', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16'];
    const plan = registerPlan([
      entry('e01', { key: 'home_hero__eyebrow' }),
      entry('e02', { key: 'home_Hero' }),
      entry('e03', { key: '2026_footer' }),
      entry('e04', { key: `a${'_b'.repeat(32)}` }),
      entry('e05', { key: 'home_taken' }),
      entry('e06', { key: 'home_faq_question' }),
      entry('e07', { key: 'home_faq_question', label: 42 as unknown as string }),
      entry('e08', { label: 'two\nlines' }),
      entry('e09', { label: 'a bell \u0007 here' }),
      entry('e10', { label: 'a flip ‮ here' }),
      entry('e11', { label: 'x'.repeat(61) }),
      entry('e12', { help: 'y'.repeat(501) }),
      entry('e13', { section: 'Hero' }),
      entry('e14', { adopt: 'no' as unknown as boolean }),
      entry('e15', { section: '2col' }),
      entry('e16', { section: '2026_annual_report' }),
    ]);
    expect(planProblems(plan, 'p.json', DESCRIPTOR, ids, { hashes: MADE })).toEqual([
      'e01: "home_hero__eyebrow" uses "__", which names a template slot or the brand group',
      'e02: "home_Hero" is not a key name — lowercase letters, digits and single underscores, starting with a letter',
      'e03: "2026_footer" is not a key name — lowercase letters, digits and single underscores, starting with a letter',
      `e04: "a${'_b'.repeat(32)}" is longer than 64 characters`,
      'e05: "home_taken" is already a key in the descriptor',
      'e06 and e07: both are named "home_faq_question"',
      'e07: its label is not text',
      'e08: its label holds a line break',
      'e09: its label holds a control character',
      'e10: its label holds a control character',
      'e11: its label is longer than 60 characters',
      'e12: its help is longer than 500 characters',
      'e13: its section "Hero" is not a section word — lowercase letters and digits in words joined by single underscores, at most 24 characters',
      'e14: its adopt is not true or false',
    ]);
  });

  it('passes a digit-first section word, as the rule writes it', () => {
    const plan = registerPlan([entry('a', { section: '2col' }), entry('b', { section: '2026_annual_report' })]);
    expect(planProblems(plan, 'p.json', DESCRIPTOR, ['a', 'b'], { hashes: MADE })).toEqual([]);
  });

  it('names a missing proposal, a foreign entry and one listed twice (rule 5)', () => {
    const plan = registerPlan([entry('a'), entry('zzz'), entry('a', { key: 'a_again' })]);
    expect(planProblems(plan, 'p.json', DESCRIPTOR, ['a', 'b'], { hashes: MADE })).toEqual([
      'zzz: not a proposal of this run',
      'a: listed twice',
      'b: not in the plan — list every proposal, with "adopt": false to leave one out',
    ]);
  });

  it('refuses a stale plan with its one line, however its entries differ (rule 6)', () => {
    const stale = 'p.json: the files it was made from have changed — run the command with --plan-out again';
    // Entries that no longer match the run's proposals: the one line stands alone.
    const plan = (made: Record<string, string>) => registerPlan([entry('old_one'), entry('old_two')], made);
    const ids = ['new_one', 'new_two'];
    const changed = { ...MADE, 'index.html': 'sha256:dd' };
    const missing: Record<string, string> = { ...MADE };
    delete missing['index.html'];
    const added = { ...MADE, 'about.html': 'sha256:ee' };
    for (const made of [changed, missing, added]) {
      expect(planProblems(plan(made), 'p.json', DESCRIPTOR, ids, { hashes: MADE })).toEqual([stale]);
    }
  });

  it('leaves an entry the plan drops unjudged but for its identity', () => {
    const plan = registerPlan([entry('a', { adopt: false, key: 'Not__A_Name' }), entry('b')]);
    expect(planProblems(plan, 'p.json', DESCRIPTOR, ['a', 'b'], { hashes: MADE })).toEqual([]);
  });
});

describe('planProblems — a rename plan', () => {
  const keys = Object.keys(DESCRIPTOR.keys);

  it('lets an entry keep its own name, and two entries swap theirs', () => {
    expect(planProblems(renamePlan([{ old: 'a_key', key: 'a_key', label: 'A label' }]), 'r.json', DESCRIPTOR, keys)).toEqual([]);
    const swap = renamePlan([
      { old: 'a_key', key: 'b_key' },
      { old: 'b_key', key: 'a_key' },
    ]);
    expect(planProblems(swap, 'r.json', DESCRIPTOR, keys)).toEqual([]);
  });

  it('refuses an old name the descriptor does not declare', () => {
    expect(planProblems(renamePlan([{ old: 'nope', key: 'fine_name' }]), 'r.json', DESCRIPTOR, keys)).toEqual([
      'nope: not a key in the descriptor',
    ]);
  });

  it('refuses an entry carrying adopt', () => {
    const plan = renamePlan([{ old: 'a_key', key: 'a_new', adopt: true }]);
    expect(planProblems(plan, 'r.json', DESCRIPTOR, keys)).toEqual(['a_key: a rename plan takes no "adopt"']);
  });

  it("gives the caller's own refusal as the entry's only line", () => {
    const plan = renamePlan([{ old: 'a_key', key: 'Bad__Name', adopt: true }]);
    const own = (e: PlanEntry): string | undefined => (e.old === 'a_key' ? 'a_key: refused by the caller' : undefined);
    expect(planProblems(plan, 'r.json', DESCRIPTOR, keys, { refusal: own })).toEqual(['a_key: refused by the caller']);
  });
});

describe('planProblems — the stage-5 review (F12)', () => {
  it('reads U+2028 and U+2029 as line breaks, and the direction marks as control characters', () => {
    const plan = registerPlan([
      entry('a', { label: 'one\u2028two' }),
      entry('b', { help: 'one\u2029two' }),
      entry('c', { label: 'a \u200E mark' }),
      entry('d', { label: 'a \u200F mark' }),
      entry('e', { help: 'an \u061C mark' }),
    ]);
    expect(planProblems(plan, 'p.json', DESCRIPTOR, ['a', 'b', 'c', 'd', 'e'], { hashes: MADE })).toEqual([
      'a: its label holds a line break',
      'b: its help holds a line break',
      'c: its label holds a control character',
      'd: its label holds a control character',
      'e: its help holds a control character',
    ]);
    // The direction marks are the plan's own: the shared class, and every line
    // printed through it, keeps them.
    expect(sanitizeLine('a\u200Eb\u200Fc\u061Cd')).toBe('a\u200Eb\u200Fc\u061Cd');
    expect(sanitizeLine('a\u202Eb')).toBe('a\uFFFDb');
  });
});

describe('planProblems — the delta review (N1)', () => {
  it('refuses a right-to-left mark in a label while a contact answer keeps it', () => {
    const answer = '\u05D3\u05E0\u05D4 \u05DB\u05D4\u05DF\u200F';
    const declared = [{ name: 'name', type: 'text' as const }];
    expect(checkAnswers(declared, { name: answer })).toEqual({ ok: true, properties: { name: answer } });
    const plan = registerPlan([entry('a', { label: answer })]);
    expect(planProblems(plan, 'p.json', DESCRIPTOR, ['a'], { hashes: MADE })).toEqual([
      'a: its label holds a control character',
    ]);
  });
});

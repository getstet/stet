import { describe, expect, it } from 'vitest';

import { miniDescriptor, miniSnapshot, mutable } from '../conformance/fixture.js';
import {
  checkBudget,
  checkClassRules,
  checkLimits,
  checkVars,
  htmlEmailTarget,
  resolve,
  shapeSchema,
  targetAdapter,
  targetAdapterIfShipped,
  templateOf,
  validateSave,
  webTarget,
  type Descriptor,
  type Target,
} from '../src/index.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();

/**
 * Scope as a caller supplies it: resolved before the call, core never fetches.
 * The slots, and the brand's postal line the marketing class rule reads.
 */
function siblingsOf(template: string): Record<string, unknown> {
  const slots = descriptor.templates?.[template]?.slots ?? [];
  const out: Record<string, unknown> = {};
  for (const slot of slots) {
    const key = `${template}__${slot}`;
    out[key] = resolve(descriptor, snapshot, [], { key }).value;
  }
  out['brand__footer_address'] = resolve(descriptor, snapshot, [], {
    key: 'brand__footer_address',
  }).value;
  return out;
}

describe('shapeSchema', () => {
  it('parses each declared shape', () => {
    expect(shapeSchema(descriptor, 'hero_headline').safeParse('text').success).toBe(true);
    expect(shapeSchema(descriptor, 'footer_links').safeParse(['a']).success).toBe(true);
    expect(shapeSchema(descriptor, 'contact_form_labels').safeParse({ a: 1 }).success).toBe(true);
    expect(shapeSchema(descriptor, 'theme_mode').safeParse('dark').success).toBe(true);
    expect(shapeSchema(descriptor, 'theme_mode').safeParse('midnight').success).toBe(false);
    expect(shapeSchema(descriptor, 'brand__radius').safeParse(8).success).toBe(true);
  });

  it('takes hex colors only — a named color is not machine-comparable', () => {
    const color = shapeSchema(descriptor, 'brand__primary');
    expect(color.safeParse('#1d4ed8').success).toBe(true);
    expect(color.safeParse('#fff').success).toBe(true);
    expect(color.safeParse('rebeccapurple').success).toBe(false);
    expect(color.safeParse('rgb(29, 78, 216)').success).toBe(false);
  });
});

describe('checkLimits', () => {
  it('rejects a hard-limit overrun, naming the key, the length and the limit', () => {
    const verdict = checkLimits(descriptor, 'farewell_notice', 'x'.repeat(4200));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({
      rule: 'limit',
      severity: 'error',
      key: 'farewell_notice',
      length: 4200,
      max: 4096,
    });
    expect(verdict.findings[0]?.message).toContain('4200');
    expect(verdict.findings[0]?.message).toContain('4096');
  });

  it('warns without rejecting on an advisory limit', () => {
    const verdict = checkLimits(descriptor, 'hero_headline', 'x'.repeat(80));
    expect(verdict.ok).toBe(true);
    expect(verdict.findings[0]).toMatchObject({ severity: 'warning', length: 80, max: 60 });
  });

  it('says nothing about a value inside its limit, or a key with no limit', () => {
    expect(checkLimits(descriptor, 'hero_headline', 'short').findings).toEqual([]);
    expect(checkLimits(descriptor, 'blog_intro', 'x'.repeat(9000)).findings).toEqual([]);
  });

  it('names the list entry that overruns, not just the key holding it', () => {
    const capped = mutable(descriptor);
    capped.keys['footer_links']!.limits = { max: 40, severity: 'hard' };
    const verdict = checkLimits(capped, 'footer_links', ['Pricing', 'x'.repeat(90)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({
      rule: 'limit',
      severity: 'error',
      key: 'footer_links[1]',
      length: 90,
      max: 40,
    });
  });

  it('names the record field that overruns', () => {
    const capped = mutable(descriptor);
    capped.keys['contact_form_labels']!.limits = { max: 5, severity: 'advisory' };
    const verdict = checkLimits(capped, 'contact_form_labels', {
      name: 'Name',
      email: 'Email address',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ severity: 'warning', key: 'contact_form_labels.email' });
  });

  it('exempts the shapes with no length semantics — enum, number and color', () => {
    const capped = mutable(descriptor);
    capped.keys['theme_mode']!.limits = { max: 1, severity: 'hard' };
    capped.keys['brand__radius']!.limits = { max: 0, severity: 'hard' };
    capped.keys['brand__primary']!.limits = { max: 3, severity: 'hard' };
    expect(checkLimits(capped, 'theme_mode', 'system').findings).toEqual([]);
    expect(checkLimits(capped, 'brand__radius', 8).findings).toEqual([]);
    expect(checkLimits(capped, 'brand__primary', '#1d4ed8').findings).toEqual([]);
  });

  it('walks top-level fields only — a nested structure carries no limit, by decision', () => {
    const capped = mutable(descriptor);
    capped.keys['contact_form_labels']!.limits = { max: 5, severity: 'hard' };
    const nested = { email: { headline: 'x'.repeat(10000) } };

    // The documented boundary, asserted so it stays a decision rather than a
    // belief: the record shape is `z.record(z.string(), z.unknown())`, so a
    // field holding an object passes the shape check, and phase 1's walk does
    // not descend into it. Nothing upstream is catching this — the validation
    // spec says so in as many words.
    expect(shapeSchema(capped, 'contact_form_labels').safeParse(nested).success).toBe(true);
    expect(checkLimits(capped, 'contact_form_labels', nested).findings).toEqual([]);
  });

  it('still rejects an over-long richtext value — a live hard gate the walk must not lose', () => {
    const capped = mutable(descriptor);
    capped.keys['blog_intro']!.limits = { max: 10, severity: 'hard' };
    const verdict = checkLimits(capped, 'blog_intro', 'x'.repeat(20));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({ key: 'blog_intro', length: 20, max: 10 });
  });
});

describe('checkVars', () => {
  it('rejects a typo, naming it, before any store write', () => {
    const withTrialEnd = mutable(descriptor);
    withTrialEnd.keys['welcome__body']!.vars = ['trial_end'];
    const verdict = checkVars(withTrialEnd, 'welcome__body', 'Your trial ends {{trialEnd}}.');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({ rule: 'vars', severity: 'error', vars: ['trialEnd'] });
    expect(verdict.findings[0]?.message).toContain('trialEnd');
  });

  it('names every unknown variable, not the first', () => {
    const verdict = checkVars(descriptor, 'welcome__body', '{{handle}} {{plan}} {{price}}');
    expect(verdict.findings[0]?.vars).toEqual(['plan', 'price']);
  });

  it('accepts a declared variable, with or without padding', () => {
    expect(checkVars(descriptor, 'welcome__body', 'Hi {{handle}} and {{ handle }}').ok).toBe(true);
  });

  it('catches an undeclared variable inside a list entry, naming the entry', () => {
    const verdict = checkVars(descriptor, 'footer_links', ['Pricing', 'Ask {{nope}}']);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({
      rule: 'vars',
      severity: 'error',
      key: 'footer_links[1]',
      vars: ['nope'],
    });

    // And it blocks the save, which is the point: an error-severity gate a
    // `text` value cannot pass must not be passable by the same string in a
    // list.
    expect(validateSave(descriptor, { key: 'footer_links', value: ['Ask {{nope}}'] }).ok).toBe(false);
  });

  it('catches one inside a record field too, naming the field', () => {
    const verdict = checkVars(descriptor, 'contact_form_labels', {
      name: 'Name',
      email: 'Email {{nope}}',
    });
    expect(verdict.findings[0]).toMatchObject({
      key: 'contact_form_labels.email',
      vars: ['nope'],
    });
  });
});

describe('checkClassRules', () => {
  it('rejects a marketing template with no unsubscribe anywhere in scope', () => {
    const siblings = { newsletter__subject: 'August', newsletter__body: 'No token here.' };
    const verdict = checkClassRules(descriptor, 'newsletter', siblings);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({ rule: 'class', severity: 'error', key: 'newsletter' });
    expect(verdict.findings[0]?.message).toContain('unsubscribe_url');

    // Both rules report: the gate and the postal line are independent, so a
    // template missing both hears about both rather than one at a time.
    expect(verdict.findings.map((f) => `${f.rule}/${f.severity}`)).toEqual([
      'class/error',
      'class/warning',
    ]);
  });

  it('warns — never blocks — where no postal carrier is in scope', () => {
    const siblings = {
      newsletter__subject: 'August',
      newsletter__body: 'Read on. {{unsubscribe_url}}',
    };
    const verdict = checkClassRules(descriptor, 'newsletter', siblings);

    // The unsubscribe gate passed, so the save proceeds: stet can verify an
    // address exists, it cannot conjure one.
    expect(verdict.ok).toBe(true);
    expect(verdict.findings.map((f) => `${f.rule}/${f.severity}`)).toEqual(['class/warning']);
    expect(verdict.findings[0]).toMatchObject({ key: 'newsletter' });

    // The message names both carriers, because either one satisfies the rule.
    expect(verdict.findings[0]?.message).toContain('postal_address');
    expect(verdict.findings[0]?.message).toContain('brand__footer_address');
  });

  it('takes the wrapper claim, and takes a resolved brand value, and takes neither blank', () => {
    // The wrapper carries it: silent, the majority case for a host whose frame
    // owns the footer.
    const wrapped = mutable(descriptor);
    wrapped.templates!['welcome']!.wrapperProvides = ['unsubscribe_url', 'postal_address'];
    expect(checkClassRules(wrapped, 'welcome', {})).toEqual({ ok: true, findings: [] });

    // A brand value in scope: silent too, on the same rule.
    expect(
      checkClassRules(descriptor, 'welcome', { brand__footer_address: '12 Example Street' }),
    ).toEqual({ ok: true, findings: [] });

    // Whitespace is not an address. The gate still passes — the wrapper carries
    // the unsubscribe — and the postal line still warns.
    const blank = checkClassRules(descriptor, 'welcome', { brand__footer_address: '   ' });
    expect(blank.ok).toBe(true);
    expect(blank.findings.map((f) => `${f.rule}/${f.severity}`)).toEqual(['class/warning']);
  });

  it('never checks the postal line on a transactional template', () => {
    // Scope is the marketing branch's: CAN-SPAM's postal requirement is about
    // commercial mail, and a receipt with no address in scope is silent.
    const verdict = checkClassRules(descriptor, 'receipt', {
      receipt__subject: 'Your receipt',
      receipt__body: 'You paid {{amount}}.',
    });
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it('passes a marketing template whose wrapper carries it — the majority case', () => {
    const siblings = siblingsOf('welcome');
    expect(Object.values(siblings).join(' ')).not.toContain('unsubscribe_url');
    expect(checkClassRules(descriptor, 'welcome', siblings)).toEqual({ ok: true, findings: [] });
  });

  it('passes when the token rides a sibling slot resolved from the snapshot', () => {
    const siblings = siblingsOf('newsletter');
    expect(siblings['newsletter__body']).toContain('{{unsubscribe_url}}');
    expect(checkClassRules(descriptor, 'newsletter', siblings).ok).toBe(true);
  });

  it('warns — never rejects — on promotional wording in a transactional template', () => {
    const siblings = {
      ...siblingsOf('receipt'),
      receipt__subject: 'Your receipt, plus 20% off',
      receipt__body: 'You paid {{amount}}. Ask about our sale.',
    };
    const verdict = checkClassRules(descriptor, 'receipt', siblings);
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toHaveLength(2);
    expect(verdict.findings[0]?.slot).toBe('subject');
    expect(verdict.findings.every((f) => f.severity === 'warning')).toBe(true);
  });

  it('leaves "turn off notifications" alone: off is not a promotion', () => {
    const siblings = { ...siblingsOf('receipt'), receipt__body: 'You can turn off notifications.' };
    expect(checkClassRules(descriptor, 'receipt', siblings).findings).toEqual([]);
  });

  it('reports a template it does not know rather than passing it silently', () => {
    expect(checkClassRules(descriptor, 'nope', {}).ok).toBe(false);
  });
});

describe('checkBudget', () => {
  it('warns on the device that overshoots hardest, and never blocks', () => {
    const advisory = checkBudget(descriptor, 'hero_headline', 'x'.repeat(100));
    expect(advisory).toMatchObject({
      rule: 'budget',
      severity: 'warning',
      key: 'hero_headline',
      device: 'mobile',
      estimate: 5,
      budget: 3,
    });
    expect(advisory?.message).toContain('estimate');
  });

  it('reports desktop when desktop is the device over budget', () => {
    const tight = mutable(descriptor);
    tight.keys['hero_headline']!.budget = { desktop: 1, mobile: 10 };
    expect(checkBudget(tight, 'hero_headline', 'x'.repeat(100))).toMatchObject({
      device: 'desktop',
      estimate: 3,
      budget: 1,
    });
  });

  it('gives no verdict to a value inside budget, or to a key without one', () => {
    expect(checkBudget(descriptor, 'hero_headline', 'Never miss a post again.')).toBeNull();
    expect(checkBudget(descriptor, 'hero_body', 'x'.repeat(5000))).toBeNull();
  });

  it('counts the line breaks the operator typed, short as those lines are', () => {
    // Three tiny segments: on width alone this is one line and invisible.
    expect(checkBudget(descriptor, 'hero_headline', 'a\nb\nc')).toMatchObject({
      device: 'desktop',
      estimate: 3,
      budget: 2,
    });
  });

  it('spends no line on the trailing newline a file-authored value carries', () => {
    const tight = mutable(descriptor);
    tight.keys['hero_headline']!.budget = { desktop: 1 };

    // `draft --value-file` takes the file's bytes verbatim, and every POSIX
    // editor ends a file with a newline. That is a terminator, not a line.
    expect(checkBudget(tight, 'hero_headline', 'one\ntwo')).toMatchObject({ estimate: 2 });
    expect(checkBudget(tight, 'hero_headline', 'one\ntwo\n')).toMatchObject({ estimate: 2 });

    // One is dropped, not all: a blank line the operator typed is content.
    expect(checkBudget(tight, 'hero_headline', 'one\ntwo\n\n')).toMatchObject({ estimate: 3 });
  });

  it('counts a CRLF value as its LF twin — a carriage return is not width', () => {
    const tight = mutable(descriptor);
    tight.keys['hero_headline']!.budget = { mobile: 1 };

    // Exactly the 20-character mobile line: counting the `\r` toward width
    // would tip this segment to 2 lines and the value to 3.
    expect(checkBudget(tight, 'hero_headline', `${'x'.repeat(20)}\nshort`)).toMatchObject({
      device: 'mobile',
      estimate: 2,
    });
    expect(checkBudget(tight, 'hero_headline', `${'x'.repeat(20)}\r\nshort`)).toMatchObject({
      device: 'mobile',
      estimate: 2,
    });
  });

  it('still estimates a richtext value — the other live path through the rewire', () => {
    const budgeted = mutable(descriptor);
    budgeted.keys['blog_intro']!.budget = { desktop: 1 };
    expect(checkBudget(budgeted, 'blog_intro', 'x'.repeat(100))).toMatchObject({
      device: 'desktop',
      estimate: 3,
      budget: 1,
    });
  });

  it('estimates an unshipped target under web metrics, and says which metrics it used', () => {
    // Synthesized rather than mutated: no fixture key carries both an unshipped
    // target and a budget, and the disclosure is the whole point of the case.
    const unshipped: Descriptor = {
      version: 1,
      keys: {
        blast__subject: { shape: 'text', target: 'telegram-md2', budget: { desktop: 1 } },
      },
    };
    const advisory = checkBudget(unshipped, 'blast__subject', 'x'.repeat(100));
    expect(advisory).toMatchObject({ device: 'desktop', estimate: 3, budget: 1 });
    expect(advisory?.message).toContain('web metrics — telegram-md2 adapter not shipped');

    // The disclosure is structural as well as prose: a consumer reads the field
    // rather than parsing the sentence.
    expect(advisory?.metricsFrom).toBe('web');

    // A shipped target discloses nothing: there is nothing to disclose.
    const shipped = checkBudget(descriptor, 'hero_headline', 'x'.repeat(100));
    expect(shipped?.message).not.toContain('not shipped');
    expect(shipped?.metricsFrom).toBe('web');
  });

  it('estimates an email key under email metrics, with nothing to disclose', () => {
    // The other side of the same field: the key's own adapter is shipped, so
    // the estimate is the email adapter's 37/20 and the message stays quiet.
    const budgeted = mutable(descriptor);
    budgeted.keys['welcome__subject']!.budget = { desktop: 1 };
    const advisory = checkBudget(budgeted, 'welcome__subject', 'x'.repeat(100));
    expect(advisory).toMatchObject({
      device: 'desktop',
      estimate: 3,
      budget: 1,
      metricsFrom: 'html-email',
    });
    expect(advisory?.message).not.toContain('not shipped');
  });
});

describe('the target registry', () => {
  it('answers its own rows only — a prototype name is not an adapter', () => {
    // A plain object resolves every `Object.prototype` name, so an unguarded
    // lookup hands back `Object.prototype` for `__proto__` and `Function` for
    // `constructor` — and the throwing form stops throwing for exactly the
    // names it most needs to reject. Unreachable from committed content (the
    // schema enum rejects them), reachable through the public export.
    const forged = (name: string): Target => name as unknown as Target;
    expect(targetAdapterIfShipped(forged('__proto__'))).toBeUndefined();
    expect(targetAdapterIfShipped(forged('constructor'))).toBeUndefined();
    expect(targetAdapterIfShipped(forged('toString'))).toBeUndefined();
    expect(() => targetAdapter(forged('toString'))).toThrowError(/toString/);
    expect(() => targetAdapter(forged('__proto__'))).toThrowError(/__proto__/);
  });
});

describe('the web target', () => {
  it('encodes the five HTML-significant characters, ampersand first', () => {
    expect(webTarget.escape('&')).toBe('&amp;');
    expect(webTarget.escape('<')).toBe('&lt;');
    expect(webTarget.escape('>')).toBe('&gt;');
    expect(webTarget.escape('"')).toBe('&quot;');
    expect(webTarget.escape("'")).toBe('&#39;');

    // The discriminating input: with the ampersand escaped last, the entities
    // written by the earlier replacements are re-encoded and this reads
    // `&amp;lt;script&amp;gt;` on the page.
    expect(webTarget.escape('<script>')).toBe('&lt;script&gt;');
  });

  it('is inert in HTML text and quoted attributes — the two contexts it serves', () => {
    expect(webTarget.escape('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');

    // The boundary the contract names, asserted rather than implied: this does
    // NOT make a value safe for an unquoted attribute (a space ends the value)
    // or for a URL (the scheme is untouched). A test claiming otherwise would
    // be the over-claim the documentation exists to prevent.
    expect(webTarget.escape('x onmouseover=alert(1)')).toBe('x onmouseover=alert(1)');
    expect(webTarget.escape('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('is byte-faithful to stored text: an entity in the value is text, not markup', () => {
    expect(webTarget.escape('&lt;')).toBe('&amp;lt;');
  });

  it('carries the line metrics and declares no illegal constructs', () => {
    expect(webTarget.charsPerLine).toEqual({ desktop: 40, mobile: 20 });
    expect(webTarget.illegalConstructs('<script>alert(1)</script>', 'hero_headline')).toEqual([]);
  });
});

/**
 * The ruled construct table, whole. Every row here was executed before the rule
 * was pinned, and the three properties it proves are the reason the naive
 * any-angle-bracket form was rejected: ordinary transactional copy passes, an
 * unterminated open still blocks, and the parser-relevant aliases the WHATWG
 * index omits are caught.
 */
const BLOCKED = [
  // Plain element opens and closes, terminated.
  '<b>',
  '</b>',
  '<a href="x">',
  '<br/>',
  'a<b>c',
  '<B>',
  '<!-- <b>x</b> -->',
  // Unterminated: the string shell supplies the closing bracket itself.
  '<script src="//evil.example"',
  '<img src=x onerror=alert(1)',
  '<a href=',
  '<iframe',
  // Parser-relevant names a modern element index leaves out.
  '<image src=x onerror=alert(1)',
  '<plaintext>',
  '<xmp>',
  '<listing>',
  '<noembed>',
  '<frameset onload=alert(1)',
  '<animate onbegin=alert(1)',
  '<set attributeName=onmouseover',
  '<use href=#x',
  '<foreignObject>',
  '<portal src=//evil',
  '<search>',
  '<fencedframe>',
  '<mglyph>',
  '<malignmark>',
  // Custom-element-shaped: any hyphenated name is markup by the model's own
  // definition.
  '<my-widget onclick=alert(1)>',
  '<annotation-xml>',
  '<x-foo>',
  '<My-Widget>',
  // The documented false-positive classes, asserted so they stay a decision:
  // an element-named local part …
  '<a@x.com>',
  '<em@x.com>',
  'Write to <mark@example.com> with questions.',
  'Reply to <address@acme.com>',
  // … an element-named placeholder …
  'Sent on <Time>.',
  'Ship to <Address>.',
  '<use this link>',
  '<set aside>',
  // … and the product's own hyphenated vocabulary.
  '<e-mail>',
  '<well-known issue>',
];

const PASSED = [
  '5 < 6 and 7 > 3',
  '{{unsubscribe_url}}',
  'i <3 u',
  'plain text',
  'You paid {{amount}}. Reply to <support@mirra.to>.',
  'Sign off as <Your Name>.',
  'Questions? Write <hello@example.com>',
  'Deadline <today> only',
  'Ranges: 5<x and y>9 are fine',
  '<supporters unite>',
  '<scripted reminder>',
  '< b>',
  '<\nb>',
  '<!--[if mso]>',
  'Sent <Date>',
  '<support@>',
  '<user@x.com>',
  '<settings saved>',
  '<searching for>',
  '<x - y>',
  '<3-2-1 go>',
];

describe('the html-email target', () => {
  it('escapes exactly what web escapes, ampersand first', () => {
    expect(htmlEmailTarget.escape('&')).toBe('&amp;');
    expect(htmlEmailTarget.escape('<')).toBe('&lt;');
    expect(htmlEmailTarget.escape('>')).toBe('&gt;');
    expect(htmlEmailTarget.escape('"')).toBe('&quot;');
    expect(htmlEmailTarget.escape("'")).toBe('&#39;');

    // The order discriminator: escaping the ampersand last re-encodes the
    // entities the earlier replacements wrote.
    expect(htmlEmailTarget.escape('<script>')).toBe('&lt;script&gt;');
  });

  it('produces byte-identical output to web — the coincidence, made visible', () => {
    // An email client renders HTML, so the tables coincide today. They are
    // deliberately not shared code: telegram-md2's is a different table
    // entirely, and hoisting now couples the pair the day email needs an
    // entity web does not. This assertion is what makes the coincidence a
    // checked fact rather than a claim in a comment.
    for (const probe of ['&', '<b>&"\'', 'Tom & Jerry <3', '&lt;', 'plain text']) {
      expect(`${probe}: ${htmlEmailTarget.escape(probe)}`).toBe(`${probe}: ${webTarget.escape(probe)}`);
    }
  });

  it('carries the email-safe line metrics', () => {
    expect(htmlEmailTarget.charsPerLine).toEqual({ desktop: 37, mobile: 20 });
  });

  it('blocks every known-or-custom element open, terminated or not', () => {
    for (const value of BLOCKED) {
      const findings = htmlEmailTarget.illegalConstructs(value, 'welcome__body');
      expect(`${JSON.stringify(value)}: ${findings.length}`).toBe(`${JSON.stringify(value)}: 1`);
    }
  });

  it('passes prose, addresses, placeholders and variables', () => {
    for (const value of PASSED) {
      const findings = htmlEmailTarget.illegalConstructs(value, 'welcome__body');
      expect(`${JSON.stringify(value)}: ${findings.length}`).toBe(`${JSON.stringify(value)}: 0`);
    }
  });

  it('files one finding per offending string, entry-pathed, naming the fix', () => {
    const findings = htmlEmailTarget.illegalConstructs('<b>bold</b> and <i>more</i>', 'footer_links[2]');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'construct',
      severity: 'error',
      key: 'footer_links[2]',
    });
    expect(findings[0]?.message).toContain('footer_links[2]');
    expect(findings[0]?.message).toContain('render shell');
    // The message names the adapter it came from, and never a hard-coded one.
    expect(findings[0]?.message).toContain(htmlEmailTarget.name);
  });

  it('rejects a save through the walker, naming the list entry that carries the tag', () => {
    // The entry-path feed built with the seam, first exercised here: a tag
    // hiding inside a list entry blocks the save exactly as it would in a text
    // value, and the finding names the entry an operator has to fix.
    const emailList = mutable(descriptor);
    emailList.keys['footer_links']!.target = 'html-email';
    const verdict = validateSave(emailList, {
      key: 'footer_links',
      value: ['Privacy', 'Read the <b>terms</b>'],
    });
    expect(verdict.ok).toBe(false);
    const construct = verdict.findings.find((f) => f.rule === 'construct');
    expect(construct).toMatchObject({ severity: 'error', key: 'footer_links[1]' });
  });
});

describe('validateSave', () => {
  it('passes a save that breaks nothing', () => {
    expect(
      validateSave(descriptor, { key: 'hero_headline', value: 'Mirror your posts.' }),
    ).toEqual({ ok: true, findings: [] });
  });

  it('composes limits, variables, class rules and budget, errors before warnings', () => {
    const verdict = validateSave(descriptor, {
      key: 'hero_headline',
      value: `${'x'.repeat(100)} {{nope}}`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.rule)).toEqual(['vars', 'limit', 'budget']);
    expect(verdict.findings.map((f) => f.severity)).toEqual(['error', 'warning', 'warning']);
  });

  it('holds no rule over a key the descriptor does not declare', () => {
    // The scope boundary, pinned so it is observable rather than incidental.
    // Per the validation spec's vars requirement: "A key with no descriptor
    // entry is outside this rule's scope, as it is outside every save rule's —
    // the descriptor entry is what binds rules to a candidate, and unknown keys
    // are refused upstream before validation" (`stet draft` rejects one at
    // cli/write.ts before any check runs).
    expect(validateSave(descriptor, { key: 'no_such_key', value: 'anything at all' })).toEqual({
      ok: true,
      findings: [],
    });

    // Including the placeholder that would be an error-severity rejection on
    // any declared key: with no declared set to measure against, there is no
    // rule to break.
    expect(validateSave(descriptor, { key: 'no_such_key', value: 'Hi {{foo}}' })).toEqual({
      ok: true,
      findings: [],
    });
  });

  it('runs the class rule for a slot key, with the candidate merged into its siblings', () => {
    const siblings = siblingsOf('newsletter');
    const stripped = validateSave(
      descriptor,
      { key: 'newsletter__body', value: 'A body with no way out.' },
      siblings,
    );
    expect(stripped.ok).toBe(false);
    expect(stripped.findings[0]?.rule).toBe('class');

    const kept = validateSave(
      descriptor,
      { key: 'newsletter__body', value: 'Read on. {{unsubscribe_url}}' },
      siblings,
    );
    expect(kept.ok).toBe(true);
  });

  it('leaves a non-slot key out of the class rules entirely', () => {
    expect(templateOf(descriptor, 'hero_headline')).toBeNull();
    expect(templateOf(descriptor, 'welcome__subject')).toBe('welcome');
  });
});

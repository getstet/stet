import { describe, expect, it } from 'vitest';

import { miniDescriptor, miniSnapshot, mutable } from '../conformance/fixture.js';
import { SEO_SEVERITY, seoCheck } from '../src/index.js';
import type { Descriptor, SeoFinding, SeoRule, Snapshot } from '../src/index.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();

/** A copy each case breaks. The committed fixture is seo-clean and stays that way. */
function copies(): { d: Descriptor; s: Snapshot } {
  return { d: mutable(descriptor), s: mutable(snapshot) };
}

function rules(findings: SeoFinding[]): SeoRule[] {
  return findings.map((f) => f.rule);
}

/** The findings of one rule — every case asserts on its own rule, not on a total. */
function only(findings: SeoFinding[], rule: SeoRule): SeoFinding[] {
  return findings.filter((f) => f.rule === rule);
}

describe('the severity table', () => {
  it('is seven errors and two warns, and it is the runtime rule list', () => {
    const errors = Object.keys(SEO_SEVERITY).filter((r) => SEO_SEVERITY[r as SeoRule] === 'error');
    const warns = Object.keys(SEO_SEVERITY).filter((r) => SEO_SEVERITY[r as SeoRule] === 'warning');
    expect(errors.sort()).toEqual([
      'canonical-noindex',
      'duplicate-title',
      'missing-alt',
      'missing-description',
      'missing-title',
      'over-length',
      'visible-content',
    ]);
    expect(warns.sort()).toEqual(['anchor-text', 'machine-field']);
  });
});

describe('seoCheck', () => {
  it('finds nothing in the fixture — the clean baseline every case is measured against', () => {
    expect(seoCheck(descriptor, snapshot)).toEqual([]);
  });

  it('takes no rows and reaches no store: the same answer with a snapshot alone', () => {
    // The signature admits no rows at all. What this pins is that the whole
    // check is a function of two committed files, which is the offline claim.
    expect(seoCheck(mutable(descriptor), mutable(snapshot))).toEqual([]);
  });

  it('errors on a page with no description reference at all', () => {
    const { d, s } = copies();
    delete d.pages?.['pricing']?.seo?.description;
    const findings = only(seoCheck(d, s), 'missing-description');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.page).toBe('pricing');
    expect(findings[0]?.message).toContain('declares no SEO description');
  });

  it('errors on a description reference that resolves to whitespace', () => {
    const { d, s } = copies();
    s['default']!['seo_pricing_desc'] = '   ';
    const findings = only(seoCheck(d, s), 'missing-description');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe('seo_pricing_desc');
    expect(findings[0]?.message).toContain('resolves to nothing');
  });

  it('errors when a derivation template pushes a valid headline over the title bound', () => {
    const { d, s } = copies();
    // The headline itself is inside its own 60-character limit; the template
    // adds the eight characters that break it — the bug no crawler could
    // attribute, because no crawler sees the template.
    s['default']!['hero_headline'] = 'x'.repeat(55);
    const findings = only(seoCheck(d, s), 'over-length');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.page).toBe('home');
    expect(findings[0]?.key).toBe('seo_home_title');
    expect(findings[0]?.message).toContain('63 characters');
    expect(findings[0]?.message).toContain('60-character');
  });

  it('errors on a description over 160 characters', () => {
    const { d, s } = copies();
    s['default']!['seo_home_desc'] = 'y'.repeat(161);
    const findings = only(seoCheck(d, s), 'over-length');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('161 characters');
    expect(findings[0]?.message).toContain('160-character');
  });

  it('blames the template once when every colliding page derives through it', () => {
    const { d, s } = copies();
    d.keys['seo_pricing_title']!.derivesFrom = 'hero_headline';
    d.keys['seo_pricing_title']!.tmpl = '{v} — Mirra';
    const findings = only(seoCheck(d, s), 'duplicate-title');
    // One finding for two pages — the property that makes forty pages one bug.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('{v} — Mirra');
    expect(findings[0]?.message).toContain('2 pages');
    expect(findings[0]?.message).not.toContain('"pricing"');
  });

  it('names the pages when the colliding titles do not share one template', () => {
    const { d, s } = copies();
    delete d.keys['seo_pricing_title']!.derivesFrom;
    delete d.keys['seo_pricing_title']!.tmpl;
    s['default']!['seo_pricing_title'] = 'Never miss a post again. — Mirra';
    const findings = only(seoCheck(d, s), 'duplicate-title');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"home"');
    expect(findings[0]?.message).toContain('"pricing"');
  });

  it('is locale-aware: one page saying the same thing in two locales is not a duplicate', () => {
    const { d, s } = copies();
    d.pages!['home']!.locales = ['default', 'de'];
    s['de']!['hero_headline'] = 'Never miss a post again.';
    // The title resolves identically in both locales, which is a translation
    // that has not happened yet — never two pages competing for one result.
    expect(only(seoCheck(d, s), 'duplicate-title')).toEqual([]);
  });

  it('errors on a canonical pointing at a noindex page, in either robots shape', () => {
    for (const robots of ['noindex, nofollow', ['noindex', 'max-snippet:-1']]) {
      const { d, s } = copies();
      d.keys['seo_home_canonical'] = { shape: 'text', target: 'web', pages: ['home'] };
      d.keys['seo_pricing_robots'] = {
        shape: Array.isArray(robots) ? 'list' : 'text',
        target: 'web',
        pages: ['pricing'],
      };
      d.pages!['home']!.seo!.canonical = 'seo_home_canonical';
      d.pages!['pricing']!.seo!.robots = 'seo_pricing_robots';
      // The trailing slash is trimmed off both sides: one route, either spelling.
      s['default']!['seo_home_canonical'] = '/pricing/';
      s['default']!['seo_pricing_robots'] = robots;

      const findings = only(seoCheck(d, s), 'canonical-noindex');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.page).toBe('home');
      expect(findings[0]?.message).toContain('"pricing"');
    }
  });

  it('leaves a canonical that names no declared page alone — the framework owns computation', () => {
    const { d, s } = copies();
    d.keys['seo_home_canonical'] = { shape: 'text', target: 'web', pages: ['home'] };
    d.pages!['home']!.seo!.canonical = 'seo_home_canonical';
    s['default']!['seo_home_canonical'] = 'https://mirra.to/blog/2026-08-20-launch';
    expect(only(seoCheck(d, s), 'canonical-noindex')).toEqual([]);
  });

  it('errors when JSON-LD binds a key that does not render on the bound page', () => {
    const { d, s } = copies();
    d.pages!['home']!.jsonLd!.bindings['name'] = 'pricing_price';
    const findings = only(seoCheck(d, s), 'visible-content');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.page).toBe('home');
    expect(findings[0]?.key).toBe('pricing_price');
    expect(findings[0]?.message).toContain('"name"');
  });

  it('errors on an OG image with no resolving alt text, and passes one that has it', () => {
    const { d, s } = copies();
    d.pages!['home']!.seo!.ogImage = 'brand__logo';
    const missing = only(seoCheck(d, s), 'missing-alt');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.page).toBe('home');

    d.keys['seo_home_alt'] = { shape: 'text', target: 'web', pages: ['home'] };
    d.pages!['home']!.seo!.ogImageAlt = 'seo_home_alt';
    s['default']!['seo_home_alt'] = 'The Mirra wordmark on a navy field.';
    expect(only(seoCheck(d, s), 'missing-alt')).toEqual([]);
  });

  it('warns on a whole value that IS a generic label, and not on prose containing one', () => {
    const { d, s } = copies();
    s['default']!['footer_links'] = ['Privacy', 'Learn more', 'Read more about how we handle data'];
    const findings = only(seoCheck(d, s), 'anchor-text');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    // Entry-pathed, the same grammar src/validate.ts reports under.
    expect(findings[0]?.key).toBe('footer_links[1]');
  });

  it('leaves a non-web target to the lints that own it', () => {
    const { d, s } = copies();
    s['default']!['welcome__subject'] = 'Click here';
    expect(only(seoCheck(d, s), 'anchor-text')).toEqual([]);
  });

  it('reports one committed value once, however many locales the snapshot carries', () => {
    const { d, s } = copies();
    s['default']!['footer_links'] = ['Click here'];
    // `de` has no footer_links of its own, so the locale chain resolves it to
    // this same value. Without the own-value test it would warn twice.
    const findings = only(seoCheck(d, s), 'anchor-text');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.locale).toBe('default');
  });

  it('still reports a value only one non-default locale carries, attributed to it', () => {
    const { d, s } = copies();
    s['de']!['footer_links'] = ['Hier klicken', 'more'];
    const findings = only(seoCheck(d, s), 'anchor-text');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.locale).toBe('de');
    expect(findings[0]?.key).toBe('footer_links[1]');
  });

  it('warns on incentive text inside a JSON-LD-bound value, naming page, field and key', () => {
    const { d, s } = copies();
    s['default']!['pricing_tier_name'] = 'Premium — buy now';
    const findings = only(seoCheck(d, s), 'machine-field');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.page).toBe('pricing');
    expect(findings[0]?.key).toBe('pricing_tier_name');
    expect(findings[0]?.message).toContain('"name"');
    expect(findings[0]?.message).toContain('buy now');
  });

  it('matches "#1" as a phrase and not as the front of "#16"', () => {
    // The boundary case the per-phrase matcher exists for: `\b` before `#`
    // asserts a preceding word character, so /\b#1\b/ matches nothing at all,
    // while a bare substring test fires on every "#16".
    const hit = copies();
    hit.s['default']!['pricing_tier_name'] = 'The #1 plan';
    expect(rules(seoCheck(hit.d, hit.s))).toContain('machine-field');

    const miss = copies();
    miss.s['default']!['pricing_tier_name'] = 'Plan #16';
    expect(rules(seoCheck(miss.d, miss.s))).not.toContain('machine-field');
  });

  it('leaves a key no page binds into JSON-LD alone', () => {
    const { d, s } = copies();
    s['default']!['blog_intro'] = 'Buy now, while stocks last.';
    expect(only(seoCheck(d, s), 'machine-field')).toEqual([]);
  });

  it('carries the effective severity when an override flips a rule', () => {
    const { d, s } = copies();
    s['default']!['footer_links'] = ['Click here'];
    expect(only(seoCheck(d, s), 'anchor-text')[0]?.severity).toBe('warning');
    expect(only(seoCheck(d, s, { 'anchor-text': 'error' }), 'anchor-text')[0]?.severity).toBe(
      'error',
    );
    // Both directions: an error a project has decided to live with becomes a warn.
    d.pages!['home']!.jsonLd!.bindings['name'] = 'pricing_price';
    expect(
      only(seoCheck(d, s, { 'visible-content': 'warning' }), 'visible-content')[0]?.severity,
    ).toBe('warning');
    // The table itself is untouched — overrides apply per call, never globally.
    expect(SEO_SEVERITY['visible-content']).toBe('error');
  });
});

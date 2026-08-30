import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { miniDescriptor, mutable, readFixture } from '../conformance/fixture.js';
import {
  DESCRIPTOR_SCHEMA,
  DescriptorError,
  checkDescriptorStructure,
  deriveLabel,
  loadDescriptor,
  loadDescriptorWithWarnings,
} from '../src/index.js';
import type { Descriptor } from '../src/index.js';

const raw = () => mutable(readFixture('descriptor.json') as Record<string, never>);

function rejects(document: unknown): DescriptorError {
  try {
    loadDescriptor(document);
  } catch (error) {
    if (error instanceof DescriptorError) return error;
    throw error;
  }
  throw new Error('expected the descriptor to be rejected');
}

describe('the published schema', () => {
  it('is the same document the core validates against', () => {
    const published = readFileSync(new URL('../descriptor.schema.json', import.meta.url), 'utf8');
    expect(published).toBe(`${JSON.stringify(DESCRIPTOR_SCHEMA, null, 2)}\n`);
  });

  it('is draft 2020-12, so a non-JS consumer knows which dialect to use', () => {
    expect(DESCRIPTOR_SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});

describe('loadDescriptor', () => {
  it('accepts the fixture with no warnings', () => {
    const { descriptor, warnings } = loadDescriptorWithWarnings(readFixture('descriptor.json'));
    expect(Object.keys(descriptor.keys).length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  it('rejects an invalid severity, naming the key and the field', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['hero_headline']['limits']['severity'] = 'harsh';
    const error = rejects(document);
    expect(error.path).toBe('keys/hero_headline/limits/severity');
    expect(error.message).toContain('advisory');
    expect(error.message).toContain('hard');
  });

  it('rejects a dangling derivesFrom, naming both keys', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['seo_home_title']['derivesFrom'] = 'hero_headlin';
    const error = rejects(document);
    expect(error.path).toBe('keys/seo_home_title/derivesFrom');
    expect(error.message).toContain('seo_home_title');
    expect(error.message).toContain('hero_headlin');
  });

  it('rejects a derivation template with no {v}', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['seo_home_title']['tmpl'] = 'Mirra';
    const error = rejects(document);
    expect(error.path).toBe('keys/seo_home_title/tmpl');
    expect(error.message).toContain('{v}');
  });

  it('rejects an enum with no value set', () => {
    const document = raw();
    delete (document as Record<string, any>)['keys']['theme_mode']['values'];
    const error = rejects(document);
    expect(error.path).toBe('keys/theme_mode/values');
    expect(error.message).toContain('theme_mode');
  });

  it('rejects a key naming an undeclared page', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['footer_links']['pages'] = ['home', 'about'];
    const error = rejects(document);
    expect(error.path).toBe('keys/footer_links/pages/1');
    expect(error.message).toContain('about');
  });

  it('rejects a JSON-LD binding naming an unknown key', () => {
    const document = raw();
    (document as Record<string, any>)['pages']['pricing']['jsonLd']['bindings']['price'] =
      'pricing_prise';
    const error = rejects(document);
    expect(error.path).toBe('pages/pricing/jsonLd/bindings/price');
    expect(error.message).toContain('pricing_prise');
  });

  it('rejects an SEO reference naming an unknown key, and accepts a good one', () => {
    const document = raw();
    (document as Record<string, any>)['pages']['home']['seo']['description'] = 'seo_home_dsc';
    const error = rejects(document);
    expect(error.path).toBe('pages/home/seo/description');
    expect(error.message).toContain('seo_home_dsc');
    expect(error.message).toContain('description');

    // The fixture's own references resolve — the good case is the baseline.
    expect(loadDescriptor(raw()).pages?.['home']?.seo).toEqual({
      title: 'seo_home_title',
      description: 'seo_home_desc',
    });
  });

  it('warns — never rejects — on an incomplete template slot set', () => {
    const document = raw();
    (document as Record<string, any>)['templates']['welcome']['slots'] = [
      'subject',
      'preheader',
      'body',
      'cta_label',
    ];
    const { warnings } = loadDescriptorWithWarnings(document);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('incomplete_slot_set');
    expect(warnings[0]?.path).toBe('templates/welcome/slots/3');
    expect(warnings[0]?.message).toContain('welcome__cta_label');
  });

  it('reports the failing path for a property the contract does not declare', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['hero_headline']['commit'] = 'row-update';
    const error = rejects(document);
    expect(error.path).toBe('keys/hero_headline/commit');
  });
});

describe('checkDescriptorStructure', () => {
  it('catches an enum with no values in a hand-built descriptor, which never meets the schema', () => {
    const handBuilt: Descriptor = {
      version: 1,
      keys: { theme_mode: { shape: 'enum', target: 'web' } },
    };
    expect(() => checkDescriptorStructure(handBuilt)).toThrowError(DescriptorError);
  });

  it('passes the fixture', () => {
    expect(checkDescriptorStructure(miniDescriptor())).toEqual([]);
  });
});

describe('deriveLabel', () => {
  it('reads a key name as a sentence', () => {
    expect(deriveLabel('hero_headline')).toBe('Hero headline');
  });

  it('drops the template prefix from a slot key', () => {
    expect(deriveLabel('welcome__subject')).toBe('Subject');
    expect(deriveLabel('sender__news__from_name')).toBe('From name');
  });

  it('capitalizes the first word only', () => {
    expect(deriveLabel('seo_home_title')).toBe('Seo home title');
  });
});

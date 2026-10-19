import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { cleanupCliHosts, makeCliHost } from '../conformance/cli-host.js';
import { miniDescriptor, mutable, readFixture } from '../conformance/fixture.js';
import { generateDefaultsModule, generateRegistry, generateResolvedModule } from '../src/codegen.js';
import {
  DESCRIPTOR_SCHEMA,
  DescriptorError,
  checkDescriptorStructure,
  deriveLabel,
  loadDescriptor,
  loadDescriptorWithWarnings,
  loadSnapshot,
} from '../src/index.js';
import type { Descriptor } from '../src/index.js';

afterAll(cleanupCliHosts);

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

  it('accepts a text key declaring placeholder tags', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['hero_headline']['tags'] = 1;
    const { descriptor, warnings } = loadDescriptorWithWarnings(document);
    expect(descriptor.keys['hero_headline']?.tags).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('rejects a tag count below one, naming the key and the field', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['hero_headline']['tags'] = 0;
    const error = rejects(document);
    expect(error.path).toBe('keys/hero_headline/tags');
  });

  it('rejects a non-integer tag count', () => {
    const document = raw();
    (document as Record<string, any>)['keys']['hero_headline']['tags'] = '1';
    const error = rejects(document);
    expect(error.path).toBe('keys/hero_headline/tags');
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

/** A project whose descriptor is `document`, its generated files current, run through `stet check`. */
async function check(document: unknown): Promise<{ code: number; err: string }> {
  const host = makeCliHost({ config: {} });
  writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(document, null, 2));
  try {
    const descriptor = loadDescriptor(document);
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    const registry = generateRegistry(descriptor);
    writeFileSync(join(host.cwd, 'content/keys.ts'), registry.keysTs);
    writeFileSync(join(host.cwd, 'content/stet-env.d.ts'), registry.dts);
    writeFileSync(join(host.cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));
    writeFileSync(join(host.cwd, 'content/resolved.ts'), generateResolvedModule(descriptor, snapshot));
  } catch {
    // A descriptor the loader refuses has no generated files to bring current.
  }
  const code = await host.run('check');
  return { code, err: host.stderr() };
}

describe('a render pointer may frame and fill its markup (journey E19)', () => {
  const MIRRA_POINTER = {
    file: 'lib/email/templates/welcome.ts',
    export: 'welcomeContent',
    sampleProps: {},
    fill: true,
    frame: { file: 'lib/email/templates/base.ts', export: 'baseTemplate', args: ['preheader'] },
  };

  /** The fixture with the welcome template's pointer set to `render`. */
  const withRender = (render: unknown): Record<string, any> => {
    const document = raw() as Record<string, any>;
    document['templates']['welcome']['render'] = render;
    return document;
  };

  it("loads Mirra's pointer, with stet check passing", async () => {
    expect(loadDescriptor(withRender(MIRRA_POINTER)).templates?.['welcome']?.render).toEqual(MIRRA_POINTER);
    expect((await check(withRender(MIRRA_POINTER))).code).toBe(0);
    for (const args of ['$all', undefined]) {
      const frame = args === undefined ? { file: 'b.ts', export: 'f' } : { file: 'b.ts', export: 'f', args };
      expect(() => loadDescriptor(withRender({ ...MIRRA_POINTER, frame }))).not.toThrow();
    }
  });

  it('refuses a frame with no export, a member render does not declare, and one frame does not', async () => {
    const noExport = rejects(withRender({ ...MIRRA_POINTER, frame: { file: 'x.ts' } }));
    expect(noExport.path).toBe('templates/welcome/render/frame/export');
    expect(rejects(withRender({ ...MIRRA_POINTER, wrap: true })).path).toBe('templates/welcome/render/wrap');
    expect(rejects(withRender({ ...MIRRA_POINTER, frame: { ...MIRRA_POINTER.frame, wrap: true } })).path).toBe(
      'templates/welcome/render/frame/wrap',
    );
    expect((await check(withRender({ ...MIRRA_POINTER, frame: { file: 'x.ts' } }))).code).toBe(1);
  });

  it('refuses args that are neither a list of names nor "$all", and a fill that is not a boolean', () => {
    for (const args of ['all', ['a', 'a'], [''], [1]]) {
      expect(() => loadDescriptor(withRender({ ...MIRRA_POINTER, frame: { ...MIRRA_POINTER.frame, args } })), JSON.stringify(args)).toThrow(
        DescriptorError,
      );
    }
    expect(() => loadDescriptor(withRender({ ...MIRRA_POINTER, fill: 'yes' }))).toThrow(DescriptorError);
  });
});

describe('an email slot declares the variables it requires (journey E19)', () => {
  it('accepts requires inside vars', () => {
    const document = raw() as Record<string, any>;
    document['keys']['welcome__body']['requires'] = ['handle'];
    expect(loadDescriptor(document).keys['welcome__body']?.requires).toEqual(['handle']);
  });

  it('refuses requires naming a variable vars does not declare, at the key\'s requires', () => {
    const document = raw() as Record<string, any>;
    document['keys']['welcome__body']['requires'] = ['handle', 'name'];
    const error = rejects(document);
    expect(error.path).toBe('keys/welcome__body/requires');
    expect(error.message).toBe('welcome__body: requires names {{name}}, which vars does not declare');
  });

  it('fails stet check on it, naming the variable', async () => {
    const document = raw() as Record<string, any>;
    document['keys']['welcome__body']['requires'] = ['handle', 'name'];
    const run = await check(document);
    expect(run.code).toBe(1);
    expect(run.err).toContain('welcome__body: requires names {{name}}, which vars does not declare');
  });

  it('refuses it in a hand-built descriptor, which never meets the schema', () => {
    const handBuilt: Descriptor = {
      version: 1,
      keys: { password_reset__body: { shape: 'text', target: 'html-email', vars: ['reset_url'], requires: ['reset_url', 'name'] } },
    };
    expect(() => checkDescriptorStructure(handBuilt)).toThrowError('password_reset__body: requires names {{name}}, which vars does not declare');
  });
});

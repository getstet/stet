/**
 * `stet merge <key> --into <other>` (cli/merge.ts): the leaving key's marks and
 * reads move to the survivor, what derives from it and what names it follows,
 * a locale only it carries is copied, and it goes — the survivor's own entry
 * and values untouched. Plan first; `--write` lands one batch.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { cleanupCliHosts, makeCliHost, makeHtmlHost, type CliHost } from '../conformance/cli-host.js';

afterAll(cleanupCliHosts);

const BUTTON = 'Start a conversation ↗';
/** psyon.ai's shape: the header's button key in three places, the contact button's in one. */
const PAGE = [
  '<!DOCTYPE html>',
  '<html><head><title data-stet="home_page_title">Psyon data partnerships</title></head><body>',
  `<header><a href="#c" data-stet="home_header_link_text">${BUTTON}</a></header>`,
  `<section id="about"><a href="#c" data-stet="home_header_link_text">${BUTTON}</a></section>`,
  `<section id="contact"><a href="#c" data-stet="home_contact_link_text">${BUTTON}</a></section>`,
  `<footer><a href="#c" data-stet="home_header_link_text">${BUTTON}</a></footer>`,
  '</body></html>',
  '',
].join('\n');
const FORMS = ['content/descriptor.json', 'content/defaults.json', 'index.html'];

async function psyon(opts: { keys?: Record<string, unknown>; defaults?: Record<string, unknown>; page?: string; pages?: unknown } = {}): Promise<CliHost> {
  const host = await makeHtmlHost({
    files: { 'index.html': opts.page ?? PAGE },
    keys: {
      home_page_title: { shape: 'text', target: 'web' },
      home_header_link_text: { shape: 'text', target: 'web', section: 'header', label: 'Header button', pages: ['home'] },
      home_contact_link_text: { shape: 'text', target: 'web', section: 'contact' },
      ...opts.keys,
    },
    defaults: { home_page_title: 'Psyon data partnerships', home_header_link_text: BUTTON, home_contact_link_text: BUTTON, ...opts.defaults },
  });
  const descriptor = JSON.parse(host.file('content/descriptor.json'));
  descriptor.pages = opts.pages ?? { home: { route: '/' } };
  writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
  return host;
}
const bytes = (host: CliHost): string[] => FORMS.map((rel) => host.file(rel));
const keys = (host: CliHost): Record<string, Record<string, unknown>> => JSON.parse(host.file('content/descriptor.json')).keys;
const values = (host: CliHost): Snapshot => JSON.parse(host.file('content/defaults.json'));
const clear = (host: CliHost): void => {
  host.out.length = 0;
  host.err.length = 0;
};

describe('stet merge — the static-HTML host', () => {
  it('plans the one mark, writes nothing, then merges the key in one batch', async () => {
    const host = await psyon();
    const before = bytes(host);
    const survivor = keys(host)['home_header_link_text'];
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text')).toBe(0);
    expect(host.out).toEqual([
      'merge home_contact_link_text into home_header_link_text',
      '  index.html:5 the mark is renamed',
      'merge: run with --write to apply',
    ]);
    expect(bytes(host)).toEqual(before);
    clear(host);
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text', '--write')).toBe(0);
    expect(host.out).toContain('wrote content/descriptor.json, content/defaults.json, index.html: 1 key merged');
    expect(host.out).toContain(
      'commit them together: git commit -m "stet: merge home_contact_link_text into home_header_link_text" -- content/descriptor.json content/defaults.json index.html',
    );
    expect(keys(host)).not.toHaveProperty('home_contact_link_text');
    expect(values(host)['default']).not.toHaveProperty('home_contact_link_text');
    // The survivor's entry, field for field (the writer's serializer orders keys).
    expect(keys(host)['home_header_link_text']).toStrictEqual(survivor);
    expect(values(host)['default']?.['home_header_link_text']).toBe(BUTTON);
    expect(host.file('index.html').match(/data-stet="home_header_link_text"/g)).toHaveLength(4);
    // Byte-identical outside the one renamed attribute value.
    expect(host.file('index.html')).toBe(PAGE.replace('data-stet="home_contact_link_text"', 'data-stet="home_header_link_text"'));
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it('refuses a second --write: the key is gone', async () => {
    const host = await psyon();
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text', '--write')).toBe(0);
    clear(host);
    const before = bytes(host);
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text', '--write')).toBe(1);
    expect(host.err).toEqual(['error: home_contact_link_text: not a key in the descriptor']);
    expect(bytes(host)).toEqual(before);
  });

  it('refuses a difference in a locale both carry, in tags, and a brand key — every problem listed, nothing written', async () => {
    const differ = await psyon();
    const snapshot = values(differ);
    snapshot['de'] = { home_header_link_text: 'Gespräch beginnen ↗', home_contact_link_text: 'Ein Gespräch ↗' };
    writeFileSync(join(differ.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
    const before = bytes(differ);
    expect(await differ.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text', '--write')).toBe(1);
    expect(differ.err).toEqual([
      'error: cannot merge: home_contact_link_text and home_header_link_text differ in de — "Ein Gespräch ↗" and "Gespräch beginnen ↗"',
    ]);
    expect(bytes(differ)).toEqual(before);

    const tagged = await psyon({ keys: { home_contact_link_text: { shape: 'text', target: 'web', tags: 1 } } });
    expect(await tagged.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text')).toBe(1);
    expect(tagged.err).toEqual(['error: cannot merge: home_contact_link_text is tags: 1, home_header_link_text is tags: none']);

    const brand = await psyon({ keys: { brand__name: { shape: 'text', target: 'web' } }, defaults: { brand__name: BUTTON } });
    expect(await brand.run('merge', 'brand__name', '--into', 'home_header_link_text')).toBe(1);
    expect(brand.err).toEqual(['error: cannot rename brand__name: brand__ keys belong to the brand group']);
  });

  it('copies a locale only the leaving key carries, and a derivation and a page reference follow', async () => {
    const page = PAGE.replace(
      '</title></head>',
      `</title><meta property="og:description" content="${BUTTON} today." data-stet-content="home_share_description"></head>`,
    );
    const host = await psyon({
      page,
      keys: { home_share_description: { shape: 'text', target: 'web', derivesFrom: 'home_contact_link_text', tmpl: '{v} today.' } },
      pages: { home: { route: '/', seo: { title: 'home_contact_link_text' } } },
    });
    const snapshot = values(host);
    snapshot['de'] = { home_contact_link_text: 'Gespräch beginnen ↗' };
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text')).toBe(0);
    expect(host.out).toContain('  home_share_description derives from it and follows');
    expect(host.out).toContain('  pages/home/seo/title follows');
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text', '--write')).toBe(0);
    expect(values(host)['de']).toEqual({ home_header_link_text: 'Gespräch beginnen ↗' });
    expect(keys(host)['home_share_description']?.['derivesFrom']).toBe('home_header_link_text');
    expect(JSON.parse(host.file('content/descriptor.json')).pages.home.seo.title).toBe('home_header_link_text');
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it("joins the leaving key's pages onto the survivor's, a page both carry once", async () => {
    const host = await psyon({
      keys: { home_contact_link_text: { shape: 'text', target: 'web', pages: ['about', 'home'] } },
      pages: { home: { route: '/' }, about: { route: '/about' } },
    });
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text', '--write')).toBe(0);
    expect(keys(host)['home_header_link_text']?.['pages']).toEqual(['home', 'about']);
  });

  it("prints remove's line for the store rows where a store is declared", async () => {
    const host = await psyon();
    const config = JSON.parse(host.file('stet.config.json'));
    writeFileSync(join(host.cwd, 'stet.config.json'), JSON.stringify({ ...config, store: { adapter: 'memory' } }, null, 2));
    expect(await host.run('merge', 'home_contact_link_text', '--into', 'home_header_link_text')).toBe(0);
    expect(host.stdout()).toContain('store rows for removed keys are kept — audit names them as orphans');
  });
});

describe('stet merge — a JavaScript host', () => {
  function site(extra = ''): CliHost {
    const host = makeCliHost({ config: { project: 't', managedSurfaces: ['app/**/*.tsx'] } });
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as Descriptor;
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Snapshot;
    for (const key of ['cta_top', 'cta_bottom']) {
      descriptor.keys[key] = { shape: 'text', target: 'web' };
      (snapshot['default'] as Record<string, unknown>)[key] = 'Book a call';
    }
    writeFileSync(join(host.cwd, 'content/descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    const registry = generateRegistry(descriptor);
    writeFileSync(join(host.cwd, 'content/keys.ts'), registry.keysTs);
    writeFileSync(join(host.cwd, 'content/stet-env.d.ts'), registry.dts);
    writeFileSync(join(host.cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));
    const page = join(host.cwd, 'app/page.tsx');
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(
      page,
      "import { copy } from '../lib/content';\n" +
        `export default function Page() {\n  return <main><a>{copy('cta_top')}</a><a>{copy('cta_bottom')}</a></main>;\n}\n${extra}`,
    );
    return host;
  }

  it('rewrites the read with the forms and the codegen trio in one batch', async () => {
    const host = site();
    expect(await host.run('merge', 'cta_bottom', '--into', 'cta_top', '--write')).toBe(0);
    expect(readFileSync(join(host.cwd, 'app/page.tsx'), 'utf8')).toContain("<a>{copy('cta_top')}</a><a>{copy('cta_top')}</a>");
    expect(host.stdout()).toMatch(/wrote .*content\/keys\.ts.*app\/page\.tsx: 1 key merged/);
    expect(JSON.parse(host.file('content/descriptor.json')).keys).not.toHaveProperty('cta_bottom');
  });

  it('refuses --write while a read it cannot rewrite remains', async () => {
    const host = site('export const which = "cta_bottom";\n');
    const before = readFileSync(join(host.cwd, 'app/page.tsx'), 'utf8');
    expect(await host.run('merge', 'cta_bottom', '--into', 'cta_top', '--write')).toBe(1);
    expect(host.stderr()).toContain('app/page.tsx:5 reads "cta_bottom" in a form stet cannot rewrite');
    expect(readFileSync(join(host.cwd, 'app/page.tsx'), 'utf8')).toBe(before);
    expect(JSON.parse(host.file('content/descriptor.json')).keys).toHaveProperty('cta_bottom');
  });
});

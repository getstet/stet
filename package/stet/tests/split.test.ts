/**
 * `stet split <key> <new> --at <file>:<line>` (cli/split.ts): the marks or reads
 * of a key at one line take a new key, which copies the key's entry (its
 * `pages` left out) and its value in every locale; the key's other places keep
 * it. Plan first; `--write` lands the forms and the edit as one batch.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { cleanupCliHosts, makeCliHost, makeHtmlHost, type CliHost } from '../conformance/cli-host.js';

afterAll(cleanupCliHosts);

const KEY = 'home_nav_link_text_3';
const NEW = 'home_footer_link_text_3';
/** psyon.ai's shape: one key marks the nav link (line 4) and the footer link (line 7). */
const PAGE = [
  '<!DOCTYPE html>',
  '<html><head><title data-stet="home_page_title">Psyon</title></head><body>',
  '<nav>',
  `<a href="#s" data-stet="${KEY}">Data sourcing</a>`,
  '</nav>',
  '<footer>',
  `<a href="#s" data-stet="${KEY}">Data sourcing</a>`,
  '</footer>',
  '</body></html>',
  '',
].join('\n');
const FORMS = ['content/descriptor.json', 'content/defaults.json', 'index.html'];

async function psyon(page = PAGE): Promise<CliHost> {
  const host = await makeHtmlHost({
    files: { 'index.html': page },
    keys: {
      home_page_title: { shape: 'text', target: 'web', pages: ['home'] },
      [KEY]: { shape: 'text', target: 'web', section: 'nav', label: 'Nav link', help: 'The third nav link', pages: ['home'] },
    },
    defaults: { home_page_title: 'Psyon', [KEY]: 'Data sourcing' },
  });
  const descriptor = JSON.parse(host.file('content/descriptor.json'));
  descriptor.pages = { home: { route: '/' } };
  writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
  const snapshot = JSON.parse(host.file('content/defaults.json'));
  snapshot['de'] = { [KEY]: 'Datenbeschaffung' };
  writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
  return host;
}
const bytes = (host: CliHost): string[] => FORMS.map((rel) => host.file(rel));
const keys = (host: CliHost): Record<string, Record<string, unknown>> => JSON.parse(host.file('content/descriptor.json')).keys;
const values = (host: CliHost): Snapshot => JSON.parse(host.file('content/defaults.json'));
const clear = (host: CliHost): void => {
  host.out.length = 0;
  host.err.length = 0;
};

describe('stet split — the static-HTML host', () => {
  it('plans the footer mark with a keeps line for the nav, writes nothing, then gives the footer its own key', async () => {
    const host = await psyon();
    const before = bytes(host);
    expect(await host.run('split', KEY, NEW, '--at', 'index.html:7')).toBe(0);
    expect(host.out).toEqual([
      'index.html:7 the mark is renamed; the value "Data sourcing" is copied',
      `index.html:4 keeps ${KEY}`,
      'split: run with --write to give index.html:7 its own key',
    ]);
    expect(host.err).toEqual([]);
    expect(bytes(host)).toEqual(before);
    clear(host);
    expect(await host.run('split', KEY, NEW, '--at', 'index.html:7', '--write')).toBe(0);
    expect(host.out).toContain('wrote content/descriptor.json, content/defaults.json, index.html: index.html:7 has its own key');
    expect(host.out).toContain(
      `commit them together: git commit -m "stet: split ${KEY} — ${NEW} at index.html:7" -- content/descriptor.json content/defaults.json index.html`,
    );
    // One attribute value changes in the document.
    expect(host.file('index.html')).toBe(PAGE.replace(`<a href="#s" data-stet="${KEY}">Data sourcing</a>\n</footer>`, `<a href="#s" data-stet="${NEW}">Data sourcing</a>\n</footer>`));
    // The new key copies the entry without `pages`; the key keeps its own.
    const { pages, ...entry } = keys(host)[KEY] as Record<string, unknown>;
    expect(pages).toEqual(['home']);
    expect(keys(host)[NEW]).toStrictEqual(entry);
    expect(keys(host)[NEW]).not.toHaveProperty('pages');
    expect(values(host)['default']?.[NEW]).toBe('Data sourcing');
    expect(values(host)['de']).toEqual({ [KEY]: 'Datenbeschaffung', [NEW]: 'Datenbeschaffung' });
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it('moves both marks a line holds', async () => {
    const page = PAGE.replace(
      `<a href="#s" data-stet="${KEY}">Data sourcing</a>\n</footer>`,
      `<a href="#s" data-stet="${KEY}">Data sourcing</a> <a href="#t" data-stet="${KEY}">Data sourcing</a>\n</footer>`,
    );
    const host = await psyon(page);
    expect(await host.run('split', KEY, NEW, '--at', 'index.html:7', '--write')).toBe(0);
    const html = host.file('index.html');
    expect(html.split('\n')[6]).toBe(`<a href="#s" data-stet="${NEW}">Data sourcing</a> <a href="#t" data-stet="${NEW}">Data sourcing</a>`);
    expect(html.split('\n')[3]).toBe(`<a href="#s" data-stet="${KEY}">Data sourcing</a>`);
  });

  it('refuses a key with one place, a line holding no mark of it, a declared new name and the key itself — nothing written', async () => {
    const one = await psyon(PAGE.replace(`<a href="#s" data-stet="${KEY}">Data sourcing</a>\n</footer>`, '</footer>'));
    const before = bytes(one);
    expect(await one.run('split', KEY, NEW, '--at', 'index.html:4', '--write')).toBe(1);
    expect(one.err).toEqual([`error: ${KEY} is marked in one place — there is nothing to split`]);
    expect(bytes(one)).toEqual(before);

    const host = await psyon();
    const held = bytes(host);
    expect(await host.run('split', KEY, NEW, '--at', 'index.html:2', '--write')).toBe(1);
    expect(host.err).toEqual([`error: index.html:2 holds no mark or read of ${KEY}`]);
    clear(host);
    expect(await host.run('split', KEY, 'home_page_title', '--at', 'index.html:7', '--write')).toBe(1);
    expect(host.err).toHaveLength(1);
    expect(host.err[0]).toContain('home_page_title');
    clear(host);
    expect(await host.run('split', KEY, KEY, '--at', 'index.html:7')).toBe(1);
    expect(host.err).toEqual([`error: ${KEY}: the new name is the old name — nothing to split`]);
    expect(bytes(host)).toEqual(held);
  });
});

describe('stet split — a JavaScript host', () => {
  /** A Next page reading `home_hero_link_text` at lines 12 and 40, and whatever `extra` adds after. */
  function next(extra: string[] = []): CliHost {
    const host = makeCliHost({ config: { project: 't', managedSurfaces: ['app/**/*.tsx'] } });
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as Descriptor;
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Snapshot;
    descriptor.keys['home_hero_link_text'] = { shape: 'text', target: 'web' };
    (snapshot['default'] as Record<string, unknown>)['home_hero_link_text'] = 'Book a call';
    writeFileSync(join(host.cwd, 'content/descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    const registry = generateRegistry(descriptor);
    writeFileSync(join(host.cwd, 'content/keys.ts'), registry.keysTs);
    writeFileSync(join(host.cwd, 'content/stet-env.d.ts'), registry.dts);
    writeFileSync(join(host.cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));
    const lines = ["import { copy } from '../lib/content';", 'export default function Page() {', '  return (', '    <main>'];
    while (lines.length < 11) lines.push('      <p />');
    lines.push("      <a>{copy('home_hero_link_text')}</a>");
    while (lines.length < 39) lines.push('      <p />');
    lines.push("      <a>{copy('home_hero_link_text')}</a>", '    </main>', '  );', '}', ...extra, '');
    const page = join(host.cwd, 'app/page.tsx');
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, lines.join('\n'));
    return host;
  }
  const lineOf = (host: CliHost, n: number): string => readFileSync(join(host.cwd, 'app/page.tsx'), 'utf8').split('\n')[n - 1] as string;

  it('moves the read at line 40 alone, with the forms and the codegen trio in one batch', async () => {
    const host = next();
    expect(await host.run('split', 'home_hero_link_text', 'home_footer_link_text', '--at', 'app/page.tsx:40')).toBe(0);
    expect(host.out).toEqual([
      'app/page.tsx:40 the read is renamed; the value "Book a call" is copied',
      'app/page.tsx:12 keeps home_hero_link_text',
      'split: run with --write to give app/page.tsx:40 its own key',
    ]);
    clear(host);
    expect(await host.run('split', 'home_hero_link_text', 'home_footer_link_text', '--at', 'app/page.tsx:40', '--write')).toBe(0);
    expect(lineOf(host, 12)).toBe("      <a>{copy('home_hero_link_text')}</a>");
    expect(lineOf(host, 40)).toBe("      <a>{copy('home_footer_link_text')}</a>");
    expect(host.stdout()).toMatch(/wrote .*content\/keys\.ts.*app\/page\.tsx: app\/page\.tsx:40 has its own key/);
    expect(host.file('content/keys.ts')).toContain('home_footer_link_text');
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it('refuses a read at the line in a form stet cannot rewrite', async () => {
    const host = next(['export const which = "home_hero_link_text";']);
    const before = readFileSync(join(host.cwd, 'app/page.tsx'), 'utf8');
    expect(await host.run('split', 'home_hero_link_text', 'home_footer_link_text', '--at', 'app/page.tsx:44', '--write')).toBe(1);
    expect(host.stderr()).toContain('app/page.tsx:44 reads "home_hero_link_text" in a form stet cannot rewrite');
    expect(readFileSync(join(host.cwd, 'app/page.tsx'), 'utf8')).toBe(before);
  });
});

/**
 * `seo check`'s copy-shaped accessibility rules (D6): the five rules read from
 * the managed html documents, the shells' `lang` and each key's places. The
 * document cases call `documentRules` over a page written per case; the exit
 * and the printed lines are read through `stet seo check` itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { defaultConfig, type StetConfig } from '../cli/config.js';
import { documentRules } from '../cli/seo-documents.js';
import { cleanupCliHosts, htmlFixture, makeHtmlHost } from '../conformance/cli-host.js';
import type { SeoFinding, SeoRule } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';

afterAll(cleanupCliHosts);

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-seo-documents-'));
  made.push(dir);
  return dir;
}

const HTML_CONFIG = (): StetConfig => ({ ...defaultConfig(), host: 'html', managedSurfaces: ['**/*.html'] });
const NEXT_CONFIG = (): StetConfig => ({ ...defaultConfig(), managedSurfaces: ['app/**/*.tsx'] });
const NO_KEYS: Descriptor = { version: 1, keys: {} };
const EMPTY: Snapshot = { default: {} };

/** A page in the html shell every case shares, its body the case's own. */
const page = (body: string, lang = ' lang="en"'): string =>
  `<!DOCTYPE html>\n<html${lang}>\n<head><meta charset="utf-8"><title>T</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

/** The findings for one html document written alone in a fresh checkout. */
async function onDocument(html: string, overrides?: Partial<Record<SeoRule, 'error' | 'warning'>>): Promise<SeoFinding[]> {
  const dir = tempDir();
  write(dir, 'index.html', html);
  return documentRules(dir, HTML_CONFIG(), NO_KEYS, EMPTY, overrides);
}

const of = (findings: SeoFinding[], rule: SeoRule): string[] => findings.filter((f) => f.rule === rule).map((f) => f.message);

describe('missing-label (journey C3)', () => {
  it('reports the fixture\'s unlabelled textarea in the name form, and stet seo check exits 1 until it is labelled', async () => {
    const host = await makeHtmlHost();
    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stderr()).toContain(
      'error: index.html:50 <textarea name="notes"> has no label — give it id="notes" and write a <label for="notes">, then run stet register',
    );
    const fixed = await makeHtmlHost({
      files: {
        'index.html': htmlFixture('index.html').replace(
          '<textarea name="notes">',
          '<label for="notes">Notes about the dataset</label>\n      <textarea id="notes" name="notes">',
        ),
      },
    });
    expect(await fixed.run('seo', 'check')).toBe(0);
    expect(fixed.stderr()).not.toContain('missing-label');
    expect(fixed.stderr()).not.toContain('has no label');
  });

  it('names the remedy by what the control carries: an id, a name, or neither', async () => {
    const findings = await onDocument(page('<input id="email" type="email">\n<input name="city">\n<select></select>'));
    expect(of(findings, 'missing-label')).toEqual([
      'index.html:5 <input id="email" type="email"> has no label — write a <label for="email">, then run stet register',
      'index.html:6 <input name="city"> has no label — give it id="city" and write a <label for="city">, then run stet register',
      'index.html:7 <select> has no label — wrap it in a <label>, then run stet register',
    ]);
  });

  it('leaves the controls no label names, and counts a wrapping label, a placeholder and the aria labels', async () => {
    const findings = await onDocument(
      page(
        [
          '<input type="hidden" name="h">',
          '<input type="submit">',
          '<input type="image" src="go.png" alt="Go">',
          '<label>Name <input name="n"></label>',
          '<input name="q" placeholder="Search">',
          '<input name="a" aria-label="Amount">',
          '<span id="l">Label</span><input name="b" aria-labelledby="l">',
          '<input name="c" aria-labelledby="">',
        ].join('\n'),
      ),
    );
    expect(of(findings, 'missing-label')).toEqual([
      'index.html:12 <input name="c" aria-labelledby=""> has no label — give it id="c" and write a <label for="c">, then run stet register',
    ]);
  });
});

describe('missing-name, missing-alt — the verdicts Lighthouse 13.5 gives (journey C3)', () => {
  it('names a link by its image, an icon by its svg title, an aria-labelledby control; only the empty link fails', async () => {
    const findings = await onDocument(
      page(
        [
          '<span id="lbl">Close the dialog</span>',
          '<a href="/"><img src="logo.svg" alt="Home"></a>',
          '<a href="/x"></a>',
          '<button aria-labelledby="lbl"><svg></svg></button>',
          '<a href="/home" aria-labelledby="lbl"><svg></svg></a>',
          '<a href="/y"><svg><title>Home</title></svg></a>',
          '<button><svg><title>Close</title></svg></button>',
          '<img src="chart.png" aria-labelledby="lbl">',
          '<input type="search" name="q" placeholder="Search the site">',
          '<input type="text" name="ghost" role="presentation">',
          '<input type="submit">',
        ].join('\n'),
      ),
    );
    expect(of(findings, 'missing-name')).toEqual(['index.html:7 <a href="/x"> has no accessible name — give it text, or an aria-label']);
    expect(of(findings, 'missing-alt')).toEqual([]);
    expect(of(findings, 'missing-label')).toEqual([
      'index.html:14 <input type="text" name="ghost" role="presentation"> has no label — give it id="ghost" and write a <label for="ghost">, then run stet register',
    ]);
  });

  it('gives the reviewer\'s probe page Lighthouse\'s verdicts: the presentation input alone', async () => {
    const findings = await onDocument(
      page(
        [
          '<main>',
          '<h1>Rules probe</h1>',
          '<span id="lbl">Close the dialog</span>',
          '<button aria-labelledby="lbl"><svg viewBox="0 0 1 1"></svg></button>',
          '<a href="/home" aria-labelledby="lbl"><svg viewBox="0 0 1 1"></svg></a>',
          '<input type="search" name="q" placeholder="Search the site">',
          '<img src="chart.png" aria-labelledby="lbl">',
          '<input type="text" name="ghost" role="presentation">',
          '<button><span class="sr-only">Open the menu</span></button>',
          '<a href="/x"><svg role="img"><title>Home page</title></svg></a>',
          '</main>',
        ].join('\n'),
      ),
    );
    expect(findings.map((f) => f.rule)).toEqual(['missing-label']);
  });

  it('judges no link without an href, names a button by its svg\'s aria-label, and leaves a presentational image', async () => {
    const findings = await onDocument(page('<a></a>\n<button><svg aria-label="Close"></svg></button>\n<img src="x.png" role="presentation">'));
    expect(findings).toEqual([]);
  });

  it('reads alt="" as decorative and an absent alt as a fault', async () => {
    const findings = await onDocument(page('<img src="rule.svg" alt="">\n<img src="x.jpg">'));
    expect(of(findings, 'missing-alt')).toEqual(['index.html:6 <img src="x.jpg"> has no alt — write alt text, or alt="" for a decorative image']);
  });

  it('prints the open tag with stet\'s marks taken out', async () => {
    const findings = await onDocument(page('<a href="/m" data-stet="nav_link_text"></a>'));
    expect(of(findings, 'missing-name')).toEqual(['index.html:5 <a href="/m"> has no accessible name — give it text, or an aria-label']);
  });
});

describe('missing-lang (journey C3)', () => {
  it('passes a tag Lighthouse accepts, bare subtags included, and fails the rest', async () => {
    for (const lang of ['en-GB', 'und']) expect(await onDocument(page('<p>x</p>', ` lang="${lang}"`)), lang).toEqual([]);
    for (const lang of ['en_GB', 'english', 'eng']) {
      expect(of(await onDocument(page('<p>x</p>', ` lang="${lang}"`)), 'missing-lang'), lang).toEqual([`index.html: lang="${lang}" is not a language tag`]);
    }
    expect(of(await onDocument(page('<p>x</p>', '')), 'missing-lang')).toEqual([
      'index.html: <html> has no lang — set language in stet.config.json and run stet audit lighthouse --fix',
    ]);
  });

  it('reads a faulted <html>\'s lang whatever its content holds', async () => {
    const findings = await onDocument(page('<p>a stray close</span></p>', ''));
    expect(of(findings, 'missing-lang')).toEqual([
      'index.html: <html> has no lang — set language in stet.config.json and run stet audit lighthouse --fix',
    ]);
  });

  it('reads a Vite host\'s index.html shell', async () => {
    const dir = tempDir();
    write(dir, 'index.html', '<!doctype html>\n<html>\n<head><title>Vite</title></head>\n<body><div id="root"></div></body>\n</html>\n');
    const findings = await documentRules(dir, { ...defaultConfig(), router: 'vite', managedSurfaces: ['src/**/*.tsx'] }, NO_KEYS, EMPTY, undefined);
    expect(of(findings, 'missing-lang')).toEqual([
      'index.html: <html> has no lang — set language in stet.config.json and run stet audit lighthouse --fix',
    ]);
  });

  it('reads a Next root layout\'s one <html>: no lang, a lang that is no tag, and an expression left alone', async () => {
    const layout = (attr: string): string =>
      `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html${attr}>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
    const run = async (attr: string): Promise<string[]> => {
      const dir = tempDir();
      write(dir, 'app/layout.tsx', layout(attr));
      return of(await documentRules(dir, NEXT_CONFIG(), NO_KEYS, EMPTY, undefined), 'missing-lang');
    };
    expect(await run('')).toEqual(['app/layout.tsx: <html> has no lang — set language in stet.config.json and run stet audit lighthouse --fix']);
    expect(await run(' lang="english"')).toEqual(['app/layout.tsx: lang="english" is not a language tag']);
    expect(await run(' lang={locale}')).toEqual([]);
    expect(await run(' lang="en"')).toEqual([]);
  });
});

describe('empty-heading', () => {
  it('warns on a heading with no text, and not on one an image names', async () => {
    const findings = await onDocument(page('<h2> </h2>\n<h2><img alt="Logo"></h2>'));
    expect(findings.filter((f) => f.rule === 'empty-heading')).toEqual([
      { rule: 'empty-heading', severity: 'warning', message: 'index.html:5 <h2> is empty' },
    ]);
  });
});

describe('the stray tag hides only what it covers', () => {
  it('reports the input in another section, and judges no element placed over the stray tag', async () => {
    const findings = await onDocument(
      page('<section id="a"><a href="/y"></span></a></section>\n<section id="b"><input name="q"></section>'),
    );
    expect(of(findings, 'missing-name')).toEqual([]);
    expect(of(findings, 'missing-label')).toEqual([
      'index.html:6 <input name="q"> has no label — give it id="q" and write a <label for="q">, then run stet register',
    ]);
  });
});

describe('the key rules (journey C3, B17)', () => {
  it('reports an emptied button key on an html host, and an emptied alt key with the html host\'s remove line', async () => {
    const dir = tempDir();
    write(dir, 'index.html', page('<button data-stet="home_page_button_text"></button>\n<img src="bench.jpg" alt="" data-stet-alt="home_page_image_alt">'));
    const descriptor: Descriptor = {
      version: 1,
      keys: { home_page_button_text: { shape: 'text', target: 'web' }, home_page_image_alt: { shape: 'text', target: 'web' } },
    };
    const findings = await documentRules(dir, HTML_CONFIG(), descriptor, { default: { home_page_button_text: '', home_page_image_alt: '' } }, undefined);
    expect(findings.filter((f) => f.key !== undefined)).toEqual([
      {
        rule: 'missing-name',
        severity: 'error',
        key: 'home_page_button_text',
        message: 'home_page_button_text is empty, and it names a button',
      },
      {
        rule: 'missing-alt',
        severity: 'error',
        key: 'home_page_image_alt',
        message: 'home_page_image_alt is empty, and it is an image\'s alt text — write it, or for a decorative image run stet remove home_page_image_alt; the document keeps alt=""',
      },
    ]);
  });

  /** A Next host whose page reads `keys` through the read path, each emptied in the snapshot. */
  async function nextHost(body: string, keys: string[], extra: Record<string, string> = {}): Promise<SeoFinding[]> {
    const dir = tempDir();
    write(
      dir,
      'app/page.tsx',
      `import Image from 'next/image';\nimport Link from 'next/link';\nimport { copy } from '@/lib/content';\n\nexport default function Page() {\n  return (\n    <main>\n${body}\n    </main>\n  );\n}\n`,
    );
    for (const [rel, text] of Object.entries(extra)) write(dir, rel, text);
    const descriptor: Descriptor = { version: 1, keys: Object.fromEntries(keys.map((k) => [k, { shape: 'text', target: 'web' }])) };
    const snapshot: Snapshot = { default: Object.fromEntries(keys.map((k) => [k, ''])) };
    return documentRules(dir, NEXT_CONFIG(), descriptor, snapshot, undefined);
  }

  it('reads an emptied button text key on a JavaScript host as missing-name', async () => {
    const findings = await nextHost("      <button>{copy('home_page_button_text')}</button>", ['home_page_button_text']);
    expect(of(findings, 'missing-name')).toEqual(['home_page_button_text is empty, and it names a button']);
  });

  it('reads next/image\'s Image alt and next/link\'s Link text like img and a, with the JavaScript host\'s alt line', async () => {
    const findings = await nextHost(
      "      <Image src=\"/hero.png\" alt={copy('home_page_image_alt_1')} width={10} height={10} />\n      <Link href=\"/\">{copy('nav_link_text')}</Link>",
      ['home_page_image_alt_1', 'nav_link_text'],
    );
    expect(of(findings, 'missing-alt')).toEqual([
      "home_page_image_alt_1 is empty, and it is an image's alt text — write it, or for a decorative image replace alt={copy('home_page_image_alt_1')} with alt=\"\" and run stet remove home_page_image_alt_1",
    ]);
    expect(of(findings, 'missing-name')).toEqual(['nav_link_text is empty, and it names a link']);
  });

  it('takes no place from a copy() that is not stet\'s, nor from a key read only in a template dialect', async () => {
    const dir = tempDir();
    write(dir, 'app/widget.tsx', "import copy from 'copy-to-clipboard';\n\nexport function Widget() {\n  return <button>{copy('home_page_button_text')}</button>;\n}\n");
    write(dir, 'src/pages/index.astro', "---\nimport { copy } from '@/lib/content';\n---\n<button>{copy('home_page_button_text')}</button>\n");
    const config = { ...NEXT_CONFIG(), managedSurfaces: ['app/**/*.tsx', 'src/**/*.astro'] };
    const descriptor: Descriptor = { version: 1, keys: { home_page_button_text: { shape: 'text', target: 'web' } } };
    const findings = await documentRules(dir, config, descriptor, { default: { home_page_button_text: '' } }, undefined);
    expect(findings).toEqual([]);
  });

  it('warns on alt text that says the obvious, and on alt text that is the file name (journey C3)', async () => {
    const dir = tempDir();
    write(dir, 'index.html', page('<img src="a.jpg" alt="x" data-stet-alt="home_page_image_alt_1">\n<img src="park-bench.jpg" alt="x" data-stet-alt="home_page_image_alt_2">'));
    const descriptor: Descriptor = {
      version: 1,
      keys: { home_page_image_alt_1: { shape: 'text', target: 'web' }, home_page_image_alt_2: { shape: 'text', target: 'web' } },
    };
    const snapshot: Snapshot = { default: { home_page_image_alt_1: 'Photo of the bench', home_page_image_alt_2: 'park bench' } };
    const findings = await documentRules(dir, HTML_CONFIG(), descriptor, snapshot, undefined);
    expect(findings.filter((f) => f.rule === 'redundant-alt')).toEqual([
      {
        rule: 'redundant-alt',
        severity: 'warning',
        key: 'home_page_image_alt_1',
        message: 'home_page_image_alt_1: "Photo of the bench" repeats what a screen reader already says — drop "photo of"',
      },
      { rule: 'redundant-alt', severity: 'warning', key: 'home_page_image_alt_2', message: 'home_page_image_alt_2: "park bench" is the file name' },
    ]);
  });
});

describe('the overrides (journey C3)', () => {
  it('takes missing-lang as a warn and empty-heading as an error, end to end, and refuses an id that is not a rule', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<!DOCTYPE html>\n<html>\n<head><title>T</title></head>\n<body>\n<h2></h2>\n</body>\n</html>\n' },
      config: { seoCheck: { 'missing-lang': 'warn', 'empty-heading': 'error' } },
    });
    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stderr()).toContain('warn: index.html: <html> has no lang — set language in stet.config.json and run stet audit lighthouse --fix');
    expect(host.stderr()).toContain('error: index.html:5 <h2> is empty');
    const wrong = await makeHtmlHost({ config: { seoCheck: { 'missing-labels': 'warn' } } });
    expect(await wrong.run('seo', 'check')).toBe(1);
    expect(wrong.stderr()).toMatch(/seoCheck\.missing-labels is not a rule — declared rules: .*missing-label, missing-lang, missing-name/);
  });
});

describe('without typescript', () => {
  it('reads no JSX place for the key rules, while the html rules still run', async () => {
    vi.resetModules();
    vi.doMock('typescript', () =>
      Promise.reject(Object.assign(new Error("Cannot find package 'typescript'"), { code: 'ERR_MODULE_NOT_FOUND' })),
    );
    try {
      const fresh = await import('../cli/seo-documents.js');
      const js = tempDir();
      write(js, 'app/page.tsx', "import { copy } from '@/lib/content';\nexport default function Page() {\n  return <button>{copy('k')}</button>;\n}\n");
      const descriptor: Descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web' } } };
      expect(await fresh.documentRules(js, NEXT_CONFIG(), descriptor, { default: { k: '' } }, undefined)).toEqual([]);
      const html = tempDir();
      write(html, 'index.html', page('<a href="/x"></a>'));
      expect((await fresh.documentRules(html, HTML_CONFIG(), NO_KEYS, EMPTY, undefined)).map((f) => f.rule)).toEqual(['missing-name']);
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});

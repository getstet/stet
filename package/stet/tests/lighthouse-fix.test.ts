/**
 * `cli/lighthouse-fix.ts` — `planDocumentFix`, the head edits `--fix` plans
 * for one html document: what it inserts, where, in which line ending and
 * indent, and what it leaves.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readDocument } from '../cli/html-host.js';
import { astroFixLines, planDocumentFix, planNextLang, planViteShell, VITE_SHELL_LINE, type DocumentFix } from '../cli/lighthouse-fix.js';
import { applyFileEdits } from '../cli/rewrite.js';
import { loadTypescript } from '../cli/source-scan.js';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'html-host');
const CHARSET = '<meta charset="utf-8">';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

interface Ctx {
  language?: string;
  page?: string | null;
  keys?: string[];
}

function plan(source: string, ctx: Ctx = {}, file = 'a.html'): DocumentFix | { skip: string } {
  return planDocumentFix(readDocument(file, source), {
    ...(ctx.language === undefined ? {} : { language: ctx.language }),
    page: ctx.page === undefined ? null : ctx.page,
    keys: new Set(ctx.keys ?? []),
  });
}

function fixed(source: string, ctx: Ctx = {}): { fix: DocumentFix; text: string } {
  const fix = plan(source, ctx);
  if ('skip' in fix) throw new Error(fix.skip);
  return { fix, text: applyFileEdits(source, fix.edits) };
}

describe('planDocumentFix — edges.html (the C12 scenario)', () => {
  const source = readFileSync(join(HOST, 'edges.html'), 'utf8');

  it('plans the charset, the viewport after it and the description bound to edges_meta_description, and no lang', () => {
    const fix = plan(source, { language: 'en', page: 'edges' }, 'edges.html');
    if ('skip' in fix) throw new Error(fix.skip);
    expect(fix.lines).toEqual([
      `${CHARSET} as the first element of <head>`,
      `${VIEWPORT} after it`,
      '<meta name="description" content="" data-stet-content="edges_meta_description"> — edges is declared as a page and the key is empty until you write it',
    ]);
    expect(fix.edits).toHaveLength(1);
    expect(fix.mints).toEqual([{ key: 'edges_meta_description', role: 'meta_description' }]);
    expect(applyFileEdits(source, fix.edits)).toBe(
      source.replace(
        '<head>\n',
        `<head>\n  ${CHARSET}\n  ${VIEWPORT}\n  <meta name="description" content="" data-stet-content="edges_meta_description">\n`,
      ),
    );
  });

  it('a stray </span> and a never-closed <p> in <body> do not block the head edits', () => {
    const doc = readDocument('edges.html', source);
    expect(doc.faults.length).toBeGreaterThan(0);
    const fix = plan('<html lang="en"><head><title>x</title></head><body><p>a</span></p><p>open</body></html>\n', { language: 'en' });
    expect('skip' in fix).toBe(false);
  });

  it('numbers a mint past a declared key', () => {
    const fix = plan(source, { page: 'edges', keys: ['edges_meta_description'] }, 'edges.html');
    expect('skip' in fix ? [] : fix.mints).toEqual([{ key: 'edges_meta_description_2', role: 'meta_description' }]);
  });
});

describe('planDocumentFix — the head inserts', () => {
  it('lands the charset above the viewport, both as the first elements of <head>', () => {
    const { fix, text } = fixed('<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>T</title>\n</head>\n<body></body>\n</html>\n');
    expect(fix.edits).toHaveLength(1);
    expect(text).toContain(`<head>\n  ${CHARSET}\n  ${VIEWPORT}\n  <title>T</title>`);
  });

  it('puts the viewport right after a charset meta standing second, never above it', () => {
    const { fix, text } = fixed(`<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>T</title>\n  ${CHARSET}\n</head>\n<body></body>\n</html>\n`);
    expect(fix.lines).toEqual([`${VIEWPORT} after the <meta charset>`]);
    expect(text).toContain(`  <title>T</title>\n  ${CHARSET}\n  ${VIEWPORT}\n</head>`);
  });

  it('reads an http-equiv charset as the charset meta', () => {
    const meta = '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    const { fix, text } = fixed(`<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>T</title>\n  ${meta}\n</head>\n<body></body>\n</html>\n`);
    expect(fix.lines).toEqual([`${VIEWPORT} after the <meta charset>`]);
    expect(text).not.toContain(CHARSET);
    expect(text).toContain(`${meta}\n  ${VIEWPORT}`);
  });

  it("follows the indent of <head>'s first child, else <head>'s own plus two spaces", () => {
    expect(fixed('<!DOCTYPE html>\n<html lang="en">\n  <head>\n\t\t<title>T</title>\n  </head>\n</html>\n').text).toContain(`<head>\n\t\t${CHARSET}\n\t\t${VIEWPORT}\n\t\t<title>`);
    expect(fixed('<!DOCTYPE html>\n<html lang="en">\n  <head><title>T</title></head>\n</html>\n').text).toContain(`<head>\n    ${CHARSET}\n    ${VIEWPORT}<title>`);
  });

  it('inserts a title and a description sharing one line where a page has neither', () => {
    const fix = plan('<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width">\n</head>\n</html>\n', { page: 'home' });
    if ('skip' in fix) throw new Error(fix.skip);
    expect(fix.lines).toEqual([
      '<title data-stet="home_page_title"></title> and <meta name="description" content="" data-stet-content="home_meta_description"> — home is declared as a page and its two keys are empty until you write them',
    ]);
    expect(fix.mints.map((m) => m.role)).toEqual(['page_title', 'meta_description']);
  });

  it('mints no key for a document no page maps to', () => {
    const fix = plan('<!DOCTYPE html>\n<html lang="en">\n<head>\n</head>\n</html>\n', { page: null });
    if ('skip' in fix) throw new Error(fix.skip);
    expect(fix.mints).toEqual([]);
    expect(fix.lines).toEqual([`${CHARSET} as the first element of <head>`, `${VIEWPORT} after it`]);
  });
});

describe('planDocumentFix — the doctype and the line endings', () => {
  it('writes the doctype after a BOM, the lang edit, and CRLF throughout on a BOM and CRLF document', () => {
    const source = '﻿<html>\r\n<head>\r\n  <title>T</title>\r\n</head>\r\n<body></body>\r\n</html>\r\n';
    const { fix, text } = fixed(source, { language: 'en-GB' });
    expect(fix.lines).toEqual([
      '<!DOCTYPE html> as the first line',
      `${CHARSET} as the first element of <head>`,
      `${VIEWPORT} after it`,
      'lang="en-GB" on <html> (from language in stet.config.json)',
    ]);
    expect(text.startsWith('﻿<!DOCTYPE html>\r\n<html lang="en-GB">\r\n')).toBe(true);
    expect(text).not.toMatch(/(?<!\r)\n/);
  });

  it('counts a doctype behind an XML declaration as present', () => {
    const fix = plan('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="x"></head></html>\n');
    expect(fix).toEqual({ file: 'a.html', edits: [], lines: [], mints: [] });
  });

  it('counts a doctype behind a comment as present', () => {
    const fix = plan('<!-- built 2026 -->\n<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="x"></head></html>\n');
    expect(fix).toEqual({ file: 'a.html', edits: [], lines: [], mints: [] });
  });
});

describe('planDocumentFix — lang', () => {
  const doc = (html: string): string => `<!DOCTYPE html>\n${html}\n<head><meta charset="utf-8"><meta name="viewport" content="x"></head>\n</html>\n`;

  it('replaces an invalid lang over its value, and leaves lang="und"', () => {
    const source = doc('<html lang="english">');
    expect(fixed(source, { language: 'en' }).text).toBe(source.replace('lang="english"', 'lang="en"'));
    expect(plan(doc('<html lang="und">'), { language: 'en' })).toEqual({ file: 'a.html', edits: [], lines: [], mints: [] });
  });

  it('prints the set-language line and edits nothing where language is unset', () => {
    const fix = plan(doc('<html>'));
    if ('skip' in fix) throw new Error(fix.skip);
    expect(fix.edits).toEqual([]);
    expect(fix.lines).toEqual(['set language in stet.config.json (a BCP 47 tag such as en-GB), then run stet audit lighthouse --fix']);
  });

  it('writes a bare lang attribute whole', () => {
    const source = doc('<html lang>');
    expect(fixed(source, { language: 'en' }).text).toBe(source.replace('<html lang>', '<html lang="en">'));
  });

  it('skips a self-closed <html/>: the reader closes it, and <head> stands outside it', () => {
    const source = '<!DOCTYPE html>\n<html/>\n<head><title>T</title></head>\n<body></body>\n';
    expect(plan(source, { language: 'en' })).toEqual({ skip: 'a.html: no single readable <head> — no head edits' });
  });
});

describe('planDocumentFix — the documents it leaves', () => {
  it('skips two <head>s and an unclosed <head>', () => {
    expect(plan('<html lang="en"><head><title>a</title></head><head></head><body></body></html>\n')).toEqual({
      skip: 'a.html: no single readable <head> — no head edits',
    });
    expect(plan('<html lang="en"><head><title>x</title>\n<body><p>a</p></body></html>\n')).toEqual({
      skip: 'a.html: no single readable <head> — no head edits',
    });
  });

  it('skips a document with two <html> elements', () => {
    expect(plan('<html lang="en"><head></head></html><html><head></head></html>\n')).toEqual({ skip: 'a.html: no single <html> element — no head edits' });
  });

  it('skips a document with no single <html>', () => {
    expect(plan('<head></head><body></body>\n')).toEqual({ skip: 'a.html: no single <html> element — no head edits' });
  });
});

/** `create-next-app@15.5.26`'s `app/layout.tsx`. */
const NEXT_LAYOUT = `import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={\`\${geistSans.variable} \${geistMono.variable}\`}>
        {children}
      </body>
    </html>
  );
}
`;

describe('the fixes by host type (D5)', () => {
  it("inserts lang on a Next root layout's <html> with every other byte equal", async () => {
    const ts = await loadTypescript();
    const without = NEXT_LAYOUT.replace('<html lang="en">', '<html>');
    const fix = planNextLang(ts, 'app/layout.tsx', without, 'en');
    if ('skip' in fix) throw new Error(fix.skip);
    expect(fix.lines).toEqual(['lang="en" on <html> (from language in stet.config.json)']);
    expect(applyFileEdits(without, fix.edits)).toBe(NEXT_LAYOUT);
    expect(planNextLang(ts, 'app/layout.tsx', NEXT_LAYOUT, 'en')).toEqual({ file: 'app/layout.tsx', edits: [], lines: [], mints: [] });
  });

  it('inserts lang on a self-closing <html />, and replaces an invalid literal', async () => {
    const ts = await loadTypescript();
    const selfClosing = 'export default function L() {\n  return <html />;\n}\n';
    const one = planNextLang(ts, 'app/layout.tsx', selfClosing, 'en');
    expect('skip' in one ? one.skip : applyFileEdits(selfClosing, one.edits)).toBe(selfClosing.replace('<html />', '<html lang="en" />'));
    const invalid = NEXT_LAYOUT.replace('lang="en"', 'lang="english"');
    const two = planNextLang(ts, 'app/layout.tsx', invalid, 'en-GB');
    expect('skip' in two ? two.skip : applyFileEdits(invalid, two.edits)).toBe(NEXT_LAYOUT.replace('lang="en"', 'lang="en-GB"'));
  });

  it('leaves two <html> elements and an expression lang, with the attribute to write by hand', async () => {
    const ts = await loadTypescript();
    const two = 'export default function L({ a }) {\n  return a ? <html><body /></html> : <html><body /></html>;\n}\n';
    expect(planNextLang(ts, 'app/layout.tsx', two, 'en')).toEqual({
      skip: 'app/layout.tsx: no single <html> element — set lang by hand\n  <html lang="en">',
    });
    const expression = NEXT_LAYOUT.replace('<html lang="en">', '<html lang={locale}>');
    expect(planNextLang(ts, 'app/layout.tsx', expression, 'en')).toEqual({
      skip: 'app/layout.tsx: lang is set by an expression — set it by hand\n  <html lang="en">',
    });
  });

  it("takes the doctype, charset, viewport and lang on a Vite shell, and reports its title and description", () => {
    const shell = '<html>\n  <head>\n    <link rel="icon" type="image/svg+xml" href="/vite.svg" />\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n';
    const fix = planViteShell(readDocument('index.html', shell), 'en');
    if ('skip' in fix) throw new Error(fix.skip);
    expect(fix.mints).toEqual([]);
    expect(fix.lines).toEqual([
      '<!DOCTYPE html> as the first line',
      `${CHARSET} as the first element of <head>`,
      `${VIEWPORT} after it`,
      'lang="en" on <html> (from language in stet.config.json)',
      VITE_SHELL_LINE,
    ]);
    expect(applyFileEdits(shell, fix.edits)).toBe(
      `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    ${CHARSET}\n    ${VIEWPORT}\n    <link rel="icon"` + shell.slice(shell.indexOf(' type="image/svg+xml"')),
    );
  });

  it('reports an Astro page’s fixes as lines and writes nothing', () => {
    expect(astroFixLines(new Set(['doctype', 'charset', 'html-has-lang', 'label']), 'en')).toEqual([
      '<!DOCTYPE html> as the first line',
      `${CHARSET} as the first element of <head>`,
      'lang="en" on <html> (from language in stet.config.json)',
    ]);
    expect(astroFixLines(new Set(['html-lang-valid']), undefined)).toEqual([
      'set language in stet.config.json (a BCP 47 tag such as en-GB), then run stet audit lighthouse --fix',
    ]);
  });
});

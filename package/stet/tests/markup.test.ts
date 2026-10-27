/**
 * The markup layer (cli/markup.ts): the dialect blanking, the brace and tag
 * matchers and the walks over a dialect's markup, a leaf that imports nothing
 * from `cli/`; and the render sites the route reads place keys by (D12).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderSites } from '../cli/dev-routes.js';
import { readDocument } from '../cli/html-host.js';
import { blankNonMarkup as blankViaScan, loadTypescript } from '../cli/source-scan.js';
import { blankNonMarkup, closing, elementPath, markupBraces, maskExpressions, openTag, selfClosedRaw } from '../cli/markup.js';

const ts = await loadTypescript();

describe('the markup leaf (D12, N2, N16)', () => {
  it('T12.24: a brace inside an open tag is a tag brace; maskExpressions masks every brace as before', () => {
    const source = '<a href={x} title={copy.t}>{copy.k}</a><p {...rest}>{y}</p>';
    const braces = markupBraces(source, 'astro').map((b) => ({ text: source.slice(b.start, b.end), inTag: b.inTag }));
    expect(braces).toEqual([
      { text: '{x}', inTag: true },
      { text: '{copy.t}', inTag: true },
      { text: '{copy.k}', inTag: false },
      { text: '{...rest}', inTag: true },
      { text: '{y}', inTag: false },
    ]);
    expect(maskExpressions(source, 'astro')).toBe('<a href={_} title={______}>{______}</a><p {_______}>{_}</p>');
    const sites = renderSites(ts, 'src/pages/index.astro', `<main>${source}</main>`, new Set(['k', 't']));
    expect(sites.get('k')).toEqual({ sites: [[{ tag: 'a', classes: [] }, { tag: 'main', classes: null }]], open: false });
    expect(sites.get('t')).toEqual({ sites: [], open: false });
  });

  it('T12.25 guard: the moved helpers answer as before, through the re-exports too', () => {
    const astro = '---\nconst a = "{x}";\n---\n<!-- {c} --><p>{copy.k}</p><script>const s = "{s}";</script>';
    const blanked = blankNonMarkup(astro, 'astro');
    expect(blanked.length).toBe(astro.length);
    expect(blanked.slice(astro.indexOf('<p>'), astro.indexOf('<script>'))).toBe('<p>{copy.k}</p>');
    expect(blanked.slice(0, astro.indexOf('<!--')).replace(/[\0\n]/g, '')).toBe('');
    expect(blankViaScan(astro, 'astro')).toBe(blanked);
    // An `.html` file keeps three leading dashes as prose.
    expect(blankNonMarkup('---\nx\n---\n<p>y</p>', 'html')).toBe('---\nx\n---\n<p>y</p>');

    expect(closing('{a: {b: "}"}} tail', 0, '}')).toBe('{a: {b: "}"}}'.length);
    expect(closing('<a alt={`a > b`} title="x>y">z', 0, '>')).toBe('<a alt={`a > b`} title="x>y">'.length);
    expect(closing("{ /* } */ x }", 0, '}')).toBe("{ /* } */ x }".length);
    expect(openTag('<Script src="x" />rest', 0)).toEqual({ end: '<Script src="x" />'.length, name: 'script', selfClosing: true });
    expect(openTag('<div class="a">', 0)).toEqual({ end: '<div class="a">'.length, name: 'div', selfClosing: false });

    // A brace in front matter, a comment or a script opens nothing; a nested brace is its outer one's.
    expect(maskExpressions('---\nconst o = { a: 1 };\n---\n<p>{f({ a: 1 })}</p>', 'astro')).toBe('---\nconst o = { a: 1 };\n---\n<p>{___________}</p>');
    expect(maskExpressions('<p>{a\nb}</p>', 'astro')).toBe('<p>{_\n_}</p>');

    const raw = '<script src="x" /><p>keep</p><script>y</script>';
    expect(selfClosedRaw(raw)).toBe('\0'.repeat('<script src="x" />'.length) + '<p>keep</p><script>y</script>');
  });

  it('elementPath walks every element holding an offset, outermost first, and stops at an opaque one', () => {
    const source = '<main><div class="a"><b>x</b></div><textarea><i>y</i></textarea></main>';
    const doc = readDocument('x.html', source, 'html');
    expect(elementPath(doc.roots, source.indexOf('x')).map((e) => e.tag)).toEqual(['main', 'div', 'b']);
    expect(elementPath(doc.roots, source.indexOf('y')).map((e) => e.tag)).toEqual(['main', 'textarea']);
    expect(elementPath(doc.roots, source.length + 1)).toEqual([]);
  });

  it('T12.25 guard: cli/markup.ts imports nothing from cli/', () => {
    const text = readFileSync(fileURLToPath(new URL('../cli/markup.ts', import.meta.url)), 'utf8');
    expect([...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2])).toEqual([]);
  });
});

/**
 * The read forms and the rename's three classes (cli/key-reads.ts): what a
 * template dialect evaluates, how a read name is bound, and whether each
 * occurrence of a leaving key is a read stet rewrites, a read it cannot
 * rewrite, or a mention.
 */
import { describe, expect, it } from 'vitest';

import { bindingsOf, dialectCode, planReadRenames, readFormAt, within } from '../cli/key-reads.js';
import { applyFileEdits } from '../cli/rewrite.js';
import { dialectOf, loadTypescript, type Dialect } from '../cli/source-scan.js';

const ts = await loadTypescript();
const RENAME = new Map([['nav_docs', 'nav_documentation']]);
const ours = (spec: string): boolean => spec === '../copy';

/** What the dialect makes of the first occurrence of `needle` (at `nth`): a script, an expression, or neither. */
function codeAt(source: string, dialect: Dialect, needle: string, nth = 0): 'script' | 'expression' | 'neither' {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = source.indexOf(needle, at + 1);
  if (at === -1) throw new Error(`no ${needle}`);
  const code = dialectCode(source, dialect);
  if (within(code.scripts, at)) return 'script';
  if (within(code.expressions, at)) return 'expression';
  return 'neither';
}

/** The rename's classes over one file, each as its line numbers. */
function classes(file: string, source: string, opts: { copyModule?: boolean } = {}) {
  const found = planReadRenames({
    ts,
    file,
    source,
    dialect: dialectOf(file),
    renames: RENAME,
    isStetModule: ours,
    copyModule: opts.copyModule ?? false,
  });
  return {
    found,
    rewritten: found.rewritten.map((o) => o.line),
    blocked: found.blocked.map((o) => o.line),
    mentions: found.mentions.map((o) => o.line),
    unparsed: (found.unparsed ?? []).map((o) => o.line),
    after: applyFileEdits(source, found.edits),
  };
}

describe('dialectCode', () => {
  it('reads an Astro file: front matter and scripts, tag interiors and braces', () => {
    const source =
      '---\nimport { copy } from "../copy";\n---\n' +
      '<script>const s = 1;</script>\n' +
      '<script type="application/ld+json">{"name": "x"}</script>\n' +
      '<a class="quoted" href={copy.href}>{copy.label}</a>\n' +
      '{/* note */}\n' +
      '<script type="application/ld+json" set:html={JSON.stringify(copy.meta)} />\n' +
      '<p>after the script</p>\n';
    expect(codeAt(source, 'astro', 'import')).toBe('script');
    expect(codeAt(source, 'astro', 'const s')).toBe('script');
    expect(codeAt(source, 'astro', '"name"')).toBe('neither');
    expect(codeAt(source, 'astro', 'href=')).toBe('expression');
    expect(codeAt(source, 'astro', 'copy.label')).toBe('expression');
    expect(codeAt(source, 'astro', 'quoted')).toBe('neither');
    expect(codeAt(source, 'astro', 'note')).toBe('neither');
    // A self-closing script's tag is code, and it has no body.
    expect(codeAt(source, 'astro', 'copy.meta')).toBe('expression');
    expect(codeAt(source, 'astro', 'after the script')).toBe('neither');
  });

  it('reads nothing inside an is:raw element, a script included, and ends it at its first close tag', () => {
    const raw = '<pre is:raw>{copy.a}<script>copy.b</script></pre>\n<p>{copy.c}</p>\n';
    expect(codeAt(raw, 'astro', 'copy.a')).toBe('neither');
    expect(codeAt(raw, 'astro', 'copy.b')).toBe('neither');
    expect(codeAt(raw, 'astro', 'copy.c')).toBe('expression');
    // `astro build` printed the value after the inner `</pre>`: the element ended there.
    const nested = '<pre is:raw><pre>x</pre>{copy.a}</pre>\n';
    expect(codeAt(nested, 'astro', 'copy.a')).toBe('expression');
  });

  it("applies each dialect's own raw attribute", () => {
    expect(codeAt('<div v-pre>{copy.a}</div>\n', 'astro', 'copy.a')).toBe('expression');
    expect(codeAt('<template><div v-pre>{{ copy.a }}</div></template>\n', 'vue', 'copy.a')).toBe('neither');
  });

  it("reads a Vue directive's value and a Svelte quoted brace as code, a plain value as text", () => {
    const vue = '<template><a :title="copy.a" v-text="copy.b" v-if="copy.c" class="copy_d">x</a></template>\n';
    for (const needle of ['copy.a', 'copy.b', 'copy.c']) expect(codeAt(vue, 'vue', needle)).toBe('expression');
    expect(codeAt(vue, 'vue', 'copy_d')).toBe('neither');
    const svelte = '<a title="{copy.a}" class="copy_d">x</a>\n';
    expect(codeAt(svelte, 'svelte', 'copy.a')).toBe('expression');
    expect(codeAt(svelte, 'svelte', 'copy_d')).toBe('neither');
  });

  it('reads a brace holding code beside comments as code', () => {
    expect(codeAt('<p>{/* a */ copy.a /* b */}</p>\n', 'astro', 'copy.a')).toBe('expression');
  });

  it('passes over comments, CDATA, bogus comments, indented fences, and front matter with trailing spaces', () => {
    const astro = '---   \nconst k = copy.a;\n---\n<!-- {copy.b} -->\n<![CDATA[ {copy.c} ]]>\n<!DOCTYPE {copy.d}>\n';
    expect(codeAt(astro, 'astro', 'copy.a')).toBe('script');
    for (const needle of ['copy.b', 'copy.c', 'copy.d']) expect(codeAt(astro, 'astro', needle)).toBe('neither');
    const mdx = 'import { copy } from "../copy";\n\n    ```js\n    {copy.a}\n    ```\n\n{copy.b}\n';
    expect(codeAt(mdx, 'mdx', 'import')).toBe('script');
    expect(codeAt(mdx, 'mdx', 'copy.a')).toBe('neither');
    expect(codeAt(mdx, 'mdx', 'copy.b')).toBe('expression');
  });

  it('reads an .html file as its scripts alone', () => {
    const html = '<p>{copy.a}</p>\n<a title={copy.b}>x</a>\n<script>copy.c</script>\n';
    expect(codeAt(html, 'html', 'copy.a')).toBe('neither');
    expect(codeAt(html, 'html', 'copy.b')).toBe('neither');
    expect(codeAt(html, 'html', 'copy.c')).toBe('script');
  });

  it('closes a tag and a brace where they end, quotes and nesting respected', () => {
    const tag = '<img alt={`a > b`} data-x="y" />{copy.after}\n';
    expect(codeAt(tag, 'astro', 'data-x')).toBe('expression');
    expect(codeAt(tag, 'astro', 'copy.after')).toBe('expression');
    const brace = '<p>{ {a: 1} }</p>{copy.after}\n';
    const code = dialectCode(brace, 'astro');
    const open = brace.indexOf('{');
    expect(code.expressions.find((s) => s.start === open)?.end).toBe(brace.indexOf('</p>'));
  });
});

describe('bindingsOf', () => {
  const bound = (text: string, name = 'copy') => bindingsOf(ts, 'x.ts', [text], ours).get(name);

  it('reads a named import from an accepted module, or the hook, as stet', () => {
    expect(bound('import { copy } from "../copy";')).toBe('stet');
    expect(bound('const copy = useCopy();')).toBe('stet');
  });

  it('reads any other declaration as foreign, and no declaration as none', () => {
    expect(bound('import { copy } from "./elsewhere";')).toBe('foreign');
    expect(bound('import copy from "../copy";')).toBe('foreign');
    expect(bound('function f(copy: unknown) { return copy; }')).toBe('foreign');
    expect(bound('const x = 1;', 'get')).toBe('none');
  });
});

describe('readFormAt', () => {
  const formOf = (source: string, key = 'nav_docs'): string | null => readFormAt(source, source.indexOf(key), key);

  it('answers the binding each read form goes through', () => {
    expect(formOf('copy.nav_docs')).toBe('copy');
    expect(formOf('copy?.nav_docs')).toBe('copy');
    expect(formOf('copyMap.nav_docs')).toBe('copyMap');
    expect(formOf("copy('nav_docs')")).toBe('copy');
    expect(formOf('get("nav_docs")')).toBe('get');
    expect(formOf("copy.get('nav_docs')")).toBe('copy');
    expect(formOf('copy["nav_docs"]')).toBe('copy');
    expect(formOf("useCopy()('nav_docs')")).toBe('useCopy');
  });

  it('reads no read form in a longer name, or a string with no read before it', () => {
    expect(readFormAt('copy.getter', 5, 'get')).toBeNull();
    expect(formOf('const name = "nav_docs";')).toBeNull();
  });
});

describe('planReadRenames', () => {
  it('sorts the first probe page into one refusal, three rewrites and two mentions', () => {
    const probe =
      '---\nimport { copy, get } from "../copy";\nconst name = "nav_docs";\n---\n' +
      '<a>{copy["nav_docs"]}</a>\n<a>{copy.nav_docs}</a>\n<a>{get("nav_docs")}</a>\n' +
      '<pre is:raw>{copy.nav_docs}</pre>\n<p>The nav_docs key names the docs link.</p>\n';
    const r = classes('src/pages/probe.astro', probe);
    expect(r.blocked).toEqual([3]);
    expect(r.rewritten).toEqual([5, 6, 7]);
    expect(r.mentions).toEqual([8, 9]);
    // The edits turn every rewritten occurrence and nothing else.
    expect(r.after).toBe(
      probe
        .replace('copy["nav_docs"]', 'copy["nav_documentation"]')
        .replace('{copy.nav_docs}</a>', '{copy.nav_documentation}</a>')
        .replace('get("nav_docs")', 'get("nav_documentation")'),
    );
  });

  it('sorts the second probe page: rewrites on lines 5, 6 and 8, mentions on 3, 6, 6, 7 and 9', () => {
    const probe =
      '---\nimport { copy } from "../copy";\n// copy.nav_docs\n---\n' +
      '<script type="application/ld+json" set:html={JSON.stringify({ name: copy.nav_docs })} />\n' +
      '<a class="nav_docs" href="#nav_docs">{copy?.nav_docs}</a>\n' +
      '<pre is:raw><script>copy.nav_docs</script></pre>\n' +
      '<p>{copy.nav_docs}</p>\n' +
      '<script is:inline>console.log(copy.nav_docs)</script>\n';
    const r = classes('src/pages/second.astro', probe);
    expect(r.rewritten).toEqual([5, 6, 8]);
    expect(r.mentions).toEqual([3, 6, 6, 7, 9]);
    expect(r.blocked).toEqual([]);
  });

  it("binds a Vue template's reads through its <script setup>, directives included", () => {
    const vue =
      '<script setup>\nimport { copy } from "../copy";\n</script>\n' +
      '<template>\n<a :title="copy.nav_docs" v-text="copy.nav_docs" v-if="copy.nav_docs" class="nav_docs">{{ copy.nav_docs }}</a>\n</template>\n';
    const r = classes('src/components/Nav.vue', vue);
    expect(r.rewritten).toEqual([5, 5, 5, 5]);
    expect(r.mentions).toEqual([5]);
    expect(r.blocked).toEqual([]);
  });

  it("rewrites a Svelte quoted brace, and leaves a plain value as text", () => {
    const svelte = '<script>\nimport { copy } from "../copy";\n</script>\n<a title="{copy.nav_docs}" class="nav_docs">x</a>\n';
    const r = classes('src/components/Nav.svelte', svelte);
    expect(r.rewritten).toEqual([4]);
    expect(r.mentions).toEqual([4]);
  });

  it('refuses a read through a name the file never declares, and leaves a client global as a mention', () => {
    expect(classes('src/pages/x.tsx', 'export const X = () => <p>{copy.nav_docs}</p>;\n').blocked).toEqual([1]);
    expect(classes('src/pages/x.mdx', '# Title\n\n{copy.nav_docs}\n').blocked).toEqual([3]);
    const client = classes('src/pages/x.astro', '<script>console.log(copy.nav_docs)</script>\n');
    expect(client.mentions).toEqual([1]);
    expect(client.blocked).toEqual([]);
  });

  it("passes over a brace's comments, and reads the code beside them", () => {
    const astro = '---\nimport { copy } from "../copy";\n---\n<p>{/* a */ copy.nav_docs /* b */}</p>\n<p>{/* copy.nav_docs */ copy.x}</p>\n';
    const r = classes('src/pages/c.astro', astro);
    expect(r.rewritten).toEqual([4]);
    expect(r.mentions).toEqual([5]);
  });

  it("renames a copy module's one property of the name, and refuses two", () => {
    const once = classes('src/copy.ts', 'export const copy = {\n  nav_docs: "Docs",\n};\n', { copyModule: true });
    expect(once.rewritten).toEqual([2]);
    expect(once.after).toBe('export const copy = {\n  nav_documentation: "Docs",\n};\n');
    const twice = classes('src/copy.ts', 'export const a = { nav_docs: "Docs" };\nexport const b = { "nav_docs": "Docs" };\n', {
      copyModule: true,
    });
    expect(twice.blocked).toEqual([1, 2]);
    expect(twice.rewritten).toEqual([]);
  });
});

// --- Stage-5 review: brace ends, raw attributes, MDX text, and the parse guard ---

const ASTRO = (body: string): string => `---\nimport { copy } from "../copy";\n---\n${body}\n`;
const SVELTE = (body: string): string => `<script>\nimport { copy } from "../copy";\n</script>\n${body}\n`;
const VUE = (template: string): string => `<script setup>\nimport { copy } from "../copy";\n</script>\n<template>\n${template}\n</template>\n`;
/** The reviewer's two shapes (F1): a `}` in a brace's comment, and an apostrophe in a brace's JSX text. */
const COMMENT_SHAPE = ASTRO('<p>{/* close } */ copy.nav_docs}</p>\n<p>{\n  // a } here\n  copy.nav_docs\n}</p>');
const APOSTROPHE_SHAPE = ASTRO(
  "{true && <p>We're open</p>}\n<pre is:raw>{copy.nav_docs}</pre>\n<!-- copy.nav_docs -->\n" +
    '<script>console.log(copy.nav_docs)</script>\n<p class="nav_docs">x</p>',
);

describe('brace expressions (stage-5 review)', () => {
  it('ends a brace where its code ends: a `}` in a comment closes nothing (F1)', () => {
    const r = classes('src/pages/a.astro', COMMENT_SHAPE);
    expect(r.rewritten).toEqual([4, 7]);
    expect(r.mentions).toEqual([]);
    expect(r.unparsed).toEqual([]);
    expect(classes('src/C.svelte', SVELTE('<p>{/* } */ copy.nav_docs}</p>')).rewritten).toEqual([4]);
    // A `//` after a colon is a URL's, never a comment.
    expect(classes('src/pages/u.astro', ASTRO('<a href={"https://x.test/" + copy.nav_docs}>x</a>')).rewritten).toEqual([4]);
  });

  it("reads an apostrophe in a brace's JSX text as text, so the brace ends where it does (F1)", () => {
    const r = classes('src/pages/a.astro', APOSTROPHE_SHAPE);
    expect(r.rewritten).toEqual([]);
    expect(r.blocked).toEqual([]);
    expect(r.mentions).toEqual([5, 6, 7, 8]);
    expect(r.unparsed).toEqual([]);
  });

  it('never writes around a brace it misreads: each reviewer shape is read right or refused (F1)', () => {
    const comment = classes('src/pages/a.astro', COMMENT_SHAPE);
    expect(comment.unparsed.length > 0 || (comment.rewritten.join() === '4,7' && comment.mentions.length === 0)).toBe(true);
    const apostrophe = classes('src/pages/a.astro', APOSTROPHE_SHAPE);
    expect(
      apostrophe.unparsed.length > 0 ||
        (apostrophe.rewritten.length === 0 && apostrophe.blocked.length === 0 && apostrophe.mentions.join() === '5,6,7,8'),
    ).toBe(true);
  });

  it('refuses a brace expression that does not parse, naming its line, never as a mention (F1 guard)', () => {
    const r = classes('src/pages/g.astro', ASTRO('<p>{copy.nav_docs +}</p>\n<p>{copy.nav_docs}</p>'));
    expect(r.unparsed).toEqual([4]);
    expect(r.mentions).toEqual([]);
    expect(classes('src/C.svelte', SVELTE('<p>{copy.nav_docs )}</p>')).unparsed).toEqual([4]);
    expect(classes('src/C.vue', VUE('<p>{{ copy.nav_docs ) }}</p>')).unparsed).toEqual([5]);
  });

  it("parses each dialect's own brace forms as the expressions they hold (F1 guard)", () => {
    const svelte = SVELTE(
      '{#if copy.nav_docs}<p>{copy.nav_docs}</p>{:else if ok}<p>x</p>{:else}<p>y</p>{/if}\n' +
        '{#each items as item, i (item.id)}<p>{item}</p>{/each}\n{#await load then v}{v}{:catch e}{e}{/await}\n' +
        '{@html copy.nav_docs}\n{@const t = copy.nav_docs}\n{#key k}{/key}',
    );
    expect(classes('src/C.svelte', svelte).unparsed).toEqual([]);
    expect(classes('src/C.vue', VUE('<p>{{ copy.nav_docs }}</p>\n<p>{{ ok ? copy.nav_docs : "" }}</p>')).unparsed).toEqual([]);
    const astro = ASTRO('<p {...props}>{copy.nav_docs}</p>\n{/* only a note */}\n<ul>{items.map((i) => <li>{i}</li>)}</ul>\n{}');
    expect(classes('src/pages/p.astro', astro).unparsed).toEqual([]);
    expect(classes('src/pages/p.mdx', 'import { copy } from "../copy";\n\n{copy.nav_docs}\n').unparsed).toEqual([]);
  });

  it('reads a raw attribute only as an attribute, never in a quoted value (F4)', () => {
    expect(classes('src/pages/r.astro', ASTRO('<p title="mark it is:raw to skip">{copy.nav_docs}</p>')).rewritten).toEqual([4]);
    expect(classes('src/C.vue', VUE('<p title="use v-pre here">{{ copy.nav_docs }}</p>')).rewritten).toEqual([5]);
  });

  it("ends Vue's v-pre at the close tag that balances it, and Astro's is:raw at the first (F4)", () => {
    const vue = classes('src/C.vue', VUE('<div v-pre><div>x</div>{{ copy.nav_docs }}</div>\n<p>{{ copy.nav_docs }}</p>'));
    expect(vue.mentions).toEqual([5]);
    expect(vue.rewritten).toEqual([6]);
    const deep = classes('src/C.vue', VUE('<div v-pre><div><div>x</div></div><div/>{{ copy.nav_docs }}</div>'));
    expect(deep.mentions).toEqual([5]);
    expect(codeAt('<pre is:raw><pre>x</pre>{copy.a}</pre>\n', 'astro', 'copy.a')).toBe('expression');
  });

  it('reads MDX inline code and an unclosed fence as text (F8)', () => {
    const inline = classes('src/pages/i.mdx', 'import { copy } from "../copy";\n\nUse `{copy.nav_docs}` in markup, and {copy.nav_docs} here.\n');
    expect(inline.mentions).toEqual([3]);
    expect(inline.rewritten).toEqual([3]);
    const fence = classes('src/pages/f.mdx', 'import { copy } from "../copy";\n\n~~~\n{copy.nav_docs}\n');
    expect(fence.mentions).toEqual([4]);
    expect(fence.rewritten).toEqual([]);
  });
});

describe('brace expressions (delta review)', () => {
  it('reads Astro markup in an expression as Astro builds it: void tags, comments, unquoted values (N2)', () => {
    for (const shape of [
      '{items.map((i) => <p>a<br>b</p>)}',
      '{items.map((i) => <img src="/a.png" alt="x">)}',
      '{items.map((i) => <div><!-- note --><p>x</p></div>)}',
      '{items.map((i) => <a href=/x>x</a>)}',
      '{items.map((i) => <input type="text" disabled>)}',
      '{items.map((i) => <p>a&nbsp;b</p>)}',
    ]) {
      const r = classes('src/pages/a.astro', ASTRO(`<p>{copy.nav_docs}</p>\n${shape}`));
      expect(r.unparsed, shape).toEqual([]);
      expect(r.rewritten, shape).toEqual([4]);
    }
    // Markup astro build refuses stays refused.
    expect(classes('src/pages/a.astro', ASTRO('<p>{copy.nav_docs}</p>\n{items.map((i) => <li>one)}')).unparsed).toEqual([5]);
  });

  it("reads a single brace in Vue's text as text (N3)", () => {
    const r = classes('src/C.vue', VUE('<p>{{ copy.nav_docs }}</p>\n<p>{see below}</p>\n<p>{copy.nav_docs}</p>'));
    expect(r.unparsed).toEqual([]);
    expect(r.rewritten).toEqual([5]);
    expect(r.mentions).toEqual([7]);
  });

  it('reads a backtick after a name as a tagged template, never as text (N6)', () => {
    const r = classes(
      'src/pages/t.astro',
      ASTRO('<p>{t`Hi ${name}`}</p>\n<p>{copy.nav_docs}</p>\n<pre is:raw>{copy.nav_docs}</pre>\n<p>`quoted` text</p>'),
    );
    expect(r.unparsed).toEqual([]);
    expect(r.rewritten).toEqual([5]);
    expect(r.mentions).toEqual([6]);
    expect(classes('src/pages/t.astro', ASTRO('<p>{t`a}b`}</p>\n<p>{copy.nav_docs}</p>')).rewritten).toEqual([5]);
  });

  it("keeps an unquoted value's trailing slash, reading the tag as HTML does (D1)", () => {
    for (const shape of ['{items.map((i) => <a href=/docs/>Docs</a>)}', '{items.map((i) => <img src=/a.png/>)}']) {
      const r = classes('src/pages/a.astro', ASTRO(`<p>{copy.nav_docs}</p>\n${shape}`));
      expect(r.unparsed, shape).toEqual([]);
      expect(r.rewritten, shape).toEqual([4]);
    }
  });

  it('reads a `<` TSX takes as a comparison as one, never as a tag (D2)', () => {
    const r = classes('src/pages/a.astro', ASTRO('<p>{copy.nav_docs}</p>\n<p>{x<input ? 1 : 2 > 0}</p>'));
    expect(r.unparsed).toEqual([]);
    expect(r.rewritten).toEqual([4]);
  });

  it("still refuses the braces a `}` in markup ends early (the reviewer's two shapes)", () => {
    for (const shape of [
      '{items.map((i) => <div><!-- } --><p>{copy.nav_docs}</p></div>)}',
      '{items.map((i) => <a href=/a}b>go</a>)}',
    ]) {
      expect(classes('src/pages/a.astro', ASTRO(`<p>{copy.nav_docs}</p>\n${shape}`)).unparsed, shape).toEqual([5]);
    }
  });
});

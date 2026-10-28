/**
 * The Astro rewriter (cli/astro-rewrite.ts, D14): what one `.astro` file
 * yields for register, its leaf, and the read-back every edited file passes
 * before it counts. The run through `register` is in register.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { astroEdits, astroLeaf, planAstroFile, planAstroUnrewrite, rereadsClean } from '../cli/astro-rewrite.js';
import { loadConfig } from '../cli/config.js';
import { applyFileEdits, planRewrite } from '../cli/rewrite.js';
import { loadTypescript } from '../cli/source-scan.js';

const ts = await loadTypescript();

/** A temp Astro host holding `files`, its read path imported as `@/lib/content` and `src/copy.ts` a declared copy module. */
function host(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-astro-unit-'));
  const all: Record<string, string> = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'stet.config.json': JSON.stringify({
      project: 't',
      managedSurfaces: ['src/**/*.astro'],
      copyModules: ['src/copy.ts'],
      readPath: { file: 'src/lib/content.ts', import: '@/lib/content' },
      router: 'astro',
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
    }),
    'src/lib/content.ts': 'export const copyMap: Record<string, string> = {};\n',
    'src/copy.ts': "import { copyMap } from '@/lib/content';\nexport const copy = copyMap;\n",
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** One file planned and rewritten with each literal's proposed key. */
function rewrite(dir: string, file: string, source: string): { after: string; plan: ReturnType<typeof planAstroFile>['plan']; reads: ReturnType<typeof astroEdits>['reads'] } {
  const { literals, plan } = planAstroFile({ ts, cwd: dir, config: loadConfig(dir), file, source, page: 'home' });
  const { edits, reads } = astroEdits(source, plan, literals.map((literal) => ({ literal, key: literal.proposedKey })));
  return { after: applyFileEdits(source, edits), plan, reads };
}

const PAGE = '---\nimport { copy } from "../copy";\n---\n<p>{copy.a}</p>\n<h3>Fixing a word</h3>\n<p>Second words here</p>\n';

describe('the Astro rewriter (D14)', () => {
  it('T14.9: keeps every byte outside its span and its insertion, past the mark, in the file\'s own line endings', () => {
    const source = '﻿<html>\r\n<body>\r\n<h3>Fixing a word</h3>\r\n</body>\r\n</html>\r\n';
    const dir = host({ 'src/pages/index.astro': source });
    const { after, plan } = rewrite(dir, 'src/pages/index.astro', source);
    const fence = "---\r\nimport { copy } from '@/lib/content';\r\n---\r\n";
    expect(plan.insert).toEqual({ pos: 1, end: 1, text: fence });
    expect(after).toBe(`﻿${fence}<html>\r\n<body>\r\n<h3>{copy('home_page_headline')}</h3>\r\n</body>\r\n</html>\r\n`);
    // Outside the replaced span and the insertion, the bytes are the input's.
    expect(after.replace(fence, '').replace("{copy('home_page_headline')}", 'Fixing a word')).toBe(source);
  });

  it('T14.1: an import lands after the comment that trails the last import, and removing the inserted span restores the file (PD9)', () => {
    for (const [comment, eol] of [['// note', '\n'], ['/* note */', '\n'], ['// note', '\r\n']] as const) {
      const source = `---${eol}import x from './x'; ${comment}${eol}---${eol}<h3>Fixing a word</h3>${eol}`;
      const dir = host({ 'src/pages/index.astro': source });
      const { plan } = rewrite(dir, 'src/pages/index.astro', source);
      const insert = plan.insert as NonNullable<typeof plan.insert>;
      const inserted = applyFileEdits(source, [insert]);
      expect(inserted).toBe(`---${eol}import x from './x'; ${comment}${eol}import { copy } from '@/lib/content';${eol}---${eol}<h3>Fixing a word</h3>${eol}`);
      expect(inserted.slice(0, insert.pos) + inserted.slice(insert.pos + insert.text.length)).toBe(source);
    }
  });

  it('T14.10: the read-back holds for a planned rewrite and refuses each check that fails', () => {
    const dir = host({ 'src/pages/index.astro': PAGE });
    const { after, reads } = rewrite(dir, 'src/pages/index.astro', PAGE);
    expect(reads).toHaveLength(2);
    expect(rereadsClean(ts, 'src/pages/index.astro', PAGE, after, reads, 0)).toBe(true);
    const clean = (text: string, planned = reads): boolean => rereadsClean(ts, 'src/pages/index.astro', PAGE, text, planned, 0);
    // Each break below moves no read and no finding, so only its own check sees it.
    // 1. The front matter no longer parses.
    expect(clean(after.replace('import { copy } from "../copy";', 'import { copy } from "../copy"('))).toBe(false);
    // 2. An unclosed tag, and one element more.
    expect(clean(`${after}<div>`)).toBe(false);
    expect(clean(`${after}<br>`)).toBe(false);
    // 3. A brace that does not parse.
    expect(clean(`${after}{a +}`)).toBe(false);
    // 4. A planned read missing at its offset.
    expect(clean(after, reads.map((read, i) => (i === 0 ? { ...read, at: read.at + 1 } : read)))).toBe(false);
    // 5. A finding of before gone that no literal replaced.
    expect(clean(after.replace(/<p>\{copy\.home_[a-z_0-9]+\}<\/p>\n$/, '<p></p>\n'), reads.slice(0, 1))).toBe(false);
  });

  it('T14.6: an index stet cannot fix after a spread is a code use when an element access reads one (N12)', () => {
    const body = (attr: string): string =>
      '---\nimport { copy } from "../copy";\nconst more = ["x"];\nconst a7 = [{ items: [...more, "Ninth words here"] }];\n---\n<p>{copy.a}</p>\n' +
      `{a7.map((g) => <div>{g.items.map((i) => <p>{i}</p>)}<span${attr}>z</span></div>)}\n`;
    const read = (source: string): ReturnType<typeof planAstroFile> =>
      planAstroFile({ ts, cwd: host({ 'src/pages/index.astro': source }), config: loadConfig(host({})), file: 'src/pages/index.astro', source, page: 'home' });
    const coded = read(body(' id={g.items[1]}'));
    expect(coded.literals).toEqual([]);
    expect(coded.plan.skips).toEqual([expect.objectContaining({ text: 'Ninth words here', reason: 'used in code' })]);
    expect(read(body('')).literals.map((l) => l.text)).toEqual(['Ninth words here']);
  });

  it('T16.5: the read-back counts the elements a sentence key moves into its renderers', () => {
    for (const [sentence, moved] of [['<p>Install: run <b>npx x init</b> and answer.</p>', 1], ['<p>See <a class="i" href="/docs"><code>stet</code> docs</a> now</p>', 2]] as const) {
      const source = `---\nimport { copy } from "../copy";\n---\n<p>{copy.a}</p>\n${sentence}\n`;
      const dir = host({ 'src/pages/index.astro': source });
      const { after, reads } = rewrite(dir, 'src/pages/index.astro', source);
      expect(after).toContain('{richParts(copy.');
      expect(rereadsClean(ts, 'src/pages/index.astro', source, after, reads, moved)).toBe(true);
      expect(rereadsClean(ts, 'src/pages/index.astro', source, after, reads, 0)).toBe(false);
    }
  });

  it("a leaf re-confirms the literal's span, and the JSX engine refuses an Astro literal by its shape (additions)", () => {
    const dir = host({ 'src/pages/index.astro': PAGE });
    const { literals, plan } = planAstroFile({ ts, cwd: dir, config: loadConfig(dir), file: 'src/pages/index.astro', source: PAGE, page: 'home' });
    const literal = literals[0] as (typeof literals)[number];
    expect(astroLeaf(PAGE, literal, 'k', plan.form)).toEqual({ pos: literal.pos, end: literal.end, text: '{copy.k}' });
    expect(() => astroLeaf(PAGE.replace('Fixing', 'Fixin!'), literal, 'k', plan.form)).toThrow('source changed since scan; re-run stet scan');
    expect(() => planRewrite(PAGE, literal, 'k', 'server', '@/lib/content')).toThrow(/astro-shaped finding .* an Astro finding is rewritten by astroLeaf alone/);
  });
});

/** One file's eject: the un-rewrite with `values`, as eject's surface loop calls it. */
function unrewrite(dir: string, file: string, source: string, values: Record<string, unknown>): ReturnType<typeof planAstroUnrewrite> {
  return planAstroUnrewrite({ ts, cwd: dir, config: loadConfig(dir), file, source, values });
}

/** The edited text, or the refusal's reason where the file refuses. */
const outOf = (result: ReturnType<typeof planAstroUnrewrite>): string => ('edited' in result ? result.edited : `refused: ${result.refused}`);

/** A file register rewrote, put back with each key's seed. */
function roundTrip(source: string, files: Record<string, string> = {}): string {
  const dir = host({ 'src/pages/index.astro': source, ...files });
  const { literals, plan } = planAstroFile({ ts, cwd: dir, config: loadConfig(dir), file: 'src/pages/index.astro', source, page: 'home' });
  const { edits } = astroEdits(source, plan, literals.map((literal) => ({ literal, key: literal.proposedKey })));
  expect(edits.length).toBeGreaterThan(0);
  const values = Object.fromEntries(literals.map((l) => [l.proposedKey, l.text]));
  return outOf(unrewrite(dir, 'src/pages/index.astro', applyFileEdits(source, edits), values));
}

describe('the Astro un-rewrite (D15)', () => {
  const VALUES = { a: "Tom & Jerry's <b>", q: 'Say "hi"', b: 'Plain', words: ['a', 'b'], br: 'x{y}' };

  it('T15.1: each read restores as its position reads it', () => {
    const source = [
      '---',
      "import { copy, get } from '@/lib/content';",
      "import Head from '../components/Head.astro';",
      'const card = { label: copy.b, };',
      '---',
      '<h3>{copy.a}</h3>',
      '<button title={copy.a}>x</button>',
      '<button title={copy.q}>y</button>',
      '<Head label={copy.b} />',
      '<Head label={copy.a} />',
      '<Head label={copy.q} />',
      '<p>{copy.b.toUpperCase()}</p>',
      "<p>{get('words')}</p>",
      '<p>{copy.br}</p>',
      '<p>{copy.b} and more</p>',
      '<p>Hello\n  {copy.b}, welcome</p>',
      '<p>{card.label}</p>',
      '',
    ].join('\n');
    const dir = host({ 'src/pages/index.astro': source });
    expect(outOf(unrewrite(dir, 'src/pages/index.astro', source, VALUES))).toBe(
      [
        '---',
        "import Head from '../components/Head.astro';",
        'const card = { label: "Plain", };',
        '---',
        "<h3>Tom &amp; Jerry's &lt;b&gt;</h3>",
        '<button title="Tom &amp; Jerry\'s <b>">x</button>',
        '<button title="Say &quot;hi&quot;">y</button>',
        '<Head label="Plain" />',
        '<Head label="Tom & Jerry\'s <b>" />',
        '<Head label={"Say \\"hi\\""} />',
        '<p>{"Plain".toUpperCase()}</p>',
        '<p>{["a","b"]}</p>',
        '<p>x&#123;y&#125;</p>',
        '<p>Plain and more</p>',
        '<p>HelloPlain, welcome</p>',
        '<p>{card.label}</p>',
        '',
      ].join('\n'),
    );
    // Under compressHTML: true Astro renders the line break as a space, so it stays (check 3 F9).
    const spaced = "---\nimport { copy } from '@/lib/content';\n---\n<p>Hello\n  {copy.b}, welcome</p>\n";
    const kept = host({ 'src/pages/index.astro': spaced, 'astro.config.mjs': 'export default { compressHTML: true };\n' });
    expect(outOf(unrewrite(kept, 'src/pages/index.astro', spaced, VALUES))).toBe('<p>Hello\n  Plain, welcome</p>\n');
  });

  it('T15.2: a rich read rebuilds its markup from the renderers, however the call is wrapped', () => {
    const renderers = '[(c) => <b>{c}</b>, (c) => <a class="i" href="/docs">{c}</a>]';
    const source = [
      '---',
      "import { richParts } from '@getstet/stet';",
      "import { copy } from '@/lib/content';",
      '---',
      `<p>{richParts(copy.r1, ${renderers})}</p>`,
      `<p>{richParts(copy.r2, ${renderers})}</p>`,
      '<p>{richParts(',
      '  copy.r1,',
      '  [(c) => <b>{c}</b>,',
      '   (c) => <a class="i" href="/docs">{c}</a>,],',
      ')}</p>',
      '',
    ].join('\n');
    const values = { r1: 'Run <1>npx</1> or <2>read</2>.', r2: '<2>read</2> or <1>npx</1>' };
    const dir = host({ 'src/pages/index.astro': source });
    expect(outOf(unrewrite(dir, 'src/pages/index.astro', source, values))).toBe(
      [
        '<p>Run <b>npx</b> or <a class="i" href="/docs">read</a>.</p>',
        '<p><a class="i" href="/docs">read</a> or <b>npx</b></p>',
        '<p>Run <b>npx</b> or <a class="i" href="/docs">read</a>.</p>',
        '',
      ].join('\n'),
    );
    // prettier-plugin-astro 0.14.1's output over a registered page, byte for byte (check 4 K5).
    const formatted =
      '---\nimport { richParts } from "@getstet/stet";\nimport { copy } from "../copy";\n---\n\n<p class="prereq lede">\n  {\n    richParts(copy.docs_quickstart_prereq, [\n' +
      '      (c) => (\n        <a href="/docs/html" class="inline-link">\n          {c}\n        </a>\n      ),\n      (c) => <code class="mono">{c}</code>,\n    ])\n  }\n</p>\n' +
      '<p>{richParts(copy.k, [(c) => <b>{c}</b>])}</p>\n';
    const pretty = host({ 'src/pages/index.astro': formatted });
    const prettyValues = { docs_quickstart_prereq: 'Works with <1>plain HTML sites</1> and <2>npx</2>.', k: 'Run <1>this</1> now' };
    expect(outOf(unrewrite(pretty, 'src/pages/index.astro', formatted, prettyValues))).toBe(
      '\n<p class="prereq lede">\n  Works with <a href="/docs/html" class="inline-link">plain HTML sites</a> and <code class="mono">npx</code>.\n</p>\n<p>Run <b>this</b> now</p>\n',
    );
  });

  it('T15.3: the imports and the fence register inserted go, and nothing else', () => {
    // The fence register wrote around a call-form import.
    expect(roundTrip('<h3>Fenceless word here</h3>\n')).toBe('<h3>Fenceless word here</h3>\n');
    // An import inserted past the comment that trails the last import (T14.1, PD9).
    for (const [comment, eol] of [['// note', '\n'], ['/* note */', '\n'], ['// note', '\r\n']] as const) {
      const source = `---${eol}import x from './x'; ${comment}${eol}---${eol}<h3>Fixing a word</h3>${eol}`;
      expect(roundTrip(source)).toBe(source);
    }
    // A byte-order mark stays where it was (check 3 F17).
    const marked = '﻿<html>\r\n<body>\r\n<h3>Fixing a word</h3>\r\n</body>\r\n</html>\r\n';
    expect(roundTrip(marked)).toBe(marked);
    // Other imports stay; stet's go.
    const kept = [
      '---',
      "import Card from '../components/Card.astro';",
      "import { copy } from '@/lib/content';",
      "import { richParts } from '@getstet/stet';",
      '---',
      "<p>{copy('a')}</p>",
      "<p>{richParts(copy('r'), [(c) => <b>{c}</b>])}</p>",
      '<Card />',
      '',
    ].join('\n');
    const dir = host({ 'src/pages/index.astro': kept });
    expect(outOf(unrewrite(dir, 'src/pages/index.astro', kept, { a: 'A', r: 'Run <1>x</1>' }))).toBe(
      "---\nimport Card from '../components/Card.astro';\n---\n<p>A</p>\n<p>Run <b>x</b></p>\n<Card />\n",
    );
    // A copy-module import the file still reads stays.
    const used = "---\nimport { copy } from '../copy';\nconst all = Object.keys(copy);\n---\n<p>{copy.a}</p>\n<p>{all.length}</p>\n";
    const usedDir = host({ 'src/pages/index.astro': used });
    expect(outOf(unrewrite(usedDir, 'src/pages/index.astro', used, { a: 'A' }))).toBe(
      "---\nimport { copy } from '../copy';\nconst all = Object.keys(copy);\n---\n<p>A</p>\n<p>{all.length}</p>\n",
    );
  });

  it("T15.7: a client script keeps its own copy (check 3 F21)", () => {
    const source = "---\nimport { copy } from '@/lib/content';\n---\n<h3>{copy('a')}</h3>\n<script>import copy from 'copy-to-clipboard'; copy(x)</script>\n";
    const dir = host({ 'src/pages/index.astro': source });
    expect(outOf(unrewrite(dir, 'src/pages/index.astro', source, { a: 'A' }))).toBe("<h3>A</h3>\n<script>import copy from 'copy-to-clipboard'; copy(x)</script>\n");
  });
});

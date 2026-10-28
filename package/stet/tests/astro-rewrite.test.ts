/**
 * The Astro rewriter (cli/astro-rewrite.ts, D14): what one `.astro` file
 * yields for register, its leaf, and the read-back every edited file passes
 * before it counts. The run through `register` is in register.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { astroEdits, astroLeaf, planAstroFile, rereadsClean } from '../cli/astro-rewrite.js';
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

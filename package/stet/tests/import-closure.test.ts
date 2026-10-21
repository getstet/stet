/**
 * The import closure (cli/import-closure.ts): the walk doctor's wrapper chain
 * runs over a render pointer's files, and the route reads run over a page's
 * files through the host's path aliases. Each case is a real directory, so the
 * extension probe and the `node_modules` guard read what is on disk.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { importClosure } from '../cli/import-closure.js';
import { loadTypescript } from '../cli/source-scan.js';

const ts = await loadTypescript();
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-closure-'));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, 'utf8');
  }
  return dir;
}

const rels = (chain: { files: Array<{ rel: string }> }): string[] => chain.files.map((f) => f.rel);

describe('importClosure', () => {
  it('reads a file two entries share once', () => {
    const dir = project({
      'a.ts': "import { x } from './shared';\nexport const a = x;\n",
      'b.ts': "import { x } from './shared';\nexport const b = x;\n",
      'shared.ts': 'export const x = 1;\n',
    });
    const chain = importClosure(ts, dir, ['a.ts', 'b.ts']);
    expect(rels(chain)).toEqual(['a.ts', 'shared.ts', 'b.ts']);
    expect(chain.boundary).toBe(false);
  });

  it('follows a re-export barrel to the file behind it', () => {
    const dir = project({
      'mail.ts': "import { Footer } from './components';\nexport const mail = Footer;\n",
      'components/index.ts': "export { Footer } from './footer';\n",
      'components/footer.ts': 'export const Footer = 1;\n',
    });
    expect(rels(importClosure(ts, dir, ['mail.ts']))).toEqual(['mail.ts', 'components/index.ts', 'components/footer.ts']);
  });

  it('sets no boundary where the alias answers undefined for a package, and sets one where it answers null', () => {
    const dir = project({
      'page.tsx': "import * as React from 'react';\nimport { Nav } from '@/components/Nav';\nexport const p = [React, Nav];\n",
      'components/Nav.tsx': 'export const Nav = 1;\n',
      'broken.tsx': "import { gone } from '@/missing';\nexport const b = gone;\n",
    });
    const alias = (_from: string, spec: string): string | null | undefined => {
      if (spec === 'react') return undefined;
      if (spec === '@/components/Nav') return 'components/Nav.tsx';
      return null;
    };
    const page = importClosure(ts, dir, ['page.tsx'], alias);
    expect(rels(page)).toEqual(['page.tsx', 'components/Nav.tsx']);
    expect(page.boundary).toBe(false);
    expect(importClosure(ts, dir, ['broken.tsx'], alias).boundary).toBe(true);
  });

  it('treats a non-relative specifier as a boundary where no alias is given, as doctor always has', () => {
    const dir = project({ 'mail.ts': "import { Html } from '@react-email/components';\nexport const m = Html;\n" });
    const chain = importClosure(ts, dir, ['mail.ts']);
    expect(rels(chain)).toEqual(['mail.ts']);
    expect(chain.boundary).toBe(true);
  });

  it('never enters node_modules, even by a specifier that reaches it the long way round', () => {
    const dir = project({
      'lib/email/mail.ts': "import { x } from '../../node_modules/x';\nexport const m = x;\n",
      'node_modules/x.ts': 'export const x = 1;\n',
    });
    const chain = importClosure(ts, dir, ['lib/email/mail.ts']);
    expect(rels(chain)).toEqual(['lib/email/mail.ts']);
    expect(chain.boundary).toBe(true);
  });

  it('sets the boundary at depth 11 and not at depth 10', () => {
    const chainOf = (n: number): Record<string, string> => {
      const files: Record<string, string> = {};
      for (let i = 0; i <= n; i++) {
        files[`f${i}.ts`] = i < n ? `import { v } from './f${i + 1}';\nexport const v${i} = v;\n` : 'export const v = 1;\n';
      }
      return files;
    };
    const ten = importClosure(ts, project(chainOf(10)), ['f0.ts']);
    expect(ten.files).toHaveLength(11);
    expect(ten.boundary).toBe(false);
    const eleven = importClosure(ts, project(chainOf(11)), ['f0.ts']);
    expect(eleven.files).toHaveLength(11);
    expect(eleven.boundary).toBe(true);
  });
});

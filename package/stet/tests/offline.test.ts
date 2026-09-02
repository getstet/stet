import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import { describe, expect, it } from 'vitest';

import {
  isNodeBuiltin,
  runtimeImportClosure,
  runtimeImports,
  sourceFiles,
  stemOf,
} from './helpers/source-roster.js';

const srcDir = new URL('../src/', import.meta.url);

/**
 * Every source file under `src/`, at any depth and in any of the extensions
 * TypeScript compiles — the collection is `source-roster.ts`'s job, and the
 * roster below pins the result so a file joining or leaving is a failing test
 * rather than a quiet change of what is guarded.
 */
const sources = sourceFiles(srcDir).map((name) => ({
  name,
  text: readFileSync(new URL(name, srcDir), 'utf8'),
}));

describe('the offline guard', () => {
  it('is installed: a test that reaches the network fails instead of passing quietly', () => {
    expect(() => globalThis.fetch('https://example.com')).toThrowError(/offline guard/);
    expect(() => http.request('http://example.com')).toThrowError(/offline guard/);
    expect(() => https.request('https://example.com')).toThrowError(/offline guard/);
    expect(() => http.get('http://example.com')).toThrowError(/offline guard/);
    expect(() => https.get('https://example.com')).toThrowError(/offline guard/);
  });

  it('covers every test file, not just this one', () => {
    const config = readFileSync(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('setupFiles');
    expect(config).toContain('setup.offline.ts');

    // The live leg is excluded here, not merely named elsewhere: without this
    // line a `*.live.test.ts` would join the default run and take its
    // infrastructure with it.
    expect(config).toContain('*.live.test.ts');
  });
});

describe('the core is pure by construction', () => {
  it('found the source files it is checking', () => {
    expect(sources.map((s) => s.name).sort()).toEqual([
      'access.ts',
      'bundle.ts',
      'codegen.ts',
      'descriptor-schema.generated.ts',
      'descriptor.ts',
      'index.ts',
      'preview-token.ts',
      'preview.ts',
      'resolve.ts',
      'seo.ts',
      'snapshot.ts',
      'store.ts',
      'targets/adapter.ts',
      'targets/html-email.ts',
      'targets/web.ts',
      'types.ts',
      'validate.ts',
    ]);
  });

  it('opens nothing: no file system, no network, no environment', () => {
    const forbidden = [
      'node:fs',
      'node:http',
      'node:https',
      'node:net',
      'node:child_process',
      'process.env',
      'fetch(',
      'readFileSync',
      'writeFileSync',
      'createRequire',
    ];
    for (const { name, text } of sources) {
      for (const token of forbidden) {
        expect(`${name}: ${text.includes(token)}`).toBe(`${name}: false`);
      }
    }
  });

  it('is deterministic: same inputs, byte-identical output', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${text.includes('Date.now')}`).toBe(`${name}: false`);
      expect(`${name}: ${text.includes('Math.random')}`).toBe(`${name}: false`);
      expect(`${name}: ${text.includes('toLocale')}`).toBe(`${name}: false`);
    }
  });

  it('permits node builtins at exactly two sites, both node:crypto', () => {
    // Every builtin any src/ file names for itself, read the way the closure
    // walk reads an edge — so a `require('node:path')`, a dynamic import or an
    // import-equals counts the same as an import statement, and the pair names
    // the file that wrote it. Two modules are permitted the hash and the token
    // signature; a sixth builtin anywhere in src/ is a new pair here.
    const sites = sources.flatMap(({ name }) =>
      runtimeImports(new URL(name, srcDir))
        .filter(isNodeBuiltin)
        .map((spec) => [name, spec]),
    );
    expect([...sites].sort()).toEqual([
      ['codegen.ts', 'node:crypto'],
      ['preview-token.ts', 'node:crypto'],
    ]);
  });

  it('reaches no Node builtin from the root entry', () => {
    expect(runtimeImportClosure(new URL('index.ts', srcDir)).bare.filter(isNodeBuiltin)).toEqual([]);
  });

  it('keeps no file named for its lack of a job', () => {
    // Stems, not paths or filenames: "in any directory, under any spelling" is
    // the rule, so `targets/utils.mts` has to fail this the same way a
    // top-level `utils.ts` does.
    const banned = ['utils', 'helpers', 'misc', 'common'];
    expect(sources.map(({ name }) => stemOf(name)).filter((s) => banned.includes(s))).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { isNodeBuiltin, runtimeImportClosure } from './helpers/source-roster.js';

/**
 * `runtimeImportClosure` and `isNodeBuiltin` against fixtures built for them.
 *
 * The guard over the published entries asserts an ABSENCE — no builtin in the
 * root or React closure — and an absence is only worth what the walker's
 * discrimination is worth. Each case below is one property of that
 * discrimination, driven from a file under `fixtures/closure-walk/` that exists
 * to carry it: what tsc erases, what it emits, what a bundler follows, and what
 * is text rather than an edge.
 *
 * The fixtures name bare specifiers (`marker-leaf`, `marker-type-leaf`) that no
 * package provides. A bare specifier is collected and never entered, so an
 * unresolvable one is the cheapest possible witness that an edge survived the
 * walk — and it keeps the fixtures free of any real dependency.
 *
 * The fixture directory sits outside `tsconfig.tests.json`, beside `ts-host`
 * for the same reason: three of these files carry constructs tsc rejects under
 * the suite's own settings — a JSON import with no `resolveJsonModule`, a
 * query-string specifier, and a `.tsx` target with no `--jsx` — and the
 * walker's verdict on exactly those is the property under test. They are parser
 * input, never compiled and never run.
 */

const FIXTURES = new URL('./fixtures/closure-walk/', import.meta.url);

/** One fixture's closure, by file name. */
function closureOf(name: string): { modules: string[]; bare: string[] } {
  return runtimeImportClosure(new URL(name, FIXTURES));
}

/** A fixture's package-root-relative path — what `modules` reports. */
function at(name: string): string {
  return `tests/fixtures/closure-walk/${name}`;
}

describe('runtimeImportClosure — what tsc erases and what it emits', () => {
  it('does not follow a declaration-level import type', () => {
    // `import type { X } from './m.js'` is erased whole: no `import` statement
    // survives into dist/, so the module is never loaded and its own imports
    // are outside the closure.
    const closure = closureOf('a-type-only.ts');
    expect(closure.modules).toEqual([at('a-type-only.ts')]);
    expect(closure.bare).toEqual([]);
  });

  it('follows an inline-only type clause, which still emits a load', () => {
    // `import { type X } from './m.js'` emits `import {} from './m.js'` — the
    // specifier survives, so the module loads and everything it names is in the
    // closure. Same target module as the case above, opposite verdict.
    const closure = closureOf('b-inline-type.ts');
    expect(closure.modules).toEqual([at('b-inline-type.ts'), at('type-leaf.ts')]);
    expect(closure.bare).toEqual(['marker-type-leaf']);
  });

  it('sees a value import that sits after a top-level type alias', () => {
    // The blindness a statement-scanning text walker had: one ordinary
    // `export type X = …;` ahead of a late import made it drop that edge.
    const closure = closureOf('c-late-import.ts');
    expect(closure.modules).toContain(at('leaf.ts'));
    expect(closure.bare).toEqual(['marker-leaf']);
  });
});

describe('runtimeImportClosure — the load forms a bundler follows', () => {
  it('follows a string-literal dynamic import and refuses a computed one', () => {
    expect(closureOf('d-dynamic.ts').bare).toEqual(['marker-leaf']);
    expect(() => closureOf('d-dynamic-computed.ts')).toThrowError(/unanalyzable dynamic import/);
  });

  it('follows a string-literal require and refuses a computed one', () => {
    expect(closureOf('e-require.ts').bare).toEqual(['marker-leaf']);
    expect(() => closureOf('e-require-computed.ts')).toThrowError(/unanalyzable require/);
  });

  it('follows import x = require() and erases the type-only form', () => {
    expect(closureOf('f-import-equals.ts').bare).toEqual(['marker-leaf']);

    const erased = closureOf('f-import-equals-type.ts');
    expect(erased.modules).toEqual([at('f-import-equals-type.ts')]);
    expect(erased.bare).toEqual([]);
  });

  it('reaches the leaf of a three-hop re-export chain', () => {
    // The three re-export forms, one per hop: `export *`, `export { x } from`,
    // `export * as ns from`. A barrel is how most code reaches its leaf, and a
    // walk that stopped at one would vouch for a graph it never opened.
    const closure = closureOf('g-chain-entry.ts');
    expect(closure.modules).toEqual([
      at('g-chain-a.ts'),
      at('g-chain-b.ts'),
      at('g-chain-entry.ts'),
      at('leaf.ts'),
    ]);
    expect(closure.bare).toEqual(['marker-leaf']);
  });
});

describe('runtimeImportClosure — resolution, and what it refuses', () => {
  it('resolves ./x.js to .ts or .tsx and ./x.mjs to .mts', () => {
    expect(closureOf('h-resolution.ts').modules).toEqual([
      at('h-resolution.ts'),
      at('leaf-modern.mts'),
      at('leaf-view.tsx'),
      at('leaf.ts'),
    ]);
  });

  it('fails closed on a specifier the rule does not cover, and names the rule', () => {
    // A JSON import and a query-string specifier are both outside the emitted
    // `./x.js` → source mapping. Neither vanishes: the walk stops and says what
    // it does resolve, because a guard that silently drops an edge it cannot
    // read vouches for nothing.
    const rule = /resolves \.\/x\.js to x\.ts\|x\.tsx\|x\.mts/;
    expect(() => closureOf('i-json.ts')).toThrowError(rule);
    expect(() => closureOf('i-json.ts')).toThrowError(/unresolved import \.\/data\.json/);
    expect(() => closureOf('i-query-string.ts')).toThrowError(rule);
  });

  it('refuses a new URL() reference built from import.meta', () => {
    // webpack and Vite both follow `new URL('./x.js', import.meta.url)` as a
    // module or asset reference. Its base is computed, so the walk will not
    // guess: it stops, the way it stops on a computed import. Nothing in src/
    // or react/ uses the form, and this is what keeps it that way.
    expect(() => closureOf('m-import-meta-url.ts')).toThrowError(/unanalyzable import\.meta URL/);
  });

  it('reads code only: an import in a comment or a string is not an edge', () => {
    // Every decoy in the fixture names a file that does not exist, so a
    // text-level walker fails this case loudly rather than subtly.
    const closure = closureOf('j-decoys.ts');
    expect(closure.modules).toEqual([at('j-decoys.ts')]);
    expect(closure.bare).toEqual([]);
  });

  it('reports modules package-root-relative and sorted', () => {
    const { modules } = closureOf('g-chain-entry.ts');
    expect(modules.filter((m) => !m.startsWith('tests/fixtures/closure-walk/'))).toEqual([]);
    expect(modules).toEqual([...modules].sort());
  });
});

describe('isNodeBuiltin', () => {
  it('closes both spellings and nothing else', () => {
    // The `node:` scheme is the semantics a bundler refuses, whether or not a
    // module stands behind it; the unprefixed spelling is closed by the list.
    expect(isNodeBuiltin('crypto')).toBe(true);
    expect(isNodeBuiltin('node:crypto')).toBe(true);
    expect(isNodeBuiltin('react')).toBe(false);
    expect(isNodeBuiltin('ajv/dist/2020.js')).toBe(false);
  });
});

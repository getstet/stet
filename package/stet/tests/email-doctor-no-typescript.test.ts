/**
 * Doctor's wrapper-chain check where the compiler is not there — the degraded
 * path, in both of the shapes that reach it: a `typescript` carrying no
 * compiler API (TS7's package root), and no `typescript` at all.
 *
 * Its own file because `vi.mock` is file-scoped, and this mock must not shadow
 * the real compiler every other chain case parses with (the same reason
 * `tests/load-typescript-ts7.test.ts` stands alone).
 *
 * What degrades is not only the token predicate: the import walk is itself a
 * parse, so a run without the compiler cannot reach the wrapper files at all.
 * The check therefore searches each pointer file on its own, in plain text, and
 * says so — and it claims NOTHING about a token it did not find there, because
 * the file that would carry it is exactly the one this mode cannot open. Both
 * limits are asserted VERBATIM: they are the whole content of the degraded
 * line, and an assertion on its first few words passes with them stripped out.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

// The two shapes, hoisted so `vi.mock` below can name one of them.
// `createSourceFile: undefined` is spelled out because vitest's mocked
// namespace throws on a key its factory never declared, where a real module
// namespace answers `undefined`. `loadTypescript` reads `typeof … !==
// 'function'`, so both forms take the same branch.
const shapes = vi.hoisted(() => ({
  ts7: () => ({ version: '7.0.2', versionMajorMinor: '7.0', createSourceFile: undefined }),
  absent: () => {
    const error = new Error("Cannot find package 'typescript'") as Error & { code?: string };
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  },
  // A `typescript` that resolves and then throws on import: a truncated
  // install, a bad postinstall. Not a missing module, so `loadTypescript`
  // rethrows it as it is.
  broken: () => {
    throw new Error('typescript/lib/typescript.js: Unexpected end of input');
  },
}));

vi.mock('typescript', shapes.ts7);

import { TS7_REFUSAL } from '../cli/source-scan.js';
import {
  MARKETING,
  chainProject as project,
  cleanupChainProjects,
  doctor,
  write,
} from './helpers/chain-project.js';

afterAll(cleanupChainProjects);

/** Both limits, in the words the line states them in. */
const LIMITS =
  '. Each pointer file is searched on its own, as plain text; a token missing from it is reported unchecked ' +
  'rather than unfound, because the wrapper that would carry it is never opened';

/**
 * One run against a tree where `typescript` cannot be resolved at all. The mock
 * is swapped for the call and put back after it, so the file's other cases keep
 * the TS7 shape whatever order they run in.
 */
async function withoutTypescript<T>(run: () => Promise<T>, shape: typeof shapes.absent = shapes.absent): Promise<T> {
  vi.doMock('typescript', shape);
  vi.resetModules();
  try {
    return await run();
  } finally {
    vi.doMock('typescript', shapes.ts7);
    vi.resetModules();
  }
}

/** A template whose declared token lives in the imported frame. */
function unreachableTokenProject(): string {
  const dir = project({ welcome: MARKETING(['unsubscribe_url']) }, { brand__footer_address: '1 Any Road' });
  write(
    dir,
    'lib/email/welcome.ts',
    "import { frame } from './frame';\nexport function welcome(): string {\n  return frame(`<h1>Hello</h1>`);\n}\n",
  );
  // The token lives in the imported frame — the file this mode cannot reach.
  write(
    dir,
    'lib/email/frame.ts',
    'export const frame = (inner: string): string =>\n  `${inner}<a href="{{unsubscribe_url}}">Unsubscribe</a>`;\n',
  );
  return dir;
}

describe('doctor — the wrapper chain without a compiler', () => {
  it('gives a TypeScript 7 host the refusal, not an install line', async () => {
    const result = await doctor(unreachableTokenProject());
    // The host HAS typescript. "not installed (npm i -D typescript)" would name
    // the one remedy that changes nothing — so the line carries the refusal
    // `loadTypescript` itself raises, with the version that works.
    expect(result.out).toContain(`wrapper chains: degraded — ${TS7_REFUSAL}${LIMITS}`);
    // One file searched, not two, and the token counted as UNCHECKED.
    expect(result.out).toContain('wrapper chain (welcome): 1 file(s), 1 declared token(s), 1 unchecked');
    // The claim is true, so warning here would be crying wolf.
    expect(result.err).not.toContain('wrapperProvides');
    expect(result.code).toBe(0);
  });

  it('states the install remedy where typescript is genuinely absent', async () => {
    const result = await withoutTypescript(async () => doctor(unreachableTokenProject()));
    expect(result.out).toContain(`wrapper chains: degraded — typescript is not installed (npm i -D typescript)${LIMITS}`);
    // The same degraded semantics: the chain is one file, the token it cannot
    // reach is unchecked rather than unfound, and nothing is warned.
    expect(result.out).toContain('wrapper chain (welcome): 1 file(s), 1 declared token(s), 1 unchecked');
    // The reason is the missing compiler, which the degraded line above already
    // gives. Blaming a package boundary instead would name an import that this
    // pointer file need not even have.
    expect(result.out).not.toContain('the chain reaches an import it does not follow');
    expect(result.err).not.toContain('wrapperProvides');
    expect(result.code).toBe(0);
  });

  it('still satisfies a claim the pointer file itself carries', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url']) }, { brand__footer_address: '1 Any Road' });
    write(
      dir,
      'lib/email/welcome.ts',
      'export function welcome(): string {\n' +
        '  return `<h1>Hello</h1><a href="{{unsubscribe_url}}">Unsubscribe</a>`;\n}\n',
    );

    const result = await doctor(dir);
    // Positive evidence survives the degradation: nothing is left unchecked.
    // Asserted against the chain line's own tail — the degradation line above
    // it carries the word "unchecked" in its explanation.
    expect(result.out).toContain('wrapper chain (welcome): 1 file(s), 1 declared token(s)');
    expect(result.out).not.toContain('declared token(s), 1 unchecked');
    expect(result.err).not.toContain('wrapperProvides');
  });

  it('blames no import on a pointer file that has none', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url']) }, { brand__footer_address: '1 Any Road' });
    // Imports nothing and carries nothing. `pointerOnly` still reports a
    // boundary — it means "this walk followed no imports", not "an import was
    // reached" — so a clause keyed on that alone would name an import this file
    // does not have. The degraded line above carries the real reason.
    write(dir, 'lib/email/welcome.ts', 'export function welcome(): string {\n  return `<h1>Hello</h1>`;\n}\n');

    const result = await withoutTypescript(async () => doctor(dir));
    expect(result.out).toContain('wrapper chain (welcome): 1 file(s), 1 declared token(s), 1 unchecked');
    expect(result.out).not.toContain('the chain reaches an import it does not follow');
    expect(result.code).toBe(0);
  });
});

/**
 * An Astro-shaped host whose one copy module is TypeScript: the website's own
 * shape. Its `.astro` surfaces are a template dialect scan reads as text; the
 * copy module goes to the compiler.
 */
function astroHost(copyModules: string[]): string {
  const dir = project({});
  write(
    dir,
    'stet.config.json',
    JSON.stringify({ project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'], emailSurfaces: [], copyModules }),
  );
  write(dir, 'src/pages/index.astro', '---\n---\n<h1>Hello</h1>\n');
  write(dir, 'src/copy.ts', "export const copy = { hero: 'Hello' };\n");
  write(dir, 'src/more.ts', "export const more = { tagline: 'More' };\n");
  return dir;
}

describe('doctor — the compiler scan and register need', () => {
  const NOT_INSTALLED = (where: string): string =>
    `typescript: not installed — stet scan and stet register read ${where} with it; npm i -D typescript`;

  it('names the copy module and the install where typescript is absent, and exits 0', async () => {
    const result = await withoutTypescript(async () => doctor(astroHost(['src/copy.ts'])));
    expect(result.err).toContain(NOT_INSTALLED('src/copy.ts'));
    expect(result.code).toBe(0);
  });

  it('counts the other files the compiler would read', async () => {
    const result = await withoutTypescript(async () => doctor(astroHost(['src/copy.ts', 'src/more.ts'])));
    expect(result.err).toContain(NOT_INSTALLED('src/copy.ts and 1 other file'));
    expect(result.code).toBe(0);
  });

  it('says nothing where every declared file is a dialect file', async () => {
    const result = await withoutTypescript(async () => doctor(astroHost([])));
    expect(`${result.out}\n${result.err}`).not.toContain('typescript:');
    expect(result.code).toBe(0);
  });

  it('reads a typescript whose import throws as not installed, and never stops on it', async () => {
    const result = await withoutTypescript(async () => doctor(astroHost(['src/copy.ts'])), shapes.broken);
    expect(result.err).toContain(NOT_INSTALLED('src/copy.ts'));
    expect(result.code).toBe(0);
  });

  it('gives a TypeScript 7 host the refusal, not the install line', async () => {
    const result = await doctor(astroHost(['src/copy.ts']));
    expect(result.err).toContain(`${TS7_REFUSAL} — stet scan and stet register read src/copy.ts with it`);
    expect(result.err).not.toContain('typescript: not installed');
    expect(result.code).toBe(0);
  });
});

/**
 * The lazy `typescript` load on the path where stet's own copy is missing. The
 * module is mocked so the dynamic import rejects with the `ERR_MODULE_NOT_FOUND`
 * Node raises for a deleted install, and the assertion is that stet answers with
 * the one reinstall line as a CliError — not a raw module error. This lives in
 * its own file so the mock never shadows the real compiler the `scanSource`
 * tests parse with.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

// Rejects on the first import and resolves (with the real compiler) on the second,
// so the same file covers a broken install and a retry after it is repaired.
const attempts = vi.hoisted(() => ({ count: 0 }));

vi.mock('typescript', async (importOriginal) => {
  attempts.count += 1;
  if (attempts.count === 1) {
    throw Object.assign(new Error("Cannot find package 'typescript' imported from the scanner"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
  }
  return importOriginal();
});

import { TS_BROKEN, loadTypescript } from '../cli/source-scan.js';
import { CliError } from '../cli/report.js';

const LINE = 'stet could not load the TypeScript compiler it ships with — reinstall stet: npm i @getstet/stet';

describe('stet ships typescript', () => {
  const manifest = (url: string) =>
    JSON.parse(readFileSync(new URL(url, import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, unknown>;
    };

  it('lists typescript as a dependency at the workspace’s own range, and as no peer', () => {
    const shipped = manifest('../package.json');
    expect(shipped.dependencies?.['typescript']).toBe('^5.6.0');
    expect(shipped.peerDependencies?.['typescript']).toBeUndefined();
    expect(shipped.peerDependenciesMeta?.['typescript']).toBeUndefined();
    expect(manifest('../../package.json').devDependencies?.['typescript']).toBe('^5.6.0');
  });
});

describe('loadTypescript (stet’s own typescript absent)', () => {
  it('throws the reinstall line as a CliError, and loads once the install is repaired', async () => {
    expect(TS_BROKEN).toBe(LINE);
    const first = loadTypescript();
    await expect(first).rejects.toBeInstanceOf(CliError);
    await expect(first).rejects.toThrow(LINE);
    // The failure is not remembered: the next call imports again and gets the compiler.
    const ts = await loadTypescript();
    expect(typeof ts.createSourceFile).toBe('function');
    expect(attempts.count).toBe(2);
  });
});

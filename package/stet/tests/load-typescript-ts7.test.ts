/**
 * The lazy `typescript` load on the path where the resolution is TypeScript 7 —
 * whose package root exports version constants and no compiler API at all. The
 * mock is that package root exactly, so the assertion is that stet refuses by
 * VERSION with the remedy named, rather than crashing later on a missing
 * function. Its own file, like the module-absent case: `vi.mock` is file-scoped,
 * and neither mock may shadow the real compiler the scanner tests parse with.
 */
import { describe, expect, it, vi } from 'vitest';

// `createSourceFile: undefined` is spelled out because vitest's mocked
// namespace THROWS on a key its factory never declared, where a real module
// namespace answers `undefined`. The guard reads `typeof … !== 'function'`, so
// both forms take the same branch — the executed TS7 package root is the render
// seam's own `ts7-unsupported` case (`tests/email-render.test.ts`).
vi.mock('typescript', () => ({ version: '7.0.2', versionMajorMinor: '7.0', createSourceFile: undefined }));

import { CliError } from '../cli/report.js';
import { TS7_REFUSAL, loadTypescript } from '../cli/source-scan.js';

describe('loadTypescript (a typescript with no compiler API)', () => {
  it('refuses with the typescript@5 remedy, verbatim', async () => {
    await expect(loadTypescript()).rejects.toBeInstanceOf(CliError);
    await expect(loadTypescript()).rejects.toThrow(TS7_REFUSAL);
    expect(TS7_REFUSAL).toBe(
      "stet's source tools use the TypeScript 5 compiler API — typescript 7 is not yet supported; install typescript@5 as a devDependency",
    );
  });
});

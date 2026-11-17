/**
 * The lazy `typescript` load on the path where the resolution carries no
 * compiler API at all — TypeScript 7's package root, or a copy replaced by one.
 * stet ships its own 5.x, so a copy of this shape is a broken install and gets
 * the same reinstall line as a missing one. Its own file, like the
 * module-absent case: `vi.mock` is file-scoped, and neither mock may shadow the
 * real compiler the scanner tests parse with.
 */
import { describe, expect, it, vi } from 'vitest';

// `createSourceFile: undefined` is spelled out because vitest's mocked
// namespace THROWS on a key its factory never declared, where a real module
// namespace answers `undefined`. The guard reads `typeof … !== 'function'`, so
// both forms take the same branch.
vi.mock('typescript', () => ({ version: '7.0.2', versionMajorMinor: '7.0', createSourceFile: undefined }));

import { CliError } from '../cli/report.js';
import { TS_BROKEN, loadTypescript } from '../cli/source-scan.js';

const LINE = 'stet could not load the TypeScript compiler it ships with — reinstall stet: npm i @getstet/stet';

describe('loadTypescript (a typescript with no compiler API)', () => {
  it('is a broken install: the reinstall line, verbatim', async () => {
    await expect(loadTypescript()).rejects.toBeInstanceOf(CliError);
    await expect(loadTypescript()).rejects.toThrow(LINE);
    expect(TS_BROKEN).toBe(LINE);
  });
});

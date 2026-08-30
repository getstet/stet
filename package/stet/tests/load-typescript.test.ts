/**
 * The lazy `typescript` load on the path where the optional peer is absent. The
 * module is mocked so the dynamic import rejects with the `ERR_MODULE_NOT_FOUND`
 * Node raises on a default install, and the assertion is that a host without
 * `typescript` gets the actionable CliError — not a raw module error. This lives
 * in its own file so the mock never shadows the real compiler the `scanSource`
 * tests parse with.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('typescript', () =>
  Promise.reject(
    Object.assign(new Error("Cannot find package 'typescript' imported from the scanner"), {
      code: 'ERR_MODULE_NOT_FOUND',
    }),
  ),
);

import { loadTypescript } from '../cli/source-scan.js';
import { CliError } from '../cli/report.js';

describe('loadTypescript (typescript absent)', () => {
  it('throws an actionable CliError naming the install line', async () => {
    await expect(loadTypescript()).rejects.toBeInstanceOf(CliError);
    await expect(loadTypescript()).rejects.toThrow(/needs 'typescript'.*npm i -D typescript/);
  });
});

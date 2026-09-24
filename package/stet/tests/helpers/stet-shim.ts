/**
 * A checkout's own `node_modules/.bin/stet`, pointing at this package's BUILT
 * bin — what the shipped pre-commit gate runs when git calls it.
 *
 * The gate runs the stet installed in its checkout, so a case that proves the
 * gate needs one there, and the built bin is the only stet a temp checkout can
 * reach without an install. `hideTypescript` puts a resolve hook in front of
 * the bin that answers `typescript` as not found, which is a host whose
 * compiler is missing while the hook, the bin and the scan are the shipped ones;
 * `breakTypescript` resolves it to a module whose import throws, a broken install.
 *
 * Consumers: `tests/hook.test.ts` (the gate run with a real stet),
 * `tests/dev.test.ts` (the shipped gate's refusal through the commit route) and
 * `conformance/conformance.test.ts` (doctor's compiler warn). Each skips where
 * the bin has not been built.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageRoot } from '../../cli/installed.js';

/** The built bin the shim runs. `npm test` builds first; a bare vitest run may not have. */
export const BUILT_BIN = join(packageRoot(), 'dist', 'cli', 'main.js');

/** Whether the shim has a bin to run. */
export const builtBinExists = (): boolean => existsSync(BUILT_BIN);

/**
 * Write the shim into `checkout`, and a `.gitignore` that keeps it and its
 * tools out of every commit the case makes.
 */
export function installStetShim(
  checkout: string,
  opts: { hideTypescript?: boolean; breakTypescript?: boolean } = {},
): void {
  mkdirSync(join(checkout, 'node_modules', '.bin'), { recursive: true });
  const imports: string[] = [];
  if (opts.hideTypescript === true || opts.breakTypescript === true) {
    mkdirSync(join(checkout, 'tools'), { recursive: true });
    const answer =
      opts.breakTypescript === true
        ? [
            "    return { url: 'data:text/javascript,throw new Error(\"a broken typescript install\")', shortCircuit: true };",
          ]
        : [
            '    const error = new Error("Cannot find package \'typescript\' imported from stet");',
            "    error.code = 'ERR_MODULE_NOT_FOUND';",
            '    throw error;',
          ];
    writeFileSync(
      join(checkout, 'tools', 'hide-typescript.mjs'),
      [
        'export async function resolve(specifier, context, next) {',
        "  if (specifier === 'typescript') {",
        ...answer,
        '  }',
        '  return next(specifier, context);',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(checkout, 'tools', 'register.mjs'),
      "import { register } from 'node:module';\nregister('./hide-typescript.mjs', import.meta.url);\n",
    );
    imports.push('--import', JSON.stringify(join(checkout, 'tools', 'register.mjs')));
  }
  const bin = join(checkout, 'node_modules', '.bin', 'stet');
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${imports.join(' ')} ${JSON.stringify(BUILT_BIN)} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(join(checkout, '.gitignore'), 'node_modules\ntools\n');
}

/**
 * The files that ship inside stet itself — the numbered migrations and the
 * package manifest — located from wherever this module is running.
 *
 * There are two layouts and both are real: the published package runs
 * `dist/cli/*.js`, two levels below the package root, while the test suite
 * transforms `cli/*.ts` in place, one level below it. Depth alone cannot tell
 * them apart safely (`package/package.json`, the workspace manifest, sits
 * exactly where the two-level guess lands), so the root is the nearest
 * ancestor whose manifest actually names this package.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliError } from './report.js';

export interface Migration {
  number: number;
  name: string;
  path: string;
}

let root: string | null = null;

/** The installed package's own directory. */
export function packageRoot(): string {
  if (root !== null) return root;
  for (const up of ['../../', '../']) {
    const dir = fileURLToPath(new URL(up, import.meta.url));
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@getstet/stet') {
        root = dir;
        return dir;
      }
    } catch {
      // A manifest that will not parse is not this package's.
    }
  }
  throw new CliError('cannot locate the stet installation — its own package.json is not where it should be');
}

/** The package's numbered migrations, in order. */
export function migrations(): Migration[] {
  const dir = join(packageRoot(), 'migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ number: Number.parseInt(name, 10), name, path: join(dir, name) }))
    .filter((m) => Number.isFinite(m.number))
    .sort((a, b) => a.number - b.number);
}

/** The installed version — the first thing a bug report needs. */
export function packageVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

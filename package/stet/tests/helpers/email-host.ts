/**
 * A temp host project for the email commands — the one place that knows how to
 * give a throwaway directory a working `node_modules`.
 *
 * `stet email verify` renders through the HOST's own `typescript` and
 * `react-dom/server`, resolved by `createRequire` from the host's
 * `package.json`. A `mkdtemp` directory has neither, and nothing up its chain
 * does either, so a fixture host has to be given them: `deps: 'all'` links the
 * workspace's whole `node_modules`, and a named list links only those packages —
 * which is how the missing-dependency arm is produced at all.
 *
 * Consumers: `tests/email-render.test.ts`, `tests/email-extract.test.ts` and
 * `tests/email-verify.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { packageRoot } from '../../cli/installed.js';

/** The workspace's installed packages — what a real adopter's host would have. */
const WORKSPACE_MODULES = join(packageRoot(), '..', 'node_modules');

const made: string[] = [];

/**
 * Every host this run created, removed. `rmSync` unlinks symlinks rather than
 * following them, so the workspace's own `node_modules` is never reached.
 */
export function cleanupEmailHosts(): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.length = 0;
}

export interface EmailHost {
  dir: string;
  /** Write a file, creating its directories. Returns the absolute path. */
  put(rel: string, text: string): string;
  path(rel: string): string;
}

export interface EmailHostOptions {
  /** `'all'` (the default) links the workspace's whole set; a list links those packages only. */
  deps?: 'all' | string[];
  /** Extra `package.json` fields — a host manifest is otherwise minimal. */
  manifest?: Record<string, unknown>;
}

export function makeEmailHost(opts: EmailHostOptions = {}): EmailHost {
  const dir = mkdtempSync(join(tmpdir(), 'stet-email-'));
  made.push(dir);

  const put = (rel: string, text: string): string => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
    return path;
  };
  put('package.json', `${JSON.stringify({ name: 'email-host', version: '1.0.0', ...opts.manifest }, null, 2)}\n`);

  const deps = opts.deps ?? 'all';
  if (deps === 'all') {
    symlinkSync(WORKSPACE_MODULES, join(dir, 'node_modules'), 'dir');
  } else {
    mkdirSync(join(dir, 'node_modules'));
    for (const name of deps) symlinkSync(join(WORKSPACE_MODULES, name), join(dir, 'node_modules', name), 'dir');
  }

  return { dir, put, path: (rel: string) => join(dir, rel) };
}

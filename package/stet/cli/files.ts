/**
 * Which files a declaration names — the dirent walk and the glob match over it,
 * and nothing else. No file CONTENT is read here: only a caller opens what this
 * hands back.
 *
 * It is a leaf so the modules that need a file list can take it without taking
 * a command with it. `pages.ts` and `scan.ts`, which owned these before their
 * second and third consumers arrived, re-export what they exported.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { posixRelative } from './report.js';
import { matchGlob } from './source-scan.js';

/** Directories a walk never descends into — a `**`-prefixed glob has an empty static prefix and would otherwise enumerate them. */
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', '.next']);

/**
 * Recursive directory walk over dirents — no file content is read. Shared with
 * `scan`, whose `filesForGlobs` walks each glob's static prefix through it.
 */
export function walk(dir: string, onFile: (absPath: string) => void): void {
  const entries = safeReaddir(dir);
  if (entries === null) return; // a static prefix that does not exist yet is empty
  for (const entry of entries) {
    if (entry.isDirectory() && WALK_SKIP.has(entry.name)) continue; // P3-17: never enumerate these
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, onFile);
    else if (entry.isFile()) onFile(abs);
  }
}

/** `readdirSync` with dirents, or null when the directory is absent. */
function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * Every file matching one of the given globs — managed surfaces or declared
 * copy modules — walked from each glob's static prefix so nothing outside them
 * (node_modules included) is even enumerated, and the file CONTENT is never
 * read here: only the caller opens a matched file. Shared with `register`,
 * which re-walks the same declarations itself.
 */
export function filesForGlobs(cwd: string, globs: string[]): string[] {
  const found = new Set<string>();
  for (const glob of globs) {
    const root = staticPrefix(glob);
    walk(join(cwd, root), (abs) => {
      const rel = posixRelative(cwd, abs);
      if (globs.some((g) => matchGlob(g, rel))) found.add(rel);
    });
  }
  return [...found].sort();
}

/** The leading directory of a glob with no wildcard — the only one worth walking. Shared with the dashboard's pending list. */
export function staticPrefix(glob: string): string {
  const parts = glob.split('/');
  const solid: string[] = [];
  for (const part of parts) {
    if (/[*?{[]/.test(part)) break;
    solid.push(part);
  }
  // A trailing solid segment that names a file (a wildcard-free glob like
  // `app/page.tsx`) is not a directory — walk its parent instead.
  const last = solid[solid.length - 1];
  if (last !== undefined && last.includes('.') && solid.length === parts.length) solid.pop();
  return solid.join('/');
}

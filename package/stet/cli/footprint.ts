/**
 * stet's own footprint on a React host's production page, read once: whether
 * the read path imports the provider's index, and which files of the checkout
 * read copy on the client. `stet upgrade` changes what these find and
 * `stet audit lighthouse` reports it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isHtmlHost, type StetConfig } from './config.js';
import { walk } from './files.js';
import { posixRelative } from './report.js';

/** The line `init` wrote before 0.7.0, and the line it writes now. */
export const INIT_READ_IMPORT = "import { createServerCopy } from '@getstet/stet/react';";
export const SERVER_READ_IMPORT = "import { createServerCopy } from '@getstet/stet/react/server';";

/** The read path's provider import: the line `init` wrote, another `@getstet/stet/react` import, or neither. */
export type ReadPathImport = 'init-line' | 'other' | 'clean';

/** Which of the three the read path carries, read line by line; an html host and a missing file are `clean`. */
export function readPathImport(cwd: string, config: StetConfig): ReadPathImport {
  const path = join(cwd, config.readPath.file);
  if (isHtmlHost(config) || !existsSync(path)) return 'clean';
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const initLines = lines.filter((line) => line === INIT_READ_IMPORT).length;
  // Another `@getstet/stet/react` import beside the line `init` wrote is `other`:
  // rewriting the one line would leave the file importing the provider's index
  // anyway, and one predicate decides the write and the audit's line alike.
  const otherImport = /from\s*['"]@getstet\/stet\/react['"]/.test(lines.filter((line) => line !== INIT_READ_IMPORT).join('\n'));
  if (initLines === 1 && !otherImport) return 'init-line';
  return initLines > 0 || otherImport ? 'other' : 'clean';
}

/**
 * Any reference to the provider's module in import position: a named, namespace or default import, an
 * export-from, a side-effect import, a dynamic `import()` or a `require`. A client can reach `useCopy`
 * through any of them, so the mount stays for each.
 */
const PROVIDER_MODULE_REF =
  /\b(?:import|export)\b[^;'"`]*?\bfrom\b\s*['"]@getstet\/stet\/react['"]|\bimport\s*['"]@getstet\/stet\/react['"]|\b(?:import|require)\s*\(\s*['"]@getstet\/stet\/react['"]\s*\)/;

/** The root layout's own mount import: the one reference to the provider module that is not a read. */
const ROOT_LAYOUT_MOUNT_IMPORT = /\bimport\s*\{\s*CopyProvider\s*\}\s*from\s*['"]@getstet\/stet\/react['"]/g;

/** Build and cache output the walk never reads, beside `WALK_SKIP`'s four: a bundle there mentions the import without being a source. */
const BUILT_OUTPUT = new Set(['out', 'build', 'coverage', '.turbo', '.cache', '.vercel', '.output', '.astro']);

/**
 * Every source file of the checkout that references `@getstet/stet/react` —
 * the client reads a provider serves, however a file reaches `useCopy`. The
 * root layout counts once its own `CopyProvider` import is blanked, and a read
 * path that `upgrade` rewrites to the server subpath first is not a read. A text walk over the
 * whole checkout (`walk`, which skips `node_modules`, `.git`, `dist` and
 * `.next`, with `BUILT_OUTPUT` skipped here — `WALK_SKIP`'s other consumers
 * are glob walks), not the managed surfaces alone: a hand-written
 * `components/Nav.tsx` outside `app/**` reads copy too, and an unmount under
 * it fails the next build. Text-level, so a mention in a comment counts — the
 * direction that leaves the mount in place.
 */
export function clientReadFiles(cwd: string, config: StetConfig): string[] {
  const skipped = new Set<string>();
  if (readPathImport(cwd, config) === 'init-line') skipped.add(config.readPath.file);
  const out: string[] = [];
  walk(cwd, (abs) => {
    const rel = posixRelative(cwd, abs);
    if (rel.split('/').some((segment) => BUILT_OUTPUT.has(segment))) return;
    if (!/\.(?:[cm]?[jt]sx?)$/.test(abs) || skipped.has(rel)) return;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    // The root layout is read like any file with its own provider import blanked: on Vite it is the
    // entry file, and a component `register` wrote a `useCopy` into there reads the provider too.
    if (rel === config.rootLayout) text = text.replace(ROOT_LAYOUT_MOUNT_IMPORT, '');
    if (PROVIDER_MODULE_REF.test(text)) out.push(rel);
  });
  return out.sort();
}

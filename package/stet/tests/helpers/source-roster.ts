/**
 * What the package's source files ARE, in one place — the collection every
 * structural guard walks.
 *
 * Two properties are the whole point, and both were holes that shipped past a
 * guard before this existed. The walk is RECURSIVE: a bare `readdirSync` lists
 * no subdirectory, so a new layer under `src/` sits outside the check written
 * to cover it, silently — which is the exact failure mode a structural check is
 * supposed to make impossible. And the extension test is `.ts`, `.mts` AND
 * `.cts`, because TypeScript compiles all three into `dist/` while
 * `endsWith('.ts')` sees only the first.
 *
 * It lives here, beside the other cross-suite helper, because both the offline
 * guard and the conformance walk's CLI-boundary case collect the same files:
 * two consumers, one collection, no second definition of "source file" to
 * drift.
 */

import { readdirSync } from 'node:fs';
import { sep } from 'node:path';

/** The extensions TypeScript compiles — the one definition of a source file. */
const SOURCE = /\.[cm]?ts$/;

/**
 * Every source file under `dir`, recursively, as `/`-separated paths relative
 * to it, sorted. Directory entries and non-source files are dropped, and the
 * platform separator is normalized so a roster reads the same everywhere.
 */
export function sourceFiles(dir: URL): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => entry.toString().split(sep).join('/'))
    .filter((name) => SOURCE.test(name))
    .sort();
}

/**
 * A path's filename without its source extension — `targets/web.mts` → `web`.
 * It reads the same extension set as the collection above, which is why it
 * lives here: a banned-name check that stripped only `.ts` would wave through
 * the `utils.mts` the check exists to stop.
 */
export function stemOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(SOURCE, '');
}

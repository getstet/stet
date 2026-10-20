/**
 * The import closure: files and everything they reach by import or re-export,
 * depth-bounded, plus whether the walk stopped somewhere it could not follow.
 * `doctor`'s wrapper chain walks a render pointer's file and its frame's;
 * `stet dev`'s route reads walk a page's files through the host's path aliases.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';

import type * as TS from 'typescript';

import { posixRelative } from './report.js';
import { scriptKindFor } from './source-scan.js';

/** How deep the walk goes before it stops following. */
export const CHAIN_DEPTH = 10;

/** The extensions a specifier may resolve to, in resolution order. */
export const CHAIN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** The files a walk read, and whether that was all of them. */
export interface Chain {
  files: Array<{ rel: string; text: string }>;
  /** The walk met an import it does not follow — a package, or an unreadable file. */
  boundary: boolean;
}

/**
 * Every entry file and everything it reaches by RELATIVE import or re-export,
 * depth-bounded, plus whether the walk stopped somewhere it could not follow.
 *
 * Package imports are never followed: a wrapper that lives in `node_modules` is
 * not the host's source, and walking into one would turn a bounded read into a
 * dependency-tree crawl. But a chain that met one is INCOMPLETE, and the caller
 * has to know: the frame carrying the token may be exactly the file behind that
 * import, so "not found here" is not "not there" — the same distinction the
 * compiler-less degradation draws.
 *
 * Where `alias` is given, a non-relative specifier is the alias's to answer: a
 * repo-relative file to visit, `null` for one that should resolve and did not
 * (a boundary), or `undefined` for one that is not the host's source (a
 * package: not followed, and no boundary). Without it, every non-relative
 * specifier is a boundary.
 *
 * Where `contained` is given, a file it refuses is a boundary, not followed:
 * the route reads use it to keep a symlink out of the checkout from being
 * walked.
 *
 * Re-exports are followed because a component directory's barrel
 * (`export { Footer } from './footer'`) is how most host code reaches its
 * frame, and a walk that stopped at the barrel would report every token the
 * frame carries as missing from a chain that never opened the frame.
 */
export function importClosure(
  ts: typeof import('typescript'),
  cwd: string,
  entries: readonly string[],
  alias?: (fromRel: string, spec: string) => string | null | undefined,
  contained?: (rel: string) => boolean,
): Chain {
  const files: Array<{ rel: string; text: string }> = [];
  const seen = new Set<string>();
  let boundary = false;

  const visit = (rel: string, depth: number): void => {
    if (seen.has(rel)) return;
    if (depth > CHAIN_DEPTH || (contained !== undefined && !contained(rel))) {
      boundary = true;
      return;
    }
    seen.add(rel);
    const abs = join(cwd, rel);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      boundary = true;
      return;
    }
    files.push({ rel, text });

    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, abs));
    for (const stmt of sf.statements) {
      const spec = moduleSpecifier(ts, stmt);
      if (spec === undefined) continue;
      const relative = spec.startsWith('./') || spec.startsWith('../');
      const target = relative ? resolveRelative(cwd, rel, spec) : alias === undefined ? null : alias(rel, spec);
      if (target === undefined) continue;
      if (target === null) boundary = true;
      else visit(target, depth + 1);
    }
  };

  for (const entry of entries) visit(entry, 0);
  return { files, boundary };
}

/** The module an import or a re-export names, where it names one. */
export function moduleSpecifier(ts: typeof import('typescript'), stmt: TS.Statement): string | undefined {
  if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) return stmt.moduleSpecifier.text;
  if (
    ts.isExportDeclaration(stmt) &&
    stmt.moduleSpecifier !== undefined &&
    ts.isStringLiteral(stmt.moduleSpecifier)
  ) {
    return stmt.moduleSpecifier.text;
  }
  return undefined;
}

/** An absolute path, extension probed, as a repo-relative file; null where nothing is there. */
export function probeFile(cwd: string, base: string): string | null {
  const candidates = [
    base,
    ...CHAIN_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...CHAIN_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    // `node_modules` is never entered, even by a specifier that reaches it the
    // long way round (`../../node_modules/x`).
    if (candidate.split(sep).includes('node_modules')) continue;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    return posixRelative(cwd, candidate);
  }
  return null;
}

/** A relative specifier as a repo-relative path, extension probed. */
export function resolveRelative(cwd: string, fromRel: string, spec: string): string | null {
  return probeFile(cwd, resolvePath(dirname(join(cwd, fromRel)), spec));
}

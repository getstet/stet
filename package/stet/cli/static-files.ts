/**
 * Serving a checkout's files: the containment every static route applies and
 * the types a static site is served as. The dashboard's static pane and
 * `stet audit lighthouse`'s documents server share it.
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';

/** Whether the real path `real` is the real root or lies under it. */
const withinRoot = (realRoot: string, real: string): boolean => real === realRoot || real.startsWith(realRoot + sep);

/**
 * A path inside the checkout that names a readable file, or null.
 *
 * The containment test runs on the REAL path, so `..`, an absolute segment and
 * a symlink pointing out of the checkout are all one refusal. A directory
 * serves its `index.html` and nothing else — there is no listing.
 */
export function insideCheckout(root: string, target: string): string | null {
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(statSync(target).isDirectory() ? join(target, 'index.html') : target);
  } catch {
    return null;
  }
  if (!withinRoot(realRoot, real)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Whether a path stet is about to WRITE stays inside the checkout, by real path.
 *
 * The target need not exist: its nearest existing ancestor is resolved
 * (symlinks and letter case included, through the native `realpath`) and must
 * lie under the checkout's own real path. A symlink at the target itself, or at
 * any component that dangles, is refused, since `writeFile` would follow it out.
 */
export function containsPath(root: string, target: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return false;
  }
  const written = resolvePath(root, target);
  const linked = (path: string): boolean => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (linked(written)) return false;
  for (let at = written; ; at = dirname(at)) {
    try {
      return withinRoot(realRoot, realpathSync.native(at));
    } catch {
      // A link that dangles is a way out; anything else is a path not made yet.
      if (linked(at) || dirname(at) === at) return false;
    }
  }
}

/**
 * The real path a write to `target` would land on: its nearest existing
 * ancestor resolved through the native `realpath`, the not-yet-made tail
 * appended. Null where nothing on the way can be resolved.
 */
function realWriteTarget(root: string, target: string): string | null {
  let tail = '';
  for (let at = resolvePath(root, target); ; at = dirname(at)) {
    try {
      return join(realpathSync.native(at), tail);
    } catch {
      if (dirname(at) === at) return null;
      tail = tail === '' ? basename(at) : join(basename(at), tail);
    }
  }
}

/**
 * Whether writing `target` would land on the file `kept` names, by real path or
 * by device and inode: a symlinked folder inside the checkout, or a hard link,
 * reaches a file the path as written does not show.
 */
export function landsOnFile(root: string, target: string, kept: string): boolean {
  const there = realWriteTarget(root, target);
  if (there === null) return false;
  if (there === realWriteTarget(root, kept)) return true;
  try {
    const a = statSync(there);
    const b = statSync(resolvePath(root, kept));
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/**
 * The file a URL path names under `root`, or null: every segment decoded, a
 * dot-leading segment (the `.env` and `.git` family) and `node_modules`
 * refused, and the rest contained by `insideCheckout`.
 */
export function servableFile(root: string, urlPath: string): string | null {
  let parts: string[];
  try {
    parts = urlPath.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    // A malformed percent-escape is a path this server does not have, the
    // same as every other one it cannot resolve.
    return null;
  }
  // A checkout holds more than its documents. A dot-leading segment is the
  // whole `.env`/`.git` family and `node_modules` is the other bulk of it;
  // neither is ever a page.
  if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) return null;
  return insideCheckout(root, resolvePath(root, ...parts));
}

/** The types a static site is served as. Anything else is bytes. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  map: 'application/json',
};

/** A file's served type, by its extension; an own entry only, so `x.constructor` is bytes. */
export function contentTypeOf(file: string): string {
  const dot = file.lastIndexOf('.');
  const extension = dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CONTENT_TYPES, extension) ? (CONTENT_TYPES[extension] as string) : 'application/octet-stream';
}

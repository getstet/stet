/**
 * Serving a checkout's files: the containment every static route applies and
 * the types a static site is served as. The dashboard's static pane and
 * `stet audit lighthouse`'s documents server share it.
 */

import { realpathSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

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
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
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

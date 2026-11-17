import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createServerCopy } from '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';

import descriptorJson from '../content/descriptor.json';

const descriptor = descriptorJson as unknown as Descriptor;

// The committed bundle (or the snapshot, snapshot-only), read at request
// time so a published change is served without a rebuild. Re-read when the
// file changes, so a running dev server serves an edit on the next request.
const READ_FROM = join(process.cwd(), 'content/defaults.json');
let cache: { mtimeMs: number; size: number; resolved: Record<string, unknown> } | undefined;
function current() {
  try {
    const { mtimeMs, size } = statSync(READ_FROM);
    if (cache === undefined || cache.mtimeMs !== mtimeMs || cache.size !== size) {
      const raw = JSON.parse(readFileSync(READ_FROM, 'utf8'));
      cache = { mtimeMs, size, resolved: resolveAll(descriptor, readBundle(raw)).resolved };
    }
    return cache.resolved;
  } catch (error) {
    // Mid-publish the file is briefly truncated, absent or half-written. The
    // last good resolution is served across that window; with nothing read
    // yet there is nothing to serve and the error is the answer.
    if (cache === undefined) throw error;
    return cache.resolved;
  }
}

// A live view over the current resolution: property reads, `in` and key
// enumeration all consult the file's mtime first.
const resolved: Record<string, unknown> = new Proxy({}, {
  get: (_, key) => current()[key as string],
  has: (_, key) => key in current(),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_, key) => Object.getOwnPropertyDescriptor(current(), key),
  // Sealing this view would leave it permanently broken: the empty target
  // would become non-extensible and every later key enumeration would throw
  // for reporting keys the target does not have. Refusing makes the freeze
  // itself throw, which a caller can catch, and leaves the view working.
  preventExtensions: () => false,
});

// stet register inserts: import { copy } from '@/lib/content'
export const copy = createServerCopy(descriptor, resolved);

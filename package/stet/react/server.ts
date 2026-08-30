/**
 * The server accessor — the same copy access for server components, with no
 * provider and no context. `init` scaffolds the read path around it:
 * `export const copy = createServerCopy(descriptor, resolved)`, where `resolved`
 * is the read path's own `resolveAll` map.
 *
 * A thin wrapper over the framework-free `createAccessor`, so the server and
 * client bindings serve a key identically. It imports no `react`: a server
 * component calls it directly.
 */

import { createAccessor, type Accessor, type AccessorOptions } from '../src/access.js';
import type { ContentKey, Descriptor } from '../src/types.js';

/** The accessor for a server component — callable for text keys, `.get()` for other shapes. */
export function createServerCopy<K extends string = ContentKey>(
  descriptor: Descriptor,
  resolved: Record<string, unknown>,
  opts?: AccessorOptions,
): Accessor<K> {
  return createAccessor<K>(descriptor, resolved, opts);
}

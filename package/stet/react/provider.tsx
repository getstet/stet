/**
 * `@getstet/stet/react` — the client binding. `CopyProvider` holds a pre-resolved
 * key→value map and the descriptor; `useCopy()` returns an accessor over them
 * and does NO resolution of its own, so a leaf adopts without threading props
 * through its callers. Both are thin over the framework-free `createAccessor`
 * (`src/access.ts`), so the client and server bindings share one contract.
 *
 * The provider carries a CLIENT-SAFE map: `init` builds it from a static
 * snapshot import, never a server read, so nothing pulls `fs`/`node:` into the
 * browser bundle.
 *
 * `'use client'` is required and lives ONLY here: `useCopy` calls `createContext`,
 * which throws under the react-server condition, so without the directive every
 * App-Router host that `init` mounts fails `next build`. `index.ts` and
 * `server.ts` stay UNDIRECTED — `createServerCopy` must remain server-evaluable,
 * and a server module importing this "use client" module is the correct RSC
 * boundary.
 */

'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { createAccessor, type Accessor } from '../src/access.js';
import type { ContentKey, Descriptor } from '../src/types.js';

interface CopyContextValue {
  descriptor: Descriptor;
  resolved: Record<string, unknown>;
}

const CopyContext = createContext<CopyContextValue | null>(null);

export interface CopyProviderProps {
  descriptor: Descriptor;
  resolved: Record<string, unknown>;
  children: ReactNode;
}

/** Mount once at the root layout; `init` writes this edit. */
export function CopyProvider({ descriptor, resolved, children }: CopyProviderProps): ReactNode {
  const value = useMemo(() => ({ descriptor, resolved }), [descriptor, resolved]);
  return <CopyContext.Provider value={value}>{children}</CopyContext.Provider>;
}

/**
 * The accessor for the copy the enclosing `CopyProvider` resolved — callable for
 * text keys, `.get()` for other shapes. Memoized on the provider's
 * descriptor+resolved, so it is stable between renders. Generic on the generated
 * `ContentKey`: a host that has run codegen gets typed keys, one that has not
 * degrades to `string`. Throws a clear error outside a provider.
 */
export function useCopy<K extends string = ContentKey>(): Accessor<K> {
  const ctx = useContext(CopyContext);
  // useMemo runs unconditionally (rules-of-hooks); the null guard throws after.
  const accessor = useMemo(
    () => (ctx === null ? null : createAccessor<K>(ctx.descriptor, ctx.resolved)),
    [ctx],
  );
  if (accessor === null) {
    throw new Error(
      'useCopy() was called outside a <CopyProvider>. Mount the provider in your root layout ' +
        '(stet init does this), or use createServerCopy in a server component.',
    );
  }
  return accessor;
}

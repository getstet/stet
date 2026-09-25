// Development builds only: which component read which key. `useCopy` hands its
// accessor through `recordReads`, which notes the component rendering at that
// moment (React's development owner) against every key the accessor returns.
// The capture helper narrows a key's text matches to the ones drawn inside a
// component that read it.
import * as React from 'react';

type Accessor = ((key: any) => string) & { get: (key: any) => unknown };

const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Per fiber, the keys its latest render read. A fiber and its alternate take
// turns rendering, so the newer of the two entries is the one on screen.
type Reads = { at: number; keys: Set<string> };
const reads = new WeakMap<object, Reads>();
let tick = 0;
let tracked = false;

export function recordReads<A extends Accessor>(copy: A): A {
  const owner: object | null = internals?.A?.getOwner?.() ?? null;
  if (!owner) return copy;
  tracked = true;
  const entry: Reads = { at: ++tick, keys: new Set() };
  reads.set(owner, entry);
  const wrapped = ((key: string) => {
    entry.keys.add(key);
    return copy(key);
  }) as A;
  wrapped.get = (key: string) => {
    entry.keys.add(key);
    return copy.get(key);
  };
  return wrapped;
}

/** True once any read has been recorded: narrowing is available. */
export function readsTracked() {
  return tracked;
}

/** Whether this fiber's latest render read the key. */
export function readBy(key: string, fiber: any): boolean {
  if (!fiber) return false;
  const a = reads.get(fiber);
  const b = fiber.alternate ? reads.get(fiber.alternate) : undefined;
  const latest = a && b ? (a.at > b.at ? a : b) : (a ?? b);
  return Boolean(latest?.keys.has(key));
}

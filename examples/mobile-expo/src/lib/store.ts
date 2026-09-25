import { useSyncExternalStore } from 'react';

/** A tiny external store: one value, a setter and a hook that re-renders on change. */
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = () => value;
  const set = (next: T | ((prev: T) => T)) => {
    value = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
    for (const listener of listeners) listener();
  };
  const use = () => useSyncExternalStore(subscribe, get, get);
  return { get, set, subscribe, use };
}

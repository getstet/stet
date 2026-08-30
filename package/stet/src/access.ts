import type { ContentKey, Descriptor } from './types.js';

/** A key reached in a way the descriptor does not support. */
export class AccessError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'AccessError';
    this.key = key;
  }
}

export interface Accessor<K extends string = ContentKey> {
  /** Text-shaped keys only — every other shape goes through `get`. */
  (key: K): string;
  get(key: K): unknown;
}

export interface AccessorOptions {
  /**
   * What to do with a key the descriptor does not declare. `throw` (the
   * default) is the honest posture: no environment sniffing, the caller
   * chooses. `fallback` serves whatever the resolved map holds.
   */
  onUnknownKey?: 'throw' | 'fallback';
}

/**
 * Ambient copy access, framework-free. The host wiring — a server accessor in
 * server components, `useCopy()` under a `CopyProvider` in client components —
 * is built on this; the React layer and the init scaffold belong to later
 * changes. Ambient access is permitted, never mandated: a host that already
 * threads copy through props seams stays conformant.
 *
 * `resolved` is a map produced by the read path (one `resolve` per key, or a
 * bundle read). The accessor does no resolution of its own, which is what keeps
 * a leaf's adoption free of caller changes.
 */
export function createAccessor<K extends string = ContentKey>(
  d: Descriptor,
  resolved: Record<string, unknown>,
  opts?: AccessorOptions,
): Accessor<K> {
  const onUnknownKey = opts?.onUnknownKey ?? 'throw';

  const read = (key: K): unknown => {
    if (!(key in d.keys)) {
      if (onUnknownKey === 'throw') {
        throw new AccessError(key, `"${key}" is not a key in this descriptor`);
      }
      return resolved[key];
    }
    if (!(key in resolved)) {
      throw new AccessError(
        key,
        `"${key}" is declared but absent from the resolved map — resolve it before handing the map to an accessor`,
      );
    }
    return resolved[key];
  };

  const accessor = ((key: K): string => {
    const shape = d.keys[key]?.shape;
    if (shape !== undefined && shape !== 'text') {
      throw new AccessError(
        key,
        `"${key}" is shape: ${shape} — the callable accessor serves text keys; use .get("${key}")`,
      );
    }
    const value = read(key);
    if (typeof value !== 'string') {
      if (shape === undefined && onUnknownKey === 'fallback') return '';
      throw new AccessError(key, `"${key}" did not resolve to a string`);
    }
    return value;
  }) as Accessor<K>;

  accessor.get = read;
  return accessor;
}

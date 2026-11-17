/** Merges a patch into a token tree. `color.primary` and `{ color: { primary } }` name the same token. */
export function merge(target: any, patch: any): any {
  if (!patch || typeof patch !== 'object') return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      const [head, ...rest] = key.split('.');
      out[head] = merge(out[head] ?? {}, { [rest.join('.')]: value });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = merge(out[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const ALIAS = /^\{([\w.-]+)\}$/;

function lookup(root: any, path: string): unknown {
  let node = root;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Replaces every `{group.token}` alias with the value it names, following
 * chains. An alias to a group (a spring) takes the whole group. An alias that
 * names nothing, or loops, is left as written.
 */
export function resolveAliases<T>(root: T): T {
  const walk = (node: unknown, seen: string[]): unknown => {
    if (typeof node === 'string') {
      const m = ALIAS.exec(node);
      if (!m || seen.includes(m[1])) return node;
      const target = lookup(root, m[1]);
      return target === undefined ? node : walk(target, [...seen, m[1]]);
    }
    if (Array.isArray(node)) return node.map((v) => walk(v, seen));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, seen);
      return out;
    }
    return node;
  };
  return walk(root, []) as T;
}

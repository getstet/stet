// Development builds only: `stetweather://stet/state?point=<id>` opens a point
// by hand. The link handler files the request; StetDev applies the recipe once
// the navigator is ready.
import { createStore } from '@/lib/store';

import { pointOf } from './recipe';

export const pendingPoint = createStore<string | null>(null);

function query(path: string) {
  const q = path.split('?')[1] ?? '';
  return Object.fromEntries(
    q
      .split('&')
      .filter(Boolean)
      .map((pair) => pair.split('=').map((s) => decodeURIComponent(s)) as [string, string]),
  );
}

/** The path to open for a state link, or null when the link is not one. */
export function redirectStateLink(path: string): string | null {
  const stripped = path.replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/^\/+/, '');
  if (!stripped.startsWith('stet/state')) return null;
  const id = query(stripped).point;
  const point = id ? pointOf(id) : null;
  if (!point) return path;
  pendingPoint.set(id);
  return point.screen;
}

// Development builds only: a point's state recipe, from the flow file, applied
// to the running app. The account preset and the fixture go into the mock
// layer; the navigation stack is reset to the recipe's stack, so a point never
// carries whatever screen came before it.
import { router } from 'expo-router';
import { Platform } from 'react-native';

import { applyMockState } from '@/api/mock';
import { copyDrafts } from '@/copy';
import { themeOverrides } from '@/theme';

import flows from '../../stet.flows.json';

export type Point = {
  screen: string;
  stack: string[];
  title: string;
  account?: string;
  fixture?: string;
  overrides?: { clock?: string; flags?: Record<string, unknown> };
};

export const points = flows.points as Record<string, Point>;

export function pointOf(id: string): Point | null {
  return Object.hasOwn(points, id) ? points[id] : null;
}

/** `/settings/units?draft=fahrenheit` → the stack route `settings/units` and its params. */
function routeOf(href: string, routeNames: string[]) {
  const [path, query = ''] = href.split('?');
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const name = [trimmed, trimmed ? `${trimmed}/index` : 'index'].find((n) => routeNames.includes(n));
  const params: Record<string, string> = {};
  for (const pair of query.split('&').filter(Boolean)) {
    const [k, v = ''] = pair.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return name ? { name, params } : null;
}

/** The path a stack route shows: `settings/index` → `/settings`. */
export function pathOf(routeName: string | null): string | null {
  if (routeName == null) return null;
  return '/' + routeName.replace(/(^|\/)index$/, '');
}

export type Applied = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Applies the recipe and resets the root stack through the navigation
 * container. Refuses, before touching anything, a stack naming a screen the
 * app does not have.
 */
export function applyPoint(
  id: string,
  navRef: any,
  variation: { appearance?: 'light' | 'dark'; textScale?: number; keepDrafts?: boolean },
): Applied {
  const point = pointOf(id);
  if (!point) return { ok: false, reason: `no point "${id}" in stet.flows.json` };
  // Expo Router keeps the root layout's stack under a `__root` route.
  const root = navRef?.getRootState?.();
  const holder = root?.routes?.find((r: any) => r.name === '__root');
  const routeNames: string[] = (holder ? holder.state?.routeNames : root?.routeNames) ?? [];
  const routes = [];
  for (const href of point.stack) {
    const route = routeOf(href, routeNames);
    if (!route) return { ok: false, reason: `the app has no screen ${href.split('?')[0]}` };
    routes.push(route);
  }
  const refused = applyMockState(point.account ?? null, point.fixture ?? null);
  if (refused) return { ok: false, reason: refused };
  if (!variation.keepDrafts) copyDrafts.set({});
  themeOverrides.set((o) => ({
    ...o,
    appearance: variation.appearance,
    textScale: variation.textScale,
    ...(variation.keepDrafts ? {} : { tokens: undefined }),
  }));
  if (Platform.OS === 'web') {
    // On the web the URL is the navigation state: replace to the bottom of the
    // stack and push the rest, so the address bar and Back follow the recipe.
    router.replace(point.stack[0] as any);
    for (const href of point.stack.slice(1)) router.push(href as any);
  } else {
    const stack = { index: routes.length - 1, routes };
    navRef.reset(holder ? { index: 0, routes: [{ name: '__root', state: stack }] } : stack);
  }
  return { ok: true, target: routes[routes.length - 1].name };
}

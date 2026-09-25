// Development builds only, web: a live point's state arrives as a URL
// (`/?stet-state=home.weather-failed&appearance=dark&textScale=1.3`), and the
// dashboard frame sends copy drafts and design-token overrides by postMessage.
import { applyMockState } from '@/api/mock';
import { copyDrafts, descriptor } from '@/copy';
import { themeOverrides } from '@/theme';

import { pointOf } from './recipe';

export type WebState = { point: string; found: boolean; appearance?: 'light' | 'dark'; textScale?: number } | null;

/**
 * Read once, when the root layout's module loads: the account and fixture go in
 * before the first screen renders, so Home does not redirect before the preset
 * is signed in. The stack reset waits for the navigator (StetDev).
 */
export function readWebState(): WebState {
  if (typeof window === 'undefined') return null;
  const search = new URLSearchParams(window.location.search);
  const id = search.get('stet-state');
  if (!id) return null;
  const appearance = search.get('appearance');
  const scale = Number(search.get('textScale'));
  const state: WebState = {
    point: id,
    found: Boolean(pointOf(id)),
    appearance: appearance === 'dark' || appearance === 'light' ? appearance : undefined,
    textScale: Number.isFinite(scale) && scale > 0 ? scale : undefined,
  };
  themeOverrides.set((o) => ({ ...o, appearance: state.appearance, textScale: state.textScale }));
  const point = pointOf(id);
  if (point) applyMockState(point.account ?? null, point.fixture ?? null);
  return state;
}

export function listenForPreviewMessages() {
  if (typeof window === 'undefined') return () => {};
  const onMessage = (event: MessageEvent) => {
    // Only the frame's parent (the dashboard) or the page itself.
    if (event.source !== window.parent && event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'stet:draft' && typeof data.key === 'string' && typeof data.value === 'string') {
      if (!Object.hasOwn(descriptor.keys, data.key)) return;
      copyDrafts.set((d) => ({ ...d, [data.key]: data.value }));
    } else if (data.type === 'stet:draft-clear') {
      copyDrafts.set({});
    } else if (data.type === 'stet:tokens') {
      const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : undefined;
      themeOverrides.set((o) => ({ ...o, tokens: tokens && Object.keys(tokens).length ? tokens : undefined }));
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

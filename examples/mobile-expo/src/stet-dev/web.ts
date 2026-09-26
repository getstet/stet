// Development builds only, web: a live point's state arrives as a URL
// (`/?stet-state=home.weather-failed&appearance=dark&textScale=1.3&motion=reduced`),
// and the dashboard frame sends copy drafts, design-token overrides, forced
// component states, replays and a motion mode by postMessage.
import { applyMockState } from '@/api/mock';
import { copyDrafts, descriptor } from '@/copy';
import { themeOverrides, type ComponentState } from '@/theme';

import { pointOf } from './recipe';
import { requestReplay } from './sandbox';

export type WebState = { point: string; found: boolean; appearance?: 'light' | 'dark'; textScale?: number; motion?: 'reduced' | 'still' } | null;

const STATES = new Set<string>(['rest', 'pressed', 'hovered', 'focused', 'loading', 'success', 'error']);

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
  const motion = search.get('motion');
  const state: WebState = {
    point: id,
    found: Boolean(pointOf(id)),
    appearance: appearance === 'dark' || appearance === 'light' ? appearance : undefined,
    textScale: Number.isFinite(scale) && scale > 0 ? scale : undefined,
    motion: motion === 'reduced' || motion === 'still' ? motion : undefined,
  };
  themeOverrides.set((o) => ({ ...o, appearance: state.appearance, textScale: state.textScale, motion: state.motion }));
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
    } else if (data.type === 'stet:state-force') {
      // The whole map each time: `{}` releases every component.
      const states: Record<string, ComponentState> = {};
      if (data.states && typeof data.states === 'object') {
        for (const [name, state] of Object.entries(data.states)) if (typeof state === 'string' && STATES.has(state)) states[name] = state as ComponentState;
      }
      themeOverrides.set((o) => ({ ...o, states }));
    } else if (data.type === 'stet:play' && typeof data.component === 'string' && typeof data.animation === 'string') {
      const ok = requestReplay(data.component, data.animation);
      const reason = ok ? {} : { reason: `no ${data.component} on screen plays "${data.animation}"` };
      window.parent?.postMessage({ type: 'stet:played', component: data.component, animation: data.animation, ok, ...reason }, '*');
    } else if (data.type === 'stet:motion') {
      const motion = data.motion === 'reduced' || data.motion === 'still' ? data.motion : undefined;
      themeOverrides.set((o) => ({ ...o, motion }));
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

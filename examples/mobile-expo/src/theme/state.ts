import { useEffect, useRef } from 'react';

import { createStore } from '@/lib/store';

import { themeOverrides, type ComponentState } from './index';

export type Live = Partial<Record<Exclude<ComponentState, 'rest'>, boolean>>;

/**
 * A component's current state, from its own interaction and status flags.
 * Development tooling and Storybook can force one per component name
 * (`themeOverrides.states`), so every variant × state can be shown and
 * captured without a finger on the screen. Nothing in a release build writes
 * that map.
 */
export function useComponentState(name: string, live: Live): ComponentState {
  const forced = themeOverrides.use().states;
  if (forced && Object.hasOwn(forced, name)) return forced[name];
  return deriveState(live);
}

/** The state flags name, strongest first: a status outranks an interaction. */
export function deriveState(live: Live): ComponentState {
  if (live.error) return 'error';
  if (live.success) return 'success';
  if (live.loading) return 'loading';
  if (live.pressed) return 'pressed';
  if (live.focused) return 'focused';
  if (live.hovered) return 'hovered';
  return 'rest';
}

/** Development tooling asks a component to run one of its animations again. */
export const replays = createStore<{ component: string; animation: string; handled: boolean } | null>(null);

/** Registers the animations a component can replay on request. Inert in a release build. */
export function useReplay(name: string, handlers: Record<string, () => void>) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    if (!__DEV__) return;
    const off = replays.subscribe(() => {
      const request = replays.get();
      if (request?.component !== name || !Object.hasOwn(current.current, request.animation)) return;
      request.handled = true;
      current.current[request.animation]();
    });
    return () => void off();
  }, [name]);
}

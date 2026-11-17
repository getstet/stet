import { Easing, ReduceMotion, useReducedMotion, withSpring, withTiming } from 'react-native-reanimated';

import { themeOverrides, type Bezier, type MotionMode, type Spring } from './index';

/** The longest fade reduced motion allows in place of movement. */
export const FADE_MS = 120;

/**
 * How animations run: `full`, `reduced` (the OS setting or a forced preview:
 * nothing moves, appearing things fade in at most 120 ms) or `still`
 * (development captures: everything lands on its final frame at once).
 */
export function useMotionMode(): MotionMode {
  const system = useReducedMotion();
  const forced = themeOverrides.use().motion;
  return forced ?? (system ? 'reduced' : 'full');
}

export function bezier(b: Bezier) {
  return Easing.bezier(b[0], b[1], b[2], b[3]);
}

/** Movement: a spring when motion is full, otherwise straight to the target. */
export function move(target: number, spring: Spring, mode: MotionMode, onDone?: (finished?: boolean) => void) {
  'worklet';
  if (mode !== 'full') return withTiming(target, { duration: 0, reduceMotion: ReduceMotion.Never }, onDone);
  return withSpring(target, { ...spring, reduceMotion: ReduceMotion.Never }, onDone);
}

/** Movement on a curve: timed when motion is full, otherwise straight to the target. */
export function glide(target: number, duration: number, easing: Bezier, mode: MotionMode, onDone?: (finished?: boolean) => void) {
  'worklet';
  if (mode !== 'full') return withTiming(target, { duration: 0, reduceMotion: ReduceMotion.Never }, onDone);
  return withTiming(target, { duration, easing: Easing.bezier(easing[0], easing[1], easing[2], easing[3]), reduceMotion: ReduceMotion.Never }, onDone);
}

/** Opacity and colour: timed when motion is full, a fade of at most 120 ms when reduced, at once when still. */
export function fade<T extends number | string>(target: T, duration: number, mode: MotionMode, onDone?: (finished?: boolean) => void): T {
  'worklet';
  const ms = mode === 'still' ? 0 : mode === 'reduced' ? Math.min(duration, FADE_MS) : duration;
  return withTiming(target, { duration: ms, reduceMotion: ReduceMotion.Never }, onDone);
}

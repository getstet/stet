import { Platform, useColorScheme, type TextStyle } from 'react-native';

import base from '../../theme/tokens.json';
import { createStore } from '@/lib/store';

import { merge, resolveAliases } from './resolve';

type Tokens = typeof base;
type ColorTokens = Tokens['color'];

export type ComponentState = 'rest' | 'pressed' | 'hovered' | 'focused' | 'loading' | 'success' | 'error';
export type MotionMode = 'full' | 'reduced' | 'still';

/**
 * Overrides the app's own settings never write. Development tooling sets them:
 * a forced appearance and text scale for a previewed state, token values under
 * trial, a forced state per component and a forced motion mode. Empty in a
 * release build, so the theme is the file and the OS.
 */
export type ThemeOverrides = {
  appearance?: 'light' | 'dark';
  textScale?: number;
  tokens?: Record<string, unknown>;
  states?: Record<string, ComponentState>;
  motion?: Exclude<MotionMode, 'full'>;
};
export const themeOverrides = createStore<ThemeOverrides>({});

export type Spring = { damping: number; stiffness: number; mass: number };
export type Bezier = [number, number, number, number];

export type Motion = {
  duration: { fast: number; base: number; slow: number };
  spring: { snappy: Spring; gentle: Spring; bouncy: Spring };
  easing: { standard: Bezier; emphasized: Bezier };
  press: { scale: number };
  stagger: number;
};

export type Theme = {
  scheme: 'light' | 'dark';
  color: ColorTokens;
  radius: Tokens['radius'];
  space: Tokens['space'];
  size: Tokens['size'];
  font: { size: Tokens['font']['size']; weight: Record<keyof Tokens['font']['weight'], TextStyle['fontWeight']> };
  motion: Motion;
  /** The whole file with every alias resolved: component groups are read through `useTokens`. */
  tokens: Record<string, any>;
};

/** Literal type sizes in component groups follow the web's text scale, as the global sizes do. */
function scaleType(node: any, scale: number, key = '', parent = ''): any {
  if (typeof node === 'number') return key === 'fontSize' || parent === 'labelSize' ? Math.round(node * scale * 10) / 10 : node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, scaleType(v, scale, k, key)]));
}

let cache: { overrides: ThemeOverrides; scheme: string; theme: Theme } | null = null;

function build(overrides: ThemeOverrides, scheme: 'light' | 'dark'): Theme {
  const tokens: any = overrides.tokens ? merge(base, overrides.tokens) : base;
  // Native text follows the OS text size on its own. The web reports a font
  // scale of 1, so a text-scale override is applied to the sizes there.
  const scale = Platform.OS === 'web' ? (overrides.textScale ?? 1) : 1;
  const size = Object.fromEntries(
    Object.entries(tokens.font.size as Record<string, number>).map(([k, v]) => [k, Math.round(v * scale * 10) / 10]),
  );
  // Aliases resolve against the tree for this appearance, so `{color.primary}`
  // in a component group reads the dark value in dark mode.
  const tree: any = {
    ...(scale === 1 ? tokens : scaleType(tokens, scale)),
    color: scheme === 'dark' ? { ...tokens.color, ...tokens.colorDark } : tokens.color,
    font: { ...tokens.font, size },
  };
  const resolved = resolveAliases(tree);
  return {
    scheme,
    color: resolved.color,
    radius: resolved.radius,
    space: resolved.space,
    size: resolved.size,
    font: { size: resolved.font.size, weight: resolved.font.weight },
    motion: resolved.motion,
    tokens: resolved,
  };
}

export function useTheme(): Theme {
  const system = useColorScheme();
  const overrides = themeOverrides.use();
  const scheme = overrides.appearance ?? (system === 'dark' ? 'dark' : 'light');
  if (!cache || cache.overrides !== overrides || cache.scheme !== scheme) {
    cache = { overrides, scheme, theme: build(overrides, scheme) };
  }
  return cache.theme;
}

/** One component's token group, aliases resolved. A component reads only its own group. */
export function useTokens<T>(group: string): T {
  return useTheme().tokens[group] as T;
}

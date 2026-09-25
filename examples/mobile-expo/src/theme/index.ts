import { Platform, useColorScheme, type TextStyle } from 'react-native';

import base from '../../theme/tokens.json';
import { createStore } from '@/lib/store';

type Tokens = typeof base;
type ColorTokens = Tokens['color'];

/**
 * Overrides the app's own settings never write. Development tooling sets them:
 * a forced appearance and text scale for a previewed state, and token values
 * under trial. Empty in a release build, so the theme is the file and the OS.
 */
export type ThemeOverrides = {
  appearance?: 'light' | 'dark';
  textScale?: number;
  tokens?: Record<string, unknown>;
};
export const themeOverrides = createStore<ThemeOverrides>({});

function merge(target: any, patch: any): any {
  if (!patch || typeof patch !== 'object') return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(patch)) {
    // `color.primary` and `{ color: { primary } }` name the same token.
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

export type Theme = {
  scheme: 'light' | 'dark';
  color: ColorTokens;
  radius: Tokens['radius'];
  space: Tokens['space'];
  size: Tokens['size'];
  font: { size: Tokens['font']['size']; weight: Record<keyof Tokens['font']['weight'], TextStyle['fontWeight']> };
};

export function useTheme(): Theme {
  const system = useColorScheme();
  const overrides = themeOverrides.use();
  const tokens: Tokens = overrides.tokens ? merge(base, overrides.tokens) : base;
  const scheme = overrides.appearance ?? (system === 'dark' ? 'dark' : 'light');
  const color = scheme === 'dark' ? { ...tokens.color, ...tokens.colorDark } : tokens.color;
  // Native text follows the OS text size on its own. The web reports a font
  // scale of 1, so a text-scale override is applied to the sizes there.
  const scale = Platform.OS === 'web' ? (overrides.textScale ?? 1) : 1;
  const size = Object.fromEntries(
    Object.entries(tokens.font.size).map(([k, v]) => [k, Math.round(v * scale * 10) / 10]),
  ) as Tokens['font']['size'];
  return { scheme, color, radius: tokens.radius, space: tokens.space, size: tokens.size, font: { size, weight: tokens.font.weight as Theme['font']['weight'] } };
}

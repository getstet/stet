import tokens from '@/theme/tokens.json';

export type TokenTree = { [name: string]: string | TokenTree };

/** A token tree as flat dot paths: `{ color: { primary } }` → `color.primary`. */
export function flattenTokens(tree: TokenTree, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'string') flat[path] = value;
    else Object.assign(flat, flattenTokens(value, path));
  }
  return flat;
}

const cssVar = (path: string) => `--${path.replace(/\./g, '-')}`;
const block = (selector: string, flat: Record<string, string>) =>
  `${selector}{${Object.entries(flat).map(([path, value]) => `${cssVar(path)}:${value};`).join('')}}`;

/**
 * The CSS variables for a token file: its own values on `:root`, and the
 * values under `dark` when the page asks for dark or the system prefers it.
 */
export function themeCss(tree: TokenTree): string {
  const { dark, ...light } = tree;
  const darkFlat = typeof dark === 'object' ? flattenTokens(dark) : {};
  return [
    block(':root', flattenTokens(light)),
    block(':root[data-appearance="dark"]', darkFlat),
    `@media (prefers-color-scheme: dark){${block(':root:not([data-appearance="light"])', darkFlat)}}`,
  ].join('\n');
}

export const THEME_STYLE_ID = 'theme-tokens';
export const baseTokens = tokens as TokenTree;

/**
 * Placeholders at the edges. stet stores a variable as `{{name}}`; a host whose
 * own table spells it `{name}` has its values converted once on the way in
 * (`import`) and once on the way out (a generated output), so nothing between
 * the two ever sees the single-brace form and the save gate keeps protecting
 * the stored one.
 */

import { VARIABLE } from './validate.js';

/** The placeholder grammar a host reads: stet stores `{{name}}`; a `{name}` host converts at import and generation. */
export type Placeholders = '{{name}}' | '{name}';

/** A single-brace variable, never one half of a doubled `{{name}}`. */
const SINGLE = /(?<!\{)\{([A-Za-z_]\w*)\}(?!\})/g;

/** `{name}` → `{{name}}` for a `{name}` host; the value unchanged for `{{name}}`. A `{{name}}` already doubled in a `{name}` value is left as it is. */
export function toStet(value: string, grammar: Placeholders): string {
  return grammar === '{name}' ? value.replace(SINGLE, '{{$1}}') : value;
}

/** `{{name}}` → `{name}` for a `{name}` host; the value unchanged for `{{name}}`. */
export function toHost(value: string, grammar: Placeholders): string {
  return grammar === '{name}' ? value.replace(VARIABLE, '{$1}') : value;
}

/** The variable names a stored value carries, sorted and unique. */
export function varsOf(value: string): string[] {
  const names = new Set<string>();
  for (const found of value.matchAll(VARIABLE)) if (found[1] !== undefined) names.add(found[1]);
  return [...names].sort();
}

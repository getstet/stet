/**
 * One command's arguments. `node:util`'s `parseArgs` does the work — zero
 * dependencies — and this wraps it so every command fails the same way.
 *
 * `strict` catches an unknown or malformed option, and `allowPositionals` is
 * what lets a command take a `<key>`: strict alone rejects every positional
 * with `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`, which would make `stet get
 * hero_headline` a usage error. Both are always on.
 */

import { parseArgs } from 'node:util';

import { UsageError } from './report.js';

export type OptionKind = 'string' | 'boolean';

/**
 * `--env <name>`, spread into every store-touching command's option literal.
 * There is no shared option table to inherit from — the literals are
 * per-command — so this const is the one declaration of the flag. `check` does
 * not spread it: it is offline by contract and has no store to select.
 */
export const ENV_OPTION = { env: 'string' } as const;

/**
 * The refusal the offline commands carry — `check` and `seo check`, both
 * offline by contract with no store to select.
 *
 * It is caught before parsing rather than left to strict parsing: `parseArgs`
 * calls an unknown option a misplaced value and tells the caller to put it
 * after `--`, which teaches the wrong thing entirely. Both spellings, because
 * the joined `--env=prod` form is one token and never matches the bare name.
 */
export function refuseEnv(args: string[], command: string): void {
  if (args.some((a) => a === '--env' || a.startsWith('--env='))) {
    throw new UsageError(`stet ${command} is offline by contract — there is no store to select`);
  }
}

/** One parsed token in SOURCE order — the order `positionals` has flattened away. */
export interface ParsedToken {
  kind: 'option' | 'positional' | 'option-terminator';
  index: number;
  name?: string;
  value?: string;
}

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  tokens: ParsedToken[];
}

/**
 * Parse, and reject a repeated option that must not be silently deduplicated.
 *
 * `parseArgs` takes the LAST value for an option given twice. For most flags
 * that is harmless; for `--editor` it means `--editor a --editor b` records b
 * and says nothing, and attribution is the one field no write may get wrong.
 * `tokens: true` is what makes the repetition visible at all — the values
 * object has already collapsed it.
 */
export function parse(
  args: string[],
  options: Record<string, OptionKind>,
  unique: readonly string[] = ['editor'],
): ParsedArgs {
  const shape: Record<string, { type: OptionKind }> = {};
  for (const [name, type] of Object.entries(options)) shape[name] = { type };
  try {
    const parsed = parseArgs({
      args,
      options: shape,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
    for (const name of unique) {
      if (!(name in options)) continue;
      const given = parsed.tokens.filter((token) => token.kind === 'option' && token.name === name);
      if (given.length > 1) {
        throw new UsageError(`--${name} was given ${given.length} times; it takes one value`);
      }
    }
    return {
      values: parsed.values as ParsedArgs['values'],
      positionals: parsed.positionals,
      tokens: parsed.tokens as ParsedToken[],
    };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('ERR_PARSE_ARGS_')) throw new UsageError((error as Error).message);
    throw error;
  }
}

/**
 * The positionals on either side of an option — what an OPTIONAL-VARIADIC flag
 * means to a parser holding one flat positional list.
 *
 * `stet email extract lib/email --apply welcome` names a path and a template,
 * and nothing but their order tells the two apart. Where the option was not
 * given every positional is `before`, so a command reads its ordinary arguments
 * from the same place either way.
 */
export function positionalsAround(
  parsed: ParsedArgs,
  option: string,
): { before: string[]; after: string[] } {
  const at = parsed.tokens.find((t) => t.kind === 'option' && t.name === option)?.index;
  if (at === undefined) return { before: parsed.positionals, after: [] };
  const before: string[] = [];
  const after: string[] = [];
  for (const token of parsed.tokens) {
    if (token.kind !== 'positional' || token.value === undefined) continue;
    (token.index < at ? before : after).push(token.value);
  }
  return { before, after };
}

/** A `--name value` option, or undefined where it was not given. */
export function text(values: ParsedArgs['values'], name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function flag(values: ParsedArgs['values'], name: string): boolean {
  return values[name] === true;
}

/** The one positional a command requires, named in the error when it is absent. */
export function required(positionals: string[], command: string, name: string): string {
  const value = positionals[0];
  if (value === undefined || value === '') throw new UsageError(`stet ${command} <${name}>`);
  if (positionals.length > 1) {
    throw new UsageError(`stet ${command} takes one <${name}>, got ${positionals.length}`);
  }
  return value;
}

/** No positionals at all — a typo'd option would otherwise land silently. */
export function noPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new UsageError(`stet ${command} takes no arguments, got "${positionals[0]}"`);
  }
}

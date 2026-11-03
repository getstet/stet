/**
 * The generated outputs — files the config's `generated` lists, written from
 * the snapshot for a host that reads its own copy table: a classic script that
 * binds a global (`TS.copyTable`), an ES module's export, or bare JSON.
 *
 * Each is a repo form like the registry: every all-or-nothing batch writes it
 * beside the snapshot (`planSideForms`), and `check` regenerates and compares
 * it. A `script` or `esm` output carries the generated header, whose hash
 * covers every input — the entry, the kept values with their status words and
 * the placeholder grammar — so a moved input reads `stale`. JSON has no
 * comment to carry a header in, so a `json` output is current or it differs.
 */

import { readBundle, resolveAll } from '../src/bundle.js';
import { canonicalize, generatedHeader, sourceHash } from '../src/codegen.js';
import { toHost, type Placeholders } from '../src/placeholders.js';
import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, type Descriptor } from '../src/types.js';
import type { GeneratedOutput } from './config.js';
import { statusOf, type StatusFile } from './status.js';

/** The keys an entry keeps: every declared web key, or those equal to or opening with one of `only`. */
export function keysFor(entry: GeneratedOutput, descriptor: Descriptor): string[] {
  const { only } = entry;
  return Object.keys(descriptor.keys)
    .filter((key) => (only === undefined ? descriptor.keys[key]?.target === DEFAULT_TARGET : only.some((prefix) => key.startsWith(prefix))))
    .sort();
}

/**
 * What an output is generated from, and what its header hashes: the entry, each
 * kept key's row as the body writes it, and the grammar. `check` hashes the
 * same object, so the two cannot disagree about what moved.
 */
export function outputSource(
  entry: GeneratedOutput,
  descriptor: Descriptor,
  snapshot: Snapshot,
  status: StatusFile | null,
  placeholders: Placeholders,
  locale: string,
): { entry: GeneratedOutput; rows: Array<[string, unknown]>; placeholders: Placeholders } {
  // Resolved as the resolved module reads it, so a derived key carries its text.
  const { resolved } = resolveAll(descriptor, readBundle(snapshot), { locale });
  const rows: Array<[string, unknown]> = [];
  for (const key of keysFor(entry, descriptor)) {
    if (!Object.hasOwn(resolved, key)) continue;
    const held = resolved[key];
    const value = typeof held === 'string' ? toHost(held, placeholders) : canonicalize(held);
    rows.push([key, entry.values === 'value-status' ? [value, statusOf(status ?? {}, key).status] : value]);
  }
  return { entry, rows, placeholders };
}

/** One output's text: the generated header (script, esm), the binding, the body. */
export function generateOutput(
  entry: GeneratedOutput,
  descriptor: Descriptor,
  snapshot: Snapshot,
  status: StatusFile | null,
  placeholders: Placeholders,
  locale: string,
): string {
  const source = outputSource(entry, descriptor, snapshot, status, placeholders, locale);
  const body = bodyOf(source.rows, entry.values === 'value-status');
  if (entry.format === 'json') return `${body}\n`;
  const header = `${generatedHeader(entry.values === 'value-status' ? 'descriptor.json + defaults.json + status.json' : 'descriptor.json + defaults.json', sourceHash(source))}\n`;
  const name = entry.name as string;
  if (entry.format === 'esm') return `${header}export const ${name} = ${body};\n`;
  const parts = name.split('.');
  if (parts.length === 1) return `${header}window.${name} = ${body};\n`;
  // One guard per prefix, so the table lands on a namespace the page may or may not have made yet.
  const guards = parts.slice(0, -1).map((_, i) => {
    const at = parts.slice(0, i + 1).join('.');
    return i === 0 ? `window.${at} = window.${at} || {};` : `${at} = ${at} || {};`;
  });
  return `${header}${guards.join('\n')}\n${name} = ${body};\n`;
}

/**
 * The sorted rows as one object, a row to a line — `"key": "value"` or
 * `"key": ["value", "status"]` — which is JSON whatever the format around it,
 * and reads as the hand-kept table did.
 */
function bodyOf(rows: ReadonlyArray<[string, unknown]>, paired: boolean): string {
  if (rows.length === 0) return '{}';
  const cell = (value: unknown): string => {
    if (!paired) return JSON.stringify(value);
    const [held, status] = value as [unknown, string];
    return `[${JSON.stringify(held)}, ${JSON.stringify(status)}]`;
  };
  return `{\n${rows.map(([key, value]) => `  ${JSON.stringify(key)}: ${cell(value)}`).join(',\n')}\n}`;
}

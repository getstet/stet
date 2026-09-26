/**
 * `stet merge <key> --into <other>` — two keys that carry the same words become
 * one: every mark and read of the leaving key moves to the survivor, a key
 * deriving from it and a page reference naming it follow, a locale only the
 * leaving key carries is copied across, and the leaving key goes. The
 * survivor's entry and its own values are never changed. Plan first; `--write`
 * lands the forms and every leaf edit as one batch.
 *
 * The planner is shared with the dashboard's `site/merge` route, so the page's
 * Link them runs the terminal's own plan.
 */

import { DescriptorError, keyDefOf, loadDescriptorWithWarnings, pageKeyReferences } from '../src/descriptor.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { flag, parse, text as argText } from './args.js';
import { rethrowBatchFailure, writePlanned } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { isHtmlHost, loadConfig, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { keyMoveWrites, markRenames, readRenames, slotOrBrand, type HostRenames } from './rename.js';
import { storeRowsLine } from './remove.js';
import { HostTextReport, UsageError } from './report.js';

const USAGE = 'stet merge <key> --into <other> [--write]';

export interface MergePlan {
  descriptor: Descriptor;
  snapshot: Snapshot;
  host: HostRenames;
  /** Lines naming what followed: derivations and page references now naming the survivor. */
  follows: string[];
  /** Locales only the leaving key carried, copied to the survivor. */
  copied: string[];
}

export async function runMerge(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { into: 'string', write: 'boolean' });
  const into = argText(values, 'into');
  if (positionals.length !== 1 || into === undefined) throw new UsageError(USAGE);
  const leaving = positionals[0] as string;

  const report = new HostTextReport();
  const config = loadConfig(io.cwd);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  const plan = await planMerge(io.cwd, config, descriptor, snapshot, leaving, into);
  if ('refused' in plan) {
    for (const line of plan.refused) report.error('config', line);
    return report.emit(io);
  }
  report.line(`merge ${leaving} into ${into}`);
  for (const occ of plan.host.rewritten) {
    report.line(isHtmlHost(config) ? `  ${occ.file}:${occ.line} the mark is renamed` : `  ${occ.file}:${occ.line} ${occ.text}`);
  }
  for (const line of plan.follows) report.line(`  ${line}`);
  storeRowsLine(config, report);
  if (!flag(values, 'write')) {
    report.line('merge: run with --write to apply');
    return report.emit(io);
  }
  const changed = keyMoveWrites(io.cwd, config, plan, plan.host, report).filter((p) => p.status !== 'unchanged');
  try {
    writePlanned(changed);
  } catch (error) {
    rethrowBatchFailure('stet merge --write', error);
  }
  const files = changed.map((p) => p.label);
  report.line(`wrote ${files.join(', ')}: 1 key merged`);
  report.line(`commit them together: git commit -m "stet: merge ${leaving} into ${into}" -- ${files.join(' ')}`);
  return report.emit(io);
}

/**
 * The merge, planned: every refusal listed where there is any, else the merged
 * forms, the host's edits and what followed. Nothing is written.
 */
export async function planMerge(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  leaving: string,
  into: string,
): Promise<MergePlan | { refused: string[] }> {
  const refused: string[] = [];
  const from = keyDefOf(descriptor, leaving);
  const to = keyDefOf(descriptor, into);
  for (const [key, def] of [
    [leaving, from],
    [into, to],
  ] as const) {
    if (def === undefined) refused.push(`${key}: not a key in the descriptor`);
  }
  if (leaving === into) refused.push(`${leaving}: the key is the one it merges into — nothing to merge`);
  const outside = slotOrBrand(descriptor);
  for (const key of new Set([leaving, into])) {
    const own = outside({ old: key, key, label: null, help: null });
    if (own !== undefined) refused.push(own);
  }
  if (from === undefined || to === undefined || refused.length > 0) return { refused };
  for (const [key, def] of [
    [leaving, from],
    [into, to],
  ] as const) {
    if (def.derivesFrom !== undefined) refused.push(`${key} derives from ${def.derivesFrom} — a derived key follows its source`);
  }
  for (const field of ['shape', 'target', 'tags'] as const) {
    if (from[field] === to[field]) continue;
    refused.push(`cannot merge: ${leaving} is ${describe(from, field)}, ${into} is ${describe(to, field)}`);
  }
  for (const locale of Object.keys(snapshot).sort()) {
    const block = snapshot[locale] ?? {};
    if (!Object.hasOwn(block, leaving) || !Object.hasOwn(block, into)) continue;
    const a = block[leaving];
    const b = block[into];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    refused.push(`cannot merge: ${leaving} and ${into} differ in ${locale} — ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }

  const renames = new Map([[leaving, into]]);
  const host = isHtmlHost(config) ? markRenames(cwd, config, renames) : await readRenames(cwd, config, renames);
  for (const occ of host.blocked) {
    refused.push(`${occ.file}:${occ.line} reads "${leaving}" in a form stet cannot rewrite — edit it to the new name by hand, then re-run`);
  }
  for (const occ of host.unparsed) {
    refused.push(`${occ.file}:${occ.line} an expression stet cannot parse — edit "${leaving}" in this file to the new name by hand, then re-run`);
  }
  if (refused.length > 0) return { refused };

  const merged = mergedForms(descriptor, snapshot, leaving, into);
  try {
    loadDescriptorWithWarnings(structuredClone(merged.descriptor));
  } catch (error) {
    if (!(error instanceof DescriptorError)) throw error;
    return { refused: [`cannot merge: ${error.path} — ${error.message}; nothing written`] };
  }
  return { ...merged, host };
}

/** One field of a key's shape as the difference line names it. */
function describe(def: KeyDef, field: 'shape' | 'target' | 'tags'): string {
  if (field !== 'tags') return def[field];
  return def.tags === undefined ? 'tags: none' : `tags: ${def.tags}`;
}

/**
 * The descriptor and snapshot with `leaving` folded into `into`. Its own
 * function beside rename's `renamedForms`, which writes the renamed entry over
 * whatever the new name held: here the survivor's entry stays as it is, and
 * gains only the leaving key's pages it lacks.
 */
export function mergedForms(
  descriptor: Descriptor,
  snapshot: Snapshot,
  leaving: string,
  into: string,
): { descriptor: Descriptor; snapshot: Snapshot; follows: string[]; copied: string[] } {
  const out = structuredClone(descriptor);
  const follows: string[] = [];
  const survivor = out.keys[into] as KeyDef;
  const gone = out.keys[leaving] as KeyDef;
  // The page append `applyPages` makes for a new page, in the leaving key's order.
  for (const page of gone.pages ?? []) {
    if (!(survivor.pages ?? []).includes(page)) survivor.pages = [...(survivor.pages ?? []), page];
  }
  delete out.keys[leaving];
  for (const [key, def] of Object.entries(out.keys)) {
    if (def.derivesFrom !== leaving) continue;
    def.derivesFrom = into;
    follows.push(`${key} derives from it and follows`);
  }
  for (const ref of pageKeyReferences(out)) {
    if (ref.key !== leaving) continue;
    const def = (out.pages ?? {})[ref.page];
    if (def === undefined) continue;
    if (ref.kind === 'seo') {
      follows.push(`pages/${ref.page}/seo/${ref.field} follows`);
      def.seo = { ...def.seo, [ref.field]: into };
    } else {
      follows.push(`pages/${ref.page}/jsonLd/bindings/${ref.field} follows`);
      (def.jsonLd as { bindings: Record<string, string> }).bindings[ref.field] = into;
    }
  }
  const copied: string[] = [];
  const merged: Snapshot = {};
  for (const [locale, block] of Object.entries(snapshot)) {
    const next = { ...block };
    if (Object.hasOwn(next, leaving) && !Object.hasOwn(next, into)) {
      next[into] = next[leaving];
      copied.push(locale);
    }
    delete next[leaving];
    merged[locale] = next;
  }
  return { descriptor: out, snapshot: merged, follows, copied };
}

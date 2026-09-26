/**
 * `stet split <key> <new> --at <file>:<line>` — one place of a key takes a key
 * of its own: the marks or reads of `<key>` on that line move to `<new>`, which
 * copies the key's entry (its `pages` left out) and its value in every locale.
 * The key's other places, its pages, the page references and the keys deriving
 * from it stay with it. Plan first; `--write` lands the forms and the edit as
 * one batch.
 *
 * The planner is shared with the dashboard's `site/split` route, so the page's
 * Give this place its own key runs the terminal's own plan.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DescriptorError, loadDescriptorWithWarnings } from '../src/descriptor.js';
import { resolve } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { flag, parse, text as argText } from './args.js';
import { rethrowBatchFailure, writePlanned } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { isHtmlHost, loadConfig, type StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { htmlBaseName, proposeHtml } from './html-host.js';
import { numberNames } from './key-names.js';
import { planProblems, type NamingPlan } from './key-plan.js';
import type { CliIo } from './main.js';
import { htmlPageOf, pageOfFile } from './pages.js';
import { accessorBaseName, hostRefusals, keyMoveWrites, markRenames, readRenames, slotOrBrand, type HostRenames, type OnlyAt } from './rename.js';
import { HostTextReport, UsageError } from './report.js';
import { scanSource } from './source-scan.js';

const USAGE = 'stet split <key> <new> --at <file>:<line> [--write]';

export interface SplitPlan {
  descriptor: Descriptor;
  snapshot: Snapshot;
  host: HostRenames;
  /** The key's other places, which keep it. */
  keeps: OnlyAt[];
  /** The key's default-locale text, which the new key starts with. */
  text: string;
}

export async function runSplit(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { at: 'string', write: 'boolean' });
  const at = parseAt(argText(values, 'at'));
  if (positionals.length !== 2 || at === null) throw new UsageError(USAGE);
  const [key, next] = positionals as [string, string];

  const report = new HostTextReport();
  const config = loadConfig(io.cwd);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  const plan = await planSplit(io.cwd, config, descriptor, snapshot, key, next, at);
  if ('refused' in plan) {
    for (const line of plan.refused) report.error('config', line);
    return report.emit(io);
  }
  const where = `${at.file}:${at.line}`;
  const what = isHtmlHost(config) ? 'mark' : 'read';
  report.line(`${where} the ${what} is renamed; the value ${JSON.stringify(plan.text)} is copied`);
  for (const place of plan.keeps) report.line(`${place.file}:${place.line} keeps ${key}`);
  if (!flag(values, 'write')) {
    report.line(`split: run with --write to give ${where} its own key`);
    return report.emit(io);
  }
  const changed = keyMoveWrites(io.cwd, config, plan, plan.host, report).filter((p) => p.status !== 'unchanged');
  try {
    writePlanned(changed);
  } catch (error) {
    rethrowBatchFailure('stet split --write', error);
  }
  const files = changed.map((p) => p.label);
  report.line(`wrote ${files.join(', ')}: ${where} has its own key`);
  report.line(`commit them together: git commit -m "stet: split ${key} — ${next} at ${where}" -- ${files.join(' ')}`);
  return report.emit(io);
}

/** `--at <file>:<line>`, the line a positive integer; null where it is not that. */
export function parseAt(raw: string | undefined): OnlyAt | null {
  const m = raw === undefined ? null : /^(.+):([1-9][0-9]*)$/.exec(raw);
  return m === null ? null : { file: m[1] as string, line: Number(m[2]) };
}

/**
 * The split, planned: every refusal listed where there is any, else the forms
 * with the new key, the host's edit at the one line and the places that keep
 * the key. Nothing is written.
 */
export async function planSplit(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  key: string,
  next: string,
  at: OnlyAt,
): Promise<SplitPlan | { refused: string[] }> {
  if (next === key) return { refused: [`${key}: the new name is the old name — nothing to split`] };
  // The pair is judged as a one-entry rename plan, in the rename's own words.
  const pair: NamingPlan = { plan: 'stet rename', version: 1, keys: [{ old: key, key: next, label: null, help: null }] };
  const refused = planProblems(pair, 'the pair', descriptor, Object.keys(descriptor.keys), { refusal: slotOrBrand(descriptor) });
  if (refused.length > 0) return { refused };

  const renames = new Map([[key, next]]);
  const move = (only?: OnlyAt): Promise<HostRenames> | HostRenames =>
    isHtmlHost(config) ? markRenames(cwd, config, renames, only) : readRenames(cwd, config, renames, only);
  const all = await move();
  const here = await move(at);
  // A place is a line that marks or reads the key; two marks on one line are one place.
  const places = new Map<string, OnlyAt>();
  for (const occ of [...all.rewritten, ...all.blocked]) places.set(`${occ.file}:${occ.line}`, { file: occ.file, line: occ.line });
  if (places.size <= 1) refused.push(`${key} is marked in one place — there is nothing to split`);
  else if (here.rewritten.length === 0 && here.blocked.length === 0) refused.push(`${at.file}:${at.line} holds no mark or read of ${key}`);
  refused.push(...hostRefusals(here, key));
  if (refused.length > 0) return { refused };

  const forms = splitForms(descriptor, snapshot, key, next);
  try {
    loadDescriptorWithWarnings(structuredClone(forms.descriptor));
  } catch (error) {
    if (!(error instanceof DescriptorError)) throw error;
    return { refused: [`cannot split: ${error.path} — ${error.message}; nothing written`] };
  }
  const value = resolve(descriptor, snapshot, null, { key }).value;
  const keeps = [...places.values()].filter((p) => !(p.file === at.file && p.line === at.line));
  return { ...forms, host: here, keeps, text: typeof value === 'string' ? value : '' };
}

/**
 * The name the naming rule gives one place of `key` — its first mark or read at
 * that line, named as `register` names an element and numbered against every
 * declared key — or null where no mark or read of the key sits there.
 */
export async function proposedSplitName(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
  key: string,
  at: OnlyAt,
): Promise<string | null> {
  let base: string | null = null;
  if (isHtmlHost(config)) {
    const set = proposeHtml(cwd, filesForGlobs(cwd, config.managedSurfaces).filter((file) => file === at.file));
    const mark = set.claimed.find((m) => m.key === key && m.line === at.line);
    if (mark !== undefined) base = htmlBaseName(htmlPageOf(cwd, mark.file, descriptor.pages), mark);
  } else {
    let source: string;
    try {
      source = readFileSync(join(cwd, at.file), 'utf8');
    } catch {
      return null;
    }
    const page = pageOfFile(cwd, at.file, descriptor.pages);
    const result = await scanSource(at.file, source, { readPathImport: config.readPath.import, ...(page === undefined ? {} : { page }) });
    const call = result.accessorCalls.find((c) => c.key === key && c.copyBinding === 'stet' && c.place.line === at.line);
    if (call !== undefined) base = accessorBaseName(page, call);
  }
  if (base === null) return null;
  return numberNames([base], (name) => Object.hasOwn(descriptor.keys, name))[0] as string;
}

/** The forms with `next` beside `key`: the entry copied without its pages, and the value in every locale. */
export function splitForms(descriptor: Descriptor, snapshot: Snapshot, key: string, next: string): { descriptor: Descriptor; snapshot: Snapshot } {
  const out = structuredClone(descriptor);
  const { pages: _pages, ...entry } = out.keys[key] as KeyDef;
  out.keys[next] = entry;
  const copied: Snapshot = {};
  for (const [locale, block] of Object.entries(snapshot)) {
    copied[locale] = Object.hasOwn(block, key) ? { ...block, [next]: block[key] } : { ...block };
  }
  return { descriptor: out, snapshot: copied };
}

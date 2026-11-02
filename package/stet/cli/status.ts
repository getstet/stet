/**
 * The approval status file — `content/status.json` by default, a JSON object of
 * key → entry. A snapshot-only project keeps its approvals here, beside the
 * snapshot but outside it: the snapshot's format holds values, and the
 * descriptor is hashed into the generated registry, so neither can carry a
 * status word without moving something that has nothing to do with approval.
 *
 * The file is BORN by the first approval — `stet approve`, the dashboard's
 * Approve or an `import` row whose meta is `approved` — and from then on holds
 * every declared key. A project that never approves never gains it, and a
 * store-backed project (publishing is its approval) has none.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalize } from '../src/codegen.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { asUpdate, planJson, type WritePlan } from './artifacts.js';
import type { StetConfig } from './config.js';
import { gitData } from './git.js';
import { CliError } from './report.js';

export type KeyStatus = { status: 'proposed' } | { status: 'approved'; at: string; by: string };
export type StatusFile = Record<string, KeyStatus>;

const PROPOSED: KeyStatus = { status: 'proposed' };

/** The file's entries; `{}` where the file is absent. A malformed file is a CliError naming the path. */
export function loadStatus(cwd: string, config: Pick<StetConfig, 'statusPath'>): StatusFile {
  const path = join(cwd, config.statusPath);
  if (!existsSync(path)) return {};
  const refuse = (why: string): never => {
    throw new CliError(`${config.statusPath}: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return refuse(`not valid JSON — ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse('must be a JSON object of key → status');
  const file: StatusFile = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return refuse(`${key} must be an object`);
    const word = (entry as Record<string, unknown>)['status'];
    // An approved entry missing its date or approver loads as it stands: `check` reports it.
    if (word !== 'proposed' && word !== 'approved') return refuse(`${key} has status ${JSON.stringify(word ?? null)} — proposed or approved`);
    file[key] = entry as KeyStatus;
  }
  return file;
}

/** A key's status: an absent entry is `proposed`. */
export function statusOf(file: StatusFile, key: string): KeyStatus {
  return Object.hasOwn(file, key) ? (file[key] as KeyStatus) : PROPOSED;
}

/** `keys` approved by `by` at `at` (today, `YYYY-MM-DD`, UTC); `already` lists the keys that were approved before, untouched. */
export function approveKeys(file: StatusFile, keys: readonly string[], by: string, at: string = new Date().toISOString().slice(0, 10)): { file: StatusFile; already: string[] } {
  const next: StatusFile = { ...file };
  const already: string[] = [];
  for (const key of keys) {
    if (statusOf(next, key).status === 'approved') already.push(key);
    else next[key] = { status: 'approved', at, by };
  }
  return { file: next, already };
}

/** Every key whose default-locale value differs between `before` and `after` goes back to `proposed`, in the same write as the value. */
export function resetChanged(file: StatusFile, before: Snapshot, after: Snapshot, defaultLocale: string): StatusFile {
  const was = Object.hasOwn(before, defaultLocale) ? (before[defaultLocale] as Record<string, unknown>) : {};
  const now = Object.hasOwn(after, defaultLocale) ? (after[defaultLocale] as Record<string, unknown>) : {};
  const valueOf = (words: Record<string, unknown>, key: string): string => JSON.stringify(canonicalize(Object.hasOwn(words, key) ? words[key] : null));
  const next: StatusFile = {};
  for (const [key, entry] of Object.entries(file)) {
    next[key] = entry.status === 'approved' && valueOf(was, key) !== valueOf(now, key) ? PROPOSED : entry;
  }
  return next;
}

/**
 * Entries for the keys the descriptor declares, sorted; every declared key
 * present. Applied only to a file that exists or is being born (an entry is
 * `approved`), so a project that never approves never gains the file.
 */
export function completeStatus(file: StatusFile, descriptor: Descriptor): StatusFile {
  const next: StatusFile = {};
  for (const key of Object.keys(descriptor.keys).sort()) next[key] = statusOf(file, key);
  return next;
}

/** The entries moved with their keys: `renames` maps old → new; an old key with no entry moves nothing, and a merge keeps the kept key's entry. */
export function renameStatus(file: StatusFile, renames: ReadonlyMap<string, string>): StatusFile {
  const next: StatusFile = {};
  for (const [key, entry] of Object.entries(file)) if (!renames.has(key)) next[key] = entry;
  for (const [old, key] of renames) if (Object.hasOwn(file, old) && !Object.hasOwn(next, key)) next[key] = file[old] as KeyStatus;
  return next;
}

/** The planned write of the file, through `planJson`; null while the file does not exist on disk and no entry is `approved`. */
export function statusPlan(cwd: string, config: Pick<StetConfig, 'statusPath'>, file: StatusFile): WritePlan | null {
  const path = join(cwd, config.statusPath);
  if (!existsSync(path) && !Object.values(file).some((entry) => entry.status === 'approved')) return null;
  return asUpdate(planJson(path, file, config.statusPath));
}

/** git's `user.name` in `cwd`, trimmed; null where unset or git is absent. */
export function gitUserName(cwd: string): string | null {
  const { code, stdout } = gitData(cwd, ['config', 'user.name']);
  const name = stdout.trim();
  return code === 0 && name !== '' ? name : null;
}

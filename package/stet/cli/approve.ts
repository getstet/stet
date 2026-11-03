/**
 * `stet approve` — keys marked approved in the status file, a person's act
 * recorded with the approver's name and the day.
 *
 * The write is the whole repo batch, never the status file alone: a
 * `value-status` generated output hashes the status words, so a status-only
 * write would leave it stale. Offline by contract, as `import` and `remove`
 * are: the loading path is `check`'s own.
 */

import { parse, text } from './args.js';
import { planRepoForms, rethrowBatchFailure, writePlanned } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { loadConfig } from './config.js';
import type { CliIo } from './main.js';
import { CliError, Report, UsageError } from './report.js';
import { approveKeys, gitUserName, loadStatus } from './status.js';
import { isStoreBacked } from './store.js';

export const STORE_BACKED_APPROVAL = 'approve: this project is store-backed — publishing is its approval';

export async function runApprove(args: string[], io: CliIo): Promise<number> {
  const { values, positionals: keys } = parse(args, { by: 'string' }, ['by']);
  if (keys.length === 0) throw new UsageError('stet approve needs at least one key');

  const config = loadConfig(io.cwd);
  if (isStoreBacked(config.store)) throw new CliError(STORE_BACKED_APPROVAL);
  const report = new Report();
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);
  for (const key of keys) {
    if (!Object.hasOwn(descriptor.keys, key)) throw new CliError(`"${key}" is not a key in ${config.descriptorPath}`);
  }
  const by = text(values, 'by') ?? gitUserName(io.cwd);
  if (by === null) throw new CliError('approve: --by NAME is needed — git has no user.name here');

  const status = loadStatus(io.cwd, config);
  const approved = approveKeys(status, [...new Set(keys)], by);
  const at = (key: string): string => {
    const entry = approved.file[key];
    return entry?.status === 'approved' ? `${entry.by}, ${entry.at}` : '';
  };
  let written: string[];
  try {
    ({ written } = writePlanned(planRepoForms(io.cwd, config, descriptor, snapshot, approved.file, report)));
  } catch (error) {
    rethrowBatchFailure('stet approve', error);
  }
  for (const key of new Set(keys)) {
    report.line(approved.already.includes(key) ? `${key} is already approved (${at(key)})` : `approved ${key} (${at(key)})`);
  }
  for (const name of written) report.line(`wrote ${name}`);
  return report.emit(io);
}

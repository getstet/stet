/**
 * `stet approve` — keys marked approved in the status file. Built in chunk C4
 * of 0.9.0; until then the command is reserved.
 */

import { UsageError } from './report.js';
import type { CliIo } from './main.js';

export async function runApprove(_args: string[], _io: CliIo): Promise<number> {
  throw new UsageError('stet approve is built in a later chunk of 0.9.0');
}

/**
 * `stet import` — a project's own copy table brought in as keys. Built in
 * chunk C2 of 0.9.0; until then the command is reserved.
 */

import { UsageError } from './report.js';
import type { CliIo } from './main.js';

export async function runImport(_args: string[], _io: CliIo): Promise<number> {
  throw new UsageError('stet import is built in a later chunk of 0.9.0');
}

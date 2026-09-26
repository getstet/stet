/**
 * The naming plan: the file `register --plan-out` writes and `register --plan`
 * and `rename --plan` read. One format for both commands, so one reader, one
 * writer and one set of refusals serve them.
 *
 * A plan names keys and says what each is: per entry a `key`, and the `label`
 * and `help` the descriptor already carries per key. An agent adopting a site
 * edits them; `null` leaves a word unwritten (register) or as it is (rename).
 *
 * A register plan belongs to the tree that produced it: `made` holds the hash of
 * the descriptor, the snapshot and every managed file the run read, and a plan
 * whose files have changed is refused, because its proposals, their numbers and
 * their places are that tree's. A rename plan is written by hand or by an agent
 * and carries no `made`; its entries are checked against the descriptor as it
 * stands.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CONTROL_CHARACTERS } from '../src/contacts.js';
import type { Descriptor } from '../src/types.js';
import { NAME_PART } from './key-names.js';
import type { CliIo } from './main.js';
import { CliError, type Report } from './report.js';

export type PlanCommand = 'stet register' | 'stet rename';

/**
 * The characters a plan's label or help may not hold: the shared control class,
 * and the direction marks (U+200E, U+200F, U+061C), which reorder a one-line
 * label in the dashboard with nothing to see. A contact's answer keeps them,
 * since a right-to-left name can carry one.
 */
const PLAN_CONTROL = new RegExp(`[${CONTROL_CHARACTERS.source.slice(1, -1)}\\u061C\\u200E\\u200F]`);

export interface PlanEntry {
  /** register: the role name the run proposed — the entry's identity. */
  proposed?: string;
  /** rename: the key as the descriptor declares it now. */
  old?: string;
  key: string;
  label: string | null;
  help: string | null;
  /** register: the section word written to the entry, `null` for none. */
  section?: string | null;
  /** register: `false` leaves the proposal out of the run. */
  adopt?: boolean;
  /** For the reader; never read back. */
  kind?: string;
  places?: string[];
  text?: string;
}

export interface NamingPlan {
  plan: PlanCommand;
  version: 1;
  /** register: repo-relative path → `sha256:<hex>` of every file the run read. */
  made?: Record<string, string>;
  keys: PlanEntry[];
}

/** A key a plan may give: a letter first, then lowercase letters and digits in words joined by single underscores. */
export const PLAN_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const PLAN_KEY_MAX = 64;
export const LABEL_MAX = 60;
export const HELP_MAX = 500;
/** A section word a plan may give: `NAME_PART`, a digit first allowed (`2col`), as the rule writes it. */
export const SECTION_WORD_MAX = 24;

/** The hash `made` records for one file. */
export function fileHash(cwd: string, rel: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(join(cwd, rel))).digest('hex')}`;
}

/** The plan as JSON text, two-space indented with a closing newline — a file an agent reads and edits. */
export function planText(plan: NamingPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/**
 * A plan file, parsed and shape-checked. A file that is not a plan of this
 * command refuses whole, before any entry is judged.
 */
export function readPlan(cwd: string, rel: string, command: PlanCommand): NamingPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(cwd, rel), 'utf8'));
  } catch (error) {
    throw new CliError(`${rel}: not a readable JSON plan — ${(error as Error).message}`);
  }
  const plan = raw as Partial<NamingPlan> | null;
  if (plan === null || typeof plan !== 'object' || plan.plan !== command || plan.version !== 1 || !Array.isArray(plan.keys)) {
    throw new CliError(`${rel}: not a ${command} plan — "plan": "${command}", "version": 1 and a "keys" list are required`);
  }
  for (const [i, entry] of plan.keys.entries()) {
    const e = entry as Partial<PlanEntry> | null;
    const id = command === 'stet register' ? e?.proposed : e?.old;
    if (e === null || typeof e !== 'object' || typeof id !== 'string' || typeof e.key !== 'string') {
      throw new CliError(
        `${rel}: entry ${i + 1} needs "${command === 'stet register' ? 'proposed' : 'old'}" and "key" as strings`,
      );
    }
  }
  return plan as NamingPlan;
}

/**
 * Every problem with a plan, in entry order and one pass per entry, each naming
 * its entry; register's unlisted proposals follow. An empty list is a plan the
 * command may apply; nothing is written while one exists.
 *
 * `ids` is what the entries must cover: register's proposed names (every one
 * listed, none foreign), or for rename the descriptor's keys (every entry's old
 * name declared). `hashes` is register's current `made` map; rename passes
 * none. `refusal` is the caller's own line for an entry — rename's slot and
 * brand keys — which, where it answers, is that entry's one problem.
 */
export function planProblems(
  plan: NamingPlan,
  rel: string,
  descriptor: Descriptor,
  ids: readonly string[],
  options: { hashes?: Record<string, string>; refusal?: (entry: PlanEntry) => string | undefined } = {},
): string[] {
  const problems: string[] = [];
  const register = plan.plan === 'stet register';
  const idOf = (e: PlanEntry): string => (register ? e.proposed : e.old) as string;

  // Rule 6: the tree the plan was made from.
  if (register) {
    const made = plan.made ?? {};
    const now = options.hashes ?? {};
    const paths = new Set([...Object.keys(made), ...Object.keys(now)]);
    if ([...paths].some((path) => made[path] !== now[path])) {
      problems.push(`${rel}: the files it was made from have changed — run the command with --plan-out again`);
      return problems;
    }
  }

  const known = new Set(ids);
  const adopted = plan.keys.filter((e) => !register || e.adopt !== false);
  const byName = new Map<string, string[]>();
  for (const e of adopted) byName.set(e.key, [...(byName.get(e.key) ?? []), idOf(e)]);
  const leaving = new Set(register ? [] : adopted.map((e) => e.old as string));
  const seen = new Set<string>();

  for (const e of plan.keys) {
    const id = idOf(e);
    const own = options.refusal?.(e);
    if (own !== undefined) {
      problems.push(own);
      seen.add(id);
      continue;
    }
    // Rule 5: every entry a proposal of the run (register) or a declared key (rename), each once.
    if (!known.has(id)) problems.push(register ? `${id}: not a proposal of this run` : `${id}: not a key in the descriptor`);
    else if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);
    if (register && e.adopt !== undefined && typeof e.adopt !== 'boolean') {
      problems.push(`${id}: its adopt is not true or false`);
    }
    if (!register && e.adopt !== undefined) problems.push(`${id}: a rename plan takes no "adopt"`);
    if (register && e.adopt === false) continue;

    // Rules 1 and 2: the name's grammar and length.
    if (e.key.includes('__')) {
      problems.push(`${id}: "${e.key}" uses "__", which names a template slot or the brand group`);
    } else if (!PLAN_KEY.test(e.key)) {
      problems.push(`${id}: "${e.key}" is not a key name — lowercase letters, digits and single underscores, starting with a letter`);
    } else if (e.key.length > PLAN_KEY_MAX) {
      problems.push(`${id}: "${e.key}" is longer than ${PLAN_KEY_MAX} characters`);
    }
    // Rule 3: a name nothing else holds. A rename may keep its own name, and may
    // take a name another entry of the same plan is moving away from.
    const keeps = !register && e.key === e.old;
    if (!keeps && Object.hasOwn(descriptor.keys, e.key) && !leaving.has(e.key)) {
      problems.push(`${id}: "${e.key}" is already a key in the descriptor`);
    }
    const sharing = byName.get(e.key) ?? [];
    if (sharing.length > 1 && sharing[0] === id) {
      problems.push(`${sharing.join(' and ')}: both are named "${e.key}"`);
    }
    // Rule 4: the words, and a register entry's section word.
    for (const [field, value, max] of [
      ['label', e.label, LABEL_MAX],
      ['help', e.help, HELP_MAX],
    ] as const) {
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') problems.push(`${id}: its ${field} is not text`);
      else if (/[\r\n\u2028\u2029]/.test(value)) problems.push(`${id}: its ${field} holds a line break`);
      else if (PLAN_CONTROL.test(value)) problems.push(`${id}: its ${field} holds a control character`);
      else if (value.length > max) problems.push(`${id}: its ${field} is longer than ${max} characters`);
    }
    if (register && e.section !== null && e.section !== undefined) {
      if (typeof e.section !== 'string' || !NAME_PART.test(e.section) || e.section.length > SECTION_WORD_MAX) {
        problems.push(
          `${id}: its section "${String(e.section)}" is not a section word — lowercase letters and digits in words joined by single underscores, at most ${SECTION_WORD_MAX} characters`,
        );
      }
    }
  }
  // Rule 5, register: every proposal listed.
  if (register) {
    for (const id of ids) {
      if (!seen.has(id)) problems.push(`${id}: not in the plan — list every proposal, with "adopt": false to leave one out`);
    }
  }
  return problems;
}

/** A refused plan: the header, then every problem, and nothing written. Register's and rename's. */
export function refusePlan(io: CliIo, report: Report, command: PlanCommand, file: string | undefined, problems: string[]): number {
  report.error('config', file === undefined ? `${command} is refused — nothing written` : `${command}: ${file} is refused — nothing written`);
  for (const problem of problems) report.error('config', problem);
  return report.emit(io);
}

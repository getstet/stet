/**
 * `stet import` — a project's own copy table brought in as keys: one object of
 * key → value read from a JSON file or a JavaScript file, planned against the
 * descriptor and snapshot, gated as a save is, and written in the one repo
 * batch with the status file and the config's `keyStyle`.
 *
 * A JavaScript file is EVALUATED, never loaded: one `vm.Script` in a context of
 * its own, whose `window` and `globalThis` are the context itself, with no
 * `process`, `require`, `fetch` or stet module in reach and a two-second
 * ceiling. An ES module runs the same way after a textual rewrite of its
 * `export`s into the script's own bindings — `vm.SourceTextModule` exists only
 * behind `--experimental-vm-modules`, a flag the CLI cannot pass itself — and a
 * module that imports another is refused, since nothing outside the file is
 * ever read. The chosen object leaves the context as JSON written inside it,
 * so no getter or proxy of the host's runs in stet's realm.
 *
 * Offline by contract: the loading path is `check`'s own, as `remove`'s is.
 */

import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import vm from 'node:vm';

import { DESCRIPTOR_SCHEMA } from '../src/descriptor-schema.generated.js';
import { toStet, varsOf, type Placeholders } from '../src/placeholders.js';
import { DEFAULT_TARGET, type KeyDef } from '../src/types.js';
import { flag, parse, positionalsAround, required, text } from './args.js';
import { planRepoForms, rethrowBatchFailure, writePlanned, type WritePlan } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { loadConfig, rawConfigPlan, type StetConfig } from './config.js';
import { NAME_PART } from './key-names.js';
import type { CliIo } from './main.js';
import { CliError, HostTextReport, Report, UsageError } from './report.js';
import { approveKeys, gitUserName, loadStatus, type StatusFile } from './status.js';
import { isStoreBacked } from './store.js';
import { validateValue } from './validate.js';

/** The key grammar, as the schema states it. */
const KEY_NAME = new RegExp(DESCRIPTOR_SCHEMA.$defs.keyName.pattern);

/** How long a file's top level may run before it is refused as an evaluation error. */
const EVALUATE_MS = 2000;

/** The binding a module's default export takes once its `export default` is rewritten. */
const DEFAULT_BINDING = '__stet_default';

/** One property of the imported object: its value in stet's placeholder spelling, or why it was skipped. */
export interface ImportRow {
  key: string;
  value?: string;
  /** The row's meta is the string `approved` (`[value, "approved"]`). */
  approved: boolean;
  skipped?: string;
}

/**
 * The C5 guard a `copyFrom` checkout answers every writer with. A no-op until
 * C5 of 0.9.0 replaces it with `config.ts`' `refuseInCopyFrom`.
 */
function refuseInCopyFrom(_config: StetConfig, _command: string): void {}

export async function runImport(args: string[], io: CliIo): Promise<number> {
  const parsed = parse(
    args,
    { export: 'string', only: 'string', section: 'string', replace: 'boolean', by: 'string', write: 'boolean' },
    ['export', 'section', 'by'],
  );
  const { values } = parsed;
  // `--only home. waitlist.` and `--only home. --only waitlist.` both list two prefixes.
  const { before, after } = positionalsAround(parsed, 'only');
  const file = required(before, 'import', 'file');
  const only = [
    ...parsed.tokens.filter((t) => t.kind === 'option' && t.name === 'only' && t.value !== undefined).map((t) => t.value as string),
    ...after,
  ];
  const section = text(values, 'section');
  if (section !== undefined && !NAME_PART.test(section)) {
    throw new UsageError(`stet import --section takes one word of lowercase letters and digits — got "${section}"`);
  }
  const replace = flag(values, 'replace');
  const write = flag(values, 'write');

  const config = loadConfig(io.cwd);
  refuseInCopyFrom(config, 'import');
  const report = new HostTextReport();
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);
  const snapshotOnly = !isStoreBacked(config.store);

  const { object, label } = readTable(io.cwd, file, text(values, 'export'));
  const rows = importRows(object, { only, placeholders: config.placeholders });

  const locale = config.locales.default;
  const defaults: Record<string, unknown> = { ...(snapshot[locale] ?? {}) };
  const held = (key: string): unknown => (Object.hasOwn(defaults, key) ? defaults[key] : undefined);
  const kindOf = (row: ImportRow): 'new' | 'same' | 'differs' | 'skipped' =>
    row.value === undefined ? 'skipped' : !Object.hasOwn(descriptor.keys, row.key) ? 'new' : held(row.key) === row.value ? 'same' : 'differs';
  const count = (kind: string): number => rows.filter((row) => kindOf(row) === kind).length;
  const differing = count('differs');
  // The rows this import writes a value for, and the approvals it records.
  const written = rows.filter((row) => kindOf(row) === 'new' || (replace && kindOf(row) === 'differs'));
  const approving = snapshotOnly ? rows.filter((row) => row.approved && kindOf(row) !== 'skipped').map((row) => row.key) : [];

  report.line(`import: ${rows.length} keys from ${file}${label === undefined ? '' : ` (${label})`}`);
  report.line(`  new ${count('new')} · same ${count('same')} · differs ${differing} · skipped ${count('skipped')}`);
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === 'new') {
      const vars = varsOf(row.value as string);
      report.line(`  ${row.key}  ${JSON.stringify(row.value)}${vars.length === 0 ? '' : `  vars: ${vars.join(', ')}`}`);
    } else if (kind === 'differs') {
      report.line(
        `  ${row.key}  differs: ${JSON.stringify(row.value)} — the snapshot holds ${JSON.stringify(held(row.key) ?? '')}; pass --replace to take the file's`,
      );
    } else if (kind === 'skipped') {
      report.line(`  ${row.key}  skipped: ${row.skipped}`);
    }
  }
  if (snapshotOnly) {
    const approvedWritten = written.filter((row) => row.approved).length;
    report.line(`  status: ${approving.length} approved, ${written.length - approvedWritten} proposed`);
  }

  if (differing > 0 && !replace) {
    report.error(
      'config',
      `import: ${differing} keys differ — nothing written; pass --replace to take the file's values, or --only to leave them out`,
    );
    return report.emit(io);
  }

  // The batch applied in memory, then every value it writes through the save gate over the merged forms.
  for (const row of written) {
    const value = row.value as string;
    if (!Object.hasOwn(descriptor.keys, row.key)) {
      const vars = varsOf(value);
      const def: KeyDef = { shape: 'text', target: DEFAULT_TARGET, ...(section === undefined ? {} : { section }), ...(vars.length === 0 ? {} : { vars }) };
      descriptor.keys[row.key] = def;
    }
    defaults[row.key] = value;
  }
  snapshot[locale] = defaults;
  const gate = new Report();
  for (const row of written) validateValue(descriptor, snapshot, row.key, row.value, locale, gate);
  report.absorb(gate);
  if (gate.failed) return report.emit(io);
  if (!write) return report.emit(io);

  let status: StatusFile | null = null;
  if (snapshotOnly) {
    status = loadStatus(io.cwd, config);
    // A value this import writes is proposed until someone approves it, as a save's is.
    for (const row of written) status[row.key] = { status: 'proposed' };
    if (approving.length > 0) {
      const by = text(values, 'by') ?? gitUserName(io.cwd);
      if (by === null) throw new CliError('import: --by NAME is needed to record an approval — git has no user.name here');
      status = approveKeys(status, approving, by).file;
    }
  }
  // `keyStyle: "dotted"` joins the config once a dotted key does, unless the config says otherwise.
  let styled = false;
  const style = written.some((row) => row.key.includes('.'))
    ? rawConfigPlan(io.cwd, (raw) => {
        if (Object.hasOwn(raw, 'keyStyle')) return;
        raw['keyStyle'] = 'dotted';
        styled = true;
      })
    : null;
  const plans: WritePlan[] = [...(styled && style !== null ? [style] : [])];

  let wrote: string[];
  try {
    ({ written: wrote } = writePlanned([...planRepoForms(io.cwd, config, descriptor, snapshot, status, report), ...plans]));
  } catch (error) {
    rethrowBatchFailure('stet import', error);
  }
  for (const name of wrote) report.line(`wrote ${name}`);
  return report.emit(io);
}

/**
 * The rows of an imported object, in its own order: `only` keeps a key equal
 * to, or opening with, one of its prefixes; each kept value is converted from
 * the host's placeholder spelling to stet's.
 */
export function importRows(object: Record<string, unknown>, opts: { only: readonly string[]; placeholders: Placeholders }): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const key of Object.keys(object)) {
    if (opts.only.length > 0 && !opts.only.some((prefix) => key.startsWith(prefix))) continue;
    if (!KEY_NAME.test(key)) {
      rows.push({ key, approved: false, skipped: 'not a key name' });
      continue;
    }
    const entry = object[key];
    let value: unknown;
    let approved = false;
    if (typeof entry === 'string') value = entry;
    else if (Array.isArray(entry)) {
      value = entry[0];
      approved = entry[1] === 'approved';
    } else if (entry !== null && typeof entry === 'object' && Object.hasOwn(entry, 'value')) {
      value = (entry as Record<string, unknown>)['value'];
    }
    if (typeof value !== 'string') rows.push({ key, approved: false, skipped: 'not a string, a [value, meta] pair or a { value } object' });
    else if (value === '') rows.push({ key, approved: false, skipped: 'an empty value' });
    else rows.push({ key, value: toStet(value, opts.placeholders), approved });
  }
  return rows;
}

/** The object `--export` names in a file (or the one the file offers alone), with the name the plan's header shows. */
function readTable(cwd: string, file: string, exportName: string | undefined): { object: Record<string, unknown>; label: string | undefined } {
  let source: string;
  try {
    source = readFileSync(resolve(cwd, file), 'utf8');
  } catch (error) {
    throw new CliError(`import: ${file} could not be read: ${(error as Error).message}`);
  }
  if (extname(file).toLowerCase() === '.json') {
    let root: unknown;
    try {
      root = JSON.parse(source);
    } catch (error) {
      throw new CliError(`import: ${file} could not be evaluated: ${(error as Error).message}`);
    }
    const object = exportName === undefined ? root : walk(root, exportName.split('.'));
    if (!isTable(object)) throw new CliError(`import: ${file} exports no ${exportName ?? 'object'}`);
    return { object, label: exportName };
  }
  const { exports, globals, context } = evaluateSource(file, source);
  let picked: unknown;
  let label: string | undefined;
  if (exportName !== undefined) {
    const path = exportName.split('.');
    const head = path[0] as string;
    picked = walk(Object.hasOwn(exports, head) ? exports : globals, path);
    label = exportName;
  } else if (isTable(exports['default'])) {
    picked = exports['default'];
    label = 'default';
  } else {
    // A classic script exports nothing; the objects it leaves on `window` stand in for exports.
    const offered = Object.keys(exports).length > 0 ? exports : globals;
    const objects = Object.keys(offered).filter((name) => isTable(offered[name]));
    if (objects.length > 1) throw new CliError(`import: ${file} exports several objects — name one with --export`);
    label = objects[0];
    picked = label === undefined ? undefined : offered[label];
  }
  if (!isTable(picked)) throw new CliError(`import: ${file} exports no ${exportName ?? 'object'}`);
  return { object: copyOut(file, context, picked), label };
}

/**
 * A file's top level run in a context of its own: the bindings its `export`s
 * name, and the globals it left behind. `window` and `globalThis` are the
 * context itself; nothing of stet's process is reachable from inside.
 */
export function evaluateSource(file: string, source: string): { exports: Record<string, unknown>; globals: Record<string, unknown>; context: vm.Context } {
  const spec = importedSpecifier(source);
  if (spec !== null) throw new CliError(`import: ${file} imports ${spec} — import a module that stands alone`);
  const { script, names } = scriptOf(source);
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox['window'] = sandbox;
  sandbox['globalThis'] = sandbox;
  const context = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
  const binding = names.map(([exported, local]) => `${JSON.stringify(exported)}: ${local}`).join(', ');
  try {
    new vm.Script(`${script}\n;globalThis.__stet_exports = { ${binding} };`, { filename: file }).runInContext(context, { timeout: EVALUATE_MS });
  } catch (error) {
    throw new CliError(`import: ${file} could not be evaluated: ${messageOf(error)}`);
  }
  const exports = (dataOf(sandbox, '__stet_exports') ?? {}) as Record<string, unknown>;
  const globals: Record<string, unknown> = {};
  for (const name of Object.keys(sandbox)) {
    if (name === 'window' || name === 'globalThis' || name === '__stet_exports') continue;
    globals[name] = dataOf(sandbox, name);
  }
  return { exports, globals, context };
}

/** The first module a file imports or re-exports from, as written; null for a file that stands alone. */
function importedSpecifier(source: string): string | null {
  const found =
    /^[ \t]*import\b[^'";]*?(['"])([^'"\n]+)\1/m.exec(source) ??
    /^[ \t]*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/m.exec(source) ??
    /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/.exec(source);
  return found === null ? null : (found[2] as string);
}

/**
 * An ES module's text as a classic script: each `export` declaration loses its
 * keyword, `export default` binds `__stet_default`, an `export { a, b as c }`
 * list goes; `names` pairs each exported name with the binding that holds it.
 * A file with no `export` runs as it stands.
 */
function scriptOf(source: string): { script: string; names: Array<[string, string]> } {
  const names: Array<[string, string]> = [];
  let script = source.replace(
    /^(\s*)export\s+((?:async\s+)?function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, space: string, kind: string, name: string) => {
      names.push([name, name]);
      return `${space}${kind} ${name}`;
    },
  );
  script = script.replace(/^(\s*)export\s+default\s+/gm, (_m, space: string) => {
    names.push(['default', DEFAULT_BINDING]);
    return `${space}const ${DEFAULT_BINDING} = `;
  });
  script = script.replace(/^\s*export\s*\{([^}]*)\}\s*;?/gm, (_m, list: string) => {
    for (const part of list.split(',')) {
      const [local, exported] = part.trim().split(/\s+as\s+/);
      if (local !== undefined && local !== '') names.push([exported ?? local, local]);
    }
    return '';
  });
  return { script, names };
}

/** The chosen object as plain data, written to JSON inside the context under the same ceiling, so a getter or proxy of the host's never runs in stet's realm. A function or `undefined` value comes out as an object with no `value`, which the rows skip. */
function copyOut(file: string, context: vm.Context, picked: unknown): Record<string, unknown> {
  (context as Record<string, unknown>)['__stet_pick'] = picked;
  try {
    const json = new vm.Script(
      'JSON.stringify(__stet_pick, function (k, v) { return typeof v === "function" || v === undefined ? { "\\u0000": 0 } : v; })',
    ).runInContext(context, { timeout: EVALUATE_MS }) as string;
    return JSON.parse(json) as Record<string, unknown>;
  } catch (error) {
    throw new CliError(`import: ${file} could not be evaluated: ${messageOf(error)}`);
  }
}

/** A data property's value, never a getter's: reading one would run the host's code outside the ceiling. */
function dataOf(holder: unknown, name: string): unknown {
  if (holder === null || typeof holder !== 'object') return undefined;
  const found = Object.getOwnPropertyDescriptor(holder, name);
  return found !== undefined && 'value' in found ? found.value : undefined;
}

/** A dotted path walked over data properties; undefined where any step is missing. */
function walk(root: unknown, path: readonly string[]): unknown {
  let at = root;
  for (const part of path) at = dataOf(at, part);
  return at;
}

/** An object that can hold rows: not null, not a list, not a function. */
function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An error's message, whichever realm threw it. */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

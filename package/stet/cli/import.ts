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
 * ever read. The `export` rewrite works on lines, so a template literal holding
 * a line that opens with `export` is edited as the file's own code would be: that
 * word is dropped from the string. Everything the file's objects can run — a getter, a proxy trap, an
 * inherited accessor, a replaced `JSON.stringify`, a thrown value's `message` —
 * runs INSIDE the context under the ceiling: the table is picked and written as
 * one JSON string there, and stet's realm only checks that it is a string of
 * bounded length and parses it.
 *
 * Offline by contract: the loading path is `check`'s own, as `remove`'s is.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import vm from 'node:vm';

import { toStet, varsOf, type Placeholders } from '../src/placeholders.js';
import { DEFAULT_TARGET, type KeyDef } from '../src/types.js';
import { flag, parse, positionalsAround, required, text } from './args.js';
import { planRepoForms, rethrowBatchFailure, writePlanned, type WritePlan } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { loadConfig, rawConfigPlan, refuseInCopyFrom } from './config.js';
import { KEY_NAME, NAME_PART } from './key-names.js';
import type { CliIo } from './main.js';
import { CliError, clip, HostTextReport, Report, UsageError } from './report.js';
import { approveKeys, gitUserName, loadStatus, type StatusFile } from './status.js';
import { isStoreBacked } from './store.js';
import { validateValue } from './validate.js';

/** How long a file's top level may run before it is refused as an evaluation error. */
const EVALUATE_MS = 2000;

/** The longest JSON string the context may hand back, in characters. */
const MAX_JSON = 16 * 1024 * 1024;

/** How much of a value one plan line shows. */
const SHOWN = 200;

/** The longest span of text one pre-scan pattern or `declaredAfter` reads for a single statement. */
const STATEMENT = 64 * 1024;

/** The text `declaredAfter` may read across all the exports of one file, so a file of open declarations cannot make the scan quadratic. */
const SCAN_BUDGET = 16 * 1024 * 1024;

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
  // A derived key has no words of its own: its text follows its source's template.
  for (const row of rows) {
    const from = Object.hasOwn(descriptor.keys, row.key) ? descriptor.keys[row.key]?.derivesFrom : undefined;
    if (row.value === undefined || from === undefined) continue;
    delete row.value;
    row.approved = false;
    row.skipped = `derives from ${from} — edit its template`;
  }

  const locale = config.locales.default;
  const defaults: Record<string, unknown> = { ...(snapshot[locale] ?? {}) };
  const held = (key: string): unknown => (Object.hasOwn(defaults, key) ? defaults[key] : undefined);
  // A declared key with no default is being filled, which overwrites nothing.
  const kindOf = (row: ImportRow): 'new' | 'same' | 'differs' | 'skipped' =>
    row.value === undefined
      ? 'skipped'
      : !Object.hasOwn(descriptor.keys, row.key) || held(row.key) === undefined
        ? 'new'
        : held(row.key) === row.value
          ? 'same'
          : 'differs';
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
      report.line(`  ${row.key}  ${shown(row.value as string)}${vars.length === 0 ? '' : `  vars: ${vars.join(', ')}`}`);
    } else if (kind === 'differs') {
      report.line(
        `  ${row.key}  differs: ${shown(row.value as string)} — the snapshot holds ${shown(held(row.key))}${replace ? '' : "; pass --replace to take the file's"}`,
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

/** A value as a plan line quotes it: whole while it is short, else clipped. */
function shown(value: unknown): string {
  return typeof value === 'string' && value.length > SHOWN ? JSON.stringify(clip(value, SHOWN)) : JSON.stringify(value);
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

/**
 * The selection of the table, run INSIDE the context: `request` is the
 * `--export` path or '' for the default export, the only object, or the one a
 * classic script left on `window`. Properties are read as data (never through
 * a getter) and the answer is ONE string, so stet's realm never touches an
 * object the file made. `several` marks an ambiguous file.
 */
function pickScript(request: string): string {
  return `(function (request) {
  var own = function (o, k) {
    if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return undefined;
    var d = Object.getOwnPropertyDescriptor(o, k);
    return d && 'value' in d ? d.value : undefined;
  };
  var table = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
  var exps = own(globalThis, '__stet_exports') || {};
  var globals = {};
  Object.keys(globalThis).forEach(function (n) {
    if (n !== 'window' && n !== 'globalThis' && n !== '__stet_exports') globals[n] = own(globalThis, n);
  });
  var picked, label;
  if (request !== '') {
    var path = request.split('.');
    var at = Object.prototype.hasOwnProperty.call(exps, path[0]) ? exps : globals;
    path.forEach(function (p) { at = own(at, p); });
    picked = at;
    label = request;
  } else if (table(own(exps, 'default'))) {
    picked = own(exps, 'default');
    label = 'default';
  } else {
    var offered = Object.keys(exps).length > 0 ? exps : globals;
    var names = Object.keys(offered).filter(function (n) { return table(own(offered, n)); });
    if (names.length > 1) return JSON.stringify({ several: true });
    label = names[0];
    picked = label === undefined ? undefined : own(offered, label);
  }
  if (!table(picked)) return JSON.stringify({});
  return JSON.stringify({ label: label, object: picked }, function (k, v) { return typeof v === 'function' || v === undefined ? { '\\u0000': 0 } : v; });
})(${JSON.stringify(request)})`;
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
    let at = root;
    for (const part of exportName === undefined ? [] : exportName.split('.')) {
      at = at !== null && typeof at === 'object' && Object.hasOwn(at, part) ? (at as Record<string, unknown>)[part] : undefined;
    }
    if (!isTable(at)) throw new CliError(`import: ${file} exports no ${exportName ?? 'object'}`);
    return { object: at, label: exportName };
  }
  const context = evaluateSource(file, source);
  let json: unknown;
  try {
    json = new vm.Script(pickScript(exportName ?? '')).runInContext(context, { timeout: EVALUATE_MS, displayErrors: false });
  } catch (error) {
    throw new CliError(`import: ${file} could not be evaluated: ${thrownMessage(context, error)}`);
  }
  if (typeof json !== 'string') throw new CliError(`import: ${file} could not be evaluated: the table could not be read as data`);
  if (json.length > MAX_JSON) throw new CliError(`import: ${file} could not be evaluated: the table is too large`);
  let picked: { object?: unknown; label?: unknown; several?: unknown };
  try {
    picked = JSON.parse(json) as typeof picked;
  } catch {
    throw new CliError(`import: ${file} could not be evaluated: the table could not be read as data`);
  }
  if (picked.several === true) throw new CliError(`import: ${file} exports several objects — name one with --export`);
  if (!isTable(picked.object)) throw new CliError(`import: ${file} exports no ${exportName ?? 'object'}`);
  return { object: picked.object, label: typeof picked.label === 'string' ? picked.label : undefined };
}

/**
 * A file's top level run in a context of its own, and the context it ran in:
 * the bindings its `export`s name sit on `__stet_exports` and the globals it
 * left behind stay on the context. `window` and `globalThis` are the context
 * itself; nothing of stet's process is reachable from inside.
 */
export function evaluateSource(file: string, source: string): vm.Context {
  const spec = importedSpecifier(source);
  if (spec !== null) throw new CliError(`import: ${file} imports ${spec} — import a module that stands alone`);
  const { script, names } = scriptOf(source);
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox['window'] = sandbox;
  sandbox['globalThis'] = sandbox;
  const context = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
  // Each name is read through a guard: a line that looks like an `export` inside a comment or a
  // template names a binding that does not exist, which must not fail a valid module.
  const binding = names
    .map(([exported, local]) => `${JSON.stringify(exported)}: (function () { try { return ${local}; } catch (_) { return undefined; } })()`)
    .join(', ');
  let compiled: vm.Script;
  try {
    compiled = new vm.Script(`${script}\n;globalThis.__stet_exports = { ${binding} };`, { filename: file });
  } catch (error) {
    // A compile error is the host realm's own SyntaxError, so its message is plain text.
    throw new CliError(`import: ${file} could not be evaluated: ${limitOf(source, script) ?? (error as Error).message}`);
  }
  try {
    compiled.runInContext(context, { timeout: EVALUATE_MS, displayErrors: false });
  } catch (error) {
    throw new CliError(`import: ${file} could not be evaluated: ${thrownMessage(context, error)}`);
  }
  return context;
}

/** The first module a file imports or re-exports from, as written; null for a file that stands alone. */
function importedSpecifier(source: string): string | null {
  const found =
    /^[ \t]*import\b[^'";]{0,2000}?(['"])([^'"\n]+)\1/m.exec(source) ??
    /^[ \t]*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]{0,2000}\})\s*from\s*(['"])([^'"\n]+)\1/m.exec(source) ??
    /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/.exec(source);
  return found === null ? null : (found[2] as string);
}

/**
 * The module syntax the rewrite cannot run, named where a script fails to
 * compile and uses it; undefined for any other syntax error. Top-level `await`
 * is the failure that compiles once the script sits inside an async function,
 * and is named only where the script holds an `await` outside strings and
 * comments (a top-level `return` compiles there too, and gets the compiler's own line).
 */
function limitOf(source: string, script: string): string | undefined {
  if (/^[ \t]*export\s+(?:const|let|var)\s*[{[]/m.test(source)) return 'a destructuring export is not supported — export each name on its own';
  if (!hasAwaitToken(script)) return undefined;
  try {
    new vm.Script(`(async function () {\n${script}\n})`);
    return 'top-level await is not supported';
  } catch {
    return undefined;
  }
}

/** Whether a script holds an `await` word outside its comments and the text of its string and template literals. */
function hasAwaitToken(script: string): boolean {
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < script.length && script[i] !== ch; i += 1) if (script[i] === '\\') i += 1;
    } else if (ch === '/' && script[i + 1] === '/') {
      const end = script.indexOf('\n', i);
      if (end < 0) return false;
      i = end;
    } else if (ch === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 1;
    } else if (script.startsWith('await', i) && !/[\w$]/.test(script[i - 1] ?? '') && !/[\w$]/.test(script[i + 5] ?? '')) {
      return true;
    }
  }
  return false;
}

/**
 * An ES module's text as a classic script: each `export` declaration loses its
 * keyword, `export default` binds `__stet_default`, an `export { a, b as c }`
 * list goes; `names` pairs each exported name with the binding that holds it.
 * A file with no `export` runs as it stands.
 */
function scriptOf(source: string): { script: string; names: Array<[string, string]> } {
  const names: Array<[string, string]> = [];
  const budget = { left: SCAN_BUDGET };
  let script = source.replace(
    /^([ \t]*)export\s+((?:async\s+)?function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, space: string, kind: string, name: string, at: number) => {
      names.push([name, name]);
      for (const more of declaredAfter(source, at + _m.length, budget)) names.push([more, more]);
      return `${space}${kind} ${name}`;
    },
  );
  script = script.replace(/^([ \t]*)export\s+default\s+/gm, (_m, space: string) => {
    names.push(['default', DEFAULT_BINDING]);
    return `${space}const ${DEFAULT_BINDING} = `;
  });
  script = script.replace(/^[ \t]*export[ \t]*\{([^}]{0,2000})\}[ \t]*;?/gm, (_m, list: string) => {
    for (const part of list.split(',')) {
      const [local, exported] = part.trim().split(/\s+as\s+/);
      if (local !== undefined && local !== '') names.push([exported ?? local, local]);
    }
    return '';
  });
  return { script, names };
}

/**
 * The names a declaration goes on to declare after its first: the identifiers
 * that follow a comma at the declaration's own depth, up to its `;` or the
 * line that ends it (`export const a = 1, b = 2`). Strings, template literals
 * and comments are skipped over; a name found in error binds to nothing and
 * reads as undefined. One declaration is read for at most `STATEMENT` characters
 * and all of a file's declarations for `budget.left`.
 */
function declaredAfter(source: string, from: number, budget: { left: number }): string[] {
  const found: string[] = [];
  let depth = 0;
  let last = '';
  const stop = Math.min(source.length, from + STATEMENT, from + budget.left);
  budget.left -= stop - from;
  for (let i = from; i < stop; i += 1) {
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < stop && source[i] !== ch; i += 1) if (source[i] === '\\') i += 1;
      last = ch;
    } else if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const end = source[i + 1] === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 1;
      if (end <= 0) break;
      i = source[i + 1] === '/' ? end - 1 : end;
    } else if ('([{'.includes(ch)) {
      depth += 1;
      last = ch;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
      last = ch;
      if (depth < 0) break;
    } else if (depth === 0 && ch === ';') {
      break;
    } else if (depth === 0 && ch === '\n' && !',=+-*/%&|^?:<>.'.includes(last) && last !== '') {
      break;
    } else if (depth === 0 && ch === ',') {
      const next = /^\s*([A-Za-z_$][\w$]*)\s*(?==|,|;|\n|$)/.exec(source.slice(i + 1, i + 1 + 256));
      if (next !== null) found.push(next[1] as string);
      last = ch;
    } else if (!/\s/.test(ch)) {
      last = ch;
    }
  }
  return found;
}

/** An object that can hold rows: not null, not a list, not a function. */
function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The message of whatever a file's code threw, read inside the context under
 * the ceiling: a thrown proxy, a looping `message` getter or a throw of the
 * file's own never runs on stet's stack. An unreadable value answers with a
 * fixed phrase.
 */
function thrownMessage(context: vm.Context, error: unknown): string {
  // The carrier's name is minted per call: a file cannot define a setter under a name it has no way to learn.
  const carrier = `__stet_${randomBytes(8).toString('hex')}`;
  try {
    (context as Record<string, unknown>)[carrier] = error;
    return String(
      new vm.Script(
        `(function (e) { try { var m = e !== null && typeof e === "object" ? e.message : undefined; return typeof m === "string" ? m : String(e); } catch (_) { return "an error that could not be read"; } })(${carrier})`,
      ).runInContext(context, { timeout: EVALUATE_MS, displayErrors: false }),
    );
  } catch {
    return 'an error that could not be read';
  }
}

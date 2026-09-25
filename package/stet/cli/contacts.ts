/**
 * `stet contacts` — the terminal read surface of the contacts model and the
 * operator's writes to it (§13.1e; the Contacts tab is phase 2). Every command
 * reaches the list through the store's contacts capability, in the store
 * `contactsBlock` resolves: the declared `contacts.store`, else the content
 * store. People are printed and exported, never written into the repository.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';

import { contactsMarker, isNotSupported, isStoreError } from '../adapters/store-shared.js';
import { checkAnswers, checkDeclaration, FORM_KEY, GROUP_KEY, isEmail, normalEmail } from '../src/contacts.js';
import type { GroupProperty, MemberRow, NotSupported, StoreAdapter, StoreError } from '../src/store.js';
import { ENV_OPTION, flag, noPositionals, parse, required, text, type ParsedArgs } from './args.js';
import { loadConfig } from './config.js';
import { trackable } from './git.js';
import type { CliIo } from './main.js';
import { openContactsStore } from './project.js';
import { CliError, plural, Report, sanitizeLine, UsageError } from './report.js';

const SUBCOMMANDS = 'groups | list | get | export | erase | suppress | import | group add | group open | group close';

export async function runContacts(args: string[], io: CliIo): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'groups':
      return withStore(rest, io, { json: 'boolean' }, groups);
    case 'list':
      return withStore(rest, io, { json: 'boolean', group: 'string' }, list);
    case 'get':
      return withStore(rest, io, { json: 'boolean' }, get);
    case 'export':
      return withStore(rest, io, { out: 'string' }, exportOne);
    case 'erase':
      return withStore(rest, io, { write: 'boolean' }, erase);
    case 'suppress':
      return withStore(rest, io, { scope: 'string' }, suppress);
    case 'import':
      return withStore(rest, io, { group: 'string', file: 'string', 'joined-at': 'string', write: 'boolean' }, importFile);
    case 'group': {
      const verb = rest[0];
      if (verb === 'add') return withStore(rest.slice(1), io, { name: 'string', property: 'string', required: 'string' }, groupAdd);
      if (verb === 'open' || verb === 'close') {
        return withStore(rest.slice(1), io, {}, (store, parsed, report) => groupState(store, parsed, report, verb));
      }
      throw new UsageError(
        verb === undefined ? 'stet contacts group add | open | close' : `stet contacts group has add, open and close — got "${verb}"`,
      );
    }
    default:
      throw new UsageError(sub === undefined ? `stet contacts ${SUBCOMMANDS}` : `stet contacts has ${SUBCOMMANDS} — got "${sub}"`);
  }
}

/** `project` is the project the store's rows belong to, which erase and get name. */
type Body = (store: StoreAdapter, parsed: ParsedArgs, report: Report, io: CliIo, project: string) => Promise<void>;

/**
 * A report whose every line is made safe to print: the lines carry addresses,
 * answers, pages and group names a stranger or a store supplied. Findings are
 * already sanitized where they are formatted; `--json` stays byte-faithful.
 */
class ContactsReport extends Report {
  override line(text = ''): void {
    super.line(sanitizeLine(text));
  }
}

/**
 * Parse, open the contacts store, run, report, close. A project with no store
 * behind its contacts is told so in one line — contacts need a store — rather
 * than handed the snapshot adapter's `NotSupported` per method.
 */
async function withStore(args: string[], io: CliIo, options: Record<string, 'string' | 'boolean'>, body: Body): Promise<number> {
  const parsed = parse(args, { ...ENV_OPTION, ...options });
  const config = loadConfig(io.cwd);
  const opened = await openContactsStore(io, config, text(parsed.values, 'env'));
  if (opened === null) throw new CliError('stet contacts needs a store — see stet upgrade');
  const { name, own, store } = opened;
  const report = new ContactsReport();
  report.environment(own ? (name === 'contacts' ? 'default' : name.slice('contacts.'.length)) : name);
  try {
    await body(store, parsed, report, io, config.project);
  } finally {
    await opened.dispose();
  }
  return report.emit(io, { json: flag(parsed.values, 'json') });
}

/** What a group marker means, said about the group the command named. */
const MARKER_TEXT = {
  unknown_group: (group: string) => `no group ${group} — stet contacts groups lists them`,
  group_closed: (group: string) => `group ${group} is closed — stet contacts group open ${group} reopens it`,
  group_exists: (group: string) => `group ${group} already exists`,
} as const;

/**
 * A capability answer, or the report's error in its place. `group` is the key
 * the command named, so a group marker reads as a sentence about it.
 */
function answered<T extends object>(answer: T | NotSupported | StoreError, report: Report, group = ''): T | null {
  if (isNotSupported(answer)) {
    report.error('store', 'this store has no contacts capability');
    return null;
  }
  if (isStoreError(answer)) {
    const marker = contactsMarker(answer);
    report.error(marker === null ? 'store' : 'contacts', marker === null ? answer.message : MARKER_TEXT[marker](group));
    return null;
  }
  return answer;
}

/**
 * The declared questions as the terminal names them: `tier (solo | team |
 * business, required), use_case` — `required` shown where `withRequired` asks.
 */
function propertiesText(properties: GroupProperty[], withRequired: boolean): string {
  return properties
    .map((p) => {
      const notes = [...(p.type === 'enum' ? [(p.values ?? []).join(' | ')] : []), ...(withRequired && p.required ? ['required'] : [])];
      return notes.length ? `${p.name} (${notes.join(', ')})` : p.name;
    })
    .join(', ');
}

/** A membership's answers as `tier=team use_case=docs`, empty where there are none. */
function answersText(properties: Record<string, string>): string {
  return Object.entries(properties)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

async function groups(store: StoreAdapter, parsed: ParsedArgs, report: Report): Promise<void> {
  noPositionals(parsed.positionals, 'contacts groups');
  const found = answered(await store.contacts.groups(), report);
  if (found === null) return;
  report.data('groups', found.groups);
  if (found.groups.length === 0) report.line('no groups — stet contacts group add <key> creates one');
  for (const g of found.groups) {
    report.line(`${g.key}   ${g.state}   ${plural(g.members, 'member')}${g.properties.length ? `   ${propertiesText(g.properties, false)}` : ''}`);
  }
}

/** Every page of a group's members, in join order. */
async function allMembers(store: StoreAdapter, group: string): Promise<MemberRow[] | NotSupported | StoreError> {
  const rows: MemberRow[] = [];
  let afterId: number | undefined;
  for (;;) {
    const page = await store.contacts.members({ group, afterId, limit: 200 });
    if (isNotSupported(page) || isStoreError(page)) return page;
    rows.push(...page.rows);
    if (page.nextAfterId === null) return rows;
    afterId = page.nextAfterId;
  }
}

async function list(store: StoreAdapter, parsed: ParsedArgs, report: Report): Promise<void> {
  noPositionals(parsed.positionals, 'contacts list');
  const group = text(parsed.values, 'group');
  if (group === undefined) throw new UsageError('stet contacts list --group <key>');
  const rows = answered(await allMembers(store, group), report, group);
  if (rows === null) return;
  report.data('group', group);
  report.data('members', rows);
  report.line(`${group}: ${plural(rows.length, 'member')}`);
  for (const r of rows) {
    const answers = answersText(r.properties);
    report.line(`${r.email}   joined ${when(r.joinedAt)}${answers ? `   ${answers}` : ''}${r.suppressed ? '   unsubscribed (marketing)' : ''}`);
  }
}

async function get(store: StoreAdapter, parsed: ParsedArgs, report: Report, _io: CliIo, project: string): Promise<void> {
  const email = emailArg(parsed, 'contacts get');
  const found = answered(await store.contacts.contact({ email }), report);
  if (found === null) return;
  report.data('record', found.record);
  if (found.record === null) {
    report.line(`${email}: nothing held in project ${project}`);
    return;
  }
  const r = found.record;
  report.line(
    r.contact === null
      ? `${r.email} in project ${project} — no contact row`
      : `${r.email} in project ${project} — first seen ${when(r.contact.createdAt)}`,
  );
  for (const m of r.memberships) {
    const answers = answersText(m.properties);
    const from = m.page === null ? '' : ` from ${m.page}`;
    const form = m.form === null ? '' : ` (form ${m.form})`;
    report.line(`  ${m.group}   joined ${when(m.joinedAt)}${from}${form}${answers ? `   ${answers}` : ''}`);
  }
  for (const s of r.suppressions) report.line(`  suppressed: ${s.scope}, ${when(s.createdAt)} (${s.source})`);
}

/**
 * One person's record as JSON — to standard output, or to `--out`: a new file
 * in a folder that exists, which git does not track. An existing file is
 * refused rather than overwritten, so the file is always created here with
 * mode 0600; contacts never enter version control.
 */
async function exportOne(store: StoreAdapter, parsed: ParsedArgs, report: Report, io: CliIo): Promise<void> {
  const email = emailArg(parsed, 'contacts export');
  const found = answered(await store.contacts.contact({ email }), report);
  if (found === null) return;
  const text_ = `${JSON.stringify(found.record ?? { email, contact: null, memberships: [], suppressions: [] }, null, 2)}\n`;
  const out = text(parsed.values, 'out');
  if (out === undefined) {
    io.stdout(text_.trimEnd());
    return;
  }
  const path = resolvePath(io.cwd, out);
  const dir = dirname(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    report.error('contacts', `${out}: the folder ${dir} does not exist — create it first`);
    return;
  }
  if (existsSync(path)) {
    report.error('contacts', `${out} already exists — export writes a new file; remove it or name another`);
    return;
  }
  if (trackable(path) === true) {
    report.error('contacts', `${out} would be tracked by git — contacts never enter version control; write it outside the repository, or to a path .gitignore names and git does not track`);
    return;
  }
  writeFileSync(path, text_, { mode: 0o600, flag: 'wx' });
  report.line(`wrote ${out}`);
}

async function erase(store: StoreAdapter, parsed: ParsedArgs, report: Report, _io: CliIo, project: string): Promise<void> {
  const email = emailArg(parsed, 'contacts erase');
  const write = flag(parsed.values, 'write');
  if (!write) {
    const found = answered(await store.contacts.contact({ email }), report);
    if (found === null) return;
    const r = found.record;
    const held = r !== null && r.contact !== null;
    const groupsOf = r === null ? [] : r.memberships.map((m) => m.group);
    const scopes = r === null ? [] : r.suppressions.map((x) => x.scope);
    const stays = scopes.length === 0 ? '' : `the ${scopes.join(' and ')} ${scopes.length === 1 ? 'suppression stays' : 'suppressions stay'}; `;
    report.line(
      held
        ? `plan: delete ${email} in project ${project} — 1 contact row, ${plural(groupsOf.length, 'membership')}${groupsOf.length ? ` (${groupsOf.join(', ')})` : ''}; ` +
            `${stays}a one-way hash is recorded so an import cannot add the address back`
        : `plan: ${email} is not a contact in project ${project} — ${stays}a one-way hash is recorded so an import cannot add the address`,
    );
    report.line('run with --write to apply');
    return;
  }
  const done = answered(await store.contacts.erase({ email }), report);
  if (done === null) return;
  report.line(
    done.existed
      ? `erased ${email} in project ${project} — 1 contact row and ${plural(done.memberships, 'membership')} deleted, the hash recorded`
      : `${email} was not a contact in project ${project} — the hash is recorded`,
  );
}

async function suppress(store: StoreAdapter, parsed: ParsedArgs, report: Report): Promise<void> {
  const email = emailArg(parsed, 'contacts suppress');
  const scope = text(parsed.values, 'scope') ?? 'marketing';
  if (scope !== 'marketing' && scope !== 'transactional') throw new UsageError('--scope is marketing or transactional');
  const done = answered(await store.contacts.suppress({ email, scope, source: 'operator' }), report);
  if (done === null) return;
  report.line(done.suppressed ? `suppressed ${email} (${scope})` : `${email} was already suppressed (${scope})`);
}

/**
 * `--property tier=solo,team,business` (an enum) or `--property use_case`
 * (text); `--required` names a declared one. Both repeat: every occurrence is
 * read from the parse's tokens, since `parseArgs` keeps only the last value.
 * What a declaration may hold is `checkDeclaration`'s, the rule every
 * adapter's `addGroup` applies too.
 */
export function parseProperties(parsed: ParsedArgs): GroupProperty[] {
  const values = (name: string): string[] =>
    parsed.tokens.filter((t) => t.kind === 'option' && t.name === name && t.value !== undefined).map((t) => t.value as string);
  const properties: GroupProperty[] = values('property').map((flagValue) => {
    const eq = flagValue.indexOf('=');
    if (eq === -1) return { name: flagValue, type: 'text' };
    return { name: flagValue.slice(0, eq), type: 'enum', values: flagValue.slice(eq + 1).split(',').map((v) => v.trim()) };
  });
  const fault = checkDeclaration(properties);
  if (fault !== null) throw new UsageError(`--property ${fault}`);
  for (const name of values('required')) {
    const p = properties.find((x) => x.name === name);
    if (p === undefined) throw new UsageError(`--required ${name}: not a --property of this group`);
    p.required = true;
  }
  return properties;
}

async function groupAdd(store: StoreAdapter, parsed: ParsedArgs, report: Report): Promise<void> {
  const key = required(parsed.positionals, 'contacts group add', 'key');
  if (!GROUP_KEY.test(key)) throw new UsageError(`${key}: a group key is lowercase letters, digits and -, up to 64 characters`);
  const properties = parseProperties(parsed);
  const name = text(parsed.values, 'name') ?? key;
  const done = answered(await store.contacts.addGroup({ key, name, properties }), report, key);
  if (done === null) return;
  report.line(
    properties.length === 0
      ? `group ${key}: created, open — no properties`
      : `group ${key}: created, open — ${plural(properties.length, 'property', 'properties')}: ${propertiesText(properties, true)}`,
  );
  report.line(`join endpoint: POST <your forms mount>/join/${key}`);
  const shape = properties.length ? `{${properties.map((p) => `"${p.name}": "…"`).join(', ')}}` : '{}';
  report.line(`body: {"email": "…", "properties": ${shape}, "form": "…", "page": "…"}`);
}

async function groupState(store: StoreAdapter, parsed: ParsedArgs, report: Report, verb: 'open' | 'close'): Promise<void> {
  const key = required(parsed.positionals, `contacts group ${verb}`, 'key');
  const state = verb === 'open' ? 'open' : 'closed';
  const done = answered(await store.contacts.setGroupState({ key, state }), report, key);
  if (done === null) return;
  report.line(`group ${key}: ${state}`);
}

/**
 * `import`: rows from a JSON array of objects or a CSV with a header row. Each
 * row is checked the way the join route checks a form — the address, then the
 * answers against the group's declaration — and an invalid row is named and
 * skipped. The plan is the check; `--write` writes, and the store decides which
 * addresses are already members, erased or suppressed.
 */
async function importFile(store: StoreAdapter, parsed: ParsedArgs, report: Report, io: CliIo): Promise<void> {
  noPositionals(parsed.positionals, 'contacts import');
  const group = text(parsed.values, 'group');
  const file = text(parsed.values, 'file');
  if (group === undefined || file === undefined) throw new UsageError('stet contacts import --group <key> --file <json|csv>');
  const joinedAtColumn = text(parsed.values, 'joined-at');
  // Each membership records the file it came from as its form, under the join
  // route's form grammar: a name that cannot be one is refused before any row.
  const name = basename(file);
  const form = `import:${name}`;
  if (!FORM_KEY.test(form)) {
    report.error(
      'contacts',
      form.length > 100
        ? `the file name is ${name.length} characters — an import records it as the form import:<file name>, which holds at most 100, so the file name at most 93; rename the file`
        : `the file name ${name} holds a character a form name cannot — an import records it as the form import:<file name>, made of letters, digits and . _ @ : -; rename the file`,
    );
    return;
  }
  const found = answered(await store.contacts.group({ key: group }), report);
  if (found === null) return;
  const def = found.group;
  if (def === null) {
    report.error('contacts', MARKER_TEXT.unknown_group(group));
    return;
  }
  const rows = readRows(resolvePath(io.cwd, file));
  const valid: { email: string; properties: Record<string, string>; joinedAt: string | null }[] = [];
  const invalid: string[] = [];
  const now = Date.now();
  rows.forEach((row, i) => {
    const n = i + 1;
    const email = normalEmail(typeof row['email'] === 'string' ? row['email'] : '');
    if (!isEmail(email)) return void invalid.push(`row ${n}: no valid email`);
    const answers: Record<string, unknown> = {};
    for (const p of def.properties) if (Object.hasOwn(row, p.name)) answers[p.name] = row[p.name];
    const checked = checkAnswers(def.properties, answers);
    if (!checked.ok) return void invalid.push(`row ${n}: ${checked.property} ${checked.reason}`);
    let joinedAt: string | null = null;
    if (joinedAtColumn !== undefined) {
      const raw = row[joinedAtColumn];
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return void invalid.push(`row ${n}: ${joinedAtColumn} is not a date`);
      // A time with no zone is a guess about where it was taken: refused, and
      // the fix named, rather than read as this machine's local time.
      if (!ZONED.test(raw.trim())) {
        return void invalid.push(`row ${n}: ${joinedAtColumn} ${raw} has no time zone — append Z for UTC or an offset such as +02:00`);
      }
      if (!realDateTime(raw.trim())) return void invalid.push(`row ${n}: ${joinedAtColumn} is not a date`);
      const at = Date.parse(raw);
      if (at > now) return void invalid.push(`row ${n}: ${joinedAtColumn} ${raw} is in the future`);
      joinedAt = new Date(at).toISOString();
    }
    valid.push({ email, properties: checked.properties, joinedAt });
  });
  for (const line of invalid) report.warn('contacts', line);
  if (!flag(parsed.values, 'write')) {
    report.line(
      `plan: ${plural(rows.length, 'row')} for ${group} — ${valid.length} valid, ${invalid.length} invalid; ` +
        'addresses already in the group, erased or suppressed are skipped when written',
    );
    report.line('run with --write to apply');
    return;
  }
  const tally = { joined: 0, present: 0, erased: 0, suppressed: 0 };
  for (const row of valid) {
    const done = answered(await store.contacts.importMember({ group, email: row.email, properties: row.properties, form, joinedAt: row.joinedAt }), report, group);
    // A write that failed stops the run where it stands: the report says how
    // far it got, and a re-run skips what landed as `present`.
    if (done === null) break;
    tally[done.outcome] += 1;
  }
  report.line(
    `imported ${tally.joined} into ${group} — ${tally.present} already members, ${tally.erased} erased, ` +
      `${tally.suppressed} suppressed, ${invalid.length} invalid`,
  );
}

/**
 * A date-time that names its zone: `Z`, or an offset such as `+02:00`, `+0200`
 * or `+02` — Postgres prints a timestamptz as `2026-09-01 10:00:00.123456+00`.
 */
const ZONED = /[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;

/** The calendar date and wall-clock time a date-time opens with. */
const CALENDAR = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/i;

/**
 * Whether a date-time names a moment that exists: its date and time read back
 * unchanged. `Date.parse` rolls 30 February into 2 March and 24:00 into the
 * next day; either is refused rather than recorded as a day nobody joined on.
 */
function realDateTime(raw: string): boolean {
  const m = CALENDAR.exec(raw);
  if (m === null) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === mo - 1 &&
    at.getUTCDate() === d &&
    at.getUTCHours() === h &&
    at.getUTCMinutes() === mi &&
    at.getUTCSeconds() === s
  );
}

/** A JSON array of objects, or a CSV whose first row names the columns. */
export function readRows(path: string): Record<string, unknown>[] {
  let text_: string;
  try {
    text_ = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${(error as Error).message}`);
  }
  if (path.toLowerCase().endsWith('.csv')) {
    const [header, ...body] = parseCsv(text_);
    if (header === undefined) return [];
    return body
      .filter((cells) => !(cells.length === 1 && cells[0] === ''))
      .map((cells) => Object.fromEntries(header.map((h, i) => [h.trim(), cells[i] ?? ''])));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text_);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))) {
    throw new CliError(`${path} must be a JSON array of objects, one per person`);
  }
  return parsed as Record<string, unknown>[];
}

/** RFC 4180: comma-separated, `"` quotes a field, `""` inside quotes is one quote, CRLF or LF ends a row. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text_ = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  for (let i = 0; i < text_.length; i += 1) {
    const c = text_[i];
    if (quoted) {
      if (c === '"' && text_[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text_[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function emailArg(parsed: ParsedArgs, command: string): string {
  const email = normalEmail(required(parsed.positionals, command, 'email'));
  if (!isEmail(email)) throw new UsageError(`${email}: not an email address`);
  return email;
}

/** `2 Oct 2026 14:02`, in UTC — the stamp the store holds, read by a person. */
export function when(iso: string): string {
  const d = new Date(iso);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

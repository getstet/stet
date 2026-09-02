/**
 * The host's agent-routing guidance — the marker-delimited block that tells an
 * AI agent session working in an adopting repo that copy here is stet's, before
 * it hardcodes a string that the drift gate then catches at commit time.
 *
 * The block is a REMINDER, not a manual: two lines, one interpolation (the
 * descriptor path), no store-mode or surface variants. The detail lives in the
 * CLI's own output, because a workflow taught in a doc block goes stale and a
 * workflow taught by the tool does not — and a block whose content almost never
 * changes is what keeps the differs refusal a rarity.
 *
 * `init` writes it at adoption (approval-gated), `agents install` writes it into
 * a host that adopted before it existed, and `eject` removes it on the way out.
 * The markers are stet's ownership claim and they match LINE-ANCHORED only: a
 * marker quoted mid-line in host prose or inside a code fence is never a span
 * boundary, or a doc example carrying one marker would swallow host text into
 * the span and eject would delete it.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { noPositionals, parse, refuseEnv } from './args.js';
import { writeText } from './artifacts.js';
import { CONFIG_FILE, loadConfig, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { CliError, posixRelative, Report } from './report.js';
import { dominantEol } from './rewrite.js';

export const GUIDANCE_BEGIN = '<!-- stet:agent-guidance:begin -->';
export const GUIDANCE_END = '<!-- stet:agent-guidance:end -->';

/**
 * The two agent-instruction names, in probe order. Both, not one by precedence:
 * a host with both has tools reading each, and a block in one is invisible to
 * the other's readers. `.cursorrules`, `GEMINI.md` and kin are deliberately out
 * — this pair is the covering one.
 */
export const GUIDANCE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** The remedies every refusal names, so a host is never left guessing at one. */
const REMEDIES = 'delete the block and re-run, or keep your edit';

export interface GuidanceFile {
  path: string;
  /** `lstat` did not throw — a live symlink is present, and so is a dangling one. */
  exists: boolean;
}

export type GuidanceStatus = 'write' | 'append' | 'unchanged' | 'differs';

export interface GuidancePlan {
  status: GuidanceStatus;
  /** Set only on `differs`: what was found, and what to do about it. */
  note?: string;
}

/**
 * The block, deterministic and LF-terminated. The ONE interpolation is the
 * descriptor path: no store-mode, email or surface variants, no version string
 * and no timestamp, so the same config builds byte-identical text every time
 * and the three-state compare stays meaningful.
 *
 * The pointer line names bare `stet`, which prints the command listing
 * (`main.ts`'s `usage()` on the no-command path).
 */
export function buildGuidanceBlock(config: StetConfig): string {
  return [
    GUIDANCE_BEGIN,
    `Copy in this project is managed by stet — \`${config.descriptorPath}\` names the keys. ` +
      'Never hardcode user-facing copy; route copy work through the stet CLI ' +
      '(run `stet` for the commands), not source edits.',
    GUIDANCE_END,
    '',
  ].join('\n');
}

/**
 * A file's IDENTITY, which is what "the same file" has to mean when two names
 * can reach one: `dev:ino` folds a symlink, a HARDLINK, and a case alias on a
 * case-folding filesystem alike, where comparing resolved paths catches only
 * the first. The path stands in where nothing can be stat'd — a dangling link
 * is its own entry, and `planGuidance` routes it to the refusal.
 */
export function fileIdentity(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return path;
  }
}

/**
 * The files the block lands in, at `target`'s root.
 *
 * PRESENCE is `lstat`-did-not-throw, never `.isFile()`: a monorepo's
 * `CLAUDE.md → ../shared/CLAUDE.md` is the host's own layout and the write
 * follows it, while `existsSync` reports a DANGLING symlink as absent and a
 * create through it would silently write the link's missing target instead.
 * Present entries are deduped by file identity, or a pair reaching one file
 * would take the append twice.
 *
 * Carrying neither name yields BOTH, identical: the pair is what reaches every
 * tool, including a Claude session working in a monorepo's app directory. A
 * DIRECTORY at one of the names is present to `lstat` but is not an
 * agent-instruction file — it is reported by name AND the other name is still
 * created, or a host that happens to carry a `CLAUDE.md/` directory would end
 * up with no guidance anywhere and no line saying why.
 */
export function guidanceFiles(target: string): GuidanceFile[] {
  const entries: Array<GuidanceFile & { usable: boolean }> = [];
  const seen = new Set<string>();
  for (const name of GUIDANCE_NAMES) {
    const path = join(target, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      entries.push({ path, exists: false, usable: false });
      continue;
    }
    const identity = fileIdentity(path);
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push({ path, exists: true, usable: !directoryAt(path, stat) });
  }
  const strip = (entry: GuidanceFile & { usable: boolean }): GuidanceFile => ({
    path: entry.path,
    exists: entry.exists,
  });
  // At least one real file: those are the targets, and no sibling is invented.
  if (entries.some((entry) => entry.exists && entry.usable)) {
    return entries.filter((entry) => entry.exists).map(strip);
  }
  // None: both names, identical — carrying any unusable present entry along so
  // its refusal still reaches the report.
  return entries.map(strip);
}

/** A directory at `path`, through a symlink or directly. */
function directoryAt(path: string, stat: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (stat.isDirectory()) return true;
  if (!stat.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // dangling: not a directory, and the plan refuses it by name
  }
}

/**
 * What writing `block` to `path` would do, without doing it.
 *
 * Four states because they need four answers: absent is the create, a file with
 * no markers is the append, a span that matches is a no-op that makes a second
 * run change nothing, and anything else — an edited span, malformed markers, a
 * second block, a path that cannot be read, a file that is not utf8 — is a host
 * edit stet must not clobber. The compare is scoped to the marker span rather
 * than the whole file, because the block shares its file with host-authored
 * prose: a whole-file compare (`planWrite`) would report `differs` the moment a
 * host edits their own text elsewhere, refusing on every ordinary host.
 */
export function planGuidance(path: string, block: string): GuidancePlan {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { status: 'write' };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { status: 'differs', note: unreadable(stat, error) };
  }

  const source = bytes.toString('utf8');
  // The block's own bytes are utf8, so appending them to a file that is not
  // leaves a MIXED file: a windows-1252 reader renders the block's em dash as
  // mojibake, and a UTF-16 reader renders the whole appended tail as garbage.
  // The host's bytes would survive it, but the file would not be one any tool
  // reads correctly — so it is reported and the host places the block itself.
  if (!isUtf8Text(bytes, source)) {
    return { status: 'differs', note: 'it is not utf8 text — add the stet agent-guidance block by hand' };
  }

  const scan = scanMarkers(source);
  // A file that ends inside an unclosed fence has no bottom to append to: the
  // block would land INSIDE the fence, be invisible to the next scan, and be
  // appended again on every run — while eject, seeing no span, would leave
  // every copy behind. Refuse it, which is what this host got before fences
  // were understood at all.
  if (scan.fenceOpen) {
    return {
      status: 'differs',
      note: 'it ends inside an unclosed code fence — close the fence and re-run, or add the stet agent-guidance block by hand',
    };
  }
  const marks = scan.marks;
  if (marks.length === 0) return { status: 'append' };
  // One BEGIN then one END, and nothing else: any other arrangement is a host
  // edit to stet's own markers, and guessing at a span inside it is how host
  // prose gets deleted.
  const [open, close] = marks;
  if (marks.length !== 2 || open?.kind !== 'begin' || close?.kind !== 'end') {
    return {
      status: 'differs',
      note:
        marks.filter((m) => m.kind === 'begin').length > 1
          ? `it carries more than one stet agent-guidance block — ${REMEDIES}`
          : `its stet agent-guidance markers are malformed — ${REMEDIES}`,
    };
  }

  const span = normalizeSpan(source.slice(open.start, close.end));
  if (span === block) return { status: 'unchanged' };
  return {
    status: 'differs',
    note: `the stet agent-guidance block differs from what stet would write — ${REMEDIES}`,
  };
}

/**
 * The planned write, applied. `unchanged` and `differs` write nothing at all —
 * a differs is the caller's to report, and applying one would be the clobber
 * this whole seam exists to prevent.
 *
 * An append leaves every existing byte where it was: one separator newline in
 * the host file's own dominant EOL, then the block re-terminated the same way.
 * The separator is always written, and `removeGuidance` always takes one back,
 * which is what makes the removal the append's exact inverse — a host file that
 * ended without a newline gets its missing newline back on the way out.
 *
 * The host's bytes are APPENDED TO, never read-and-rewritten. A utf8 round trip
 * through a file that is not utf8 — a windows-1252 or UTF-16 `CLAUDE.md` — turns
 * every byte it cannot decode into U+FFFD, and writing that back would destroy
 * host content this seam exists to preserve. The utf8 read here only measures
 * the line ending; nothing it decodes is ever written.
 */
export function applyGuidance(path: string, block: string, plan: GuidancePlan): void {
  if (plan.status === 'write') {
    writeText(path, block);
    return;
  }
  if (plan.status !== 'append') return;
  const eol = dominantEol(readFileSync(path, 'utf8'));
  appendFileSync(path, `${eol}${block.split('\n').join(eol)}`, 'utf8');
}

/** Does this text carry a line-anchored guidance marker at all — eject's backstop probe. */
export function hasGuidanceMarker(source: string): boolean {
  return markerLines(source).length > 0;
}

/**
 * Every guidance span in `source`, each EOL-normalized to LF and terminated —
 * the shape a block compare takes, so eject can name a span's line count and
 * say whether it was edited before removing it.
 */
export function guidanceSpans(source: string): string[] {
  const spans: string[] = [];
  let marks = markerLines(source);
  for (;;) {
    const span = firstSpan(marks);
    if (span === null) return spans;
    spans.push(normalizeSpan(source.slice(span.start, span.end)));
    marks = marks.filter((m) => m.start >= span.end);
  }
}

/**
 * Eject's inverse of the append: EVERY span gone with the separator newline
 * that put it there, every other byte preserved exactly. The loop is what makes
 * the totality claim per FILE rather than per span — a host that ran `init` and
 * `agents install` against a moved block can carry two.
 *
 * `null` means the caller deletes the file, and it is answered from the removal
 * WITHOUT the separator cut: a host's own empty or BOM-carrying file has bytes
 * of its own to keep (even zero of them), while a file stet created holds
 * nothing but the block.
 */
export function removeGuidance(source: string): string | null {
  if (stripSpans(source, false) === '') return null;
  const out = stripSpans(source, true);
  // A file whose very FIRST byte was already stet's, and which holds nothing
  // besides its blocks and the separators between them, has no host content
  // either — eject deletes it rather than leaving a zero-byte file behind. A
  // host's own empty or BOM-carrying file starts with its own bytes and keeps
  // its file.
  if (out === '' && firstSpan(markerLines(source))?.start === 0) return null;
  return out;
}

export type GuidanceRemovalPlan =
  | { status: 'absent' }
  /** `result` is `null` where the file held nothing but its blocks — the caller deletes it. */
  | { status: 'remove'; result: string | null; lines: number; edited: boolean }
  | { status: 'skip'; note: string };

/**
 * What removing the guidance from `path` would do, without doing it — the shape
 * eject's plan line is printed from, so the host sees both the SIZE of what
 * leaves and whether it was stet's own text.
 *
 * Unlike the append, a removal must WRITE THE FILE BACK, and a write-back of
 * text decoded from bytes that are not utf8 replaces every undecodable byte
 * with U+FFFD — destroying host content. Such a file is reported and skipped
 * rather than rewritten. A marker with no matching end is reported too: it is
 * not a span the removal can take, and silence would leave the host a file
 * still pointing at a dependency that is gone.
 */
export function planGuidanceRemoval(path: string, block: string): GuidanceRemovalPlan {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { status: 'absent' };
  }
  const source = bytes.toString('utf8');
  const scan = scanMarkers(source);
  // Markers swallowed by a fence that never closes are markers this walk cannot
  // reach — and a silent `absent` here is what would leave them behind after
  // the dependency is gone. Named, so the host can close the fence or take the
  // block out by hand.
  if (scan.fenceOpen && scan.hidden > 0) {
    return {
      status: 'skip',
      note: 'it ends inside an unclosed code fence — close the fence and re-run, or remove the stet agent-guidance block by hand',
    };
  }
  if (scan.marks.length === 0) return { status: 'absent' };
  if (!isUtf8Text(bytes, source)) {
    return { status: 'skip', note: 'it is not utf8 text — remove the stet agent-guidance block by hand' };
  }
  const spans = guidanceSpans(source);
  if (spans.length === 0) {
    return {
      status: 'skip',
      note: 'it carries a stet agent-guidance marker with no matching end — remove it by hand',
    };
  }
  return {
    status: 'remove',
    result: removeGuidance(source),
    lines: spans.reduce((total, span) => total + span.split('\n').length - 1, 0),
    edited: spans.some((span) => span !== block),
  };
}

/**
 * Bytes a write-back may safely round-trip through a utf8 string.
 *
 * The re-encode compare catches windows-1252 and BOM-carrying UTF-16. The NUL
 * probe is what catches BOM-LESS UTF-16, whose padding bytes decode as U+0000
 * and survive the round trip unchanged — no markdown file carries a NUL for any
 * other reason.
 */
function isUtf8Text(bytes: Buffer, decoded: string): boolean {
  return !bytes.includes(0) && Buffer.from(decoded, 'utf8').equals(bytes);
}

// --- the command -----------------------------------------------------------

/**
 * `stet agents install` — the same write for a host that adopted before the
 * guidance existed. Re-running `init` is not that path: its all-or-nothing
 * scaffold plan refuses once a written file has evolved, and the descriptor
 * always has.
 *
 * It never prompts — invoking the command is the approval — and it plans EVERY
 * file before writing any, so a refusal on one leaves no partial emit behind it.
 */
export async function runAgentsInstall(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'agents install');
  const { positionals } = parse(args, {});
  noPositionals(positionals, 'agents install');
  const report = new Report();

  // The config FILE, not `loadConfig`'s answer: a missing file returns
  // `defaultConfig()` by design (config.ts), and there is no upward search — so
  // without this probe a run from the wrong directory would scaffold guidance
  // naming a descriptor path for a project that does not exist.
  if (!existsSync(join(io.cwd, CONFIG_FILE))) {
    throw new CliError(
      `agents install needs a stet project — run it from the directory holding ${CONFIG_FILE}, ` +
        'or run stet init first',
    );
  }

  const block = buildGuidanceBlock(loadConfig(io.cwd));
  const planned = guidanceFiles(io.cwd).map((file) => ({
    file,
    label: posixRelative(io.cwd, file.path),
    plan: planGuidance(file.path, block),
  }));

  const refused = planned.filter((p) => p.plan.status === 'differs');
  if (refused.length > 0) {
    throw new CliError(
      `${refused.map((p) => `${p.label}: ${p.plan.note ?? 'it differs from what stet would write'}`).join('; ')}. ` +
        'Nothing was written',
    );
  }

  // A clean plan can still fail at the write — a read-only file, a full disk.
  // Each failure is a FINDING rather than a throw: the report is emitted whole,
  // naming what was written and what was not, and `Report`'s own policy turns
  // an error finding into the nonzero exit. A throw here would take the record
  // of the successful writes with it.
  for (const { file, label, plan } of planned) {
    try {
      applyGuidance(file.path, block, plan);
    } catch (error) {
      report.error('config', writeFailure(label, error));
      continue;
    }
    report.line(outcomeLine(label, plan.status));
    noteIfIgnored(io.cwd, file.path, label, plan.status, report);
  }
  return report.emit(io);
}

/**
 * `init`'s guidance write — approval-gated, and never a failed init after a
 * successful scaffold.
 *
 * It runs outside the scaffold's all-or-nothing batch: that batch is over NEW
 * files stet owns, while this edits files it does not, under different per-file
 * semantics — folding it in would let a host's edited `CLAUDE.md` veto the
 * descriptor write. A `differs` here is reported and skipped, not thrown.
 */
export async function writeInitGuidance(args: {
  io: CliIo;
  target: string;
  config: StetConfig;
  yes: boolean;
  report: Report;
}): Promise<void> {
  const { io, target, config, yes, report } = args;
  const block = buildGuidanceBlock(config);
  const planned = guidanceFiles(target).map((file) => ({
    file,
    label: posixRelative(io.cwd, file.path),
    plan: planGuidance(file.path, block),
  }));

  for (const { label, plan } of planned) {
    if (plan.status === 'unchanged') report.line(outcomeLine(label, 'unchanged'));
    if (plan.status === 'differs') report.line(`${label}: ${plan.note ?? 'it differs from what stet would write'}`);
  }

  const actionable = planned.filter((p) => p.plan.status === 'write' || p.plan.status === 'append');
  if (actionable.length === 0) return;

  // Shown whole — the same diff-shaped transparency the mount edit gets, and
  // the block is short enough to print entire. These lines go to the `Report`,
  // which flushes at `emit`, so at a real terminal the PROMPT below arrives
  // first and the block prints with the rest of the report: the record of what
  // was written, not a preview. That is `mountProvider`'s behaviour too, and
  // changing it belongs to the Report, not to this one caller.
  for (const { label, plan } of actionable) {
    report.line(`${plan.status === 'write' ? 'create' : 'append to'} ${label} — the agent-guidance block:`);
    for (const line of block.replace(/\n$/, '').split('\n')) report.line(`  ${line}`);
  }

  const names = actionable.map((p) => p.label).join(', ');
  const apply = yes || (io.confirm ? await io.confirm(`Write the agent-guidance block to ${names}?`) : false);
  if (!apply) {
    report.line('agent guidance not written — stet agents install writes it later');
    return;
  }
  // A write that fails is REPORTED and the loop continues: init must not fail
  // after a successful scaffold, and the report must reach the operator whole.
  for (const { file, label, plan } of actionable) {
    try {
      applyGuidance(file.path, block, plan);
    } catch (error) {
      report.line(writeFailure(label, error));
      continue;
    }
    report.line(outcomeLine(label, plan.status));
    noteIfIgnored(io.cwd, file.path, label, plan.status, report);
  }
}

// --- the line-anchored marker machinery ------------------------------------

interface MarkerLine {
  kind: 'begin' | 'end';
  /** The offset of the marker line's first character. */
  start: number;
  /** The offset just past the marker line's terminator, or the end of `source`. */
  end: number;
}

interface MarkerScan {
  marks: MarkerLine[];
  /**
   * The scan reached end of file with a fence still OPEN. Such a file has no
   * bottom: everything appended to it lands inside the fence, invisible to the
   * next scan, so an append would repeat forever and a removal would find
   * nothing to take.
   */
  fenceOpen: boolean;
  /** Marker lines swallowed by that still-open fence — what a removal would miss. */
  hidden: number;
}

/**
 * Every line whose EOL-trimmed text is exactly one of the two markers, in
 * order, OUTSIDE any fenced code block — plus whether the file ended with a
 * fence still open.
 *
 * Whole lines only: an indented marker, or one quoted mid-line, is host text.
 * And a marker on its own line INSIDE a ``` or ~~~ fence is host text too — a
 * README showing what stet writes is documentation, and treating it as a span
 * boundary would refuse the host on init and delete their documentation on
 * eject. That is the same host-prose-deletion class the line anchor exists for,
 * reached by the other road.
 */
function scanMarkers(source: string): MarkerScan {
  const marks: MarkerLine[] = [];
  let fence: { char: string; length: number } | null = null;
  let hidden = 0;
  let pos = 0;
  for (;;) {
    const nl = source.indexOf('\n', pos);
    const lineEnd = nl === -1 ? source.length : nl;
    const textEnd = lineEnd > pos && source.charAt(lineEnd - 1) === '\r' ? lineEnd - 1 : lineEnd;
    const line = source.slice(pos, textEnd);

    // CommonMark allows a fence up to three spaces indented; the closing fence
    // is the same character, at least as long, and carries no info string — so
    // a ```js meant as a closer opens nothing and closes nothing.
    const rail = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (rail !== null) {
      const bar = rail[1] as string;
      const tail = rail[2] as string;
      if (fence === null) {
        fence = { char: bar.charAt(0), length: bar.length };
      } else if (bar.charAt(0) === fence.char && bar.length >= fence.length && tail.trim() === '') {
        // The fence CLOSED, so whatever it held was documentation after all.
        fence = null;
        hidden = 0;
      }
    } else if (line === GUIDANCE_BEGIN || line === GUIDANCE_END) {
      if (fence === null) {
        marks.push({
          kind: line === GUIDANCE_BEGIN ? 'begin' : 'end',
          start: pos,
          end: nl === -1 ? source.length : nl + 1,
        });
      } else {
        hidden += 1;
      }
    }
    if (nl === -1) return { marks, fenceOpen: fence !== null, hidden };
    pos = nl + 1;
  }
}

function markerLines(source: string): MarkerLine[] {
  return scanMarkers(source).marks;
}

/** The first BEGIN in `marks`, with the first END that follows it. */
function firstSpan(marks: MarkerLine[]): { start: number; end: number } | null {
  const begin = marks.find((m) => m.kind === 'begin');
  if (begin === undefined) return null;
  const end = marks.find((m) => m.kind === 'end' && m.start > begin.start);
  if (end === undefined) return null;
  return { start: begin.start, end: end.end };
}

/**
 * A span's text as the compare sees it: CRLF normalized to LF and one trailing
 * newline, so a CRLF host does not read as edited forever and a span truncated
 * at end-of-file still compares against the block's terminated form.
 */
function normalizeSpan(text: string): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\r?\n$|\r$/, '');
  return `${body}\n`;
}

/**
 * Every span cut out, optionally with the one separator newline the append put
 * in front of it. Each cut restarts the scan, so a file carrying two blocks
 * loses both.
 */
function stripSpans(source: string, withSeparator: boolean): string {
  let out = source;
  for (;;) {
    const span = firstSpan(markerLines(out));
    if (span === null) return out;
    let cut = span.start;
    // `cut > 0` is defensive, not load-bearing: `charAt(-1)` is `''`, so the
    // newline compare already fails at offset 0. Kept because the intent — do
    // not reach behind the start of the file — should not depend on a `charAt`
    // convention a reader has to recall.
    if (withSeparator && cut > 0 && out.charAt(cut - 1) === '\n') {
      cut -= 1;
      // The separator was written in the SPAN's own line ending, so the `\r` is
      // only ours to take when the span itself is CRLF. A host file whose last
      // byte was a bare `\r` formed an accidental CRLF with our LF, and that
      // `\r` is the host's — taking it would lose a byte.
      const spanIsCrlf = out.charAt(span.start + GUIDANCE_BEGIN.length) === '\r';
      if (spanIsCrlf && cut > 0 && out.charAt(cut - 1) === '\r') cut -= 1;
    }
    out = out.slice(0, cut) + out.slice(span.end);
  }
}

// --- small shared helpers --------------------------------------------------

/** The errno a thrown fs error carries, or `''` where it carries none. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: string }).code;
  return typeof code === 'string' ? code : '';
}

/**
 * What a present-but-unreadable path IS, named from what the READ actually
 * threw rather than guessed at. A symlink that cannot be followed is not
 * necessarily a missing target — a loop throws `ELOOP` and would otherwise be
 * reported as a lie — so every case the message claims is one the errno states.
 *
 * The note is a bare finding: each caller adds its own tail, because `init`
 * reports and skips while `agents install` refuses the whole run.
 */
function unreadable(stat: { isSymbolicLink(): boolean }, error: unknown): string {
  const link = stat.isSymbolicLink();
  const code = errorCode(error);
  if (code === 'EISDIR') return link ? 'it is a symlink to a directory, not a file' : 'it is a directory, not a file';
  if (code === 'ENOENT' && link) return 'it is a symlink to a missing target';
  if (code === 'ELOOP') return 'it is a symlink loop';
  return code === '' ? 'it could not be read' : `it could not be read (${code})`;
}

/**
 * A write that could not happen, named by its errno and never by a stack. The
 * expected causes are a read-only file or tree (`EACCES`, `EPERM`, `EROFS`) and
 * a full disk (`ENOSPC`); anything else is named the same way rather than
 * escaping, because losing the whole report to an unexpected errno is the
 * failure this catch exists to prevent.
 */
function writeFailure(label: string, error: unknown): string {
  const code = errorCode(error);
  return `${label}: could not be written${code === '' ? '' : ` (${code})`} — add the stet agent-guidance block by hand`;
}

/**
 * A written block git will never carry to another clone.
 *
 * The block's whole job is reaching an agent session in someone else's
 * checkout, and a gitignored `CLAUDE.md` reaches none of them — so it is said
 * out loud rather than left as a silent no-op. Advisory only: `git` missing or
 * a directory that is not a repo degrades to nothing, the `hooksDir` posture.
 */
function noteIfIgnored(cwd: string, path: string, label: string, status: GuidanceStatus, report: Report): void {
  if (status !== 'write' && status !== 'append') return;
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    return; // exit 1 = tracked, 128 = not a repo, ENOENT = no git
  }
  report.line(`${label} is gitignored — the block will not reach other clones`);
}

/** The per-file line a completed write prints. */
function outcomeLine(label: string, status: GuidanceStatus): string {
  if (status === 'write') return `wrote ${label} (agent guidance)`;
  if (status === 'append') return `${label}: agent guidance appended`;
  return `${label}: agent guidance already present, identical`;
}



/**
 * The one home for what a command prints and what it exits with. Every command
 * builds a `Report` and hands it back; nothing else decides an exit code, so
 * "a warning is not a failure" is a property of this file rather than a rule
 * eleven commands each remember.
 *
 * The policy, whole: any `error` exits 1, warnings alone exit 0, and a usage
 * mistake exits 2 before a command runs at all. `--json` emits the same
 * findings and the same payload as one object, so a script reads exactly what
 * a human reads.
 */

import { relative, sep } from 'node:path';

import type { SeoRule } from '../src/seo.js';
import type { FindingRule } from '../src/validate.js';

/**
 * What a finding is about. `src/validate.ts`'s save-time rules and
 * `src/seo.ts`'s audit rules, plus the six kinds the terminal owns: `shape`
 * (the declared shape rejected the value — a check that lives in `shapeSchema`,
 * not in `validateSave`), `store` (what the store answered, or — where a
 * command is offline by contract — that it deliberately did not read one),
 * `config` (the project's own files), `scan` (what the drift gate found in the
 * host: an unkeyed copy literal in a managed surface with its file and
 * position, a declared slot the pointered template never reads, a static route
 * no declared page claims), `email` (what the template commands found: a file
 * extract skipped, a custody comparison that failed), and `pages` (a route
 * `pages scan` read and refused to propose, with the reason it refused).
 */
export type CliFindingKind =
  | FindingRule
  | SeoRule
  | 'shape'
  | 'store'
  | 'config'
  | 'scan'
  | 'email'
  | 'pages';

/** Two levels only: one fails the command, the other reports and does not. */
export type CliLevel = 'error' | 'warn';

export interface CliFinding {
  kind: CliFindingKind;
  level: CliLevel;
  /**
   * The content key a finding is about, where it is about one — possibly
   * entry-pathed (`footer_links[2]`, `labels.email`) where the rule walked into
   * a structured value. It is `src/validate.ts`'s `Finding.key` verbatim, and
   * `--json` carries it as it stands.
   */
  key?: string;
  message: string;
}

/**
 * An actionable failure: the message is printed, the exit code is 1, and no
 * stack reaches the terminal. Anything that escapes as a raw Error is a bug in
 * stet and keeps its stack on purpose.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Every character that can act on a terminal rather than print in it: the C0
 * controls (tab and newline included — a line print is one line), DEL, the C1
 * controls, and the bidi overrides and isolates.
 *
 * C1 is here because U+009B is CSI in a UTF-8 xterm — stripping ESC alone
 * leaves a second way to open an escape sequence, and the message would still
 * repaint the screen. The bidi set (U+202A–U+202E, U+2066–U+2069) is the
 * Trojan-Source vector: an override inside a finding makes the terminal
 * display a different key name than the one the finding actually names, which
 * is worse than a repaint because it is silent.
 *
 * Written with escapes rather than the bytes themselves: a literal control
 * character in source is invisible to a reader and to a patch.
 *
 * A `g` regex is safe here because `String.replace` starts at index 0 and
 * resets `lastIndex`; a `.test()` caller would carry it between calls.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * A finding message, made safe to print. Store-controlled text reaches the
 * message through interpolation — an entry path names a record field, and the
 * field name comes from the row — so an escape sequence in a field name would
 * otherwise reach the terminal and repaint it.
 *
 * The LINE channel is what is sanitized, not the data: `Finding` objects and
 * `--json` stay byte-faithful, because a program reading the wire needs the
 * bytes that were stored. `JSON.stringify` escapes the ESC byte on that wire;
 * a consumer that re-prints decoded JSON content raw crosses this boundary in
 * its own terminal, and owns that.
 */
function sanitizeLine(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '\uFFFD');
}

/**
 * A finding rendered for a human channel: its level, and its message with every
 * terminal-active character replaced.
 *
 * Exported because `doctor`'s pasteable block formats findings too, and one
 * formatter is what makes "finding text is sanitized wherever it is printed" a
 * property of this code rather than a claim about it. Hand-rolling the same
 * template at a second site is exactly how the raw path survived the first
 * sanitizer, and the block travels further than a terminal — it is what an
 * operator pastes into an issue.
 */
export function formatFinding(finding: CliFinding): string {
  return `${finding.level}: ${sanitizeLine(finding.message)}`;
}

/**
 * A path from one directory to another in the `/`-joined spelling every message
 * uses, whatever separator the platform walks with.
 *
 * Named for what it DOES rather than for repo-relative, because three of its
 * callers rebase on something else: a tsconfig alias root, a module's own
 * directory, and a symlink's canonical root.
 */
export function posixRelative(from: string, abs: string): string {
  return relative(from, abs).split(sep).join('/');
}

/**
 * A one-line preview of host- or store-supplied text, for a message that quotes
 * it. Whitespace collapses so a multi-line value cannot break the line a finding
 * occupies, and the length is the caller's because the useful amount differs:
 * a scanned literal is identified by its opening words, a captured stderr needs
 * room to carry the actual error.
 */
export function clip(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`;
}

/**
 * What a value IS, in the words a report uses.
 *
 * The article is computed rather than written into the sentence: `typeof` is
 * the only thing that knows the noun, and pasting it after a literal "a" says
 * "a object" and "a undefined" — the two shapes a refusal most often names.
 * `null` and arrays answer for themselves, because `typeof` calls both
 * "object" and a message that does is no help to whoever has to fix the value.
 */
export function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  const type = typeof value;
  return `${'aeiou'.includes(type[0] ?? '') ? 'an' : 'a'} ${type}`;
}

/**
 * A per-file block, collapsed to one count line once it stops being a list and
 * starts being a wall. Two refusals are information; twenty-nine bury the plan
 * they are printed beside — the site's eject printed a 29-line refusal block
 * over a 9-line plan, and the plan is what the operator came for.
 *
 * Three or fewer print verbatim, as does any number under `verbose`. It returns
 * lines rather than printing them: the callers own their channel, like every
 * other formatter here.
 */
export function collapseLines(lines: string[], summary: string, verbose: boolean): string[] {
  return lines.length > 3 && !verbose ? [summary] : lines;
}

/** The caller's invocation was wrong — exit 2, before any work happens. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Where a report goes. Structural, so nothing here imports the dispatch. */
export interface ReportSink {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export class Report {
  readonly findings: CliFinding[] = [];
  private readonly lines: string[] = [];
  private readonly payload: Record<string, unknown> = {};

  error(kind: CliFindingKind, message: string, key?: string): void {
    this.push('error', kind, message, key);
  }

  warn(kind: CliFindingKind, message: string, key?: string): void {
    this.push('warn', kind, message, key);
  }

  /** A line of the human report. `--json` never sees these. */
  line(text = ''): void {
    this.lines.push(text);
  }

  /** A field of the `--json` object. The human report never sees these. */
  data(name: string, value: unknown): void {
    this.payload[name] = value;
  }

  /**
   * Which environment this run selected — so `stet publish --env prod` never
   * reads like a default-environment run. A no-op on `default`, because a
   * default run must print exactly what it always printed.
   *
   * It rides the report, both halves, rather than a raw `io.stdout` line: a
   * bare line would sit outside the `--json` object on the five commands that
   * emit one, and would land in `stet get`'s scriptable output.
   */
  environment(name: string): void {
    if (name === 'default') return;
    this.line(`environment: ${name}`);
    this.data('environment', name);
  }

  /** `--strict`: every finding becomes a failure. Audit's whole flag. */
  promoteWarnings(): void {
    for (const finding of this.findings) finding.level = 'error';
  }

  /**
   * Another report's lines and findings, folded in. `doctor` embeds `check`'s
   * whole output at `warn` — the same facts, under a command whose contract is
   * to report rather than to gate.
   */
  absorb(other: Report, level?: CliLevel): void {
    for (const line of other.lines) this.lines.push(line);
    for (const finding of other.findings) {
      this.findings.push(level === undefined ? finding : { ...finding, level });
    }
  }

  get failed(): boolean {
    return this.findings.some((f) => f.level === 'error');
  }

  /** Prints, and answers with the exit code the policy demands. */
  emit(io: ReportSink, opts: { json?: boolean } = {}): number {
    if (opts.json === true) {
      io.stdout(JSON.stringify({ ok: !this.failed, ...this.payload, findings: this.findings }, null, 2));
    } else {
      for (const line of this.lines) io.stdout(line);
      for (const finding of this.findings) io.stderr(formatFinding(finding));
    }
    return this.failed ? 1 : 0;
  }

  private push(level: CliLevel, kind: CliFindingKind, message: string, key?: string): void {
    this.findings.push(key === undefined ? { kind, level, message } : { kind, level, key, message });
  }
}

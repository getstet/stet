/**
 * The render seam — the CLI's one way to execute a host template.
 *
 * Nothing here loads host code: `templates/email-runner.cjs` does, in a CHILD
 * process, one render per invocation. That is what makes a crashing template
 * fail itself while the walk continues, and it keeps a stranger's `require`
 * side effects out of the CLI's own process. This module spawns, maps the
 * child's exit table to the failure taxonomy, and returns — it never throws.
 *
 * The result is the SERIALIZED render: the runner writes `JSON.stringify` of
 * whatever the template returned, so a string result and a multi-part object
 * result (`{ subject, html }`) compare under one rule.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import type { Descriptor, RenderFrame, RenderPointer, TemplateDef } from '../src/types.js';
import { VARIABLE } from '../src/validate.js';
import { packageRoot } from './installed.js';
import type { CliIo } from './main.js';
import { clip, shapeOf } from './report.js';

/** Enough of a stray stdout write to recognize the line that produced it. */
const STRAY_EXCERPT = 200;

/** Why a render did not produce bytes. One per non-zero exit the runner names. */
export type RenderFailure =
  | 'export-not-function'
  | 'compiler-missing'
  | 'missing-dependency'
  | 'render-threw'
  | 'not-renderable'
  | 'send-failed';

export interface RenderRequest {
  /** The app package root — every import resolves from ITS `node_modules`. */
  hostDir: string;
  /** The module to render, absolute or resolvable from `hostDir`. */
  file: string;
  exportName: string;
  /** The one argument the export is called with. */
  props: Record<string, unknown>;
  /** The pointer's frame, its file resolvable from `hostDir` as `file` is. */
  frame?: RenderFrame;
  /** The pointer's `fill`. */
  fill?: boolean;
  /** `stet email test`: the host send function the rendered email is handed to, and the message around it. */
  send?: { file: string; export: string; message: SendMessage };
}

/** What `stet email test` hands the host's send function; the runner adds `html`. */
export interface SendMessage {
  to: string;
  subject: string | null;
  template: string;
}

export type RenderResult =
  | { ok: true; result: string; note?: string }
  | { ok: false; reason: RenderFailure; detail: string };

/**
 * The prefix the runner marks a line with when the render SUCCEEDED and there
 * is still something to say — today, that it fell back to the default export.
 * Everything else on the child's stderr during a successful render belongs to
 * the host's own template, which is routed there while it runs, so a note has
 * to be told apart by its marker rather than by being there at all.
 */
const NOTE_PREFIX = 'stet-note: ';

/**
 * The child's exit table, one-to-one with `templates/email-runner.cjs`. An exit
 * outside it is `render-threw` with the child's stderr, so a runner and a CLI
 * that ever drift apart still produce a reported failure rather than a throw.
 */
const REASONS: Record<number, RenderFailure> = {
  2: 'export-not-function',
  3: 'compiler-missing',
  4: 'missing-dependency',
  5: 'render-threw',
  6: 'not-renderable',
  7: 'send-failed',
};

/**
 * A rendered email is bytes, not a line: the 1 MB spawn default is too small.
 * Exported because `email verify` reads a template's committed source through
 * the same ceiling — one number, so the two cannot disagree about how large a
 * template may be.
 */
export const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * How long a host template may take to render before the child is killed.
 *
 * This executes a stranger's module: a top-level `await` on a network call, a
 * `while (true)`, a prompt waiting on stdin all hang forever, and `spawnSync`
 * has no timeout by default — so a single template could hang a pre-commit run
 * with no output at all.
 */
const RENDER_TIMEOUT_MS = 30_000;

/**
 * A spawn failure said in terms of the ceiling it met.
 *
 * `spawnSync` reports each of these as `error` with a code rather than as an
 * exit, and each has a different remedy: a template that never returns, one
 * whose output is enormous, and props too large for the argument list the child
 * is started with. Reporting them as a thrown render sends the reader looking
 * for a stack trace their template never produced.
 */
function ceilingDetail(error: NodeJS.ErrnoException, timeoutMs: number): string {
  if (error.code === 'ETIMEDOUT') {
    return (
      `the render did not finish within ${timeoutMs / 1000}s and the child was killed — ` +
      'this template blocks when it is called (a network call, a wait on input, a loop that does not end). ' +
      'Render it behind a guard, or declare this entry without a render pointer so it is reported unverifiable'
    );
  }
  if (error.code === 'ENOBUFS') {
    return (
      `the render produced more than ${MAX_OUTPUT / (1024 * 1024)}MB of output, which is the ceiling this seam ` +
      'reads a template through — an email that large is not a template stet can prove, so declare this entry ' +
      'without a render pointer, or cut what the template inlines (an embedded image is the usual cause)'
    );
  }
  if (error.code === 'E2BIG') {
    return (
      'the props are too large to pass to the render child — the sample props and every resolved slot value ' +
      'travel as one argument, and the operating system caps the argument list at about a megabyte. Shorten the ' +
      'seeded values, or declare this entry without a render pointer'
    );
  }
  return error.message;
}

/** The runner's command line for one request: the script, then its arguments. */
function runnerArgv(request: RenderRequest): string[] {
  const runner = join(packageRoot(), 'templates', 'email-runner.cjs');
  return [runner, request.hostDir, request.file, request.exportName, JSON.stringify(request.props), ...runnerOptions(request)];
}

/** What a finished child leaves: the error `spawn` or a ceiling raised, else its exit status and what it wrote. */
interface ChildOutcome {
  error?: NodeJS.ErrnoException;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function renderTemplate(io: CliIo, request: RenderRequest): RenderResult {
  const child = spawnSync(process.execPath, runnerArgv(request), {
    cwd: io.cwd,
    env: io.env,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    timeout: RENDER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return renderOutcome(
    { ...(child.error === undefined ? {} : { error: child.error as NodeJS.ErrnoException }), status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' },
    RENDER_TIMEOUT_MS,
  );
}

/** How long the pipes have to close after the runner exits on its own, when a process it started still holds them. */
const PIPE_GRACE_MS = 1_000;

/** The process groups of the renders in flight, ended with this process: a render's child is not in the terminal's group. */
const groups = new Set<number>();
let exitHooked = false;

/** SIGKILL to a whole process group: the runner and everything it started that stayed in it. Never `kill(-0)`. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined || pid === 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * The same render, asynchronous: the contract of `renderTemplate` — same
 * command line, environment, output ceiling and deadline, and never a throw —
 * for a caller that is a server. `spawnSync` would hold every route of
 * `stet dev` for as long as a template hangs. The deadline is an argument so a
 * fixture can reach it in a second; the callers take the default.
 *
 * The runner is started in a process group of its own and the deadline kills
 * the group, so a child the template started does not outlive it. A runner that
 * exits on its own has written its whole outcome, so the answer does not wait
 * past `PIPE_GRACE_MS` for pipes a process it started still holds.
 */
export function renderTemplateAsync(io: CliIo, request: RenderRequest, timeoutMs: number = RENDER_TIMEOUT_MS): Promise<RenderResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let ceiling: NodeJS.ErrnoException | undefined;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const done = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (child.pid !== undefined) groups.delete(child.pid);
      // Pipes a grandchild still holds are let go; the answer is already in the buffers.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(renderOutcome(outcome, timeoutMs));
    };
    const failed = (error: NodeJS.ErrnoException): void => done({ error, status: null, stdout: '', stderr: '' });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, runnerArgv(request), { cwd: io.cwd, env: io.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    } catch (error) {
      resolve(renderOutcome({ error: error as NodeJS.ErrnoException, status: null, stdout: '', stderr: '' }, timeoutMs));
      return;
    }
    if (child.pid !== undefined) {
      if (!exitHooked) {
        exitHooked = true;
        process.on('exit', () => groups.forEach(killGroup));
      }
      groups.add(child.pid);
    }
    const stop = (error: NodeJS.ErrnoException): void => {
      ceiling ??= error;
      killGroup(child.pid);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    // `maxBuffer` is a ceiling per stream, as `spawnSync` applies it.
    const collect = (into: Buffer[]): ((chunk: Buffer) => void) => {
      let size = 0;
      return (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) stop(Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }));
        else into.push(chunk);
      };
    };
    const finish = (status: number | null): void =>
      done({
        ...(ceiling === undefined ? {} : { error: ceiling }),
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    child.on('error', failed);
    child.on('exit', (status) => {
      // A ceiling hit ends the answer with the child: pipes a grandchild holds open must not hold it.
      if (ceiling !== undefined) failed(ceiling);
      else grace = setTimeout(() => finish(status), PIPE_GRACE_MS);
    });
    child.on('close', finish);
  });
}

/** The exit table applied to a finished child: the one mapping both renders share. */
function renderOutcome(child: ChildOutcome, timeoutMs: number): RenderResult {
  if (child.error !== undefined) {
    // Three failures arrive as an ERROR rather than an exit, and each names a
    // ceiling this seam owns. "The renderer threw" would send an adopter
    // reading a stack that does not exist for any of them.
    return { ok: false, reason: 'render-threw', detail: ceilingDetail(child.error, timeoutMs) };
  }

  const stderr = child.stderr.trim();
  const status = child.status;

  if (status === 0) {
    const out = child.stdout.trim();
    // The runner mutes host writes to stdout, so unparseable output means the
    // runner itself misbehaved — reported, never returned as a render.
    try {
      JSON.parse(out);
    } catch {
      // The stray bytes ARE the diagnosis — a host that writes to fd 1 directly
      // walks past the runner's muting, and naming what landed there is the
      // only way an adopter finds the line that did it.
      const stray = out === '' ? 'nothing was written' : `stdout carried ${JSON.stringify(clip(out, STRAY_EXCERPT))}`;
      return {
        ok: false,
        reason: 'render-threw',
        detail: `the renderer exited 0 without a parseable result — ${stray}${stderr === '' ? '' : `; stderr: ${stderr}`}`,
      };
    }
    const note = stderr
      .split('\n')
      .filter((line) => line.startsWith(NOTE_PREFIX))
      .map((line) => line.slice(NOTE_PREFIX.length))
      .join('; ');
    return note === '' ? { ok: true, result: out } : { ok: true, result: out, note };
  }

  const reason = (status === null ? undefined : REASONS[status]) ?? 'render-threw';
  return {
    ok: false,
    reason,
    detail: stderr === '' ? `the renderer exited ${status === null ? 'on a signal' : String(status)}` : stderr,
  };
}

/**
 * The runner's fifth argument, present only where the pointer shapes the
 * output or a send follows: a plain pointer keeps the four-argument call every
 * earlier render made.
 */
function runnerOptions(request: RenderRequest): string[] {
  if (request.frame === undefined && request.fill !== true && request.send === undefined) return [];
  return [
    JSON.stringify({
      ...(request.frame === undefined ? {} : { frame: request.frame }),
      ...(request.fill === true ? { fill: true } : {}),
      ...(request.send === undefined ? {} : { send: request.send }),
    }),
  ];
}

/**
 * The ONE props object a declared template is rendered with, for `email
 * verify`, `email render`, `email test` and `stet dev`'s email preview and
 * mount: the sample props the pointer declares, plus every slot's value under
 * its flattened name, with each `{{var}}` substituted from those same sample
 * props. `valueOf` answers a slot key's value: the snapshot's, a store's, or a
 * draft laid over either.
 *
 * The substitution is what reproduces the before: the original file
 * interpolated `props.name` into its markup, so the seeded `{{name}}` has to
 * become the same characters before the shell renders it.
 */
export function templateProps(
  name: string,
  entry: TemplateDef,
  valueOf: (key: string) => unknown,
): { values: Record<string, unknown> } | { missing: string } {
  const sample = entry.render?.sampleProps ?? {};
  const values: Record<string, unknown> = { ...sample };

  for (const slot of entry.slots) {
    const key = `${name}__${slot}`;
    const value = valueOf(key);
    if (value === undefined) {
      return { missing: `the slot ${JSON.stringify(slot)} resolves to no value (${key}) — seed it before verifying` };
    }
    if (typeof value !== 'string') {
      // A slot value is text. Passing a number or an object through renders
      // whatever it stringifies to, and the comparison then reports a byte
      // difference — a true sentence about the wrong problem, which sends the
      // reader looking for a copy edit nobody made.
      return {
        missing:
          `${key} resolved to ${shapeOf(value)}, not a string — fix the snapshot value; ` +
          'a slot that is not text cannot be compared as copy',
      };
    }
    let unresolved: string | null = null;
    const substituted = value.replace(VARIABLE, (whole: string, variable: string) => {
      // `Object.hasOwn`: `sampleProps` is JSON-parsed, so a bare lookup would
      // answer for `constructor` and hand the renderer a function.
      if (!Object.hasOwn(sample, variable)) {
        unresolved ??= variable;
        return whole;
      }
      return String((sample as Record<string, unknown>)[variable]);
    });
    if (unresolved !== null) {
      return {
        missing:
          `${key} seeds {{${unresolved}}}, which is not a member of this template's sampleProps — ` +
          'add it to the render pointer, or fix the placeholder',
      };
    }
    values[key] = substituted;
  }
  return { values };
}

/**
 * The subject a template's email carries when it has no map subject of its own:
 * the filled `subject` slot, else a declared `<name>__subject` key's resolved
 * value (a key that is not a slot has no variables to fill); null where
 * neither is text.
 */
export function slotSubject(
  name: string,
  entry: TemplateDef,
  descriptor: Descriptor,
  values: Record<string, unknown>,
  valueOf: (key: string) => unknown,
): string | null {
  const subjectKey = `${name}__subject`;
  const subject = entry.slots.includes('subject')
    ? values[subjectKey]
    : Object.hasOwn(descriptor.keys, subjectKey)
      ? valueOf(subjectKey)
      : undefined;
  return typeof subject === 'string' ? subject : null;
}

/** The pointer's request with the host send function and the message around it: `email test` and the dashboard's Test send. */
export function sendRequest(
  probe: RenderRequest,
  props: Record<string, unknown>,
  name: string,
  subject: string | null,
  send: { file: string; export: string; to: string },
): RenderRequest {
  return { ...probe, props, send: { file: send.file, export: send.export, message: { to: send.to, subject, template: name } } };
}

/** The render request a declared template's pointer makes, props supplied by the caller; null without a pointer. */
export function pointerRequest(
  hostDir: string,
  descriptor: Descriptor,
  name: string,
  props: Record<string, unknown>,
): RenderRequest | null {
  const templates = descriptor.templates ?? {};
  const pointer = Object.hasOwn(templates, name) ? templates[name]?.render : undefined;
  if (pointer === undefined) return null;
  return {
    hostDir,
    file: pointer.file,
    exportName: pointer.export,
    props,
    ...(pointer.frame === undefined ? {} : { frame: pointer.frame }),
    ...(pointer.fill === true ? { fill: true } : {}),
  };
}

/**
 * The first of a pointer's file, its frame's file and the send file that
 * resolves outside the project, or null. An existing file is judged on its real
 * path, so a symlink out of the project is outside; a missing one by where its
 * path points. Every caller that renders a pointer asks first, and runs
 * nothing of a pointer that escapes.
 */
export function containedPointer(cwd: string, pointer: RenderPointer, send?: { file: string }): string | null {
  const files = [pointer.file, ...(pointer.frame === undefined ? [] : [pointer.frame.file]), ...(send === undefined ? [] : [send.file])];
  for (const rel of files) {
    const abs = resolvePath(cwd, rel);
    if (existsSync(abs) ? realPathLeaves(cwd, abs) : leaves(cwd, abs)) return rel;
  }
  return null;
}

/** Whether `to` lies outside `from`: a path above it, or on another drive. */
function leaves(from: string, to: string): boolean {
  const rel = relative(from, to);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

/** `leaves` on real paths, so a symlink out of the project counts; a path that cannot be resolved is left to the caller's own read. */
function realPathLeaves(root: string, target: string): boolean {
  try {
    return leaves(realpathSync(root), realpathSync(target));
  } catch {
    return false;
  }
}

/** The line every surface refusing an escaping pointer file prints. */
export function outsideLine(file: string): string {
  return `${file} is outside the project — a render pointer names a file inside it`;
}

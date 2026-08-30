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

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { packageRoot } from './installed.js';
import type { CliIo } from './main.js';
import { clip } from './report.js';

/** Enough of a stray stdout write to recognize the line that produced it. */
const STRAY_EXCERPT = 200;

/** Why a render did not produce bytes. One per non-zero exit the runner names. */
export type RenderFailure =
  | 'export-not-function'
  | 'ts7-unsupported'
  | 'missing-dependency'
  | 'render-threw'
  | 'not-renderable';

export interface RenderRequest {
  /** The app package root — every import resolves from ITS `node_modules`. */
  hostDir: string;
  /** The module to render, absolute or resolvable from `hostDir`. */
  file: string;
  exportName: string;
  /** The one argument the export is called with. */
  props: Record<string, unknown>;
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
  3: 'ts7-unsupported',
  4: 'missing-dependency',
  5: 'render-threw',
  6: 'not-renderable',
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
function ceilingDetail(error: NodeJS.ErrnoException): string {
  if (error.code === 'ETIMEDOUT') {
    return (
      `the render did not finish within ${RENDER_TIMEOUT_MS / 1000}s and the child was killed — ` +
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

export function renderTemplate(io: CliIo, request: RenderRequest): RenderResult {
  const runner = join(packageRoot(), 'templates', 'email-runner.cjs');
  const child = spawnSync(
    process.execPath,
    [runner, request.hostDir, request.file, request.exportName, JSON.stringify(request.props)],
    {
      cwd: io.cwd,
      env: io.env,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      timeout: RENDER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );

  if (child.error !== undefined) {
    // Three failures arrive as an ERROR rather than an exit, and each names a
    // ceiling this seam owns. "The renderer threw" would send an adopter
    // reading a stack that does not exist for any of them.
    return { ok: false, reason: 'render-threw', detail: ceilingDetail(child.error as NodeJS.ErrnoException) };
  }

  const stderr = (child.stderr ?? '').trim();
  const status = child.status;

  if (status === 0) {
    const out = (child.stdout ?? '').trim();
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

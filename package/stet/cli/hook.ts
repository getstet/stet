/**
 * `stet hook install` — the opt-in pre-commit gate. It installs the shipped
 * `templates/pre-commit` (which runs `stet check` + `stet scan`) into git's
 * resolved hooks directory, EXECUTABLE, and refuses to clobber a differing one.
 *
 * Never automatic — only this command writes the hook, and `stet eject` removes
 * it. The hooks dir is resolved via `git rev-parse --git-path hooks`, not a
 * hard-coded `.git/hooks`: `.git` is a FILE in a worktree and `core.hooksPath`
 * can redirect, so a literal path throws ENOTDIR or writes a hook git ignores.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { noPositionals, parse, refuseEnv } from './args.js';
import { planWrite, writeExecutable } from './artifacts.js';
import { packageRoot } from './installed.js';
import type { CliIo } from './main.js';
import { CliError, Report } from './report.js';

export async function runHookInstall(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'hook install');
  const { positionals } = parse(args, {});
  noPositionals(positionals, 'hook install');
  const report = new Report();

  const dir = hooksDir(io.cwd);
  if (dir === null) {
    throw new CliError('hook install needs a git repository — run it inside one');
  }
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'pre-commit');
  const template = readFileSync(join(packageRoot(), 'templates', 'pre-commit'), 'utf8');

  // planWrite decides: a DIFFERING existing hook is a host edit — reported, never
  // clobbered; an identical one is a no-op; absent is the install.
  const plan = planWrite(hookPath, template, hookPath);
  if (plan.status === 'differs') {
    throw new CliError(
      `${hookPath} already exists and differs from the shipped hook — ` +
        'remove it (or merge in its "npx stet check" and "npx stet scan" lines) and re-run',
    );
  }
  if (plan.status === 'unchanged') {
    report.line(`${hookPath}: the stet pre-commit gate is already installed — no change`);
    return report.emit(io);
  }
  writeExecutable(hookPath, template);
  report.line(`installed the pre-commit gate at ${hookPath} — it runs stet check, then stet scan`);
  return report.emit(io);
}

/**
 * Git's hooks directory, worktree- and `core.hooksPath`-safe, resolved against
 * `cwd`. `null` when `cwd` is not a git repo. Shared with `eject`, which removes
 * the hook this command installs.
 */
export function hooksDir(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return isAbsolute(out) ? out : resolvePath(cwd, out);
  } catch {
    return null; // not a git repo
  }
}

/**
 * `stet hook install` — the opt-in pre-commit gate. It installs the shipped
 * `templates/pre-commit` into git's resolved hooks directory, EXECUTABLE, and
 * refuses to clobber a differing one.
 *
 * Git runs a hook from the top of the worktree that is committing, every
 * worktree of a repository shares one hooks folder, and one repository may
 * hold several checkouts (the website's `site/`). The hook is therefore one
 * fixed file that runs `templates/stet-gate.mjs`, copied into git's common
 * directory; the runner reads the checkouts from `stet-gate.json` beside it and
 * runs `stet check` + `stet scan` in each one of the committing worktree that
 * the commit touches, with the stet installed there. Nothing an install records
 * reaches a shell, and the gate never fetches a package. A hook stet did not
 * write joins the gate by one line.
 *
 * Never automatic — only this command writes the gate, and `stet eject` removes
 * it. The hooks dir is resolved via `git rev-parse --git-path hooks`, not a
 * hard-coded `.git/hooks`: `.git` is a FILE in a worktree and `core.hooksPath`
 * can redirect, so a literal path throws ENOTDIR or writes a hook git ignores.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { noPositionals, parse, refuseEnv } from './args.js';
import { writeExecutable, writeText } from './artifacts.js';
import { CONFIG_FILE } from './config.js';
import { packageRoot } from './installed.js';
import type { CliIo } from './main.js';
import { CliError, Report } from './report.js';

export async function runHookInstall(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'hook install');
  const { positionals } = parse(args, {});
  noPositionals(positionals, 'hook install');
  const report = new Report();

  const dir = hooksDir(io.cwd);
  const where = gateSite(io.cwd);
  if (dir === null || where === null) {
    throw new CliError('hook install needs a git repository — run it inside one');
  }
  // The gate runs check and scan in the folder it lists, so only a checkout's own folder is listed.
  if (!existsSync(join(io.cwd, CONFIG_FILE))) {
    throw new CliError('hook install runs in a stet checkout — cd to the folder that holds stet.config.json');
  }
  const top = worktreeTop(io.cwd);
  const inCommon = insideDir(dir, where.common);
  const shared = !inCommon && (top === null || !insideDir(dir, top));
  // The pre-commit that actually runs: under husky v9 it is `.husky/pre-commit`,
  // which the generated `.husky/_` stub hands over to.
  const theHook = operatorHook(dir);
  const hookPath = theHook.path;
  const hook = template('pre-commit');
  const held = !shared && existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;
  // A hook the operator owns — a hooks manager's folder inside the worktree
  // (husky's .husky/), or a pre-commit stet did not write — is never written;
  // the gate joins it through one line.
  const theirs = !inCommon || (held !== null && hookKind(held) === null);
  if (!shared && theirs && inCommon && held !== null && !held.includes(GATE_LINE)) {
    throw new CliError(`${hookPath} already exists and differs from the shipped hook — remove it and re-run, or add this line to it and re-run: ${GATE_LINE}`);
  }

  writeAtomic(join(where.common, GATE_RUNNER), template(GATE_RUNNER));
  // Read and written under the lock, so an install started beside this one in
  // another checkout keeps its entry too.
  const known = withGateLock(where.common, () => {
    const listed = readGate(where.common);
    const found = listed.some((entry) => entry.worktree === where.worktree && entry.checkout === where.checkout);
    writeGate(where.common, found ? listed : [...listed, { worktree: where.worktree, checkout: where.checkout }]);
    return found;
  });

  // A hooks folder outside both this repository's git directory and its
  // worktree (core.hooksPath) may be every repository's on the machine: stet
  // writes no hook there, and the line it offers does nothing in a repository
  // that has no gate.
  if (shared) {
    throw new CliError(
      `core.hooksPath points at ${dir}, which other repositories may share — add this line to the hook there by hand: ${SHARED_GATE_LINE}`,
    );
  }
  const covers = `it runs stet check, then stet scan, in ${label(where.checkout)} when a commit touches it`;
  if (theirs) {
    report.line(
      held !== null && held.includes(GATE_LINE)
        ? `${hookPath} runs the stet pre-commit gate — ${covers}`
        : theHook.husky
          ? `the stet pre-commit gate is ready; add this line to ${hookPath}, which husky runs from ${dir}: ${GATE_LINE}`
          : `the stet pre-commit gate is ready; add this line to ${hookPath}: ${GATE_LINE}`,
    );
    return report.emit(io);
  }
  if (held === hook && known) {
    report.line(`${hookPath}: the stet pre-commit gate is already installed for ${label(where.checkout)} — no change`);
    return report.emit(io);
  }
  mkdirSync(dir, { recursive: true });
  if (held !== hook) writeExecutable(hookPath, hook);
  report.line(
    `${held === HOOK_BEFORE_0_3_1 ? 'replaced the older gate with' : 'installed'} the pre-commit gate at ${hookPath} — ${covers}`,
  );
  return report.emit(io);
}

/**
 * `stet hook remove` — this checkout out of the pre-commit gate, and the gate
 * gone with the last one, through the same function `stet eject` runs. It
 * needs git and nothing else: a folder that is no longer a stet checkout, or
 * whose stet was uninstalled, is taken out the same way.
 */
export async function runHookRemove(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'hook remove');
  const { positionals } = parse(args, {});
  noPositionals(positionals, 'hook remove');
  const where = gateSite(io.cwd);
  if (hooksDir(io.cwd) === null || where === null) {
    throw new CliError('hook remove needs a git repository — run it inside one');
  }
  const report = new Report();
  if (!removeFromGate(io.cwd, true, report)) {
    report.line(`${label(where.checkout)} is not in the stet pre-commit gate — no change`);
  }
  return report.emit(io);
}

/**
 * Take this checkout out of the pre-commit gate; the last checkout out removes
 * the gate — the hook, its runner and its list. A hook stet did not write is
 * never clobbered: the entry still goes, the runner stays (it passes on an
 * empty list, so the line left in that hook cannot fail a commit), and the
 * report names the line to remove. `stet eject` and `stet hook remove` both
 * call it; it answers whether it had anything to do.
 */
export function removeFromGate(cwd: string, write: boolean, report: Report): boolean {
  const dir = hooksDir(cwd);
  const where = gateSite(cwd);
  if (dir === null || where === null) return false;
  const hook = operatorHook(dir).path;
  const listed = readGate(where.common);
  const rest = listed.filter((entry) => !(entry.worktree === where.worktree && entry.checkout === where.checkout));
  const listedHere = rest.length < listed.length;
  const takeOut = (): void => {
    report.line('remove this checkout from the stet pre-commit gate');
    if (!write) return;
    // Read again under the lock: another checkout may have joined since.
    withGateLock(where.common, () =>
      writeGate(
        where.common,
        readGate(where.common).filter((entry) => !(entry.worktree === where.worktree && entry.checkout === where.checkout)),
      ),
    );
  };
  if (rest.length > 0) {
    if (listedHere) takeOut();
    return listedHere;
  }
  const text = existsSync(hook) ? readFileSync(hook, 'utf8') : null;
  const kind = text === null ? null : hookKind(text);
  if (text !== null && kind === null) {
    if (listedHere) takeOut();
    const line = [SHARED_GATE_LINE, GATE_LINE].find((gate) => text.includes(gate));
    report.line(
      line !== undefined
        ? `remove this line from ${hook}: ${line}`
        : `${hook} differs from the shipped hook — remove its "stet check" and "stet scan" lines by hand`,
    );
    return true;
  }
  if (kind === null && listed.length === 0) return false;
  report.line('remove the stet pre-commit hook');
  if (!write) return true;
  if (kind !== null) rmSync(hook);
  rmSync(join(where.common, GATE_LIST), { force: true });
  rmSync(join(where.common, GATE_RUNNER), { force: true });
  return true;
}

/** The hook 0.3.0 and earlier shipped: a bare `npx stet`, run from the top of the repository. */
export const HOOK_BEFORE_0_3_1 =
  "#!/bin/sh\n# stet pre-commit gate — installed by `stet hook install`, removed by `stet eject`.\n# `check` blocks a commit on a broken descriptor/snapshot. `scan` warns about\n# unkeyed copy without blocking by default; with scan.severity: \"fail\" in\n# stet.config.json it exits non-zero and blocks the commit too — the opted-in\n# strict gate, which is correct when a project has chosen it.\nnpx stet check || exit 1\nnpx stet scan\n";

/** The one line a hook stet does not write adds to run the gate, quoted for sh. */
export const GATE_LINE = 'node "$(git rev-parse --git-common-dir)/stet-gate.mjs" "$@" || exit 1';

/** The gate line for a hooks folder other repositories share: it does nothing in a repository with no gate. */
export const SHARED_GATE_LINE =
  'f="$(git rev-parse --git-common-dir)/stet-gate.mjs"; [ ! -f "$f" ] || node "$f" "$@" || exit 1';

/** The runner the hook executes and the list it reads, both in git's common directory. */
export const GATE_RUNNER = 'stet-gate.mjs';
export const GATE_LIST = 'stet-gate.json';

/** One checkout the gate covers: its worktree's git dir under the common one ('' for the main worktree) and its folder under that worktree's top ('' at the top). */
export interface GateEntry {
  worktree: string;
  checkout: string;
}

const git = (cwd: string, args: string[]): string =>
  // Only the trailing newline goes: a folder name may begin or end with a space.
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');

/** Where the checkout at `cwd` sits: git's common directory, its worktree, and its folder under that worktree's top. */
export function gateSite(cwd: string): { common: string; worktree: string; checkout: string } | null {
  try {
    const common = realpathSync(resolvePath(cwd, git(cwd, ['rev-parse', '--git-common-dir'])));
    const here = realpathSync(resolvePath(cwd, git(cwd, ['rev-parse', '--git-dir'])));
    const checkout = git(cwd, ['rev-parse', '--show-prefix']).replace(/\/$/, '');
    return { common, worktree: relative(common, here), checkout };
  } catch {
    return null; // not a git repo
  }
}

/**
 * The gate's live entries; empty where there is none. An entry whose worktree
 * git has since removed is dropped, so a pruned worktree neither keeps the gate
 * alive nor hands its entry to a new worktree of the same name. A list that
 * does not parse is refused, never overwritten.
 */
export function readGate(common: string): GateEntry[] {
  const path = join(common, GATE_LIST);
  if (!existsSync(path)) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8')).entries;
    if (!Array.isArray(entries)) throw new Error('entries is not a list');
  } catch (error) {
    throw new CliError(`${path} does not parse (${(error as Error).message}) — fix or remove it and re-run`);
  }
  return entries.filter(
    (entry): entry is GateEntry =>
      typeof entry?.worktree === 'string' &&
      typeof entry?.checkout === 'string' &&
      existsSync(join(common, entry.worktree)),
  );
}

/** The list, replaced whole: a commit reading it meanwhile sees the old list or the new one, never half of one. */
export function writeGate(common: string, entries: GateEntry[]): void {
  writeAtomic(join(common, GATE_LIST), `${JSON.stringify({ entries: entries.map(({ checkout, worktree }) => ({ checkout, worktree })) }, null, 2)}\n`);
}

/**
 * Run `fn` holding the gate list's lock. Two installs or ejects started
 * together would otherwise each read the list before the other wrote it, and
 * one checkout's entry would be lost. A lock older than ten seconds was left
 * by a process that died holding it, and is broken.
 */
export function withGateLock<T>(common: string, fn: () => T): T {
  const lock = join(common, `${GATE_LIST}.lock`);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) {
        throw new CliError(`${lock} is held by another stet hook install or eject — wait for it to finish, or remove the file if none is running`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Written beside, then renamed over: a reader never sees a half-written file. */
function writeAtomic(path: string, text: string): void {
  const beside = `${path}.${process.pid}.tmp`;
  writeText(beside, text);
  renameSync(beside, path);
}

/**
 * The pre-commit that runs from hooks folder `dir`. Husky v9 points
 * `core.hooksPath` at its generated, gitignored `.husky/_`, whose `pre-commit`
 * is a stub that sources `h`, and `h` runs the operator's `.husky/pre-commit`
 * and exits: a line added to the stub never runs, and the next `npm install`
 * regenerates it.
 */
export function operatorHook(dir: string): { path: string; husky: boolean } {
  const ignore = join(dir, '.gitignore');
  const husky =
    basename(dir) === '_' && existsSync(join(dir, 'h')) && existsSync(ignore) && readFileSync(ignore, 'utf8').trim() === '*';
  return husky ? { path: join(dirname(dir), 'pre-commit'), husky } : { path: join(dir, 'pre-commit'), husky };
}

/** The shipped hook, or 'older' for the one 0.3.0 and earlier wrote; null for any other hook. */
export function hookKind(text: string): 'this' | 'older' | null {
  if (text === template('pre-commit')) return 'this';
  return text === HOOK_BEFORE_0_3_1 ? 'older' : null;
}

function template(name: string): string {
  return readFileSync(join(packageRoot(), 'templates', name), 'utf8');
}

const label = (checkout: string): string => (checkout === '' ? 'the repository root' : `${checkout}/`);

export function worktreeTop(cwd: string): string | null {
  try {
    return realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  } catch {
    return null; // a bare repository has no worktree
  }
}

export function insideDir(path: string, dir: string): boolean {
  const at = relative(dir, existsSync(path) ? realpathSync(path) : path);
  return at === '' || (!at.startsWith('..') && !isAbsolute(at));
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

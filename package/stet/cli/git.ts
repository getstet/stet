/**
 * Git, called with argument arrays.
 *
 * The local dashboard's commit and push are the first callers that run git on
 * the operator's behalf rather than reading a fact out of it, so the invocation
 * lives in one place: an argument array (never a shell string, so a branch or a
 * commit message can carry anything), the server's own environment MINUS the
 * run token, prompting disabled, and stdout and stderr merged — a hook's output
 * and git's own refusal arrive on different channels and the reader needs both.
 *
 * `gitData` is the data-returning variant beside it: stdout alone, because a
 * status list or a file's bytes at HEAD is corrupted by a merged stream. The
 * dashboard's two reads over it — the uncommitted forms and the sequencer
 * check — are its first consumers. The four ad hoc `execFileSync` calls
 * elsewhere (`email verify`'s `show`, `email extract`'s `ls-files -z`,
 * `hooksDir` and the `check-ignore` probe) still wait to move onto it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { hooksDir } from './hook.js';
import { childEnv } from './workspace.js';

/** Long enough for a pre-commit hook that runs a real check; short enough that a hung git is not a hung server. */
const GIT_TIMEOUT_MS = 60_000;

/** How long a timed-out git group has to end on SIGTERM before SIGKILL follows. */
const KILL_GRACE_MS = 2_000;

/** How long the pipes have to flush after git itself exits, when something else still holds them. */
const PIPE_FLUSH_MS = 100;

/**
 * One git run in a checkout. Never throws on git's own failure: the exit code
 * and the output are the answer, because every caller here reports them rather
 * than dying on them.
 */
export function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // The server's own environment, minus the run token: a hook is a shell
    // script the operator's repo supplies, and a hook holding the dashboard's
    // API credential holds the whole API. Never the SITE's `.env` map — git
    // needs the operator's own credential helpers, and a site's map never
    // enters this process.
    env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' },
    timeout: GIT_TIMEOUT_MS,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // A spawn that never ran (git absent, timeout) has a null code; its `error`
  // message is the only thing the caller can show.
  if (result.error !== undefined) return { code: 1, out: `${out}${result.error.message}` };
  return { code: result.status ?? 1, out };
}

/**
 * One git read whose answer is DATA: stdout alone, never merged with stderr,
 * so a warning git prints cannot land inside a status list or a file's bytes.
 * Never throws; a spawn that never ran answers code 1 and nothing.
 */
export function gitData(cwd: string, args: string[]): { code: number; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // No optional lock: a status read on every site load must not take
    // `index.lock` from the operator's own terminal.
    env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    timeout: GIT_TIMEOUT_MS,
    // A snapshot read at HEAD is the largest answer; the default 1 MiB cap would cut it.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) return { code: 1, stdout: '' };
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
}

/**
 * The paths under `pathspecs` that differ from HEAD — staged, unstaged or
 * untracked — relative to `cwd`, sorted. A deletion is left out, since it is
 * the terminal's to commit, and so is an unmerged path, which is a merge's.
 *
 * Porcelain paths are relative to the repository's top whatever the working
 * directory, so the checkout's own prefix (`site/` where the checkout is a
 * folder of its repository) is stripped; the pathspecs themselves are read
 * relative to `cwd`. A directory that is not a repository answers nothing.
 */
export function uncommittedPaths(cwd: string, pathspecs: string[]): string[] {
  const prefix = gitData(cwd, ['rev-parse', '--show-prefix']);
  if (prefix.code !== 0) return [];
  const base = prefix.stdout.trim();
  const status = gitData(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs]);
  if (status.code !== 0) return [];
  const records = status.stdout.split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    // A rename or a copy, in either column, carries its source path as the NEXT record.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1;
    // A deletion is the terminal's to commit, and an unmerged path is a merge's.
    if (x === 'D' || y === 'D' || x === 'U' || y === 'U' || (x === 'A' && y === 'A')) continue;
    const path = record.slice(3);
    if (path.startsWith(base)) paths.add(path.slice(base.length));
  }
  return [...paths].sort();
}

/**
 * Whether git is part-way through a merge, a cherry-pick, a revert or a
 * rebase, read from its own sequencer state. A commit of named files then
 * either stages them into that operation's index or, mid-rebase, lands inside
 * it; both are the terminal's to finish. `sequencer/` outlives `CHERRY_PICK_HEAD`
 * between the picks of a multi-commit cherry-pick or revert, and `SQUASH_MSG`
 * holds a `merge --squash` the operator has not committed yet, which a commit
 * here would consume.
 */
export function operationInProgress(cwd: string): boolean {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (gitData(cwd, ['rev-parse', '-q', '--verify', ref]).code === 0) return true;
  }
  for (const dir of ['rebase-merge', 'rebase-apply', 'sequencer', 'SQUASH_MSG']) {
    const path = gitData(cwd, ['rev-parse', '--git-path', dir]);
    if (path.code === 0 && existsSync(resolvePath(cwd, path.stdout.trim()))) return true;
  }
  return false;
}

/**
 * Where a checkout stands: its short HEAD, its branch, and whether anything is
 * uncommitted. Every badge the dashboard paints names the commit it was
 * measured against, so this rides every reply that measured something.
 *
 * A directory that is not a git repository answers all-null rather than
 * throwing — a workspace entry may legitimately be one, and the listing says so
 * rather than dying on it. `hooksDir` is the repo test, already resolved
 * worktree- and `core.hooksPath`-safe.
 */
export function gitState(cwd: string): { head: string | null; branch: string | null; dirty: boolean } {
  if (hooksDir(cwd) === null) return { head: null, branch: null, dirty: false };
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Through the data read, without the optional lock: this runs on every site
  // load, and a status that refreshes the index takes `index.lock` from the
  // operator's own terminal.
  const status = gitData(cwd, ['status', '--porcelain']);
  return {
    // An unborn HEAD is a repo with no commit yet: `rev-parse` fails and the
    // stamp is honestly absent rather than invented.
    head: head.code === 0 ? head.out.trim() : null,
    branch: branch.code === 0 ? branch.out.trim() : null,
    dirty: status.code === 0 && status.stdout.trim() !== '',
  };
}

/**
 * The same run, asynchronous.
 *
 * `spawnSync` blocks the event loop, and the dashboard is a server: a
 * pre-commit hook that runs a real check, or a push to a slow remote, would
 * freeze the page, every other checkout and every unrelated route for as long
 * as git took. The per-site queue does not help — it serialises one site's
 * requests, not the whole process. The two calls that can run for minutes go
 * through here; the three fast reads `gitState` makes stay synchronous, where
 * a promise per call would cost more than it saves.
 *
 * Same contract as `git`: never throws on git's own failure, stdout and stderr
 * merged in arrival order, the run token out of the child's environment. The
 * deadline is an argument so a fixture can reach it in a second; the two
 * callers take the default.
 */
export function gitRun(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let flush: NodeJS.Timeout | undefined;
    const done = (code: number, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (flush !== undefined) clearTimeout(flush);
      resolve({ code, out: `${out}${extra}` });
    };
    const child = spawn('git', args, {
      cwd,
      env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so the deadline can signal the hook git spawned
      // as well as git itself. A hook left running after git is gone holds the
      // repository against the operator's own terminal.
      detached: true,
    });
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      // TERM first and to the whole group: git removes `.git/index.lock` on
      // TERM and dies holding it on KILL, which wedges the repository for
      // every later commit from anywhere. KILL is the fallback for a group
      // that ignores TERM, and it is unref'd because the answer has already
      // gone back by then.
      signalGroup('SIGTERM');
      const hard = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      hard.unref();
      done(1, `git timed out after ${timeoutMs / 1000}s`);
    }, timeoutMs);
    // One string in arrival order: a hook writes to stdout and git refuses on
    // stderr, and the reader needs to see them interleaved as they happened.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.on('data', (chunk: string) => (out += chunk));
    child.on('error', (error) => done(1, error.message));
    // `close` waits for the pipes, which anything the hook backgrounded can
    // hold open long past git's own exit — a commit that landed would then be
    // reported as a timeout. It stays the fast path; `exit` settles a moment
    // later with the same code where the pipes outlive the process.
    child.on('close', (code) => done(code ?? 1));
    child.on('exit', (code) => {
      flush = setTimeout(() => done(code ?? 1), PIPE_FLUSH_MS);
    });
  });
}

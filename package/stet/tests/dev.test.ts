/**
 * `stet dev` — the local dashboard's server, its workspace and its git calls.
 *
 * The handler is a `Request → Response` function, so every route case here
 * calls it directly with a `Request` and no socket is opened: the suite's
 * offline guard replaces `fetch`, `http.request` and `http.get`, and a server
 * proven only over sockets could not be proven here at all. The three cases
 * that DO need a socket — the bind address, the Host check through the adapter,
 * and the page's own headers — use `node:net`, which the guard does not touch.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { createStetHandler } from '../server/mount.js';
import type { StoreAdapter } from '../src/store.js';
import { closeFrames, frame as frameAgent, tick, type Framed } from './helpers/preview-frame.js';
import { cleanupCliHosts, fakeFetch, htmlFixture, makeCliHost, makeHtmlHost, type CliHost } from '../conformance/cli-host.js';
import { cleanupEmailHosts, makeEmailHost } from './helpers/email-host.js';
import { handlerOver, NONCE, paintPage, req, TOKEN, type PaintedPage } from './helpers/dashboard-page.js';
import { cleanupOutsideFiles, linkOut, outsideFile, previewHost, SNAPSHOT, type PreviewHost } from './helpers/email-preview-host.js';
import { runtimeImportClosure } from './helpers/source-roster.js';
import { builtBinExists, installStetShim } from './helpers/stet-shim.js';
import { writeJsonDeterministic } from '../cli/artifacts.js';
import { check } from '../cli/check.js';
import { mountRenderer, mountSender } from '../cli/email-preview.js';
import { loadConfig } from '../cli/config.js';
import { planDocuments } from '../cli/html-host.js';
import { HEAD_KINDS, kindOf } from '../cli/key-names.js';
import { Report } from '../cli/report.js';
import {
  captured,
  createDevHandler,
  importsLazily,
  githubRepoOf,
  previewOfSummary,
  stopEveryChild,
  withEnvFilesHint,
  type DevContext,
} from '../cli/dev-routes.js';
import { packageRoot } from '../cli/installed.js';
import { dashboardPage, runDev, startDevServer, type DevServerHandle } from '../cli/dev.js';
import { git, gitData, gitRun, gitState, operationInProgress, pushRemoteOf, uncommittedPaths } from '../cli/git.js';
import { runHookInstall } from '../cli/hook.js';
import { gone } from '../cli/liveness.js';
import { runCli, type CliIo } from '../cli/main.js';
import { loadTypescript } from '../cli/source-scan.js';
import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { loadDescriptor, loadSnapshot, resolve } from '../src/index.js';
import { derivedText } from '../src/resolve.js';
import { pageSpan } from '../src/preview.js';
import { PLACEHOLDER } from '../src/validate.js';
import type { Descriptor } from '../src/types.js';
import {
  addSite,
  baseEnv,
  childEnv,
  connectionEnv,
  connectionNames,
  devDefaults,
  loadSite,
  parseEnvText,
  readWorkspace,
  removeSite,
  routerPreviewCommand,
  siteChildEnv,
  siteEnv,
  siteId,
  siteIo,
  updateSite,
  workspacePath,
  writeWorkspace,
  type WorkspaceEntry,
} from '../cli/workspace.js';

afterAll(cleanupCliHosts);
afterAll(cleanupEmailHosts);
afterAll(cleanupOutsideFiles);

/** A temp directory that is not a checkout — for the paths a rule has to refuse. */
function tempDir(prefix = 'stet-dev-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A workspace file path inside a fresh temp directory. */
function workspaceFile(): string {
  return join(tempDir('stet-ws-'), 'projects.json');
}

/** A host turned into a git checkout with one commit, through `cli/git.ts` itself. */
function gitInit(cwd: string): void {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'dev@test']);
  git(cwd, ['config', 'user.name', 'dev']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'base']);
}

/** A bare repository added to `cwd` as the remote `name`; answers its path. */
function bareRemote(cwd: string, name: string): string {
  const bare = tempDir('stet-bare-');
  git(bare, ['init', '-q', '--bare']);
  git(cwd, ['remote', 'add', name, bare]);
  return bare;
}

/** The mini project as a committed git checkout. */
function gitHost(opts: Parameters<typeof makeCliHost>[0] = {}): CliHost {
  const host = makeCliHost(opts);
  gitInit(host.cwd);
  return host;
}

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * A pid a fixture's own hook wrote, waited for.
 *
 * Under a loaded suite git can take a second to fork the hook at all, so a
 * deadline that fires first leaves no pid to poll and the case fails for a
 * reason that has nothing to do with the signal it is about.
 */
async function pidFrom(file: string, ms = 2_500): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (text !== '') return Number(text);
    } catch {
      /* the hook has not started yet */
    }
    if (Date.now() >= deadline) throw new Error(`the hook never started: ${file} was not written`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Whether a path is gone, polled: a signal handler's unlink is not instant. */
async function waitUnlinked(file: string, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!existsSync(file)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('git', () => {
  it('reports a checkout head, branch and clean tree, and null on a non-repo', () => {
    const host = gitHost();
    const state = gitState(host.cwd);
    expect(state.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(state.branch).not.toBeNull();
    expect(state.dirty).toBe(false);

    writeFileSync(join(host.cwd, 'notes.txt'), 'stray\n', 'utf8');
    expect(gitState(host.cwd).dirty).toBe(true);

    expect(gitState(tempDir())).toEqual({
      head: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      detached: false,
    });
  });

  it('reads the head as seven hex digits, an unborn branch as null', () => {
    const host = gitHost();
    expect(gitState(host.cwd).head).toMatch(/^[0-9a-f]{7}$/);
    const unborn = tempDir();
    git(unborn, ['init', '-q']);
    expect(gitState(unborn)).toMatchObject({ head: null, upstream: null, ahead: 0 });
  });

  it('reads the upstream and the ahead count, and a pruned or absent upstream as none', () => {
    const host = gitHost();
    const bare = bareRemote(host.cwd, 'origin');
    const branch = gitState(host.cwd).branch as string;
    // A branch with no upstream.
    expect(gitState(host.cwd)).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
    expect(git(host.cwd, ['push', '-q', '-u', 'origin', branch]).code).toBe(0);
    expect(gitState(host.cwd)).toMatchObject({ upstream: `origin/${branch}`, ahead: 0, behind: 0 });
    // One commit ahead.
    writeFileSync(join(host.cwd, 'notes.txt'), 'ahead\n', 'utf8');
    git(host.cwd, ['add', '--', 'notes.txt']);
    git(host.cwd, ['commit', '-qm', 'ahead']);
    expect(gitState(host.cwd)).toMatchObject({ upstream: `origin/${branch}`, ahead: 1, behind: 0 });
    // The upstream deleted on the remote and pruned: git still names it, with no count.
    git(bare, ['branch', '-D', branch]);
    git(host.cwd, ['fetch', '-q', '--prune', 'origin']);
    expect(gitState(host.cwd)).toMatchObject({ upstream: null, ahead: 0 });
  });

  it('reads a detached HEAD as no branch', () => {
    const host = gitHost();
    git(host.cwd, ['checkout', '-q', '--detach']);
    expect(gitState(host.cwd)).toMatchObject({ branch: null, detached: true });
    expect(gitState(host.cwd).head).toMatch(/^[0-9a-f]{7}$/);
  });

  it('chooses the push remote in git’s own order', () => {
    const host = gitHost();
    const branch = gitState(host.cwd).branch as string;
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ error: 'this checkout has no remote' });
    bareRemote(host.cwd, 'up');
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ remote: 'up' });
    bareRemote(host.cwd, 'other');
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ error: `several remotes and none chosen for ${branch}: other, up` });
    bareRemote(host.cwd, 'origin');
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ remote: 'origin' });
    git(host.cwd, ['config', `branch.${branch}.remote`, 'origin']);
    git(host.cwd, ['config', 'remote.pushDefault', 'other']);
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ remote: 'other' });
    git(host.cwd, ['config', `branch.${branch}.pushRemote`, 'up']);
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ remote: 'up' });
  });

  it('reads a branch tracking a local branch (branch.<b>.remote is .) as choosing no remote', () => {
    const host = gitHost();
    const branch = gitState(host.cwd).branch as string;
    git(host.cwd, ['checkout', '-qb', 'feature', '--track', branch]);
    expect(git(host.cwd, ['config', '--get', 'branch.feature.remote']).out.trim()).toBe('.');
    expect(pushRemoteOf(host.cwd, 'feature')).toEqual({ error: 'this checkout has no remote' });
    bareRemote(host.cwd, 'origin');
    expect(pushRemoteOf(host.cwd, 'feature')).toEqual({ remote: 'origin' });
  });

  it('names the remotes a and b when neither is chosen', () => {
    const host = gitHost();
    const branch = gitState(host.cwd).branch as string;
    bareRemote(host.cwd, 'a');
    bareRemote(host.cwd, 'b');
    expect(pushRemoteOf(host.cwd, branch)).toEqual({ error: `several remotes and none chosen for ${branch}: a, b` });
  });

  it('ends a timed-out git and the hook it spawned, and leaves no lock behind', async () => {
    // SIGKILL cannot be caught, so git dies holding `.git/index.lock` and the
    // repository is wedged for the operator's own terminal too. The hook here
    // ignores TERM itself, which is why the signal goes to the whole group.
    const host = gitHost();
    const hooks = join(host.cwd, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\ntrap '' TERM\necho $$ > ${JSON.stringify(join(host.cwd, 'hook.pid'))}\nsleep 20\n`,
      { mode: 0o755 },
    );
    write(host.cwd, 'content/keys.ts', `${host.file('content/keys.ts')}\n// an edit to commit\n`);

    const started = Date.now();
    const running = gitRun(host.cwd, ['commit', '-m', 'held', '--', 'content/keys.ts'], 3_000);
    const hookPid = await pidFrom(join(host.cwd, 'hook.pid'));
    const timedOut = await running;
    expect(timedOut.code).toBe(1);
    expect(timedOut.out).toContain('git timed out after 3s');
    expect(Date.now() - started).toBeLessThan(8_000);

    expect(await waitGone(hookPid)).toBe(true);
    expect(await waitUnlinked(join(host.cwd, '.git/index.lock'))).toBe(true);

    // The proof the repository is usable again: the same commit, hook removed.
    rmSync(join(hooks, 'pre-commit'));
    const landed = await gitRun(host.cwd, ['commit', '-m', 'after the timeout', '--', 'content/keys.ts']);
    expect(landed.code).toBe(0);
    expect(git(host.cwd, ['log', '-1', '--format=%s']).out.trim()).toBe('after the timeout');
  }, 30_000);

  it('answers on git’s own exit, not on pipes a hook left open', async () => {
    // A hook that starts a watcher, an agent or anything else in the background
    // hands it git's stdout, so the pipes outlive git by however long that runs
    // — and a commit that LANDED would be reported as a timeout.
    const host = gitHost();
    const hooks = join(host.cwd, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\nsleep 20 &\necho $! > ${JSON.stringify(join(host.cwd, 'bg.pid'))}\necho hook done\nexit 0\n`,
      { mode: 0o755 },
    );
    write(host.cwd, 'content/keys.ts', `${host.file('content/keys.ts')}\n// an edit to commit\n`);

    const started = Date.now();
    const made = await gitRun(host.cwd, ['commit', '-m', 'the hook backgrounded a watcher', '--', 'content/keys.ts'], 6_000);
    expect(made.code).toBe(0);
    expect(made.out).toContain('hook done');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(git(host.cwd, ['log', '-1', '--format=%s']).out.trim()).toBe('the hook backgrounded a watcher');

    const background = Number(readFileSync(join(host.cwd, 'bg.pid'), 'utf8').trim());
    try {
      process.kill(background, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 30_000);

  it('never hands the run token to a hook', () => {
    const host = gitHost();
    // A hook is a shell script the repo supplies. Exiting 1 keeps the run
    // observable — the output is returned and nothing is committed.
    const hooks = join(host.cwd, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "token=${STET_DEV_TOKEN-unset}"\nexit 1\n', { mode: 0o755 });

    process.env['STET_DEV_TOKEN'] = 'the-run-token';
    try {
      writeFileSync(join(host.cwd, 'notes.txt'), 'stray\n', 'utf8');
      git(host.cwd, ['add', '--', 'notes.txt']);
      const result = git(host.cwd, ['commit', '-m', 'x', '--', 'notes.txt']);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain('token=unset');
      expect(result.out).not.toContain('the-run-token');
    } finally {
      delete process.env['STET_DEV_TOKEN'];
    }
  });
});

/** The snapshot's first key set to `value` — one line, so two branches setting it conflict. */
function setHeadline(cwd: string, value: string): void {
  const file = join(cwd, 'content/defaults.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
  snapshot.default['hero_headline'] = value;
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/**
 * A checkout left part-way through a git operation, the snapshot in conflict:
 * a merge, a cherry-pick or a revert that stopped on it, or a rebase stopped
 * by `edit` with nothing in conflict at all.
 */
function midOperation(kind: 'merge' | 'cherry-pick' | 'revert' | 'rebase', host: CliHost = gitHost()): CliHost {
  const cwd = host.cwd;
  const base = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  if (kind === 'rebase') {
    setHeadline(cwd, 'One');
    git(cwd, ['commit', '-qam', 'one']);
    const stopped = git(cwd, ['-c', 'sequence.editor=sed -i.orig 1s/^pick/edit/', 'rebase', '-i', 'HEAD~1']);
    expect(stopped.code, stopped.out).toBe(0);
    return host;
  }
  if (kind === 'revert') {
    setHeadline(cwd, 'One');
    git(cwd, ['commit', '-qam', 'one']);
    setHeadline(cwd, 'Two');
    git(cwd, ['commit', '-qam', 'two']);
    expect(git(cwd, ['revert', '--no-edit', 'HEAD~1']).code).not.toBe(0);
    return host;
  }
  git(cwd, ['checkout', '-qb', 'theirs']);
  setHeadline(cwd, 'Theirs');
  git(cwd, ['commit', '-qam', 'theirs']);
  git(cwd, ['checkout', '-q', base]);
  setHeadline(cwd, 'Ours');
  git(cwd, ['commit', '-qam', 'ours']);
  const stopped = kind === 'merge' ? git(cwd, ['merge', 'theirs']) : git(cwd, ['cherry-pick', 'theirs']);
  expect(stopped.code).not.toBe(0);
  return host;
}

/** A repository whose checkout is its `site/` folder, holding the mini host, committed. */
function subfolderHost(): { top: string; cwd: string } {
  const top = tempDir('stet-top-');
  const host = snapshotHost();
  const cwd = join(top, 'site');
  cpSync(host.cwd, cwd, { recursive: true, filter: (src) => !src.split('/').includes('.git') });
  gitInit(top);
  return { top: realpathSync(top), cwd: realpathSync(cwd) };
}

describe('git — the reads that return data', () => {
  it('lists the modified, staged and untracked paths under the pathspecs, and never a deletion', () => {
    const host = gitHost();
    setHeadline(host.cwd, 'Modified');
    write(host.cwd, 'content/keys.ts', `${host.file('content/keys.ts')}\n// staged\n`);
    git(host.cwd, ['add', 'content/keys.ts']);
    write(host.cwd, 'content/extra.json', '{}\n');
    rmSync(join(host.cwd, 'content/stet-env.d.ts'));
    write(host.cwd, 'notes.txt', 'outside\n');
    expect(uncommittedPaths(host.cwd, ['content'])).toEqual([
      'content/defaults.json',
      'content/extra.json',
      'content/keys.ts',
    ]);
  });

  it('reads a rename as its new path, in either column', () => {
    const staged = gitHost();
    git(staged.cwd, ['mv', 'content/keys.ts', 'content/registry.ts']);
    expect(git(staged.cwd, ['status', '--porcelain']).out).toContain('R  content/keys.ts -> content/registry.ts');
    expect(uncommittedPaths(staged.cwd, ['content'])).toEqual(['content/registry.ts']);

    // Moved in the worktree and added with intent: git prints ` R new\0old\0`,
    // the R in the second column.
    const moved = gitHost();
    write(moved.cwd, 'page.html', '<p>A page.</p>\n');
    git(moved.cwd, ['add', 'page.html']);
    git(moved.cwd, ['commit', '-qm', 'page']);
    writeFileSync(join(moved.cwd, 'about.html'), readFileSync(join(moved.cwd, 'page.html')));
    rmSync(join(moved.cwd, 'page.html'));
    git(moved.cwd, ['add', '-N', 'about.html']);
    expect(gitData(moved.cwd, ['status', '--porcelain=v1', '-z']).stdout).toBe(' R about.html\0page.html\0');
    expect(uncommittedPaths(moved.cwd, ['.'])).toEqual(['about.html']);
  });

  it('leaves an unmerged path to the merge', () => {
    const host = midOperation('merge');
    expect(git(host.cwd, ['status', '--porcelain']).out).toContain('UU content/defaults.json');
    expect(uncommittedPaths(host.cwd, ['content'])).toEqual([]);
  });

  it('answers nothing outside a repository', () => {
    expect(uncommittedPaths(tempDir(), ['.'])).toEqual([]);
  });

  it('names a subfolder checkout’s paths relative to the checkout, not the repository', () => {
    const { top, cwd } = subfolderHost();
    setHeadline(cwd, 'In the subfolder');
    expect(git(top, ['status', '--porcelain']).out).toContain(' M site/content/defaults.json');
    expect(uncommittedPaths(cwd, ['content/defaults.json'])).toEqual(['content/defaults.json']);
  });

  it('reads a file at HEAD from a subfolder whole, with git’s warnings kept off stdout', () => {
    const { top, cwd } = subfolderHost();
    const committed = readFileSync(join(cwd, 'content/defaults.json'));
    setHeadline(cwd, 'Not yet committed');
    const read = gitData(cwd, ['show', 'HEAD:./content/defaults.json']);
    expect(read.code).toBe(0);
    expect(Buffer.from(read.stdout, 'utf8')).toEqual(committed);

    // A branch and a tag of one name: git warns the name is ambiguous, on
    // stderr, and answers anyway.
    git(top, ['branch', 'twice']);
    git(top, ['tag', 'twice']);
    expect(git(cwd, ['show', 'twice:./content/defaults.json']).out).toContain("warning: refname 'twice' is ambiguous");
    const warned = gitData(cwd, ['show', 'twice:./content/defaults.json']);
    expect(warned.code).toBe(0);
    expect(Buffer.from(warned.stdout, 'utf8')).toEqual(committed);
  });

  it('knows a cherry-pick between its picks, and a squash merge not yet committed', () => {
    // Two picks, the first in conflict and committed by hand: CHERRY_PICK_HEAD
    // is gone, and the sequence still waits on `--continue`.
    const host = gitHost();
    const cwd = host.cwd;
    const base = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
    git(cwd, ['checkout', '-qb', 'theirs']);
    setHeadline(cwd, 'Theirs');
    git(cwd, ['commit', '-qam', 'a']);
    write(cwd, 'notes.txt', 'b\n');
    git(cwd, ['add', 'notes.txt']);
    git(cwd, ['commit', '-qm', 'b']);
    git(cwd, ['checkout', '-q', base]);
    setHeadline(cwd, 'Ours');
    git(cwd, ['commit', '-qam', 'ours']);
    expect(git(cwd, ['cherry-pick', 'theirs~1', 'theirs']).code).not.toBe(0);
    git(cwd, ['checkout', '--theirs', '--', 'content/defaults.json']);
    git(cwd, ['add', 'content/defaults.json']);
    expect(git(cwd, ['commit', '-qm', 'a resolved']).code).toBe(0);
    expect(git(cwd, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).code).not.toBe(0);
    expect(operationInProgress(cwd)).toBe(true);

    // `merge --squash` stages the branch and leaves SQUASH_MSG, with no MERGE_HEAD.
    const squash = gitHost();
    const main = git(squash.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
    git(squash.cwd, ['checkout', '-qb', 'feature']);
    write(squash.cwd, 'notes.txt', 'feature\n');
    git(squash.cwd, ['add', 'notes.txt']);
    git(squash.cwd, ['commit', '-qm', 'feature']);
    git(squash.cwd, ['checkout', '-q', main]);
    expect(git(squash.cwd, ['merge', '--squash', 'feature']).code).toBe(0);
    expect(git(squash.cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code).not.toBe(0);
    expect(operationInProgress(squash.cwd)).toBe(true);
  });

  it('reads the status and the site without writing the index, so the terminal keeps index.lock', async () => {
    const host = gitHost();
    const index = join(host.cwd, '.git/index');
    // A tracked file whose stat no longer matches the index: a status allowed
    // to refresh the index would rewrite it.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(host.cwd, 'content/defaults.json'), later, later);
    const old = new Date(2000, 0, 1);
    utimesSync(index, old, old);
    uncommittedPaths(host.cwd, ['content']);
    gitState(host.cwd);
    const { handler } = handlerOver([host.cwd]);
    await get(handler, `/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`);
    expect(statSync(index).mtimeMs).toBe(old.getTime());
  });

  it('knows a merge, a cherry-pick, a revert and a rebase in progress, and a clean tree', () => {
    expect(operationInProgress(gitHost().cwd)).toBe(false);
    for (const kind of ['merge', 'cherry-pick', 'revert', 'rebase'] as const) {
      expect(operationInProgress(midOperation(kind).cwd), kind).toBe(true);
    }
  });
});

describe('the workspace file', () => {
  it('reads an absent file as empty and refuses a broken one by name', () => {
    const file = workspaceFile();
    expect(readWorkspace(file)).toEqual({ sites: [] });

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json', 'utf8');
    expect(() => readWorkspace(file)).toThrow(/fix or delete the file/);
    expect(() => readWorkspace(file)).toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    writeFileSync(file, JSON.stringify({ sites: {} }), 'utf8');
    expect(() => readWorkspace(file)).toThrow(/sites must be an array of \{ "path": "\/abs\/checkout" \}/);
  });

  it('refuses a relative path and a file path, and keeps one entry for two adds', () => {
    const file = workspaceFile();
    const dir = tempDir();
    expect(() => addSite(file, 'relative/path')).toThrow('relative/path: a workspace path must be absolute');
    expect(existsSync(file)).toBe(false);

    const notADir = join(dir, 'a-file.txt');
    writeFileSync(notADir, 'x', 'utf8');
    expect(() => addSite(file, notADir)).toThrow(`${notADir}: not a directory`);
    expect(() => addSite(file, join(dir, 'nowhere'))).toThrow(`${join(dir, 'nowhere')}: not a directory`);

    const first = addSite(file, dir);
    expect(first.added).toBe(true);
    const second = addSite(file, dir);
    expect(second.added).toBe(false);
    expect(readWorkspace(file).sites).toHaveLength(1);
  });

  it('writes whole through a temp file and leaves none behind', () => {
    const file = workspaceFile();
    writeWorkspace(file, { sites: [{ path: '/abs/one' }] });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readWorkspace(file).sites).toEqual([{ path: '/abs/one' }]);
  });

  it('stores a symlinked path as its real path — one identity, one id', () => {
    const file = workspaceFile();
    const real = tempDir();
    const link = join(tempDir(), 'link');
    symlinkSync(real, link, 'dir');
    expect(addSite(file, link).path).toBe(realpathSync(real));
    expect(addSite(file, real).added).toBe(false);
    expect(readWorkspace(file).sites).toHaveLength(1);
  });

  it('accepts a loopback dev URL and refuses every other spelling', () => {
    const file = workspaceFile();
    const dir = tempDir();
    addSite(file, dir);
    const path = readWorkspace(file).sites[0]?.path as string;

    expect(() => updateSite(file, path, { dev: 'http://evil.example' })).toThrow(
      'http://evil.example: the dev URL must be http(s) on 127.0.0.1 or localhost',
    );
    // Not a CSP host-source in Chrome, so an entry naming it would pass here
    // and then be blocked in the pane with nothing said.
    expect(() => updateSite(file, path, { dev: 'http://[::1]:4321' })).toThrow(
      'the dev URL must be http(s) on 127.0.0.1 or localhost',
    );
    updateSite(file, path, { dev: 'http://localhost:4321' });
    expect(readWorkspace(file).sites[0]?.dev).toBe('http://localhost:4321');
    updateSite(file, path, { dev: 'http://127.0.0.1:3000', devCommand: 'npm run dev', pushAfterCommit: true });
    expect(readWorkspace(file).sites[0]).toMatchObject({
      dev: 'http://127.0.0.1:3000',
      devCommand: 'npm run dev',
      pushAfterCommit: true,
    });

    removeSite(file, path);
    expect(readWorkspace(file).sites).toEqual([]);
  });

  it('stores a trimmed display name, and an empty one clears it (journey A22)', () => {
    const file = workspaceFile();
    const dir = tempDir();
    addSite(file, dir);
    const path = readWorkspace(file).sites[0]?.path as string;

    updateSite(file, path, { name: '  Taskboard ' });
    expect(readWorkspace(file).sites[0]).toEqual({ path, name: 'Taskboard' });
    // Another field's update leaves the name where it is.
    updateSite(file, path, { devCommand: 'npm run dev' });
    expect(readWorkspace(file).sites[0]).toMatchObject({ name: 'Taskboard', devCommand: 'npm run dev' });
    updateSite(file, path, { name: '' });
    expect('name' in (readWorkspace(file).sites[0] as object)).toBe(false);
    updateSite(file, path, { name: 'Again' });
    updateSite(file, path, { name: '   ' });
    expect('name' in (readWorkspace(file).sites[0] as object)).toBe(false);
  });

  it('derives a stable twelve-hex id from the path', () => {
    expect(siteId('/abs/one')).toMatch(/^[0-9a-f]{12}$/);
    expect(siteId('/abs/one')).toBe(siteId('/abs/one'));
    expect(siteId('/abs/one')).not.toBe(siteId('/abs/two'));
  });

  it('takes the workspace path from the environment where one is set', () => {
    expect(workspacePath({ env: { STET_WORKSPACE: '/tmp/ws.json' } })).toBe('/tmp/ws.json');
    expect(workspacePath({ env: {} })).toMatch(/\.stet\/projects\.json$/);
  });
});

describe('loadSite', () => {
  it('names a directory with no config as not adopted', () => {
    const dir = tempDir();
    expect(loadSite({ path: dir })).toMatchObject({ state: 'not-adopted', name: dir.split('/').pop() });
  });

  it('names a config the loader refuses, with the loader’s own message', () => {
    const dir = tempDir();
    write(dir, 'stet.config.json', JSON.stringify({ project: 't', host: 'static' }));
    const site = loadSite({ path: dir });
    expect(site.state).toBe('broken');
    expect(site.state === 'broken' && site.message).toContain('host');
  });

  it('names a descriptor that will not parse, with the report’s message', () => {
    const dir = tempDir();
    write(dir, 'stet.config.json', JSON.stringify({ project: 't' }));
    write(dir, 'content/descriptor.json', '{ not json');
    const site = loadSite({ path: dir });
    expect(site.state).toBe('broken');
    expect(site.state === 'broken' && site.message).toContain('content/descriptor.json');
  });

  it('reads the mini host as a ready snapshot-only JavaScript site', () => {
    const host = gitHost({ config: { project: 't' } });
    const site = loadSite({ path: host.cwd });
    expect(site.state).toBe('ready');
    if (site.state !== 'ready') return;
    expect(site.mode).toBe('snapshot');
    expect(site.host).toBe('js');
    expect(site.keys).toBe(25);
    expect(site.locales).toEqual(['default']);
    expect(site.environments).toEqual([]);
    expect(site.git.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(site.project).toBe('t');
    expect(site.router).toBe(loadConfig(host.cwd).router);
  });

  it('shows an entry’s display name with its folder, and the folder name alone where none is set (journey A22)', () => {
    const host = gitHost({ config: { project: 't' } });
    const folder = host.cwd.split('/').pop() as string;
    const plain = loadSite({ path: host.cwd });
    expect(plain).toMatchObject({ state: 'ready', name: folder });
    expect('folder' in plain).toBe(false);
    const named = loadSite({ path: host.cwd, name: 'Taskboard' });
    expect(named).toMatchObject({ state: 'ready', name: 'Taskboard', folder });

    const blank = tempDir();
    expect(loadSite({ path: blank, name: 'Soon' })).toMatchObject({ state: 'not-adopted', name: 'Soon', folder: blank.split('/').pop() });
    write(blank, 'stet.config.json', JSON.stringify({ project: 't', host: 'static' }));
    expect(loadSite({ path: blank, name: 'Soon' })).toMatchObject({ state: 'broken', name: 'Soon', folder: blank.split('/').pop() });
  });

  it('renames through workspace/update, lists the name, and leaves the folder alone (journey A22)', async () => {
    const host = gitHost({ config: { project: 't' } });
    const { handler, file } = handlerOver([host.cwd]);
    const path = readWorkspace(file).sites[0]?.path as string;
    const listed = async (): Promise<Array<Record<string, unknown>>> =>
      ((await (await handler(req('/api/workspace'))).json()) as { sites: Array<Record<string, unknown>> }).sites;

    const renamed = await handler(req('/api/workspace/update', { method: 'POST', body: { path, name: ' Taskboard ' } }));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { sites: Array<Record<string, unknown>> }).sites[0]).toMatchObject({ name: 'Taskboard', folder: path.split('/').pop() });
    expect((await listed())[0]).toMatchObject({ name: 'Taskboard' });
    const site = (await (await handler(req(`/api/site?site=${encodeURIComponent(path)}`))).json()) as Record<string, unknown>;
    expect(site).toMatchObject({ name: 'Taskboard', folder: path.split('/').pop() });
    expect(existsSync(path)).toBe(true);

    await handler(req('/api/workspace/update', { method: 'POST', body: { path, name: '' } }));
    expect(readWorkspace(file).sites).toEqual([{ path }]);
    const cleared = (await listed())[0] as Record<string, unknown>;
    expect(cleared['name']).toBe(path.split('/').pop());
    expect('folder' in cleared).toBe(false);
  });

  it('carries the project id and the router into the workspace listing', async () => {
    const astro = gitHost({ config: { project: 'site-one', router: 'astro' } });
    const html = await makeHtmlHost();
    const { handler } = handlerOver([astro.cwd, html.cwd]);
    const listed = (await (await handler(req('/api/workspace'))).json()) as { sites: Array<Record<string, unknown>> };
    expect(listed.sites.map((row) => [row['project'], row['router'], row['host']])).toEqual([
      ['site-one', 'astro', 'js'],
      ['default', loadConfig(html.cwd).router, 'html'],
    ]);
  });

  it('names the adapter as the mode on a store-backed site, and html as the host kind', async () => {
    const memory = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const site = loadSite({ path: memory.cwd });
    expect(site.state === 'ready' && site.mode).toBe('memory');

    const html = await makeHtmlHost();
    const htmlSite = loadSite({ path: html.cwd });
    expect(htmlSite.state === 'ready' && htmlSite.host).toBe('html');
  });
});

describe('the per-site environment', () => {
  it('reads .env then .env.local, later winning, and never touches the process', () => {
    const dir = tempDir();
    write(dir, '.env', ['A=1', 'export B="two\\nlines"', "C='q'", '# c', 'a bare word line'].join('\n'));
    write(dir, '.env.local', 'A=9\n');
    expect(siteEnv(dir)).toEqual({ A: '9', B: 'two\nlines', C: 'q' });

    const unique = 'STET_DEV_ENV_PROBE_ONLY';
    write(dir, '.env', `${unique}=set-by-the-file\n`);
    siteEnv(dir);
    expect(unique in process.env).toBe(false);
  });

  it('reads the grammar’s edges', () => {
    const dir = tempDir();
    write(
      dir,
      '.env',
      '﻿BOM=first\r\nD=a=b\r\nE=\r\nF=v # c\r\nG="open\r\nH=a#b\r\n',
    );
    expect(siteEnv(dir)).toEqual({
      BOM: 'first',
      D: 'a=b',
      E: '',
      F: 'v',
      G: '"open',
      H: 'a#b',
    });
  });

  it('parses a bare-word line as nothing at all, never folded into the next key', () => {
    expect(parseEnvText('bareword\nD=1\n')).toEqual([['D', '1']]);
  });

  it('gives a child the process environment minus the run token', () => {
    process.env['STET_DEV_TOKEN'] = 'the-run-token';
    try {
      expect('STET_DEV_TOKEN' in childEnv()).toBe(false);
      expect(process.env['STET_DEV_TOKEN']).toBe('the-run-token');
    } finally {
      delete process.env['STET_DEV_TOKEN'];
    }
  });

  it('never lets a checkout’s .env decide where the tools it runs are found', () => {
    const dir = tempDir();
    write(dir, '.env', 'PATH=/nope\nHOME=/nowhere\nDATABASE_URL=postgres://u:p@h/db\n');
    const io = siteIo(dir, siteEnv(dir), { out: [], err: [] });
    expect(io.env?.['PATH']).toBe(process.env['PATH']);
    expect(io.env?.['HOME']).toBe(process.env['HOME']);
    expect(io.env?.['DATABASE_URL']).toBe('postgres://u:p@h/db');
  });

  it('builds a command io from the five base variables and the site’s own', () => {
    const dir = tempDir();
    write(dir, '.env', 'A=1\n');
    process.env['DASHTEST_SECRET'] = 'must-not-cross';
    const heldTmp = process.env['TMPDIR'];
    delete process.env['TMPDIR'];
    try {
      const io = siteIo(dir, siteEnv(dir), { out: [], err: [] });
      expect(io.cwd).toBe(dir);
      expect(io.env['PATH']).toBe(process.env['PATH']);
      expect(io.env['HOME']).toBe(process.env['HOME']);
      expect(io.env['A']).toBe('1');
      // Not in the five, so it does not cross — the whole point of the list
      // being written out rather than filtered.
      expect('DASHTEST_SECRET' in io.env).toBe(false);
      // A base variable the process does not have is ABSENT, never empty: Node
      // hands an undefined value to a child as an empty string.
      expect('TMPDIR' in baseEnv()).toBe(false);
      expect('TMPDIR' in io.env).toBe(false);
    } finally {
      delete process.env['DASHTEST_SECRET'];
      if (heldTmp !== undefined) process.env['TMPDIR'] = heldTmp;
    }
  });
});

/** Runs `fn` with these variables set in this process, restored after. */
async function withProcessEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const held = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries(held)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('the connection environment', () => {
  const pair = { adapter: 'postgrest', urlEnv: 'FSG_URL', tokenEnv: 'FSG_TOKEN' };

  it('lists every connection variable a config names, once, in block order', () => {
    const host = makeCliHost({
      config: {
        project: 't',
        store: pair,
        environments: {
          staging: { adapter: 'pg', urlEnv: 'FSG_STAGING_DB', tokenEnv: 'FSG_UNUSED' },
          local: { adapter: 'memory' },
          mirror: { adapter: 'postgrest', urlEnv: 'FSG_URL', tokenEnv: 'FSG_MIRROR_TOKEN' },
        },
        contacts: {
          store: { adapter: 'postgrest', urlEnv: 'FSG_CONTACTS_URL', tokenEnv: 'FSG_CONTACTS_TOKEN' },
          environments: { staging: { adapter: 'pg', urlEnv: 'FSG_CONTACTS_DB', tokenEnv: 'FSG_UNUSED' } },
        },
      },
    });
    expect(connectionNames(loadConfig(host.cwd))).toEqual([
      'FSG_URL',
      'FSG_TOKEN',
      'FSG_STAGING_DB',
      'FSG_MIRROR_TOKEN',
      'FSG_CONTACTS_URL',
      'FSG_CONTACTS_TOKEN',
      'FSG_CONTACTS_DB',
    ]);
    expect(connectionNames(loadConfig(makeCliHost({ config: { project: 't' } }).cwd))).toEqual([]);
  });

  it('lays the launched checkout’s process values over its files, and no other checkout’s', async () => {
    const host = makeCliHost({
      config: { project: 't', store: { adapter: 'postgrest', urlEnv: 'FSG_URL', tokenEnv: 'STET_DEV_TOKEN' } },
    });
    write(host.cwd, '.env', 'FSG_URL=http://file.test\nFSG_OTHER=from-the-file\n');
    const site = { path: host.cwd, config: loadConfig(host.cwd) };
    await withProcessEnv({ FSG_URL: 'http://process.test', FSG_OTHER: 'from-the-process', STET_DEV_TOKEN: 'the-run-token' }, () => {
      const env = connectionEnv(site, host.cwd);
      expect(env['FSG_URL']).toBe('http://process.test');
      // Only the variables the config names cross, and the run token is never one.
      expect(env['FSG_OTHER']).toBe('from-the-file');
      expect('STET_DEV_TOKEN' in env).toBe(false);
      // Any other checkout, and a run started in none, reads its files alone.
      expect(connectionEnv(site, join(host.cwd, 'elsewhere'))).toEqual(siteEnv(host.cwd));
      expect(connectionEnv(site, undefined)).toEqual(siteEnv(host.cwd));
    });
    // A value the process holds empty is unset, so the file's stays.
    await withProcessEnv({ FSG_URL: '' }, () => {
      expect(connectionEnv(site, host.cwd)['FSG_URL']).toBe('http://file.test');
    });
  });

  it('hands another checkout’s children none of the variables its config names', async () => {
    const host = makeCliHost({ config: { project: 't', store: pair } });
    const site = { path: host.cwd, config: loadConfig(host.cwd) };
    await withProcessEnv({ FSG_URL: 'http://process.test', FSG_TOKEN: 'secret', FSG_UNNAMED: 'kept', STET_DEV_TOKEN: 'run' }, () => {
      const launched = siteChildEnv(site, host.cwd);
      expect(launched['FSG_URL']).toBe('http://process.test');
      expect(launched['FSG_TOKEN']).toBe('secret');
      const other = siteChildEnv(site, join(host.cwd, 'elsewhere'));
      expect('FSG_URL' in other).toBe(false);
      expect('FSG_TOKEN' in other).toBe(false);
      expect(other['FSG_UNNAMED']).toBe('kept');
      expect(other['PATH']).toBe(process.env['PATH']);
      expect('STET_DEV_TOKEN' in other).toBe(false);
      expect('FSG_URL' in siteChildEnv(site, undefined)).toBe(false);
    });
  });

  it('hands another checkout’s children none of the started-in checkout’s variables either, whatever names its own config uses', async () => {
    const started = makeCliHost({ config: { project: 't', store: pair } });
    const names = [
      makeCliHost({ config: { project: 't' } }),
      makeCliHost({ config: { project: 't', store: { adapter: 'pg', urlEnv: 'FSG_DATABASE_URL' } } }),
    ];
    await withProcessEnv({ FSG_URL: 'http://process.test', FSG_TOKEN: 'secret', FSG_DATABASE_URL: 'own', FSG_UNNAMED: 'kept' }, () => {
      for (const host of names) {
        const other = siteChildEnv({ path: host.cwd, config: loadConfig(host.cwd) }, started.cwd);
        expect('FSG_URL' in other).toBe(false);
        expect('FSG_TOKEN' in other).toBe(false);
        expect(other['FSG_UNNAMED']).toBe('kept');
      }
      // Its own names still go.
      expect('FSG_DATABASE_URL' in siteChildEnv({ path: names[1]!.cwd, config: loadConfig(names[1]!.cwd) }, started.cwd)).toBe(false);
    });
  });

  it('keeps stripping the started-in checkout’s names while its config does not load', async () => {
    const started = makeCliHost({ config: { project: 't', store: pair } });
    const other = makeCliHost({ config: { project: 't' } });
    const site = { path: other.cwd, config: loadConfig(other.cwd) };
    const file = join(started.cwd, 'stet.config.json');
    const good = readFileSync(file, 'utf8');
    await withProcessEnv({ FSG_URL: 'http://process.test', FSG_TOKEN: 'secret' }, () => {
      expect('FSG_TOKEN' in siteChildEnv(site, started.cwd)).toBe(false);
      // Mid-edit, and then gone: the names it last had are still stripped.
      writeFileSync(file, '{', 'utf8');
      expect('FSG_TOKEN' in siteChildEnv(site, started.cwd)).toBe(false);
      rmSync(file);
      expect('FSG_TOKEN' in siteChildEnv(site, started.cwd)).toBe(false);
      writeFileSync(file, good, 'utf8');
    });
  });

  it('strips the names of a started-in config that never loaded since the dev server started', async () => {
    const started = makeCliHost({ config: { project: 't', store: pair } });
    const other = makeCliHost({ config: { project: 't' } });
    const site = { path: other.cwd, config: loadConfig(other.cwd) };
    const handle = await startDevServer({
      port: 0,
      workspaceFile: workspaceFile(),
      io: { cwd: started.cwd, env: {}, stdout: () => {}, stderr: () => {} },
      launched: started.cwd,
    });
    try {
      writeFileSync(join(started.cwd, 'stet.config.json'), '{', 'utf8');
      await withProcessEnv({ FSG_TOKEN: 'secret' }, () => {
        expect('FSG_TOKEN' in siteChildEnv(site, started.cwd)).toBe(false);
      });
    } finally {
      await handle.close();
    }
  });

  it('strips the adapters’ default names when the started-in config was already broken at start', async () => {
    const started = makeCliHost({ config: { project: 't', store: pair } });
    const other = makeCliHost({ config: { project: 't' } });
    const site = { path: other.cwd, config: loadConfig(other.cwd) };
    writeFileSync(join(started.cwd, 'stet.config.json'), '{"store":{"adapter":"postgrest"},', 'utf8');
    const handle = await startDevServer({
      port: 0,
      workspaceFile: workspaceFile(),
      io: { cwd: started.cwd, env: {}, stdout: () => {}, stderr: () => {} },
      launched: started.cwd,
    });
    try {
      await withProcessEnv({ STET_POSTGREST_TOKEN: 'secret', STET_POSTGREST_URL: 'http://process.test', STET_DATABASE_URL: 'postgres://x', FSG_UNNAMED: 'kept' }, () => {
        const env = siteChildEnv(site, started.cwd);
        for (const name of ['STET_POSTGREST_TOKEN', 'STET_POSTGREST_URL', 'STET_DATABASE_URL']) expect(name in env, name).toBe(false);
        expect(env['FSG_UNNAMED']).toBe('kept');
      });
    } finally {
      await handle.close();
    }
  });

  it('hands the started-in checkout’s children no variable the shell holds empty', async () => {
    const host = makeCliHost({ config: { project: 't', store: pair } });
    const site = { path: host.cwd, config: loadConfig(host.cwd) };
    await withProcessEnv({ FSG_URL: 'http://process.test', FSG_TOKEN: '', FSG_UNNAMED: '' }, () => {
      const launched = siteChildEnv(site, host.cwd);
      expect(launched['FSG_URL']).toBe('http://process.test');
      expect('FSG_TOKEN' in launched).toBe(false);
      // Only the variables the config names: another empty variable passes as it was.
      expect(launched['FSG_UNNAMED']).toBe('');
    });
  });
});

describe('routerPreviewCommand', () => {
  it('answers the router’s own production preview, Next’s for app and pages', () => {
    const preview = (router: 'app' | 'pages' | 'astro' | 'vite'): string => {
      const host = makeCliHost({ config: { project: 't', router } });
      return routerPreviewCommand(loadConfig(host.cwd));
    };
    expect(preview('app')).toBe('npx next start -H 127.0.0.1 -p {port}');
    expect(preview('pages')).toBe('npx next start -H 127.0.0.1 -p {port}');
    expect(preview('astro')).toBe('npx astro preview --host 127.0.0.1 --port {port} --ignore-lock');
    expect(preview('vite')).toBe('npx vite preview --host 127.0.0.1 --port {port} --strictPort');
  });
});

describe('devDefaults', () => {
  it('answers null on an html host, whatever router the loader filled in', async () => {
    const html = await makeHtmlHost();
    expect(devDefaults(loadConfig(html.cwd), { path: html.cwd })).toBeNull();
  });

  it('takes the router’s pair where the entry names none', () => {
    const astro = makeCliHost({ config: { project: 't', router: 'astro' } });
    expect(devDefaults(loadConfig(astro.cwd), { path: astro.cwd })).toEqual({
      dev: 'http://localhost:4321',
      devCommand: 'npx astro dev',
      devStopCommand: 'npx astro dev stop',
      source: 'router',
    });

    const next = makeCliHost({ config: { project: 't', router: 'app' } });
    expect(devDefaults(loadConfig(next.cwd), { path: next.cwd })).toEqual({
      dev: 'http://localhost:3000',
      devCommand: 'npm run dev',
      source: 'router',
    });

    const vite = makeCliHost({ config: { project: 't', router: 'vite' } });
    expect(devDefaults(loadConfig(vite.cwd), { path: vite.cwd })).toEqual({
      dev: 'http://localhost:5173',
      devCommand: 'npm run dev',
      source: 'router',
    });
  });

  it('lets the entry’s own values win, and says they are the entry’s', () => {
    const host = makeCliHost({ config: { project: 't', router: 'astro' } });
    expect(
      devDefaults(loadConfig(host.cwd), { path: host.cwd, dev: 'http://127.0.0.1:5173', devCommand: 'npm start' }),
    ).toEqual({
      dev: 'http://127.0.0.1:5173',
      devCommand: 'npm start',
      devStopCommand: 'npx astro dev stop',
      source: 'entry',
    });
  });
});

// --- the handler ------------------------------------------------------------

describe('the handler — the guards every request passes', () => {
  it('refuses a wrong or missing Host on the page, the API and the static files', async () => {
    const host = gitHost();
    const { handler } = handlerOver([host.cwd]);
    for (const path of ['/', '/api/workspace', `/s/${siteId(host.cwd)}/site/index.html`]) {
      expect((await handler(req(path, { host: 'evil.example' }))).status, path).toBe(403);
      expect((await handler(req(path, { host: null }))).status, path).toBe(403);
    }
    expect(await (await handler(req('/api/workspace', { host: 'evil.example' }))).json()).toEqual({
      error: 'wrong host',
    });
    // A bare host on a non-default port is a different address.
    expect((await handler(req('/api/workspace', { host: '127.0.0.1' }))).status).toBe(403);
    expect((await handler(req('/api/workspace', { host: 'localhost:4400' }))).status).toBe(200);
  });

  it('serves the page with no token, its nonce, its policy and its headers', async () => {
    const { handler } = handlerOver([]);
    const res = await handler(req('/', { token: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const policy = res.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(Buffer.from(policy, 'utf8')).toEqual(
      Buffer.from(
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; ` +
          "connect-src 'self'; frame-src 'self' http://127.0.0.1:* http://localhost:* " +
          'https://127.0.0.1:* https://localhost:*; ' +
          "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'utf8',
      ),
    );
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers HEAD on the page with the policy and no body', async () => {
    const { handler } = handlerOver([]);
    const res = await handler(req('/', { token: null, method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  it('refuses a missing or wrong Bearer on the API and admits the run token', async () => {
    const { handler } = handlerOver([]);
    expect((await handler(req('/api/workspace', { token: null }))).status).toBe(401);
    expect(await (await handler(req('/api/workspace', { token: 'wrong' }))).json()).toEqual({
      error: 'unauthorized',
    });
    expect((await handler(req('/api/workspace'))).status).toBe(200);
  });

  it('refuses a foreign Origin and a cross-site fetch, token or no token', async () => {
    const { handler } = handlerOver([]);
    const foreign = await handler(req('/api/workspace', { headers: { origin: 'http://evil.example' } }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'cross-origin request refused' });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    expect(
      (await handler(req('/api/workspace', { headers: { 'sec-fetch-site': 'cross-site' } }))).status,
    ).toBe(403);
    expect(
      (await handler(req('/api/workspace', { headers: { origin: 'http://127.0.0.1:4400' } }))).status,
    ).toBe(200);
    expect(
      (await handler(req('/api/workspace', { headers: { origin: 'http://localhost:4400' } }))).status,
    ).toBe(200);
  });

  it('answers 404 for an unknown path and for a site the workspace does not hold', async () => {
    const outside = tempDir();
    const { handler } = handlerOver([]);
    expect((await handler(req('/nope'))).status).toBe(404);
    expect(await (await handler(req('/nope'))).json()).toEqual({ error: 'not found' });
    // The directory EXISTS; it is simply not one the operator added.
    const res = await handler(req(`/api/site?site=${encodeURIComponent(outside)}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not a workspace site' });
  });
});

describe('the handler — the workspace routes', () => {
  it('lists the workspace with the editor and the version', async () => {
    const host = gitHost({ config: { project: 't' } });
    const { handler } = handlerOver([host.cwd]);
    const body = (await (await handler(req('/api/workspace'))).json()) as {
      editor: string;
      version: string;
      sites: Array<Record<string, unknown>>;
    };
    expect(body.editor).toMatch(/^dashboard:.+/);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.sites).toHaveLength(1);
    expect(body.sites[0]).toMatchObject({ state: 'ready', mode: 'snapshot', keys: 25, host: 'js' });
    // The listing is a listing: the two big forms belong to `GET /api/site`.
    expect(body.sites[0] && 'descriptor' in body.sites[0]).toBe(false);
    expect(body.sites[0] && 'snapshot' in body.sites[0]).toBe(false);
  });

  it('adds, updates and removes a checkout', async () => {
    const host = gitHost();
    const { handler, file } = handlerOver([]);
    const added = await handler(req('/api/workspace/add', { method: 'POST', body: { path: host.cwd } }));
    expect(added.status).toBe(200);
    expect(readWorkspace(file).sites).toHaveLength(1);
    const path = readWorkspace(file).sites[0]?.path as string;

    const updated = await handler(
      req('/api/workspace/update', {
        method: 'POST',
        body: { path, dev: 'http://localhost:4321', devCommand: 'npx astro dev', pushAfterCommit: true },
      }),
    );
    expect(updated.status).toBe(200);
    expect(readWorkspace(file).sites[0]).toMatchObject({ dev: 'http://localhost:4321', pushAfterCommit: true });

    expect((await handler(req('/api/workspace/remove', { method: 'POST', body: { path } }))).status).toBe(200);
    expect(readWorkspace(file).sites).toEqual([]);
  });

  it('maps a usage refusal to 400 and a failure to 409, in one place', async () => {
    const { handler } = handlerOver([]);
    // A missing body field is a usage mistake.
    const usage = await handler(req('/api/workspace/add', { method: 'POST', body: {} }));
    expect(usage.status).toBe(400);
    expect(await usage.json()).toEqual({ error: 'path is required' });

    // A path that breaks a rule is a failure the operator can act on.
    const failure = await handler(req('/api/workspace/add', { method: 'POST', body: { path: 'relative' } }));
    expect(failure.status).toBe(409);
    expect(await failure.json()).toEqual({ error: 'relative: a workspace path must be absolute' });
  });
});

describe('captured — a command run in the dashboard’s own process', () => {
  it('gives back the terminal’s own exit code and channels', async () => {
    const host = gitHost();
    const { ctx } = handlerOver([host.cwd]);
    const site = { path: host.cwd, config: loadConfig(host.cwd) };
    const usage = await captured(ctx, ['check', '--env', 'prod'], site);
    expect(usage.code).toBe(2);
    expect(usage.err.join('\n')).toContain('usage:');
    expect(usage.json).toBeUndefined();

    const plain = await captured(ctx, ['check'], site);
    expect(plain.json).toBeUndefined();
    expect(plain.out.join('\n')).toContain('snapshot: 25 keys declared');

    const asJson = await captured(ctx, ['check', '--json'], site);
    expect(asJson.json).toMatchObject({ ok: expect.any(Boolean) });
  });
});

describe('withEnvFilesHint', () => {
  it('replaces the CLI’s remedy with the checkout’s own files, and leaves every other message', () => {
    expect(
      withEnvFilesHint(
        "store adapter 'pg' is configured but DATABASE_URL is unset — set it or remove the store block",
      ),
    ).toBe(
      "store adapter 'pg' is configured but DATABASE_URL is unset — " +
        "stet dev reads it from the project's .env and .env.local, and for the project it was started in, from the shell it was started in",
    );
    const driver =
      "store adapter 'pg' needs the optional peer dependency `pg`, which is not installed — " +
      'run `npm install pg`, or switch store.adapter to postgrest/snapshot';
    expect(withEnvFilesHint(driver)).toBe(driver);
  });
});

// --- the listener -----------------------------------------------------------

/**
 * The three things only a socket can prove: the interface the server bound, the
 * Host check reached through the adapter, and the page's own response headers
 * on the wire. `node:net` is what the offline guard leaves alone.
 */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      seen += chunk;
    });
    socket.on('end', () => resolve(seen));
    socket.on('close', () => resolve(seen));
    socket.on('error', reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve(seen);
    });
  });
}

/**
 * Whether an HTTP server answers on a loopback port: a status line back for a
 * `HEAD`. A bare connect cannot say so here: a connect to a free ephemeral port
 * can be given that port as its own and connect to itself, and a container's
 * port forwarder may accept on a port for a moment after its server let go.
 */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = '';
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`HEAD / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      seen += chunk;
      if (seen.startsWith('HTTP/1.')) done(true);
    });
    socket.on('error', () => done(false));
    socket.on('close', () => done(seen.startsWith('HTTP/1.')));
    socket.setTimeout(1_000, () => done(false));
  });
}

const PAGE = '<style nonce="__STET_NONCE__"></style><script nonce="__STET_NONCE__"></script>';

/** A context over a workspace file that already holds its sites. */
function contextOver(file: string, over: Partial<DevContext> = {}): DevContext {
  return {
    token: TOKEN,
    origin: 'http://127.0.0.1:4400',
    workspaceFile: file,
    io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
    page: PAGE,
    fetchImpl: globalThis.fetch,
    children: new Map(),
    stores: new Map(),
    queues: new Map(),
    ...over,
  };
}

/** A listening server over an empty workspace, with the fixture page and token. */
async function listening(port = 0): Promise<DevServerHandle> {
  return startDevServer({
    port,
    workspaceFile: workspaceFile(),
    io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
    token: TOKEN,
    page: PAGE,
  });
}

describe('the listener', () => {
  it('binds the loopback interface and reports the port it actually got', async () => {
    const handle = await listening();
    try {
      expect(handle.address).toBe('127.0.0.1');
      expect(handle.port).toBeGreaterThan(0);
      // The printed URL carries the REAL port, never the argument.
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/?t=${TOKEN}`);
    } finally {
      await handle.close();
    }
  });

  it('refuses a foreign Host on the wire', async () => {
    const handle = await listening();
    try {
      const seen = await raw(
        handle.port,
        'GET /api/workspace HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n',
      );
      expect(seen.split('\r\n')[0]).toContain('403');
    } finally {
      await handle.close();
    }
  });

  it('serves the page with its policy and referrer headers on the wire', async () => {
    const handle = await listening();
    try {
      const seen = await raw(
        handle.port,
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`,
      );
      const head = seen.split('\r\n\r\n')[0] ?? '';
      expect(seen.split('\r\n')[0]).toContain('200');
      expect(head.toLowerCase()).toContain('content-security-policy:');
      expect(head.toLowerCase()).toContain('referrer-policy: no-referrer');
    } finally {
      await handle.close();
    }
  });

  it('answers 400 to a request target that does not parse — the adapter’s own guard', async () => {
    const handle = await listening();
    try {
      const seen = await raw(
        handle.port,
        `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(seen.split('\r\n')[0]).toContain('400');
    } finally {
      await handle.close();
    }
  });

  it('refuses a body over the cap before the handler runs, every time', async () => {
    // Ten runs, not one. Writing the refusal on a socket that still holds
    // unread inbound data makes the stack send RST instead, and the client
    // loses the reply it has not yet read — which happened about one upload in
    // six, so a single run would pass on a server that mostly answers nothing.
    const handle = await listening();
    const oversized = 12 * 1024 * 1024;
    const attempt = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        let text = '';
        const socket = connect(handle.port, '127.0.0.1', () => {
          socket.write(
            `POST /api/workspace/add HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n` +
              `Authorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\n` +
              `content-length: ${oversized}\r\nConnection: close\r\n\r\n`,
          );
          // Written in chunks; the server refuses partway and reads the rest.
          const chunk = Buffer.alloc(1024 * 512, 0x61);
          for (let sent = 0; sent < oversized; sent += chunk.byteLength) {
            if (socket.destroyed || socket.writableEnded) break;
            socket.write(chunk);
          }
        });
        socket.setEncoding('utf8');
        socket.on('data', (part: string) => {
          text += part;
        });
        socket.on('close', () => resolve(text));
        socket.on('error', () => resolve(text));
        socket.setTimeout(15_000, () => {
          socket.destroy();
          reject(new Error('the server never answered the oversized body'));
        });
      });

    try {
      const answers: string[] = [];
      for (let run = 0; run < 10; run += 1) answers.push((await attempt()).split('\r\n')[0] ?? '');
      expect(answers.filter((line) => line.includes('413'))).toHaveLength(10);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('names --port when the port is already bound', async () => {
    const first = await listening();
    try {
      await expect(listening(first.port)).rejects.toThrow(`port ${first.port} is in use — pass --port <another>`);
    } finally {
      await first.close();
    }
  });

  it('closes with an idle keep-alive client still connected', async () => {
    const handle = await listening();
    const socket = connect(handle.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n\r\n`);
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    await handle.close();
    socket.destroy();
    // Reaching here at all is the assertion: an un-closed keep-alive connection
    // would hold `server.close` open past the test's timeout.
    expect(true).toBe(true);
  });
});

describe('runDev', () => {
  it('refuses a port that is not an integer in range', async () => {
    const io = { cwd: tempDir(), env: { STET_WORKSPACE: workspaceFile() }, stdout: () => {}, stderr: () => {} };
    expect(await runCli(['dev', '--port', 'x'], io)).toBe(2);
    expect(await runCli(['dev', '--port', '70000'], io)).toBe(2);
    expect(await runCli(['dev', '--port', '-1'], io)).toBe(2);
  });

  it('adds the checkout it was pointed at and prints the URL that opens on it', async () => {
    const host = gitHost({ config: { project: 't' } });
    const file = workspaceFile();
    const out: string[] = [];
    const io: CliIo = {
      cwd: tempDir(),
      env: { STET_WORKSPACE: file },
      stdout: (line) => out.push(line),
      stderr: () => {},
    };
    const held = process.env['STET_DEV_TOKEN'];
    try {
      const code = await runDev(['--no-open', '--port', '0', '--add', host.cwd], io, {
        onListening: async (handle) => {
          // The run token is in the server's own environment, for the mount.
          expect(process.env['STET_DEV_TOKEN']).toBe(handle.token);
        },
      });
      expect(code).toBe(0);
    } finally {
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
    }
    expect(readWorkspace(file).sites.map((s) => s.path)).toEqual([realpathSync(host.cwd)]);
    const line = out.join('\n');
    expect(line).toContain('dashboard: http://127.0.0.1:');
    expect(line).toContain('&site=');
    expect(line).toContain(encodeURIComponent(realpathSync(host.cwd)));
  });

  it('adds the checkout it was RUN in, with no --add at all', async () => {
    const host = gitHost({ config: { project: 't' } });
    const file = workspaceFile();
    const io: CliIo = {
      cwd: host.cwd,
      env: { STET_WORKSPACE: file },
      stdout: () => {},
      stderr: () => {},
    };
    const held = process.env['STET_DEV_TOKEN'];
    try {
      await runDev(['--no-open', '--port', '0'], io, { onListening: async () => {} });
    } finally {
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
    }
    expect(readWorkspace(file).sites.map((s) => s.path)).toEqual([realpathSync(host.cwd)]);
  });
});

// --- a snapshot-only site ---------------------------------------------------

/**
 * The mini project as a committed, snapshot-only checkout whose forms are all
 * in canonical form.
 *
 * The rewrite matters: `makeCliHost` copies the fixture's descriptor and
 * snapshot verbatim, and a first save would otherwise report them written for
 * their formatting rather than for their content. Two keys gain a HARD limit,
 * because the mini descriptor's own limits are advisory and a save has to be
 * refusable to prove the gate.
 */
function snapshotHost(edit: (descriptor: Descriptor) => void = () => {}): CliHost {
  const host = makeCliHost({ config: { project: 't' } });
  const at = (rel: string): string => join(host.cwd, rel);
  const descriptor = loadDescriptor(JSON.parse(readFileSync(at('content/descriptor.json'), 'utf8')));
  const limit = { max: 12, severity: 'hard' as const };
  (descriptor.keys['contact_form_labels'] as { limits?: unknown }).limits = limit;
  (descriptor.keys['footer_links'] as { limits?: unknown }).limits = limit;
  edit(descriptor);
  writeJsonDeterministic(at('content/descriptor.json'), descriptor);
  const snapshot = loadSnapshot(JSON.parse(readFileSync(at('content/defaults.json'), 'utf8')));
  writeJsonDeterministic(at('content/defaults.json'), snapshot);
  const registry = generateRegistry(descriptor);
  writeFileSync(at('content/keys.ts'), registry.keysTs);
  writeFileSync(at('content/stet-env.d.ts'), registry.dts);
  writeFileSync(at('content/defaults.ts'), generateDefaultsModule(snapshot));
  // The read path the save touches. Its content is never read here.
  mkdirSync(at('lib'), { recursive: true });
  writeFileSync(at('lib/content.ts'), 'export const copy = () => "";\n', 'utf8');
  gitInit(host.cwd);
  return host;
}

/** The four repo forms, as bytes, for the nothing-was-written compares. */
function forms(cwd: string): Record<string, Buffer> {
  const files = ['content/defaults.json', 'content/defaults.ts', 'content/keys.ts', 'content/stet-env.d.ts'];
  return Object.fromEntries(files.map((rel) => [rel, readFileSync(join(cwd, rel))]));
}

async function post(
  handler: (r: Request) => Promise<Response>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handler(req(path, { method: 'POST', body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/site', () => {
  it('carries the forms, the config projection and the environments', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const body = (await (
      await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`))
    ).json()) as Record<string, any>;
    expect(Object.keys(body.descriptor.keys)).toContain('hero_headline');
    expect(body.snapshot.default.hero_headline).toBe('Never miss a post again.');
    expect(body.config.locales.enabled).toEqual(['default']);
    expect(body.config.readPath.file).toBe('lib/content.ts');
    expect(body.git.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(body.mode).toBe('snapshot');
    expect(body.environments).toEqual([{ name: 'default', adapter: 'snapshot', vars: [] }]);
  });

  it('carries the router’s preview command as previewDefault, the placeholder Setup shows', async () => {
    const ask = async (router: 'app' | 'astro' | 'vite'): Promise<any> => {
      const host = makeCliHost({ config: { project: 't', router } });
      const { handler } = handlerOver([host.cwd]);
      return (await (await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`))).json()) as any;
    };
    expect((await ask('app')).previewDefault).toBe('npx next start -H 127.0.0.1 -p {port}');
    expect((await ask('astro')).previewDefault).toBe('npx astro preview --host 127.0.0.1 --port {port} --ignore-lock');
    expect((await ask('vite')).previewDefault).toBe('npx vite preview --host 127.0.0.1 --port {port} --strictPort');
  });

  it('reads each connection variable from the checkout’s own files, without dialing', async () => {
    const host = snapshotHost();
    writeFileSync(
      join(host.cwd, 'stet.config.json'),
      JSON.stringify({ project: 't', store: { adapter: 'pg', urlEnv: 'DATABASE_URL' } }, null, 2),
    );
    const { handler } = handlerOver([host.cwd]);
    const ask = async (): Promise<any> =>
      (await (await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`))).json()) as any;

    // No file at all.
    expect((await ask()).environments[0].vars).toEqual([{ name: 'DATABASE_URL', set: false }]);
    // An empty value reads as unset — `requireEnv`'s own rule.
    writeFileSync(join(host.cwd, '.env.local'), 'DATABASE_URL=\n');
    expect((await ask()).environments[0].vars).toEqual([{ name: 'DATABASE_URL', set: false }]);
    writeFileSync(join(host.cwd, '.env.local'), 'DATABASE_URL=postgres://x/y\n');
    expect((await ask()).environments[0].vars).toEqual([{ name: 'DATABASE_URL', set: true }]);
    // The offline guard is the proof nothing was dialed: a real pg connection
    // would have to open a socket, and this suite refuses one.
  });

  describe('previewReads, where the preview’s words come from (journey B8)', () => {
    const STAGING = 'postgres://staging.example/db';
    const PROD = 'postgres://prod.example/db';
    /** A store site with a staging and a prod environment, its read path as the caller writes it, and `.env` lines. */
    function storeSite(read: string, envFile: string): CliHost {
      const host = snapshotHost();
      writeFileSync(
        join(host.cwd, 'stet.config.json'),
        JSON.stringify(
          {
            project: 't',
            store: { adapter: 'pg', urlEnv: 'DATABASE_URL' },
            environments: {
              staging: { adapter: 'pg', urlEnv: 'STAGING_DATABASE_URL' },
              prod: { adapter: 'pg', urlEnv: 'PROD_DATABASE_URL' },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(host.cwd, 'lib/content.ts'), read);
      writeFileSync(join(host.cwd, '.env'), envFile);
      return host;
    }
    const ask = async (host: CliHost, over: Partial<Parameters<typeof handlerOver>[1] & object> = {}): Promise<{ text: string; body: any }> => {
      const { handler } = handlerOver([host.cwd], over);
      const text = await (await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`))).text();
      return { text, body: JSON.parse(text) };
    };

    it('names no source of words for an html host, whose preview is its documents (F3)', async () => {
      const html = await makeHtmlHost();
      expect((await ask(html)).body.previewReads).toBeNull();
    });

    it('reads the stores where the snapshot’s path appears only in comments (D56)', async () => {
      const read = [
        "// const READ_FROM = join(process.cwd(), 'content/defaults.json');",
        '/* the old path: "content/defaults.json"',
        '   `content/defaults.json` */',
        'export const live = 1;',
        '',
      ].join('\n');
      const host = storeSite(read, `DATABASE_URL=${STAGING}\nSTAGING_DATABASE_URL=${STAGING}\nPROD_DATABASE_URL=${PROD}\n`);
      expect((await ask(host)).body.previewReads).toEqual({ stores: { default: true, staging: true, prod: false } });
    });

    it('names the snapshot for a live literal beside a commented one, and past a URL string holding // (D56)', async () => {
      const beside = storeSite("// const OLD = 'content/defaults.json';\nconst READ_FROM = join(cwd, 'content/defaults.json');\n", `DATABASE_URL=${STAGING}\n`);
      expect((await ask(beside)).body.previewReads).toEqual({ snapshot: 'content/defaults.json' });
      const url = storeSite("const A = 'http://example.test/x', READ_FROM = join(cwd, 'content/defaults.json'); // trailing\n", `DATABASE_URL=${STAGING}\n`);
      expect((await ask(url)).body.previewReads).toEqual({ snapshot: 'content/defaults.json' });
    });

    it('names the snapshot where the read path holds its path as a string literal', async () => {
      for (const quote of ["'", '"', '`']) {
        const host = storeSite(`import { join } from 'node:path';\nconst READ_FROM = join(process.cwd(), ${quote}content/defaults.json${quote});\n`, `DATABASE_URL=${STAGING}\n`);
        expect((await ask(host)).body.previewReads).toEqual({ snapshot: 'content/defaults.json' });
      }
    });

    it('reads the stores where the read path names another file', async () => {
      const host = storeSite("const READ_FROM = 'content/other.json';\n", `DATABASE_URL=${STAGING}\nSTAGING_DATABASE_URL=${STAGING}\n`);
      expect((await ask(host)).body.previewReads).toEqual({ stores: { default: true, staging: true, prod: false } });
    });

    it('says per environment whether the dev server’s connection variable holds that environment’s value', async () => {
      const host = storeSite("export const x = 1;\n", `DATABASE_URL=${STAGING}\nSTAGING_DATABASE_URL=${STAGING}\nPROD_DATABASE_URL=${PROD}\n`);
      expect((await ask(host)).body.previewReads).toEqual({ stores: { default: true, staging: true, prod: false } });
      // Nothing set: no environment is the dev server's own.
      writeFileSync(join(host.cwd, '.env'), `STAGING_DATABASE_URL=${STAGING}\n`);
      expect((await ask(host)).body.previewReads).toEqual({ stores: { default: false, staging: false, prod: false } });
      // Two unset variables are not equal values.
      writeFileSync(join(host.cwd, '.env'), 'DATABASE_URL=\nPROD_DATABASE_URL=\n');
      expect((await ask(host)).body.previewReads).toEqual({ stores: { default: false, staging: false, prod: false } });
    });

    it('reads the shell’s value for the started-in project, as the dev command receives it', async () => {
      const host = storeSite("export const x = 1;\n", `DATABASE_URL=${STAGING}\nSTAGING_DATABASE_URL=${STAGING}\nPROD_DATABASE_URL=${PROD}\n`);
      const prior = process.env['DATABASE_URL'];
      process.env['DATABASE_URL'] = PROD;
      try {
        const started = await ask(host, { launched: realpathSync(host.cwd) });
        expect(started.body.previewReads).toEqual({ stores: { default: true, staging: false, prod: true } });
        expect((await ask(host)).body.previewReads).toEqual({ stores: { default: true, staging: true, prod: false } });
      } finally {
        if (prior === undefined) delete process.env['DATABASE_URL'];
        else process.env['DATABASE_URL'] = prior;
      }
    });

    it('never carries a connection value in the reply', async () => {
      const host = storeSite("export const x = 1;\n", `DATABASE_URL=${STAGING}\nSTAGING_DATABASE_URL=${STAGING}\nPROD_DATABASE_URL=${PROD}\n`);
      const { text, body } = await ask(host);
      expect(body.previewReads.stores).toEqual({ default: true, staging: true, prod: false });
      expect(text).not.toContain(STAGING);
      expect(text).not.toContain(PROD);
      expect(text).not.toContain('staging.example');
      const snapshot = storeSite("const R = 'content/defaults.json';\n", `DATABASE_URL=${STAGING}\n`);
      expect((await ask(snapshot)).text).not.toContain('staging.example');
    });
  });

  it('answers a not-adopted and a broken site with what they are, and no forms', async () => {
    const bare = tempDir();
    const broken = tempDir();
    writeFileSync(join(broken, 'stet.config.json'), JSON.stringify({ project: 't', host: 'static' }));
    const { handler } = handlerOver([bare, broken]);
    const one = (await (
      await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(bare))}`))
    ).json()) as Record<string, unknown>;
    expect(one['state']).toBe('not-adopted');
    expect('descriptor' in one).toBe(false);
    const two = (await (
      await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(broken))}`))
    ).json()) as Record<string, unknown>;
    expect(two['state']).toBe('broken');
    expect(String(two['message'])).toContain('host');
  });
});

describe('POST /api/site/save', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;

  it('refuses a value over a hard limit and writes nothing (journey B18)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const before = forms(host.cwd);
    const { status, body } = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'welcome__subject', value: 'x'.repeat(200) }],
    });
    expect(status).toBe(409);
    expect(body['error']).toBe('refused by the save gate');
    expect((body['findings'] as Array<{ kind: string }>).some((f) => f.kind === 'limit')).toBe(true);
    expect(forms(host.cwd)).toEqual(before);
  });

  it('writes the snapshot and the defaults module in one call, and nothing on a repeat', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const first = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'A new headline' }],
    });
    expect(first.status).toBe(200);
    expect(first.body['written']).toEqual(['content/defaults.json', 'content/defaults.ts', 'content/resolved.ts']);
    // The registry and the ambient types carry the DESCRIPTOR's hash, and the
    // descriptor did not move.
    expect(first.body['unchanged']).toEqual(['content/descriptor.json', 'content/keys.ts', 'content/stet-env.d.ts']);
    expect(JSON.parse(host.file('content/defaults.json')).default.hero_headline).toBe('A new headline');

    const again = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'A new headline' }],
    });
    expect(again.body['written']).toEqual([]);

    const report = new Report();
    check(loadConfig(host.cwd), host.cwd, report);
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
  });

  it('is all or nothing: a second value that fails leaves the first unwritten', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const before = forms(host.cwd);
    const { status, body } = await post(handler, `/api/site/save${at(host)}`, {
      values: [
        { key: 'hero_headline', value: 'A new headline' },
        { key: 'welcome__subject', value: 'x'.repeat(200) },
      ],
    });
    expect(status).toBe(409);
    expect((body['findings'] as Array<{ key?: string }>).some((f) => f.key === 'welcome__subject')).toBe(true);
    expect(forms(host.cwd)).toEqual(before);
  });

  it('reads the batch’s own siblings, not the committed ones', async () => {
    // The marketing class rule needs `{{unsubscribe_url}}` in scope. The
    // committed body has none, and the batch supplies it: a gate reading the
    // COMMITTED snapshot would refuse a save that is in fact complete.
    const host = snapshotHost();
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, unknown>;
    };
    snapshot.default['newsletter__body'] = 'Here is what shipped.';
    writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), snapshot);
    const { handler } = handlerOver([host.cwd]);
    const { status } = await post(handler, `/api/site/save${at(host)}`, {
      values: [
        { key: 'newsletter__subject', value: 'What shipped' },
        { key: 'newsletter__body', value: 'What shipped. Unsubscribe: {{unsubscribe_url}}' },
      ],
    });
    expect(status).toBe(200);
  });

  it('moves the read path’s modification time, and leaves it alone under touch: false', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const file = join(host.cwd, 'lib/content.ts');
    const past = Math.floor(Date.now() / 1000) - 600;

    utimesSync(file, past, past);
    const touched = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Touched' }],
    });
    expect(touched.body['touched']).toBe('lib/content.ts');
    expect(statSync(file).mtimeMs).toBeGreaterThan(past * 1000);

    utimesSync(file, past, past);
    const untouched = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Untouched' }],
      touch: false,
    });
    expect(untouched.body['touched']).toBeNull();
    expect(Math.floor(statSync(file).mtimeMs / 1000)).toBe(past);
  });

  it('leaves a read path that points outside the checkout alone', async () => {
    const host = snapshotHost();
    const victim = join(dirname(realpathSync(host.cwd)), 'victim.txt');
    writeFileSync(victim, 'not yours\n', 'utf8');
    const past = Math.floor(Date.now() / 1000) - 600;
    utimesSync(victim, past, past);
    writeFileSync(
      join(host.cwd, 'stet.config.json'),
      JSON.stringify({ project: 't', readPath: { file: '../victim.txt', import: '@/lib/content' } }, null, 2),
    );

    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Contained' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body['touched']).toBeNull();
    expect(Math.floor(statSync(victim).mtimeMs / 1000)).toBe(past);
  });

  it('refuses an undeclared key and a locale the site does not enable', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    expect(await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'nope', value: 'x' }] })).toMatchObject({
      status: 400,
      body: { error: 'undeclared key: nope' },
    });
    expect(
      await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'hero_headline', locale: 'de', value: 'x' }] }),
    ).toMatchObject({ status: 400, body: { error: 'locale de is not enabled' } });
  });

  it('lands a translation in its own block and leaves the default alone (journey B21)', async () => {
    const host = snapshotHost();
    writeFileSync(
      join(host.cwd, 'stet.config.json'),
      JSON.stringify({ project: 't', locales: { default: 'default', enabled: ['default', 'de'] } }, null, 2),
    );
    const { handler } = handlerOver([host.cwd]);
    const before = JSON.parse(host.file('content/defaults.json')).default.hero_headline;
    const { status } = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', locale: 'de', value: 'Eine neue Überschrift' }],
    });
    expect(status).toBe(200);
    const after = JSON.parse(host.file('content/defaults.json'));
    expect(after.de.hero_headline).toBe('Eine neue Überschrift');
    expect(after.default.hero_headline).toBe(before);
  });

  it('walks into a record’s fields and a list’s entries (journeys B20, E20)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);

    const record = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'contact_form_labels', value: { heading: 'A heading far over the limit', submit: 'Send' } }],
    });
    expect(record.status).toBe(409);
    expect((record.body['findings'] as Array<{ key?: string }>).map((f) => f.key)).toContain(
      'contact_form_labels.heading',
    );

    const passing = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'contact_form_labels', value: { heading: 'Hello', submit: 'Send' } }],
    });
    expect(passing.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.contact_form_labels).toEqual({
      heading: 'Hello',
      submit: 'Send',
    });

    const list = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'footer_links', value: ['Privacy', 'An entry far over the limit'] }],
    });
    expect(list.status).toBe(409);
    expect((list.body['findings'] as Array<{ key?: string }>).map((f) => f.key)).toContain('footer_links[1]');

    const shortList = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'footer_links', value: ['Privacy', 'Terms'] }],
    });
    expect(shortList.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.footer_links).toEqual(['Privacy', 'Terms']);
  });

  it('names the mount on a store-backed site rather than writing the snapshot', async () => {
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const { handler } = handlerOver([host.cwd]);
    const { status, body } = await post(
      handler,
      `/api/site/save?site=${encodeURIComponent(realpathSync(host.cwd))}`,
      { values: [{ key: 'hero_headline', value: 'x' }] },
    );
    expect(status).toBe(409);
    expect(body['error']).toBe('a store-backed site is edited through its mounted API — use Save draft');
  });

  describe('derived keys', () => {
    const bytes = (host: CliHost): Buffer[] =>
      ['content/descriptor.json', 'content/defaults.json', 'index.html'].map((rel) => readFileSync(join(host.cwd, rel)));

    it('takes a derived key’s template alone, and refuses everything else first (journey C1)', async () => {
      const host = await psyonHost();
      const { handler } = handlerOver([host.cwd]);
      const before = bytes(host);
      const refusals = [
        { values: [{ key: 'share_description', value: 'A value of its own' }] },
        { templates: [{ key: 'hero_headline', tmpl: '{v}!' }] },
        { templates: [{ key: 'share_description', tmpl: 'No placeholder.' }] },
        { templates: [{ key: 'share_description', tmpl: '{v} and {v}' }] },
      ];
      const answers = [];
      for (const body of refusals) answers.push(await post(handler, `/api/site/save${at(host)}`, body));
      expect(answers).toEqual([
        { status: 400, body: { error: 'share_description derives from hero_headline — edit its template instead' } },
        { status: 400, body: { error: 'hero_headline is not a derived key' } },
        { status: 400, body: { error: 'the template of share_description must hold {v} exactly once' } },
        { status: 400, body: { error: 'the template of share_description must hold {v} exactly once' } },
      ]);
      expect(bytes(host)).toEqual(before);

      const saved = await post(handler, `/api/site/save${at(host)}`, {
        templates: [{ key: 'share_description', tmpl: '{v} Start with a call.' }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body['written']).toEqual(['content/descriptor.json', 'index.html']);
      expect(JSON.parse(host.file('content/descriptor.json')).keys.share_description.tmpl).toBe('{v} Start with a call.');
      expect(host.file('index.html')).toContain(
        'content="You may already have the data our AI lab partners need. Start with a call."',
      );
      const made = await post(handler, `/api/site/commit${at(host)}`, { files: saved.body['pending'] });
      expect(made.body['subject']).toBe('stet: 1 key updated — share_description');
    });

    it('moves a derived share description with its headline, and refuses one pushed past its limit (journeys C1, B17)', async () => {
      const host = await psyonHost();
      const { handler } = handlerOver([host.cwd]);
      const saved = await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: 'hero_headline', value: 'You may already have data<1> our AI lab partners need.</1>' }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body['written']).toEqual(['content/defaults.json', 'index.html']);
      expect(host.file('index.html')).toContain(
        'content="You may already have data our AI lab partners need. No raw data is needed to start."',
      );
      expect(host.file('index.html')).toContain('>You may already have data<span class="tail"> our AI lab partners need.</span></h1>');
      const made = await post(handler, `/api/site/commit${at(host)}`, { files: saved.body['pending'] });
      expect(made.body['subject']).toBe('stet: 2 keys updated — hero_headline, share_description');

      const before = bytes(host);
      const refused = await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: 'hero_headline', value: 'You may already have all of the data<1> our AI lab research partners need today.</1>' }],
      });
      expect(refused.status).toBe(409);
      expect(refused.body['findings']).toEqual([expect.objectContaining({ kind: 'limit', key: 'share_description' })]);
      expect(bytes(host)).toEqual(before);
    });

    it('refuses a value for a derived key on a JavaScript host, and saves its template', async () => {
      const host = snapshotHost();
      const { handler } = handlerOver([host.cwd]);
      const before = forms(host.cwd);
      expect(
        await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'seo_home_title', value: 'Home' }] }),
      ).toEqual({ status: 400, body: { error: 'seo_home_title derives from hero_headline — edit its template instead' } });
      expect(forms(host.cwd)).toEqual(before);
      const saved = await post(handler, `/api/site/save${at(host)}`, {
        templates: [{ key: 'seo_home_title', tmpl: '{v} | Mirra' }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body['written']).toContain('content/descriptor.json');
      expect(JSON.parse(host.file('content/descriptor.json')).keys.seo_home_title.tmpl).toBe('{v} | Mirra');
    });

    it('refuses an undeclared or `constructor` key in values and in templates', async () => {
      const host = await psyonHost();
      const { handler } = handlerOver([host.cwd]);
      for (const key of ['nope', 'constructor']) {
        expect(await post(handler, `/api/site/save${at(host)}`, { values: [{ key, value: 'x' }] })).toEqual({
          status: 400,
          body: { error: `undeclared key: ${key}` },
        });
        expect(await post(handler, `/api/site/save${at(host)}`, { templates: [{ key, tmpl: '{v}' }] })).toEqual({
          status: 400,
          body: { error: `undeclared key: ${key}` },
        });
      }
      const empty = await handler(req(`/api/site/save${at(host)}`, { method: 'POST', body: {} }));
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: 'values or templates is required' });
      const malformed = await handler(req(`/api/site/save${at(host)}`, { method: 'POST', body: { templates: ['x'] } }));
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: 'each template is { key, tmpl }' });
    });

    for (const chain of ['a_chain', 'z_chain']) {
      it(`gates a key two links from the edit, named ${chain}`, async () => {
        const host = await deriveHost((d) => {
          d.keys[chain] = {
            shape: 'text',
            target: 'web',
            derivesFrom: DERIVE_KEYS.title,
            tmpl: '{v} and so on',
            limits: { max: 45, severity: 'hard' },
          };
        });
        const { handler } = handlerOver([host.cwd]);
        const refused = await post(handler, `/api/site/save${at(host)}`, {
          values: [{ key: DERIVE_KEYS.h1, value: 'Ship the whole catalogue <1>in a day now!</1>' }],
        });
        expect(refused.status).toBe(409);
        expect((refused.body['findings'] as Array<{ key?: string }>).map((f) => f.key)).toEqual([chain]);
      });
    }

    const de = { locales: { default: 'default', enabled: ['default', 'de'] } };

    it('gates a derived key’s resolution in the locale its source’s value moves', async () => {
      const host = await deriveHost((d) => {
        (d.keys[DERIVE_KEYS.title] as { limits?: unknown }).limits = { max: 40, severity: 'hard' };
      }, de);
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: DERIVE_KEYS.h1, locale: 'de', value: 'Den ganzen Katalog versenden <1>an einem einzigen Tag</1>' }],
      });
      expect(refused.status).toBe(409);
      expect(refused.body['findings']).toEqual([
        expect.objectContaining({ key: DERIVE_KEYS.title, message: expect.stringContaining('(de)') }),
      ]);
    });

    it('saves a default edit that leaves an overrun already in de alone', async () => {
      const host = await deriveHost((d, snapshot) => {
        (d.keys[DERIVE_KEYS.title] as { limits?: unknown }).limits = { max: 40, severity: 'hard' };
        snapshot['de'] = { [DERIVE_KEYS.h1]: 'Den ganzen Katalog versenden <1>an einem einzigen Tag</1>' };
      }, de);
      const { handler } = handlerOver([host.cwd]);
      const saved = await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: DERIVE_KEYS.h1, value: 'Ship it <1>today</1>' }],
      });
      expect(saved.status).toBe(200);
    });

    it('reports a derived key’s overrun once where both locales resolve alike', async () => {
      const host = await deriveHost((d) => {
        (d.keys[DERIVE_KEYS.title] as { limits?: unknown }).limits = { max: 20, severity: 'hard' };
      }, de);
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: DERIVE_KEYS.h1, value: 'Ship the whole catalogue <1>in a day now</1>' }],
      });
      expect(refused.status).toBe(409);
      expect((refused.body['findings'] as Array<{ key?: string; kind: string }>).filter((f) => f.key === DERIVE_KEYS.title)).toEqual([
        expect.objectContaining({ kind: 'limit' }),
      ]);
    });

    it('refuses a template that pushes its derived key past a hard limit, and changes nothing (stage-5 R1)', async () => {
      const host = await deriveHost((d) => {
        (d.keys[DERIVE_KEYS.title] as { limits?: unknown }).limits = { max: 40, severity: 'hard' };
      });
      const { handler } = handlerOver([host.cwd]);
      const before = ['content/descriptor.json', 'index.html'].map((rel) => readFileSync(join(host.cwd, rel)));
      const refused = await post(handler, `/api/site/save${at(host)}`, {
        templates: [{ key: DERIVE_KEYS.title, tmpl: 'Every single day, all year: {v}' }],
      });
      expect(refused.status).toBe(409);
      expect(refused.body['findings']).toEqual([expect.objectContaining({ kind: 'limit', key: DERIVE_KEYS.title })]);
      expect(['content/descriptor.json', 'index.html'].map((rel) => readFileSync(join(host.cwd, rel)))).toEqual(before);
    });

    it('writes the descriptor through the batch for a template alone', async () => {
      const host = await deriveHost();
      const { handler } = handlerOver([host.cwd]);
      const saved = await post(handler, `/api/site/save${at(host)}`, {
        templates: [{ key: DERIVE_KEYS.title, tmpl: 'Now: {v}' }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body['written']).toEqual(['content/descriptor.json', 'index.html']);
      expect(host.file('index.html')).toContain('>Now: Ship the catalogue in a day</title>');
    });
  });

  describe('the commit subject names the derived keys whose text changed', () => {
    const subjectOf = (host: CliHost): string => git(host.cwd, ['log', '-1', '--format=%s']).out.trim();

    it('titles a descriptor-only commit by the template it carries, not the value left on disk', async () => {
      const host = await deriveHost();
      const { handler } = handlerOver([host.cwd]);
      await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: DERIVE_KEYS.p, value: 'Plans from ten up, for every product page.' }],
      });
      await post(handler, `/api/site/save${at(host)}`, { templates: [{ key: DERIVE_KEYS.title, tmpl: 'Now: {v}' }] });
      const made = await post(handler, `/api/site/commit${at(host)}`, { files: ['content/descriptor.json'] });
      expect(made.status).toBe(200);
      expect(subjectOf(host)).toBe(`stet: 1 key updated — ${DERIVE_KEYS.title}`);
    });

    it('titles a snapshot-only commit by the value it carries, not the template left on disk', async () => {
      const host = await deriveHost();
      const { handler } = handlerOver([host.cwd]);
      await post(handler, `/api/site/save${at(host)}`, { templates: [{ key: DERIVE_KEYS.title, tmpl: 'Now: {v}' }] });
      await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_page_button_text', value: 'Try it now' }] });
      const made = await post(handler, `/api/site/commit${at(host)}`, { files: ['content/defaults.json'] });
      expect(made.status).toBe(200);
      expect(subjectOf(host)).toBe('stet: 1 key updated — home_page_button_text');
    });

    it('reads a descriptor HEAD holds but cannot load as the one on disk, and the commit lands', async () => {
      const host = await psyonHost();
      const valid = host.file('content/descriptor.json');
      writeFileSync(join(host.cwd, 'content/descriptor.json'), '{ "version": 1, "keys": { "x": { "shape": "nope" } } }\n');
      git(host.cwd, ['commit', '-qam', 'a descriptor stet refuses']);
      writeFileSync(join(host.cwd, 'content/descriptor.json'), valid);
      const { handler } = handlerOver([host.cwd]);
      const saved = await post(handler, `/api/site/save${at(host)}`, {
        values: [{ key: 'hero_headline', value: 'You may already have data<1> our AI lab partners need.</1>' }],
      });
      expect(saved.body['pending']).toContain('content/descriptor.json');
      const made = await post(handler, `/api/site/commit${at(host)}`, { files: saved.body['pending'] });
      expect(made.status).toBe(200);
      expect(subjectOf(host)).toBe('stet: 2 keys updated — hero_headline, share_description');
    });
  });

  describe('the commit subject', () => {
    /** An html host holding a 0.3.2 name, a plain key and two keys sharing one value, committed. */
    const renameHost = async (): Promise<CliHost> => {
      const text = { shape: 'text', target: 'web' } as const;
      const host = await makeHtmlHost({
        files: {
          'index.html':
            '<!DOCTYPE html>\n<html><head>\n<title>Process</title>\n</head><body>\n' +
            '<h3 data-stet="01_assess">Assess what you hold</h3>\n<p data-stet="hero_body">Plans from ten up.</p>\n' +
            '<p data-stet="a_key">Same words</p>\n<p data-stet="b_key">Same words</p>\n</body></html>\n',
        },
        keys: { '01_assess': text, hero_body: text, a_key: text, b_key: text },
        defaults: { '01_assess': 'Assess what you hold', hero_body: 'Plans from ten up.', a_key: 'Same words', b_key: 'Same words' },
      });
      for (const rel of ['content/descriptor.json', 'content/defaults.json']) {
        writeJsonDeterministic(join(host.cwd, rel), JSON.parse(host.file(rel)));
      }
      gitInit(host.cwd);
      return host;
    };
    const renamePlan = (host: CliHost, keys: Array<{ old: string; key: string; label?: string; help?: string }>): void => {
      const plan = { plan: 'stet rename', version: 1, keys: keys.map((k) => ({ label: null, help: null, ...k })) };
      writeFileSync(join(host.cwd, 'rename.json'), `${JSON.stringify(plan, null, 2)}\n`);
    };
    /** Commit what the site reports pending, and answer the subject. */
    const commitPending = async (host: CliHost, expected: string[]): Promise<string> => {
      const { handler } = handlerOver([host.cwd]);
      const pending = (await get(handler, `/api/site${at(host)}`))['pending'] as string[];
      expect(pending).toEqual(expected);
      const made = await post(handler, `/api/site/commit${at(host)}`, { files: pending });
      expect(made.status).toBe(200);
      return String(made.body['subject']);
    };
    const FORMS = ['content/defaults.json', 'content/descriptor.json', 'index.html'];

    it('titles a commit that only renames in the words stet rename prints (journey G2)', async () => {
      const host = await renameHost();
      expect(await host.run('rename', '01_assess', 'home_process_step_1', '--write')).toBe(0);
      expect(await commitPending(host, FORMS)).toBe('stet: rename 1 key — 01_assess → home_process_step_1');
    });

    it('names a rename beside a value edit as one entry of the updated list', async () => {
      const host = await renameHost();
      expect(await host.run('rename', '01_assess', 'home_process_step_1', '--write')).toBe(0);
      const { handler } = handlerOver([host.cwd]);
      expect((await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'hero_body', value: 'Plans from five up.' }] })).status).toBe(200);
      expect(await commitPending(host, FORMS)).toBe('stet: 2 keys updated — 01_assess → home_process_step_1, hero_body');
    });

    it('pairs none where two leaving keys and two arriving keys share one value', async () => {
      const host = await renameHost();
      renamePlan(host, [
        { old: 'a_key', key: 'a_new' },
        { old: 'b_key', key: 'b_new' },
      ]);
      expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
      expect(await commitPending(host, FORMS)).toBe('stet: 4 keys updated — a_key, a_new, b_key, b_new');
    });

    it('pairs a derived key, which holds no value, on its descriptor entry', async () => {
      const host = await psyonHost();
      expect(await host.run('rename', 'share_description', 'home_share_description', '--write')).toBe(0);
      expect(await commitPending(host, ['content/descriptor.json', 'index.html'])).toBe(
        'stet: rename 1 key — share_description → home_share_description',
      );
    });

    it('pairs a derived key renamed with a new label and help, which the entry compare sets aside', async () => {
      const host = await psyonHost();
      renamePlan(host, [
        { old: 'share_description', key: 'home_share_description', label: 'Share text', help: 'What a shared link shows.' },
      ]);
      expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
      expect(await commitPending(host, ['content/descriptor.json', 'index.html'])).toBe(
        'stet: rename 1 key — share_description → home_share_description',
      );
    });
  });

  it('regenerates an html host’s documents, and inherits the batch’s own refusal (journey B17)', async () => {
    const html = await makeHtmlHost({ register: true, git: true });
    gitInit(html.cwd);
    const { handler } = handlerOver([html.cwd]);
    const path = `?site=${encodeURIComponent(realpathSync(html.cwd))}`;
    const key = Object.keys(JSON.parse(html.file('content/descriptor.json')).keys)[0] as string;

    // What the batch's own planner would write, computed BEFORE the save from
    // the same descriptor and a snapshot carrying the new value.
    const descriptor = loadDescriptor(JSON.parse(html.file('content/descriptor.json')));
    const wanted = loadSnapshot(JSON.parse(html.file('content/defaults.json')));
    (wanted['default'] ??= {})[key] = 'A regenerated line';
    const expected = planDocuments(html.cwd, ['index.html'], descriptor, wanted, new Report()).writes.find(
      (w) => w.rel === 'index.html',
    )?.text;
    expect(expected).toBeDefined();

    const saved = await post(handler, `/api/site/save${path}`, {
      values: [{ key, value: 'A regenerated line' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body['written']).toContain('index.html');
    expect(readFileSync(join(html.cwd, 'index.html'))).toEqual(Buffer.from(expected as string, 'utf8'));

    // A mark the batch cannot regenerate refuses the whole save, with the
    // batch's own message — the one place that refusal lives.
    writeFileSync(
      join(html.cwd, 'index.html'),
      html.file('index.html').replace('<body', '<body data-stet="not_a_declared_key"'),
      'utf8',
    );
    const refused = await post(handler, `/api/site/save${path}`, { values: [{ key, value: 'Another line' }] });
    expect(refused.status).toBe(409);
    expect(String(refused.body['error'])).toContain('could not be regenerated');
  });
});

/** The psyon shape on a static-HTML host: a tagged headline and a share description derived from it, its limit 100, committed. */
async function psyonHost(): Promise<CliHost> {
  const host = await makeHtmlHost({
    files: {
      'index.html':
        '<!DOCTYPE html>\n<html><head>\n<meta property="og:description" content="You may already have the data our AI lab ' +
        'partners need. No raw data is needed to start." data-stet-content="share_description">\n</head><body>\n' +
        '<h1 data-stet="hero_headline">You may already have the data<span class="tail"> our AI lab partners need.</span></h1>\n' +
        '</body></html>\n',
    },
    keys: {
      hero_headline: { shape: 'text', target: 'web', tags: 1 },
      share_description: {
        shape: 'text',
        target: 'web',
        derivesFrom: 'hero_headline',
        tmpl: '{v} No raw data is needed to start.',
        limits: { max: 100, severity: 'hard' },
      },
    },
    defaults: { hero_headline: 'You may already have the data<1> our AI lab partners need.</1>' },
  });
  // In the forms' own spelling, so a save rewrites only what it changes.
  for (const rel of ['content/descriptor.json', 'content/defaults.json']) {
    writeJsonDeterministic(join(host.cwd, rel), JSON.parse(host.file(rel)));
  }
  gitInit(host.cwd);
  return host;
}

/** `derive.html` registered, edited as a case needs, and committed. */
async function deriveHost(
  edit: (descriptor: Descriptor, snapshot: Record<string, Record<string, unknown>>) => void = () => {},
  config?: Record<string, unknown>,
): Promise<CliHost> {
  const host = await makeHtmlHost({
    files: { 'index.html': htmlFixture('derive.html') },
    register: true,
    ...(config === undefined ? {} : { config }),
  });
  const descriptor = JSON.parse(host.file('content/descriptor.json')) as Descriptor;
  const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
  edit(descriptor, snapshot);
  writeJsonDeterministic(join(host.cwd, 'content/descriptor.json'), descriptor);
  writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), snapshot);
  gitInit(host.cwd);
  return host;
}
/** `derive.html`'s keys once registered. */
const DERIVE_KEYS = {
  h1: 'home_page_headline_1',
  title: 'home_page_title',
  p: 'home_page_paragraph',
  description: 'home_meta_description',
};

describe('the stale base on a snapshot save (D10, 9.1)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  /** Every file the save batch writes, as bytes: the forms plus the descriptor. */
  const allForms = (cwd: string): Record<string, Buffer> => ({
    ...forms(cwd),
    'content/descriptor.json': readFileSync(join(cwd, 'content/descriptor.json')),
    'content/resolved.ts': readFileSync(join(cwd, 'content/resolved.ts')),
  });
  /** An agent's write: the snapshot file edited on disk behind the page's back. */
  function agentWrites(cwd: string, values: Record<string, unknown>): void {
    const file = join(cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    Object.assign(snapshot.default, values);
    writeJsonDeterministic(file, snapshot);
  }

  it('F3 (R5-6): an agent write that lands while the body is still arriving is stale, and no other key the agent wrote is reverted', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const body = JSON.stringify({
      values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline', base: 'Never miss a post again.' }],
    });
    const enc = new TextEncoder();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(body.slice(0, 5)));
        await gate;
        controller.enqueue(enc.encode(body.slice(5)));
        controller.close();
      },
    });
    const pending = handler(
      new Request(`http://127.0.0.1:4400/api/site/save${at(host)}`, {
        method: 'POST',
        headers: { host: '127.0.0.1:4400', authorization: `Bearer ${TOKEN}` },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    agentWrites(host.cwd, { hero_headline: 'The agent’s headline', pricing_price: '$18' });
    const written = allForms(host.cwd);
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'hero_headline', locale: 'default', disk: 'The agent’s headline' }],
    });
    expect(allForms(host.cwd)).toEqual(written);
    expect(JSON.parse(host.file('content/defaults.json')).default.pricing_price).toBe('$18');
  });

  it('F3: a config turned store-backed while the body arrives is refused as store-backed, and nothing is written', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const body = JSON.stringify({ values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline' }] });
    const enc = new TextEncoder();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(body.slice(0, 5)));
        await gate;
        controller.enqueue(enc.encode(body.slice(5)));
        controller.close();
      },
    });
    const pending = handler(
      new Request(`http://127.0.0.1:4400/api/site/save${at(host)}`, {
        method: 'POST',
        headers: { host: '127.0.0.1:4400', authorization: `Bearer ${TOKEN}` },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const config = JSON.parse(host.file('stet.config.json'));
    writeFileSync(join(host.cwd, 'stet.config.json'), JSON.stringify({ ...config, store: { adapter: 'memory' } }));
    const written = allForms(host.cwd);
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'a store-backed site is edited through its mounted API — use Save draft' });
    expect(allForms(host.cwd)).toEqual(written);
  });

  it('refuses a key an agent wrote after the page loaded, naming it with the agent’s words, and Save mine over it then writes (journey B18)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    agentWrites(host.cwd, { hero_headline: 'The agent’s headline', pricing_price: '$18' });
    const before = allForms(host.cwd);

    const refused = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline', base: 'Never miss a post again.' }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'hero_headline', locale: 'default', disk: 'The agent’s headline' }],
    });
    expect(allForms(host.cwd)).toEqual(before);

    // Save mine over it: the batch again, the stale key's base left out.
    const mine = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline' }],
    });
    expect(mine.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.hero_headline).toBe('The editor’s headline');

    // A key the agent left alone saves with no refusal, whatever else moved on disk.
    const alone = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_body', locale: 'default', value: 'Follow {{handle}} from Telegram.', base: 'Follow {{handle}} without leaving Telegram.' }],
    });
    expect(alone.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.pricing_price).toBe('$18');
  });

  // Mutation guard: green on the first build by design; it fails when a base is
  // compared as it arrives rather than by its canonical form.
  it('reads a record whose fields arrive in another order as unchanged', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [
        {
          key: 'contact_form_labels',
          locale: 'default',
          value: { heading: 'Say hello', submit: 'Send it' },
          base: { submit: 'Send it', heading: 'Get in touch' },
        },
      ],
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.contact_form_labels.heading).toBe('Say hello');
  });

  // Mutation guard: green on the first build by design; it fails when a value
  // sent without a base is checked against the disk anyway.
  it('checks no value that carries no base', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    agentWrites(host.cwd, { hero_headline: 'The agent’s headline' });
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline' }],
    });
    expect(saved.status).toBe(200);
  });

  // Mutation guard: green on the first build by design; it fails when a key the
  // disk does not hold reads as anything but the null base the page sends.
  it('reads a key the disk does not hold as a null base, and a null base against a held value as stale', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const file = join(host.cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    delete snapshot.default['farewell_notice'];
    writeJsonDeterministic(file, snapshot);
    const fresh = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'farewell_notice', locale: 'default', value: 'So long.', base: null }],
    });
    expect(fresh.status).toBe(200);
    const held = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', locale: 'default', value: 'Mine', base: null }],
    });
    expect(held.status).toBe(409);
    expect(held.body['stale']).toEqual([{ key: 'hero_headline', locale: 'default', disk: 'Never miss a post again.' }]);
  });

  // Mutation guard: green on the first build by design; it fails when the disk's
  // value is looked up with `in`, which finds a member named like Object.prototype's own.
  it('reads a declared key named like Object.prototype’s own, absent on disk, as a null base', async () => {
    const host = snapshotHost((descriptor) => {
      descriptor.keys['constructor'] = { shape: 'text', target: 'web' };
    });
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'constructor', locale: 'default', value: 'A value', base: null }],
    });
    expect(saved.status).toBe(200);
  });

  it('writes nothing on a 409, the clean key of the batch included', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    agentWrites(host.cwd, { pricing_price: '$18' });
    const before = allForms(host.cwd);
    const refused = await post(handler, `/api/site/save${at(host)}`, {
      values: [
        { key: 'hero_headline', locale: 'default', value: 'Clean edit', base: 'Never miss a post again.' },
        { key: 'pricing_price', locale: 'default', value: '$20', base: '$16' },
      ],
    });
    expect(refused.status).toBe(409);
    expect((refused.body['stale'] as Array<{ key: string }>).map((s) => s.key)).toEqual(['pricing_price']);
    expect(allForms(host.cwd)).toEqual(before);
  });

  it('names a stale key before the gate can refuse it', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    agentWrites(host.cwd, { welcome__subject: 'Hello from the agent' });
    const refused = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'welcome__subject', locale: 'default', value: 'x'.repeat(200), base: 'Welcome, {{handle}}' }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'welcome__subject', locale: 'default', disk: 'Hello from the agent' }],
    });
  });
});

describe('GET /api/site/carries and Put back (D10, 9.2)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  type Carried = { keys: Array<{ key: string; locale: string; head?: unknown; now?: unknown }>; files: string[] };
  const carried = async (handler: (r: Request) => Promise<Response>, host: CliHost): Promise<Carried> =>
    (await (await handler(req(`/api/site/carries${at(host)}`))).json()) as Carried;

  it('lists each key that differs from HEAD, and Put back saves HEAD’s value through the gate (journey B18)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    for (const [key, value] of [['hero_headline', 'A saved headline'], ['pricing_price', '$18']]) {
      expect((await post(handler, `/api/site/save${at(host)}`, { values: [{ key, locale: 'default', value }] })).status).toBe(200);
    }
    const panel = await carried(handler, host);
    expect(panel.keys).toEqual([
      { key: 'hero_headline', locale: 'default', head: 'Never miss a post again.', now: 'A saved headline' },
      { key: 'pricing_price', locale: 'default', head: '$16', now: '$18' },
    ]);
    expect(panel.files).toEqual(['content/defaults.json', 'content/defaults.ts', 'content/resolved.ts']);

    const price = panel.keys[1] as { key: string; locale: string; head: unknown; now: unknown };
    const back = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: price.key, locale: price.locale, value: price.head, base: price.now }],
    });
    expect(back.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.pricing_price).toBe('$16');
    expect((await carried(handler, host)).keys.map((k) => k.key)).toEqual(['hero_headline']);
  });

  it('refuses a Put back whose key changed on disk after the panel loaded, naming it', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'pricing_price', locale: 'default', value: '$18' }] });
    const price = (await carried(handler, host)).keys[0] as { key: string; locale: string; head: unknown; now: unknown };
    const file = join(host.cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    snapshot.default['pricing_price'] = '$19';
    writeJsonDeterministic(file, snapshot);
    const before = readFileSync(file);
    const back = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: price.key, locale: price.locale, value: price.head, base: price.now }],
    });
    expect(back.status).toBe(409);
    expect(back.body['stale']).toEqual([{ key: 'pricing_price', locale: 'default', disk: '$19' }]);
    expect(readFileSync(file)).toEqual(before);
  });

  // Addition: guards `carries` comparing HEAD's value and the disk's by their
  // canonical forms, so a record an agent rewrote with its fields in another
  // order is not listed as a change.
  it('lists no key whose record HEAD and the disk hold with their fields in another order', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const file = join(host.cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    const labels = snapshot.default['contact_form_labels'] as Record<string, unknown>;
    snapshot.default['contact_form_labels'] = Object.fromEntries(Object.entries(labels).reverse());
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).default.contact_form_labels)).not.toEqual(Object.keys(labels));
    expect((await carried(handler, host)).keys).toEqual([]);
  });

  it('gives a key new since HEAD no head', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    // HEAD holds no value for farewell_notice; the editor gives it one.
    const file = join(host.cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    delete snapshot.default['farewell_notice'];
    writeJsonDeterministic(file, snapshot);
    git(host.cwd, ['commit', '-qam', 'farewell_notice unset']);
    await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'farewell_notice', locale: 'default', value: 'So long.' }] });
    expect((await carried(handler, host)).keys).toEqual([{ key: 'farewell_notice', locale: 'default', now: 'So long.' }]);
  });
});

describe('GET /api/site/key-history (D10, 9.3)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;

  it('answers a snapshot key’s past values newest first, numbered oldest first (journey B25)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    for (const value of ['Second headline', 'Third headline']) {
      const saved = await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'hero_headline', value }] });
      await post(handler, `/api/site/commit${at(host)}`, { files: saved.body['written'] as string[], keys: ['hero_headline'], message: value });
    }
    const body = (await (await handler(req(`/api/site/key-history${at(host)}&key=hero_headline&locale=default`))).json()) as {
      versions: Array<{ n: number; short: string; author: string; value: unknown }>;
    };
    expect(body.versions.map((v) => [v.n, v.value, v.author])).toEqual([
      [3, 'Third headline', 'dev'],
      [2, 'Second headline', 'dev'],
      [1, 'Never miss a post again.', 'dev'],
    ]);
    expect(body.versions[0]?.short).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('skips a revision over the 64 MB parse cap, lists the rest and says some are too large', async () => {
    const host = snapshotHost();
    const file = join(host.cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    for (const value of ['x'.repeat(64 * 1024 * 1024 + 1), 'Back to normal']) {
      snapshot.default['hero_headline'] = value;
      writeFileSync(file, JSON.stringify(snapshot));
      git(host.cwd, ['commit', '-qam', 'edit']);
    }
    const { handler } = handlerOver([host.cwd]);
    const res = await handler(req(`/api/site/key-history${at(host)}&key=hero_headline&locale=default`));
    expect(await res.json()).toEqual({
      versions: [
        expect.objectContaining({ n: 2, value: 'Back to normal' }),
        expect.objectContaining({ n: 1, value: 'Never miss a post again.' }),
      ],
      truncated: true,
    });
  });

  it('refuses an undeclared key and a locale that is not enabled before git runs', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    for (const key of ['constructor', '__proto__', '../content/defaults.json', '/etc/passwd', '-n', '--output=/tmp/x']) {
      const res = await handler(req(`/api/site/key-history${at(host)}&key=${encodeURIComponent(key)}&locale=default`));
      expect(res.status, key).toBe(400);
      expect(await res.json()).toEqual({ error: `undeclared key: ${key}` });
    }
    for (const locale of ['..', '/etc', '-p', '__proto__']) {
      const res = await handler(req(`/api/site/key-history${at(host)}&key=hero_headline&locale=${encodeURIComponent(locale)}`));
      expect(res.status, locale).toBe(400);
    }
  });

  it('reads no snapshot outside the checkout, though the repository holds it', async () => {
    // The checkout is a folder of its repository, and its config points the
    // snapshot at a file beside the folder, which git would read.
    const { top, cwd } = subfolderHost();
    writeFileSync(join(top, 'secret.json'), readFileSync(join(cwd, 'content/defaults.json')));
    git(top, ['add', 'secret.json']);
    git(top, ['commit', '-qm', 'beside the checkout']);
    const config = JSON.parse(readFileSync(join(cwd, 'stet.config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(cwd, 'stet.config.json'), JSON.stringify({ ...config, snapshotPath: '../secret.json' }));
    const { handler } = handlerOver([cwd]);
    const res = await handler(req(`/api/site/key-history?site=${encodeURIComponent(cwd)}&key=hero_headline&locale=default`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: [] });
  });
});

describe('POST /api/site/commit and /push', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  /** A handler over a fresh context holding just this checkout — a restart, in one call. */
  const handler0 = (host: CliHost): ((r: Request) => Promise<Response>) => handlerOver([host.cwd]).handler;

  it('commits exactly what the save reported, and leaves the working tree alone (journey B18)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'A committed headline' }],
    });
    const written = saved.body['written'] as string[];
    expect(written).toHaveLength(3);

    // An unrelated edit, sitting in the working tree while the commit runs.
    writeFileSync(join(host.cwd, 'notes.txt'), 'stray\n', 'utf8');

    const made = await post(handler, `/api/site/commit${at(host)}`, {
      files: written,
      keys: ['hero_headline'],
    });
    expect(made.status).toBe(200);
    expect(git(host.cwd, ['log', '-1', '--format=%s']).out.trim()).toBe('stet: 1 key updated — hero_headline');
    const touched = git(host.cwd, ['show', '--stat', '--format=', 'HEAD']).out;
    expect(touched).toContain('content/defaults.json');
    expect(touched).toContain('content/defaults.ts');
    expect(touched).toContain('content/resolved.ts');
    expect(touched).not.toContain('notes.txt');
    expect(git(host.cwd, ['status', '--porcelain']).out).toContain('?? notes.txt');
  });

  it('refuses a file that is not one of this site’s stet-written forms', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    writeFileSync(join(host.cwd, 'notes.txt'), 'stray\n', 'utf8');
    const refused = await post(handler, `/api/site/commit${at(host)}`, {
      files: ['notes.txt'],
      keys: ['hero_headline'],
    });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('notes.txt is not a stet-written form of this site');
    expect(refused.body['pending']).toEqual([]);
  });

  it('returns a failing hook’s output and commits nothing', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const head = gitState(host.cwd).head;
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Hooked' }],
    });
    mkdirSync(join(host.cwd, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(host.cwd, '.git/hooks/pre-commit'), '#!/bin/sh\necho nope\nexit 1\n', { mode: 0o755 });

    const refused = await post(handler, `/api/site/commit${at(host)}`, {
      files: saved.body['written'] as string[],
      keys: ['hero_headline'],
    });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('git commit failed');
    expect(String(refused.body['output'])).toContain('nope');
    expect(gitState(host.cwd).head).toBe(head);
  });

  it('names only the changed key when HEAD’s snapshot is larger than a mebibyte', async () => {
    const host = snapshotHost();
    const file = join(host.cwd, 'content/defaults.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
    snapshot.default['blog_intro'] = 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    git(host.cwd, ['commit', '-qam', 'a large snapshot']);
    setHeadline(host.cwd, 'Only this one');
    const made = await post(handler0(host), `/api/site/commit${at(host)}`, { files: ['content/defaults.json'] });
    expect(made.status).toBe(200);
    // `seo_home_title` derives from the headline, so its text changed too.
    expect(made.body['subject']).toBe('stet: 2 keys updated — hero_headline, seo_home_title');
  });

  it('agrees the count with the noun, and clips a long list at 72', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [
        { key: 'hero_headline', value: 'One' },
        { key: 'blog_intro', value: 'Two' },
        { key: 'pricing_price', value: 'Three' },
      ],
    });
    await post(handler, `/api/site/commit${at(host)}`, {
      files: saved.body['written'] as string[],
      keys: ['hero_headline', 'blog_intro', 'pricing_price'],
    });
    expect(git(host.cwd, ['log', '-1', '--format=%s']).out.trim()).toBe(
      'stet: 3 keys updated — hero_headline, blog_intro, pricing_price',
    );

    const again = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Four' }],
    });
    await post(handler, `/api/site/commit${at(host)}`, {
      files: again.body['written'] as string[],
      keys: ['a_very_long_key_name_indeed', 'another_very_long_key_name', 'a_third_long_key_name'],
    });
    const subject = git(host.cwd, ['log', '-1', '--format=%s']).out.trim();
    expect(subject).toHaveLength(72);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('commits the document a save on an html host just regenerated (journey B17)', async () => {
    // The document the save wrote is now CURRENT, so the repo-form planner has
    // nothing to say about it. A label set derived from that plan refused the
    // commit of exactly the file the save had reported writing.
    const html = await makeHtmlHost({ register: true, git: true });
    gitInit(html.cwd);
    const { handler } = handlerOver([html.cwd]);
    const path = `?site=${encodeURIComponent(realpathSync(html.cwd))}`;
    const key = Object.keys(JSON.parse(html.file('content/descriptor.json')).keys)[0] as string;

    const saved = await post(handler, `/api/site/save${path}`, {
      values: [{ key, value: 'A committed line' }],
    });
    expect(saved.status).toBe(200);
    const written = saved.body['written'] as string[];
    expect(written).toContain('index.html');
    expect(written).toContain('content/defaults.json');

    const made = await post(handler, `/api/site/commit${path}`, { files: written, keys: [key] });
    expect(made.status).toBe(200);
    const stat = git(html.cwd, ['show', '--stat', '--name-only', '--format=', 'HEAD']).out.trim().split('\n');
    expect(stat.filter((line) => line !== '').sort()).toEqual(['content/defaults.json', 'index.html']);

    // A file the managed surfaces do not match is still refused.
    writeFileSync(join(html.cwd, 'art.js'), 'console.log(1)\n', 'utf8');
    const refused = await post(handler, `/api/site/commit${path}`, { files: ['art.js'], keys: [key] });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('art.js is not a stet-written form of this site');
  });

  it('accepts an html host’s MARKED documents, whoever edited them, and refuses the rest — across a restart', async () => {
    // Every `.html` in the checkout is a managed surface, so a set drawn from
    // the surfaces would let the dashboard commit an unrelated page. A mark is
    // the file's own property, so it survives the server that wrote it: a
    // document a previous run regenerated is still committable.
    const html = await makeHtmlHost({
      files: { 'notes.html': '<html><body><p>Working notes, mine.</p></body></html>\n' },
      register: true,
      git: true,
    });
    gitInit(html.cwd);
    const path = `?site=${encodeURIComponent(realpathSync(html.cwd))}`;
    const key = Object.keys(JSON.parse(html.file('content/descriptor.json')).keys)[0] as string;

    const saved = await post(handler0(html), `/api/site/save${path}`, {
      values: [{ key, value: 'A line from the first run' }],
    });
    expect(saved.status).toBe(200);
    const written = saved.body['written'] as string[];
    expect(written).toContain('index.html');

    // A second server over the same checkout — the restart. It never saw the
    // save, and must still accept what the save wrote.
    const restarted = handler0(html);
    const made = await post(restarted, `/api/site/commit${path}`, { files: written, keys: [key] });
    expect(made.status).toBe(200);

    // An unmarked page is refused whatever state it is in.
    writeFileSync(join(html.cwd, 'notes.html'), '<html><body><p>Half a thought.</p></body></html>\n', 'utf8');
    const refused = await post(restarted, `/api/site/commit${path}`, { files: ['notes.html'], keys: [key] });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('notes.html is not a stet-written form of this site');
    expect(git(html.cwd, ['status', '--porcelain']).out).toContain('notes.html');

    // A marked document carrying an edit stet did not make is accepted: the
    // rule is the mark, not authorship of the last byte.
    writeFileSync(
      join(html.cwd, 'index.html'),
      `${readFileSync(join(html.cwd, 'index.html'), 'utf8')}<!-- edited by hand -->\n`,
      'utf8',
    );
    const byHand = await post(restarted, `/api/site/commit${path}`, { files: ['index.html'], keys: [key] });
    expect(byHand.status).toBe(200);
  });

  it('answers another request while a slow commit is still running', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Slow' }],
    });
    // A pre-commit hook that takes a second is an ordinary repository, and a
    // synchronous git would hold the whole process for its whole run.
    mkdirSync(join(host.cwd, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(host.cwd, '.git/hooks/pre-commit'), '#!/bin/sh\nsleep 1\nexit 0\n', { mode: 0o755 });

    let settled = false;
    const committing = post(handler, `/api/site/commit${at(host)}`, {
      files: saved.body['written'] as string[],
      keys: ['hero_headline'],
    }).then((made) => {
      settled = true;
      return made;
    });
    // Long enough for the commit to reach git and suspend there.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const listed = handler(req('/api/workspace')).then(() => 'listed' as const);
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 400));
    expect(await Promise.race([listed, late])).toBe('listed');
    expect(settled).toBe(false);

    expect((await committing).status).toBe(200);
  });

  /** Save and commit one headline through the routes, so the branch holds a commit to push. */
  async function commitHeadline(handler: (r: Request) => Promise<Response>, host: CliHost, value: string): Promise<void> {
    const saved = await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'hero_headline', value }] });
    await post(handler, `/api/site/commit${at(host)}`, { files: saved.body['written'] as string[], keys: ['hero_headline'] });
  }

  it('runs another checkout’s commit and push hooks without the started-in checkout’s connection variables', async () => {
    const started = makeCliHost({
      config: { project: 't', store: { adapter: 'postgrest', urlEnv: 'STET_POSTGREST_URL', tokenEnv: 'STET_POSTGREST_TOKEN' } },
    });
    const host = snapshotHost();
    git(host.cwd, ['checkout', '-qb', 'develop']);
    bareRemote(host.cwd, 'origin');
    mkdirSync(join(host.cwd, '.git', 'hooks'), { recursive: true });
    for (const name of ['pre-commit', 'pre-push']) {
      writeFileSync(join(host.cwd, '.git/hooks', name), '#!/bin/sh\necho "${STET_POSTGREST_TOKEN-unset}" >> .git/saw.txt\n', { mode: 0o755 });
    }
    await withProcessEnv({ STET_POSTGREST_TOKEN: 'SERVICE-KEY' }, async () => {
      const { handler } = handlerOver([started.cwd, host.cwd], { launched: realpathSync(started.cwd) });
      await commitHeadline(handler, host, 'Hooked');
      expect((await post(handler, `/api/site/push${at(host)}`, {})).status).toBe(200);
    });
    expect(readFileSync(join(host.cwd, '.git/saw.txt'), 'utf8')).toBe('unset\nunset\n');
  });

  it('pushes a branch with no upstream with -u to origin, then lands the next commit on it (journey B18)', async () => {
    const host = snapshotHost();
    git(host.cwd, ['checkout', '-qb', 'develop']);
    const { handler } = handlerOver([host.cwd]);
    await commitHeadline(handler, host, 'Pushed');
    const bare = bareRemote(host.cwd, 'origin');

    const first = await post(handler, `/api/site/push${at(host)}`, {});
    expect(first.status).toBe(200);
    expect(first.body['upstream']).toBe('origin');
    expect(first.body['branch']).toBe('develop');
    expect(String(first.body['output'])).toContain('develop');
    expect(first.body['at']).toMatchObject({ branch: 'develop', upstream: 'origin/develop', ahead: 0 });
    expect(git(host.cwd, ['config', '--get', 'branch.develop.remote']).out.trim()).toBe('origin');

    await commitHeadline(handler, host, 'Pushed again');
    const second = await post(handler, `/api/site/push${at(host)}`, {});
    expect(second.status).toBe(200);
    expect(second.body['upstream']).toBeUndefined();
    expect(second.body['at']).toMatchObject({ upstream: 'origin/develop', ahead: 0 });
    expect(git(bare, ['rev-parse', 'develop']).out.trim()).toBe(git(host.cwd, ['rev-parse', 'HEAD']).out.trim());
  });

  it('pushes to remote.pushDefault over branch.<b>.remote, git’s own order', async () => {
    const host = snapshotHost();
    git(host.cwd, ['checkout', '-qb', 'develop']);
    const { handler } = handlerOver([host.cwd]);
    bareRemote(host.cwd, 'origin');
    const other = bareRemote(host.cwd, 'other');
    git(host.cwd, ['config', 'remote.pushDefault', 'other']);
    git(host.cwd, ['config', 'branch.develop.remote', 'origin']);
    git(host.cwd, ['config', 'branch.develop.merge', 'refs/heads/develop']);
    const pushed = await post(handler, `/api/site/push${at(host)}`, {});
    expect(pushed.status).toBe(200);
    expect(pushed.body['upstream']).toBe('other');
    expect(git(other, ['rev-parse', 'develop']).out.trim()).toBe(git(host.cwd, ['rev-parse', 'HEAD']).out.trim());
  });

  it('refuses several remotes none of which is chosen, naming them, and pushes nothing', async () => {
    const host = snapshotHost();
    git(host.cwd, ['checkout', '-qb', 'develop']);
    const { handler } = handlerOver([host.cwd]);
    const a = bareRemote(host.cwd, 'a');
    const b = bareRemote(host.cwd, 'b');
    const refused = await post(handler, `/api/site/push${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('cannot push develop: several remotes and none chosen for develop: a, b');
    expect(refused.body['at']).toMatchObject({ branch: 'develop', upstream: null });
    for (const bare of [a, b]) expect(gitData(bare, ['rev-parse', '--verify', '-q', 'develop']).code).not.toBe(0);
  });

  it('refuses a checkout with no remote', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const branch = gitState(host.cwd).branch as string;
    const refused = await post(handler, `/api/site/push${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe(`cannot push ${branch}: this checkout has no remote`);
  });

  it('refuses a detached HEAD and pushes nothing', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const bare = bareRemote(host.cwd, 'origin');
    git(host.cwd, ['checkout', '-q', '--detach']);
    const refused = await post(handler, `/api/site/push${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('HEAD is detached — check out a branch to push');
    expect(git(bare, ['for-each-ref']).out.trim()).toBe('');
  });

  it('answers git’s own text when the push fails', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    git(host.cwd, ['remote', 'add', 'origin', join(tempDir(), 'missing.git')]);
    const failed = await post(handler, `/api/site/push${at(host)}`, {});
    expect(failed.status).toBe(409);
    expect(failed.body['error']).toBe('git push failed');
    expect(String(failed.body['output'])).toMatch(/does not appear to be a git repository|not found/);
    expect(failed.body['at']).toMatchObject({ upstream: null });
  });

  it('carries the live branch in the site reply: the remote’s HEAD symref, else null', async () => {
    const host = snapshotHost();
    const branch = gitState(host.cwd).branch as string;
    const { handler } = handlerOver([host.cwd]);
    const site = async (): Promise<Record<string, any>> =>
      (await (await handler(req(`/api/site${at(host)}`))).json()) as Record<string, any>;
    expect((await site()).git.live).toBeNull();
    bareRemote(host.cwd, 'origin');
    git(host.cwd, ['push', '-q', '-u', 'origin', branch]);
    expect((await site()).git.live).toBeNull();
    git(host.cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
    const read = await site();
    expect(read.git.live).toBe(branch);
    expect(read.git).toMatchObject({ branch, upstream: `origin/${branch}` });
  });
});

/**
 * A second page for the static-HTML twin, whose marks `index.html` does not
 * share — so a save of an index key leaves it alone, and a conflict on it
 * leaves the site loadable.
 */
const ABOUT_PAGE =
  '<!DOCTYPE html>\n<html><body><h1>About the partner team at the lab</h1>\n' +
  '<p>Every partner we work with signs one agreement first.</p></body></html>\n';

/** Hand-written html, written after the adoption so it carries no mark. */
const NOTES_PAGE = '<html><body><p>Working notes, mine.</p></body></html>\n';

/** The keys a document carries a mark for. */
function marksIn(cwd: string, rel: string): string[] {
  return [...readFileSync(join(cwd, rel), 'utf8').matchAll(/data-stet="([^"]+)"/g)].map((m) => m[1] as string);
}

/** The checkout committed at `top` with `left` out of the first commit, which leaves it untracked. */
function gitInitWithout(top: string, left: string): void {
  git(top, ['init', '-q']);
  git(top, ['config', 'user.email', 'dev@test']);
  git(top, ['config', 'user.name', 'dev']);
  git(top, ['config', 'commit.gpgsign', 'false']);
  git(top, ['add', '-A']);
  git(top, ['reset', '-q', '--', left]);
  git(top, ['commit', '-qm', 'base']);
}

/** The keys the checkout's descriptor derives from another. */
function derivedIn(cwd: string): string[] {
  const keys = (JSON.parse(readFileSync(join(cwd, 'content/descriptor.json'), 'utf8')) as Descriptor).keys;
  return Object.keys(keys).filter((key) => keys[key]?.derivesFrom !== undefined);
}

/** A subject as the commit route clips it. */
const clip72 = (text: string): string => (text.length <= 72 ? text : `${text.slice(0, 71)}…`);

type Kind = 'js' | 'html';

/**
 * One checkout of either host kind, committed, and the key a save changes.
 * On the JavaScript twin that is the mini project's `hero_headline`; on the
 * static-HTML twin a key marked in `index.html` alone. `folder` builds the
 * checkout as that folder of its repository; `untracked` leaves the snapshot
 * out of the first commit.
 */
interface Twin {
  kind: Kind;
  /** The checkout. */
  cwd: string;
  /** The repository's top — the checkout itself unless `folder` was given. */
  top: string;
  key: string;
  /** What a save of `key` writes. */
  written: string[];
}

async function twin(
  kind: Kind,
  opts: { folder?: string; config?: Record<string, unknown>; files?: Record<string, string>; untracked?: boolean } = {},
): Promise<Twin> {
  let source: string;
  if (kind === 'js') {
    const host = makeCliHost({ config: { project: 't', ...opts.config } });
    const at = (rel: string): string => join(host.cwd, rel);
    const descriptor = loadDescriptor(JSON.parse(readFileSync(at('content/descriptor.json'), 'utf8')));
    writeJsonDeterministic(at('content/descriptor.json'), descriptor);
    const snapshot = loadSnapshot(JSON.parse(readFileSync(at('content/defaults.json'), 'utf8')));
    writeJsonDeterministic(at('content/defaults.json'), snapshot);
    const registry = generateRegistry(descriptor);
    writeFileSync(at('content/keys.ts'), registry.keysTs);
    writeFileSync(at('content/stet-env.d.ts'), registry.dts);
    writeFileSync(at('content/defaults.ts'), generateDefaultsModule(snapshot));
    mkdirSync(at('lib'), { recursive: true });
    writeFileSync(at('lib/content.ts'), 'export const copy = () => "";\n', 'utf8');
    for (const [rel, text] of Object.entries(opts.files ?? {})) write(host.cwd, rel, text);
    source = host.cwd;
  } else {
    const host = await makeHtmlHost({
      files: { 'about.html': ABOUT_PAGE, ...opts.files },
      register: true,
      ...(opts.config === undefined ? {} : { config: opts.config }),
    });
    source = host.cwd;
  }
  const top = opts.folder === undefined ? source : tempDir('stet-top-');
  const cwd = opts.folder === undefined ? source : join(top, opts.folder);
  if (opts.folder !== undefined) cpSync(source, cwd, { recursive: true });
  if (opts.untracked === true) gitInitWithout(top, relative(top, join(cwd, 'content/defaults.json')));
  else gitInit(top);
  const key =
    kind === 'js'
      ? 'hero_headline'
      : (marksIn(cwd, 'index.html').filter((k) => !marksIn(cwd, 'about.html').includes(k)).sort()[0] as string);
  expect(key).toBeDefined();
  return {
    kind,
    cwd: realpathSync(cwd),
    top: realpathSync(top),
    key,
    written: kind === 'js' ? ['content/defaults.json', 'content/defaults.ts', 'content/resolved.ts'] : ['content/defaults.json', 'index.html'],
  };
}

describe('the committable files', () => {
  const at = (t: Twin): string => `?site=${encodeURIComponent(t.cwd)}`;
  const porcelain = (cwd: string): string => git(cwd, ['status', '--porcelain']).out;
  const subject = (cwd: string): string => git(cwd, ['log', '-1', '--format=%s']).out.trim();
  const head = (cwd: string): string => git(cwd, ['rev-parse', 'HEAD']).out.trim();
  const save = (handler: (r: Request) => Promise<Response>, t: Twin, value = 'A pending line') =>
    post(handler, `/api/site/save${at(t)}`, { values: [{ key: t.key, value }] });
  /** Two branches that append different lines to `rel`, merged or picked into a conflict on it. */
  const conflictOn = (t: Twin, rel: string, how: 'merge' | 'cherry-pick'): void => {
    const base = git(t.top, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
    const file = join(t.cwd, rel);
    const text = readFileSync(file, 'utf8');
    git(t.top, ['checkout', '-qb', 'theirs']);
    writeFileSync(file, `${text}// theirs\n`);
    git(t.top, ['commit', '-qam', 'theirs']);
    git(t.top, ['checkout', '-q', base]);
    writeFileSync(file, `${text}// ours\n`);
    git(t.top, ['commit', '-qam', 'ours']);
    expect(git(t.top, how === 'merge' ? ['merge', 'theirs'] : ['cherry-pick', 'theirs']).code).not.toBe(0);
  };

  for (const kind of ['js', 'html'] as const) {
    describe(`on the ${kind === 'js' ? 'JavaScript' : 'static-HTML'} host`, () => {
      it('answers the saved forms on every read, across a restart and a same-value re-save (journey B18)', async () => {
        const t = await twin(kind);
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        expect([...(saved.body['written'] as string[])].sort()).toEqual(t.written);
        expect(saved.body['pending']).toEqual(t.written);
        expect((await get(handler, `/api/site${at(t)}`)).pending).toEqual(t.written);
        // A fresh server over the same checkout: nothing remembered, the same answer.
        expect((await get(handlerOver([t.cwd]).handler, `/api/site${at(t)}`)).pending).toEqual(t.written);
        const again = await save(handler, t);
        expect(again.body['written']).toEqual([]);
        expect(again.body['pending']).toEqual(t.written);
      });

      it('leaves the forms unstaged when a hook refuses, so the operator’s next commit carries only its own file', async () => {
        // The snapshot untracked too: it reaches the commit through `add -N`.
        const t = await twin(kind, { untracked: true });
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        const hook = join(t.top, '.git/hooks/pre-commit');
        mkdirSync(dirname(hook), { recursive: true });
        writeFileSync(hook, '#!/bin/sh\necho refusing\nexit 1\n', { mode: 0o755 });
        const before = head(t.top);
        const refused = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
        expect(refused.status).toBe(409);
        expect(head(t.top)).toBe(before);
        expect(git(t.top, ['diff', '--cached', '--name-only']).out).toBe('');

        rmSync(hook);
        write(t.top, 'mine.md', 'the operator’s own\n');
        git(t.top, ['add', 'mine.md']);
        git(t.top, ['commit', '-qm', 'mine']);
        expect(git(t.top, ['show', '--name-only', '--format=', 'HEAD']).out.trim()).toBe('mine.md');
        // The page's own commit still carries every form.
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
        expect(made.status).toBe(200);
        expect(made.body['pending']).toEqual([]);
      });

      it('never lists an unrelated file, an unmarked document or a deletion', async () => {
        const t = await twin(kind);
        write(t.cwd, 'notes.txt', 'stray\n');
        if (kind === 'html') {
          // Written after the adoption, so no mark: hand-written html the managed glob matches.
          write(t.cwd, 'notes.html', NOTES_PAGE);
          git(t.cwd, ['add', 'notes.html']);
          git(t.cwd, ['commit', '-qm', 'notes']);
          write(t.cwd, 'notes.html', '<html><body><p>Half a thought.</p></body></html>\n');
          rmSync(join(t.cwd, 'about.html'));
        } else {
          rmSync(join(t.cwd, 'content/keys.ts'));
        }
        const { handler } = handlerOver([t.cwd]);
        expect((await get(handler, `/api/site${at(t)}`)).pending).toEqual([]);
      });

      it('commits the pending forms with no keys named, titled by the key the snapshot changed', async () => {
        const t = await twin(kind);
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
        expect(made.status).toBe(200);
        // The JavaScript twin's `seo_home_title` derives from its headline, so its text changed too.
        expect(made.body['subject']).toBe(
          kind === 'js' ? 'stet: 2 keys updated — hero_headline, seo_home_title' : `stet: 1 key updated — ${t.key}`,
        );
        expect(made.body['pending']).toEqual([]);
        expect(git(t.cwd, ['show', '--name-only', '--format=', 'HEAD']).out.trim().split('\n').sort()).toEqual(t.written);
      });

      it('titles a commit that changes no value by its files', async () => {
        const t = await twin(kind);
        const rel = kind === 'js' ? 'content/keys.ts' : 'content/descriptor.json';
        write(t.cwd, rel, `${readFileSync(join(t.cwd, rel), 'utf8')}${kind === 'js' ? '// a comment\n' : '\n'}`);
        const { handler } = handlerOver([t.cwd]);
        expect((await get(handler, `/api/site${at(t)}`)).pending).toEqual([rel]);
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: [rel] });
        expect(made.status).toBe(200);
        expect(subject(t.cwd)).toBe(`stet: 1 file updated — ${rel}`);
      });

      it('names every key an untracked snapshot holds, clipped at 72', async () => {
        const t = await twin(kind, { untracked: true });
        expect(porcelain(t.cwd)).toContain('?? content/defaults.json');
        const { handler } = handlerOver([t.cwd]);
        expect((await get(handler, `/api/site${at(t)}`)).pending).toEqual(['content/defaults.json']);
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: ['content/defaults.json'] });
        expect(made.status).toBe(200);
        const snapshot = JSON.parse(readFileSync(join(t.cwd, 'content/defaults.json'), 'utf8')) as Record<string, object>;
        // HEAD holds no snapshot, so every key on disk changed, the derived ones with their sources.
        const keys = [...new Set([...Object.values(snapshot).flatMap((block) => Object.keys(block)), ...derivedIn(t.cwd)])].sort();
        expect(keys.length).toBe(kind === 'js' ? 25 : Object.keys((snapshot as Record<string, object>)['default'] ?? {}).length);
        expect(subject(t.cwd)).toBe(clip72(`stet: ${keys.length} keys updated — ${keys.join(', ')}`));
      });

      it('uses the checkout’s own paths where the checkout is a folder of its repository (journey B18)', async () => {
        const t = await twin(kind, { folder: 'site' });
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        expect(saved.body['pending']).toEqual(t.written);
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
        expect(made.status).toBe(200);
        expect(made.body['pending']).toEqual([]);
        expect(git(t.top, ['show', '--name-only', '--format=', 'HEAD']).out.trim().split('\n').sort()).toEqual(
          t.written.map((rel) => `site/${rel}`),
        );
      });

      it('commits a form the config spells with ./ (journey B18)', async () => {
        const t = await twin(kind, {
          ...(kind === 'html' ? { folder: 'site' } : {}),
          config: { descriptorPath: './content/descriptor.json', snapshotPath: './content/defaults.json' },
        });
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        expect(saved.body['pending']).toContain('content/defaults.json');
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
        expect(made.status).toBe(200);
        expect(made.body['pending']).toEqual([]);
        expect(porcelain(t.top)).toBe('');
      });

      it('refuses a stale list naming a form committed in the terminal since, or deleted, and commits nothing', async () => {
        const t = await twin(kind);
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        const stale = saved.body['pending'] as string[];
        const other = stale.find((rel) => rel !== 'content/defaults.json') as string;
        git(t.cwd, ['commit', '-qm', 'from the terminal', '--', other]);
        const before = head(t.cwd);
        const refused = await post(handler, `/api/site/commit${at(t)}`, { files: stale });
        expect(refused.status).toBe(400);
        expect(refused.body['error']).toBe(`${other} has nothing to commit`);
        expect(refused.body['pending']).toEqual(stale.filter((rel) => rel !== other));
        expect(head(t.cwd)).toBe(before);

        rmSync(join(t.cwd, other));
        const deleted = await post(handler, `/api/site/commit${at(t)}`, { files: ['content/defaults.json', other] });
        expect(deleted.status).toBe(400);
        // A deleted document no longer carries the mark that made it stet's, so
        // it is refused as no form at all; a codegen file is a form by its path.
        expect(deleted.body['error']).toBe(
          kind === 'js' ? `${other} has nothing to commit` : `${other} is not a stet-written form of this site`,
        );
        expect(head(t.cwd)).toBe(before);
      });

      it('titles a commit without the snapshot by its files, and leaves the snapshot pending', async () => {
        const t = await twin(kind);
        const { handler } = handlerOver([t.cwd]);
        await save(handler, t);
        const other = t.written.find((rel) => rel !== 'content/defaults.json') as string;
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: [other] });
        expect(made.status).toBe(200);
        expect(subject(t.cwd)).toBe(`stet: 1 file updated — ${other}`);
        expect(made.body['pending']).toEqual(t.written.filter((rel) => rel !== other));
      });

      it('leaves a conflicted form out, and refuses a commit while the merge runs', async () => {
        const t = await twin(kind);
        const rel = kind === 'js' ? 'content/keys.ts' : 'about.html';
        conflictOn(t, rel, 'merge');
        const { handler } = handlerOver([t.cwd]);
        expect((await get(handler, `/api/site${at(t)}`)).pending).toEqual([]);
        const refused = await post(handler, `/api/site/commit${at(t)}`, { files: [rel] });
        expect(refused.status).toBe(409);
        expect(refused.body['error']).toBe('a merge, cherry-pick, revert or rebase is in progress — finish it in the terminal');
        expect(refused.body['pending']).toEqual([]);
        expect(porcelain(t.cwd)).toContain(`UU ${rel}`);
      });

      for (const how of ['merge', 'cherry-pick'] as const) {
        it(`stages nothing into a conflicted ${how}, even after a save`, async () => {
          const t = await twin(kind);
          const rel = kind === 'js' ? 'content/keys.ts' : 'about.html';
          conflictOn(t, rel, how);
          const { handler } = handlerOver([t.cwd]);
          const saved = await save(handler, t);
          expect(saved.status).toBe(200);
          expect(saved.body['pending']).toEqual(t.written);
          const before = head(t.cwd);
          const refused = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
          // The forms stay unstaged: `git add` never ran into the operation's index.
          const status = porcelain(t.cwd);
          for (const form of t.written) expect(status).toContain(` M ${form}`);
          expect(status).toContain(`UU ${rel}`);
          expect(refused.status).toBe(409);
          expect(refused.body['error']).toBe('a merge, cherry-pick, revert or rebase is in progress — finish it in the terminal');
          expect(head(t.cwd)).toBe(before);
        });
      }

      it('refuses an empty list, carrying the pending forms', async () => {
        const t = await twin(kind);
        const { handler } = handlerOver([t.cwd]);
        await save(handler, t);
        const refused = await post(handler, `/api/site/commit${at(t)}`, { files: [] });
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: 'files is required', pending: t.written });
      });

      for (const folder of [undefined, 'site'] as const) {
        it(`lets the checkout’s own hook select the staged files by glob${folder === undefined ? '' : ' from a subfolder checkout'} (journey B18)`, async () => {
          const t = await twin(kind, folder === undefined ? {} : { folder });
          const glob = kind === 'js' ? '*.json' : '*.html';
          const hooks = join(t.top, '.git', 'hooks');
          mkdirSync(hooks, { recursive: true });
          writeFileSync(
            join(hooks, 'pre-commit'),
            '#!/bin/sh\necho "literal=${GIT_LITERAL_PATHSPECS-unset}"\n' +
              `staged=$(git diff --cached --name-only -- '${glob}')\n` +
              'if [ -n "$staged" ]; then echo "refusing: $staged"; exit 1; fi\n',
            { mode: 0o755 },
          );
          const { handler } = handlerOver([t.cwd]);
          const saved = await save(handler, t);
          const before = head(t.cwd);
          const refused = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
          expect(refused.status).toBe(409);
          expect(String(refused.body['output'])).toContain('literal=unset');
          expect(String(refused.body['output'])).toContain('refusing: ');
          expect(refused.body['pending']).toEqual(t.written);
          expect(head(t.cwd)).toBe(before);
        });
      }

      it('titles a commit repairing a null locale block with every key on disk', async () => {
        const t = await twin(kind, { config: { locales: { default: 'default', enabled: ['default', 'de'] } } });
        const file = join(t.cwd, 'content/defaults.json');
        const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        writeFileSync(file, `${JSON.stringify({ ...snapshot, de: null }, null, 2)}\n`);
        git(t.cwd, ['commit', '-qam', 'a null block']);
        const repaired = { ...snapshot, de: { [t.key]: 'Eine Zeile' } };
        writeFileSync(file, `${JSON.stringify(repaired, null, 2)}\n`);
        const { handler } = handlerOver([t.cwd]);
        const made = await post(handler, `/api/site/commit${at(t)}`, { files: ['content/defaults.json'] });
        expect(made.status).toBe(200);
        // HEAD's snapshot is refused, so every key on disk changed, the derived ones with their sources.
        const keys = [
          ...new Set([...Object.values(repaired).flatMap((block) => Object.keys(block as object)), ...derivedIn(t.cwd)]),
        ].sort();
        if (kind === 'js') expect(keys.length).toBe(25);
        expect(subject(t.cwd)).toBe(clip72(`stet: ${keys.length} keys updated — ${keys.join(', ')}`));
      });
    });
  }

  it('commits a marked p[ab].html and never stages the unmarked pb.html beside it', async () => {
    const t = await twin('html', { files: { 'p[ab].html': ABOUT_PAGE.replace('partner team', 'bracketed team') } });
    expect(marksIn(t.cwd, 'p[ab].html').length).toBeGreaterThan(0);
    write(t.cwd, 'pb.html', NOTES_PAGE);
    git(t.cwd, ['add', 'pb.html']);
    git(t.cwd, ['commit', '-qm', 'an unmarked page']);
    write(t.cwd, 'pb.html', '<html><body><p>Edited by hand.</p></body></html>\n');
    const key = marksIn(t.cwd, 'p[ab].html')[0] as string;
    const { handler } = handlerOver([t.cwd]);
    const saved = await post(handler, `/api/site/save${at(t)}`, { values: [{ key, value: 'A bracketed line' }] });
    expect(saved.body['pending']).toEqual(['content/defaults.json', 'p[ab].html']);
    const made = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
    expect(made.status).toBe(200);
    expect(porcelain(t.cwd)).toBe(' M pb.html\n');
  });

  // Root reads through mode 000, so the case proves nothing there.
  it.skipIf(process.getuid?.() === 0)('opens a site whose managed glob holds a document it cannot read', async () => {
    const t = await twin('html');
    write(t.cwd, 'locked.html', NOTES_PAGE);
    chmodSync(join(t.cwd, 'locked.html'), 0o000);
    try {
      const { handler } = handlerOver([t.cwd]);
      const res = await handler(req(`/api/site${at(t)}`));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { pending: string[] }).pending).toEqual([]);
    } finally {
      chmodSync(join(t.cwd, 'locked.html'), 0o644);
    }
  });

  it('lists a document by stet’s reading of the managed glob, which git reads otherwise', async () => {
    // `[` is a character to stet and a class to git; `**` beside a name
    // crosses folders for stet and is a plain `*` for git.
    for (const [glob, file] of [
      ['[en]/*.html', '[en]/index.html'],
      ['docs/**.html', 'docs/a/index.html'],
    ] as const) {
      const host = await makeHtmlHost({
        files: { [file]: htmlFixture('index.html') },
        register: true,
        config: { managedSurfaces: [glob] },
      });
      gitInit(host.cwd);
      const cwd = realpathSync(host.cwd);
      const key = marksIn(cwd, file).sort()[0] as string;
      expect(key, glob).toBeDefined();
      const { handler } = handlerOver([cwd]);
      const site = `?site=${encodeURIComponent(cwd)}`;
      const saved = await post(handler, `/api/site/save${site}`, { values: [{ key, value: 'A line both readings agree on' }] });
      expect([...(saved.body['pending'] as string[])].sort(), glob).toEqual(['content/defaults.json', file].sort());
      const made = await post(handler, `/api/site/commit${site}`, { files: saved.body['pending'] });
      expect(made.status, glob).toBe(200);
      expect(git(cwd, ['status', '--porcelain']).out, glob).toBe('');
    }
  });

  for (const kind of ['js', 'html'] as const) {
    // The shipped gate runs the stet installed in the checkout — here the built
    // bin, behind a resolve hook that hides `typescript`.
    it.skipIf(!builtBinExists())(
      `shows the shipped gate’s refusal where scan cannot load typescript, on the ${kind} host (journey B18)`,
      async () => {
        const t = await twin(kind, {
          config: { copyModules: ['src/copy.ts'] },
          files: { 'src/copy.ts': "export const copy = { tagline: 'A line of copy' };\n" },
        });
        installStetShim(t.cwd, { hideTypescript: true });
        const io: CliIo = { cwd: t.cwd, env: {}, stdout: () => {}, stderr: () => {} };
        expect(await runHookInstall([], io)).toBe(0);
        const { handler } = handlerOver([t.cwd]);
        const saved = await save(handler, t);
        const before = head(t.cwd);
        const refused = await post(handler, `/api/site/commit${at(t)}`, { files: saved.body['pending'] });
        expect(refused.status).toBe(409);
        expect(String(refused.body['output'])).toContain('stet could not load the TypeScript compiler it ships with — reinstall stet: npm i @getstet/stet');
        expect(refused.body['pending']).toEqual(t.written);
        expect(head(t.cwd)).toBe(before);
      },
      30_000,
    );
  }
});

const START = 'Start a conversation ↗';
const BOOK = 'Book an introductory call ↗';
/**
 * psyon.ai's forms at 3ca2faf: the header's button key in three places, the
 * contact button's own words in one, the nav's third link marked again in the
 * footer beside two footer links; a brand key and a derived key holding the
 * header's words, neither of which a save may link.
 */
const PSYON_FORMS_PAGE = [
  '<!DOCTYPE html>',
  '<html><head><title data-stet="home_page_title">Psyon data partnerships</title></head><body>',
  `<header><a href="#c" data-stet="home_header_link_text">${START}</a></header>`,
  `<section id="about"><h2>About</h2><a href="#c" data-stet="home_header_link_text">${START}</a></section>`,
  `<section id="contact"><h2>Contact</h2><a href="#c" data-stet="home_contact_link_text">${BOOK}</a></section>`,
  '<nav><a href="#s" data-stet="home_nav_link_text_3">Data sourcing</a></nav>',
  '<footer>',
  `<a href="#c" data-stet="home_header_link_text">${START}</a>`,
  '<a href="#p" data-stet="home_footer_link_text">Privacy</a>',
  '<a href="#t" data-stet="home_footer_link_text_2">Terms</a>',
  '<a href="#s" data-stet="home_nav_link_text_3">Data sourcing</a>',
  '</footer>',
  '</body></html>',
  '',
].join('\n');

async function psyonFormsHost(): Promise<CliHost> {
  const host = await makeHtmlHost({
    files: { 'index.html': PSYON_FORMS_PAGE },
    keys: {
      home_page_title: { shape: 'text', target: 'web' },
      home_header_link_text: { shape: 'text', target: 'web' },
      home_contact_link_text: { shape: 'text', target: 'web' },
      home_nav_link_text_3: { shape: 'text', target: 'web' },
      home_footer_link_text: { shape: 'text', target: 'web' },
      home_footer_link_text_2: { shape: 'text', target: 'web' },
      brand__cta: { shape: 'text', target: 'web' },
      home_cta_echo: { shape: 'text', target: 'web', derivesFrom: 'home_contact_link_text', tmpl: '{v}' },
    },
    defaults: {
      home_page_title: 'Psyon data partnerships',
      home_header_link_text: START,
      home_contact_link_text: BOOK,
      home_nav_link_text_3: 'Data sourcing',
      home_footer_link_text: 'Privacy',
      home_footer_link_text_2: 'Terms',
      brand__cta: START,
    },
  });
  for (const rel of ['content/descriptor.json', 'content/defaults.json']) {
    writeJsonDeterministic(join(host.cwd, rel), JSON.parse(host.file(rel)));
  }
  gitInit(host.cwd);
  return host;
}

describe('the same words, Link them and Give this place its own key (D9, D13)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;

  it('answers same when a save gives a key the words another key holds — never a brand or derived key', async () => {
    const host = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_contact_link_text', value: START }] });
    expect(saved.status).toBe(200);
    expect(saved.body['same']).toEqual([{ key: 'home_contact_link_text', others: ['home_header_link_text'] }]);
  });

  it('answers no same where the pair already held the same words before the save', async () => {
    const host = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_contact_link_text', value: START }] });
    // The contact key saved again with the words it and the header already share.
    const again = await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_contact_link_text', value: START }] });
    expect(again.status).toBe(200);
    expect(again.body['same']).toEqual([]);
    // A save elsewhere leaves the equal pair alone and asks nothing.
    const other = await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_footer_link_text', value: 'Privacy policy' }] });
    expect(other.body['same']).toEqual([]);
  });

  it('answers no same for words no other key holds, and in a locale other than the default', async () => {
    const host = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    const fresh = await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_contact_link_text', value: 'Talk to us ↗' }] });
    expect(fresh.body['same']).toEqual([]);
  });

  it('links two keys through site/merge: the contact mark moves, the key goes, one batch', async () => {
    const host = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_contact_link_text', value: START }] });
    const linked = await post(handler, `/api/site/merge${at(host)}`, { key: 'home_contact_link_text', into: 'home_header_link_text' });
    expect(linked.status).toBe(200);
    expect(linked.body['written']).toEqual(['content/descriptor.json', 'content/defaults.json', 'index.html']);
    expect(host.file('index.html').match(/data-stet="home_header_link_text"/g)).toHaveLength(4);
    expect(host.file('index.html')).not.toContain('home_contact_link_text');
    expect(JSON.parse(host.file('content/descriptor.json')).keys).not.toHaveProperty('home_contact_link_text');
    expect(JSON.parse(host.file('content/defaults.json')).default).not.toHaveProperty('home_contact_link_text');
    // The derived key follows the survivor.
    expect(JSON.parse(host.file('content/descriptor.json')).keys['home_cta_echo'].derivesFrom).toBe('home_header_link_text');
    expect((linked.body['pending'] as string[]).sort()).toEqual(['content/defaults.json', 'content/descriptor.json', 'index.html']);
  });

  it('answers merge’s refusal lines with 409 and writes nothing', async () => {
    const host = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    const before = ['content/descriptor.json', 'content/defaults.json', 'index.html'].map((rel) => host.file(rel));
    const refused = await post(handler, `/api/site/merge${at(host)}`, { key: 'home_contact_link_text', into: 'home_header_link_text' });
    expect(refused.status).toBe(409);
    expect(refused.body['lines']).toEqual([`cannot merge: home_contact_link_text and home_header_link_text differ in default — "${BOOK}" and "${START}"`]);
    expect(refused.body['error']).toBe((refused.body['lines'] as string[]).join('\n'));
    expect(['content/descriptor.json', 'content/defaults.json', 'index.html'].map((rel) => host.file(rel))).toEqual(before);
  });

  it('refuses merge and split on a store-backed site', async () => {
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const { handler } = handlerOver([host.cwd]);
    const merged = await post(handler, `/api/site/merge${at(host)}`, { key: 'hero_headline', into: 'hero_subheadline' });
    expect(merged.status).toBe(409);
    expect(merged.body['error']).toBe('merge works on a snapshot-only site — use stet merge');
    const split = await post(handler, `/api/site/split${at(host)}`, { key: 'hero_headline', at: 'app/page.tsx:3' });
    expect(split.status).toBe(409);
    expect(split.body['error']).toBe('split works on a snapshot-only site — use stet split');
  });

  it('proposes the footer place’s own name, then splits it as the CLI does', async () => {
    const host = await psyonFormsHost();
    const cli = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    const asked = await post(handler, `/api/site/split${at(host)}`, { key: 'home_nav_link_text_3', at: 'index.html:11' });
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ proposed: 'home_footer_link_text_3' });
    expect(git(host.cwd, ['status', '--porcelain']).out).toBe('');

    const split = await post(handler, `/api/site/split${at(host)}`, { key: 'home_nav_link_text_3', at: 'index.html:11', name: 'home_footer_link_text_3' });
    expect(split.status).toBe(200);
    expect(split.body['key']).toBe('home_footer_link_text_3');
    expect(await cli.run('split', 'home_nav_link_text_3', 'home_footer_link_text_3', '--at', 'index.html:11', '--write')).toBe(0);
    for (const rel of ['content/descriptor.json', 'content/defaults.json', 'index.html']) expect(host.file(rel)).toBe(cli.file(rel));
  });

  it('answers split’s refusal lines with 409 and writes nothing', async () => {
    const host = await psyonFormsHost();
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/split${at(host)}`, { key: 'home_header_link_text', at: 'index.html:11', name: 'home_footer_link_text_3' });
    expect(refused.status).toBe(409);
    expect(refused.body['lines']).toEqual(['index.html:11 holds no mark or read of home_header_link_text']);
    expect(git(host.cwd, ['status', '--porcelain']).out).toBe('');
  });
});

/** A saved check-run payload from psyon-site, the Cloudflare account ids trimmed. */
const checkRuns = (sha: string): string => readFileSync(join(import.meta.dirname, 'fixtures', `check-runs-${sha}.json`), 'utf8');
const summariesOf = (sha: string): string[] =>
  (JSON.parse(checkRuns(sha)) as { check_runs: Array<{ output: { summary: string } }> }).check_runs.map((run) => run.output.summary);
/** The one answer a sequence of check runs gives: the Branch Preview URL of any run, else the first run's lone Preview URL. */
const previewOfRuns = (sha: string): string | null => {
  const found = summariesOf(sha).map(previewOfSummary).filter((p) => p !== null);
  return (found.find((p) => p.branch) ?? found[0])?.url ?? null;
};

describe('previewOfSummary and githubRepoOf (D11)', () => {
  it('reads the develop branch’s standing address from psyon-site’s check runs', () => {
    expect(previewOfRuns('c94b498')).toBe('https://develop.psyon-site.pages.dev');
    // The main push's run names only its own deploy; the develop run's Branch Preview URL wins.
    expect(previewOfSummary(summariesOf('c7b3961')[0] as string)).toEqual({ url: 'https://b34f4a0a.psyon-site.pages.dev', branch: false });
    expect(previewOfRuns('c7b3961')).toBe('https://develop.psyon-site.pages.dev');
  });

  it('answers null for a run still in progress', () => {
    expect(previewOfSummary(summariesOf('c94b498')[1] as string)).toBeNull();
  });

  it('reads an anchor whose href follows another attribute', () => {
    const summary = (summariesOf('c94b498')[0] as string).replaceAll("<a href='", '<a target="_blank" href=\'');
    expect(previewOfSummary(summary)).toEqual({ url: 'https://develop.psyon-site.pages.dev', branch: true });
  });

  it('parses the three GitHub remote forms, and nothing else', () => {
    expect(githubRepoOf('git@github.com:psyon/psyon-site.git')).toBe('psyon/psyon-site');
    expect(githubRepoOf('https://github.com/psyon/psyon-site.git')).toBe('psyon/psyon-site');
    expect(githubRepoOf('https://github.com/psyon/psyon-site')).toBe('psyon/psyon-site');
    expect(githubRepoOf('ssh://git@github.com/psyon/psyon-site.git\n')).toBe('psyon/psyon-site');
    expect(githubRepoOf('git@gitlab.com:psyon/psyon-site.git')).toBeNull();
    expect(githubRepoOf('/tmp/origin.git')).toBeNull();
  });
});

describe('GET /api/site/preview-link (D11)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  const savedPath = process.env['PATH'];
  afterAll(() => {
    process.env['PATH'] = savedPath;
  });

  /** A `gh` on PATH printing a fixture per API path, logging each call; a path with no fixture exits 1. */
  function stubGh(answers: { deployments?: unknown; statuses?: unknown; checkRuns?: string }): string {
    const dir = tempDir('stet-gh-');
    if (answers.deployments !== undefined) writeFileSync(join(dir, 'deployments.json'), JSON.stringify(answers.deployments));
    if (answers.statuses !== undefined) writeFileSync(join(dir, 'statuses.json'), JSON.stringify(answers.statuses));
    if (answers.checkRuns !== undefined) writeFileSync(join(dir, 'check-runs.json'), answers.checkRuns);
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${dir}/calls.log"`,
        'case "$2" in',
        `  */deployments/*/statuses) cat "${dir}/statuses.json" ;;`,
        `  */deployments\\?sha=*) cat "${dir}/deployments.json" ;;`,
        `  */check-runs\\?filter=all) cat "${dir}/check-runs.json" ;;`,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env['PATH'] = `${dir}:${savedPath}`;
    return dir;
  }

  /** A checkout on `develop` whose origin is psyon-site on GitHub. */
  function githubHost(): CliHost {
    const host = snapshotHost();
    git(host.cwd, ['checkout', '-qb', 'develop']);
    git(host.cwd, ['remote', 'add', 'origin', 'git@github.com:psyon/psyon-site.git']);
    return host;
  }

  it('answers the Branch Preview URL from the commit’s check runs through the operator’s gh', async () => {
    const host = githubHost();
    const gh = stubGh({ deployments: [], checkRuns: checkRuns('c7b3961') });
    const { handler } = handlerOver([host.cwd]);
    expect(await get(handler, `/api/site/preview-link${at(host)}`)).toEqual({ url: 'https://develop.psyon-site.pages.dev' });
    const head = git(host.cwd, ['rev-parse', 'HEAD']).out.trim();
    expect(readFileSync(join(gh, 'calls.log'), 'utf8').split('\n').filter(Boolean)).toEqual([
      `api repos/psyon/psyon-site/deployments?sha=${head}`,
      `api repos/psyon/psyon-site/commits/${head}/check-runs?filter=all`,
    ]);
  });

  it('takes a later successful deployment status, skipping an empty environment_url and a failure', async () => {
    const host = githubHost();
    stubGh({
      deployments: [{ id: 7 }, { id: 6 }],
      statuses: [
        { state: 'success', environment_url: '', target_url: 'https://github.com/psyon/psyon-site/actions/runs/1' },
        { state: 'failure', environment_url: 'https://failed.example.app' },
        { state: 'success', environment_url: 'https://psyon-site-git-develop.vercel.app' },
      ],
      checkRuns: checkRuns('c7b3961'),
    });
    const { handler } = handlerOver([host.cwd]);
    expect(await get(handler, `/api/site/preview-link${at(host)}`)).toEqual({ url: 'https://psyon-site-git-develop.vercel.app' });
  });

  it('answers null with no gh on PATH, and names a remote not on GitHub', async () => {
    const host = githubHost();
    const bin = tempDir('stet-nogh-');
    for (const tool of ['git', 'sh']) {
      const found = execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim();
      symlinkSync(found, join(bin, tool));
    }
    process.env['PATH'] = bin;
    const { handler } = handlerOver([host.cwd]);
    try {
      expect(await get(handler, `/api/site/preview-link${at(host)}`)).toEqual({ url: null });
    } finally {
      process.env['PATH'] = savedPath;
    }
    git(host.cwd, ['remote', 'set-url', 'origin', 'git@gitlab.com:psyon/psyon-site.git']);
    expect(await get(handler, `/api/site/preview-link${at(host)}`)).toEqual({ url: null, reason: 'not-github' });
  });

  it('answers null on the live branch without asking gh', async () => {
    const host = githubHost();
    git(host.cwd, ['checkout', '-qB', 'main']);
    const gh = stubGh({ deployments: [], checkRuns: checkRuns('c7b3961') });
    const { handler } = handlerOver([host.cwd]);
    expect(await get(handler, `/api/site/preview-link${at(host)}`)).toEqual({ url: null });
    expect(existsSync(join(gh, 'calls.log'))).toBe(false);
  });
});

describe('POST /api/site/publish-live (D11)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  const rev = (cwd: string, ref: string): string => git(cwd, ['rev-parse', ref]).out.trim();

  /**
   * A checkout on `develop` one commit ahead of `main`, both pushed to a bare
   * origin whose HEAD is `main`; `origin/HEAD` set locally unless `symref` is false.
   */
  function publishHost(opts: { symref?: boolean; ahead?: boolean } = {}): { host: CliHost; bare: string } {
    const host = snapshotHost();
    git(host.cwd, ['branch', '-M', 'main']);
    const bare = bareRemote(host.cwd, 'origin');
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(host.cwd, ['push', '-q', 'origin', 'main']);
    git(host.cwd, ['checkout', '-qb', 'develop']);
    if (opts.ahead !== false) {
      writeFileSync(join(host.cwd, 'notes.txt'), 'develop\n', 'utf8');
      git(host.cwd, ['add', 'notes.txt']);
      git(host.cwd, ['commit', '-qm', 'develop work']);
    }
    git(host.cwd, ['push', '-q', '-u', 'origin', 'develop']);
    if (opts.symref !== false) git(host.cwd, ['remote', 'set-head', 'origin', 'main']);
    return { host, bare };
  }

  it('fast-forwards the live branch to the branch’s commit, never switching the local branch', async () => {
    const { host, bare } = publishHost();
    const { handler } = handlerOver([host.cwd]);
    const published = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(published.status).toBe(200);
    expect(published.body['live']).toBe('main');
    expect(published.body['already']).toBeUndefined();
    expect(rev(bare, 'main')).toBe(rev(host.cwd, 'HEAD'));
    expect(gitState(host.cwd).branch).toBe('develop');
  });

  it('refuses where another clone advanced the live branch, pushing nothing', async () => {
    const { host, bare } = publishHost();
    const other = tempDir('stet-clone-');
    git(other, ['clone', '-q', bare, '.']);
    git(other, ['config', 'user.email', 'o@test']);
    git(other, ['config', 'user.name', 'o']);
    git(other, ['commit', '-q', '--allow-empty', '-m', 'hotfix on main']);
    git(other, ['push', '-q', 'origin', 'main']);
    const tip = rev(bare, 'main');
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('main has commits develop lacks — bring them into develop first');
    expect(rev(bare, 'main')).toBe(tip);
    expect(gitState(host.cwd).branch).toBe('develop');
  });

  it('refuses a live branch the remote no longer has', async () => {
    const { host, bare } = publishHost();
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    git(bare, ['branch', '-D', 'main']);
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('main does not exist on origin');
    expect(gitData(bare, ['rev-parse', '--verify', '-q', 'main']).code).not.toBe(0);
  });

  it('asks the remote for its HEAD where the local origin/HEAD is missing', async () => {
    const { host, bare } = publishHost({ symref: false });
    // The remote serves develop; this checkout publishes feature onto it.
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    git(host.cwd, ['checkout', '-qb', 'feature']);
    git(host.cwd, ['commit', '-q', '--allow-empty', '-m', 'feature work']);
    git(host.cwd, ['push', '-q', '-u', 'origin', 'feature']);
    expect(gitData(host.cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).code).not.toBe(0);
    const { handler } = handlerOver([host.cwd]);
    const published = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(published.status).toBe(200);
    expect(published.body['live']).toBe('develop');
    expect(rev(bare, 'develop')).toBe(rev(host.cwd, 'HEAD'));
    expect(rev(bare, 'main')).not.toBe(rev(host.cwd, 'HEAD'));
    expect(gitState(host.cwd).branch).toBe('feature');
  });

  it('pushes nothing where the live branch is already at HEAD', async () => {
    const { host, bare } = publishHost({ ahead: false });
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\necho pushed >> "${bare}/received.log"\n`, { mode: 0o755 });
    const { handler } = handlerOver([host.cwd]);
    const same = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ live: 'main', already: true, output: '' });
    expect(existsSync(join(bare, 'received.log'))).toBe(false);
  });

  it('refuses while a git operation is in progress, pushing nothing', async () => {
    const { host, bare } = publishHost();
    const tip = rev(bare, 'main');
    writeFileSync(join(host.cwd, '.git/MERGE_HEAD'), `${rev(host.cwd, 'HEAD')}\n`);
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('a merge, cherry-pick, revert or rebase is in progress — finish it in the terminal');
    expect(rev(bare, 'main')).toBe(tip);
  });

  it('refuses a live branch the remote holds only as the tail of another name', async () => {
    const { host, bare } = publishHost();
    git(bare, ['branch', 'feature/main', 'main']);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    git(bare, ['branch', '-D', 'main']);
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('main does not exist on origin');
    expect(gitData(bare, ['rev-parse', '--verify', '-q', 'main']).code).not.toBe(0);
  });

  it('publishes from a single-branch clone, whose fetch refspec names its own branch alone', async () => {
    const { bare } = publishHost();
    const clone = tempDir('stet-single-');
    git(clone, ['clone', '-q', '--single-branch', '--branch', 'develop', bare, '.']);
    git(clone, ['config', 'user.email', 'c@test']);
    git(clone, ['config', 'user.name', 'c']);
    git(clone, ['commit', '-q', '--allow-empty', '-m', 'clone work']);
    git(clone, ['push', '-q']);
    expect(git(clone, ['config', '--get', 'remote.origin.fetch']).out.trim()).toBe('+refs/heads/develop:refs/remotes/origin/develop');
    const { handler } = handlerOver([clone]);
    const published = await post(handler, `/api/site/publish-live?site=${encodeURIComponent(realpathSync(clone))}`, {});
    expect(published.status).toBe(200);
    expect(published.body['live']).toBe('main');
    expect(rev(bare, 'main')).toBe(rev(clone, 'HEAD'));
  });

  it('refuses a branch that is not level with its upstream', async () => {
    const { host, bare } = publishHost();
    const other = tempDir('stet-clone-');
    git(other, ['clone', '-q', bare, '.']);
    git(other, ['config', 'user.email', 'o@test']);
    git(other, ['config', 'user.name', 'o']);
    git(other, ['checkout', '-q', 'develop']);
    git(other, ['commit', '-q', '--allow-empty', '-m', 'develop elsewhere']);
    git(other, ['push', '-q', 'origin', 'develop']);
    git(host.cwd, ['fetch', '-q', 'origin']);
    const tip = rev(bare, 'main');
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('push develop first — it is not level with origin/develop');
    expect(refused.body['at']).toMatchObject({ behind: 1, ahead: 0 });
    expect(rev(bare, 'main')).toBe(tip);
  });

  it('refuses on the live branch and on a detached HEAD', async () => {
    const { host } = publishHost();
    const { handler } = handlerOver([host.cwd]);
    git(host.cwd, ['checkout', '-q', 'main']);
    const live = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(live.status).toBe(409);
    expect(live.body['error']).toBe('main is the live branch');
    git(host.cwd, ['checkout', '-q', '--detach']);
    const detached = await post(handler, `/api/site/publish-live${at(host)}`, {});
    expect(detached.status).toBe(409);
    expect(detached.body['error']).toBe('HEAD is detached — check out a branch to publish');
  });
});

const RESTORE_NAV = ['<nav class="site-nav">', '<a href="#value" data-stet="home_nav_link_text">Why it may have value</a>', '<a href="#process" data-stet="home_nav_link_text_2">How it works</a>'];
const FAQ_LINK = '<a href="#faq" data-stet="home_nav_link_text_3">FAQ</a>';
const OPERATING = [
  '<section id="operating">',
  '<h2 data-stet="home_operating_headline">Operating model</h2>',
  '<div class="row">',
  '<article class="card"><h3 data-stet="home_operating_card_1_headline">Scoped</h3><p data-stet="home_operating_card_1_text">Every project is scoped.</p></article>',
  '<article class="card"><h3 data-stet="home_operating_card_2_headline">Piloted</h3><p data-stet="home_operating_card_2_text">A pilot comes first.</p></article>',
  '</div>',
  '<aside id="terms"><p data-stet="home_terms_text">Terms apply.</p></aside>',
  '</section>',
].join('\n');
/** psyon.ai's shape before 67694e8: a nav whose last link is FAQ, and section#operating holding a headline, two cards and a terms note. */
const RESTORE_PAGE = [
  '<!DOCTYPE html>',
  '<html><head><title data-stet="home_page_title">Psyon</title></head><body>',
  '<header>',
  ...RESTORE_NAV,
  FAQ_LINK,
  '</nav>',
  '</header>',
  '<section id="hero"><h1 data-stet="home_hero_headline">You may already have the data.</h1></section>',
  OPERATING,
  '<footer><p data-stet="home_footer_text">Psyon Ltd</p></footer>',
  '</body></html>',
  '',
].join('\n');
const RESTORE_VALUES: Record<string, string> = {
  home_page_title: 'Psyon',
  home_nav_link_text: 'Why it may have value',
  home_nav_link_text_2: 'How it works',
  home_nav_link_text_3: 'FAQ',
  home_hero_headline: 'You may already have the data.',
  home_operating_headline: 'Operating model',
  home_operating_card_1_headline: 'Scoped',
  home_operating_card_1_text: 'Every project is scoped.',
  home_operating_card_2_headline: 'Piloted',
  home_operating_card_2_text: 'A pilot comes first.',
  home_terms_text: 'Terms apply.',
  home_footer_text: 'Psyon Ltd',
};
/** The keys 67694e8's shape removes: the FAQ link and everything section#operating marks. */
const REMOVED = [
  'home_nav_link_text_3',
  'home_operating_card_1_headline',
  'home_operating_card_1_text',
  'home_operating_card_2_headline',
  'home_operating_card_2_text',
  'home_operating_headline',
  'home_terms_text',
].sort();

describe('GET /api/site/removed and POST /api/site/restore (D12)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  const rev = (cwd: string, ref: string): string => git(cwd, ['rev-parse', ref]).out.trim();

  /** The page and its keys, committed with a notes file beside them. */
  async function restoreHost(): Promise<CliHost> {
    const host = await makeHtmlHost({
      files: { 'index.html': RESTORE_PAGE, 'notes.txt': 'launch notes\n' },
      keys: Object.fromEntries(Object.keys(RESTORE_VALUES).map((key) => [key, { shape: 'text', target: 'web' }])),
      defaults: RESTORE_VALUES,
    });
    for (const rel of ['content/descriptor.json', 'content/defaults.json']) {
      writeJsonDeterministic(join(host.cwd, rel), JSON.parse(host.file(rel)));
    }
    gitInit(host.cwd);
    return host;
  }

  /** One commit editing the forms and the page as `edit` says; answers its hash. */
  function commitForms(
    host: CliHost,
    message: string,
    edit: { keys?: (keys: Record<string, unknown>, values: Record<string, unknown>) => void; page?: (html: string) => string; notes?: string },
  ): string {
    const descriptor = JSON.parse(host.file('content/descriptor.json'));
    const snapshot = JSON.parse(host.file('content/defaults.json'));
    edit.keys?.(descriptor.keys, snapshot.default);
    writeJsonDeterministic(join(host.cwd, 'content/descriptor.json'), descriptor);
    writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), snapshot);
    if (edit.page) writeFileSync(join(host.cwd, 'index.html'), edit.page(host.file('index.html')));
    if (edit.notes !== undefined) writeFileSync(join(host.cwd, 'notes.txt'), edit.notes);
    git(host.cwd, ['add', '-A']);
    git(host.cwd, ['commit', '-qm', message]);
    return rev(host.cwd, 'HEAD');
  }

  /** 67694e8's shape: the FAQ link and section#operating removed with their seven keys, and the notes edited. */
  function removeOperating(host: CliHost): string {
    return commitForms(host, 'layout: the client’s rewrite', {
      keys: (keys, values) => {
        for (const key of REMOVED) {
          delete keys[key];
          delete values[key];
        }
      },
      page: (html) => html.replace(`${FAQ_LINK}\n`, '').replace(`${OPERATING}\n`, ''),
      notes: 'launch notes, rewritten\n',
    });
  }

  /** a7f8af6's shape: a later commit rewriting the nav lines around the removed link, and the value beside the removed keys. */
  function rewriteNav(host: CliHost): string {
    return commitForms(host, 'stet: rename the nav anchors', {
      keys: (_keys, values) => {
        values['home_nav_link_text_2'] = 'How we work';
      },
      page: (html) =>
        html
          .replace('<a href="#process" data-stet="home_nav_link_text_2">How it works</a>', '<a href="#services" data-stet="home_nav_link_text_2">How we work</a>')
          .replace('<a href="#value" data-stet="home_nav_link_text">', '<a href="#top" data-stet="home_nav_link_text">'),
    });
  }

  it('lists the keys a commit removed, each with the item-aware section word and its text at <sha>^', async () => {
    const host = await restoreHost();
    const sha = removeOperating(host);
    const { handler } = handlerOver([host.cwd]);
    const listed = await get(handler, `/api/site/removed${at(host)}&sha=${sha}`);
    const byKey = Object.fromEntries((listed.keys as Array<{ key: string; section: string | null; text: string }>).map((k) => [k.key, k]));
    expect(Object.keys(byKey)).toEqual(REMOVED);
    // The cards read the section above the repeated item, never `article`.
    expect(byKey['home_operating_card_1_headline']).toEqual({ key: 'home_operating_card_1_headline', section: 'operating', text: 'Scoped' });
    expect(byKey['home_operating_card_2_text']?.section).toBe('operating');
    expect(byKey['home_operating_headline']?.section).toBe('operating');
    expect(byKey['home_terms_text']).toEqual({ key: 'home_terms_text', section: 'terms', text: 'Terms apply.' });
    expect(byKey['home_nav_link_text_3']?.text).toBe('FAQ');
  });

  it('lists nothing for a rename commit', async () => {
    const host = await restoreHost();
    const sha = commitForms(host, 'stet: rename 1 key — home_footer_text → home_footer_note', {
      keys: (keys, values) => {
        keys['home_footer_note'] = keys['home_footer_text'];
        delete keys['home_footer_text'];
        values['home_footer_note'] = values['home_footer_text'];
        delete values['home_footer_text'];
      },
      page: (html) => html.replace('data-stet="home_footer_text"', 'data-stet="home_footer_note"'),
    });
    const { handler } = handlerOver([host.cwd]);
    expect(await get(handler, `/api/site/removed${at(host)}&sha=${sha}`)).toEqual({ keys: [] });
  });

  it('restores on the clean path: one revert commit, the document back, no markup', async () => {
    const host = await restoreHost();
    const base = rev(host.cwd, 'HEAD');
    const sha = removeOperating(host);
    const { handler } = handlerOver([host.cwd]);
    const restored = await post(handler, `/api/site/restore${at(host)}`, { sha });
    expect(restored.status).toBe(200);
    expect(restored.body['restored']).toEqual(REMOVED);
    expect(restored.body['markup']).toBeNull();
    expect(restored.body['subject']).toBe(`stet: restore 7 keys removed by ${sha.slice(0, 7)}`);
    expect(rev(host.cwd, 'HEAD~1')).toBe(sha);
    for (const rel of ['index.html', 'content/descriptor.json', 'content/defaults.json', 'notes.txt']) {
      expect(host.file(rel)).toBe(git(host.cwd, ['show', `${base}:./${rel}`]).out);
    }
    expect(git(host.cwd, ['status', '--porcelain']).out).toBe('');
    expect(operationInProgress(host.cwd)).toBe(false);
  });

  it('restores the keys alone where a later commit changed the same lines, and hands back the markup', async () => {
    const host = await restoreHost();
    const sha = removeOperating(host);
    const later = rewriteNav(host);
    const page = host.file('index.html');
    const { handler } = handlerOver([host.cwd]);
    const restored = await post(handler, `/api/site/restore${at(host)}`, { sha });
    expect(restored.status).toBe(200);
    expect(operationInProgress(host.cwd)).toBe(false);
    expect(rev(host.cwd, 'HEAD~1')).toBe(later);
    expect(restored.body['subject']).toBe(`stet: restore 7 keys removed by ${sha.slice(0, 7)}`);
    expect(git(host.cwd, ['show', '--name-only', '--format=', 'HEAD']).out.trim().split('\n')).toEqual(['content/defaults.json', 'content/descriptor.json']);
    const keys = JSON.parse(host.file('content/descriptor.json')).keys;
    const values = JSON.parse(host.file('content/defaults.json')).default;
    for (const key of REMOVED) {
      expect(keys).toHaveProperty(key);
      expect(values[key]).toBe(RESTORE_VALUES[key]);
    }
    // The later commit's words stay; the page is left as HEAD had it.
    expect(values['home_nav_link_text_2']).toBe('How we work');
    expect(host.file('index.html')).toBe(page);
    expect(git(host.cwd, ['status', '--porcelain']).out).toBe('');
    // The FAQ link alone, since its <nav> is still in HEAD's page; section#operating whole, its cards and terms note inside it.
    expect(restored.body['markup']).toEqual([
      { file: 'index.html', section: expect.any(String), text: FAQ_LINK },
      { file: 'index.html', section: 'operating', text: OPERATING },
    ]);
  });

  it('never hands back a mark of a key the commit left declared: a renamed section’s removed chips come back alone', async () => {
    const CHAIN = '<div class="chain">\n<span data-stet="chip_select">Select</span>\n<span data-stet="chip_deliver">Deliver</span>\n</div>';
    const DOES = `<section id="does">\n<h2 data-stet="does_headline">What we do</h2>\n${CHAIN}\n<p data-stet="does_note">Every batch is reviewed.</p>\n</section>`;
    const page = `<!DOCTYPE html>\n<html><head><title data-stet="home_page_title">Psyon</title></head><body>\n${DOES}\n</body></html>\n`;
    const values: Record<string, string> = { home_page_title: 'Psyon', does_headline: 'What we do', chip_select: 'Select', chip_deliver: 'Deliver', does_note: 'Every batch is reviewed.' };
    const host = await makeHtmlHost({
      files: { 'index.html': page },
      keys: Object.fromEntries(Object.keys(values).map((key) => [key, { shape: 'text', target: 'web' }])),
      defaults: values,
    });
    for (const rel of ['content/descriptor.json', 'content/defaults.json']) writeJsonDeterministic(join(host.cwd, rel), JSON.parse(host.file(rel)));
    gitInit(host.cwd);
    // 67694e8's shape: the section takes a new id and loses its chips; its headline and note stay declared.
    const sha = commitForms(host, 'layout: the chips removed', {
      keys: (keys, vals) => {
        for (const key of ['chip_select', 'chip_deliver']) {
          delete keys[key];
          delete vals[key];
        }
      },
      page: (html) => html.replace('<section id="does">', '<section id="services">').replace(`${CHAIN}\n`, ''),
    });
    commitForms(host, 'the note rewritten', {
      keys: (_keys, vals) => {
        vals['does_note'] = 'Every batch is reviewed twice.';
      },
      page: (html) => html.replace('Every batch is reviewed.', 'Every batch is reviewed twice.'),
    });
    const { handler } = handlerOver([host.cwd]);
    const restored = await post(handler, `/api/site/restore${at(host)}`, { sha });
    expect(restored.status).toBe(200);
    expect(restored.body['markup']).toEqual([{ file: 'index.html', section: 'does', text: CHAIN }]);
    for (const slice of restored.body['markup'] as Array<{ text: string }>) {
      expect([...slice.text.matchAll(/data-stet="([^"]+)"/g)].map((m) => m[1])).toEqual(['chip_select', 'chip_deliver']);
    }
  });

  it('leaves no REVERT_HEAD where the pre-commit gate refuses the restore commit', async () => {
    const host = await restoreHost();
    const sha = removeOperating(host);
    mkdirSync(join(host.cwd, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(host.cwd, '.git/hooks/pre-commit'), '#!/bin/sh\necho gate says no\nexit 1\n', { mode: 0o755 });
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('git commit failed');
    expect(String(refused.body['output'])).toContain('gate says no');
    expect(rev(host.cwd, 'HEAD')).toBe(sha);
    expect(operationInProgress(host.cwd)).toBe(false);
    expect(git(host.cwd, ['status', '--porcelain']).out).toBe('');
  });

  it('says the revert is left in progress where git refuses the abort after a refused commit', async () => {
    const host = await restoreHost();
    const sha = removeOperating(host);
    // A formatter-style hook: it edits a file the revert staged, then refuses, so the abort cannot reset it.
    mkdirSync(join(host.cwd, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(host.cwd, '.git/hooks/pre-commit'), '#!/bin/sh\necho formatted >> notes.txt\necho gate says no\nexit 1\n', { mode: 0o755 });
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('git revert --abort failed — finish it in the terminal');
    expect(String(refused.body['output'])).toContain('gate says no');
    expect(String(refused.body['output'])).toContain('notes.txt');
    expect(rev(host.cwd, 'HEAD')).toBe(sha);
    expect(operationInProgress(host.cwd)).toBe(true);
  });

  it('answers git’s output and writes nothing where the revert refuses to start', async () => {
    const host = await restoreHost();
    const main = gitState(host.cwd).branch as string;
    git(host.cwd, ['checkout', '-qb', 'rewrite']);
    removeOperating(host);
    git(host.cwd, ['checkout', '-q', main]);
    writeFileSync(join(host.cwd, 'footer.txt'), 'a footer\n');
    git(host.cwd, ['add', 'footer.txt']);
    git(host.cwd, ['commit', '-qm', 'footer']);
    git(host.cwd, ['merge', '-q', '--no-edit', '--no-ff', 'rewrite']);
    const merge = rev(host.cwd, 'HEAD');
    const { handler } = handlerOver([host.cwd]);
    expect((await get(handler, `/api/site/removed${at(host)}&sha=${merge}`)).keys).toHaveLength(7);
    const refused = await post(handler, `/api/site/restore${at(host)}`, { sha: merge });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('git revert failed');
    expect(String(refused.body['output'])).toContain('is a merge');
    expect(rev(host.cwd, 'HEAD')).toBe(merge);
    expect(git(host.cwd, ['status', '--porcelain']).out).toBe('');
  });

  describe('refuses, writing nothing', () => {
    it('for a hash that is not a commit, saying project', async () => {
      const host = await restoreHost();
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha: 'deadbeef' });
      expect(refused.status).toBe(400);
      expect(refused.body['error']).toBe('deadbeef is not a commit of this project');
    });

    it('while a stet file is uncommitted', async () => {
      const host = await restoreHost();
      const sha = removeOperating(host);
      const { handler } = handlerOver([host.cwd]);
      await post(handler, `/api/site/save${at(host)}`, { values: [{ key: 'home_footer_text', value: 'Psyon Limited' }] });
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('Restore waits for the uncommitted stet files — commit them first');
      expect(rev(host.cwd, 'HEAD')).toBe(sha);
    });

    it('while anything is staged, which the revert’s commit would carry', async () => {
      const host = await restoreHost();
      const sha = removeOperating(host);
      writeFileSync(join(host.cwd, 'draft.txt'), 'staged, unrelated\n');
      git(host.cwd, ['add', 'draft.txt']);
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('Restore waits for the staged changes — commit or unstage them first');
      expect(rev(host.cwd, 'HEAD')).toBe(sha);
      expect(git(host.cwd, ['show', '--name-only', '--format=', 'HEAD']).out).not.toContain('draft.txt');
    });

    it('while a file the commit touched holds uncommitted changes, naming it', async () => {
      const host = await restoreHost();
      const sha = removeOperating(host);
      writeFileSync(join(host.cwd, 'notes.txt'), 'launch notes, edited again\n');
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('Restore waits for the uncommitted changes to notes.txt — commit or discard them first');
      expect(host.file('notes.txt')).toBe('launch notes, edited again\n');
      expect(rev(host.cwd, 'HEAD')).toBe(sha);
    });

    it('while a file the commit touched was moved to an intent-to-add path, naming the path git reports', async () => {
      const host = await restoreHost();
      writeFileSync(join(host.cwd, 'old-notes.txt'), 'launch notes, the first draft\n');
      git(host.cwd, ['add', 'old-notes.txt']);
      git(host.cwd, ['commit', '-qm', 'old notes']);
      // The commit deletes old-notes.txt and rewrites notes.txt: both are paths it touched.
      rmSync(join(host.cwd, 'old-notes.txt'));
      const sha = removeOperating(host);
      renameSync(join(host.cwd, 'notes.txt'), join(host.cwd, 'old-notes.txt'));
      git(host.cwd, ['add', '-N', 'old-notes.txt']);
      // A rename in the worktree column: its source path is the next NUL field.
      expect(gitData(host.cwd, ['status', '--porcelain=v1', '-z', '--', 'notes.txt', 'old-notes.txt']).stdout).toBe(' R old-notes.txt\0notes.txt\0');
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('Restore waits for the uncommitted changes to old-notes.txt — commit or discard them first');
      expect(rev(host.cwd, 'HEAD')).toBe(sha);
    });

    it('while a git operation is in progress', async () => {
      const host = await restoreHost();
      const sha = removeOperating(host);
      writeFileSync(join(host.cwd, '.git/MERGE_HEAD'), `${sha}\n`);
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('a merge, cherry-pick, revert or rebase is in progress — finish it in the terminal');
      expect(rev(host.cwd, 'HEAD')).toBe(sha);
    });

    it('on a store-backed site', async () => {
      const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
      gitInit(host.cwd);
      const { handler } = handlerOver([host.cwd]);
      const refused = await post(handler, `/api/site/restore${at(host)}`, { sha: rev(host.cwd, 'HEAD') });
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe("restore works on a snapshot-only site's commits");
    });
  });
});

describe('GET /api/site/history', () => {
  it('lists the commits that touched the snapshot, newest first', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const path = `?site=${encodeURIComponent(realpathSync(host.cwd))}`;

    for (const value of ['First edit', 'Second edit']) {
      const saved = await post(handler, `/api/site/save${path}`, {
        values: [{ key: 'hero_headline', value }],
      });
      await post(handler, `/api/site/commit${path}`, {
        files: saved.body['written'] as string[],
        keys: ['hero_headline'],
        message: value,
      });
    }
    // One commit that touches something else entirely.
    writeFileSync(join(host.cwd, 'notes.txt'), 'stray\n', 'utf8');
    git(host.cwd, ['add', '--', 'notes.txt']);
    git(host.cwd, ['commit', '-qm', 'notes only', '--', 'notes.txt']);

    const body = (await (await handler(req(`/api/site/history${path}`))).json()) as {
      commits: Array<{ short: string; author: string; subject: string; at: string }>;
    };
    expect(body.commits.map((c) => c.subject)).toEqual(['Second edit', 'First edit', 'base']);
    expect(body.commits[0]?.author).toBe('dev');
    expect(body.commits[0]?.short).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('lists the commit that touched an html host’s own document', async () => {
    // The managed surfaces are globs; passing git the expanded file list breaks
    // the moment a document is renamed or the list is long, so they go as
    // pathspecs and git does the matching.
    const html = await makeHtmlHost({ register: true, git: true });
    gitInit(html.cwd);
    const { handler } = handlerOver([html.cwd]);
    const path = `?site=${encodeURIComponent(realpathSync(html.cwd))}`;
    const key = Object.keys(JSON.parse(html.file('content/descriptor.json')).keys)[0] as string;

    const saved = await post(handler, `/api/site/save${path}`, {
      values: [{ key, value: 'A line in the history' }],
    });
    await post(handler, `/api/site/commit${path}`, {
      files: saved.body['written'] as string[],
      keys: [key],
      message: 'the document edit',
    });

    // A document that has since been deleted. Its commits are still this
    // site's history; a list expanded from the working tree cannot name it.
    writeFileSync(join(html.cwd, 'gone.html'), '<html><body><p>A page that went.</p></body></html>\n', 'utf8');
    git(html.cwd, ['add', '--', 'gone.html']);
    git(html.cwd, ['commit', '-qm', 'the gone document', '--', 'gone.html']);
    git(html.cwd, ['rm', '-q', '--', 'gone.html']);
    git(html.cwd, ['commit', '-qm', 'and it went', '--', 'gone.html']);

    const body = (await (await handler(req(`/api/site/history${path}`))).json()) as {
      commits: Array<{ subject: string }>;
    };
    expect(body.commits.map((c) => c.subject)).toContain('the document edit');
    expect(body.commits.map((c) => c.subject)).toContain('the gone document');
  });

  it('lists a store-backed site’s commits as a snapshot site’s, with no repository answering none', async () => {
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const { handler } = handlerOver([host.cwd]);
    const body = await (
      await handler(req(`/api/site/history?site=${encodeURIComponent(realpathSync(host.cwd))}`))
    ).json();
    expect(body).toEqual({ commits: [] });
  });
});

describe('removed keys and commits on a JavaScript host and a store-backed site (D10, 9.4)', () => {
  const at = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
  const rev = (cwd: string, ref: string): string => git(cwd, ['rev-parse', ref]).out.trim();
  const PAGE = 'app/(marketing)/lab/page.tsx';
  /** The page at `<sha>^`: `farewell_notice` read in a paragraph on line 20, and named in a comment on line 3. */
  const labPage = (): string =>
    [
      "import { copy } from '@/lib/content';",
      '',
      '// farewell_notice was the old footer line',
      ...Array.from({ length: 13 }, () => ''),
      'export default function Page() {',
      '  return (',
      '    <main>',
      "      <p>{copy.get('farewell_notice')}</p>",
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n');
  /** One commit taking `key` (or each of several) out of the descriptor and the snapshot, and `page` written as given; answers its hash. */
  function removeKey(cwd: string, key: string | string[], page?: string): string {
    const gone = [key].flat();
    for (const rel of ['content/descriptor.json', 'content/defaults.json']) {
      const forms = JSON.parse(readFileSync(join(cwd, rel), 'utf8')) as { keys?: Record<string, unknown>; default?: Record<string, unknown> };
      for (const name of gone) delete (forms.keys ?? forms.default ?? {})[name];
      writeJsonDeterministic(join(cwd, rel), forms);
    }
    if (page !== undefined) write(cwd, PAGE, page);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', `remove ${gone.join(' and ')}`]);
    return rev(cwd, 'HEAD');
  }

  it('names where a removed key was shown on a Next host, at the commit’s parent (journey B22)', async () => {
    const host = snapshotHost();
    const config = JSON.parse(host.file('stet.config.json')) as Record<string, unknown>;
    write(host.cwd, 'stet.config.json', JSON.stringify({ ...config, router: 'app', managedSurfaces: ['app/**/*.tsx'] }));
    write(host.cwd, PAGE, labPage());
    git(host.cwd, ['add', '-A']);
    git(host.cwd, ['commit', '-qm', 'the lab page']);
    const sha = removeKey(host.cwd, 'farewell_notice', labPage().replace("      <p>{copy.get('farewell_notice')}</p>\n", ''));
    const { handler } = handlerOver([host.cwd]);
    expect(await get(handler, `/api/site/removed${at(host)}&sha=${sha}`)).toEqual({
      keys: [
        {
          key: 'farewell_notice',
          section: null,
          text: 'This channel is closing. Thanks for reading.',
          places: [{ file: PAGE, line: 20, kind: `text in ${PAGE}` }],
        },
      ],
    });
  });

  // Addition: guards the places read for a commit that removes several keys at
  // once (git grep takes each key as its own `-e` pattern).
  it('names where each of several removed keys was shown, in one commit', async () => {
    const host = snapshotHost();
    const config = JSON.parse(host.file('stet.config.json')) as Record<string, unknown>;
    write(host.cwd, 'stet.config.json', JSON.stringify({ ...config, router: 'app', managedSurfaces: ['app/**/*.tsx'] }));
    write(host.cwd, PAGE, labPage().replace("      <p>{copy.get('farewell_notice')}</p>\n", "      <p>{copy.get('farewell_notice')}</p>\n      <p>{copy.get('footer_links')}</p>\n"));
    git(host.cwd, ['add', '-A']);
    git(host.cwd, ['commit', '-qm', 'the lab page']);
    const sha = removeKey(host.cwd, ['farewell_notice', 'footer_links'], labPage().replace("      <p>{copy.get('farewell_notice')}</p>\n", ''));
    const { handler } = handlerOver([host.cwd]);
    const listed = (await get(handler, `/api/site/removed${at(host)}&sha=${sha}`)) as { keys: Array<{ key: string; places: Array<{ file: string; line: number }> }> };
    expect(listed.keys.map((k) => [k.key, k.places.map((p) => [p.file, p.line])])).toEqual([
      ['farewell_notice', [[PAGE, 20]]],
      ['footer_links', [[PAGE, 21]]],
    ]);
  });

  it('lists the commits and the keys a commit removed on a store-backed site', async () => {
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    gitInit(host.cwd);
    const sha = removeKey(host.cwd, 'farewell_notice');
    const { handler } = handlerOver([host.cwd]);
    const history = (await get(handler, `/api/site/history${at(host)}`)) as { commits: Array<{ sha: string; subject: string }> };
    expect(history.commits.map((c) => c.subject)).toEqual(['remove farewell_notice', 'base']);
    expect(history.commits[0]?.sha).toBe(sha);
    const listed = (await get(handler, `/api/site/removed${at(host)}&sha=${sha}`)) as { keys: Array<{ key: string; text: string }> };
    expect(listed.keys.map((k) => [k.key, k.text])).toEqual([['farewell_notice', 'This channel is closing. Thanks for reading.']]);
  });

  // Mutation guard: green on the first build by design; it fails when a commit
  // named like an option is handed to git as one.
  it('refuses a commit named like an option, a range or a path before git reads it', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const written = join(tempDir(), 'out.txt');
    for (const sha of ['-n', `--output=${written}`, 'HEAD..HEAD', '/etc/passwd', '../content', '']) {
      const res = await handler(req(`/api/site/removed${at(host)}&sha=${encodeURIComponent(sha)}`));
      expect(res.status, sha).toBe(400);
    }
    expect(existsSync(written)).toBe(false);
  });
});

describe('one site’s requests never interleave', () => {
  it('runs two concurrent saves in order and leaves the snapshot consistent', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const path = `?site=${encodeURIComponent(realpathSync(host.cwd))}`;
    const [first, second] = await Promise.all([
      post(handler, `/api/site/save${path}`, { values: [{ key: 'hero_headline', value: 'First' }] }),
      post(handler, `/api/site/save${path}`, { values: [{ key: 'hero_headline', value: 'Second' }] }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(host.file('content/defaults.json')).default.hero_headline).toBe('Second');

    const report = new Report();
    check(loadConfig(host.cwd), host.cwd, report);
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
  });
});

// --- Health, SEO, declare, remove, setup, verify -----------------------------

/** An Astro-shaped host: the mini project plus the route files the detector reads. */
function astroHost(routes: string[] = ['index.astro', 'about.astro', '[slug].astro']): CliHost {
  const host = snapshotHost();
  writeFileSync(
    join(host.cwd, 'stet.config.json'),
    JSON.stringify({ project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'] }, null, 2),
  );
  for (const route of routes) write(host.cwd, `src/pages/${route}`, '<h1>x</h1>\n');
  return host;
}

const site = (host: CliHost): string => `?site=${encodeURIComponent(realpathSync(host.cwd))}`;

async function get(handler: (r: Request) => Promise<Response>, path: string): Promise<any> {
  return (await (await handler(req(path))).json()) as any;
}

describe('GET /api/site/health', () => {
  it('carries doctor’s lines, check’s findings, scan’s payload and the commit it was measured at (journey A1)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/health${site(host)}`);
    expect(body.doctor.out.join('\n')).toContain('config: stet.config.json found in');
    expect(body.doctor.out.join('\n')).toContain('descriptor: content/descriptor.json');
    expect(Array.isArray(body.check)).toBe(true);
    expect(Array.isArray(body.scan.findings)).toBe(true);
    expect(body.audit).toBeNull();
    expect(body.at.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(body.at.dirty).toBe(false);

    writeFileSync(join(host.cwd, 'notes.txt'), 'stray\n', 'utf8');
    expect((await get(handler, `/api/site/health${site(host)}`)).at.dirty).toBe(true);
  });

  it('carries a null commit stamp on a checkout that is not a repository', async () => {
    const host = makeCliHost({ config: { project: 't' } });
    const { handler } = handlerOver([host.cwd]);
    expect((await get(handler, `/api/site/health${site(host)}`)).at.head).toBeNull();
  });

  it('badges a template slot the code no longer reads (journey G7)', async () => {
    const host = snapshotHost();
    writeFileSync(
      join(host.cwd, 'stet.config.json'),
      JSON.stringify({ project: 't', managedSurfaces: ['lib/email/**/*.ts'] }, null, 2),
    );
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as {
      templates: Record<string, Record<string, unknown>>;
    };
    descriptor.templates['welcome'] = {
      ...descriptor.templates['welcome'],
      render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: {} },
    };
    writeJsonDeterministic(join(host.cwd, 'content/descriptor.json'), descriptor);
    write(host.cwd, 'lib/email/welcome.ts', 'export function welcome(): string {\n  return "<h1>hi</h1>";\n}\n');

    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/health${site(host)}`);
    const unread = (body.scan.findings as Array<any>).find((f) => f.slot !== undefined);
    expect(unread.slot).toEqual({ template: 'welcome', name: 'subject' });
    expect(unread.at.file).toBe('lib/email/welcome.ts');
  });

  it('adds audit’s answer on a store-backed site', async () => {
    const memory = createMemoryStore({ project: 't' });
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } }, store: memory });
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/health${site(host)}`);
    expect(Array.isArray(body.audit.findings)).toBe(true);
  });
});

describe('GET /api/site/seo', () => {
  it('reports a missing title by rule, page and severity', async () => {
    // A bespoke descriptor: the mini project's own title keys DERIVE from other
    // keys, so they always resolve and could never state this case.
    const host = snapshotHost((descriptor) => {
      descriptor.keys = {
        home_title: { shape: 'text', target: 'web', pages: ['home'] },
        home_desc: { shape: 'text', target: 'web', pages: ['home'] },
      };
      descriptor.pages = { home: { route: '/', seo: { title: 'home_title', description: 'home_desc' } } };
      descriptor.templates = {};
    });
    writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), {
      default: { home_title: '', home_desc: 'A description that is present.' },
    });
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/seo${site(host)}`);
    const missing = (body.seo.seo as Array<any>).find((f) => f.rule === 'missing-title');
    expect(missing.page).toBe('home');
    expect(missing.severity).toBe('error');
    expect((body.seo.seo as Array<any>).some((f) => f.rule === 'missing-description')).toBe(false);
  });

  it('lists the undeclared routes and the named skips (journey C10)', async () => {
    const host = astroHost();
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/seo${site(host)}`);
    expect((body.pages.pages as Array<any>).map((p) => p.name)).toContain('about');
    expect((body.pages.skips as Array<any>).some((s) => s.reason === 'dynamic-route')).toBe(true);
  });
});

describe('POST /api/site/pages/declare', () => {
  it('declares a page and its keys in one batch, then clears its finding (journey C10)', async () => {
    const host = astroHost();
    const { handler } = handlerOver([host.cwd]);
    const declared = await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['about'] });
    expect(declared.status).toBe(200);
    expect((declared.body['lines'] as string[]).join('\n')).toContain(
      'declared 1 page(s), scaffolded 2 key(s); next: stet seo check',
    );
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as {
      pages: Record<string, unknown>;
      keys: Record<string, unknown>;
    };
    expect(descriptor.pages['about']).toBeDefined();
    expect(descriptor.keys['seo_about_title']).toBeDefined();
    // The codegen trio rode along in the same batch.
    expect(readFileSync(join(host.cwd, 'content/keys.ts'))).toEqual(
      Buffer.from(generateRegistry(loadDescriptor(descriptor)).keysTs, 'utf8'),
    );

    const found = await get(handler, `/api/site/seo${site(host)}`);
    expect((found.seo.seo as Array<any>).some((f) => f.rule === 'missing-title' && f.page === 'about')).toBe(true);

    const saved = await post(handler, `/api/site/save${site(host)}`, {
      values: [{ key: 'seo_about_title', value: 'About us, in short' }],
    });
    expect(saved.status).toBe(200);
    const cleared = await get(handler, `/api/site/seo${site(host)}`);
    expect((cleared.seo.seo as Array<any>).some((f) => f.rule === 'missing-title' && f.page === 'about')).toBe(false);
  });

  describe('the page files its own write changed (PD14)', () => {
    /** An Astro host whose about page writes its own title and description, committed. */
    function seoHost(): CliHost {
      const host = astroHost(['about.astro']);
      writeFileSync(
        join(host.cwd, 'stet.config.json'),
        JSON.stringify(
          { project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'], readPath: { file: 'src/lib/content.ts', import: '@/lib/content' } },
          null,
          2,
        ),
      );
      write(host.cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
      write(host.cwd, 'src/lib/content.ts', 'export const copyMap: Record<string, string> = {};\n');
      write(
        host.cwd,
        'src/pages/about.astro',
        '<html><head><title>About us</title><meta name="description" content="Who we are." /></head><body><h1>x</h1></body></html>\n',
      );
      git(host.cwd, ['add', '-A']);
      git(host.cwd, ['commit', '-qm', 'pages']);
      return host;
    }
    const status = (host: CliHost): string => git(host.cwd, ['status', '--porcelain']).out;

    it('commits the page file Declare pages rewrote, with the keys', async () => {
      const host = seoHost();
      const { handler } = handlerOver([host.cwd]);
      const declared = await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['about'] });
      expect(declared.status).toBe(200);
      expect(declared.body['written']).toContain('src/pages/about.astro');
      const pending = (await get(handler, `/api/site/carries${site(host)}`)).files as string[];
      expect(pending).toContain('src/pages/about.astro');
      const made = await post(handler, `/api/site/commit${site(host)}`, { files: pending });
      expect(made.status).toBe(200);
      expect(status(host)).toBe('');
    });

    it('leaves out a page file that had uncommitted edits before Declare pages wrote to it', async () => {
      const host = seoHost();
      appendFileSync(join(host.cwd, 'src/pages/about.astro'), '<!-- by hand -->\n');
      const { handler } = handlerOver([host.cwd]);
      await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['about'] });
      const pending = (await get(handler, `/api/site/carries${site(host)}`)).files as string[];
      expect(pending).not.toContain('src/pages/about.astro');
      const made = await post(handler, `/api/site/commit${site(host)}`, { files: pending });
      expect(made.status).toBe(200);
      expect(status(host).trim()).toBe('M src/pages/about.astro');
    });

    it('leaves out a page file edited by hand after Declare pages', async () => {
      const host = seoHost();
      const { handler } = handlerOver([host.cwd]);
      await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['about'] });
      appendFileSync(join(host.cwd, 'src/pages/about.astro'), '<!-- by hand -->\n');
      const pending = (await get(handler, `/api/site/carries${site(host)}`)).files as string[];
      expect(pending).not.toContain('src/pages/about.astro');
      expect(pending).toContain('content/descriptor.json');
      const made = await post(handler, `/api/site/commit${site(host)}`, { files: pending });
      expect(made.status).toBe(200);
      expect(status(host).trim()).toBe('M src/pages/about.astro');
    });

    it('REVIEW-S2: records nothing when the git status taken before the write fails', async () => {
      const host = seoHost();
      appendFileSync(join(host.cwd, 'src/pages/about.astro'), '<!-- by hand -->\n');
      // A git whose first `status` listing fails and whose every later call is the real one.
      const bin = tempDir('stet-gitfail-');
      const flag = join(bin, 'fail-once');
      writeFileSync(flag, '');
      const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --untracked-files=all "*) if [ -e '${flag}' ]; then rm -f '${flag}'; exit 1; fi;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
      const { handler } = handlerOver([host.cwd]);
      const pathBefore = process.env['PATH'];
      process.env['PATH'] = `${bin}:${pathBefore}`;
      try {
        const declared = await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['about'] });
        expect(declared.status).toBe(200);
        expect(declared.body['written']).toContain('src/pages/about.astro');
      } finally {
        process.env['PATH'] = pathBefore;
      }
      expect(existsSync(flag)).toBe(false);
      const pending = (await get(handler, `/api/site/carries${site(host)}`)).files as string[];
      expect(pending).not.toContain('src/pages/about.astro');
      expect(pending).toContain('content/descriptor.json');
    });
  });

  it('declares every proposal where no names are given', async () => {
    const host = astroHost();
    const { handler } = handlerOver([host.cwd]);
    await post(handler, `/api/site/pages/declare${site(host)}`, { names: [] });
    const pages = (JSON.parse(host.file('content/descriptor.json')) as { pages: Record<string, unknown> }).pages;
    // `index.astro` maps to `/`, which the mini descriptor already declares as
    // `home`, so the only route left to propose is `about`.
    expect(Object.keys(pages).sort()).toEqual(['about', 'home', 'pricing']);
  });

  it("fills a declared html page's empty description through the same pair (F44)", async () => {
    const titled = '<html>\n<head><title>About the partnership team</title></head>\n<body><p>A short page about the team.</p></body>\n</html>\n';
    const host = await makeHtmlHost({ register: true, files: { 'about.html': titled } });
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    writeFileSync(
      join(host.cwd, 'about.html'),
      titled.replace('</title></head>', '</title><meta name="description" content="Who runs the data partnerships, and how to reach them."></head>'),
      'utf8',
    );
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const { handler } = handlerOver([host.cwd]);
    const declared = await post(handler, `/api/site/pages/declare${site(host)}`, { names: [] });
    expect(declared.status).toBe(200);
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as { pages: Record<string, { seo?: Record<string, string> }> };
    const key = descriptor.pages['about']?.seo?.['description'];
    expect(key).toMatch(/^about_/);
    expect((declared.body['lines'] as string[]).join('\n')).toContain(`about.html: fills the description with ${key}`);
  });

  it('refuses a name that was never proposed, and a host with no routing convention', async () => {
    const host = astroHost();
    const { handler } = handlerOver([host.cwd]);
    const unknown = await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body['error'])).toContain('nothing was proposed under that name');

    const bare = snapshotHost();
    const { handler: bareHandler } = handlerOver([bare.cwd]);
    const none = await post(bareHandler, `/api/site/pages/declare${site(bare)}`, { names: [] });
    expect(none.status).toBe(400);
    expect(String(none.body['error'])).toContain('no routing convention detected');
  });
});

describe('POST /api/site/remove', () => {
  it('shows the CLI’s own plan and writes nothing (journey B14)', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const before = forms(host.cwd);
    const planned = await post(handler, `/api/site/remove${site(host)}`, { keys: ['blog_intro'] });
    expect(planned.status).toBe(200);
    expect(planned.body['applied']).toBe(false);
    expect(forms(host.cwd)).toEqual(before);

    // The terminal's own lines, minus the one `runRemove` adds for its flag.
    const terminal = makeCliHost({ config: { project: 't' } });
    cpSync(join(host.cwd, 'content'), join(terminal.cwd, 'content'), { recursive: true });
    expect(await terminal.run('remove', 'blog_intro')).toBe(0);
    const printed = terminal.out.filter((line) => line !== 'plan only — run with --write to apply');
    expect(Buffer.from((planned.body['lines'] as string[]).join('\n'), 'utf8')).toEqual(
      Buffer.from(printed.join('\n'), 'utf8'),
    );
  });

  it('applies the same batch and regenerates the forms', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const applied = await post(handler, `/api/site/remove${site(host)}`, { keys: ['blog_intro'], apply: true });
    expect(applied.status).toBe(200);
    expect(applied.body['applied']).toBe(true);
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, unknown> };
    expect('blog_intro' in descriptor.keys).toBe(false);
    expect('blog_intro' in JSON.parse(host.file('content/defaults.json')).default).toBe(false);
    expect(readFileSync(join(host.cwd, 'content/keys.ts'))).toEqual(
      Buffer.from(generateRegistry(loadDescriptor(descriptor)).keysTs, 'utf8'),
    );
  });

  it('refuses an unknown key by name', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const refused = await post(handler, `/api/site/remove${site(host)}`, { keys: ['nope'] });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('"nope" is not a key in content/descriptor.json');
  });
});

describe('GET /api/site/setup and /verify', () => {
  it('names a stale generated file without rewriting it (journey G3)', async () => {
    const host = snapshotHost();
    const stale = '// hand-edited\n';
    writeFileSync(join(host.cwd, 'content/keys.ts'), stale, 'utf8');
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/setup${site(host)}`);
    expect([...body.lines, ...body.stderr].join('\n')).toContain('content/keys.ts');
    expect(host.file('content/keys.ts')).toBe(stale);
  });

  it('names the store’s own migration posture on a store-backed site', async () => {
    const memory = createMemoryStore({ project: 't' });
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } }, store: memory });
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/setup${site(host)}`);
    // The memory reference keeps no `stet_meta`, so what upgrade has to say
    // about migrations here is that there is nothing to say. A genuinely
    // pending migration needs a SQL store, which the offline suite cannot open.
    expect([...body.lines, ...body.stderr].join('\n')).toContain(
      'store: this adapter has no stet_meta — nothing to migrate',
    );
  });

  it('gives each declared template its verify state (journey E19)', async () => {
    const email = makeEmailHost();
    execFileSync('git', ['init', '-q'], { cwd: email.dir });
    execFileSync('git', ['config', 'user.email', 'dev@test'], { cwd: email.dir });
    execFileSync('git', ['config', 'user.name', 'dev'], { cwd: email.dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: email.dir });
    email.put('.gitignore', 'node_modules\n');
    email.put(
      'stet.config.json',
      `${JSON.stringify({ project: 't', managedSurfaces: [], emailSurfaces: ['lib/email/*.ts'] }, null, 2)}\n`,
    );
    email.put('content/descriptor.json', `${JSON.stringify({ version: 1, keys: {}, templates: {} }, null, 2)}\n`);
    email.put('content/defaults.json', '{"default":{}}\n');
    email.put(
      'lib/email/welcome.ts',
      'export function welcome(props: { name: string }): string {\n' +
        '  return `<h1>Good to see you, ${props.name}</h1>`;\n' +
        '}\n',
    );
    execFileSync('git', ['add', '-A'], { cwd: email.dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: email.dir });
    const applied = await runCli(['email', 'extract', 'lib/email/*.ts', '--apply'], {
      cwd: email.dir,
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(applied).toBe(0);

    const { handler } = handlerOver([email.dir]);
    const body = await get(handler, `/api/site/verify?site=${encodeURIComponent(realpathSync(email.dir))}`);
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBeGreaterThan(0);
    for (const template of body.templates as Array<{ template: string; state: string }>) {
      expect(typeof template.template).toBe('string');
      expect(typeof template.state).toBe('string');
    }
  });
});

// --- the store-backed mount --------------------------------------------------

/** The mount reads the run token from this process's own environment. */
function withToken(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const held = process.env['STET_DEV_TOKEN'];
    process.env['STET_DEV_TOKEN'] = TOKEN;
    try {
      await fn();
    } finally {
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
    }
  };
}

describe('the mounted API under /s/<id>/api/stet', () => {
  const mount = (host: CliHost, route: string, query = ''): string =>
    `/s/${siteId(realpathSync(host.cwd))}/api/stet/${route}${query}`;

  it(
    'answers keys and a draft behind the run token, and refuses a blank editor',
    withToken(async () => {
      const store = createMemoryStore({ project: 't' });
      const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
      const { handler } = handlerOver([host.cwd], { storeFor: () => store });

      expect((await handler(req(mount(host, 'keys'), { token: null }))).status).toBe(401);
      const keys = (await (await handler(req(mount(host, 'keys')))).json()) as { descriptor: { keys: object } };
      expect(Object.keys(keys.descriptor.keys)).toContain('hero_headline');

      const drafted = await post(handler, mount(host, 'draft'), {
        editor: 'dashboard:test',
        key: 'hero_headline',
        value: 'A drafted headline',
      });
      expect(drafted.status).toBe(200);
      const rows = await store.read({ keys: ['hero_headline'], preview: true });
      expect(Array.isArray(rows) && rows.some((row) => row.value === 'A drafted headline')).toBe(true);

      const blank = await post(handler, mount(host, 'draft'), { editor: '', key: 'hero_headline', value: 'x' });
      expect(blank.status).toBe(400);
      expect(blank.body['error']).toBe('editor is required');
    }),
  );

  it(
    'reads the connection from the checkout’s files, and names both of them when it is unset',
    withToken(async () => {
      const host = makeCliHost({
        config: { project: 't', store: { adapter: 'pg', urlEnv: 'DATABASE_URL' } },
      });
      const { handler } = handlerOver([host.cwd]);
      const unset = await handler(req(mount(host, 'keys')));
      expect(unset.status).toBe(409);
      expect(((await unset.json()) as { error: string }).error).toBe(
        "store adapter 'pg' is configured but DATABASE_URL is unset — " +
          "stet dev reads it from the project's .env and .env.local, and for the project it was started in, from the shell it was started in",
      );
    }),
  );

  it(
    'hands the checkout’s own map to the adapter factory, and never the process environment',
    withToken(async () => {
      const host = makeCliHost({
        config: { project: 't', store: { adapter: 'postgrest', urlEnv: 'STET_URL', tokenEnv: 'STET_TOKEN' } },
      });
      writeFileSync(join(host.cwd, '.env'), 'STET_URL=http://localhost:9999\nSTET_TOKEN=from-the-file\n');
      process.env['STET_TOKEN'] = 'from-the-process';
      let seen: NodeJS.ProcessEnv | undefined;
      try {
        const store = createMemoryStore({ project: 't' });
        // The recorder runs where `resolveStore` reads the env, so the map it
        // was handed is the map under test. No socket is opened either way.
        const { handler } = handlerOver([host.cwd], {
          storeFor: (path) => {
            seen = siteEnv(path);
            return store;
          },
        });
        expect((await handler(req(mount(host, 'keys')))).status).toBe(200);
      } finally {
        delete process.env['STET_TOKEN'];
      }
      expect(seen?.['STET_TOKEN']).toBe('from-the-file');
      expect(seen?.['STET_URL']).toBe('http://localhost:9999');
    }),
  );

  it(
    'builds a second store for a second environment, and refuses an undeclared name',
    withToken(async () => {
      const host = makeCliHost({
        config: {
          project: 't',
          store: { adapter: 'memory' },
          environments: { staging: { adapter: 'memory' } },
        },
      });
      const stores = new Map<string, ReturnType<typeof createMemoryStore>>([
        ['', createMemoryStore({ project: 'default' })],
        ['staging', createMemoryStore({ project: 'staging' })],
      ]);
      const { handler } = handlerOver([host.cwd], {
        storeFor: (_path, env) => stores.get(env ?? ''),
      });
      await post(handler, mount(host, 'draft'), {
        editor: 'dashboard:test',
        key: 'hero_headline',
        value: 'only in default',
      });
      const inDefault = (await (await handler(req(mount(host, 'keys')))).json()) as { rows: unknown[] };
      const inStaging = (await (
        await handler(req(mount(host, 'keys', '?env=staging')))
      ).json()) as { rows: unknown[] };
      expect(inDefault.rows.length).toBeGreaterThan(inStaging.rows.length);

      const unknown = await handler(req(mount(host, 'keys', '?env=nope')));
      expect(unknown.status).toBe(400);
      expect(String(((await unknown.json()) as { error: string }).error)).toContain('not a declared environment');
      expect(String((await handler(req(mount(host, 'keys', '?env=nope')))).status)).toBe('400');
    }),
  );

  it(
    'keeps a path with a space apart from an environment name',
    withToken(async () => {
      // `${path} ${env}` runs the two together: the checkout `/a` under
      // environment `b c` and the checkout `/a b` under environment `c` make
      // the same string, and the second site would be served the first one's
      // adapter — its rows, its connection, its project.
      const plain = makeCliHost({
        config: {
          project: 't',
          store: { adapter: 'memory' },
          environments: { 'b c': { adapter: 'memory' }, c: { adapter: 'memory' } },
        },
      });
      const spaced = `${realpathSync(plain.cwd)} b`;
      cpSync(plain.cwd, spaced, { recursive: true });

      const asked: string[] = [];
      const { handler } = handlerOver([plain.cwd, spaced], {
        storeFor: (path, env) => {
          asked.push(JSON.stringify([path, env ?? null]));
          return createMemoryStore({ project: 't' });
        },
      });
      const id = (path: string): string => siteId(realpathSync(path));

      expect((await handler(req(`/s/${id(plain.cwd)}/api/stet/keys?env=${encodeURIComponent('b c')}`))).status).toBe(
        200,
      );
      expect((await handler(req(`/s/${id(spaced)}/api/stet/keys?env=c`))).status).toBe(200);
      expect(asked).toEqual([
        JSON.stringify([realpathSync(plain.cwd), 'b c']),
        JSON.stringify([spaced, 'c']),
      ]);
    }),
  );

  describe('the checkout stet dev was started in takes its pair from the shell', () => {
    const PAIR = { project: 't', store: { adapter: 'postgrest', urlEnv: 'STET_POSTGREST_URL', tokenEnv: 'STET_POSTGREST_TOKEN' } };
    const UNSET =
      "store adapter 'postgrest' is configured but STET_POSTGREST_URL is unset — " +
      "stet dev reads it from the project's .env and .env.local, and for the project it was started in, from the shell it was started in";

    /** Two checkouts declaring the pair; the first's `.env.local` holds an older URL. */
    function twoCheckouts(): { a: CliHost; b: CliHost } {
      const a = makeCliHost({ config: PAIR });
      const b = makeCliHost({ config: PAIR });
      writeFileSync(join(a.cwd, '.env.local'), 'STET_POSTGREST_URL=http://stale.test/rest/v1\n');
      return { a, b };
    }

    /** Records each store request's URL and apikey, answering no rows. */
    function recordingFetch(): { calls: Array<{ url: string; apikey: string | undefined }> } {
      const calls: Array<{ url: string; apikey: string | undefined }> = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), apikey: (init?.headers as Record<string, string> | undefined)?.['apikey'] });
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      return { calls };
    }

    const vars = async (handler: (r: Request) => Promise<Response>, host: CliHost): Promise<unknown[]> => {
      const body = (await (await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`))).json()) as {
        environments: Array<{ vars: unknown[] }>;
      };
      return body.environments[0]!.vars;
    };

    it(
      'reads the process pair over the files for the started-in site, and the files alone for any other',
      withToken(async () => {
        const { a, b } = twoCheckouts();
        const { calls } = recordingFetch();
        try {
          await withProcessEnv({ STET_POSTGREST_URL: 'http://store.test/rest/v1', STET_POSTGREST_TOKEN: 'proc-token' }, async () => {
            const { handler } = handlerOver([a.cwd, b.cwd], { launched: realpathSync(a.cwd) });
            expect(await vars(handler, a)).toEqual([
              { name: 'STET_POSTGREST_URL', set: true },
              { name: 'STET_POSTGREST_TOKEN', set: true },
            ]);
            expect(await vars(handler, b)).toEqual([
              { name: 'STET_POSTGREST_URL', set: false },
              { name: 'STET_POSTGREST_TOKEN', set: false },
            ]);

            const mounted = await handler(req(mount(a, 'keys')));
            expect(mounted.status).toBe(200);
            expect(calls[0]?.url).toMatch(/^http:\/\/store\.test\/rest\/v1\/content_versions/);
            expect(calls[0]?.apikey).toBe('proc-token');

            const refused = await handler(req(mount(b, 'keys')));
            expect(refused.status).toBe(409);
            expect(((await refused.json()) as { error: string }).error).toBe(UNSET);
            expect(calls).toHaveLength(1);
          });

          // A value the process holds empty is unset: the file's older URL stays.
          calls.length = 0;
          await withProcessEnv({ STET_POSTGREST_URL: '', STET_POSTGREST_TOKEN: 'proc-token' }, async () => {
            const { handler } = handlerOver([a.cwd, b.cwd], { launched: realpathSync(a.cwd) });
            expect((await handler(req(mount(a, 'keys')))).status).toBe(200);
            expect(calls[0]?.url).toMatch(/^http:\/\/stale\.test\/rest\/v1\/content_versions/);
          });
        } finally {
          vi.unstubAllGlobals();
        }
      }),
    );

    it(
      'runs a command the page starts with the same pair, and another checkout’s without it',
      withToken(async () => {
        const { a, b } = twoCheckouts();
        recordingFetch();
        try {
          await withProcessEnv({ STET_POSTGREST_URL: 'http://store.test/rest/v1', STET_POSTGREST_TOKEN: 'proc-token' }, async () => {
            const { ctx } = handlerOver([a.cwd, b.cwd], { launched: realpathSync(a.cwd) });
            const text = async (host: CliHost): Promise<string> => {
              const run = await captured(ctx, ['doctor'], { path: realpathSync(host.cwd), config: loadConfig(host.cwd) });
              return `${run.out.join('\n')}\n${run.err.join('\n')}`;
            };
            expect(await text(a)).not.toContain('is unset');
            expect(await text(b)).toContain('STET_POSTGREST_URL is unset');
          });
        } finally {
          vi.unstubAllGlobals();
        }
      }),
    );

    it('takes the shell pair for the checkout it was RUN in, through runDev', async () => {
      const host = gitHost({ config: PAIR });
      const file = workspaceFile();
      const io: CliIo = { cwd: host.cwd, env: { STET_WORKSPACE: file }, stdout: () => {}, stderr: () => {} };
      const held = process.env['STET_DEV_TOKEN'];
      let seen = '';
      try {
        await withProcessEnv({ STET_POSTGREST_URL: 'http://store.test/rest/v1', STET_POSTGREST_TOKEN: 'proc-token' }, async () => {
          await runDev(['--no-open', '--port', '0'], io, {
            onListening: async (handle) => {
              seen = await raw(
                handle.port,
                `GET /api/site?site=${encodeURIComponent(realpathSync(host.cwd))} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n` +
                  `Authorization: Bearer ${handle.token}\r\nConnection: close\r\n\r\n`,
              );
            },
          });
        });
      } finally {
        if (held === undefined) delete process.env['STET_DEV_TOKEN'];
        else process.env['STET_DEV_TOKEN'] = held;
      }
      expect(seen).toContain('{"name":"STET_POSTGREST_URL","set":true}');
      expect(seen).toContain('{"name":"STET_POSTGREST_TOKEN","set":true}');
    });
  });

  it('ends every adapter it opened when the server closes', async () => {
    let ended = 0;
    const store = { ...createMemoryStore({ project: 't' }), end: async () => void (ended += 1) };
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const file = workspaceFile();
    addSite(file, host.cwd);
    const handle = await startDevServer({
      port: 0,
      workspaceFile: file,
      io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
      token: TOKEN,
      page: PAGE,
      storeFor: () => store,
    });
    try {
      const seen = await fetchOverSocket(handle.port, `/s/${siteId(realpathSync(host.cwd))}/api/stet/keys`);
      expect(seen.split('\r\n')[0]).toContain('200');
    } finally {
      await handle.close();
    }
    expect(ended).toBe(1);
  });

  it('mounts behind its own handle’s token, whatever the environment held', async () => {
    // The mount reads the run token out of this process's environment, so the
    // server has to put it there: a caller other than `runDev` would otherwise
    // get a mount that answers 401 to the token its own handle hands out.
    const store = createMemoryStore({ project: 't' });
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const file = workspaceFile();
    addSite(file, host.cwd);
    const held = process.env['STET_DEV_TOKEN'];
    delete process.env['STET_DEV_TOKEN'];
    const handle = await startDevServer({
      port: 0,
      workspaceFile: file,
      io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
      token: TOKEN,
      page: PAGE,
      storeFor: () => store,
    });
    try {
      expect(process.env['STET_DEV_TOKEN']).toBe(TOKEN);
      const seen = await fetchOverSocket(handle.port, `/s/${siteId(realpathSync(host.cwd))}/api/stet/keys`);
      expect(seen.split('\r\n')[0]).toContain('200');
      expect(seen).toContain('hero_headline');
    } finally {
      await handle.close();
      if (held !== undefined) process.env['STET_DEV_TOKEN'] = held;
    }
    // The run is over, so the credential it set is gone with it.
    expect(process.env['STET_DEV_TOKEN']).toBe(held);
  });
});

describe('the mount renders email through the pointer in stet dev (D12, 11.3)', () => {
  const mount = (host: { dir: string }, route: string, query = ''): string =>
    `/s/${siteId(realpathSync(host.dir))}/api/stet/${route}${query}`;
  const withDraft = async (headline: string): Promise<StoreAdapter> => {
    const store = createMemoryStore({ project: 'default' });
    await store.saveDraft({ key: 'welcome__headline', value: headline, target: 'html-email', editor: 't' });
    return store;
  };
  const storeHost = (opts: Parameters<typeof previewHost>[0] = {}): PreviewHost =>
    previewHost({ ...opts, config: { store: { adapter: 'memory' }, ...opts.config } });
  /** The renderer over a host's forms, as `mountRoute` builds it, with its own store. */
  const rendererOver = (host: PreviewHost, store: StoreAdapter): ReturnType<typeof mountRenderer> =>
    mountRenderer(
      { cwd: host.dir, env: {}, stdout: () => {}, stderr: () => {} },
      {
        path: host.dir,
        descriptor: loadDescriptor(JSON.parse(readFileSync(join(host.dir, 'content/descriptor.json'), 'utf8'))),
        snapshot: loadSnapshot(JSON.parse(readFileSync(join(host.dir, 'content/defaults.json'), 'utf8'))),
      },
      store,
    );
  const pointTo = (host: PreviewHost, edit: (render: Record<string, unknown>) => void): void => {
    const path = join(host.dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(path, 'utf8'));
    edit(descriptor.templates.welcome.render);
    writeFileSync(path, JSON.stringify(descriptor));
  };

  it(
    'the render route renders a string template with the store’s draft',
    withToken(async () => {
      const host = storeHost();
      const store = await withDraft('A headline from the store');
      const { handler } = handlerOver([host.dir], { storeFor: () => store });
      const res = await handler(req(mount(host, 'render', '?template=welcome')));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('<h1>A headline from the store</h1>');
      // The sample props fill {{name}} and the mount's markup carries no preview marker.
      expect(html).toContain('<p>Hi Ada</p>');
      expect(html).not.toContain('data-stet');
    }),
  );

  it(
    'the render route falls to the snapshot for a slot with no stored row',
    withToken(async () => {
      const host = storeHost();
      const store = createMemoryStore({ project: 'default' });
      const { handler } = handlerOver([host.dir], { storeFor: () => store });
      const html = await (await handler(req(mount(host, 'render', '?template=welcome')))).text();
      expect(html).toContain('<h1>Welcome to mirra</h1>');
    }),
  );

  it('test-send renders with opts.override laid over the store values, key by key', async () => {
    const host = storeHost();
    const render = rendererOver(host, await withDraft('From the store'));
    const html = await render('welcome', { override: { welcome__headline: 'From the override' } });
    expect(html).toContain('<h1>From the override</h1>');
    // A key the override does not name keeps the store's (or the snapshot's) value.
    expect(html).toContain('<p>Your first week starts here</p>');
    // An override that is not text is refused as the CLI's render refuses it.
    await expect(render('welcome', { override: { welcome__headline: 5 } })).rejects.toThrow(/welcome__headline resolved to a number, not a string/);
  });

  it('rejects, naming the store’s message, when the store does not answer', async () => {
    const host = storeHost();
    const store = createMemoryStore({ project: 'default' });
    const down = { ...store, read: async () => ({ storeError: true as const, message: 'connection refused' }) } as unknown as StoreAdapter;
    await expect(rendererOver(host, down)('welcome')).rejects.toThrow('the store did not answer: connection refused');
  });

  it(
    'a string map resolves its html member',
    withToken(async () => {
      const host = storeHost({
        template: "export function welcome(p: Record<string, string>) { return { subject: 'S', html: '<b>' + p.welcome__headline + '</b>' }; }\n",
      });
      const { handler } = handlerOver([host.dir], { storeFor: () => createMemoryStore({ project: 'default' }) });
      expect(await (await handler(req(mount(host, 'render', '?template=welcome')))).text()).toBe('<b>Welcome to mirra</b>');
    }),
  );

  it('rejects a map with no html member, a runner failure and a slot with no value, each with its sentence', async () => {
    const store = createMemoryStore({ project: 'default' });
    const noHtml = rendererOver(storeHost({ template: "export function welcome() { return { subject: 'only' }; }\n" }), store);
    await expect(noHtml('welcome')).rejects.toThrow('not-renderable: welcome renders a map with no html member — the email is its html');
    const threw = rendererOver(storeHost({ template: "export function welcome(): string { throw new Error('kaput'); }\n" }), store);
    await expect(threw('welcome')).rejects.toThrow(/^render-threw: .*kaput/s);
    const gap = rendererOver(storeHost({ snapshot: { welcome__headline: 'x' } }), store);
    await expect(gap('welcome')).rejects.toThrow(/welcome__subject/);
  });

  it(
    'a render by version rejects: only the host’s own renderEmail can',
    withToken(async () => {
      const host = storeHost();
      const store = createMemoryStore({ project: 'default' });
      await expect(rendererOver(host, store)('welcome', { version: 3 })).rejects.toThrow("render by version needs the host's renderEmail");
      const { handler } = handlerOver([host.dir], { storeFor: () => store });
      const res = await handler(req(mount(host, 'render', '?template=welcome&version=3')));
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("render by version needs the host's renderEmail");
    }),
  );

  it('rejects a template with no render pointer', async () => {
    const host = storeHost();
    const path = join(host.dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(path, 'utf8'));
    delete descriptor.templates.welcome.render;
    writeFileSync(path, JSON.stringify(descriptor));
    await expect(rendererOver(host, createMemoryStore({ project: 'default' }))('welcome')).rejects.toThrow(
      'welcome has no render pointer — declare one, or render it through the host',
    );
  });

  it(
    'S3: a pointer ../../outside/tpl.ts rejects with the containment line and spawns nothing',
    withToken(async () => {
      const host = storeHost();
      const mark = join(host.dir, 'spawned');
      const out = outsideFile(
        host,
        `export function welcome(): string { require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); return '<p>outside</p>'; }\n`,
      );
      pointTo(host, (render) => (render['file'] = out.rel));
      const line = `${out.rel} is outside the project — a render pointer names a file inside it`;
      const store = createMemoryStore({ project: 'default' });
      await expect(rendererOver(host, store)('welcome')).rejects.toThrow(line);
      const { handler } = handlerOver([host.dir], { storeFor: () => store });
      const res = await handler(req(mount(host, 'render', '?template=welcome')));
      expect(((await res.json()) as { error: string }).error).toBe(line);
      expect(existsSync(mark)).toBe(false);
    }),
  );

  it('F6c: a template named after an Object.prototype member rejects with the no-render-pointer sentence', async () => {
    const render = rendererOver(storeHost(), createMemoryStore({ project: 'default' }));
    for (const name of ['constructor', '__proto__', 'toString']) {
      await expect(render(name)).rejects.toThrow(`${name} has no render pointer — declare one, or render it through the host`);
    }
  });

  it(
    'F6d: a pointer that escapes the project never reaches the store, on the render route and on the renderer itself',
    withToken(async () => {
      const host = storeHost();
      const out = outsideFile(host, "export function welcome(): string { return '<p>outside</p>'; }\n");
      pointTo(host, (render) => (render['file'] = out.rel));
      const base = createMemoryStore({ project: 'default' });
      let reads = 0;
      const counting = {
        ...base,
        read: async (...args: Parameters<StoreAdapter['read']>) => {
          reads += 1;
          return base.read(...args);
        },
      } as StoreAdapter;
      await expect(rendererOver(host, counting)('welcome')).rejects.toThrow('is outside the project');
      const { handler } = handlerOver([host.dir], { storeFor: () => counting });
      const res = await handler(req(mount(host, 'render', '?template=welcome')));
      expect(((await res.json()) as { error: string }).error).toContain('is outside the project');
      const previewed = await handler(
        req(`/api/site/email-preview?site=${encodeURIComponent(realpathSync(host.dir))}`, { method: 'POST', body: { template: 'welcome' } }),
      );
      expect(((await previewed.json()) as { failure: { detail: string } }).failure.detail).toContain('is outside the project');
      expect(reads).toBe(0);
    }),
  );

  it(
    'a host’s own createStetHandler without renderEmail still answers 501, and its closure reaches no child process',
    withToken(async () => {
      const host = storeHost();
      const handler = createStetHandler({
        store: createMemoryStore({ project: 'default' }),
        descriptor: loadDescriptor(JSON.parse(readFileSync(join(host.dir, 'content/descriptor.json'), 'utf8'))),
        auth: 'STET_DEV_TOKEN',
      });
      const res = await handler.GET(req('/api/stet/render?template=welcome'));
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toBe('render is not wired');
      const closure = runtimeImportClosure(new URL('../server/index.ts', import.meta.url));
      expect(closure.bare.filter((spec) => /(^|:)child_process$/.test(spec))).toEqual([]);
      expect(closure.modules.filter((m) => /^(cli|templates)\//.test(m))).toEqual([]);
    }),
  );
});

describe('the dashboard sends a test email through the host’s emailSend (D58)', () => {
  const SEND =
    "const { appendFileSync } = require('node:fs');\n" +
    "const { join } = require('node:path');\n" +
    "const log = join(__dirname, '..', 'sent.log');\n" +
    "exports.sendTest = (message) => appendFileSync(log, JSON.stringify(message) + '\\n');\n" +
    "exports.sendEnv = (message) => appendFileSync(log, JSON.stringify({ ...message, token: process.env.STET_DEV_TOKEN ?? 'unset' }) + '\\n');\n" +
    "exports.sendDown = () => { throw new Error('smtp down'); };\n" +
    "exports.sendHang = () => { setInterval(() => {}, 1000); return new Promise(() => {}); };\n";
  const sendHost = (emailSend: { file: string; export: string } | null = { file: 'lib/send.js', export: 'sendTest' }): PreviewHost =>
    previewHost({
      config: { store: { adapter: 'memory' }, ...(emailSend === null ? {} : { emailSend }) },
      files: { 'lib/send.js': SEND },
    });
  const mountOf = (host: PreviewHost, route: string): string => `/s/${siteId(realpathSync(host.dir))}/api/stet/${route}`;
  const sentLog = (host: PreviewHost): Array<Record<string, any>> => {
    const path = join(host.dir, 'sent.log');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  };
  const withDraft = async (headline: string): Promise<StoreAdapter> => {
    const store = createMemoryStore({ project: 'default' });
    await store.saveDraft({ key: 'welcome__headline', value: headline, target: 'html-email', editor: 't' });
    return store;
  };
  const send = (host: PreviewHost, store: StoreAdapter, body: Record<string, unknown> = { template: 'welcome', to: 'typed@example.test' }) => {
    const { handler } = handlerOver([host.dir], { storeFor: () => store });
    return post(handler, mountOf(host, 'test-send'), body);
  };

  it(
    'T1: sends the store’s draft to the typed address through the host’s function, with the subject and template, and no marker',
    withToken(async () => {
      const host = sendHost();
      const reply = await send(host, await withDraft('A drafted headline'));
      expect(reply).toEqual({ status: 200, body: { sent: true } });
      const lines = sentLog(host);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ to: 'typed@example.test', subject: 'Welcome aboard', template: 'welcome' });
      expect(lines[0]?.['html']).toContain('<h1>A drafted headline</h1>');
      expect(lines[0]?.['html']).not.toContain('data-stet');
    }),
  );

  it(
    'T2: without emailSend the route stays 501 and nothing is sent',
    withToken(async () => {
      const host = sendHost(null);
      const reply = await send(host, await withDraft('x'));
      expect(reply.status).toBe(501);
      expect(reply.body['error']).toBe('test-send is not wired');
      expect(sentLog(host)).toEqual([]);
    }),
  );

  it(
    'T3: a recipient holding a line break is refused with nothing rendered and nothing sent',
    withToken(async () => {
      const host = sendHost();
      const mark = join(host.dir, 'rendered');
      writeFileSync(
        join(host.dir, 'lib/email/welcome.ts'),
        `export function welcome(): string { require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); return '<p>x</p>'; }\n`,
      );
      const reply = await send(host, await withDraft('x'), { template: 'welcome', to: 'a@example.test\r\nBcc: b@example.test' });
      expect(reply.status).toBe(400);
      expect(sentLog(host)).toEqual([]);
      expect(existsSync(mark)).toBe(false);
    }),
  );

  it(
    'T4: rendering, reading the keys and saving a draft never send',
    withToken(async () => {
      const host = sendHost();
      const store = await withDraft('x');
      const { handler } = handlerOver([host.dir], { storeFor: () => store });
      expect((await handler(req(mountOf(host, 'render') + '?template=welcome'))).status).toBe(200);
      expect((await handler(req(mountOf(host, 'keys')))).status).toBe(200);
      const drafted = await post(handler, mountOf(host, 'draft'), { editor: 't', key: 'welcome__headline', value: 'y' });
      expect(drafted.status).toBe(200);
      expect(sentLog(host)).toEqual([]);
    }),
  );

  it(
    'T5: an emailSend file outside the project, or a symlink out of it, answers the containment line and runs nothing',
    withToken(async () => {
      const host = sendHost();
      const mark = join(host.dir, 'outside-ran');
      const out = outsideFile(host, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); exports.sendTest = () => {};\n`);
      const config = JSON.parse(readFileSync(join(host.dir, 'stet.config.json'), 'utf8'));
      const store = await withDraft('x');
      for (const [file, line] of [
        [out.rel, `${out.rel} is outside the project — a render pointer names a file inside it`],
        ['lib/linked.js', 'lib/linked.js is outside the project — a render pointer names a file inside it'],
      ] as const) {
        if (file === 'lib/linked.js') linkOut(host, file, out.abs);
        writeFileSync(join(host.dir, 'stet.config.json'), JSON.stringify({ ...config, emailSend: { file, export: 'sendTest' } }));
        const reply = await send(host, store);
        expect(reply.status).toBe(500);
        expect(reply.body['error']).toBe(line);
      }
      expect(existsSync(mark)).toBe(false);
      expect(sentLog(host)).toEqual([]);
    }),
  );

  it(
    'F4: an emailSend file with no extension whose sibling is a symlink out of the project runs nothing and answers the containment line',
    withToken(async () => {
      const host = sendHost();
      const mark = join(host.dir, 'outside-ran');
      const out = outsideFile(host, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); exports.sendTest = () => {};\n`);
      linkOut(host, 'lib/linked.js', out.abs);
      const config = JSON.parse(readFileSync(join(host.dir, 'stet.config.json'), 'utf8'));
      writeFileSync(join(host.dir, 'stet.config.json'), JSON.stringify({ ...config, emailSend: { file: 'lib/linked', export: 'sendTest' } }));
      const reply = await send(host, await withDraft('x'));
      expect(reply.status).toBe(500);
      expect(reply.body['error']).toBe('lib/linked is outside the project — a render pointer names a file inside it');
      expect(existsSync(mark)).toBe(false);
      expect(sentLog(host)).toEqual([]);
    }),
  );

  it(
    'T6: a host send that throws answers its own error and records nothing',
    withToken(async () => {
      const host = sendHost({ file: 'lib/send.js', export: 'sendDown' });
      const reply = await send(host, await withDraft('x'));
      expect(reply.status).toBe(500);
      expect(String(reply.body['error'])).toContain('smtp down');
      // The host's own error as it stands, not a reason tag put in front of it.
      expect(String(reply.body['error'])).not.toContain('send-failed');
      expect(sentLog(host)).toEqual([]);
    }),
  );

  it(
    'T7: the host send function runs without the dashboard’s run token',
    withToken(async () => {
      const host = sendHost({ file: 'lib/send.js', export: 'sendEnv' });
      const reply = await send(host, await withDraft('x'));
      expect(reply.status).toBe(200);
      expect(process.env['STET_DEV_TOKEN']).toBe(TOKEN);
      expect(sentLog(host)[0]?.['token']).toBe('unset');
    }),
  );

  it(
    'D66: a mount draft of a subject holding a line break is refused (422), and the stored draft is never written',
    withToken(async () => {
      const host = sendHost();
      const store = createMemoryStore({ project: 'default' });
      const { handler } = handlerOver([host.dir], { storeFor: () => store });
      const reply = await post(handler, mountOf(host, 'draft'), { editor: 'mallory', key: 'welcome__subject', value: 'Hi\r\nBcc: x@evil.test' });
      expect(reply.status).toBe(422);
      expect(String(reply.body['error'])).toContain('An email subject fits on one line. Remove the line break.');
      expect(await store.read({ keys: ['welcome__subject'], preview: true })).toEqual([]);
    }),
  );

  it(
    'D66: a subject with a line break that arrives by a hand-edited snapshot is refused at send, and the sender is never called',
    withToken(async () => {
      const host = sendHost();
      writeFileSync(
        join(host.dir, 'content/defaults.json'),
        JSON.stringify({ default: { ...SNAPSHOT, welcome__subject: 'Hi\r\nBcc: x@evil.test' } }),
      );
      const reply = await send(host, await withDraft('x'));
      expect(reply.status).toBe(500);
      expect(String(reply.body['error'])).toContain('the subject has a line break, which an email header cannot hold');
      expect(sentLog(host)).toEqual([]);
    }),
  );

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const HANG = 'export function welcome(): Promise<string> {\n  setInterval(() => {}, 1000);\n  return new Promise(() => {});\n}\n';

  it(
    'F1: a mount render that never returns holds only its own request, not the site’s other routes',
    withToken(async () => {
      const host = previewHost({ config: { store: { adapter: 'memory' } }, template: HANG });
      const { handler } = handlerOver([host.dir], { renderDeadlineMs: 3000, storeFor: () => createMemoryStore({ project: 'default' }) });
      const started = Date.now();
      const hung = handler(req(mountOf(host, 'render') + '?template=welcome'));
      await sleep(500);
      expect((await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.dir))}`))).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
      const answer = await hung;
      expect(answer.status).toBe(500);
      expect(((await answer.json()) as { error: string }).error).toContain('did not finish within 3s');
    }),
    15_000,
  );

  // An addition beyond R5-1: renders run outside the site's queue, so two can ask for the
  // adapter while the first is still opening it. It guards a second pool being built.
  it(
    'two renders asking at once open the site’s store once',
    withToken(async () => {
      const host = previewHost({ config: { store: { adapter: 'memory' } } });
      const store = createMemoryStore({ project: 'default' });
      let opened = 0;
      const { handler } = handlerOver([host.dir], {
        storeFor: () => {
          opened += 1;
          return store;
        },
      });
      const replies = await Promise.all([1, 2, 3].map(() => handler(req(mountOf(host, 'render') + '?template=welcome'))));
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(opened).toBe(1);
    }),
  );

  it(
    'F1: a host send function that never returns holds only its own request, not the site’s other routes',
    withToken(async () => {
      const host = sendHost({ file: 'lib/send.js', export: 'sendHang' });
      const { handler } = handlerOver([host.dir], { renderDeadlineMs: 3000, storeFor: () => createMemoryStore({ project: 'default' }) });
      const started = Date.now();
      const hung = post(handler, mountOf(host, 'test-send'), { template: 'welcome', to: 'typed@example.test' });
      await sleep(500);
      expect((await handler(req(`/api/site?site=${encodeURIComponent(realpathSync(host.dir))}`))).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
      const answer = await hung;
      expect(answer.status).toBe(500);
      expect(String(answer.body['error'])).toContain('did not finish within 3s');
      expect(sentLog(host)).toEqual([]);
    }),
    15_000,
  );

  // An addition beyond T1-T8: it guards the sender's own refusal when no render came before it in the request.
  it('the sender refuses what was never rendered in its request, and sends nothing', async () => {
    const host = sendHost();
    const site = {
      path: host.dir,
      descriptor: loadDescriptor(JSON.parse(readFileSync(join(host.dir, 'content/descriptor.json'), 'utf8'))),
      snapshot: loadSnapshot(JSON.parse(readFileSync(join(host.dir, 'content/defaults.json'), 'utf8'))),
    };
    const io = { cwd: host.dir, env: {}, stdout: () => {}, stderr: () => {} };
    const sender = mountSender(io, site, { file: 'lib/send.js', export: 'sendTest' }, { current: null });
    await expect(sender('<p>x</p>', 'me@example.test')).rejects.toThrow('nothing was rendered to send');
    expect(sentLog(host)).toEqual([]);
  });
});

/** One authenticated GET over a socket — for the cases that need the real listener. */
function fetchOverSocket(port: number, path: string): Promise<string> {
  return raw(
    port,
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
  );
}

// --- the preview, the dev child, the static files ----------------------------

describe('GET /api/site/preview', () => {
  it('answers up through the site’s own proxy with the route, the dev server’s URL as dev, and the channel', async () => {
    const host = snapshotHost();
    const file = workspaceFile();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    updateSite(file, path, { dev: 'http://localhost:4321', devCommand: 'npm start' });

    const ctx = contextOver(file, { fetchImpl: fakeFetch('') });
    const answering = createDevHandler(ctx);
    try {
      const probe = async (): Promise<any> =>
        (await answering(req(`/api/site/preview?site=${encodeURIComponent(path)}&route=/about`))).json();
      const up = await probe();
      expect(up.up).toBe(true);
      const proxy = new URL(up.url);
      expect(proxy.hostname).toBe('127.0.0.1');
      expect(proxy.port).not.toBe('4321');
      expect(proxy.pathname).toBe('/about');
      expect(up.dev).toBe('http://localhost:4321/about');
      expect(up.source).toBe('entry');
      expect(up.channel).toMatch(/^[0-9a-f]{32}$/);
      const again = await probe();
      expect(again.url).toBe(up.url);
      expect(again.channel).toBe(up.channel);

      // The entry's dev URL moves: a new proxy, and the old port lets go.
      updateSite(file, path, { dev: 'http://localhost:4322' });
      const moved = await probe();
      expect(moved.url).not.toBe(up.url);
      expect(await answers(Number(proxy.port))).toBe(false);
      expect(await answers(Number(new URL(moved.url).port))).toBe(true);

      // The site leaves the workspace: its proxy closes with it.
      const removed = await answering(req('/api/workspace/remove', { method: 'POST', body: { path } }));
      expect(removed.status).toBe(200);
      expect(await answers(Number(new URL(moved.url).port))).toBe(false);
    } finally {
      await stopEveryChild(ctx);
    }

    addSite(file, host.cwd);
    updateSite(file, path, { dev: 'http://localhost:4321', devCommand: 'npm start' });
    const refusing = createDevHandler(
      contextOver(file, { fetchImpl: (async () => Promise.reject(new Error('down'))) as typeof fetch }),
    );
    const down = (await (await refusing(req(`/api/site/preview?site=${encodeURIComponent(path)}`))).json()) as any;
    expect(down.up).toBe(false);
    expect(down.start).toBe('npm start');
    expect(down.url).toBe('http://localhost:4321/');
  });

  it('closes every proxy when the server closes', async () => {
    const host = snapshotHost();
    const file = workspaceFile();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    updateSite(file, path, { dev: 'http://localhost:4321' });
    const handle = await startDevServer({
      port: 0,
      workspaceFile: file,
      io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
      token: TOKEN,
      page: PAGE,
      fetchImpl: fakeFetch(''),
    });
    const reply = await raw(
      handle.port,
      `GET /api/site/preview?site=${encodeURIComponent(path)} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n` +
        `Authorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
    );
    const port = Number(new URL(/"url":"([^"]+)"/.exec(reply)?.[1] ?? 'http://x').port);
    expect(await answers(port)).toBe(true);
    await handle.close();
    expect(await answers(port)).toBe(false);
  });

  it('names one channel on both panes', async () => {
    const html = await makeHtmlHost();
    const js = snapshotHost();
    const { handler, ctx } = handlerOver([html.cwd, js.cwd]);
    try {
      const read = async (cwd: string): Promise<any> =>
        (await handler(req(`/api/site/preview?site=${encodeURIComponent(realpathSync(cwd))}`))).json();
      const a = await read(html.cwd);
      const b = await read(js.cwd);
      expect(a.channel).toMatch(/^[0-9a-f]{32}$/);
      expect(b.channel).toBe(a.channel);
    } finally {
      await stopEveryChild(ctx);
    }
  });

  it('takes the router’s own pair where the entry names none', async () => {
    const host = snapshotHost();
    writeFileSync(join(host.cwd, 'stet.config.json'), JSON.stringify({ project: 't', router: 'astro' }, null, 2));
    const file = workspaceFile();
    addSite(file, host.cwd);
    const handler = createDevHandler(
      contextOver(file, { fetchImpl: (async () => Promise.reject(new Error('down'))) as typeof fetch }),
    );
    const body = (await (
      await handler(req(`/api/site/preview?site=${encodeURIComponent(realpathSync(host.cwd))}`))
    ).json()) as any;
    expect(body.url).toBe('http://localhost:4321/');
    expect(body.start).toBe('npx astro dev');
    expect(body.source).toBe('router');
  });

  it('points a static-HTML site at the server’s own copy of it', async () => {
    const html = await makeHtmlHost();
    const { handler } = handlerOver([html.cwd]);
    const body = (await (
      await handler(req(`/api/site/preview?site=${encodeURIComponent(realpathSync(html.cwd))}`))
    ).json()) as any;
    expect(body.static).toBe(true);
    expect(body.up).toBe(true);
    expect(body.url).toBe(`http://127.0.0.1:4400/s/${siteId(realpathSync(html.cwd))}/site/`);
  });

  it('holds a static site’s route to a path too, and gives a bare route its slash', async () => {
    const html = await makeHtmlHost();
    const { handler } = handlerOver([html.cwd]);
    const path = encodeURIComponent(realpathSync(html.cwd));
    for (const route of ['//example.com/', 'https://example.com/x']) {
      const res = await handler(req(`/api/site/preview?site=${path}&route=${encodeURIComponent(route)}`));
      expect(res.status, route).toBe(400);
      expect(((await res.json()) as { error: string }).error, route).toBe('route must be a path on the dev server');
    }
    const bare = (await (await handler(req(`/api/site/preview?site=${path}&route=about%2F`))).json()) as any;
    expect(bare.url).toBe(`http://127.0.0.1:4400/s/${siteId(realpathSync(html.cwd))}/site/about/`);
  });

  it('keeps ?route= on the dev server, whatever spelling it carries', async () => {
    const host = snapshotHost();
    const file = workspaceFile();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    updateSite(file, path, { dev: 'http://localhost:4321' });

    const seen: string[] = [];
    const recording = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response('');
    }) as typeof fetch;
    const ctx = contextOver(file, { fetchImpl: recording });
    const handler = createDevHandler(ctx);

    // The three spellings that carry a host, refused before the route is used.
    for (const route of ['//example.com/', 'https://example.com/x', '\\\\example.com', 'javascript:alert(1)']) {
      const res = await handler(
        req(`/api/site/preview?site=${encodeURIComponent(path)}&route=${encodeURIComponent(route)}`),
      );
      expect(res.status, route).toBe(400);
      expect(((await res.json()) as { error: string }).error, route).toBe('route must be a path on the dev server');
    }
    // An ordinary path is a path, including the empty one and one carrying a query.
    for (const route of ['/pricing', '/', '', '/a?b=c']) {
      const res = await handler(
        req(`/api/site/preview?site=${encodeURIComponent(path)}&route=${encodeURIComponent(route)}`),
      );
      expect(res.status, route).toBe(200);
      const body = (await res.json()) as { url: string; dev: string };
      // Framed through the site's proxy, on a port of its own, at the route.
      expect(new URL(body.url).hostname, route).toBe('127.0.0.1');
      expect(new URL(body.dev).origin, route).toBe('http://localhost:4321');
      expect(new URL(body.url).pathname, route).toBe(new URL(body.dev).pathname);
    }
    // Not one probe left the dev server the entry declares.
    expect(seen.length).toBe(4);
    expect(seen.every((url) => url.startsWith('http://localhost:4321/'))).toBe(true);
    await stopEveryChild(ctx);
  });

  it('settles within its own deadline when the probe ignores the abort signal', async () => {
    const host = snapshotHost();
    const file = workspaceFile();
    addSite(file, host.cwd);
    const handler = createDevHandler(
      contextOver(file, { fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch }),
    );
    const started = Date.now();
    const body = (await (
      await handler(req(`/api/site/preview?site=${encodeURIComponent(realpathSync(host.cwd))}`))
    ).json()) as any;
    expect(body.up).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});

describe('GET /api/site/marks', () => {
  /** An adopted checkout with a folder index and a flat page, one sentence shared with index.html. */
  async function markedSite(): Promise<CliHost> {
    return makeHtmlHost({
      files: {
        'about/index.html': ABOUT_PAGE,
        'notes.html': "<html><body><p>Working notes, mine.</p><p>We'll reply within a day.</p></body></html>\n",
      },
      register: true,
    });
  }
  const marksOf = async (host: CliHost): Promise<any> => {
    const { handler } = handlerOver([host.cwd]);
    return get(handler, `/api/site/marks?site=${encodeURIComponent(realpathSync(host.cwd))}`);
  };

  it('answers each document at the route the static arm serves it, and the page it is (journeys B17, B19)', async () => {
    const host = await markedSite();
    const before = await marksOf(host);
    expect(before.documents).toEqual([
      { file: 'about/index.html', route: '/about/', page: null },
      { file: 'index.html', route: '/', page: null },
      { file: 'notes.html', route: '/notes.html', page: null },
    ]);

    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    const after = await marksOf(host);
    expect(after.documents).toEqual([
      { file: 'about/index.html', route: '/about/', page: 'about' },
      { file: 'index.html', route: '/', page: 'home' },
      { file: 'notes.html', route: '/notes.html', page: 'notes' },
    ]);

    // Every key names the documents its mark sits in, each once.
    for (const [key, files] of Object.entries(after.keys as Record<string, string[]>)) {
      expect(new Set(files).size, key).toBe(files.length);
      for (const file of files) expect(readFileSync(join(host.cwd, file), 'utf8'), key).toContain(`"${key}"`);
    }
    const shared = Object.entries(after.keys as Record<string, string[]>).filter(([, files]) => files.length > 1);
    expect(shared.map(([, files]) => [...files].sort())).toEqual([['index.html', 'notes.html']]);
  });

  it('answers the source reads on a JavaScript host, and 401 without the Bearer', async () => {
    const js = snapshotHost();
    writeFileSync(
      join(js.cwd, 'stet.config.json'),
      JSON.stringify({ project: 't', managedSurfaces: ['src/**/*.astro'] }, null, 2),
    );
    write(js.cwd, 'src/pages/index.astro', "---\n---\n<main>\n  <h1>{copy.get('hero_headline')}</h1>\n</main>\n");
    expect(await marksOf(js)).toEqual({
      documents: [],
      keys: {},
      places: { hero_headline: [{ file: 'src/pages/index.astro', line: 4, tag: 'h1', kind: 'headline' }] },
    });
    const { handler } = handlerOver([js.cwd]);
    const refused = await handler(
      req(`/api/site/marks?site=${encodeURIComponent(realpathSync(js.cwd))}`, { token: null }),
    );
    expect(refused.status).toBe(401);
  });

  it('places each mark of an html host: its file, line, tag, and a meta’s attribute and name', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': htmlFixture('derive.html') }, register: true });
    const { places } = await marksOf(host);
    expect(places['home_page_title']).toEqual([
      { file: 'index.html', line: 5, tag: 'title', head: true, kind: 'page title' },
      { file: 'index.html', line: 7, tag: 'meta', attr: 'content', meta: 'og:title', head: true, kind: 'share title' },
    ]);
    expect(places['home_meta_description']).toEqual([
      { file: 'index.html', line: 6, tag: 'meta', attr: 'content', meta: 'description', head: true, kind: 'meta description' },
    ]);
    expect(places['home_share_description_1']).toEqual([
      { file: 'index.html', line: 8, tag: 'meta', attr: 'content', meta: 'og:description', head: true, kind: 'share description' },
    ]);
    expect(places['home_share_description_2']).toEqual([
      { file: 'index.html', line: 9, tag: 'meta', attr: 'content', meta: 'twitter:description', head: true, kind: 'share description' },
    ]);
    expect(places['home_page_headline_1']).toEqual([{ file: 'index.html', line: 14, tag: 'h1', kind: 'headline' }]);
    expect(places['home_nav_aria_label']).toEqual([
      { file: 'index.html', line: 18, tag: 'h3', kind: 'headline' },
      { file: 'index.html', line: 12, tag: 'nav', attr: 'aria-label', kind: 'aria label' },
    ]);
  });

  it("reads the page's head kinds as a superset of the CLI vocabulary's", () => {
    const page = readFileSync(join(packageRoot(), 'dashboard/index.html'), 'utf8');
    const declared = /const HEAD_KINDS = (\[[^\]]*\]);/.exec(page)?.[1];
    expect(declared).toBeDefined();
    const pageKinds = JSON.parse((declared as string).replace(/'/g, '"')) as string[];
    for (const kind of HEAD_KINDS) expect(pageKinds, kind).toContain(kind);
  });

  it('places a `<title>` inside an `<svg>` as the graphic’s', async () => {
    const page =
      '<!DOCTYPE html>\n<html><head><title data-stet="t">Acme</title></head><body>\n' +
      '<button><svg viewBox="0 0 1 1"><title data-stet="close">Close the menu</title></svg></button>\n</body></html>\n';
    const host = await makeHtmlHost({
      files: { 'index.html': page },
      keys: { t: { shape: 'text', target: 'web' }, close: { shape: 'text', target: 'web' } },
      defaults: { t: 'Acme', close: 'Close the menu' },
    });
    const { places } = await marksOf(host);
    expect(places['close']).toEqual([{ file: 'index.html', line: 3, tag: 'title', svg: true, kind: 'tooltip' }]);
    expect(places['t']).toEqual([{ file: 'index.html', line: 2, tag: 'title', head: true, kind: 'page title' }]);
  });

  describe('on a JavaScript host', () => {
    /** The mini project with the given managed files, reading `src/**` and one copy module. */
    function readsHost(files: Record<string, string>): CliHost {
      const host = snapshotHost();
      writeFileSync(
        join(host.cwd, 'stet.config.json'),
        JSON.stringify(
          {
            project: 't',
            managedSurfaces: ['src/**/*.astro', 'src/**/*.vue', 'src/**/*.tsx'],
            copyModules: ['content/copy.ts'],
          },
          null,
          2,
        ),
      );
      for (const [rel, text] of Object.entries(files)) write(host.cwd, rel, text);
      return host;
    }

    it('places each declared read: the element around it, or the file alone', async () => {
      const host = readsHost({
        'src/pages/index.astro':
          "---\nconst name = copy('brand__name');\n---\n<main>\n  <h1>{copy.get('hero_headline')}</h1>\n" +
          "  <a href=\"/docs\">{copy.hero_body}</a>\n  <p>{copy.get('not_declared')} {copy.constructor}</p>\n</main>\n",
        'content/copy.ts': "export const price = copyMap.pricing_price;\n",
      });
      expect((await marksOf(host)).places).toEqual({
        brand__name: [{ file: 'src/pages/index.astro', line: 2, kind: 'text in src/pages/index.astro' }],
        hero_headline: [{ file: 'src/pages/index.astro', line: 5, tag: 'h1', kind: 'headline' }],
        hero_body: [{ file: 'src/pages/index.astro', line: 6, tag: 'a', kind: 'link text' }],
        pricing_price: [{ file: 'content/copy.ts', line: 1, kind: 'text in content/copy.ts' }],
      });
    });

    // Root reads through mode 000, and a virtiofs mount can ignore the mode, so
    // the case proves nothing there.
    it.skipIf(process.getuid?.() === 0)('answers 200 with a managed file it cannot read', async () => {
      const host = readsHost({
        'src/pages/index.astro': "<h1>{copy.get('hero_headline')}</h1>\n",
        'src/pages/locked.astro': "<p>{copy.get('hero_body')}</p>\n",
      });
      chmodSync(join(host.cwd, 'src/pages/locked.astro'), 0o000);
      try {
        const { handler } = handlerOver([host.cwd]);
        const res = await handler(req(`/api/site/marks?site=${encodeURIComponent(realpathSync(host.cwd))}`));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { places: unknown }).places).toEqual({
          hero_headline: [{ file: 'src/pages/index.astro', line: 1, tag: 'h1', kind: 'headline' }],
        });
      } finally {
        chmodSync(join(host.cwd, 'src/pages/locked.astro'), 0o644);
      }
    });

    it('gives a read in a comment or a script no tag, and a bare one its element', async () => {
      const host = readsHost({
        'src/a.astro':
          "<p><!-- {copy.get('hero_headline')} --></p>\n<p><script>const s = copy.get('hero_body');</script></p>\n" +
          "<p>{copy.get('blog_intro')}</p>\n",
      });
      const { places } = await marksOf(host);
      // A read in a comment is no read: the dialect never evaluates it.
      expect(places['hero_headline']).toBeUndefined();
      expect(places['hero_body']).toEqual([{ file: 'src/a.astro', line: 2, kind: 'text in src/a.astro' }]);
      expect(places['blog_intro']).toEqual([{ file: 'src/a.astro', line: 3, tag: 'p', kind: 'paragraph' }]);
    });

    it('reads a .vue file’s template as its markup, and its script as none', async () => {
      const host = readsHost({
        'src/Hero.vue':
          "<template>\n  <section>\n    <h1>{{ copy.get('hero_headline') }}</h1>\n  </section>\n</template>\n" +
          "<script setup>\nconst x = copy.get('hero_body');\n</script>\n",
      });
      const { places } = await marksOf(host);
      expect(places['hero_headline']).toEqual([{ file: 'src/Hero.vue', line: 3, tag: 'h1', kind: 'headline' }]);
      expect(places['hero_body']).toEqual([{ file: 'src/Hero.vue', line: 7, kind: 'text in src/Hero.vue' }]);
    });

    it('reads a Vue-bound attribute by the attribute it binds', async () => {
      const host = readsHost({
        'src/Hero.vue':
          "<template>\n  <a :title=\"copy.hero_headline\" href=\"#\">x</a>\n" +
          "  <img v-bind:alt=\"copy.hero_body\" src=\"/a.png\">\n  <input :placeholder=\"copy.blog_intro\">\n</template>\n",
      });
      const { places } = await marksOf(host);
      expect(places['hero_headline']).toEqual([{ file: 'src/Hero.vue', line: 2, tag: 'a', attr: ':title', kind: 'tooltip' }]);
      expect(places['hero_body']).toEqual([{ file: 'src/Hero.vue', line: 3, tag: 'img', attr: 'v-bind:alt', kind: 'image alt text' }]);
      expect(places['blog_intro']).toEqual([{ file: 'src/Hero.vue', line: 4, tag: 'input', attr: ':placeholder', kind: 'placeholder' }]);
    });

    it('reads the markup after a self-closing `<script />` or `<style />` as markup', async () => {
      const host = readsHost({
        'src/pages/probe.astro':
          '<script type="application/ld+json" set:html={JSON.stringify({ name: copy.hero_body })} />\n' +
          "<a href=\"#\">{copy.hero_headline}</a>\n<style is:inline set:html={css} />\n<p>{copy.blog_intro}</p>\n" +
          '<pre is:raw><script>copy.hero_headline</script><style></style></pre>\n',
      });
      const { places } = await marksOf(host);
      expect(places['hero_headline']).toEqual([{ file: 'src/pages/probe.astro', line: 2, tag: 'a', kind: 'link text' }]);
      expect(places['blog_intro']).toEqual([{ file: 'src/pages/probe.astro', line: 4, tag: 'p', kind: 'paragraph' }]);
      expect(places['hero_body']).toEqual([{ file: 'src/pages/probe.astro', line: 1, kind: 'text in src/pages/probe.astro' }]);
    });

    it('reads a head read as its meta, and a `<title>` as the page title', async () => {
      const host = readsHost({
        'src/Base.astro':
          "---\n---\n<head>\n<meta name=\"description\" content={copy.get('hero_headline')}>\n" +
          "<meta property=\"og:title\" content={copy.hero_body} />\n<title>{copy.get('blog_intro')}</title>\n</head>\n",
      });
      const { places } = await marksOf(host);
      expect(places['hero_headline']).toEqual([
        { file: 'src/Base.astro', line: 4, tag: 'meta', attr: 'content', meta: 'description', head: true, kind: 'meta description' },
      ]);
      expect(places['hero_body']).toEqual([
        { file: 'src/Base.astro', line: 5, tag: 'meta', attr: 'content', meta: 'og:title', head: true, kind: 'share title' },
      ]);
      expect(places['blog_intro']).toEqual([{ file: 'src/Base.astro', line: 6, tag: 'title', head: true, kind: 'page title' }]);
    });

    it('counts braces only in markup, so a brace in frontmatter masks nothing (stage-5 R4)', async () => {
      const host = readsHost({
        'src/pages/index.astro':
          "---\nconst open = '{';\n---\n<head><meta name=\"description\" content={copy.get('hero_body')}></head>\n" +
          "<h1>{copy.get('hero_headline')}</h1>\n",
      });
      const { places } = await marksOf(host);
      expect(places['hero_body']).toEqual([
        { file: 'src/pages/index.astro', line: 4, tag: 'meta', attr: 'content', meta: 'description', head: true, kind: 'meta description' },
      ]);
      expect(places['hero_headline']).toEqual([{ file: 'src/pages/index.astro', line: 5, tag: 'h1', kind: 'headline' }]);
    });

    it('answers no place for a read the dialect prints as text', async () => {
      const host = readsHost({
        'src/pages/docs.astro':
          "<pre is:raw>{copy('hero_headline')}</pre>\n<p>{copy.hero_body}</p>\n<p>The hero_headline key, in prose: copy.get('hero_headline').</p>\n",
      });
      const { places } = await marksOf(host);
      expect(places['hero_headline']).toBeUndefined();
      expect(places['hero_body']).toEqual([{ file: 'src/pages/docs.astro', line: 2, tag: 'p', kind: 'paragraph' }]);
    });

    it('places a read in an svg’s `<title>` as a tooltip, never a head text (F41)', async () => {
      const host = readsHost({
        'src/pages/index.astro':
          "<button><svg viewBox=\"0 0 1 1\"><title>{copy.get('close_label')}</title></svg></button>\n",
      });
      const descriptor = JSON.parse(readFileSync(join(host.cwd, 'content/descriptor.json'), 'utf8')) as Descriptor;
      descriptor.keys['close_label'] = { shape: 'text', target: 'web' };
      writeJsonDeterministic(join(host.cwd, 'content/descriptor.json'), descriptor);
      const snapshot = JSON.parse(readFileSync(join(host.cwd, 'content/defaults.json'), 'utf8'));
      snapshot.default.close_label = 'Close the menu';
      writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), snapshot);
      const { places } = await marksOf(host);
      expect(places['close_label']).toEqual([
        { file: 'src/pages/index.astro', line: 1, tag: 'title', svg: true, kind: 'tooltip' },
      ]);
    });

    it('answers 5,000 reads in a 185,000-byte file within 200 ms', async () => {
      const host = readsHost({ 'src/big.tsx': "const a = copy.get('hero_headline');\n".repeat(5000) });
      expect(readFileSync(join(host.cwd, 'src/big.tsx')).length).toBe(185_000);
      const { handler } = handlerOver([host.cwd]);
      const path = `/api/site/marks?site=${encodeURIComponent(realpathSync(host.cwd))}`;
      await get(handler, `/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`);
      const started = performance.now();
      const { places } = await get(handler, path);
      const took = performance.now() - started;
      expect(places['hero_headline']).toHaveLength(5000);
      expect(places['hero_headline'].at(-1)).toEqual({ file: 'src/big.tsx', line: 5000, kind: 'text in src/big.tsx' });
      expect(took).toBeLessThan(200);
    });

    it('answers a read inside markup nested deeper than a recursive walk reaches with its file, line and element', async () => {
      const host = readsHost({
        'src/deep.astro': '<div>'.repeat(5000) + "{copy.get('hero_headline')}" + '</div>'.repeat(5000) + '\n',
      });
      const { handler } = handlerOver([host.cwd]);
      const res = await handler(req(`/api/site/marks?site=${encodeURIComponent(realpathSync(host.cwd))}`));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { places: Record<string, unknown[]> }).places['hero_headline']).toEqual([
        { file: 'src/deep.astro', line: 1, tag: 'div', kind: 'text in <div>' },
      ]);
    });

    it('answers a 64 KiB run of spaces after `copy` within 200 ms', async () => {
      const host = readsHost({ 'src/spaces.astro': `<p>{copy${' '.repeat(65_536)}}</p>\n<p>{copy.get('hero_body')}</p>\n` });
      const { handler } = handlerOver([host.cwd]);
      const path = `/api/site/marks?site=${encodeURIComponent(realpathSync(host.cwd))}`;
      await get(handler, `/api/site?site=${encodeURIComponent(realpathSync(host.cwd))}`);
      const started = performance.now();
      const { places } = await get(handler, path);
      expect(performance.now() - started).toBeLessThan(200);
      expect(places['hero_body']).toEqual([{ file: 'src/spaces.astro', line: 2, tag: 'p', kind: 'paragraph' }]);
    });
  });
});

/**
 * Whether a process is really gone. Polled rather than asserted once: an exited
 * child stays visible to `kill(pid, 0)` as a zombie until its parent reaps it,
 * and under a loaded suite that lands after the stop returns.
 */
async function waitGone(pid: number, ms = 5_000): Promise<boolean> {
  return gone(pid, ms);
}

describe('gone', () => {
  // Linux only: the case reads `/proc`, and on macOS a zombie under a live
  // non-reaping parent stays reachable by `kill`, while launchd reaps every
  // orphan — the case the helper fixes does not arise there.
  it.skipIf(process.platform !== 'linux')('counts a zombie, and a group of zombies, as ended', async () => {
    // `sh` backgrounds a child in a group of its own, prints its pid, and execs
    // into `sleep`, which never waits for it: the child becomes a zombie that
    // `kill(pid, 0)` and `kill(-pid, 0)` both still reach.
    const shell = spawn('sh', ['-c', 'setsid sleep 0.1 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const zombie = await new Promise<number>((resolve) => {
        shell.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString('utf8').split('\n')[0])));
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The premise: a zombie, and `kill` still answers for it.
      expect(readFileSync(`/proc/${zombie}/stat`, 'utf8')).toMatch(/\) Z /);
      expect(() => process.kill(-zombie, 0)).not.toThrow();

      expect(await gone(zombie, 1_000)).toBe(true);
      expect(await gone(-zombie, 1_000)).toBe(true);
      expect(await gone(shell.pid as number, 200)).toBe(false);
    } finally {
      shell.kill('SIGKILL');
    }
  });
});

describe('the dev child', () => {
  /** Poll `dev-log` until the predicate holds, or give up. */
  async function until(
    handler: (r: Request) => Promise<Response>,
    path: string,
    holds: (body: any) => boolean,
    ms = 4_000,
  ): Promise<any> {
    const deadline = Date.now() + ms;
    let last: any;
    while (Date.now() < deadline) {
      last = await get(handler, path);
      if (holds(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return last;
  }

  /** A workspace holding one checkout with the given dev command. */
  function childHost(devCommand: string, over: Partial<WorkspaceEntry> = {}): {
    handler: (r: Request) => Promise<Response>;
    ctx: DevContext;
    query: string;
  } {
    const host = snapshotHost();
    const file = workspaceFile();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    updateSite(file, path, { devCommand, ...over });
    const ctx = contextOver(file, { fetchImpl: fakeFetch('') });
    return { handler: createDevHandler(ctx), ctx, query: `?site=${encodeURIComponent(path)}` };
  }

  it('starts a compound command in its own group, logs it, and ends the whole group', async () => {
    // A single simple command is exec'd by `sh` IN PLACE, so only the compound
    // form proves the group kill — and `npm run dev` is compound.
    const { handler, query } = childHost(
      `node -e "setInterval(()=>console.log('tick:'+process.pid),50)"; true`,
    );
    const started = await post(handler, `/api/site/dev-start${query}`, {});
    expect(started.status).toBe(200);
    expect(started.body['running']).toBe(true);

    const logged = await until(handler, `/api/site/dev-log${query}`, (b) =>
      (b.lines as string[]).some((line) => line.startsWith('tick:')),
    );
    const tick = (logged.lines as string[]).find((line) => line.startsWith('tick:')) as string;
    const nodePid = Number(tick.slice('tick:'.length));
    expect(nodePid).toBeGreaterThan(0);

    const stopped = await post(handler, `/api/site/dev-stop${query}`, {});
    expect(stopped.status).toBe(200);
    expect(await waitGone(nodePid)).toBe(true);

    // Starting again after a stop works.
    const again = await post(handler, `/api/site/dev-start${query}`, {});
    expect(again.body['running']).toBe(true);
    await post(handler, `/api/site/dev-stop${query}`, {});
  });

  it('ends a child that traps SIGTERM', async () => {
    const { handler, query } = childHost(
      `node -e "process.on('SIGTERM',()=>{});setInterval(()=>console.log('alive:'+process.pid),50)"; true`,
    );
    await post(handler, `/api/site/dev-start${query}`, {});
    const logged = await until(handler, `/api/site/dev-log${query}`, (b) =>
      (b.lines as string[]).some((line) => line.startsWith('alive:')),
    );
    const pid = Number((logged.lines as string[]).find((l) => l.startsWith('alive:'))?.slice('alive:'.length));
    await post(handler, `/api/site/dev-stop${query}`, {});
    expect(await waitGone(pid)).toBe(true);
  }, 20_000);

  it('never hands the child the run token', async () => {
    const { handler, query } = childHost(`node -e "console.log(String(process.env.STET_DEV_TOKEN))"; true`);
    const held = process.env['STET_DEV_TOKEN'];
    process.env['STET_DEV_TOKEN'] = TOKEN;
    try {
      await post(handler, `/api/site/dev-start${query}`, {});
      const logged = await until(handler, `/api/site/dev-log${query}`, (b) => (b.lines as string[]).length > 0);
      expect(logged.lines).toContain('undefined');
      expect((logged.lines as string[]).join('\n')).not.toContain(TOKEN);
    } finally {
      await post(handler, `/api/site/dev-stop${query}`, {});
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
    }
  });

  it('starts an Astro site’s dev command in the foreground, whatever agent environment runs stet', async () => {
    const SHOW = `node -e "console.log('bg:'+String(process.env.ASTRO_DEV_BACKGROUND))"; true`;
    for (const [router, expected] of [['astro', 'bg:1'], ['app', 'bg:undefined']] as const) {
      const host = makeCliHost({ config: { project: 't', router } });
      const file = workspaceFile();
      addSite(file, host.cwd);
      const path = realpathSync(host.cwd);
      updateSite(file, path, { devCommand: SHOW });
      const { handler } = { handler: createDevHandler(contextOver(file, { fetchImpl: fakeFetch('') })) };
      const query = `?site=${encodeURIComponent(path)}`;
      // The command prints and exits, so there is nothing to stop.
      await post(handler, `/api/site/dev-start${query}`, {});
      const logged = await until(handler, `/api/site/dev-log${query}`, (b) => (b.lines as string[]).length > 0);
      expect(logged.lines).toContain(expected);
    }
  });

  describe('under a shell that supplies the store', () => {
    const PAIR = { project: 't', store: { adapter: 'postgrest', urlEnv: 'STET_POSTGREST_URL', tokenEnv: 'STET_POSTGREST_TOKEN' } };
    const SHELL = { STET_POSTGREST_URL: 'http://store.test/rest/v1', STET_POSTGREST_TOKEN: 'proc-token' };
    const SHOW_TOKEN = `node -e "console.log('tok:'+(process.env.STET_POSTGREST_TOKEN??'unset'))"`;

    /** Two checkouts declaring the pair in one workspace, `launched` the first. */
    function pairHosts(
      over: (index: number) => Partial<WorkspaceEntry>,
      second: Record<string, unknown> = PAIR,
    ): {
      handler: (r: Request) => Promise<Response>;
      paths: [string, string];
    } {
      const hosts = [makeCliHost({ config: PAIR }), makeCliHost({ config: second })];
      const file = workspaceFile();
      const paths = hosts.map((host) => realpathSync(host.cwd)) as [string, string];
      for (const [index, host] of hosts.entries()) {
        addSite(file, host.cwd);
        updateSite(file, paths[index] as string, over(index));
      }
      // The dev URL of a site answers until its stop command has run.
      const alive = (async (input: RequestInfo | URL) => {
        const index = Number(new URL(String(input)).port) - 3_001;
        if (existsSync(join(paths[index] as string, 'stop.out'))) throw new Error('connection refused');
        return new Response('');
      }) as typeof fetch;
      const ctx = contextOver(file, { fetchImpl: alive, launched: paths[0] });
      return { handler: createDevHandler(ctx), paths };
    }

    const query = (path: string): string => `?site=${encodeURIComponent(path)}`;

    it('starts the started-in checkout’s dev command with the pair and another checkout’s without it', async () => {
      await withProcessEnv(SHELL, async () => {
        const { handler, paths } = pairHosts(() => ({ devCommand: SHOW_TOKEN }));
        try {
          for (const [index, expected] of [[0, 'tok:proc-token'], [1, 'tok:unset']] as const) {
            const path = paths[index];
            expect((await post(handler, `/api/site/dev-start${query(path)}`, {})).status).toBe(200);
            const logged = await until(handler, `/api/site/dev-log${query(path)}`, (b) => (b.lines as string[]).length > 0);
            expect(logged.lines).toContain(expected);
          }
        } finally {
          for (const path of paths) await post(handler, `/api/site/dev-stop${query(path)}`, {});
        }
      });
    });

    it('starts another checkout’s dev command without the started-in checkout’s variables, whatever names its config uses', async () => {
      const others = {
        'no store': { project: 't' },
        'other names': { project: 't', store: { adapter: 'pg', urlEnv: 'FSG_DATABASE_URL' } },
      };
      for (const [name, config] of Object.entries(others)) {
        await withProcessEnv(SHELL, async () => {
          const { handler, paths } = pairHosts(() => ({ devCommand: SHOW_TOKEN }), config);
          try {
            expect((await post(handler, `/api/site/dev-start${query(paths[1])}`, {})).status, name).toBe(200);
            const logged = await until(handler, `/api/site/dev-log${query(paths[1])}`, (b) => (b.lines as string[]).length > 0);
            expect(logged.lines, name).toContain('tok:unset');
          } finally {
            await post(handler, `/api/site/dev-stop${query(paths[1])}`, {});
          }
        });
      }
    });

    it('starts the started-in checkout’s dev command without a variable the shell holds empty', async () => {
      await withProcessEnv({ ...SHELL, STET_POSTGREST_TOKEN: '' }, async () => {
        const { handler, paths } = pairHosts(() => ({ devCommand: SHOW_TOKEN }));
        try {
          expect((await post(handler, `/api/site/dev-start${query(paths[0])}`, {})).status).toBe(200);
          const logged = await until(handler, `/api/site/dev-log${query(paths[0])}`, (b) => (b.lines as string[]).length > 0);
          expect(logged.lines).toContain('tok:unset');
        } finally {
          await post(handler, `/api/site/dev-stop${query(paths[0])}`, {});
        }
      });
    });

    it('runs each checkout’s stop command in the environment its dev command started in', async () => {
      const writeToken = `node -e "require('fs').writeFileSync('stop.out', process.env.STET_POSTGREST_TOKEN ?? 'unset')"`;
      await withProcessEnv(SHELL, async () => {
        const { handler, paths } = pairHosts((index) => ({
          devCommand: SHOW_TOKEN,
          dev: `http://localhost:${3_001 + index}`,
          devStopCommand: writeToken,
        }));
        for (const path of paths) {
          await post(handler, `/api/site/dev-start${query(path)}`, {});
          await until(handler, `/api/site/dev-log${query(path)}`, (b) => b.state !== 'running');
          expect((await post(handler, `/api/site/dev-stop${query(path)}`, {})).status).toBe(200);
        }
        expect(readFileSync(join(paths[0], 'stop.out'), 'utf8')).toBe('proc-token');
        expect(readFileSync(join(paths[1], 'stop.out'), 'utf8')).toBe('unset');
      });
    }, 20_000);
  });

  it('refuses Start on a site with no dev command and no router default', async () => {
    const html = await makeHtmlHost();
    const file = workspaceFile();
    addSite(file, html.cwd);
    const handler = createDevHandler(contextOver(file));
    const refused = await post(
      handler,
      `/api/site/dev-start?site=${encodeURIComponent(realpathSync(html.cwd))}`,
      {},
    );
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('the workspace entry has no dev command — set it in Setup');
  });

  it('stops the child when the site leaves the workspace, and when the server closes', async () => {
    const { handler, ctx, query } = childHost(`node -e "setInterval(()=>console.log('a:'+process.pid),50)"; true`);
    await post(handler, `/api/site/dev-start${query}`, {});
    const logged = await until(handler, `/api/site/dev-log${query}`, (b) =>
      (b.lines as string[]).some((l) => l.startsWith('a:')),
    );
    const pid = Number((logged.lines as string[]).find((l) => l.startsWith('a:'))?.slice(2));
    const path = decodeURIComponent(query.slice('?site='.length));
    await post(handler, '/api/workspace/remove', { path });
    expect(await waitGone(pid)).toBe(true);
    expect(ctx.children.size).toBe(0);
  });

  it('ends a running child when the server closes', async () => {
    const host = snapshotHost();
    const file = workspaceFile();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    updateSite(file, path, { devCommand: `node -e "setInterval(()=>console.log('b:'+process.pid),50)"; true` });
    const handle = await startDevServer({
      port: 0,
      workspaceFile: file,
      io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
      token: TOKEN,
      page: PAGE,
      fetchImpl: fakeFetch(''),
    });
    const started = await raw(
      handle.port,
      `POST /api/site/dev-start?site=${encodeURIComponent(path)} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n` +
        `Authorization: Bearer ${TOKEN}\r\ncontent-length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(started.split('\r\n')[0]).toContain('200');
    const pid = Number(/"pid":(\d+)/.exec(started)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await handle.close();
    expect(await waitGone(-pid)).toBe(true);
  });

  it('calls a launcher that outlives its own exit detached, and stops it by the entry’s command', async () => {
    const host = snapshotHost();
    const port = 45_921;
    const pidFile = join(host.cwd, 'server.pid');
    const file = workspaceFile();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    updateSite(file, path, {
      dev: `http://127.0.0.1:${port}`,
      devCommand:
        `node -e "const c=require('child_process').spawn(process.execPath,['-e',` +
        `'require(\\"fs\\").writeFileSync(process.argv[1],String(process.pid));require(\\"http\\").createServer((q,s)=>s.end()).listen(${port})',` +
        `'${pidFile}'],{detached:true,stdio:'ignore'});c.unref();console.log('launched')"; true`,
      devStopCommand: `kill $(cat ${pidFile})`,
    });
    // The probe answers while the server does, which is what tells an exited
    // launcher from a dead one, and what the stop path waits on.
    const ctx = contextOver(file, { fetchImpl: portFetch });
    const handler = createDevHandler(ctx);
    const query = `?site=${encodeURIComponent(path)}`;
    await post(handler, `/api/site/dev-start${query}`, {});
    const settled = await until(handler, `/api/site/dev-log${query}`, (b) => b.state === 'detached');
    expect(settled.state).toBe('detached');
    expect(settled.lines).toContain('launched');

    // Give the grandchild a moment to write its pid, then stop it by the
    // entry's own command — the group kill has nothing left to reach.
    await until(handler, `/api/site/dev-log${query}`, () => existsSync(pidFile));
    const stopped = await post(handler, `/api/site/dev-stop${query}`, {});
    expect(stopped.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(await waitGone(grandchild)).toBe(true);
  }, 20_000);
});

/** A fetch that answers only while an HTTP server answers on the URL's port: the suite's offline guard blocks real fetches. */
const portFetch = (async (input: RequestInfo | URL) => {
  if (await answers(Number(new URL(String(input)).port))) return new Response('');
  throw new Error('connection refused');
}) as typeof fetch;

describe('the server’s exit ends every dev server it started', () => {
  /** A listening server over a workspace of `entries`, whose Start goes through its real listener. */
  async function serverOver(
    entries: Array<Partial<WorkspaceEntry>>,
    fetchImpl: typeof fetch,
  ): Promise<{ handle: DevServerHandle; paths: string[]; start(path: string): Promise<number> }> {
    const file = workspaceFile();
    const paths: string[] = [];
    for (const entry of entries) {
      const host = snapshotHost();
      addSite(file, host.cwd);
      const path = realpathSync(host.cwd);
      updateSite(file, path, entry);
      paths.push(path);
    }
    const handle = await startDevServer({
      port: 0,
      workspaceFile: file,
      io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
      token: TOKEN,
      page: PAGE,
      fetchImpl,
    });
    const start = async (path: string): Promise<number> => {
      const reply = await raw(
        handle.port,
        `POST /api/site/dev-start?site=${encodeURIComponent(path)} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n` +
          `Authorization: Bearer ${TOKEN}\r\ncontent-length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      expect(reply.split('\r\n')[0]).toContain('200');
      return Number(/"pid":(\d+)/.exec(reply)?.[1]);
    };
    return { handle, paths, start };
  }

  /** Wait for `holds`, polling, up to `ms`. */
  async function waitFor(holds: () => boolean | Promise<boolean>, ms = 8_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await holds()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  /**
   * A launcher that spawns a detached server writing its pid to `pidFile` and
   * listening on `port`, then `after`. The server shuts down 700 ms after
   * SIGTERM, as a dev server finishing its requests does, so the port is held
   * for a moment after the stop command returns.
   */
  const launcher = (port: number, pidFile: string, after: string): string =>
    `node -e "const c=require('child_process').spawn(process.execPath,['-e',` +
    `'require(\\"fs\\").writeFileSync(process.argv[1],String(process.pid));process.on(\\"SIGTERM\\",()=>setTimeout(()=>process.exit(0),700));require(\\"http\\").createServer((q,s)=>s.end()).listen(${port},\\"127.0.0.1\\")',` +
    `'${pidFile}'],{detached:true,stdio:'ignore'});c.unref();console.log('launched')"; ${after}`;

  for (const [name, port, after] of [
    ['exits once it has spawned', 45_931, 'true'],
    ['keeps running beside', 45_932, 'sleep 30'],
  ] as const) {
    it(`ends a server its launcher left behind, a launcher that ${name} it, within five seconds of close`, async () => {
      expect(await answers(port)).toBe(false);
      const pidDir = tempDir('stet-pid-');
      const pidFile = join(pidDir, 'server.pid');
      const { handle, paths, start } = await serverOver(
        [{ dev: `http://127.0.0.1:${port}`, devCommand: launcher(port, pidFile, after), devStopCommand: `kill $(cat ${pidFile})` }],
        portFetch,
      );
      await start(paths[0] as string);
      expect(await waitFor(() => existsSync(pidFile))).toBe(true);
      expect(await waitFor(() => answers(port))).toBe(true);
      const began = Date.now();
      await handle.close();
      expect(Date.now() - began).toBeLessThan(5_500);
      expect(await answers(port)).toBe(false);
    }, 20_000);
  }

  it('leaves the operator’s own server alone where the launcher failed on its port', async () => {
    const port = 45_933;
    expect(await answers(port)).toBe(false);
    const theirs = createServer((_, res) => res.end('theirs'));
    await new Promise<void>((resolve) => theirs.listen(port, '127.0.0.1', () => resolve()));
    try {
      const marker = join(tempDir('stet-marker-'), 'stop-ran');
      const { handle, paths, start } = await serverOver(
        [{ dev: `http://127.0.0.1:${port}`, devCommand: 'exit 1', devStopCommand: `touch ${marker}` }],
        portFetch,
      );
      const pid = await start(paths[0] as string);
      // The launcher has failed on its own before the close.
      expect(await waitFor(() => gone(pid, 0))).toBe(true);
      await handle.close();
      expect(existsSync(marker)).toBe(false);
      expect(await answers(port)).toBe(true);
    } finally {
      theirs.closeAllConnections();
      await new Promise<void>((resolve) => theirs.close(() => resolve()));
    }
  }, 20_000);

  it('ends two children that trap SIGTERM together', async () => {
    const trap = `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"; true`;
    const { handle, paths, start } = await serverOver([{ devCommand: trap }, { devCommand: trap }], fakeFetch(''));
    const pids = [await start(paths[0] as string), await start(paths[1] as string)];
    await new Promise((resolve) => setTimeout(resolve, 300));
    const began = Date.now();
    await handle.close();
    expect(Date.now() - began).toBeLessThan(3_500);
    for (const pid of pids) expect(await gone(-pid, 0)).toBe(true);
  }, 20_000);
});

describe('the static-HTML site’s own files', () => {
  const at = (host: CliHost, rel: string): string => `/s/${siteId(realpathSync(host.cwd))}/site/${rel}`;

  /** The html host with its context, for the channel it minted; `files` join the shared ones. */
  async function htmlServerWithContext(
    files: Record<string, string> = {},
  ): Promise<{ host: CliHost; handler: (r: Request) => Promise<Response>; ctx: DevContext }> {
    const host = await makeHtmlHost({ files });
    const { handler, ctx } = handlerOver([host.cwd]);
    return { host, handler, ctx };
  }

  async function htmlServer(): Promise<{ host: CliHost; handler: (r: Request) => Promise<Response> }> {
    const host = await makeHtmlHost({
      files: {
        'art.js': 'console.log("art");\n',
        'site.webmanifest': '{"name":"site"}\n',
        'clip.mp4': 'not really a video\n',
        'docs/index.html': '<html><body><p>Docs index page here.</p></body></html>\n',
      },
    });
    return { host, handler: handlerOver([host.cwd]).handler };
  }

  it('serves the checkout’s documents with no Bearer at all', async () => {
    const { host, handler } = await htmlServer();
    const index = await handler(req(at(host, 'index.html'), { token: null }));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toContain('<html');
  });

  it('serves the pane’s own asset requests, which arrive cross-site with no Origin', async () => {
    const { host, handler } = await htmlServer();
    // The sandboxed frame's origin is opaque, so its asset requests look
    // exactly like this. The same headers on the API stay refused.
    const asset = await handler(
      req(at(host, 'art.js'), { token: null, headers: { 'sec-fetch-site': 'cross-site' } }),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(
      (await handler(req('/api/workspace', { headers: { 'sec-fetch-site': 'cross-site' } }))).status,
    ).toBe(403);
  });

  it('serves a directory’s index and the content types it knows', async () => {
    const { host, handler } = await htmlServer();
    expect((await handler(req(at(host, ''), { token: null }))).status).toBe(200);
    expect(await (await handler(req(at(host, 'docs/'), { token: null }))).text()).toContain('Docs index page');
    expect((await handler(req(at(host, 'site.webmanifest'), { token: null }))).headers.get('content-type')).toBe(
      'application/manifest+json',
    );
    expect((await handler(req(at(host, 'clip.mp4'), { token: null }))).headers.get('content-type')).toBe('video/mp4');
  });

  // 8.2 — the preview agent, served and added to documents as they are served
  const AGENT_TAG = /<script src="\/preview-agent\.js" data-parent="([^"]*)" data-channel="([0-9a-f]{32})"><\/script>/;

  it('serves the preview agent with no Bearer, as script, and still checks the Host', async () => {
    const { handler } = await htmlServer();
    const agent = await handler(req('/preview-agent.js', { token: null }));
    expect(agent.status).toBe(200);
    expect(agent.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(agent.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await agent.arrayBuffer())).toEqual(readFileSync(join(packageRoot(), 'templates', 'preview-agent.js')));
    expect((await handler(req('/preview-agent.js', { token: null, host: 'evil.example' }))).status).toBe(403);
  });

  it('adds the agent to a document as it serves it, sandboxed, and never writes the file', async () => {
    const { host, handler, ctx } = await htmlServerWithContext();
    const onDisk = readFileSync(join(host.cwd, 'index.html'));
    const served = await handler(req(at(host, ''), { token: null }));
    const text = await served.text();
    const tag = AGENT_TAG.exec(text);
    expect(tag?.[1]).toBe('http://127.0.0.1:4400');
    expect(text.indexOf(tag?.[0] ?? '<none>')).toBe(text.search(/<\/head\s*>/i) - (tag?.[0].length ?? 0));
    expect(served.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-forms allow-popups');
    expect(readFileSync(join(host.cwd, 'index.html'))).toEqual(onDisk);
    // The tag carries the channel the preview reply names.
    const preview = (await (await handler(req(`/api/site/preview?site=${encodeURIComponent(realpathSync(host.cwd))}`))).json()) as {
      channel: string;
    };
    expect(tag?.[2]).toBe(preview.channel);
    expect(ctx.previewChannel).toBe(preview.channel);
  });

  it('writes no hydration hold on the tag of a static page, which has no hydration to wait for (6.1)', async () => {
    const { host, handler } = await htmlServerWithContext();
    const text = await (await handler(req(at(host, ''), { token: null }))).text();
    expect(text).toMatch(AGENT_TAG);
    expect(text).not.toContain('data-hold');
  });

  it('serves every other file byte for byte, under the same sandbox', async () => {
    const { host, handler } = await htmlServerWithContext({ 'site.css': 'body { color: #123; } /* é */\n' });
    const css = await handler(req(at(host, 'site.css'), { token: null }));
    expect(Buffer.from(await css.arrayBuffer())).toEqual(readFileSync(join(host.cwd, 'site.css')));
    expect(css.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-forms allow-popups');
  });

  it('puts the tag after <body> where a document has no </head>, and keeps every byte of any charset', async () => {
    const { host, handler } = await htmlServerWithContext();
    writeFileSync(join(host.cwd, 'bare.html'), '<html><body class="x"><p>Bare page</p></body></html>\n');
    const bare = await (await handler(req(at(host, 'bare.html'), { token: null }))).text();
    expect(bare).toMatch(/^<html><body class="x"><script src="\/preview-agent\.js" [^>]*><\/script><p>Bare page/);

    // A latin-1 byte and a UTF-8 `é` in one document: both come back as they are.
    const bytes = Buffer.concat([
      Buffer.from('<html><head><title>T</title></head><body><p>caf', 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from(' and café</p></body></html>\n', 'utf8'),
    ]);
    writeFileSync(join(host.cwd, 'mixed.html'), bytes);
    const served = Buffer.from(await (await handler(req(at(host, 'mixed.html'), { token: null }))).arrayBuffer());
    const tag = AGENT_TAG.exec(served.toString('latin1'))?.[0] ?? '';
    expect(tag).not.toBe('');
    expect(Buffer.from(served.toString('latin1').replace(tag, ''), 'latin1')).toEqual(bytes);
  });

  it('refuses the checkout’s own dot files, its node_modules, and a malformed escape', async () => {
    // A checkout holds far more than its pages, and this route carries no
    // Bearer: the connection file and the repository's own internals sit one
    // relative path away from a document the pane legitimately asks for.
    const host = await makeHtmlHost({
      files: {
        'art.js': 'console.log("art");\n',
        '.env': 'DATABASE_URL=postgres://user:secret@localhost/db\n',
        'node_modules/x.js': 'module.exports = 1;\n',
        'sub/page.html': '<html><body><p>A sub page here.</p></body></html>\n',
        'sub/.hidden': 'not yours\n',
      },
      git: true,
    });
    const { handler } = handlerOver([host.cwd]);

    for (const rel of ['.env', '.git/config', '.git/HEAD', 'node_modules/x.js', 'sub/.hidden']) {
      expect((await handler(req(at(host, rel), { token: null }))).status, rel).toBe(404);
    }
    for (const rel of ['index.html', 'art.js', 'sub/page.html']) {
      expect((await handler(req(at(host, rel), { token: null }))).status, rel).toBe(200);
    }
    // A percent-escape that does not decode is a path this server does not
    // have, not a 500 out of `decodeURIComponent`.
    for (const rel of ['%zz', '%', 'a%2']) {
      expect((await handler(req(at(host, rel), { token: null }))).status, rel).toBe(404);
    }
  });

  it('refuses every path that leaves the checkout, a JavaScript site, and a POST', async () => {
    const { host, handler } = await htmlServer();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.txt'), 'not yours\n', 'utf8');
    symlinkSync(join(outside, 'secret.txt'), join(host.cwd, 'escape.txt'));

    expect((await handler(req(at(host, '../etc/passwd'), { token: null }))).status).toBe(404);
    expect((await handler(req(at(host, '/etc/passwd'), { token: null }))).status).toBe(404);
    expect((await handler(req(at(host, 'escape.txt'), { token: null }))).status).toBe(404);
    expect((await handler(req(at(host, 'index.html'), { token: null, method: 'POST' }))).status).toBe(404);

    const js = snapshotHost();
    const { handler: jsHandler } = handlerOver([js.cwd]);
    expect(
      (await jsHandler(req(`/s/${siteId(realpathSync(js.cwd))}/site/index.html`, { token: null }))).status,
    ).toBe(404);
  });
});

/**
 * The page itself, painted.
 *
 * The dashboard is served under a policy that nonces its one script, so an
 * inline event-handler attribute would silently do nothing — and the shell's
 * attributes are only half the surface, since forty-five render sites write
 * their own markup. The proof therefore runs the real page in jsdom against
 * stubbed routes, drives every tab and every key shape, and greps the DOM the
 * page actually built. A `ReferenceError` from a render function reaches the
 * delegated listener uncaught, which jsdom reports; one from a loader is
 * caught by the page's own guard and lands in the toast, which each step reads.
 */
describe('the page', () => {
  const SITE_ID = 'aaaaaaaaaaaa';

  const descriptor: Descriptor = {
    version: 1,
    keys: {
      hero_headline: { shape: 'text', target: 'web', limits: { max: 60, severity: 'advisory' }, pages: ['home'] },
      hero_bullets: { shape: 'list', target: 'web', limits: { max: 40, severity: 'hard' }, pages: ['home'] },
      hero_card: { shape: 'record', target: 'web', pages: ['home'] },
      hero_tone: { shape: 'enum', target: 'web', values: ['calm', 'loud'], pages: ['home'] },
      hero_count: { shape: 'number', target: 'web', pages: ['home'] },
      hero_story: { shape: 'richtext', target: 'web', pages: ['home'] },
      hero_shot: { shape: 'media', target: 'web', pages: ['home'] },
      seo_home_title: { shape: 'text', target: 'web', pages: ['home'] },
      brand__accent: { shape: 'color', target: 'html-email' },
      welcome__subject: { shape: 'text', target: 'html-email', tmpl: 'welcome' },
      loose_key: { shape: 'text', target: 'web' },
      unseeded_key: { shape: 'text', target: 'web' },
    },
    pages: { home: { route: '/', seo: { title: 'seo_home_title' } } },
    templates: { welcome: { class: 'transactional', trigger: 'app-event', slots: ['subject'] } },
  };

  const snapshot = {
    default: {
      hero_headline: 'Ship the copy',
      hero_bullets: ['one', 'two'],
      hero_card: { title: 'Card', body: 'Body' },
      hero_tone: 'calm',
      hero_count: 3,
      hero_story: '<p>A paragraph</p>',
      hero_shot: 'media/hero.png',
      seo_home_title: 'Home',
      brand__accent: '#3355ff',
      welcome__subject: 'Welcome aboard',
      loose_key: 'loose',
    },
    de: { hero_headline: 'Text versenden' },
  };

  /** The reply `GET /api/site` gives for a snapshot-only checkout. */
  function siteBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      state: 'ready',
      name: 'mini',
      path: '/checkouts/mini',
      id: SITE_ID,
      mode: 'snapshot',
      host: 'js',
      keys: Object.keys(descriptor.keys).length,
      locales: ['default', 'de'],
      git: { head: 'abc1234', branch: 'main', dirty: true },
      descriptor,
      snapshot,
      config: {
        locales: { default: 'default', enabled: ['default', 'de'] },
        host: 'js',
        readPath: { file: 'src/stet.ts' },
        descriptorPath: 'stet/descriptor.json',
        snapshotPath: 'stet/defaults.json',
        managedSurfaces: ['src/**/*.tsx'],
        store: { adapter: 'snapshot' },
      },
      environments: [
        { name: 'default', adapter: 'snapshot', vars: [] },
        { name: 'staging', adapter: 'pg', vars: [{ name: 'DATABASE_URL', set: false }] },
      ],
      dev: { dev: 'http://localhost:4321', devCommand: 'npx astro dev', source: 'astro' },
      entry: { path: '/checkouts/mini', pushAfterCommit: false },
      pending: [],
      project: 'default',
      router: 'astro',
      ...over,
    };
  }

  /** The fixture descriptor with no key naming a page, and `home` declared at `/` — the shape an html host's marks group. */
  const unpaged: Descriptor = {
    ...descriptor,
    keys: Object.fromEntries(
      Object.entries(descriptor.keys).map(([id, def]) => {
        const { pages: _pages, ...rest } = def;
        return [id, rest];
      }),
    ),
  };
  /** Every fixture key marked in one document. */
  const allMarkedIn = (file: string, page: string | null): Record<string, unknown> => ({
    documents: [{ file, route: '/', page }],
    keys: Object.fromEntries(Object.keys(descriptor.keys).map((id) => [id, [file]])),
  });

  /** Every route the page can reach, with a body shaped like the real one. */
  function routeTable(site: Record<string, unknown>): Array<[string, number, unknown]> {
    return [
      [
        '/api/workspace',
        200,
        {
          editor: 'dashboard:test',
          version: '0.5.0',
          sites: [
            { state: 'ready', name: 'mini', path: '/checkouts/mini', id: SITE_ID, mode: site['mode'], keys: 11, host: 'js', router: 'astro', project: 'default' },
            { state: 'ready', name: 'other', path: '/checkouts/other', id: 'dddddddddddd', mode: 'snapshot', keys: 4, host: 'html', router: 'app', project: 'other-site' },
            { state: 'not-adopted', name: 'blank', path: '/checkouts/blank', id: 'bbbbbbbbbbbb' },
            { state: 'broken', name: 'bent', path: '/checkouts/bent', id: 'cccccccccccc', message: 'stet.config.json: not JSON' },
          ],
        },
      ],
      ['/api/site/save', 409, { error: 'refused by the save gate', findings: [{ kind: 'limits', level: 'error', key: 'hero_headline', message: 'hero_headline: 71 characters over a 60 limit' }] }],
      ['/api/site/commit', 200, { sha: 'abc1234def', short: 'abc1234', subject: 'stet: 1 key updated — hero_headline', at: site['git'] }],
      ['/api/site/push', 200, { output: 'Everything up-to-date', at: site['git'] }],
      ['/api/site/history', 200, { commits: [{ sha: 'abc1234def', short: 'abc1234', author: 'dev', at: '2026-09-01T10:00:00Z', subject: 'stet: 1 key updated' }] }],
      [
        '/api/site/health',
        200,
        {
          at: { head: 'abc1234', branch: 'main', dirty: true },
          doctor: { code: 0, out: ['mode: snapshot-only', 'host: js'], err: [] },
          check: [{ kind: 'config', level: 'error', key: 'loose_key', message: 'loose_key: declared in the descriptor with no value in the snapshot' }],
          unseeded: [],
          drift: [],
          scan: { findings: [{ kind: 'scan', level: 'warn', slot: { template: 'welcome', name: 'subject' }, message: 'welcome__subject: no file renders this slot' }] },
          audit: {
            orphans: ['hero_tone'],
            unseeded: [],
            drift: [],
            findings: [{ kind: 'config', level: 'warn', key: 'hero_tone', message: 'hero_tone: in the store, not in the descriptor — an orphan, reported never deleted' }],
          },
        },
      ],
      [
        '/api/site/seo',
        200,
        {
          seo: { seo: [{ rule: 'description-missing', severity: 'error', page: 'home', key: 'seo_home_description', message: 'home declares no description key' }] },
          pages: {
            pages: [{ name: 'about', route: '/about', file: 'src/pages/about.astro' }],
            skips: [{ file: 'src/pages/[slug].astro', reason: 'dynamic-route', detail: 'a route parameter', remedy: 'declare this page by hand' }],
          },
        },
      ],
      ['/api/site/pages/declare', 200, { lines: ['declared about'], findings: [], touched: 'src/stet.ts', at: site['git'] }],
      ['/api/site/remove', 200, { applied: false, lines: ['remove hero_headline', '  1 value in the default locale'], findings: [] }],
      ['/api/site/setup', 200, { lines: ['this adapter has no stet_meta — nothing to migrate'], stderr: [], code: 0 }],
      ['/api/site/verify', 200, { templates: [{ template: 'welcome', state: 'PASS', detail: 'the renders match' }] }],
      ['/api/site/dev-log', 200, { running: false, state: 'none', lines: [] }],
      ['/api/site/dev-start', 200, { running: true, state: 'running', pid: 1234, command: 'npx astro dev', lines: [] }],
      ['/api/site/dev-stop', 200, { running: false, state: 'stopped', lines: [] }],
      ['/api/site/marks', 200, { documents: [], keys: {}, places: {} }],
      ['/api/site/carries', 200, { keys: [], files: ['stet/defaults.json'] }],
      [`/s/${SITE_ID}/api/stet/recent`, 200, { rows: [{ id: 3, key: 'hero_headline', locale: 'default', status: 'published', value: 'Ship the copy', publishedAt: '2026-09-01T10:00:00Z' }], nextBeforeId: null }],
      [`/s/${SITE_ID}/api/stet/keys`, 200, { descriptor, rows: [{ key: 'hero_headline', locale: 'default', status: 'draft', value: 'Later', publishAt: '2026-09-09T09:00:00Z' }] }],
      [`/s/${SITE_ID}/api/stet/changes`, 200, { changes: [{ id: 2, name: 'September prices', note: 'the whole page', status: 'scheduled', authorKind: 'human', publishAt: '2026-09-30T09:00:00Z', createdAt: '2026-09-01T09:00:00Z', revertedAt: null }], nextBeforeId: null }],
      [`/s/${SITE_ID}/api/stet/draft`, 200, { versionId: 4, status: 'draft' }],
      [`/s/${SITE_ID}/api/stet/publish`, 200, { versionId: 5 }],
      [`/s/${SITE_ID}/api/stet/discard`, 200, { discarded: 1 }],
      ['/api/workspace/update', 200, { sites: [] }],
      ['/api/workspace/add', 200, { added: true, path: '/checkouts/mini', sites: [] }],
      ['/api/workspace/remove', 200, { sites: [] }],
    ];
  }

  interface Painted extends PaintedPage {
    /** The body `GET /api/workspace` answers. Mutable, so a case can change what a reload sees. */
    workspace: { sites: Array<Record<string, unknown>> };
    /** Change what one route answers from here on: a body, or a function called per request; `delay` holds the reply back. */
    answer(path: string, status: number, body: unknown, delay?: number): void;
  }

  /**
   * The real page, booted in jsdom over stubbed routes. The token rides the
   * address bar exactly as the terminal's link delivers it.
   */
  async function paint(
    opts: {
      site?: Record<string, unknown>;
      preview?: unknown;
      token?: string;
      expects?: string;
      /** The query after `/`; `?t=<token>` by default. */
      url?: string;
      /** The workspace rows, in place of the fixture's. */
      sites?: Array<Record<string, unknown>>;
      /** Routes answered otherwise from the first request: path, status, body (or a function), delay. */
      routes?: Array<[string, number, unknown, number?]>;
      /** Local and session storage as a page before this one left them. */
      storage?: Record<string, string>;
      session?: Record<string, string>;
      /** Run on the page's window before its script. */
      prepare?: (window: Painted['dom']['window']) => void;
      /** Answers every request to the site's mount (`/s/<id>/api/stet/…`) in place of the table. */
      mount?: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
    } = {},
  ): Promise<Painted> {
    const site = opts.site ?? siteBody();
    const table = new Map<string, [number, unknown, number?]>();
    for (const [path, status, body] of routeTable(site)) table.set(path, [status, body]);
    const workspace = (table.get('/api/workspace') as [number, { sites: Array<Record<string, unknown>> }])[1];
    if (opts.sites !== undefined) workspace.sites = opts.sites;
    table.set('/api/site', [200, site]);
    table.set('/api/site/preview', [200, opts.preview ?? { url: 'http://localhost:4321/', up: false, start: 'npx astro dev', source: 'astro' }]);
    for (const [path, status, body, delay] of opts.routes ?? []) table.set(path, [status, body, delay]);

    const page = await paintPage({
      ...(opts.token === undefined ? {} : { token: opts.token }),
      ...(opts.expects === undefined ? {} : { expects: opts.expects }),
      ...(opts.url === undefined ? {} : { url: opts.url }),
      ...(opts.storage === undefined ? {} : { storage: opts.storage }),
      ...(opts.session === undefined ? {} : { session: opts.session }),
      ...(opts.prepare === undefined ? {} : { prepare: opts.prepare }),
      serve: async (path, body) => {
        if (opts.mount !== undefined && path.startsWith(`/s/${SITE_ID}/api/stet/`)) return opts.mount(path, body);
        const found = table.get(path.split('?')[0] ?? '');
        if (found === undefined) return { status: 404, body: { error: 'not found' } };
        if (found[2] !== undefined) await new Promise((resolve) => setTimeout(resolve, found[2]));
        return { status: found[0], body: typeof found[1] === 'function' ? (found[1] as () => unknown)() : found[1] };
      },
    });
    return Object.assign(page, {
      workspace,
      answer(path: string, status: number, body: unknown, delay?: number): void {
        table.set(path, [status, body, delay]);
      },
    });
  }

  /** Every inline event-handler attribute in a tree — the thing the policy forbids. */
  function inlineHandlers(html: string): string[] {
    return html.match(/\bon[a-z]+="/g) ?? [];
  }

  it('says on the Contacts tab where form sign-ups are read (journey E23)', async () => {
    const page = await paint();
    await page.act('tab:Contacts');
    expect(page.errors).toEqual([]);
    expect(page.html()).toContain('<h3>Contacts</h3><span class="bdg">Not built yet.</span>');
    expect(page.html()).toContain(
      'Form sign-ups are stored in your database. Read them in the terminal with stet contacts list — this tab does not show them yet.',
    );
    expect(page.html()).not.toContain('is planned.</');
  });

  it('paints every tab and every key shape with no inline handler and no ReferenceError', async () => {
    const page = await paint();
    const seen: string[] = [];
    const collect = (): void => {
      seen.push(...inlineHandlers(page.html()));
    };
    collect();
    expect(page.errors).toEqual([]);

    // Content, with one key of every declared shape selected in turn. A key no
    // page claims groups by its prefix, so the walk visits every group.
    const walked: string[] = [];
    const groupIds = [...page.dom.window.document.querySelectorAll('#gsel option')].map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(groupIds).toEqual(['all', 'page', 'page:home', 'seo', 'prefix:brand', 'prefix:loose', 'prefix:unseeded', 'prefix:welcome']);
    // Every key and the open page's keys come first; the groups after them hold each key once.
    for (const group of groupIds.slice(2)) {
      await page.change('group', group);
      for (const key of page.keys()) {
        await page.act(`key:${key}`);
        walked.push(key);
        collect();
      }
    }
    expect(walked.sort()).toEqual(Object.keys(descriptor.keys).sort());
    await page.change('locale', 'de');
    collect();
    expect(page.html()).toContain('falls back to default');
    await page.change('locale', 'default');
    await page.change('group', 'page:home');
    await page.act('key:hero_headline');
    await page.act('history');
    await page.act('previewLoad');
    await page.act('removePlan:hero_headline');
    collect();
    expect(page.html()).toContain('remove hero_headline');
    await page.act('removeCancel');
    await page.type('text:hero_headline', 'x'.repeat(71));
    collect();
    expect(page.html()).toContain('1 unsaved edit');
    await page.act('save');
    collect();
    expect(page.html()).toContain('Over the 60-character limit for a text');
    await page.act('saveAnyway');
    collect();
    expect(page.html()).toContain('71 characters over a 60 limit');

    for (const tab of ['Templates', 'Sends', 'Contacts', 'Media', 'Brand', 'SEO', 'Packs', 'Environments', 'Recent', 'Health', 'Setup', 'Content']) {
      await page.act(`tab:${tab}`);
      collect();
    }
    await page.act('tab:Templates');
    await page.act('verify');
    collect();
    await page.act('tab:SEO');
    await page.act('seoLoad');
    collect();
    expect(page.html()).toContain('src/pages/[slug].astro');
    await page.act('tab:Health');
    await page.act('health');
    collect();
    expect(page.html()).toContain('not rendered by the code as of abc1234');
    expect(page.html()).toContain('working tree has uncommitted changes');
    await page.act('tab:Setup');
    await page.act('setupLoad');
    collect();
    await page.act('tab:Recent');
    await page.act('history');
    collect();
    await page.act('cycleEnv');
    await page.act('theme');
    collect();

    expect(seen).toEqual([]);
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('a store-backed site paints Scheduled and the draft bar', async () => {
    const page = await paint({ site: siteBody({ mode: 'memory' }) });
    await page.act('tab:Scheduled');
    await page.act('rowsLoad');
    expect(page.html()).toContain('2026-09-09T09:00:00Z');
    expect(page.html()).toContain('September prices');
    await page.act('tab:Recent');
    await page.act('recentLoad');
    expect(page.html()).toContain('v3');
    await page.act('tab:Content');
    await page.act('key:hero_headline');
    expect(page.html()).toContain('Save draft');
    await page.act('publish');
    expect(page.toast()).toBe('Published hero_headline');
    await page.act('discard');
    expect(inlineHandlers(page.html())).toEqual([]);
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('the two preview panes differ by exactly one sandbox token', async () => {
    // Both panes load on open: nothing is clicked. The static site's marks come
    // through the harness's own marks route.
    const dev = await paint({ preview: { url: 'http://localhost:4321/', up: true, start: 'npx astro dev' } });
    const devFrame = dev.dom.window.document.querySelector('#devwrap iframe');
    expect(devFrame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups');
    dev.dom.window.close();

    const stat = await paint({
      site: siteBody({ host: 'html' }),
      preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
    });
    expect(stat.requested('/api/site/marks')).toHaveLength(1);
    const staticFrame = stat.dom.window.document.querySelector('#devwrap iframe');
    expect(staticFrame?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
    expect(staticFrame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(inlineHandlers(stat.html())).toEqual([]);
    stat.dom.window.close();
  });

  it('a tab with no token behind it is told to reopen, and asks for nothing', async () => {
    const page = await paint({ token: '' });
    expect(page.html()).toContain('token is from an earlier run');
    expect(page.html()).toContain('Open the link the terminal printed');
    expect(page.dom.window.document.getElementById('projs')).toBeNull();
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('a token from an earlier run leaves the address bar and the page says so', async () => {
    // The stub answers 401 to anything but the fixture token, which is the
    // shape a restarted server presents to an open tab.
    const page = await paint({ token: 'stale-token', expects: 'a-newer-run' });
    const table = page.dom.window.document.getElementById('shell')?.innerHTML ?? '';
    expect(table).toContain('token is from an earlier run');
    expect(page.dom.window.location.search).toBe('');
    expect(page.dom.window.sessionStorage.getItem('stet.token')).toBe('stale-token');
    page.dom.window.close();
  });

  it('badges a key the last Health run found unread, orphaned or valueless', async () => {
    const page = await paint();
    await page.act('tab:Health');
    await page.act('health');
    await page.act('tab:Content');
    // The badge on one key's own row, read off that row and nowhere else, and
    // every one from a structured field: `hero_tone` is in audit's `orphans`
    // list, `welcome__subject` carries the scan finding's `slot`, and
    // `unseeded_key` is declared with no value in the snapshot. `loose_key`
    // has a value, so it carries nothing.
    const badgeOn = (key: string): string => {
      const row = page.dom.window.document.querySelector(`[data-act="key:${key}"]`);
      return [...(row?.querySelectorAll('.bdg') ?? [])].map((b) => b.textContent).join(' ');
    };
    expect(badgeOn('hero_tone')).toContain('orphan');
    await page.change('group', 'prefix:welcome');
    expect(badgeOn('welcome__subject')).toContain('not rendered');
    // Declared and absent from the snapshot: the site says so on its own.
    await page.change('group', 'prefix:unseeded');
    expect(badgeOn('unseeded_key')).toContain('no value');
    await page.change('group', 'prefix:loose');
    expect(badgeOn('loose_key')).toBe('');
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  // The four defects the stage-3 browser walk found. Each is asserted here so a
  // later edit cannot put it back.
  it('keeps a filled button legible while the pointer is on it', () => {
    // `.btn:hover:not(:disabled)` outranks `.btn.pri` on specificity, so
    // without these three rules a filled button paints its light label on the
    // light hover ground. jsdom resolves no cascade, so the rule itself is what
    // is pinned.
    const page = dashboardPage();
    expect(page).toContain('.btn.pri:hover:not(:disabled){background:hsl(var(--pri))}');
    expect(page).toContain('.btn.vio:hover:not(:disabled){background:hsl(var(--vi))}');
    expect(page).toContain('.btn.env:hover:not(:disabled){background:hsl(var(--c))}');
  });

  it('follows the typing with the counter on a key that declares no limit', async () => {
    const page = await paint();
    await page.change('group', 'prefix:loose');
    await page.act('key:loose_key');
    const counter = (): string =>
      page.dom.window.document.querySelector('.cnt')?.textContent ?? '';
    expect(counter()).toBe('5');
    await page.type('text:loose_key', 'a much longer value than before');
    expect(counter()).toBe('31');
    page.dom.window.close();
  });

  it('gives the reopen line the whole page, not the sidebar column', async () => {
    const page = await paint({ token: 'stale-token', expects: 'a-newer-run' });
    const shell = page.dom.window.document.getElementById('shell') as HTMLElement | null;
    expect(shell?.style.display).toBe('block');
    page.dom.window.close();
  });

  it('reloads the listing after a write that changed the descriptor', async () => {
    const page = await paint();
    expect(page.html()).toContain('11 keys');
    // What the workspace answers after the removal.
    const row = page.workspace.sites[0];
    expect(row).toBeDefined();
    (row as Record<string, unknown>)['keys'] = 10;
    await page.act('key:hero_headline');
    await page.act('removePlan:hero_headline');
    await page.act('removeApply');
    expect(page.html()).toContain('10 keys');
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  /** The header's Commit and Push as the page draws them: label, blue or grey, and the title where one is set. */
  function gitButtons(page: Painted): Array<{ label: string; blue: boolean; grey: boolean; title: string | null }> {
    return [...page.dom.window.document.querySelectorAll('#gitbar button')].map((b) => ({
      label: b.textContent ?? '',
      blue: b.classList.contains('pri'),
      grey: (b as HTMLButtonElement).disabled,
      title: b.getAttribute('title'),
    }));
  }
  const GIT = { head: 'abc1234', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false, live: 'main' };

  it('Push waits for the commit, then reads its commits, then Pushed (journey B18)', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json'], git: GIT }) });
    // Files a save left uncommitted: a blue Commit, a grey Push.
    expect(gitButtons(page)).toEqual([
      { label: 'Commit', blue: true, grey: false, title: null },
      { label: 'Push', blue: false, grey: true, title: null },
    ]);
    page.answer('/api/site/commit', 200, {
      sha: 'def5678abc',
      short: 'def5678',
      subject: 'stet: 1 key updated — hero_headline',
      at: { ...GIT, head: 'def5678', ahead: 1 },
      pending: [],
    });
    await page.act('commit');
    await page.act('commitApply');
    expect(gitButtons(page)).toEqual([
      { label: 'Commit', blue: false, grey: true, title: null },
      { label: 'Push · 1 commit', blue: true, grey: false, title: null },
    ]);
    // Unsaved work greys Push until it is saved.
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'A headline that fits');
    expect(gitButtons(page)[1]).toEqual({ label: 'Push', blue: false, grey: true, title: null });
    await page.type('text:hero_headline', 'Ship the copy');
    page.answer('/api/site/push', 200, { output: 'To origin\n   abc1234..def5678  main -> main', at: { ...GIT, head: 'def5678' } });
    await page.act('push');
    expect(page.toast()).toBe('Pushed.');
    expect(gitButtons(page)[1]).toEqual({ label: 'Pushed', blue: false, grey: true, title: null });
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('reads Push · new branch, Push · 2 commits, and a grey Push on a detached HEAD', async () => {
    const fresh = await paint({ site: siteBody({ git: { ...GIT, branch: 'develop', upstream: null } }) });
    expect(gitButtons(fresh)[1]).toEqual({ label: 'Push · new branch', blue: true, grey: false, title: null });
    fresh.answer('/api/site/push', 200, {
      output: "branch 'develop' set up to track 'origin/develop'.",
      at: { ...GIT, branch: 'develop', upstream: 'origin/develop' },
      upstream: 'origin',
      branch: 'develop',
    });
    await fresh.act('push');
    expect(fresh.toast()).toBe('Pushed develop to origin and set it as the upstream.');
    expect(gitButtons(fresh)[1]?.label).toBe('Pushed');
    fresh.dom.window.close();

    const ahead = await paint({ site: siteBody({ git: { ...GIT, ahead: 2 } }) });
    expect(gitButtons(ahead)[1]).toEqual({ label: 'Push · 2 commits', blue: true, grey: false, title: null });
    ahead.dom.window.close();

    const detached = await paint({ site: siteBody({ git: { ...GIT, branch: null, upstream: null } }) });
    expect(gitButtons(detached)[1]).toEqual({ label: 'Push', blue: false, grey: true, title: 'HEAD is detached — check out a branch to push' });
    expect(detached.errors).toEqual([]);
    detached.dom.window.close();
  });

  it('commits the files the last reply listed, and names no keys (journey B18)', async () => {
    const page = await paint();
    page.answer('/api/site/save', 200, {
      written: ['stet/defaults.json', 'src/stet.ts'],
      unchanged: [],
      findings: [],
      at: { head: 'abc1234', branch: 'main', dirty: true },
      pending: ['stet/defaults.json', 'src/stet.ts'],
    });
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'A headline that fits');
    await page.act('save');

    // A same-value re-save writes nothing, and the server still lists what the
    // first save left uncommitted — so Commit stays.
    page.answer('/api/site/save', 200, { written: [], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
    await page.act('key:hero_tone');
    await page.change('enum:hero_tone', 'loud');
    await page.act('save');
    expect(page.dom.window.document.querySelector('#gitbar [data-act="commit"]')).not.toBeNull();

    // Commit opens what the commit carries; its own Commit commits.
    page.answer('/api/site/carries', 200, { keys: [], files: ['stet/defaults.json'] });
    await page.act('commit');
    await page.act('commitApply');
    const body = page.sent.filter((r) => r.path.startsWith('/api/site/commit')).at(-1)?.body;
    expect(body).toEqual({ files: ['stet/defaults.json'] });
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('sends each value’s base, names a key changed on disk, and Use theirs or Save mine over it settles it (journey B18)', async () => {
    const page = await paint();
    const disk = { ...snapshot, default: { ...snapshot.default, hero_headline: 'The agent’s headline' } };
    page.answer('/api/site/save', 409, {
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'hero_headline', locale: 'default', disk: 'The agent’s headline' }],
    });
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'The editor’s headline');
    await page.act('save');
    const saves = (): unknown[] => page.sent.filter((r) => r.path.startsWith('/api/site/save')).map((r) => r.body);
    const asks = (): string[] => [...page.dom.window.document.querySelectorAll('.term')].map((el) => el.textContent ?? '');
    expect(saves().at(-1)).toEqual({ values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline', base: 'Ship the copy' }] });
    expect(asks()).toContain('hero_headline changed on disk since you opened it: "The agent’s headline"');

    // Save mine over it: the batch again, the stale key without its base.
    page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
    await page.act('saveMine:0');
    expect(saves().at(-1)).toEqual({ values: [{ key: 'hero_headline', locale: 'default', value: 'The editor’s headline' }] });
    expect(asks().filter((line) => line.includes('changed on disk'))).toEqual([]);

    // Use theirs: the draft and its base dropped, and the disk's words read again.
    page.answer('/api/site', 200, siteBody({ snapshot: disk }));
    await page.type('text:hero_headline', 'A second try');
    page.answer('/api/site/save', 409, {
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'hero_headline', locale: 'default', disk: 'The agent’s headline' }],
    });
    await page.act('save');
    const reads = page.requested('/api/site?').length;
    await page.act('useTheirs:0');
    expect(page.requested('/api/site?').length).toBe(reads + 1);
    expect(asks().filter((line) => line.includes('changed on disk'))).toEqual([]);
    expect((page.dom.window.document.querySelector('[data-act="save"]') as HTMLButtonElement).disabled).toBe(true);
    expect((page.dom.window.document.querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement).value).toBe(
      'The agent’s headline',
    );
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  // Mutation guard: green on the first build by design; it fails when Save mine
  // over one stale key drops the bases of the others.
  it('sends Save mine over one of two stale keys without its base and the other with its own', async () => {
    const page = await paint();
    page.answer('/api/site/save', 409, {
      error: 'changed on disk since the page loaded',
      stale: [
        { key: 'hero_headline', locale: 'default', disk: 'The agent’s headline' },
        { key: 'hero_tone', locale: 'default', disk: 'loud' },
      ],
    });
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'The editor’s headline');
    await page.act('key:hero_tone');
    await page.change('enum:hero_tone', 'loud');
    await page.act('save');
    page.answer('/api/site/save', 409, {
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'hero_tone', locale: 'default', disk: 'loud' }],
    });
    await page.act('saveMine:0');
    const values = (page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body as { values: unknown[] }).values;
    expect(values).toEqual([
      { key: 'hero_headline', locale: 'default', value: 'The editor’s headline' },
      { key: 'hero_tone', locale: 'default', value: 'loud', base: 'calm' },
    ]);
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  // Mutation guard: green on the first build by design; it fails when Use theirs
  // leaves the dropped edit's base behind for the next edit of the key.
  it('sends a fresh edit after Use theirs with the disk’s word as its base', async () => {
    const page = await paint();
    const disk = { ...snapshot, default: { ...snapshot.default, hero_headline: 'The agent’s headline' } };
    page.answer('/api/site/save', 409, {
      error: 'changed on disk since the page loaded',
      stale: [{ key: 'hero_headline', locale: 'default', disk: 'The agent’s headline' }],
    });
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'The editor’s headline');
    await page.act('save');
    page.answer('/api/site', 200, siteBody({ snapshot: disk }));
    await page.act('useTheirs:0');
    page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
    await page.type('text:hero_headline', 'A fresh try');
    await page.act('save');
    expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
      values: [{ key: 'hero_headline', locale: 'default', value: 'A fresh try', base: 'The agent’s headline' }],
    });
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('reads what the commit carries again after a stale Put back, keeps its line, and sends the new now on the next press', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json'] }) });
    const carries = (now: string): void =>
      page.answer('/api/site/carries', 200, {
        keys: [{ key: 'hero_headline', locale: 'default', head: 'Talk to sales today', now }],
        files: ['stet/defaults.json'],
      });
    carries('Talk to us today');
    await page.act('commit');
    const doc = page.dom.window.document;
    const reads = page.requested('/api/site/carries').length;

    // The file changed again after the panel loaded: the refusal is shown over a panel read again.
    page.answer('/api/site/save', 409, { error: 'changed on disk since the page loaded', stale: [{ key: 'hero_headline', locale: 'default', disk: 'Talk to the team' }] });
    carries('Talk to the team');
    await page.act('putBack:0');
    expect(page.requested('/api/site/carries').length).toBe(reads + 1);
    expect(doc.querySelector('#ask .err')?.textContent).toBe('hero_headline changed on disk since you opened it: "Talk to the team"');
    expect([...doc.querySelectorAll('#ask .term')].map((el) => el.textContent)).toEqual(['Talk to [-sales today-] [+the team+]']);

    page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
    await page.act('putBack:0');
    expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
      values: [{ key: 'hero_headline', locale: 'default', value: 'Talk to sales today', base: 'Talk to the team' }],
    });
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('opens what the commit carries, and Put back saves HEAD’s value with the panel’s now as its base (journey B18)', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json', 'src/stet.ts'] }) });
    page.answer('/api/site/carries', 200, {
      keys: [
        { key: 'hero_headline', locale: 'default', head: 'Talk to sales today', now: 'Talk to us today' },
        { key: 'loose_key', locale: 'default', head: 'loose', now: 'tight' },
        { key: 'unseeded_key', locale: 'default', now: 'A new value' },
      ],
      files: ['stet/defaults.json', 'src/stet.ts'],
    });
    await page.act('commit');
    const doc = page.dom.window.document;
    expect(doc.querySelector('#ask h3')?.textContent).toBe('What this commit carries · 3 keys · 2 files');
    const terms = [...doc.querySelectorAll('#ask .term')].map((el) => el.textContent);
    expect(terms).toEqual(['Talk to [-sales-] [+us+] today', '[-loose-] [+tight+]', 'A new value']);
    // A key new since HEAD shows its value with no Put back.
    expect([...doc.querySelectorAll('#ask [data-act^="putBack:"]')].map((el) => el.getAttribute('data-act'))).toEqual(['putBack:0', 'putBack:1']);
    expect(page.sent.filter((r) => r.path.startsWith('/api/site/commit'))).toEqual([]);

    page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json', 'src/stet.ts'] });
    page.answer('/api/site/carries', 200, {
      keys: [{ key: 'hero_headline', locale: 'default', head: 'Talk to sales today', now: 'Talk to us today' }],
      files: ['stet/defaults.json', 'src/stet.ts'],
    });
    await page.act('putBack:1');
    expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
      values: [{ key: 'loose_key', locale: 'default', value: 'loose', base: 'tight' }],
    });
    expect(doc.querySelector('#ask h3')?.textContent).toBe('What this commit carries · 1 key · 2 files');
    expect([...doc.querySelectorAll('#ask .term')].map((el) => el.textContent)).toEqual(['Talk to [-sales-] [+us+] today']);

    // A disk change since the panel loaded: the refusal names the key and the panel stays.
    page.answer('/api/site/save', 409, { error: 'changed on disk since the page loaded', stale: [{ key: 'hero_headline', locale: 'default', disk: 'Talk to the team' }] });
    await page.act('putBack:0');
    expect(doc.querySelector('#ask .err')?.textContent).toBe('hero_headline changed on disk since you opened it: "Talk to the team"');

    await page.act('commitApply');
    expect(page.sent.filter((r) => r.path.startsWith('/api/site/commit')).at(-1)?.body).toEqual({ files: ['stet/defaults.json', 'src/stet.ts'] });
    expect((doc.getElementById('ask') as HTMLElement).hidden).toBe(true);
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('lists a snapshot key’s past values from git, and Restore loads one as an unsaved edit (journey B25)', async () => {
    const page = await paint();
    page.answer('/api/site/key-history', 200, {
      versions: [
        { n: 3, commit: 'c'.repeat(40), short: 'ccccccc', date: '2026-10-03T09:00:00Z', author: 'Ada', value: 'Ship the copy' },
        { n: 2, commit: 'b'.repeat(40), short: 'bbbbbbb', date: '2026-10-02T09:00:00Z', author: 'Grace', value: 'Ship it today' },
        { n: 1, commit: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-10-01T09:00:00Z', author: 'Ada', value: 'First words' },
      ],
    });
    await page.act('key:hero_headline');
    expect(page.requested('/api/site/key-history')).toEqual([
      `/api/site/key-history?site=${encodeURIComponent('/checkouts/mini')}&key=hero_headline&locale=default`,
    ]);
    const doc = page.dom.window.document;
    const card = doc.getElementById('keyhistory') as HTMLElement;
    expect(card.querySelector('h3')?.textContent).toBe('Key history');
    const lines = [...card.querySelectorAll('.hline')].map((el) => el.textContent ?? '');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^v1 · aaaaaaa · 2026-10-0[12] \d\d:\d\d · Ada · First words$/);

    // The third row, restored: the field holds its words, unsaved, and the save carries the stored value as its base.
    await page.act('gitRestore:1');
    expect((doc.querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement).value).toBe('First words');
    expect((doc.querySelector('[data-act="save"]') as HTMLButtonElement).disabled).toBe(false);
    page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
    await page.act('save');
    expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
      values: [{ key: 'hero_headline', locale: 'default', value: 'First words', base: 'Ship the copy' }],
    });
    // The commit history card says what it lists.
    expect([...doc.querySelectorAll('h3')].map((el) => el.textContent)).toContain('Commit history');
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('says some older versions are too large to show when git’s history was cut short', async () => {
    const page = await paint();
    page.answer('/api/site/key-history', 200, {
      versions: [{ n: 1, commit: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-10-01T09:00:00Z', author: 'Ada', value: 'First words' }],
      truncated: true,
    });
    await page.act('key:hero_headline');
    const card = page.dom.window.document.getElementById('keyhistory') as HTMLElement;
    expect(card.querySelectorAll('.hline')).toHaveLength(1);
    expect(card.querySelector('.note')?.textContent).toBe('Some older versions are too large to show.');

    // Every version cut: the card still says so.
    page.answer('/api/site/key-history', 200, { versions: [], truncated: true });
    await page.act('key:hero_tone');
    expect(page.dom.window.document.querySelector('#keyhistory .note')?.textContent).toBe('Some older versions are too large to show.');
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('keeps the caret where the typing is, through the render a keystroke triggers', async () => {
    const page = await paint();
    await page.act('key:hero_headline');
    const field = (): HTMLTextAreaElement =>
      page.dom.window.document.querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement;

    // Select all, then type one character. That keystroke flips the page dirty,
    // which takes a full render, which replaces the field being typed in.
    await page.typeAt('text:hero_headline', 'T', 1);
    expect(field().value).toBe('T');
    expect(field().selectionStart).toBe(1);
    await page.typeAt('text:hero_headline', 'Ty', 2);
    expect(field().value).toBe('Ty');
    expect(field().selectionStart).toBe(2);

    // The search box renders on EVERY keystroke, so every one of them is the
    // same risk rather than only the first.
    const search = (): HTMLInputElement =>
      page.dom.window.document.querySelector('[data-act-input="search"]') as HTMLInputElement;
    await page.typeAt('search', 'h', 1);
    expect(search().value).toBe('h');
    expect(search().selectionStart).toBe(1);
    await page.typeAt('search', 'he', 2);
    expect(search().value).toBe('he');
    expect(search().selectionStart).toBe(2);
    expect(page.errors).toEqual([]);
    page.dom.window.close();
  });

  it('the shipped file carries the nonce placeholder on its one style and its one script', () => {
    const page = dashboardPage();
    expect(page.match(/<style nonce="__STET_NONCE__">/g)).toHaveLength(1);
    expect(page.match(/<script nonce="__STET_NONCE__">/g)).toHaveLength(1);
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
    expect(inlineHandlers(page)).toEqual([]);
    // The one network call the page makes is same-origin and relative.
    expect(page.match(/fetch\(/g)).toHaveLength(1);
    expect(page).toContain('await fetch(path, {');
  });

  // --- the hotfix: fix-dashboard-first-consumers ------------------------------

  const docOf = (page: Painted): Document => page.dom.window.document;
  /** What the page painted — the shell, without the script whose source holds every string. */
  const painted = (page: Painted): string => docOf(page).getElementById('shell')?.innerHTML ?? '';
  /** Poll until `holds`, or give up after `ms` — for the cases that run a real start wait. */
  async function until(holds: () => boolean, ms = 4_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (holds()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return holds();
  }
  const DOWN = { url: 'http://localhost:4321/', up: false, start: 'npx astro dev', source: 'astro' };
  const UP = { url: 'http://localhost:4321/', up: true, start: 'npx astro dev', source: 'astro' };

  // 5.1 — the address bar
  it('opens on the site the address bar names, keeps it there, and reopens it after a reload (journey A18)', async () => {
    const page = await paint({ url: '?t=fixture-token&site=%2Fcheckouts%2Fother' });
    expect(page.requested('/api/site?')[0]).toBe('/api/site?site=%2Fcheckouts%2Fother');
    expect(page.dom.window.location.search).toBe('?site=%2Fcheckouts%2Fother');
    await page.act('site:/checkouts/mini');
    expect(page.dom.window.location.search).toBe('?site=%2Fcheckouts%2Fmini');
    const session = { 'stet.token': page.dom.window.sessionStorage.getItem('stet.token') as string };
    page.dom.window.close();

    // The reload: the site in the bar, no token in it, the token in session
    // storage. The stub refuses any request not carrying the stored token.
    const reload = await paint({ url: '?site=%2Fcheckouts%2Fmini', session });
    expect(reload.requested('/api/site?')[0]).toBe('/api/site?site=%2Fcheckouts%2Fmini');
    expect(painted(reload)).not.toContain('token is from an earlier run');
    expect(painted(reload)).toContain('store id other-site');
    expect(reload.errors).toEqual([]);
    reload.dom.window.close();
  });

  // 5.2 — the committable files in the header, the refusal under it
  it('counts the uncommitted stet files in the header, names them, and offers Commit with no key selected (journey B18)', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json', 'src/stet.ts'] }) });
    const doc = docOf(page);
    const line = doc.querySelector('#gitbar span') as HTMLElement;
    expect(line.textContent).toBe('2 stet files not yet committed');
    expect(line.getAttribute('title')).toBe('stet/defaults.json\nsrc/stet.ts');
    expect(doc.querySelector('#gitbar [data-act="commit"]')?.className).toBe('btn sm pri');
    expect((doc.querySelector('#gitbar [data-act="push"]') as HTMLButtonElement).disabled).toBe(true);
    expect(doc.querySelector('.row.on')).toBeNull();
    // The unsaved-edit badge is hidden until there is an edit.
    expect((doc.getElementById('dc') as HTMLElement).hidden).toBe(true);
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'x');
    expect((doc.getElementById('dc') as HTMLElement).hidden).toBe(false);
    expect(doc.getElementById('dc')?.textContent).toBe('1 unsaved edit');
    page.dom.window.close();
  });

  it('shows a refused commit and a failed push under the header with git’s output, until Dismiss (journey B18)', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json', 'src/stet.ts'] }) });
    const doc = docOf(page);
    const card = (): HTMLElement => doc.getElementById('giterr') as HTMLElement;
    page.answer('/api/site/commit', 409, {
      error: 'git commit failed',
      output: '\u001b[31merror:\u001b[0m hook says no',
      pending: ['stet/defaults.json'],
    });
    // No key selected: the card is the page's, not the editor's.
    await page.act('commit');
    await page.act('commitApply');
    expect(card().hidden).toBe(false);
    expect(card().textContent).toContain("The commit was refused. Git's output is below.");
    expect(card().querySelector('.term')?.textContent).toBe('git commit failed\nerror: hook says no');
    expect(card().innerHTML).not.toContain('\u001b');
    // The refusal's own list is the one the header shows now.
    expect(doc.querySelector('#gitbar span')?.textContent).toBe('1 stet file not yet committed');

    page.answer('/api/site/commit', 200, {
      sha: 'def5678abc',
      short: 'def5678',
      subject: 'stet: 1 file updated — stet/defaults.json',
      at: { head: 'def5678', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, dirty: false },
      pending: [],
    });
    await page.act('commit');
    await page.act('commitApply');
    page.answer('/api/site/push', 409, { error: 'git push failed', output: 'fatal: No configured push destination.' });
    await page.act('push');
    expect(card().textContent).toContain("The push failed. Git's output is below.");
    expect(card().querySelector('.term')?.textContent).toBe('git push failed\nfatal: No configured push destination.');

    // Dismiss takes the card down and refits the frame it had pushed down.
    let fits = 0;
    (page.dom.window as unknown as { fitFrame: () => void }).fitFrame = () => {
      fits += 1;
    };
    await page.act('gitErrorDismiss');
    expect(card().hidden).toBe(true);
    expect(card().innerHTML).toBe('');
    expect(fits).toBeGreaterThan(0);
    page.dom.window.close();
  });

  it('shows a hook’s output as text, never as markup, and drops terminal link codes (journey B18)', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json'] }) });
    const doc = docOf(page);
    const images = doc.querySelectorAll('img').length;
    const output =
      '<img src=x onerror="window.__pwned=1"><b id="inj">bold</b></div></div><script>window.__pwned=2</script>\n' +
      '\u001b]8;;http://lint.example/rule\u0007see the rule\u001b]8;;\u0007 and \u001b]0;a title\u001b\\done';
    page.answer('/api/site/commit', 409, { error: 'git commit failed', output, pending: ['stet/defaults.json'] });
    await page.act('commit');
    await page.act('commitApply');
    const card = doc.getElementById('giterr') as HTMLElement;
    expect(card.hidden).toBe(false);
    expect(card.querySelector('img, script, b')).toBeNull();
    expect(doc.getElementById('inj')).toBeNull();
    expect(doc.querySelectorAll('img')).toHaveLength(images);
    expect(card.querySelector('.term')?.textContent).toBe(
      'git commit failed\n' +
        '<img src=x onerror="window.__pwned=1"><b id="inj">bold</b></div></div><script>window.__pwned=2</script>\n' +
        'see the rule and done',
    );
    expect((page.dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    page.dom.window.close();
  });

  it('clears the last refusal before the next commit posts', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json'] }) });
    const card = (): HTMLElement => docOf(page).getElementById('giterr') as HTMLElement;
    page.answer('/api/site/commit', 409, { error: 'git commit failed', output: 'no', pending: ['stet/defaults.json'] });
    await page.act('commit');
    await page.act('commitApply');
    expect(card().hidden).toBe(false);
    // Held back, so the card is read while the commit is still in flight.
    page.answer('/api/site/commit', 409, { error: 'git commit failed', output: 'no', pending: ['stet/defaults.json'] }, 300);
    await page.act('commit');
    await page.act('commitApply');
    expect(page.requested('/api/site/commit')).toHaveLength(2);
    expect(card().hidden).toBe(true);
    // The held reply lands before the window goes, so nothing paints into a closed page.
    expect(await until(() => !card().hidden)).toBe(true);
    page.dom.window.close();
  });

  // 5.3 — the sidebar
  it('tells two projects named alike apart, and names each ready row’s host and store id (journey A19)', async () => {
    const row = (path: string, host: string, router: string, project: string): Record<string, unknown> => ({
      state: 'ready',
      name: path.split('/').pop(),
      path,
      id: path.replace(/\W/g, '').slice(-12),
      mode: 'snapshot',
      keys: 3,
      host,
      router,
      project,
    });
    const rows = (page: Painted): string[][] =>
      [...docOf(page).querySelectorAll('#projs .it')].map((button) => [
        button.childNodes[0]?.textContent ?? '',
        ...[...button.querySelectorAll('.u')].slice(1).map((line) => line.textContent ?? ''),
      ]);

    const first = await paint({
      sites: [
        row('/a/stet-website-v1/site', 'js', 'astro', 'default'),
        row('/a/stet-planning/site', 'js', 'astro', 'default'),
        row('/a/psyon-site', 'html', 'app', 'psyon'),
      ],
    });
    expect(rows(first)).toEqual([
      ['stet-website-v1/site', 'js host · astro'],
      ['stet-planning/site', 'js host · astro'],
      ['psyon-site', 'html host', 'store id psyon'],
    ]);
    first.dom.window.close();

    const second = await paint({
      sites: [row('/a/x/site', 'js', 'app', 'a'), row('/b/x/site', 'js', 'app', 'b'), row('/c/y/site', 'js', 'app', 'c')],
    });
    expect(rows(second).map((r) => r[0])).toEqual(['a/x/site', 'b/x/site', 'y/site']);
    second.dom.window.close();
  });

  // 10.1 — Rename
  describe('Rename (journey A22)', () => {
    const miniRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      state: 'ready', name: 'mini', path: '/checkouts/mini', id: SITE_ID, mode: 'snapshot', keys: 11, host: 'js', router: 'astro', project: 'default', ...over,
    });
    const labels = (page: Painted): string[][] =>
      [...docOf(page).querySelectorAll('#projs .it')].map((button) => [
        button.childNodes[0]?.textContent ?? '',
        ...[...button.querySelectorAll('.u')].map((line) => line.textContent ?? ''),
      ]);
    const updates = (page: Painted): unknown[] =>
      page.sent.filter((r) => r.path.startsWith('/api/workspace/update')).map((r) => r.body);

    it('renames a project, shows the name with the folder line under it, and clears it', async () => {
      const page = await paint();
      expect(labels(page)[0]).toEqual(['mini', 'snapshot-only · 11 keys', 'js host · astro']);
      expect(docOf(page).querySelectorAll('#projs [data-act^="renameOpen:"]')).toHaveLength(4);

      await page.act('renameOpen:/checkouts/mini');
      const field = docOf(page).querySelector('[data-act-input="renameName"]') as HTMLInputElement;
      expect(field.value).toBe('mini');
      page.answer('/api/workspace/update', 200, { sites: [miniRow({ name: 'Taskboard', folder: 'mini' })] });
      await page.type('renameName', 'Taskboard');
      await page.act('renameSave');
      expect(updates(page)).toEqual([{ path: '/checkouts/mini', name: 'Taskboard' }]);
      expect(labels(page)[0]).toEqual(['Taskboard', 'mini', 'snapshot-only · 11 keys', 'js host · astro']);
      expect(docOf(page).getElementById('crumb')?.textContent).toContain('Taskboard');
      expect(docOf(page).querySelector('[data-act-input="renameName"]')).toBeNull();

      await page.act('renameOpen:/checkouts/mini');
      expect((docOf(page).querySelector('[data-act-input="renameName"]') as HTMLInputElement).value).toBe('Taskboard');
      page.answer('/api/workspace/update', 200, { sites: [miniRow()] });
      await page.type('renameName', '');
      await page.act('renameSave');
      expect(updates(page).at(-1)).toEqual({ path: '/checkouts/mini', name: '' });
      expect(labels(page)[0]).toEqual(['mini', 'snapshot-only · 11 keys', 'js host · astro']);
      expect(docOf(page).getElementById('crumb')?.textContent).toContain('mini');
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('keeps a name the server refused open with its line, and ends on Escape with nothing sent', async () => {
      const page = await paint();
      await page.act('renameOpen:/checkouts/mini');
      page.answer('/api/workspace/update', 409, { error: 'no such project' });
      await page.type('renameName', 'Taskboard');
      await page.act('renameSave');
      expect(page.toast()).toBe('no such project');
      expect(docOf(page).querySelector('[data-act-input="renameName"]')).not.toBeNull();
      const field = docOf(page).querySelector('[data-act-input="renameName"]') as HTMLInputElement;
      field.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await page.settle();
      expect(docOf(page).querySelector('[data-act-input="renameName"]')).toBeNull();
      expect(updates(page)).toHaveLength(1);
      page.dom.window.close();
    });

    it('saves on Enter in the field', async () => {
      const page = await paint();
      await page.act('renameOpen:/checkouts/mini');
      page.answer('/api/workspace/update', 200, { sites: [miniRow({ name: 'Taskboard', folder: 'mini' })] });
      await page.type('renameName', 'Taskboard');
      const field = docOf(page).querySelector('[data-act-input="renameName"]') as HTMLInputElement;
      field.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await page.settle();
      expect(updates(page)).toEqual([{ path: '/checkouts/mini', name: 'Taskboard' }]);
      page.dom.window.close();
    });

    // D19 — the project's name in Setup (T19.1, T19.3)
    describe('Setup names the project (D19)', () => {
      const setupHeading = (page: Painted): string =>
        [...docOf(page).querySelectorAll('.card .ch h3')].map((h) => h.textContent ?? '').find((t) => t !== 'Attribution' && !t.startsWith('Pending')) ?? '';
      const projname = (page: Painted): HTMLInputElement => docOf(page).getElementById('projname') as HTMLInputElement;

      it('shows the field first with the folder as its placeholder, and renames through workspace/update', async () => {
        const page = await paint();
        await page.act('tab:Setup');
        expect(projname(page).value).toBe('');
        expect(projname(page).placeholder).toBe('mini');
        expect(painted(page)).toContain('Shown in this dashboard only; the folder keeps its name. Leave it empty to show the folder\'s name.');
        expect((projname(page).closest('.cb') as HTMLElement).querySelector('input')?.id).toBe('projname');

        page.answer('/api/workspace/update', 200, { sites: [miniRow({ name: 'Marketing site', folder: 'mini' })] });
        await page.change('entryName', 'Marketing site');
        expect(updates(page)).toEqual([{ path: '/checkouts/mini', name: 'Marketing site' }]);
        expect(labels(page)[0]).toEqual(['Marketing site', 'mini', 'snapshot-only · 11 keys', 'js host · astro']);
        expect(setupHeading(page)).toBe('Marketing site');
        expect(docOf(page).getElementById('sidetoggle')?.textContent).toContain('Marketing site');
        expect(projname(page).value).toBe('Marketing site');
        expect(projname(page).placeholder).toBe('mini');

        page.answer('/api/workspace/update', 200, { sites: [miniRow()] });
        await page.change('entryName', '');
        expect(updates(page).at(-1)).toEqual({ path: '/checkouts/mini', name: '' });
        expect(labels(page)[0]?.[0]).toBe('mini');
        expect(setupHeading(page)).toBe('mini');
        expect(docOf(page).getElementById('sidetoggle')?.textContent).toContain('mini');
        expect(projname(page).value).toBe('');
        expect(page.errors).toEqual([]);
        page.dom.window.close();
      });

      it('shows a refused name and leaves every label as it was', async () => {
        const page = await paint();
        await page.act('tab:Setup');
        page.answer('/api/workspace/update', 400, { error: 'the name was refused' });
        await page.change('entryName', 'Marketing site');
        expect(page.toast()).toBe('the name was refused');
        expect(labels(page)[0]?.[0]).toBe('mini');
        expect(setupHeading(page)).toBe('mini');
        page.dom.window.close();
      });
    });

    it('tells two unnamed twins apart by folder, and never extends a name', async () => {
      const page = await paint({
        sites: [
          miniRow({ path: '/a/x/site', name: 'site' }),
          miniRow({ path: '/b/x/site', name: 'Taskboard', folder: 'site' }),
          miniRow({ path: '/c/y/site', name: 'site' }),
          // A name that spells another row's folder is still the name, never extended.
          miniRow({ path: '/d/q/proj', name: 'site', folder: 'proj' }),
        ],
      });
      expect(labels(page).map((row) => row[0])).toEqual(['a/x/site', 'Taskboard', 'y/site', 'site']);
      page.dom.window.close();
    });
  });

  // 10.2 — "project" for a workspace entry
  describe('the word project (journey A19)', () => {
    // The fixture's own path is /checkouts/mini: only the page's words are read.
    const noCheckout = (text: string): void => expect(text.replace(/\/checkouts\//g, '/').replace(/\s+/g, ' ')).not.toMatch(/checkout/i);

    it('heads the sidebar Projects and asks for a project path', async () => {
      const page = await paint({ sites: [] });
      const doc = docOf(page);
      expect(doc.querySelector('.side .lbl')?.textContent).toBe('Projects');
      expect(doc.getElementById('addpath')?.getAttribute('placeholder')).toBe('/absolute/path/to/project');
      expect(doc.querySelector('[data-act="addSite"]')?.textContent).toBe('Add a project');
      expect(doc.getElementById('pjnote')?.textContent).toBe('no projects yet — add one below');
      expect(doc.getElementById('work')?.textContent ?? '').toContain('Add a project to begin. The path must be absolute and hold a stet project.');
      noCheckout(doc.querySelector('.side')?.textContent ?? '');
      noCheckout(doc.getElementById('main')?.textContent ?? '');
      page.dom.window.close();
    });

    it('says project on the Health tab with no project and after a run with no head', async () => {
      const empty = await paint({ sites: [] });
      await empty.act('tab:Health');
      expect(docOf(empty).getElementById('main')?.textContent).toContain('Add a project to run Health against it.');
      noCheckout(docOf(empty).getElementById('main')?.textContent ?? '');
      empty.dom.window.close();

      const page = await paint();
      await page.act('tab:Health');
      page.answer('/api/site/health', 200, {
        at: { head: null, branch: null, dirty: false },
        doctor: { code: 0, out: [], err: [] }, check: [], unseeded: [], drift: [], scan: { findings: [] }, audit: { orphans: [], unseeded: [], drift: [], findings: [] },
      });
      await page.act('health');
      expect(page.toast()).toBe('Health ran against this project');
      page.dom.window.close();
    });

    it('offers Remove this project in Setup, and says the static pane is served from the project', async () => {
      const page = await paint();
      await page.act('tab:Setup');
      expect(docOf(page).querySelector('[data-act="removeSite"]')?.textContent).toBe('Remove this project');
      noCheckout(docOf(page).getElementById('main')?.textContent ?? '');
      page.dom.window.close();

      const stat = await paint({
        site: siteBody({ host: 'html' }),
        preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
      });
      expect(docOf(stat).getElementById('pane')?.textContent).toContain('Served read-only from the project by this server.');
      noCheckout(docOf(stat).getElementById('pane')?.textContent ?? '');
      stat.dom.window.close();
    });
  });

  // 10.3 — the environment line
  describe('the environment line (journey B8)', () => {
    const UP = { url: 'http://localhost:4321/', up: true, start: 'npx astro dev', source: 'astro' };
    const line = (page: Painted): string => {
      const el = docOf(page).getElementById('paneenv') as HTMLElement | null;
      return el === null || el.hidden ? '' : el.textContent ?? '';
    };
    const store = (previewReads: unknown, over: Record<string, unknown> = {}): Record<string, unknown> =>
      siteBody({ mode: 'memory', previewReads, ...over });
    const SNAPSHOT_LINE = 'The preview shows content/defaults.json as this project holds it. Store drafts and publishes appear only as the dashboard layers them.';

    it('says the preview shows the snapshot where the read path reads it, in any environment', async () => {
      const page = await paint({ site: store({ snapshot: 'content/defaults.json' }), preview: UP });
      expect(line(page)).toBe(SNAPSHOT_LINE);
      await page.act('cycleEnv');
      expect(docOf(page).querySelector('.envchip')?.textContent).toContain('staging');
      expect(line(page)).toBe(SNAPSHOT_LINE);
      page.dom.window.close();
    });

    it('says the preview reads the selected environment’s store where the dev server’s own holds it', async () => {
      const page = await paint({ site: store({ stores: { default: true, staging: true } }), preview: UP });
      await page.act('cycleEnv');
      expect(line(page)).toBe('The preview reads the staging store, the one this tab edits.');
      page.dom.window.close();
    });

    it('says the preview reads the dev server’s own store where it does not, and follows the environment switch', async () => {
      const page = await paint({ site: store({ stores: { default: true, staging: false } }), preview: UP });
      expect(line(page)).toBe('The preview reads the default store, the one this tab edits.');
      await page.act('cycleEnv');
      expect(line(page)).toBe("The preview reads the dev server's own store, not staging.");
      await page.act('cycleEnv');
      expect(line(page)).toBe('The preview reads the default store, the one this tab edits.');
      page.dom.window.close();
    });

    it('shows no line on a snapshot site, with no dev-server pane, or on a reply that names none', async () => {
      const snap = await paint({ site: siteBody({ previewReads: { snapshot: 'content/defaults.json' } }), preview: UP });
      expect(line(snap)).toBe('');
      snap.dom.window.close();
      const stat = await paint({
        site: store({ snapshot: 'content/defaults.json' }, { host: 'html' }),
        preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
      });
      expect(line(stat)).toBe('');
      stat.dom.window.close();
      const down = await paint({ site: store({ snapshot: 'content/defaults.json' }), preview: { ...UP, up: false } });
      expect(line(down)).toBe('');
      down.dom.window.close();
      const none = await paint({ site: store(undefined), preview: UP });
      expect(line(none)).toBe('');
      none.dom.window.close();
    });

    it('reads an environment the reply does not list as the dev server’s own store', async () => {
      const page = await paint({ site: store({ stores: {} }), preview: UP });
      expect(line(page)).toBe("The preview reads the dev server's own store, not default.");
      page.dom.window.close();
    });
  });

  // 11.2 — the email preview on the Templates tab
  describe('the email preview (journey B4, 11.2)', () => {
    const HEADLINE = 'welcome__headline';
    const text = { shape: 'text', target: 'html-email' } as const;
    const mailDescriptor: Descriptor = {
      version: 1,
      keys: {
        [HEADLINE]: { ...text, limits: { max: 60, severity: 'advisory' } },
        welcome__subject: text,
        welcome__preheader: text,
        welcome__greeting: { ...text, vars: ['name'], requires: ['name'] },
      },
      templates: {
        welcome: {
          class: 'transactional',
          trigger: 'app-event',
          slots: ['headline', 'subject', 'preheader', 'greeting'],
          render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: { name: 'Ada' } },
        },
        receipt: { class: 'transactional', trigger: 'app-event', slots: [] },
      },
    };
    const mailSnapshot = {
      default: {
        [HEADLINE]: 'Welcome to mirra',
        welcome__subject: 'Welcome aboard',
        welcome__preheader: '',
        welcome__greeting: 'Hi {{name}}',
      },
    };
    const mark = (key: string, value: string): string => `<span data-stet="${key}">${value}</span>`;
    const mail = (headline = 'Welcome to mirra'): string =>
      `<html><body><h1>${mark(HEADLINE, headline)}</h1><p>${mark('welcome__greeting', 'Hi Ada')}</p><a href="https://x.test/">link</a></body></html>`;
    const reply = (html = mail(), over: Record<string, unknown> = {}): unknown => ({ html, subject: 'Welcome aboard', preheader: '', ...over });
    const mailSite = (over: Record<string, unknown> = {}): Record<string, unknown> => siteBody({ descriptor: mailDescriptor, snapshot: mailSnapshot, ...over });
    const previews = (page: Painted): Array<{ template: string; locale: string; drafts: Record<string, unknown>; env?: string }> =>
      page.sent.filter((r) => r.path.startsWith('/api/site/email-preview')).map((r) => r.body as never);
    const frameOf = (page: Painted): HTMLIFrameElement | null => docOf(page).querySelector('iframe[data-tpl-frame="welcome"]');
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    /** The Templates tab of a site whose preview answers `body`. */
    async function open(body: unknown = reply(), site: Record<string, unknown> = mailSite()): Promise<Painted> {
      const page = await paint({ site, routes: [['/api/site/email-preview', 200, body]] });
      await page.act('tab:Templates');
      if (frameOf(page) !== null) loadFrame(page);
      return page;
    }
    /**
     * jsdom does not load a frame's `srcdoc`, so the document a browser would load into it is put in its body,
     * which leaves the listeners the page attached to that document where they are.
     */
    const loadFrame = (page: Painted): void => {
      const frame = frameOf(page) as HTMLIFrameElement;
      const parsed = new page.dom.window.DOMParser().parseFromString(frame.getAttribute('srcdoc') as string, 'text/html');
      ((frame.contentDocument as Document).body as HTMLElement).innerHTML = parsed.body.innerHTML;
      frame.dispatchEvent(new page.dom.window.Event('load'));
    };
    /** A click on a marked text inside the frame, as the dashboard's listener on the frame's document hears it. */
    const clickIn = (page: Painted, selector: string): void => {
      const doc = (frameOf(page) as HTMLIFrameElement).contentDocument as Document;
      const hit = doc.querySelector(selector) as HTMLElement;
      expect(hit, selector).not.toBeNull();
      hit.dispatchEvent(new page.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    };

    it('shows each template with a pointer in a frame that runs no scripts, and says what it is rendered from', async () => {
      const page = await open();
      const doc = docOf(page);
      expect(doc.querySelectorAll('[data-tpl]')).toHaveLength(1);
      const frame = frameOf(page) as HTMLIFrameElement;
      expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
      expect(frame.getAttribute('srcdoc')).toBe(mail());
      expect(doc.querySelector('[data-tpl="welcome"]')?.textContent).toContain("Images hosted on other sites don't show in this preview.");
      // Subject and Preview with their keys, and (empty) where a slot is empty.
      const meta = (doc.querySelector('[data-tpl-meta="welcome"]') as HTMLElement).textContent as string;
      expect(meta).toContain('Subject Welcome aboard');
      expect(meta).toContain('welcome__subject');
      expect(meta).toContain('Preview (empty)');
      expect(meta).toContain('welcome__preheader');
      expect(previews(page)).toEqual([{ template: 'welcome', locale: 'default', drafts: {} }]);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('the page adds nothing to the frame but a stylesheet and a click listener, and no other frame allows scripts and the dashboard’s origin together', async () => {
      const page = await open();
      for (const el of docOf(page).querySelectorAll('iframe')) {
        const sandbox = el.getAttribute('sandbox') ?? '';
        expect(sandbox.includes('allow-scripts') && sandbox.includes('allow-same-origin')).toBe(false);
      }
      const doc = (frameOf(page) as HTMLIFrameElement).contentDocument as Document;
      expect(doc.querySelectorAll('script')).toHaveLength(0);
      expect(doc.querySelectorAll('style')).toHaveLength(1);
      expect(doc.querySelector('style')?.hasAttribute('data-stet-preview')).toBe(true);
      expect(inlineHandlers(page.html())).toEqual([]);
      page.dom.window.close();
    });

    it('Desktop and Mobile set the frame to 640 and 375 px', async () => {
      const page = await open();
      expect((frameOf(page) as HTMLIFrameElement).style.width).toBe('640px');
      await page.act('tplWidth:mobile');
      expect((frameOf(page) as HTMLIFrameElement).style.width).toBe('375px');
      expect((frameOf(page) as HTMLIFrameElement).style.maxWidth).toBe('100%');
      await page.act('tplWidth:desktop');
      expect((frameOf(page) as HTMLIFrameElement).style.width).toBe('640px');
      page.dom.window.close();
    });

    it('a click on rendered text opens the slot that wrote it, with its count and what it requires (journey B4)', async () => {
      const page = await open();
      const doc = docOf(page);
      expect(doc.querySelector('[data-tpl-field="welcome"] textarea')).toBeNull();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      const field = doc.querySelector('[data-tpl-field="welcome"]') as HTMLElement;
      expect((field.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Welcome to mirra');
      expect(field.textContent).toContain(`${HEADLINE} · 16 / 60`);
      expect(field.textContent).toContain('requires: none');
      clickIn(page, '[data-stet="welcome__greeting"]');
      await page.settle();
      expect(doc.querySelector('[data-tpl-field="welcome"]')?.textContent).toContain('requires: name');
      expect((doc.querySelector('[data-tpl-field="welcome"] textarea') as HTMLTextAreaElement).value).toBe('Hi {{name}}');
      page.dom.window.close();
    });

    it('a mouse click on a slot scrolls its field into view once the pointer leaves the email; a tap scrolls at once (8o T1.8)', async () => {
      const page = await open();
      const scrolled: string[] = [];
      (page.dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this.getAttribute('data-act-input') ?? '');
      };
      const doc = (frameOf(page) as HTMLIFrameElement).contentDocument as Document;
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      expect(docOf(page).activeElement?.getAttribute('data-act-input')).toBe(`text:${HEADLINE}`);
      expect(scrolled).toEqual([]);
      (doc.querySelector(`[data-stet="${HEADLINE}"]`) as HTMLElement).dispatchEvent(new page.dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
      expect(scrolled).toEqual([`text:${HEADLINE}`]);
      const tap = new page.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(tap, 'pointerType', { value: 'touch' });
      (doc.querySelector('[data-stet="welcome__greeting"]') as HTMLElement).dispatchEvent(tap);
      await page.settle();
      expect(scrolled).toEqual([`text:${HEADLINE}`, 'text:welcome__greeting']);
      page.dom.window.close();
    });

    it('a mouse click on a slot keeps its field where it is while the pointer moves between elements of the email (8o F4g)', async () => {
      const page = await open();
      const scrolled: string[] = [];
      (page.dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this.getAttribute('data-act-input') ?? '');
      };
      const doc = (frameOf(page) as HTMLIFrameElement).contentDocument as Document;
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      const slot = doc.querySelector(`[data-stet="${HEADLINE}"]`) as HTMLElement;
      slot.dispatchEvent(new page.dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: doc.body }));
      expect(scrolled).toEqual([]);
      slot.dispatchEvent(new page.dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
      expect(scrolled).toEqual([`text:${HEADLINE}`]);
      page.dom.window.close();
    });

    it('a click on Subject’s key opens the subject slot, and a click on a link in the email goes nowhere', async () => {
      const page = await open();
      const doc = docOf(page);
      await page.act('tplSlot:welcome__subject');
      expect(doc.querySelector('[data-tpl-field="welcome"] textarea')?.getAttribute('data-act-input')).toBe('text:welcome__subject');
      const link = ((frameOf(page) as HTMLIFrameElement).contentDocument as Document).querySelector('a') as HTMLElement;
      const click = new page.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      page.dom.window.close();
    });

    it('believes only the slots of its own template: a marker the email forges selects nothing (S4)', async () => {
      const forged = '<html><body>' + mark('constructor', 'a') + mark('brand__accent', 'b') + mark('welcome__nope', 'c') + '</body></html>';
      const page = await open(reply(forged));
      const sheet = ((frameOf(page) as HTMLIFrameElement).contentDocument as Document).querySelector('style[data-stet-preview]') as HTMLElement;
      for (const key of ['constructor', 'brand__accent', 'welcome__nope']) {
        clickIn(page, `[data-stet="${key}"]`);
        await page.settle();
        expect(docOf(page).querySelector('[data-tpl-field="welcome"] textarea')).toBeNull();
        // Nothing of the forged name reaches the stylesheet the page keeps in the frame.
        expect(sheet.textContent).not.toContain(key);
      }
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('typing in the slot’s field renders again 400 ms after the last keystroke, with the draft', async () => {
      const page = await open();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      expect(previews(page)).toHaveLength(1);
      page.answer('/api/site/email-preview', 200, reply(mail('Welcome back')));
      await page.type(`text:${HEADLINE}`, 'Welcome ba');
      await sleep(150);
      await page.type(`text:${HEADLINE}`, 'Welcome back');
      await sleep(250);
      // 400 ms after the first keystroke, but 250 ms after the last: nothing yet.
      expect(previews(page)).toHaveLength(1);
      await sleep(300);
      await page.settle();
      expect(previews(page)).toHaveLength(2);
      expect(previews(page)[1]?.drafts).toEqual({ [HEADLINE]: 'Welcome back' });
      expect((frameOf(page) as HTMLIFrameElement).getAttribute('srcdoc')).toBe(mail('Welcome back'));
      loadFrame(page);
      expect(((frameOf(page) as HTMLIFrameElement).contentDocument as Document).querySelector('h1')?.textContent).toBe('Welcome back');
      // The field being typed in keeps its words and the caret: the frame's repaint touches nothing else.
      const typed = docOf(page).querySelector(`[data-act-input="text:${HEADLINE}"]`) as HTMLTextAreaElement;
      expect(typed.value).toBe('Welcome back');
      expect(docOf(page).activeElement === typed).toBe(true);
      page.dom.window.close();
    });

    it('words typed while a render is in flight are rendered next, once, with the latest of them', async () => {
      const page = await open();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      page.answer('/api/site/email-preview', 200, reply(mail('OLD')), 600);
      await page.type(`text:${HEADLINE}`, 'a');
      await sleep(500);
      page.answer('/api/site/email-preview', 200, reply(mail('NEW')), 0);
      await page.type(`text:${HEADLINE}`, 'ab');
      await sleep(1200);
      await page.settle();
      expect(previews(page).map((r) => r.drafts[HEADLINE])).toEqual([undefined, 'a', 'ab']);
      expect((frameOf(page) as HTMLIFrameElement).getAttribute('srcdoc')).toBe(mail('NEW'));
      page.dom.window.close();
    });

    it('renders again after a request that failed on the way', async () => {
      const page = await open();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      page.answer('/api/site/email-preview', 500, { error: 'the server stopped' });
      await page.type(`text:${HEADLINE}`, 'x');
      await sleep(500);
      expect(docOf(page).querySelector('[data-tpl-fail="welcome"]')?.textContent).toBe('not-renderable: the server stopped');
      // A request that never got an answer leaves the next one free to go.
      page.answer('/api/site/email-preview', 200, () => { throw new Error('offline'); });
      await page.type(`text:${HEADLINE}`, 'xx');
      await sleep(500);
      expect(page.toast()).toContain('offline');
      page.answer('/api/site/email-preview', 200, reply(mail('Back again')));
      await page.type(`text:${HEADLINE}`, 'xy');
      await sleep(500);
      expect(frameOf(page)?.getAttribute('srcdoc')).toBe(mail('Back again'));
      expect(docOf(page).querySelector('[data-tpl-fail="welcome"]')?.textContent).toBe('');
      page.dom.window.close();
    });

    it('answers a render that failed with its reason and detail, and shows no frame', async () => {
      const page = await open({ failure: { reason: 'render-threw', detail: 'boom from the template' } });
      expect(docOf(page).querySelector('[data-tpl-fail="welcome"]')?.textContent).toBe('render-threw: boom from the template');
      expect(frameOf(page)).toBeNull();
      page.dom.window.close();
    });

    it('sends the selected environment and language with the draft, and renders a snapshot-only site as well', async () => {
      const snap = await open();
      expect(previews(snap)[0]).not.toHaveProperty('env');
      snap.dom.window.close();
      const page = await open(reply(), mailSite({ mode: 'memory' }));
      await page.act('cycleEnv');
      await page.settle();
      expect(previews(page).at(-1)?.env).toBe('staging');
      await page.act('tab:Content');
      await page.change('locale', 'de');
      await page.act('tab:Templates');
      expect(previews(page).at(-1)?.locale).toBe('de');
      page.dom.window.close();
    });

    // --- the fix round: what the first build left unproved ---------------------

    const run = (page: Painted, code: string): unknown => (page.dom.window as unknown as { eval: (code: string) => unknown }).eval(code);
    const TEST_SEND = `/s/${SITE_ID}/api/stet/test-send`;
    const sends = (page: Painted): Array<{ path: string; body: unknown }> => page.sent.filter((r) => r.path.startsWith(TEST_SEND));
    /** The Templates tab of a store-backed site, whose test send answers `answer`. */
    async function openStored(answer: [number, unknown] = [200, { sent: true }]): Promise<Painted> {
      const page = await paint({
        site: mailSite({ mode: 'memory' }),
        routes: [['/api/site/email-preview', 200, reply()], [TEST_SEND, answer[0], answer[1]]],
      });
      await page.act('tab:Templates');
      loadFrame(page);
      return page;
    }
    const field = (page: Painted, act: string): HTMLInputElement => docOf(page).querySelector(`[data-act-input="${act}"]`) as HTMLInputElement;
    const press = (page: Painted, act: string): HTMLButtonElement | null => docOf(page).querySelector(`[data-act="${act}"]`);

    it('F6a: painting the tab again while a render is pending asks for it once', async () => {
      const page = await paint({ site: mailSite(), routes: [['/api/site/email-preview', 200, reply(), 600]] });
      await page.act('tab:Templates');
      run(page, 'render(); render();');
      await page.settle();
      expect(previews(page)).toHaveLength(1);
      await sleep(700);
      page.dom.window.close();
    });

    it('F6b: once rendered, toggling the unsaved list or repainting the tab asks for nothing more', async () => {
      const page = await open();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      await page.type(`text:${HEADLINE}`, 'Edited');
      await sleep(600);
      await page.settle();
      const before = previews(page).length;
      expect(before).toBe(2);
      await page.act('unsaved');
      await page.act('unsaved');
      run(page, 'render();');
      await page.act('tab:Content');
      await page.act('tab:Templates');
      await sleep(600);
      expect(previews(page)).toHaveLength(before);
      page.dom.window.close();
    });

    it('F8: at 360 px the email card’s name and the Subject and Preview text break inside the card', async () => {
      const page = await open();
      const css = [...docOf(page).querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n').replace(/\s+/g, ' ');
      expect(css).toMatch(/@media\(max-width:760px\)\{[^}]*\[data-tpl\] \.ch h3[^{]*\{[^}]*overflow-wrap:anywhere/);
      expect(css).toMatch(/@media\(max-width:760px\)\{[^}]*\[data-tpl-meta\] span[^{]*\{[^}]*overflow-wrap:anywhere/);
      page.dom.window.close();
    });

    // An addition beyond T1-T8: the send row's controls are touch targets at a phone's width.
    it('T8: at 360 px the Test send controls are 36 px tall', async () => {
      const page = await open();
      const css = [...docOf(page).querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n').replace(/\s+/g, ' ');
      expect(css).toMatch(/@media\(max-width:760px\)\{\[data-tpl-send\] \.btn,\[data-tpl-send\] \.in\{[^}]*min-height:36px/);
      page.dom.window.close();
    });

    it('F10: the Brand tab says nothing of an email preview that is not built', async () => {
      const brand = { ...mailDescriptor, keys: { ...mailDescriptor.keys, brand__accent: { shape: 'text', target: 'html-email' } } } as Descriptor;
      const page = await paint({ site: mailSite({ descriptor: brand, snapshot: { default: { ...mailSnapshot.default, brand__accent: '#fff' } } }) });
      await page.act('tab:Brand');
      expect(docOf(page).querySelector('#main')?.textContent).toContain('brand__accent');
      expect(page.html()).not.toContain('not built yet');
      page.dom.window.close();
    });

    it('D62: the Templates tab carries Save, which saves the drafts typed there; Remove key stays on the Content editor', async () => {
      const page = await open();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: [] });
      await page.type(`text:${HEADLINE}`, 'Welcome back');
      expect(press(page, 'save')).not.toBeNull();
      expect(docOf(page).querySelector('[data-act^="removePlan:"]')).toBeNull();
      await page.act('save');
      const saves = page.sent.filter((r) => r.path.startsWith('/api/site/save'));
      expect(saves).toHaveLength(1);
      expect((saves[0]?.body as { values: unknown[] }).values).toMatchObject([{ key: HEADLINE, locale: 'default', value: 'Welcome back' }]);
      await page.act('tab:Content');
      await page.act(`key:${HEADLINE}`);
      expect(press(page, `removePlan:${HEADLINE}`)).not.toBeNull();
      page.dom.window.close();
    });

    it('D62: an over-limit value asks Save anyway on the Templates tab, and a refused save says why there', async () => {
      const page = await open();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      await page.type(`text:${HEADLINE}`, 'x'.repeat(71));
      await page.act('save');
      expect(press(page, 'saveAnyway')).not.toBeNull();
      expect(docOf(page).querySelector('[data-tpl-save]')?.textContent).toContain('Over the 60-character limit');
      await page.act('saveAnyway');
      expect(docOf(page).querySelector('[data-tpl-save] #refusal')?.textContent).toContain('refused by the save gate');
      page.dom.window.close();
    });

    it('D62: on a store-backed site the Templates tab’s Save saves every draft to the store', async () => {
      const page = await openStored();
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      await page.type(`text:${HEADLINE}`, 'Stored words');
      expect(press(page, 'save')?.textContent).toBe('Save draft');
      await page.act('save');
      const drafts = page.sent.filter((r) => r.path.startsWith(`/s/${SITE_ID}/api/stet/draft`));
      expect(drafts.map((r) => (r.body as { key: string; value: string }).value)).toEqual(['Stored words']);
      page.dom.window.close();
    });

    it('T8: a store-backed card offers Test send…; a snapshot site’s card does not', async () => {
      const stored = await openStored();
      expect(press(stored, 'tplSendOpen:welcome')?.textContent).toBe('Test send…');
      expect(field(stored, 'tplTo:welcome')).toBeNull();
      stored.dom.window.close();
      const snapshot = await open();
      expect(docOf(snapshot).querySelector('[data-act^="tplSendOpen:"]')).toBeNull();
      snapshot.dom.window.close();
    });

    it('T8: the address starts empty, Send waits for an @ and no line break, and typing posts nothing', async () => {
      const page = await openStored();
      await page.act('tplSendOpen:welcome');
      expect(field(page, 'tplTo:welcome').value).toBe('');
      expect(press(page, 'tplSendGo:welcome')?.disabled).toBe(true);
      for (const [typed, enabled] of [['me', false], ['me@example.test', true], ['', false]] as const) {
        await page.type('tplTo:welcome', typed);
        expect(press(page, 'tplSendGo:welcome')?.disabled, JSON.stringify(typed)).toBe(!enabled);
      }
      // A text field strips line breaks on its own; the page's rule does not rely on that.
      expect(run(page, 'tplToOk("me@example.test\\r\\nBcc: x@example.test")')).toBe(false);
      expect(run(page, 'tplToOk("me@example.test")')).toBe(true);
      run(page, 'render();');
      await page.settle();
      expect(sends(page)).toEqual([]);
      page.dom.window.close();
    });

    it('T8: Send posts exactly the template and the address to the mount’s test-send, and says where it went', async () => {
      const page = await openStored();
      await page.act('tplSendOpen:welcome');
      await page.type('tplTo:welcome', 'me@example.test');
      await page.act('tplSendGo:welcome');
      expect(sends(page)).toEqual([{ path: TEST_SEND, body: { template: 'welcome', to: 'me@example.test' } }]);
      expect(docOf(page).querySelector('[data-tpl-send="welcome"]')?.textContent).toContain('Sent to me@example.test.');
      page.dom.window.close();
    });

    it('T8: without emailSend (501) the page says what to add; any other refusal shows the server’s sentence', async () => {
      const none = await openStored([501, { error: 'test-send is not wired' }]);
      await none.act('tplSendOpen:welcome');
      await none.type('tplTo:welcome', 'me@example.test');
      await none.act('tplSendGo:welcome');
      expect(docOf(none).querySelector('[data-tpl-send="welcome"]')?.textContent).toContain(
        'Test send needs emailSend in stet.config.json: the host function that sends one email, the same one `stet email test` uses.',
      );
      none.dom.window.close();
      const down = await openStored([500, { error: 'smtp down' }]);
      await down.act('tplSendOpen:welcome');
      await down.type('tplTo:welcome', 'me@example.test');
      await down.act('tplSendGo:welcome');
      expect(docOf(down).querySelector('[data-tpl-send="welcome"]')?.textContent).toContain('smtp down');
      expect(docOf(down).querySelector('[data-tpl-send="welcome"] .err')).not.toBeNull();
      down.dom.window.close();
    });

    it('T8: unsaved edits are named as not in the email, pluralised as the header does', async () => {
      const page = await openStored();
      await page.act('tplSendOpen:welcome');
      const note = (): string => docOf(page).querySelector('[data-tpl-unsaved="welcome"]')?.textContent ?? '';
      expect(note()).toBe('');
      clickIn(page, `[data-stet="${HEADLINE}"]`);
      await page.settle();
      await page.type(`text:${HEADLINE}`, 'one');
      expect(note()).toBe('1 unsaved edit is not in this email.');
      run(page, 'setDraft("welcome__subject", "two"); paintDirty();');
      expect(note()).toBe('2 unsaved edits are not in this email.');
      page.dom.window.close();
    });
  });

  // 10.4 — the unsaved list, Undo, Show, Discard all, the project-switch ask and beforeunload
  describe('unsaved edits (journey B23)', () => {
    const run = (page: Painted, code: string): unknown => (page.dom.window as unknown as { eval: (code: string) => unknown }).eval(code);
    const header = (page: Painted): string => {
      const el = docOf(page).getElementById('dc') as HTMLElement;
      return el.hidden ? '' : el.textContent ?? '';
    };
    const rows = (page: Painted): string[] =>
      [...docOf(page).querySelectorAll('#ask [data-act^="undoEdit:"], #ask [data-act^="undoTmpl:"]')].map((el) => (el.getAttribute('data-act') ?? '').split(':')[1] ?? '');
    const ask = (page: Painted): string => (docOf(page).getElementById('ask') as HTMLElement).textContent ?? '';
    /** Three unsaved edits: one typed in the field, two set as the preview's edits arrive. */
    async function three(over: Parameters<typeof paint>[0] = {}): Promise<Painted> {
      const page = await paint(over);
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'Changed headline');
      run(page, 'setDraft("seo_home_title", "Changed title"); setDraft("loose_key", "Changed loose"); render();');
      await page.settle();
      return page;
    }
    const stored = (page: Painted, id: string): unknown => run(page, `storedValue(${JSON.stringify(id)}, S.locale)`);

    it('opens a list of the edited keys from the header count, each with Undo and Show, and Discard all', async () => {
      const page = await three();
      expect(header(page)).toBe('3 unsaved edits');
      expect(docOf(page).querySelector('button#dc')).not.toBeNull();
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      await page.act('unsaved');
      expect(rows(page)).toEqual(['default hero_headline', 'default seo_home_title', 'default loose_key']);
      expect(docOf(page).querySelectorAll('#ask [data-act^="showEdit:"]')).toHaveLength(3);
      expect(docOf(page).querySelector('#ask [data-act="discardAll"]')?.textContent).toBe('Discard all');
      expect(docOf(page).querySelector('#ask [data-act="undoEdit:default loose_key"]')?.textContent).toBe('Undo');
      expect(docOf(page).querySelector('#ask [data-act="showEdit:default loose_key"]')?.textContent).toBe('Show');
      await page.act('unsaved');
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      page.dom.window.close();
    });

    it('undoes one of three: the key returns to its stored value, with no base left, and the header reads 2 unsaved edits', async () => {
      const page = await three();
      await page.act('unsaved');
      expect(run(page, 'JSON.stringify(Object.keys(S.base))')).toBe('["default hero_headline","default seo_home_title","default loose_key"]');
      await page.act('undoEdit:default loose_key');
      expect(header(page)).toBe('2 unsaved edits');
      expect(rows(page)).toEqual(['default hero_headline', 'default seo_home_title']);
      expect(run(page, 'valueOf("loose_key")')).toBe(stored(page, 'loose_key'));
      expect(run(page, 'JSON.stringify(Object.keys(S.base))')).toBe('["default hero_headline","default seo_home_title"]');
      expect(run(page, 'JSON.stringify(Object.keys(S.draft))')).toBe('["default hero_headline","default seo_home_title"]');
      page.dom.window.close();
    });

    it('undoes the key being typed in the field, and the field shows the stored value', async () => {
      const page = await three();
      await page.act('unsaved');
      await page.act('undoEdit:default hero_headline');
      expect((docOf(page).querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement).value).toBe('Ship the copy');
      expect(header(page)).toBe('2 unsaved edits');
      page.dom.window.close();
    });

    it('ends an open edit of the key before undoing it, so the page’s typed words do not come back', async () => {
      const page = await three();
      run(page, 'S.edit = { key: "loose_key", locale: "default", entry: undefined, form: "inplace", before: undefined, rect: null };');
      await page.act('unsaved');
      await page.act('undoEdit:default loose_key');
      expect(run(page, 'S.edit')).toBeNull();
      expect(run(page, 'valueOf("loose_key")')).toBe(stored(page, 'loose_key'));
      page.dom.window.close();
    });

    it('undoes a derived key’s template edit with its own button', async () => {
      const page = await paint();
      run(page, 'tmplEdit("welcome__subject", { before: "Hi " }); render();');
      await page.settle();
      expect(header(page)).toBe('1 unsaved edit');
      await page.act('unsaved');
      expect(rows(page)).toEqual(['welcome__subject']);
      await page.act('undoTmpl:welcome__subject');
      expect(header(page)).toBe('');
      expect(run(page, 'Object.keys(S.tmpl).length')).toBe(0);
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      page.dom.window.close();
    });

    it('shows an edited key: selects it, lists it among all keys, in its locale', async () => {
      const page = await three();
      run(page, 'setDraftIn("de", "hero_headline", "Geaendert"); render();');
      await page.settle();
      await page.act('unsaved');
      await page.act('showEdit:default loose_key');
      expect(run(page, 'S.sel')).toBe('loose_key');
      // The list shows every key, so the edited one is listed where it stands.
      expect(run(page, 'S.group')).toBe('all');
      expect(docOf(page).querySelector('.row.on')?.getAttribute('data-act')).toBe('key:loose_key');
      await page.act('showEdit:de hero_headline');
      expect(run(page, 'S.locale')).toBe('de');
      expect(run(page, 'S.sel')).toBe('hero_headline');
      page.dom.window.close();
    });

    it('shows an edited key: moves the list to the key’s group when the open group does not hold it (F4k)', async () => {
      const page = await three();
      await page.change('group', 'seo');
      await page.act('unsaved');
      await page.act('showEdit:default loose_key');
      expect(run(page, 'S.sel')).toBe('loose_key');
      expect(run(page, 'S.group')).toBe('prefix:loose');
      expect(docOf(page).querySelector('.row.on')?.getAttribute('data-act')).toBe('key:loose_key');
      page.dom.window.close();
    });

    it('discards every unsaved edit of the selected environment, and none of another environment’s', async () => {
      const page = await three({ site: siteBody({ mode: 'memory' }) });
      expect(run(page, 'S.env')).toBe('default');
      await page.act('cycleEnv');
      expect(run(page, 'S.env')).toBe('staging');
      expect(header(page)).toBe('');
      run(page, 'setDraft("hero_headline", "Staging words"); render();');
      await page.settle();
      expect(header(page)).toBe('1 unsaved edit');
      await page.act('unsaved');
      await page.act('discardAll');
      expect(header(page)).toBe('');
      expect(run(page, 'Object.keys(S.draft).length + Object.keys(S.base).length')).toBe(0);
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      // Back in the first environment its three edits are where they were left.
      await page.act('cycleEnv');
      expect(run(page, 'S.env')).toBe('default');
      expect(header(page)).toBe('3 unsaved edits');
      await page.act('unsaved');
      await page.act('discardAll');
      expect(header(page)).toBe('');
      expect(run(page, 'JSON.stringify(Object.keys(S.stashed).map((k) => Object.keys(S.stashed[k].draft).length))')).toBe('[0,0]');
      page.dom.window.close();
    });

    it('asks before a project switch with unsaved edits; Cancel keeps the project and its edits', async () => {
      const page = await three();
      const before = page.requested('/api/site?').length;
      await page.act('site:/checkouts/other');
      expect(ask(page)).toContain('3 unsaved edits will be lost. Leave anyway?');
      expect(docOf(page).querySelector('#ask [data-act="leaveGo"]')?.textContent).toBe('Leave');
      expect(docOf(page).querySelector('#ask [data-act="leaveStay"]')?.textContent).toBe('Cancel');
      expect(page.requested('/api/site?')).toHaveLength(before);
      await page.act('leaveStay');
      expect(run(page, 'S.path')).toBe('/checkouts/mini');
      expect(header(page)).toBe('3 unsaved edits');
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      expect(page.requested('/api/site?')).toHaveLength(before);
      page.dom.window.close();
    });

    it('leaves on Leave, losing the edits, and counts the other environments’ edits too', async () => {
      const page = await three({ site: siteBody({ mode: 'memory' }) });
      await page.act('cycleEnv');
      run(page, 'setDraft("hero_headline", "Staging words"); render();');
      await page.settle();
      await page.act('site:/checkouts/other');
      expect(ask(page)).toContain('4 unsaved edits will be lost. Leave anyway?');
      await page.act('leaveGo');
      expect(run(page, 'S.path')).toBe('/checkouts/other');
      expect(page.requested('/api/site?')).toContain('/api/site?site=%2Fcheckouts%2Fother');
      expect(header(page)).toBe('');
      expect(run(page, 'Object.keys(S.stashed).length')).toBe(0);
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      page.dom.window.close();
    });

    it('switches at once with nothing unsaved', async () => {
      const page = await paint();
      await page.act('site:/checkouts/other');
      expect(run(page, 'S.path')).toBe('/checkouts/other');
      expect(ask(page)).not.toContain('will be lost');
      page.dom.window.close();
    });

    /** One edit typed in the field, then the Setup tab, where Remove this project lives. */
    async function oneThenSetup(): Promise<Painted> {
      const page = await paint({ site: siteBody({ mode: 'memory' }) });
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'Changed headline');
      await page.act('tab:Setup');
      return page;
    }

    it('asks before Remove this project with unsaved edits, and removes nothing until Leave (D53)', async () => {
      const page = await oneThenSetup();
      await page.act('removeSite');
      expect(ask(page)).toContain('1 unsaved edit will be lost. Leave anyway?');
      expect(page.requested('/api/workspace/remove')).toEqual([]);
      expect(run(page, 'S.path')).toBe('/checkouts/mini');
      await page.act('leaveGo');
      expect(page.requested('/api/workspace/remove')).toHaveLength(1);
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      page.dom.window.close();
    });

    it('keeps the project and its edit when Cancel answers the Remove ask (D53)', async () => {
      const page = await oneThenSetup();
      await page.act('removeSite');
      await page.act('leaveStay');
      expect(page.requested('/api/workspace/remove')).toEqual([]);
      expect(run(page, 'S.path')).toBe('/checkouts/mini');
      expect(header(page)).toBe('1 unsaved edit');
      expect((docOf(page).getElementById('ask') as HTMLElement).hidden).toBe(true);
      page.dom.window.close();
    });

    it('asks before Remove this project when only another environment holds the edit (D53)', async () => {
      const page = await oneThenSetup();
      await page.act('tab:Content');
      await page.act('cycleEnv');
      expect(header(page)).toBe('');
      await page.act('tab:Setup');
      await page.act('removeSite');
      expect(ask(page)).toContain('1 unsaved edit will be lost. Leave anyway?');
      expect(page.requested('/api/workspace/remove')).toEqual([]);
      page.dom.window.close();
    });

    it('removes at once with nothing unsaved', async () => {
      const page = await paint();
      await page.act('tab:Setup');
      await page.act('removeSite');
      expect(ask(page)).not.toContain('will be lost');
      expect(page.requested('/api/workspace/remove')).toHaveLength(1);
      page.dom.window.close();
    });

    it('asks before a project switch when only another environment holds the edit (F3)', async () => {
      const page = await three({ site: siteBody({ mode: 'memory' }) });
      await page.act('cycleEnv');
      expect(run(page, 'S.env')).toBe('staging');
      expect(header(page)).toBe('');
      await page.act('site:/checkouts/other');
      expect(ask(page)).toContain('3 unsaved edits will be lost. Leave anyway?');
      expect(run(page, 'S.path')).toBe('/checkouts/mini');
      page.dom.window.close();
    });

    it('asks before Add a project switches away from unsaved edits; Cancel keeps the project and the edit (F3)', async () => {
      const page = await three();
      page.answer('/api/workspace/add', 200, { added: true, path: '/checkouts/other', sites: page.workspace.sites });
      (docOf(page).getElementById('addpath') as HTMLInputElement).value = '/checkouts/other';
      const before = page.requested('/api/site?').length;
      await page.act('addSite');
      expect(page.requested('/api/workspace/add')).toHaveLength(1);
      expect(ask(page)).toContain('3 unsaved edits will be lost. Leave anyway?');
      expect(page.requested('/api/site?')).toHaveLength(before);
      await page.act('leaveStay');
      expect(run(page, 'S.path')).toBe('/checkouts/mini');
      expect(header(page)).toBe('3 unsaved edits');
      page.dom.window.close();
    });

    it('raises the browser’s own prompt on a reload or a tab close while edits exist, in any environment', async () => {
      const page = await paint();
      const press = (): boolean => {
        const event = new page.dom.window.Event('beforeunload', { cancelable: true });
        page.dom.window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(press()).toBe(false);
      run(page, 'setDraft("loose_key", "Changed loose"); render();');
      await page.settle();
      expect(press()).toBe(true);
      run(page, 'switchEnv("staging");');
      await page.settle();
      expect(header(page)).toBe('');
      expect(press()).toBe(true);
      run(page, 'switchEnv("default"); undoEdit("default", "loose_key");');
      await page.settle();
      expect(press()).toBe(false);
      page.dom.window.close();
    });
  });

  // 10.5 — 360 px. jsdom has no layout: it proves the structure and the rules the browser run reads, and the pick behaviour at 360.
  describe('editing at 360 px (journey B19)', () => {
    const phone = (window: Painted['dom']['window']): void => {
      Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
    };
    const rules = (page: Painted): string =>
      [...docOf(page).querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n').replace(/\s+/g, ' ');
    /** The declarations of every rule inside an `@media(max-width:760px)` block that names `selector`. */
    const phoneRule = (css: string, selector: string): string[] => {
      const out: string[] = [];
      const opener = '@media(max-width:760px){';
      for (let at = css.indexOf(opener); at !== -1; at = css.indexOf(opener, at + 1)) {
        let depth = 1;
        let end = at + opener.length;
        for (; end < css.length && depth > 0; end += 1) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
        for (const rule of css.slice(at + opener.length, end - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if ((rule[1] ?? '').split(',').map((part) => part.trim()).includes(selector)) out.push((rule[2] ?? '').trim());
        }
      }
      return out;
    };

    it('puts the selected key’s editor in the column directly under the preview, the key list after it', async () => {
      const page = await paint({ prepare: phone });
      await page.act('key:hero_headline');
      const main = docOf(page).getElementById('main') as HTMLElement;
      expect([...main.children].map((el) => el.className.split(' ')[0])).toEqual(['card', 'edcol']);
      expect(docOf(page).querySelector('#main > .edcol > .card.edcard')).not.toBeNull();
      const css = rules(page);
      expect(phoneRule(css, '#main').join(';')).toMatch(/display:flex/);
      expect(phoneRule(css, '#main').join(';')).toMatch(/flex-direction:column/);
      expect(phoneRule(css, '.edcol').join(';')).toMatch(/order:-1/);
      expect(phoneRule(css, '.edcard').join(';')).toMatch(/order:-1/);
      page.dom.window.close();
    });

    it('focuses the field on a second tap, with no in-place edit and no popover', async () => {
      const page = await paint({ prepare: phone });
      page.dom.window.eval('onPick({ keys: [{ key: "hero_headline", attr: null, by: "whole", inplace: true }], again: true, rect: { left: 1, top: 1, width: 10, height: 10 } })');
      await page.settle();
      expect(docOf(page).activeElement?.getAttribute('data-act-input')).toBe('text:hero_headline');
      expect(page.dom.window.eval('S.edit')).toBeNull();
      expect(page.dom.window.eval('S.popover')).toBeNull();
      page.dom.window.close();
    });

    it('breaks a long project name inside its row, so no name widens the page (F2)', async () => {
      const page = await paint({ prepare: phone });
      expect(rules(page)).toMatch(/\.prow>\.it\{[^}]*overflow-wrap:anywhere/);
      page.dom.window.close();
    });

    it('caps the preview frame so a short phone screen shows the frame and the selected field together (D55)', async () => {
      const page = await paint({ prepare: phone });
      const wrap = phoneRule(rules(page), '.devwrap').join(';');
      expect(wrap).toMatch(/height:min\(\d+px,calc\(100vh - \d+px\)\)/);
      expect(wrap).toMatch(/min-height:0/);
      page.dom.window.close();
    });

    it('leaves the frame’s height to the stylesheet under 760 px and sets it from the window above (D55)', async () => {
      const page = await paint({ prepare: phone, site: siteBody({ host: 'html' }), preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true } });
      const box = docOf(page).getElementById('devwrap') as HTMLElement;
      Object.defineProperty(box, 'clientWidth', { value: 300, configurable: true });
      box.style.height = '500px';
      page.dom.window.eval('fitFrame()');
      expect(box.style.height).toBe('');
      Object.defineProperty(page.dom.window, 'innerWidth', { value: 1200, configurable: true });
      page.dom.window.eval('fitFrame()');
      expect(box.style.height).toMatch(/^\d+px$/);
      page.dom.window.close();
    });

    it('lets every card of the column shrink to the viewport', async () => {
      const page = await paint({ prepare: phone });
      const css = rules(page);
      expect(phoneRule(css, '#main>*').join(';')).toMatch(/min-width:0/);
      expect(phoneRule(css, '.edcol>*').join(';')).toMatch(/min-width:0/);
      page.dom.window.close();
    });

    it('selects on a tap and brings the field into view without opening the popover', async () => {
      const page = await paint({ prepare: phone });
      const scrolled: string[] = [];
      (page.dom.window as unknown as { HTMLElement: { prototype: { scrollIntoView: unknown } } }).HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, arg: unknown): void {
        scrolled.push((this.getAttribute('data-act-input') ?? '') + ' ' + JSON.stringify(arg));
      };
      page.dom.window.eval('selectFromFrame("hero_headline", undefined)');
      await page.settle();
      expect(scrolled).toContain('text:hero_headline {"block":"nearest"}');
      expect(page.dom.window.eval('S.popover')).toBeNull();
      page.dom.window.close();
    });
  });

  // 10.6 — shortcuts
  describe('shortcuts (journey B23)', () => {
    const key = (page: Painted, target: EventTarget, init: KeyboardEventInit & { key: string }): void => {
      target.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    };
    const mode = (page: Painted): unknown => page.dom.window.eval('S.mode');

    it('toggles Edit and Use on E outside a field, in either case', async () => {
      const page = await paint();
      expect(mode(page)).toBe('edit');
      key(page, docOf(page).body, { key: 'e' });
      expect(mode(page)).toBe('use');
      expect(docOf(page).querySelector('[data-act="mode:use"]')?.className).toBe('on');
      key(page, docOf(page).body, { key: 'E' });
      expect(mode(page)).toBe('edit');
      page.dom.window.close();
    });

    it('leaves E to the field when focus is in one: an input, a textarea, a select or an editable element', async () => {
      const page = await paint();
      await page.act('key:hero_headline');
      const field = docOf(page).querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement;
      key(page, field, { key: 'e' });
      expect(mode(page)).toBe('edit');
      key(page, docOf(page).getElementById('addpath') as HTMLElement, { key: 'e' });
      key(page, docOf(page).getElementById('route') as HTMLElement, { key: 'e' });
      const select = docOf(page).querySelector('[data-act-change]') as HTMLElement;
      key(page, select, { key: 'e' });
      const editable = docOf(page).createElement('div');
      editable.setAttribute('contenteditable', 'true');
      docOf(page).body.appendChild(editable);
      key(page, editable, { key: 'e' });
      expect(mode(page)).toBe('edit');
      page.dom.window.close();
    });

    it('ignores E with a modifier, off the Content tab, and while composing', async () => {
      const page = await paint();
      for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) key(page, docOf(page).body, { key: 'e', ...init });
      key(page, docOf(page).body, { key: 'e', isComposing: true });
      expect(mode(page)).toBe('edit');
      await page.act('tab:Health');
      key(page, docOf(page).body, { key: 'e' });
      expect(mode(page)).toBe('edit');
      page.dom.window.close();
    });

    it('leaves a key an element already answered', async () => {
      const page = await paint();
      docOf(page).body.addEventListener('keydown', (event) => event.preventDefault());
      key(page, docOf(page).body, { key: 'e' });
      expect(mode(page)).toBe('edit');
      page.dom.window.close();
    });

    it('posts the new mode to the preview', async () => {
      const page = await paint({ preview: { url: 'http://localhost:4321/', up: true, start: 'npx astro dev', source: 'astro' } });
      const frame = docOf(page).querySelector('#devwrap iframe') as HTMLIFrameElement;
      const posts: unknown[] = [];
      (frame.contentWindow as unknown as { postMessage: unknown }).postMessage = (message: unknown): void => { posts.push(message); };
      page.dom.window.eval('agentReady = true');
      key(page, docOf(page).body, { key: 'e' });
      expect(posts).toContainEqual({ stet: 'mode', mode: 'use' });
      page.dom.window.close();
    });

    it('ends the selection on Escape outside a field, and not inside one', async () => {
      const page = await paint();
      await page.act('key:hero_headline');
      const field = docOf(page).querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement;
      key(page, field, { key: 'Escape' });
      expect(page.dom.window.eval('S.sel')).toBe('hero_headline');
      key(page, docOf(page).body, { key: 'Escape' });
      expect(page.dom.window.eval('S.sel')).toBeNull();
      expect(docOf(page).querySelector('.row.on')).toBeNull();
      page.dom.window.close();
    });

    it('does not take an Escape the open field over the frame is answering', async () => {
      const page = await paint();
      await page.act('key:hero_headline');
      page.dom.window.eval('openPopover("hero_headline", "default", undefined, { left: 1, top: 1, width: 10, height: 10 })');
      expect(page.dom.window.eval('S.popover !== null')).toBe(true);
      key(page, docOf(page).body, { key: 'Escape' });
      expect(page.dom.window.eval('S.sel')).toBe('hero_headline');
      page.dom.window.close();
    });
  });

  // 5.4 — the layout and the widths
  it('opens on the key column beside the pane, with no key selected and Desktop on (journey B19)', async () => {
    const page = await paint();
    const doc = docOf(page);
    const work = (): string => (doc.getElementById('work') as HTMLElement).className;
    expect(work()).toBe('wrap content');
    expect(doc.querySelector('.row.on')).toBeNull();
    expect(doc.querySelector('[data-act="width:desktop"]')?.className).toBe('on');
    await page.act('keys');
    expect(work()).toBe('wrap content wide');
    expect(doc.querySelector('[data-act="keys"]')?.textContent).toBe('Show keys');
    await page.act('key:hero_headline');
    expect(work()).toBe('wrap content');
    expect(doc.querySelector('.row.on')?.getAttribute('data-act')).toBe('key:hero_headline');
    await page.act('tab:Recent');
    expect(work()).toBe('wrap');
    expect((doc.getElementById('pane') as HTMLElement).hidden).toBe(true);
    page.dom.window.close();
  });

  it('shows a not-adopted checkout its hint in the plain layout', async () => {
    const page = await paint({ site: { state: 'not-adopted', name: 'mini', path: '/checkouts/mini', id: SITE_ID } });
    expect(painted(page)).toContain('is not adopted');
    expect((docOf(page).getElementById('work') as HTMLElement).className).toBe('wrap');
    page.dom.window.close();
  });

  it('fits the frame: Desktop scaled down or centred, Tablet centred, Fit pane one to one (journey B19)', async () => {
    const page = await paint();
    const fit = (page.dom.window as unknown as { frameFit: (pane: number, preset: string) => unknown }).frameFit;
    expect(fit(895, 'desktop')).toEqual({ width: 1280, scale: 895 / 1280, left: 0 });
    expect(fit(1686, 'desktop')).toEqual({ width: 1280, scale: 1, left: 203 });
    expect(fit(1206, 'tablet')).toEqual({ width: 768, scale: 1, left: 219 });
    expect(fit(895, 'pane')).toEqual({ width: 895, scale: 1, left: 0 });
    // A name on the prototype chain is not a width.
    expect(fit(895, 'constructor')).toEqual(fit(895, 'desktop'));
    page.dom.window.close();
  });

  it('remembers the column and the width for the next visit', async () => {
    const page = await paint();
    await page.act('keys');
    await page.act('width:tablet');
    const storage = page.storage();
    page.dom.window.close();
    const next = await paint({ storage });
    expect((docOf(next).getElementById('work') as HTMLElement).className).toBe('wrap content wide');
    expect(docOf(next).querySelector('[data-act="width:tablet"]')?.className).toBe('on');
    expect(docOf(next).querySelector('[data-act="width:desktop"]')?.className).toBe('');
    next.dom.window.close();
  });

  // 5.5 — the pane
  it('keeps the frame through typing, searching, selecting and a width change (journeys B18, B19)', async () => {
    const page = await paint({ preview: UP });
    const doc = docOf(page);
    const frame = doc.querySelector('#devwrap iframe');
    expect(frame).not.toBeNull();
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'A new line');
    expect(doc.querySelector('#devwrap iframe')).toBe(frame);
    await page.type('search', 'loose');
    expect(doc.querySelector('#devwrap iframe')).toBe(frame);
    await page.act('key:loose_key');
    expect(doc.querySelector('#devwrap iframe')).toBe(frame);
    await page.act('width:tablet');
    expect(doc.querySelector('#devwrap iframe')).toBe(frame);
    page.dom.window.close();
  });

  for (const pane of ['static', 'dev'] as const) {
    it(`${pane === 'static' ? 'navigates the static frame again after a save' : 'leaves the dev server’s frame to its own reload after a save'}, and Reload navigates it`, async () => {
      const page = await paint(
        pane === 'static'
          ? { site: siteBody({ host: 'html' }), preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true } }
          : { preview: UP },
      );
      const frame = docOf(page).querySelector('#devwrap iframe') as HTMLIFrameElement;
      const navigations: string[] = [];
      const set = frame.setAttribute.bind(frame);
      frame.setAttribute = (name: string, value: string): void => {
        navigations.push(name);
        set(name, value);
      };
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'Saved');
      await page.act('save');
      expect(docOf(page).querySelector('#devwrap iframe')).toBe(frame);
      expect(navigations).toEqual(pane === 'static' ? ['src'] : []);
      await page.act('previewLoad');
      expect(navigations).toEqual(pane === 'static' ? ['src', 'src'] : ['src']);
      page.dom.window.close();
    });
  }

  it('moves the pane to where a key renders, for the visit only (journeys B17, B19)', async () => {
    const html = await paint({
      site: siteBody({ host: 'html' }),
      preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
      routes: [
        ['/api/site/marks', 200, { documents: [{ file: 'about/index.html', route: '/about/', page: null }], keys: { hero_headline: ['about/index.html'], loose_key: ['about/index.html'] } }],
      ],
    });
    await html.act('key:hero_headline');
    expect(html.requested('/api/site/preview').at(-1)).toContain('route=%2Fabout%2F');
    expect(Object.keys(html.storage()).filter((name) => name.startsWith('stet.route.'))).toEqual([]);
    html.dom.window.close();

    const group = await paint({
      site: siteBody({ host: 'html' }),
      preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
      routes: [['/api/site/marks', 200, { documents: [{ file: 'about/index.html', route: '/about/', page: null }], keys: { loose_key: ['about/index.html'] } }]],
    });
    await group.change('group', 'doc:about/index.html');
    expect(group.requested('/api/site/preview').at(-1)).toContain('route=%2Fabout%2F');
    group.dom.window.close();

    // A JavaScript site: the first static page the key's entry names, never a dynamic one.
    const js = await paint({
      site: siteBody({
        descriptor: {
          ...descriptor,
          keys: {
            ...descriptor.keys,
            pricing_price: { shape: 'text', target: 'web', pages: ['pricing'] },
            blog_title: { shape: 'text', target: 'web', pages: ['blog'] },
          },
          pages: { ...descriptor.pages, pricing: { route: '/pricing' }, blog: { route: '/blog/[slug]' } },
        },
      }),
    });
    await js.change('group', 'page:pricing');
    await js.act('key:pricing_price');
    expect(js.requested('/api/site/preview').at(-1)).toContain('route=%2Fpricing');
    const sent = js.requested('/api/site/preview').length;
    await js.change('group', 'page:blog');
    await js.act('key:blog_title');
    expect(js.requested('/api/site/preview')).toHaveLength(sent);
    js.dom.window.close();
  });

  it('takes a typed route, remembers it for the site, and cuts a pasted dev-server origin (journey B19)', async () => {
    const page = await paint();
    const route = docOf(page).getElementById('route') as HTMLInputElement;
    expect(route.value).toBe('/');
    route.value = 'docs/quickstart/';
    route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    await page.settle();
    expect(page.requested('/api/site/preview').at(-1)).toContain('route=%2Fdocs%2Fquickstart%2F');
    expect(route.value).toBe('/docs/quickstart/');
    expect(page.storage()[`stet.route.${SITE_ID}`]).toBe('/docs/quickstart/');

    route.value = 'http://localhost:4321/docs/';
    route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    await page.settle();
    expect(page.requested('/api/site/preview').at(-1)).toContain('route=%2Fdocs%2F');
    // A route the home page serves, with its query, is the one the next open keeps.
    route.value = '/?x=1';
    route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    await page.settle();
    const storage = page.storage();
    page.dom.window.close();

    const next = await paint({ storage });
    expect(next.requested('/api/site/preview')[0]).toContain('route=%2F%3Fx%3D1');
    expect((docOf(next).getElementById('route') as HTMLInputElement).value).toBe('/?x=1');
    next.dom.window.close();
  });

  it('keeps only the path of a pasted address of the site itself, and leaves any other address a path (journey B19)', async () => {
    const paste = async (page: Awaited<ReturnType<typeof paint>>, value: string): Promise<string> => {
      const route = docOf(page).getElementById('route') as HTMLInputElement;
      route.value = value;
      route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
      await page.settle();
      return (docOf(page).getElementById('route') as HTMLInputElement).value;
    };
    // The dev server is http://localhost:4321/.
    const dev = await paint();
    expect(await paste(dev, 'http://127.0.0.1:4321/docs/?a=1#b')).toBe('/docs/?a=1#b');
    expect(await paste(dev, 'http://localhost:43210/docs/')).toBe('/http://localhost:43210/docs/');
    expect(await paste(dev, 'http://localhost:4321.evil.example/x')).toBe('/http://localhost:4321.evil.example/x');
    dev.dom.window.close();

    const html = await paint({
      site: siteBody({ host: 'html' }),
      preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
    });
    expect(await paste(html, `http://127.0.0.1:4400/s/${SITE_ID}/site/about/#team`)).toBe('/about/#team');
    expect(await paste(html, `http://127.0.0.1:4400/s/${SITE_ID}/site`)).toBe('/');
    expect(await paste(html, 'http://127.0.0.1:4400/s/bbbbbbbbbbbb/site/about/')).toBe(
      '/http://127.0.0.1:4400/s/bbbbbbbbbbbb/site/about/',
    );
    html.dom.window.close();
  });

  // 8.4 — the page's side of the preview agent. The frame's agent is played
  // by the test: what the page posts to the frame is recorded on its window,
  // and the agent's answers are dispatched from the frame's window.
  describe('finding the key in the preview', () => {
    const PROXY = 'http://127.0.0.1:45123';
    const CHANNEL = 'chan-1';
    const DEV_PREVIEW = { url: `${PROXY}/`, dev: 'http://localhost:4321/', up: true, channel: CHANNEL, start: 'npx astro dev', source: 'astro' };
    const STATIC_PREVIEW = { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true, channel: CHANNEL };
    const LOCATED = (over: Record<string, unknown>): Record<string, unknown> => ({
      stet: 'located', key: 'hero_headline', found: 1, by: 'text', draft: null, route: '/', channel: CHANNEL, ...over,
    });
    type Post = { message: Record<string, unknown>; target: string };

    /** The frame's side: what the page posted to it, and a voice to answer as its agent with. */
    function agentOf(page: Painted, auto?: (message: Record<string, unknown>) => Record<string, unknown> | null) {
      const doc = docOf(page);
      const frame = (): HTMLIFrameElement => doc.querySelector('#devwrap iframe') as HTMLIFrameElement;
      const posts: Post[] = [];
      const say = (data: unknown, source: unknown = frame().contentWindow): void => {
        page.dom.window.dispatchEvent(new page.dom.window.MessageEvent('message', { data, source: source as Window }));
      };
      const spy = (): void => {
        const win = frame().contentWindow as unknown as { __spied?: boolean; postMessage: unknown };
        if (win.__spied === true) return;
        win.__spied = true;
        win.postMessage = (message: Record<string, unknown>, target: string): void => {
          posts.push({ message: JSON.parse(JSON.stringify(message)) as Record<string, unknown>, target });
          const reply = auto?.(message) ?? null;
          if (reply !== null) setTimeout(() => say(reply), 0);
        };
      };
      spy();
      /** One message from the frame's agent, carrying the channel, then the page settled. */
      const tell = async (message: Record<string, unknown>): Promise<void> => {
        say({ channel: CHANNEL, ...message });
        await page.settle();
      };
      return {
        posts,
        say,
        spy,
        frame,
        tell,
        /** The messages of one kind the page posted to the frame. */
        sent: (stet: string): Array<Record<string, unknown>> => posts.map((p) => p.message).filter((m) => m['stet'] === stet),
        pick: (keys: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Promise<void> =>
          tell({ stet: 'pick', keys: keys.map((k) => ({ attr: null, by: 'whole', inplace: true, ...k })), tag: 'h1', rect: { left: 100, top: 50, width: 200, height: 20 }, again: false, ...over }),
        typed: (key: string, value: unknown, over: Record<string, unknown> = {}): Promise<void> =>
          tell({ stet: 'typed', key, locale: 'default', value, ...over }),
        edited: (key: string, how: string, over: Record<string, unknown> = {}): Promise<void> =>
          tell({ stet: 'edited', key, locale: 'default', how, proposed: true, ...over }),
        census: (over: Record<string, unknown> = {}): Promise<void> =>
          tell({ stet: 'census', found: {}, entries: {}, ambiguous: [], weak: [], head: [], route: '/', ...over }),
        moved: (route: string): Promise<void> => tell({ stet: 'moved', how: 'pushState', route }),
        key: (which: string): Promise<void> => tell({ stet: 'key', which }),
        /** The frame's `load`, as a navigation ends. */
        load: async (): Promise<void> => {
          spy();
          frame().dispatchEvent(new page.dom.window.Event('load'));
          await page.settle();
        },
        ready: async (route = '/'): Promise<void> => {
          say({ stet: 'ready', route, channel: CHANNEL });
          await page.settle();
        },
        locates: (): Array<Record<string, unknown>> => posts.map((p) => p.message).filter((m) => m['stet'] === 'locate'),
      };
    }
    const note = (page: Painted): HTMLElement => docOf(page).getElementById('panenote') as HTMLElement;
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // --- add-key-context: what each key is and where it appears -----------------
    describe('what each key is and where it appears', () => {
      const HEADLINE = 'You may already have the data<1> our AI lab partners need.</1>';
      /** The psyon shape: a tagged headline, a share description derived from it, and the head's title and description. */
      const KC: Descriptor = {
        version: 1,
        keys: {
          hero: { shape: 'text', target: 'web', tags: 1 },
          share: { shape: 'text', target: 'web', derivesFrom: 'hero', tmpl: '{v} More.' },
          title: { shape: 'text', target: 'web' },
          desc: { shape: 'text', target: 'web' },
          foot: { shape: 'text', target: 'web' },
        },
        pages: { home: { route: '/', seo: { title: 'title', description: 'desc' } } },
      };
      const KC_SNAPSHOT = {
        default: { hero: HEADLINE, title: 'Psyon — data acquisition', desc: 'Your development history, read.', foot: '© 2026 Psyon' },
      };
      const KC_PLACES: Record<string, Array<Record<string, unknown>>> = {
        title: [{ file: 'index.html', line: 3, kind: 'page title', tag: 'title', head: true }],
        share: [{ file: 'index.html', line: 4, kind: 'share description', tag: 'meta', attr: 'content', meta: 'og:description', head: true }],
        desc: [{ file: 'index.html', line: 5, kind: 'meta description', tag: 'meta', attr: 'content', meta: 'description', head: true }],
        hero: [{ file: 'index.html', line: 9, kind: 'headline', tag: 'h1' }],
        foot: [{ file: 'index.html', line: 20, kind: 'paragraph', tag: 'p' }],
      };
      const kcMarks = (places: Record<string, unknown> = KC_PLACES): Record<string, unknown> => ({
        documents: [{ file: 'index.html', route: '/', page: 'home' }],
        keys: Object.fromEntries(Object.keys(places).map((id) => [id, ['index.html']])),
        places,
      });
      /** The psyon-shaped site, its marks answered with `places`. */
      const kcPage = (over: { descriptor?: Descriptor; snapshot?: unknown; places?: Record<string, unknown>; site?: Record<string, unknown>; preview?: unknown } = {}) =>
        paint({
          site: siteBody({ host: 'html', descriptor: over.descriptor ?? KC, snapshot: over.snapshot ?? KC_SNAPSHOT, ...over.site }),
          routes: [['/api/site/marks', 200, over.places === undefined ? kcMarks() : kcMarks(over.places)]],
          ...(over.preview === undefined ? {} : { preview: over.preview }),
        });
      const rowKinds = (page: Painted, id: string): string =>
        docOf(page).querySelector(`[data-act="key:${id}"] .kd`)?.textContent ?? '';
      const kline = (page: Painted): string[] =>
        [...docOf(page).querySelectorAll('.kline > div')].map((line) => line.textContent ?? '');
      const cards = (page: Painted): HTMLElement => docOf(page).getElementById('panecards') as HTMLElement;
      const card = (page: Painted, which: 'serp' | 'share'): string[] =>
        [...cards(page).querySelectorAll(`.${which} > div`)].map((part) => part.textContent ?? '');

      it('names each row’s and the header’s element (journeys B17, B18)', async () => {
        const page = await kcPage();
        await page.change('group', 'seo');
        expect([rowKinds(page, 'title'), rowKinds(page, 'share'), rowKinds(page, 'desc')]).toEqual([
          'page title',
          'share description',
          'meta description',
        ]);
        await page.change('group', 'page:home');
        expect([rowKinds(page, 'hero'), rowKinds(page, 'foot')]).toEqual(['headline', 'paragraph']);
        await page.act('key:hero');
        expect(kline(page)).toEqual(['headline index.html:9', 'feeds: share description (share)']);
        await page.change('group', 'seo');
        await page.act('key:share');
        expect(kline(page)).toEqual(['share description index.html:4', 'derived from: headline (hero)']);
        expect(page.errors).toEqual([]);
        page.dom.window.close();
      });

      it('names a JavaScript host’s reads by their element, or by their file', async () => {
        const page = await paint({
          routes: [
            [
              '/api/site/marks',
              200,
              {
                documents: [],
                keys: {},
                places: {
                  hero_headline: [
                    { file: 'src/components/Nav.astro', line: 4, kind: 'link text', tag: 'a' },
                    { file: 'src/pages/index.astro', line: 12, kind: 'paragraph', tag: 'p' },
                    { file: 'src/pages/index.astro', line: 2, kind: 'text in src/pages/index.astro' },
                    { file: 'src/pages/about.astro', line: 7, kind: 'link text', tag: 'a' },
                  ],
                },
              },
            ],
          ],
        });
        expect(rowKinds(page, 'hero_headline')).toBe('link text · paragraph · text in src/pages/index.astro');
        await page.act('key:hero_headline');
        expect(kline(page)[0]).toBe(
          'link text · paragraph · text in src/pages/index.astro src/components/Nav.astro:4, src/pages/index.astro:12, src/pages/index.astro:2, +1 more',
        );
        page.dom.window.close();
      });

      it('reads a `constructor` tag, meta or attribute as plain text, never from a prototype', async () => {
        const page = await kcPage({
          places: {
            ...KC_PLACES,
            hero: [{ file: 'index.html', line: 9, kind: 'text in <constructor>', tag: 'constructor' }],
            foot: [{ file: 'index.html', line: 20, kind: 'content attribute', tag: 'meta', attr: 'content', meta: 'constructor' }],
            desc: [{ file: 'index.html', line: 5, kind: 'constructor attribute', tag: 'img', attr: 'constructor' }],
          },
        });
        await page.type('search', 'o');
        expect([rowKinds(page, 'hero'), rowKinds(page, 'foot'), rowKinds(page, 'desc')]).toEqual([
          'text in <constructor>',
          'content attribute',
          'constructor attribute · meta description',
        ]);
        page.dom.window.close();
      });

      it('reads an svg’s `<title>` as a tooltip, outside the SEO group and with no cards', async () => {
        const page = await kcPage({ places: { ...KC_PLACES, foot: [{ file: 'index.html', line: 20, kind: 'tooltip', tag: 'title', svg: true }] } });
        expect(rowKinds(page, 'foot')).toBe('tooltip');
        await page.act('key:foot');
        expect(cards(page).hidden).toBe(true);
        expect(cards(page).innerHTML).toBe('');
        await page.change('group', 'seo');
        expect(page.keys()).not.toContain('foot');
        page.dom.window.close();
      });

      it('reads a JavaScript host’s meta description read as one, in the SEO group', async () => {
        const page = await paint({
          routes: [
            [
              '/api/site/marks',
              200,
              { documents: [], keys: {}, places: { loose_key: [{ file: 'src/Base.astro', line: 4, kind: 'meta description', tag: 'meta', attr: 'content', meta: 'description', head: true }] } },
            ],
          ],
        });
        await page.change('group', 'seo');
        expect(page.keys()).toEqual(['loose_key', 'seo_home_title']);
        expect(rowKinds(page, 'loose_key')).toBe('meta description');
        page.dom.window.close();
      });

      it('puts the head keys in the SEO group (journeys B17, C1)', async () => {
        const page = await kcPage();
        const labels = [...docOf(page).querySelectorAll('#gsel option')].map((option) => option.textContent);
        expect(labels).toEqual(['All keys', 'This page', 'home — page', 'SEO']);
        expect((docOf(page).getElementById('gsel') as HTMLSelectElement).value).toBe('all');
        await page.change('group', 'page:home');
        expect(page.keys()).toEqual(['foot', 'hero']);
        await page.change('group', 'seo');
        expect(page.keys()).toEqual(['desc', 'share', 'title']);
        page.dom.window.close();
      });

      it('says where a key the page does not show appears, in place of the not-found line (journeys B19, C1)', async () => {
        const page = await kcPage({ preview: STATIC_PREVIEW });
        const agent = agentOf(page);
        await agent.load();
        await agent.ready(`/s/${SITE_ID}/site/`);
        await page.change('group', 'seo');
        await page.act('key:title');
        agent.say(LOCATED({ key: 'title', found: 0, seq: agent.locates().at(-1)?.['seq'] }));
        await page.settle();
        expect(note(page).textContent).toBe(
          'title appears as the page title, in the browser tab and in search results. It is not part of the page’s visible text.',
        );
        await page.act('key:share');
        expect(note(page).textContent).toBe(
          'share appears as the share description, under the share title when the page is shared as a link. ' +
            'It follows hero (headline), outlined dashed on the page.',
        );
        page.dom.window.close();
      });

      it('says where a key appears with no agent reply at all', async () => {
        const page = await kcPage();
        await page.change('group', 'seo');
        await page.act('key:title');
        expect(note(page).textContent).toBe(
          'title appears as the page title, in the browser tab and in search results. It is not part of the page’s visible text.',
        );
        page.dom.window.close();
      });

      it('draws the search result and the share card from the drafts (journeys C1, B17)', async () => {
        const page = await kcPage();
        await page.change('group', 'seo');
        await page.act('key:share');
        const serp = ['Search result', '/', 'Psyon — data acquisition', 'Your development history, read.'];
        expect(card(page, 'serp')).toEqual(serp);
        expect(card(page, 'share')).toEqual([
          'Share card',
          '/',
          'Psyon — data acquisition',
          'You may already have the data our AI lab partners need. More.',
        ]);
        await page.change('group', 'page:home');
        await page.act('key:hero');
        expect(card(page, 'serp')).toEqual(serp);
        await page.type('text:hero', 'You may already have data<1> our AI lab partners need.</1>');
        expect(card(page, 'share')[3]).toBe('You may already have data our AI lab partners need. More.');
        await page.act('key:foot');
        expect(cards(page).hidden).toBe(true);
        expect(cards(page).innerHTML).toBe('');
        page.dom.window.close();
      });

      it('draws a JavaScript page record’s title and description in both cards', async () => {
        const page = await paint({
          site: siteBody({
            descriptor: { ...descriptor, pages: { home: { route: '/', seo: { title: 'seo_home_title', description: 'loose_key' } } } },
          }),
        });
        await page.change('group', 'seo');
        await page.act('key:seo_home_title');
        expect(card(page, 'serp')).toEqual(['Search result', '/', 'Home', 'loose']);
        expect(card(page, 'share')).toEqual(['Share card', '/', 'Home', 'loose']);
        page.dom.window.close();
      });

      it('writes a value holding markup into a card as text', async () => {
        const page = await kcPage({ snapshot: { default: { ...KC_SNAPSHOT.default, desc: '<b>Bold</b> claims' } } });
        await page.change('group', 'seo');
        await page.act('key:title');
        expect(card(page, 'serp')[3]).toBe('<b>Bold</b> claims');
        expect(cards(page).querySelector('b')).toBeNull();
        page.dom.window.close();
      });

      it('shades the numbered tags in a field that keeps them exactly (journeys B17, B18)', async () => {
        const page = await kcPage();
        await page.answer('/api/site/save', 200, { written: ['content/defaults.json', 'index.html'], unchanged: [], findings: [], at: {}, pending: [] });
        await page.act('key:hero');
        const doc = docOf(page);
        const field = doc.querySelector('.tagged textarea') as HTMLTextAreaElement;
        expect(field.value).toBe(HEADLINE);
        const mirror = doc.querySelector('.tagmirror') as HTMLElement;
        expect([...mirror.querySelectorAll('.ptag')].map((tag) => tag.textContent)).toEqual(['<1>', '</1>']);
        expect([...mirror.querySelectorAll('.pin')].map((run) => run.textContent)).toEqual([' our AI lab partners need.']);
        expect(doc.querySelector('.tagged + .note')?.textContent).toBe(
          'Words between <1> and </1> keep the page’s own styling for that part, shaded here. ' +
            'Change the words as you like and keep each tag; a save without them is refused.',
        );
        const typed = 'You may already have <1>all the data</1> we need.';
        await page.type('text:hero', typed);
        expect([...mirror.querySelectorAll('.pin')].map((run) => run.textContent)).toEqual(['all the data']);
        expect(doc.querySelector('.cb .cnt')?.textContent).toBe(String(typed.length));
        await page.act('save');
        expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
          values: [{ key: 'hero', locale: 'default', value: typed, base: HEADLINE }],
        });
        expect(page.dom.window.document.querySelector('style')?.textContent).toContain('.tagged textarea{display:block;');
        page.dom.window.close();

        const markup = await kcPage({ snapshot: { default: { ...KC_SNAPSHOT.default, hero: '<img src=x onerror=alert(1)><1>x</1>' } } });
        await markup.act('key:hero');
        expect(docOf(markup).querySelector('.tagmirror img')).toBeNull();
        expect(docOf(markup).querySelector('.tagmirror')?.textContent).toBe('<img src=x onerror=alert(1)><1>x</1>\n');
        markup.dom.window.close();
      });

      /** The derived editor's two fields and the source's grey text between them. */
      const editor = (page: Painted, id: string): { before: HTMLInputElement; after: HTMLInputElement; source: string } => ({
        before: docOf(page).querySelector(`[data-act-input="tmplBefore:${id}"]`) as HTMLInputElement,
        after: docOf(page).querySelector(`[data-act-input="tmplAfter:${id}"]`) as HTMLInputElement,
        source: docOf(page).getElementById('derivedsrc')?.textContent ?? '',
      });

      it('edits a derived key’s template in the two fields around its source’s text (journey C1)', async () => {
        const page = await kcPage();
        page.answer('/api/site/save', 200, { written: ['content/descriptor.json', 'index.html'], unchanged: [], findings: [], at: {}, pending: [] });
        await page.change('group', 'seo');
        await page.act('key:share');
        const doc = docOf(page);
        const fields = editor(page, 'share');
        expect(fields.before.value).toBe('');
        expect(fields.after.value).toBe(' More.');
        expect(fields.before.getAttribute('aria-label')).toBe('Text before hero');
        expect(fields.after.getAttribute('aria-label')).toBe('Text after hero');
        expect(fields.before.disabled).toBe(false);
        // The headline's text, its tags dropped, grey between the fields; no {v} line.
        expect(fields.source).toBe('You may already have the data our AI lab partners need.');
        expect(doc.getElementById('derivedsrc')?.className).toBe('muted');
        expect(doc.querySelector('.cb .note')).toBeNull();
        expect(doc.querySelector('#derived .term')?.textContent).toBe('You may already have the data our AI lab partners need. More.');
        expect(doc.querySelector('[data-act="key:share"]')?.innerHTML).not.toContain('no value');

        await page.type('tmplAfter:share', ' Start with a call.');
        const reads = 'You may already have the data our AI lab partners need. Start with a call.';
        expect(doc.querySelector('#derived .term')?.textContent).toBe(reads);
        expect(doc.querySelector('#derived .cnt')?.textContent).toBe(String(reads.length));
        expect(doc.querySelector('.row.on .v')?.textContent).toBe(reads.slice(0, 40));
        expect(card(page, 'share')[3]).toBe(reads);
        await page.act('save');
        expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
          values: [],
          templates: [{ key: 'share', tmpl: '{v} Start with a call.' }],
        });
        expect(doc.querySelector('[data-act="key:share"]')?.innerHTML).not.toContain('no value');
        page.dom.window.close();
      });

      it('drops a template typed back to the saved one, and follows the source’s draft in the grey text', async () => {
        const page = await kcPage();
        await page.act('key:hero');
        await page.type('text:hero', 'You may already have <1>all the data</1> we need.');
        await page.change('group', 'seo');
        await page.act('key:share');
        expect(editor(page, 'share').source).toBe('You may already have all the data we need.');
        await page.type('tmplBefore:share', 'Read: ');
        expect(docOf(page).getElementById('dc')?.textContent).toBe('2 unsaved edits');
        await page.type('tmplBefore:share', '');
        expect(docOf(page).getElementById('dc')?.textContent).toBe('1 unsaved edit');
        page.dom.window.close();
      });

      it('shows a source holding only a default value grey in another locale, as Reads as does', async () => {
        const page = await kcPage();
        await page.change('locale', 'de');
        await page.change('group', 'seo');
        await page.act('key:share');
        expect(editor(page, 'share').source).toBe('You may already have the data our AI lab partners need.');
        expect(docOf(page).querySelector('#derived .term')?.textContent).toBe('You may already have the data our AI lab partners need. More.');
        page.dom.window.close();
      });

      it('draws markup in the source’s text as text', async () => {
        const page = await kcPage({ snapshot: { default: { ...KC_SNAPSHOT.default, hero: '<b>bold</b> <img src=x onerror=alert(1)><1>x</1>' } } });
        await page.change('group', 'seo');
        await page.act('key:share');
        expect(docOf(page).querySelector('#derivedsrc b, #derivedsrc img')).toBeNull();
        expect(editor(page, 'share').source).toBe('<b>bold</b> <img src=x onerror=alert(1)>x');
        page.dom.window.close();
      });

      it('shows a store-backed site’s template read-only', async () => {
        const page = await kcPage({ site: { mode: 'store' } });
        await page.change('group', 'seo');
        await page.act('key:share');
        const fields = editor(page, 'share');
        expect(fields.before.disabled).toBe(true);
        expect(fields.after.disabled).toBe(true);
        expect(docOf(page).querySelector('.cb .note')?.textContent).toBe('The template lives in the descriptor; edit it in the repository.');
        page.dom.window.close();
      });

      it('outlines a derived key’s source and sends a tagged key’s count with its locate', async () => {
        const page = await kcPage({ preview: STATIC_PREVIEW });
        const agent = agentOf(page);
        await agent.load();
        await agent.ready(`/s/${SITE_ID}/site/`);
        await page.change('group', 'seo');
        await page.act('key:share');
        expect(agent.locates().at(-1)).toMatchObject({ key: 'share', mark: 'hero', dashed: true, draft: null });
        await page.change('group', 'page:home');
        await page.act('key:hero');
        expect(agent.locates().at(-1)).toMatchObject({ key: 'hero', tags: 1 });
        page.dom.window.close();
      });

      it('shows a derived key through the locale chain where its source has no value of its own', async () => {
        const page = await kcPage({
          descriptor: { ...KC, pages: { home: { route: '/', seo: { title: 'title', description: 'share' } } } },
        });
        const expected = resolve(KC, KC_SNAPSHOT, null, { key: 'share', locale: 'de' }).value as string;
        expect(expected).toBe('You may already have the data our AI lab partners need. More.');
        await page.change('locale', 'de');
        await page.change('group', 'seo');
        expect(docOf(page).querySelector('[data-act="key:share"] .v')?.textContent).toBe(expected.slice(0, 40));
        await page.act('key:share');
        expect(docOf(page).querySelector('#derived .term')?.textContent).toBe(expected);
        expect(card(page, 'share')[3]).toBe(expected);
        await page.act('tab:SEO');
        expect(painted(page)).toContain(expected.slice(0, 70));
        page.dom.window.close();
      });

      it('fills a card from the default locale where a key has no value in the one selected (stage-5 R5)', async () => {
        const page = await kcPage();
        await page.change('locale', 'de');
        await page.change('group', 'seo');
        await page.act('key:title');
        expect(card(page, 'serp')).toEqual(['Search result', '/', 'Psyon — data acquisition', 'Your development history, read.']);
        page.dom.window.close();
      });

      it('paints two derived keys that derive from each other, each with no value (stage-5 R8)', async () => {
        const cycle: Descriptor = {
          version: 1,
          keys: {
            loop_a: { shape: 'text', target: 'web', derivesFrom: 'loop_b', tmpl: '{v}' },
            loop_b: { shape: 'text', target: 'web', derivesFrom: 'loop_a', tmpl: '{v}' },
          },
        };
        const page = await kcPage({ descriptor: cycle, snapshot: { default: {} }, places: {} });
        await page.act('key:loop_a');
        await page.act('key:loop_b');
        expect(page.errors).toEqual([]);
        expect([...docOf(page).querySelectorAll('.row .k')].map((k) => k.textContent)).toEqual(['loop_a', 'loop_b']);
        page.dom.window.close();
      });

      it('holds in SEO the keys the server places in the head, and no visible attribute', async () => {
        const descriptor = structuredClone(KC);
        descriptor.keys['logo'] = { shape: 'text', target: 'web' };
        descriptor.keys['tab'] = { shape: 'text', target: 'web' };
        const page = await kcPage({
          descriptor,
          places: {
            ...KC_PLACES,
            logo: [{ file: 'index.html', line: 10, tag: 'img', attr: 'alt' }],
            tab: [{ file: 'about.html', line: 3, tag: 'title', head: true }],
          },
        });
        await page.change('group', 'seo');
        const rows = [...docOf(page).querySelectorAll('.row .k')].map((k) => k.textContent);
        expect(rows).toContain('tab');
        expect(rows).not.toContain('logo');
        page.dom.window.close();
      });

      it('names no icon it would fetch (stage-5 R7)', () => {
        expect(dashboardPage()).toContain('<link rel="icon" href="data:,">');
      });

      it('reads the numbered tags the way src does, in the page and in the agent (the placeholder grammar)', () => {
        const page = dashboardPage();
        const agent = readFileSync(join(packageRoot(), 'templates', 'preview-agent.js'), 'utf8');
        const literal = (source: string, pattern: RegExp): RegExp => {
          const found = pattern.exec(source)?.[1];
          expect(found, String(pattern)).toBeDefined();
          return new RegExp(found as string, 'g');
        };
        // The page's derivation, its mirror's split, and the agent's split, as written in their sources.
        const readers: Record<string, RegExp> = {
          'page deriveText': literal(page, /function deriveText[\s\S]*?text\.replace\(\/(.+?)\/g,/),
          'page taggedHtml': literal(page, /function taggedHtml[\s\S]*?text\.split\(\/\((.+?)\)\/\)/),
          'agent draftTagged': literal(agent, /function draftTagged[\s\S]*?draft\.split\(\/\((.+?)\)\/\)/),
        };
        const tokens = (pattern: RegExp, text: string): string[] => [...text.matchAll(new RegExp(pattern.source, 'g'))].map((m) => m[0]);
        const shapes = ['<1>', '</1>', '<1/>', '<01>', '<1 >', '</1/>', 'text with <b>bold</b> and <2>two</2>'];
        const mismatches: string[] = [];
        for (const shape of shapes) {
          const src = tokens(PLACEHOLDER, shape);
          for (const [name, pattern] of Object.entries(readers)) {
            const theirs = tokens(pattern, shape);
            if (JSON.stringify(theirs) !== JSON.stringify(src)) mismatches.push(`${name} on ${shape}: ${JSON.stringify(theirs)} ≠ ${JSON.stringify(src)}`);
          }
        }
        expect(mismatches).toEqual([]);
      });

      it('derives the text the resolver does (the parity table)', () => {
        const source = /function deriveText\(tmpl, value, tagged\) \{[\s\S]*?\n\}/.exec(dashboardPage())?.[0];
        expect(source).toBeDefined();
        const deriveText = new Function(`${source as string}; return deriveText;`)() as (t: string, v: unknown, tagged: boolean) => string;
        const rows: Array<[string, string]> = [
          ['{v} No raw data is needed to start.', HEADLINE],
          ['$& $$ $1 {v}', 'Costs $$ and $& now'],
          ['{v}!', 'First line<1/>second line.'],
          ['{v} and {v}', 'Twice'],
          ['No placeholder at all.', 'Ignored'],
          ['[{v}]', ''],
          ["{v} — Mirra", "x$`y$'z"],
        ];
        const mismatches: string[] = [];
        for (const tags of [undefined, 1]) {
          const d: Descriptor = { version: 1, keys: { src: { shape: 'text', target: 'web', ...(tags === undefined ? {} : { tags }) } } };
          for (const [tmpl, value] of rows) {
            const page = deriveText(tmpl, value, tags !== undefined);
            const core = derivedText(d, 'src', value, tmpl);
            if (page !== core) mismatches.push(`${tags ?? 0} ${tmpl} ${value}: ${page} ≠ ${core}`);
          }
        }
        expect(mismatches).toEqual([]);
      });
    });

    it('posts a locate for the picked key to the proxy’s origin, and to * on the static pane', async () => {
      const dev = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(dev);
      await agent.load();
      await agent.ready();
      await dev.act('key:hero_headline');
      expect(agent.locates().at(-1)).toMatchObject({
        stet: 'locate', key: 'hero_headline', texts: ['Ship the copy'], draft: null, scroll: true, guess: true,
      });
      expect(agent.posts.at(-1)?.target).toBe(PROXY);
      dev.dom.window.close();

      const html = await paint({
        site: siteBody({ host: 'html', descriptor: unpaged }),
        preview: STATIC_PREVIEW,
        routes: [['/api/site/marks', 200, allMarkedIn('index.html', null)]],
      });
      const statik = agentOf(html);
      await statik.load();
      await statik.ready(`/s/${SITE_ID}/site/`);
      await html.act('key:hero_headline');
      expect(statik.locates().at(-1)).toMatchObject({ key: 'hero_headline', scroll: true });
      expect(statik.posts.at(-1)?.target).toBe('*');
      html.dom.window.close();
    });

    it('posts one locate for three quick keystrokes, with the draft and no scroll', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page);
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      const before = agent.locates().length;
      await page.type('text:hero_headline', 'S');
      await page.type('text:hero_headline', 'Sh');
      await page.type('text:hero_headline', 'Shi');
      await wait(150);
      expect(agent.locates().slice(before)).toEqual([
        expect.objectContaining({ key: 'hero_headline', draft: 'Shi', scroll: false }),
      ]);
      page.dom.window.close();
    });

    it('names a key the page does not show, a draft shown after Save, and reads only the selected key’s answers', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page);
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      const seq = (): number => agent.locates().at(-1)?.['seq'] as number;
      agent.say(LOCATED({ found: 0, seq: seq() }));
      await page.settle();
      expect(note(page).hidden).toBe(false);
      expect(note(page).textContent).toBe('hero_headline was not found on /.');
      agent.say(LOCATED({ draft: 'after-save', seq: seq() }));
      await page.settle();
      expect(note(page).textContent).toBe('This draft is shown after Save.');
      // An answer about another key is not this key's.
      agent.say(LOCATED({ key: 'loose_key', found: 0, seq: seq() }));
      await page.settle();
      expect(note(page).textContent).toBe('This draft is shown after Save.');
      // One from a window other than the frame's changes nothing.
      agent.say(LOCATED({ found: 0, seq: seq() }), page.dom.window);
      await page.settle();
      expect(note(page).textContent).toBe('This draft is shown after Save.');
      // A reply to a request that no longer stands changes nothing.
      agent.say(LOCATED({ found: 0, seq: seq() - 1 }));
      await page.settle();
      expect(note(page).textContent).toBe('This draft is shown after Save.');
      page.dom.window.close();
    });

    it('spells a static route as the Route field does, and locates with scroll once a moved page is ready', async () => {
      const page = await paint({
        site: siteBody({ host: 'html', descriptor: unpaged }),
        preview: STATIC_PREVIEW,
        routes: [['/api/site/marks', 200, {
          documents: [{ file: 'index.html', route: '/', page: null }, { file: 'about/index.html', route: '/about/', page: null }],
          keys: { hero_headline: ['about/index.html'], loose_key: ['index.html'] },
        }]],
      });
      const agent = agentOf(page);
      await agent.load();
      await agent.ready(`/s/${SITE_ID}/site/`);
      // Found by search, so picking it is what moves the pane.
      await page.type('search', 'hero_headline');
      await page.act('key:hero_headline');
      // Moved: nothing is located until the page it moved to reports ready.
      expect(agent.locates().filter((m) => m['key'] === 'hero_headline')).toEqual([]);
      await agent.load();
      await agent.ready(`/s/${SITE_ID}/site/about/`);
      expect(agent.locates().at(-1)).toMatchObject({ key: 'hero_headline', scroll: true });
      agent.say(LOCATED({ found: 0, route: `/s/${SITE_ID}/site/about/`, seq: agent.locates().at(-1)?.['seq'] }));
      await page.settle();
      expect(note(page).textContent).toBe('hero_headline was not found on /about/.');
      page.dom.window.close();
    });

    it('says highlighting is not available where the frame’s page stays silent for 3 s', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page);
      await agent.load();
      await wait(3_100);
      expect(note(page).textContent).toBe('Highlighting is not available on this page.');
      page.dom.window.close();
    }, 10_000);

    it('never posts the run token, and cuts a pasted address of the proxy or the dev server', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page);
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'A draft');
      await wait(150);
      for (const post of agent.posts) expect(JSON.stringify(post.message)).not.toContain('fixture-token');
      const route = docOf(page).getElementById('route') as HTMLInputElement;
      for (const pasted of [`${PROXY}/docs/`, 'http://localhost:4321/docs/']) {
        route.value = pasted;
        route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
        await page.settle();
        expect(page.requested('/api/site/preview').at(-1), pasted).toContain('route=%2Fdocs%2F');
      }
      page.dom.window.close();
    });

    it('posts nothing before a ready carrying the channel, nothing after a bye, and only hello on a load', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page);
      await page.act('key:hero_headline');
      expect(agent.posts).toEqual([]);
      agent.say({ stet: 'ready', route: '/' });
      await page.settle();
      expect(agent.posts).toEqual([]);
      await agent.load();
      expect(agent.posts.map((p) => p.message)).toEqual([{ stet: 'hello' }]);
      await agent.ready();
      expect(agent.locates()).toHaveLength(1);
      agent.say({ stet: 'bye', channel: CHANNEL });
      await page.settle();
      const held = agent.posts.length;
      await page.type('text:hero_headline', 'Typed after bye');
      await wait(150);
      expect(agent.posts).toHaveLength(held);
      await agent.ready();
      expect(agent.locates().at(-1)).toMatchObject({ draft: 'Typed after bye' });
      page.dom.window.close();
    });

    it('counts a ready sent before the frame’s load, through the hello it answers', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page, (message) => (message['stet'] === 'hello' ? { stet: 'ready', route: '/', channel: CHANNEL } : null));
      await agent.ready();
      await agent.load();
      await page.settle();
      await page.act('key:hero_headline');
      expect(agent.locates().at(-1)).toMatchObject({ key: 'hero_headline', scroll: true });
      page.dom.window.close();
    });

    it('turns a text match solid once a save shows its text changing', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
      // The saved text is on the page: every look finds it.
      const agent = agentOf(page, (message) =>
        message['stet'] === 'locate' ? LOCATED({ seq: message['seq'], found: 1, by: 'text' }) : null,
      );
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.settle();
      await page.type('text:hero_headline', 'Saved words');
      await wait(150);
      expect(agent.locates().at(-1)).toMatchObject({ guess: true });
      await page.act('save');
      await agent.ready();
      await page.settle();
      const looks = agent.locates();
      expect(looks.some((m) => JSON.stringify(m['texts']) === JSON.stringify(['Saved words']))).toBe(true);
      expect(looks.at(-1)).toMatchObject({ key: 'hero_headline', guess: false });
      // Above the frame the note keeps its line, empty.
      expect([note(page).hidden, note(page).textContent]).toEqual([false, '']);
      page.dom.window.close();
    });

    it('checks a match inside more text after a save as it does a whole one, and never a mark', async () => {
      for (const [by, confirmed] of [['contained', true], ['mark', false]] as const) {
        const page = await paint({ preview: DEV_PREVIEW });
        page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
        const agent = agentOf(page, (message) =>
          message['stet'] === 'locate' ? LOCATED({ seq: message['seq'], found: 1, by }) : null,
        );
        await agent.load();
        await agent.ready();
        await page.act('key:hero_headline');
        await page.settle();
        await page.type('text:hero_headline', 'Saved words');
        await wait(150);
        await page.act('save');
        await agent.ready();
        await page.settle();
        expect(agent.locates().at(-1)).toMatchObject({ key: 'hero_headline', guess: !confirmed });
        page.dom.window.close();
      }
    });

    it('says when the key is on the page but hidden there', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page, (message) =>
        message['stet'] === 'locate' ? LOCATED({ seq: message['seq'], found: 1, hidden: true }) : null,
      );
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.settle();
      expect(note(page).hidden).toBe(false);
      expect(note(page).textContent).toBe('hero_headline is on this page but hidden, so the preview cannot show it.');
      page.dom.window.close();
    });

    it('names text the template writes out itself when a save leaves a match inside more text unchanged', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
      const agent = agentOf(page, (message) =>
        message['stet'] === 'locate'
          ? LOCATED({ seq: message['seq'], by: 'contained', found: (message['texts'] as string[])[0] === 'Ship the copy' ? 1 : 0 })
          : null,
      );
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.settle();
      expect(agent.locates().at(-1)).toMatchObject({ guess: true });
      await page.type('text:hero_headline', 'Saved words');
      await wait(150);
      await page.act('save');
      await agent.ready();
      for (let turn = 0; turn < 4; turn += 1) await page.settle();
      expect(note(page).textContent).toBe(
        "The outlined text does not come from stet — the page's template writes it out itself, so saving hero_headline does not change it.",
      );
      page.dom.window.close();
    });

    it('names text the template writes out itself, and keeps saying so, when the saved text is not on the page', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
      const HARDCODED =
        "The outlined text does not come from stet — the page's template writes it out itself, so saving hero_headline does not change it.";
      // The page shows the old text whatever is saved: the template writes it.
      const agent = agentOf(page, (message) =>
        message['stet'] === 'locate'
          ? LOCATED({ seq: message['seq'], found: (message['texts'] as string[])[0] === 'Ship the copy' ? 1 : 0 })
          : null,
      );
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.settle();
      await page.type('text:hero_headline', 'Saved words');
      await wait(150);
      await page.act('save');
      // Announced twice: only the reply to the latest look is read.
      agent.say({ stet: 'ready', route: '/', channel: CHANNEL });
      agent.say({ stet: 'ready', route: '/', channel: CHANNEL });
      for (let turn = 0; turn < 4; turn += 1) await page.settle();
      expect(note(page).textContent).toBe(HARDCODED);
      // The page re-applying its request later changes nothing about it.
      agent.say(LOCATED({ seq: agent.locates().at(-1)?.['seq'], found: 1 }));
      await page.settle();
      expect(note(page).textContent).toBe(HARDCODED);
      page.dom.window.close();
    });

    it('ignores the pre-save request’s reply once the save is made, so a page re-rendered in place is not read as missing the key (F89)', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
      const agent = agentOf(page, (message) =>
        message['stet'] === 'locate' ? LOCATED({ seq: message['seq'], found: 1 }) : null,
      );
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.settle();
      await page.type('text:hero_headline', 'Saved words');
      await wait(150);
      await page.settle();
      const earlier = agent.locates().at(-1)?.['seq'];
      await page.act('save');
      const before = agent.locates().length;
      // The dev server re-rendered the page in place: its agent re-applies the request from before the save
      // against the saved text, and finds nothing.
      agent.say(LOCATED({ seq: earlier, found: 0, by: 'contained' }));
      await page.settle();
      expect(agent.locates()).toHaveLength(before);
      expect(note(page).textContent).not.toContain('was not found');
      page.dom.window.close();
    }, 10_000);

    it('runs the save’s check after 3 s where the page sends no new ready', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
      const agent = agentOf(page, (message) =>
        message['stet'] === 'locate' ? LOCATED({ seq: message['seq'], found: 1 }) : null,
      );
      await agent.load();
      await agent.ready();
      await page.act('key:hero_headline');
      await page.settle();
      await page.type('text:hero_headline', 'In place');
      await wait(150);
      await page.act('save');
      const before = agent.locates().length;
      await wait(3_200);
      const check = agent.locates().slice(before).find((m) => JSON.stringify(m['texts']) === JSON.stringify(['In place']));
      // The check is flagged, so the agent looks again once a page that rendered late has gone quiet (F90).
      expect(check).toMatchObject({ draft: null, check: true });
      page.dom.window.close();
    }, 10_000);

    it('shows a list’s draft after Save, before any reply and after one', async () => {
      const page = await paint({ preview: DEV_PREVIEW });
      const agent = agentOf(page);
      await agent.load();
      await agent.ready();
      await page.act('key:hero_bullets');
      await page.type('list:hero_bullets 0', 'uno');
      await wait(150);
      expect(note(page).textContent).toBe('This draft is shown after Save.');
      expect(agent.locates().at(-1)).toMatchObject({ key: 'hero_bullets', draft: null, texts: ['one', 'two'] });
      agent.say(LOCATED({ key: 'hero_bullets', draft: null, seq: agent.locates().at(-1)?.['seq'] }));
      await page.settle();
      expect(note(page).textContent).toBe('This draft is shown after Save.');
      page.dom.window.close();
    });

    // --- add-preview-editing D8: the frame's messages, the pinned locale, the popover, the badge ---
    describe('the bridge (D8)', () => {
      const RECT = { left: 100, top: 50, width: 200, height: 20 };
      type State = {
        draft: Record<string, unknown>;
        base: Record<string, unknown> | null;
        edit: Record<string, unknown> | null;
        snapshot: Record<string, Record<string, unknown>>;
      };
      /** The page's own state, read in its global scope: the drafts, their bases, the open edit and the snapshot it holds. */
      const stateOf = (page: Painted): State =>
        JSON.parse(
          (page.dom.window as unknown as { eval: (code: string) => string }).eval(
            'JSON.stringify({ draft: S.draft, base: S.base === undefined ? null : S.base, edit: S.edit === undefined ? null : S.edit, snapshot: S.site.snapshot })',
          ),
        ) as State;
      /** The page over the dev pane, its agent announced. */
      async function bridged(over: Parameters<typeof paint>[0] = {}) {
        const page = await paint({ preview: DEV_PREVIEW, ...over });
        const agent = agentOf(page);
        await agent.load();
        await agent.ready();
        return { page, agent };
      }
      const byId = (page: Painted, id: string): HTMLElement => docOf(page).getElementById(id) as HTMLElement;
      const popover = (page: Painted): HTMLElement => byId(page, 'popover');
      const poptext = (page: Painted): HTMLTextAreaElement => byId(page, 'poptext') as HTMLTextAreaElement;
      const lines = (page: Painted): string[] => [...note(page).children].map((line) => line.textContent ?? '');
      /** The note's last line where the open page's reads are incomplete or failed (8o D2). */
      const UNKNOWN = 'stet could not work out which keys this page reads, so any text that matches a key can be picked.';
      const selected = (page: Painted): string => docOf(page).querySelector('#main .ch h3 .mono')?.textContent ?? '';
      const typeInto = async (page: Painted, field: HTMLTextAreaElement, value: string): Promise<void> => {
        field.value = value;
        field.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
        await page.settle();
      };
      const press = async (page: Painted, field: HTMLElement, key: string): Promise<void> => {
        field.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        await page.settle();
      };
      const THREE = siteBody({ snapshot: { ...snapshot, default: { ...snapshot.default, hero_bullets: ['one', 'two', 'three'] } } });
      /** The fixture with a 40-character advisory key whose value holds a `{{name}}` token. */
      const GREETING = siteBody({
        descriptor: {
          ...descriptor,
          keys: {
            ...descriptor.keys,
            lab_greeting: { shape: 'text', target: 'web', limits: { max: 40, severity: 'advisory' } },
            lab_tagged: { shape: 'text', target: 'web', tags: 1, limits: { max: 20, severity: 'hard' } },
          },
        },
        snapshot: {
          ...snapshot,
          default: { ...snapshot.default, hero_bullets: ['one', 'two', 'three'], lab_greeting: 'Welcome back, {{name}}.', lab_tagged: 'Ship <1>it</1> now' },
        },
      });

      // 7.1 — the values
      it('writes a typed list entry into that entry alone (7.1)', async () => {
        const { page, agent } = await bridged({ site: THREE });
        await agent.pick([{ key: 'hero_bullets', entry: 2 }], { again: true, tag: 'li' });
        expect(agent.sent('edit').at(-1)).toEqual({ stet: 'edit', key: 'hero_bullets', locale: 'default', entry: 2, form: 'inplace', oneLine: true });
        await agent.typed('hero_bullets', 'tres', { entry: 2 });
        expect(stateOf(page).draft).toEqual({ 'default hero_bullets': ['one', 'two', 'tres'] });
        expect(page.html()).toContain('1 unsaved edit');
        page.dom.window.close();
      });

      it('Discard all ends an open edit, so its end does not bring the discarded key back (F3)', async () => {
        const { page, agent } = await bridged();
        await page.act('key:hero_headline');
        await page.type('text:hero_headline', 'First words');
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'Second words');
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Second words' });
        await page.act('unsaved');
        await page.act('discardAll');
        expect(stateOf(page).draft).toEqual({});
        await agent.edited('hero_headline', 'cancel');
        expect(stateOf(page).draft).toEqual({});
        expect(stateOf(page).base).toEqual({});
        page.dom.window.close();
      });

      it('keeps no draft and no base for a value typed back to the stored one (7.1)', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'Ship it');
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Ship it' });
        expect(stateOf(page).base).toEqual({ 'default hero_headline': 'Ship the copy' });
        await agent.typed('hero_headline', 'Ship the copy');
        expect(stateOf(page).draft).toEqual({});
        expect(stateOf(page).base).toEqual({});
        page.dom.window.close();
      });

      it('drops the bases with the drafts a save writes (7.1: every draft removal clears its base)', async () => {
        const page = await paint();
        page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] });
        await page.act('key:hero_headline');
        await page.type('text:hero_headline', 'Saved words');
        expect(stateOf(page).base).toEqual({ 'default hero_headline': 'Ship the copy' });
        await page.act('save');
        expect(stateOf(page).draft).toEqual({});
        expect(stateOf(page).base).toEqual({});
        page.dom.window.close();
      });

      // 7.2 — the frame message arms
      it('takes a typed value only for the open edit’s key, locale and entry (7.2)', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'Mine');
        await agent.typed('loose_key', 'Forged');
        await agent.typed('hero_headline', 'Forged in de', { locale: 'de' });
        await agent.typed('hero_headline', 'Forged entry', { entry: 0 });
        await agent.typed('hero_headline', 7);
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Mine' });
        // An end for another key or another locale is not this edit's.
        await agent.edited('loose_key', 'cancel');
        await agent.edited('hero_headline', 'lost', { locale: 'de', proposed: false });
        expect(stateOf(page).edit).toMatchObject({ key: 'hero_headline', locale: 'default' });
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Mine' });
        page.dom.window.close();
      });

      it('puts back the value from before the edit on cancel, and keeps no draft for an edit lost before any proposal (7.2)', async () => {
        const { page, agent } = await bridged();
        await page.act('key:hero_headline');
        await page.type('text:hero_headline', 'Before');
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'During');
        await agent.edited('hero_headline', 'cancel');
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Before' });
        expect(stateOf(page).edit).toBeNull();

        await agent.pick([{ key: 'loose_key' }], { again: true, tag: 'p' });
        await agent.typed('loose_key', 'Typed');
        await agent.edited('loose_key', 'lost', { proposed: false });
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Before' });
        expect(stateOf(page).edit).toBeNull();
        expect(popover(page).hidden).toBe(false);
        expect(poptext(page).value).toBe('loose');
        expect(lines(page)).toContain('The page redrew this text, so the edit moved to a field.');
        page.dom.window.close();
      });

      it('R15: a double click’s selected word is selected in the field over the frame, so typing replaces it', async () => {
        const { page, agent } = await bridged({ site: GREETING });
        const greeting = { key: 'lab_greeting', by: 'pattern', inplace: false };
        const range = (): [number, number] => [poptext(page).selectionStart, poptext(page).selectionEnd];
        // 'Welcome back, {{name}}.': the word occurs once.
        await agent.pick([greeting], { again: true, sel: { text: 'back', offset: 8 } });
        expect(range()).toEqual([8, 12]);
        await typeInto(page, poptext(page), 'to be or not to be');
        await press(page, poptext(page), 'Enter');
        // Several occurrences: the one nearest where the word sat in the element.
        await agent.pick([greeting], { again: true, sel: { text: 'be', offset: 14 } });
        expect(range()).toEqual([16, 18]);
        await press(page, poptext(page), 'Enter');
        await agent.pick([greeting], { again: true, sel: { text: 'be', offset: 2 } });
        expect(range()).toEqual([3, 5]);
        await press(page, poptext(page), 'Enter');
        // A trailing space the browser selected with the word is not part of it.
        await agent.pick([greeting], { again: true, sel: { text: 'be\n', offset: 14 } });
        expect(range()).toEqual([16, 18]);
        await press(page, poptext(page), 'Enter');
        // Not in the value, or no selection: the caret at the end.
        await agent.pick([greeting], { again: true, sel: { text: 'missing', offset: 0 } });
        expect(range()).toEqual([18, 18]);
        await press(page, poptext(page), 'Enter');
        await agent.pick([greeting], { again: true });
        expect(range()).toEqual([18, 18]);
        page.dom.window.close();
      });

      it('R15: a word the value holds twice is selected at the ordinal it had in the element, tokens in the value or not', async () => {
        const { page, agent } = await bridged({ site: GREETING });
        const greeting = { key: 'lab_greeting', by: 'pattern', inplace: false };
        const range = (): [number, number] => [poptext(page).selectionStart, poptext(page).selectionEnd];
        await agent.pick([greeting], { again: true });
        await typeInto(page, poptext(page), '{{count}} items and {{count}} items');
        await press(page, poptext(page), 'Enter');
        // The element shows '12 items and 12 items': its offsets drift from the value's.
        await agent.pick([greeting], { again: true, sel: { text: 'items', offset: 16, nth: 1 } });
        expect(range()).toEqual([30, 35]);
        await press(page, poptext(page), 'Enter');
        await agent.pick([greeting], { again: true, sel: { text: 'items', offset: 3, nth: 0 } });
        expect(range()).toEqual([10, 15]);
        await press(page, poptext(page), 'Enter');
        // An ordinal the value does not reach falls back to the nearest occurrence.
        await agent.pick([greeting], { again: true, sel: { text: 'items', offset: 28, nth: 5 } });
        expect(range()).toEqual([30, 35]);
        page.dom.window.close();
      });

      it('R15: a word selected in the element’s text is not looked for in an attribute’s value; the caret goes to the end', async () => {
        const { page, agent } = await bridged({ site: GREETING });
        const attr = { key: 'lab_greeting', by: 'attr', inplace: false, attr: 'alt' };
        await agent.pick([attr], { again: true, sel: { text: 'back', offset: 8, nth: 0 } });
        const value = poptext(page).value;
        expect(value).toContain('back');
        expect([poptext(page).selectionStart, poptext(page).selectionEnd]).toEqual([value.length, value.length]);
        page.dom.window.close();
      });

      it('R15: the word selected by a double click survives the chooser of two keys', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }, { key: 'loose_key' }], { again: true, sel: { text: 'oo', offset: 1 } });
        await page.act('choose:loose_key');
        expect([poptext(page).selectionStart, poptext(page).selectionEnd]).toEqual([1, 3]);
        page.dom.window.close();
      });

      it('R14: a click in the frame on no key’s copy ends the selection as Escape does: the edit box closes, unsaved edits stay, the ring goes', async () => {
        const { page, agent } = await bridged({ site: GREETING });
        await agent.pick([{ key: 'lab_greeting', by: 'pattern', inplace: false }], { again: true });
        await typeInto(page, poptext(page), 'Welcome, {{name}}.');
        expect(popover(page).hidden).toBe(false);
        const clears = agent.sent('clear').length;
        await agent.tell({ stet: 'deselect' });
        expect(popover(page).hidden).toBe(true);
        expect(selected(page)).toBe('');
        expect(stateOf(page).draft).toEqual({ 'default lab_greeting': 'Welcome, {{name}}.' });
        expect(agent.sent('clear').length).toBeGreaterThan(clears);
        page.dom.window.close();
      });

      it('R14: deselect, then unmanaged, keeps the note for text no key matches; deselect alone takes an earlier note away', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }]);
        expect(selected(page)).toBe('hero_headline');
        await agent.tell({ stet: 'deselect' });
        await agent.tell({ stet: 'unmanaged', text: 'Docs', tag: 'a' });
        expect(selected(page)).toBe('');
        expect(lines(page)[0]).toBe('No key matches this text.');
        await agent.tell({ stet: 'deselect' });
        expect(lines(page)).not.toContain('No key matches this text.');
        page.dom.window.close();
      });

      it('starts an in-place edit on a second pick under the selector’s locale, and ends an open edit before a pick of another key (7.2)', async () => {
        const { page, agent } = await bridged();
        await page.change('locale', 'de');
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        expect(agent.sent('edit').at(-1)).toEqual({ stet: 'edit', key: 'hero_headline', locale: 'de', form: 'inplace', oneLine: true });
        expect(stateOf(page).edit).toMatchObject({ key: 'hero_headline', locale: 'de' });
        const at = agent.posts.length;
        await agent.pick([{ key: 'loose_key' }], { tag: 'p' });
        expect(agent.posts[at]?.message).toEqual({ stet: 'end', how: 'keep' });
        expect(selected(page)).toBe('loose_key');
        page.dom.window.close();
      });

      it('starts no edit and no popover for an entry the key’s value lacks (7.2)', async () => {
        const { page, agent } = await bridged({ site: THREE });
        const cases: Array<[string, number | string]> = [
          ['hero_bullets', 5], ['hero_bullets', 1.5], ['hero_bullets', -1], ['hero_bullets', '1'],
          ['hero_card', 'constructor'], ['hero_headline', 0], ['hero_headline', 'title'],
        ];
        for (const [key, entry] of cases) {
          await agent.pick([{ key, entry }], { again: true });
          await agent.pick([{ key, entry, attr: 'alt', by: 'attr', inplace: false }], { again: true });
          expect(agent.sent('edit'), `${key} ${entry}`).toEqual([]);
          expect(popover(page).hidden, `${key} ${entry}`).toBe(true);
          expect(selected(page), `${key} ${entry}`).toBe(key);
        }
        page.dom.window.close();
      });

      // 7.3 — the pinned locale
      it('F3: keeps an edit’s draft under its own locale across a locale switch, and ends the edit (7.3)', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'Ship it');
        const at = agent.posts.length;
        await page.change('locale', 'de');
        await agent.typed('hero_headline', 'Ship it now');
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Ship it' });
        expect(stateOf(page).edit).toBeNull();
        expect(agent.posts.slice(at).map((p) => p.message)).toContainEqual({ stet: 'end', how: 'keep' });
        page.dom.window.close();
      });

      // 7.4 — condition 1
      it('lets go of the remembered field when the frame takes focus, so a repaint leaves focus in the frame (7.4)', async () => {
        const { page, agent } = await bridged();
        const route = byId(page, 'route') as HTMLInputElement;
        route.focus();
        // Focus moving into a frame fires no focusin on the dashboard's side, as in a browser.
        const frame = agent.frame();
        page.dom.window.addEventListener('focusin', (event) => { if (event.target === frame) event.stopImmediatePropagation(); }, true);
        frame.focus();
        expect(docOf(page).activeElement).toBe(frame);
        page.dom.window.dispatchEvent(new page.dom.window.FocusEvent('blur'));
        let pulled = 0;
        route.addEventListener('focus', () => { pulled += 1; });
        await page.act('keys');
        await page.act('keys');
        expect(pulled).toBe(0);
        page.dom.window.close();
      });

      // 7.5 — the popover and the counter
      it('opens the popover under the element’s box at the dashboard’s scale with the raw value; Enter keeps it, Esc puts it back (7.5)', async () => {
        const { page, agent } = await bridged({ site: GREETING });
        const frame = agent.frame();
        // The frame renders at 1280 px, scaled to 640 in a pane that starts 500 px from the left.
        Object.defineProperty(frame, 'offsetWidth', { configurable: true, get: () => 1280 });
        frame.getBoundingClientRect = () => ({ left: 500, top: 100, width: 640, height: 400, right: 1140, bottom: 500, x: 500, y: 100, toJSON: () => ({}) }) as DOMRect;
        const greeting = { key: 'lab_greeting', by: 'pattern', inplace: false };
        await agent.pick([greeting], { again: true, rect: { left: 100, top: 60, width: 300, height: 20 } });
        expect(agent.sent('edit')).toEqual([]);
        expect(popover(page).hidden).toBe(false);
        expect(poptext(page).value).toBe('Welcome back, {{name}}.');
        expect(byId(page, 'popkey').textContent).toBe('lab_greeting');
        expect(byId(page, 'popcount').textContent).toBe('23 / 40');
        expect(popover(page).textContent).toContain('Enter keeps it · Esc puts it back');
        expect([popover(page).style.left, popover(page).style.top]).toEqual(['550px', '146px']);
        await typeInto(page, poptext(page), 'Welcome, {{name}}.');
        expect(stateOf(page).draft).toEqual({ 'default lab_greeting': 'Welcome, {{name}}.' });
        await press(page, poptext(page), 'Enter');
        expect(popover(page).hidden).toBe(true);
        expect(stateOf(page).draft).toEqual({ 'default lab_greeting': 'Welcome, {{name}}.' });

        // Kept inside the window: clamped at the right edge, flipped above a box near the bottom.
        await agent.pick([greeting], { again: true, rect: { left: 1200, top: 1300, width: 300, height: 20 } });
        expect([popover(page).style.left, popover(page).style.top]).toEqual(['1016px', '744px']);
        expect(poptext(page).value).toBe('Welcome, {{name}}.');
        await typeInto(page, poptext(page), 'Gone');
        await press(page, poptext(page), 'Escape');
        expect(popover(page).hidden).toBe(true);
        expect(stateOf(page).draft).toEqual({ 'default lab_greeting': 'Welcome, {{name}}.' });
        page.dom.window.close();
      });

      it('colours the counter grey, amber from 90 % and red past the limit saying what Save does, and counts a list entry alone (7.5)', async () => {
        const { page, agent } = await bridged({ site: GREETING });
        const count = (id = 'popcount'): [string, string] => [byId(page, id).textContent ?? '', byId(page, id).className];
        await agent.pick([{ key: 'lab_greeting', by: 'pattern', inplace: false }], { again: true });
        await typeInto(page, poptext(page), 'x'.repeat(32));
        expect(count()).toEqual(['32 / 40', 'cnt']);
        await typeInto(page, poptext(page), 'x'.repeat(35));
        expect(count()).toEqual(['35 / 40', 'cnt']);
        await typeInto(page, poptext(page), 'x'.repeat(36));
        expect(count()).toEqual(['36 / 40', 'cnt amb']);
        await typeInto(page, poptext(page), 'x'.repeat(40));
        expect(count()).toEqual(['40 / 40', 'cnt amb']);
        await typeInto(page, poptext(page), 'x'.repeat(41));
        expect(count()).toEqual(['41 / 40 · Save asks first', 'cnt bad']);
        await press(page, poptext(page), 'Enter');

        await agent.pick([{ key: 'hero_bullets', entry: 2, by: 'contained', inplace: false }], { again: true, tag: 'li' });
        expect(byId(page, 'popkey').textContent).toBe('hero_bullets[2]');
        expect(poptext(page).value).toBe('three');
        expect(count()).toEqual(['5 / 40', 'cnt']);
        await typeInto(page, poptext(page), 'y'.repeat(41));
        expect(count()).toEqual(['41 / 40 · Save refuses this', 'cnt bad']);
        expect(stateOf(page).draft['default hero_bullets']).toEqual(['one', 'two', 'y'.repeat(41)]);
        await press(page, poptext(page), 'Enter');

        // A tagged value counts its plain text.
        await agent.pick([{ key: 'lab_tagged', by: 'element', inplace: false }], { again: true });
        expect(poptext(page).value).toBe('Ship <1>it</1> now');
        expect(count()).toEqual(['11 / 20', 'cnt']);
        await press(page, poptext(page), 'Enter');

        // Typing in place: the counter sits by the element.
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'x'.repeat(54));
        expect(byId(page, 'counter').hidden).toBe(false);
        expect(count('counter')).toEqual(['54 / 60', 'cnt amb']);
        await agent.edited('hero_headline', 'keep');
        expect(byId(page, 'counter').hidden).toBe(true);
        page.dom.window.close();
      });

      it('opens no popover under 760 px: a pick selects, and a second pick focuses the field and scrolls it into view (7.5)', async () => {
        const scrolled: string[] = [];
        const { page, agent } = await bridged({
          site: GREETING,
          prepare: (window) => {
            Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 500 });
            (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: HTMLElement) {
              scrolled.push(this.getAttribute('data-act-input') ?? '');
            };
          },
        });
        await agent.pick([{ key: 'hero_headline' }]);
        expect(selected(page)).toBe('hero_headline');
        expect(scrolled).toEqual([]);
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        expect(scrolled).toEqual(['text:hero_headline']);
        expect(agent.sent('edit')).toEqual([]);
        expect(popover(page).hidden).toBe(true);
        expect(docOf(page).activeElement?.getAttribute('data-act-input')).toBe('text:hero_headline');
        await agent.pick([{ key: 'lab_greeting', by: 'pattern', inplace: false }], { again: true });
        expect(popover(page).hidden).toBe(true);
        expect(docOf(page).activeElement?.getAttribute('data-act-input')).toBe('text:lab_greeting');
        page.dom.window.close();
      });

      // 7.6 — the hover label, the chooser, unmanaged text, shared spots, the route warning, Page info, moved
      it('answers text no key matches with the keys the route reads that the census did not find (7.6, journey B23)', async () => {
        const nav = {
          ...descriptor,
          keys: { ...descriptor.keys, nav_link: { shape: 'text', target: 'web' }, nav_button_text: { shape: 'text', target: 'web' } },
        } as Descriptor;
        const { page, agent } = await bridged({
          site: siteBody({ descriptor: nav, snapshot: { ...snapshot, default: { ...snapshot.default, nav_link: 'Docs', nav_button_text: 'Start' } } }),
          routes: [['/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['hero_headline', 'nav_button_text', 'nav_link'], complete: true }]],
        });
        await agent.census({ found: { hero_headline: 1 } });
        await agent.tell({ stet: 'unmanaged', text: 'Docs Start', tag: 'a' });
        expect(lines(page)).toEqual(['No key matches this text.', 'Keys this page reads that were not found: nav_link, nav_button_text.']);
        expect(note(page).textContent).not.toContain('unmanaged');
        // Every key the route reads was found: the first line alone.
        await agent.census({ found: { hero_headline: 1, nav_link: 1, nav_button_text: 1 } });
        expect(lines(page)).toEqual(['No key matches this text.']);
        page.dom.window.close();
      });

      it('shows a chooser for words two keys share, and selects the key chosen (7.6, journey B23)', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }, { key: 'loose_key' }]);
        const box = byId(page, 'panepick');
        expect(box.hidden).toBe(false);
        expect(box.textContent).toContain('Two keys show these words. Which one?');
        expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['hero_headline', 'loose_key']);
        await page.act('choose:loose_key');
        expect(selected(page)).toBe('loose_key');
        expect(box.hidden).toBe(true);
        page.dom.window.close();
      });

      it('names a key’s other spots on hover and in the editor header (7.6, journey B23)', async () => {
        const { page, agent } = await bridged({
          routes: [['/api/site/marks', 200, {
            documents: [],
            keys: {},
            places: {
              hero_headline: [
                { file: 'app/(app)/inbox/page.tsx', line: 9, kind: 'headline', tag: 'h1' },
                { file: 'components/AppShell.tsx', line: 12, kind: 'text in components/AppShell.tsx' },
              ],
            },
          }]],
        });
        await agent.census({ found: { hero_headline: 2, loose_key: 2 } });
        const label = byId(page, 'hoverlabel');
        await agent.tell({ stet: 'hover', keys: [{ key: 'hero_headline', attr: null, by: 'whole' }], tag: 'a', rect: RECT, inplace: true });
        expect(label.hidden).toBe(false);
        expect([...label.children].map((line) => line.textContent)).toEqual(['link text · hero_headline', 'also in app/(app)/inbox/page.tsx:9']);
        await agent.tell({ stet: 'hover', keys: [{ key: 'loose_key', attr: 'aria-label', by: 'attr' }], tag: 'button', rect: RECT, inplace: false });
        expect([...label.children].map((line) => line.textContent)).toEqual(['aria label · loose_key', 'also on 1 other spot']);
        await agent.tell({ stet: 'hover', keys: [] });
        expect(label.hidden).toBe(true);
        await agent.pick([{ key: 'hero_headline' }]);
        expect(byId(page, 'shared').textContent).toBe('Shown in 2 places on this page · app/(app)/inbox/page.tsx:9 · components/AppShell.tsx:12');
        await agent.pick([{ key: 'seo_home_title' }]);
        expect(byId(page, 'shared').textContent).toBe('');
        page.dom.window.close();
      });

      it('F7: names the other place of a key on hover when both places are the same kind, never the hovered one (7.6)', async () => {
        const { page, agent } = await bridged({
          routes: [['/api/site/marks', 200, {
            documents: [],
            keys: {},
            places: {
              hero_headline: [
                { file: 'app/a/page.tsx', line: 3, kind: 'headline', tag: 'h1' },
                { file: 'app/b/page.tsx', line: 8, kind: 'headline', tag: 'h1' },
              ],
            },
          }]],
        });
        const label = byId(page, 'hoverlabel');
        await agent.tell({ stet: 'hover', keys: [{ key: 'hero_headline', attr: null, by: 'whole' }], tag: 'h1', rect: RECT, inplace: true });
        const shown = [...label.children].map((line) => line.textContent);
        expect(shown).toEqual(['headline · hero_headline', 'also in app/b/page.tsx:8']);
        page.dom.window.close();
      });

      it('warns where a key found by its text is read by no file of a fully read route, and nowhere else (7.6, journey B23)', async () => {
        const WARN = 'This text matches hero_headline, but no file on this page reads that key — saving may not change it.';
        const { page, agent } = await bridged({
          routes: [['/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['loose_key'], complete: true }]],
        });
        await agent.pick([{ key: 'hero_headline', by: 'whole' }]);
        expect(lines(page)).toContain(WARN);
        expect(agent.locates().at(-1)).toMatchObject({ key: 'hero_headline', guess: true });
        await agent.pick([{ key: 'hero_headline', by: 'mark' }]);
        expect(lines(page)).not.toContain(WARN);
        await agent.pick([{ key: 'loose_key', by: 'contained', inplace: false }]);
        expect(lines(page).join(' ')).not.toContain('but no file on this page reads');
        // A route whose reads are incomplete never warns.
        page.answer('/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['loose_key'], complete: false });
        await page.act('previewLoad');
        await agent.load();
        await agent.ready();
        await agent.pick([{ key: 'hero_headline', by: 'whole' }]);
        expect(lines(page)).not.toContain(WARN);
        page.dom.window.close();
      });

      it('lists the census’s head keys under Page info, with the search result and the share card (7.6, journey B26)', async () => {
        const { page, agent } = await bridged();
        await agent.census({ found: { seo_home_title: 1, loose_key: 1 }, head: [{ key: 'seo_home_title', where: 'title' }, { key: 'loose_key', where: 'description' }] });
        await page.act('pageInfo');
        const info = byId(page, 'paneinfo');
        expect(info.hidden).toBe(false);
        expect([...info.querySelectorAll('.hl')].map((line) => line.textContent)).toEqual(['page title · seo_home_title', 'meta description · loose_key']);
        expect([...info.querySelectorAll('.serp > div')].map((part) => part.textContent)).toEqual(['Search result', '/', 'Home', 'loose']);
        await page.act('pageInfo');
        expect(info.hidden).toBe(true);
        page.dom.window.close();
      });

      it('names the app’s own navigation beside the route field, keeps the route, and reads the new route’s files (7.6)', async () => {
        const { page, agent } = await bridged();
        await agent.moved('/pricing?plan=pro');
        expect(byId(page, 'panemoved').textContent).toBe('The app moved to /pricing?plan=pro');
        expect((byId(page, 'route') as HTMLInputElement).value).toBe('/');
        expect(page.requested('/api/site/route-reads').at(-1)).toContain('route=%2Fpricing');
        page.dom.window.close();
      });

      it('names a hovered element’s kind as the marks route does (the kind parity table, an addition)', () => {
        const source = /const ELEMENT_KINDS = [\s\S]*?\nfunction elementKind\([\s\S]*?\n\}/.exec(dashboardPage())?.[0];
        expect(source).toBeDefined();
        const elementKind = new Function(`${source as string}; return elementKind;`)() as (tag: string, attr: string | null) => string;
        const rows: Array<[string, string | undefined]> = [
          ['h1', undefined], ['h6', undefined], ['p', undefined], ['a', undefined], ['button', undefined], ['label', undefined],
          ['li', undefined], ['summary', undefined], ['span', undefined], ['constructor', undefined], ['img', 'alt'],
          ['button', 'aria-label'], ['div', 'title'], ['input', 'placeholder'], ['div', 'data-x'],
        ];
        const mismatches = rows
          .map(([tag, attr]) => [tag, attr, elementKind(tag, attr ?? null), kindOf({ file: 'x', line: 1, tag, ...(attr === undefined ? {} : { attr }) })])
          .filter(([, , page, core]) => page !== core);
        expect(mismatches).toEqual([]);
      });

      it('says nothing of a key missing from the page while it is typed in place (the C5 flag, an addition)', async () => {
        const { page, agent } = await bridged();
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'Typed in place');
        await wait(150);
        agent.say(LOCATED({ found: 0, seq: agent.locates().at(-1)?.['seq'] }));
        await page.settle();
        expect(note(page).textContent).not.toContain('was not found');
        await agent.edited('hero_headline', 'keep');
        agent.say(LOCATED({ found: 0, seq: agent.locates().at(-1)?.['seq'] }));
        await page.settle();
        expect(note(page).textContent).toContain('hero_headline was not found on /.');
        page.dom.window.close();
      });

      it('says where a key the census found only in the head sits (the C5 flag, an addition)', async () => {
        // The route's reads answer complete, so no line that stet cannot tell follows the head line.
        const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['loose_key'], complete: true }]] });
        await agent.census({ found: { loose_key: 1 }, head: [{ key: 'loose_key', where: 'description' }] });
        await page.change('group', 'prefix:loose');
        await page.act('key:loose_key');
        expect(lines(page)).toEqual(['loose_key appears as the meta description, under the title in search results. It is not part of the page’s visible text.']);
        page.dom.window.close();
      });

      // 7.7 — the badge
      describe('the unread-key badge (7.7)', () => {
        const PAGES = { home: { route: '/' }, a: { route: '/a' }, b: { route: '/b/' }, c: { route: '/c' }, d: { route: '/d' }, post: { route: '/blog/[slug]' } };
        const BADGED: Descriptor = {
          version: 1,
          keys: {
            lone_key: { shape: 'text', target: 'web' },
            mail_key: { shape: 'text', target: 'html-email' },
            server_key: { shape: 'text', target: 'web' },
            home_key: { shape: 'text', target: 'web', pages: ['home'] },
            tier_solo_name: { shape: 'text', target: 'web' },
            blind_key: { shape: 'text', target: 'web' },
          },
          pages: PAGES,
        };
        const VALUES = { lone_key: 'Lone words', mail_key: 'Mail words', server_key: 'Server words', home_key: 'Home words', tier_solo_name: 'Solo', blind_key: 'Blind' };
        const usageOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
          keys: { lone_key: { state: 'not_found' }, mail_key: { state: 'not_found' }, server_key: { state: 'not_found' }, home_key: { state: 'read' } },
          prefixes: [],
          causes: [],
          serverOnly: ['server_key'],
          files: 55,
          root: 'site/',
          ...over,
        });
        const COMPLETE = { route: '/', files: [], keys: [], complete: true };
        /** Every route's reads answer complete unless `routes` says otherwise. */
        const badged = (usage: Record<string, unknown>, d: Descriptor = BADGED, routes: Array<[string, number, unknown]> = []) =>
          bridged({
            site: siteBody({ descriptor: d, snapshot: { default: VALUES } }),
            routes: [['/api/site/usage', 200, usage], ['/api/site/route-reads', 200, COMPLETE], ...routes],
          });
        const SCOPE = 'not found in any file stet searched (55 files in site/)';
        const badges = async (page: Painted, id: string): Promise<string[]> => {
          await page.type('search', '_');
          return [...(docOf(page).querySelector(`[data-act="key:${id}"]`)?.querySelectorAll('.bdg') ?? [])].map((b) => b.textContent ?? '');
        };
        const noteOf = async (page: Painted, id: string): Promise<string[]> => {
          await page.type('search', '_');
          await page.act(`key:${id}`);
          return lines(page);
        };
        const visit = async (agent: ReturnType<typeof agentOf>, routes: string[], found: Record<string, number> = {}): Promise<void> => {
          for (const route of routes) {
            await agent.moved(route);
            await agent.census({ route, found });
          }
        };

        it('says how many pages are not yet checked (key-usage: pages not yet checked)', async () => {
          const { page, agent } = await badged(usageOf());
          await visit(agent, ['/', '/a']);
          expect(await badges(page, 'lone_key')).toContain(SCOPE);
          expect(await noteOf(page, 'lone_key')).toEqual([SCOPE, '3 of 5 pages not yet checked']);
          page.dom.window.close();
        });

        it('upgrades to may be a leftover once every page is visited, never for an email or server-only key (key-usage: the upgrade)', async () => {
          const { page, agent } = await badged(usageOf());
          await visit(agent, ['/', '/a', '/b/', '/c', '/d']);
          expect(await badges(page, 'lone_key')).toContain('may be a leftover');
          expect(await noteOf(page, 'lone_key')).toEqual(['may be a leftover']);
          expect(await badges(page, 'mail_key')).toContain(SCOPE);
          expect(await noteOf(page, 'mail_key')).toEqual([SCOPE]);
          expect(await noteOf(page, 'server_key')).toEqual([SCOPE]);
          page.dom.window.close();
        });

        it('keeps the scan’s wording for a key a visited page showed, and before any page is visited (key-usage: a sibling package’s read)', async () => {
          const { page, agent } = await badged(usageOf());
          expect(await noteOf(page, 'lone_key')).toEqual([SCOPE, '5 of 5 pages not yet checked']);
          await visit(agent, ['/', '/a', '/b', '/c'], {});
          await visit(agent, ['/d'], { lone_key: 1 });
          expect(await noteOf(page, 'lone_key')).toEqual([SCOPE]);
          expect(await badges(page, 'lone_key')).not.toContain('may be a leftover');
          page.dom.window.close();
        });

        it('never upgrades on a site with no page list', async () => {
          const { page } = await badged(usageOf(), { ...BADGED, pages: {} });
          expect(await badges(page, 'lone_key')).toContain(SCOPE);
          expect(await noteOf(page, 'lone_key')).toEqual([SCOPE]);
          page.dom.window.close();
        });

        it('counts a page whose route reads are incomplete as not yet checked', async () => {
          const { page, agent } = await badged(usageOf(), BADGED, [['/api/site/route-reads', 200, { route: '/a', files: [], keys: [], complete: false }]]);
          await visit(agent, ['/', '/a', '/b/', '/c', '/d']);
          expect(await noteOf(page, 'lone_key')).toEqual([SCOPE, '5 of 5 pages not yet checked', UNKNOWN]);
          page.dom.window.close();
        });

        it('reads unknown under a learnt prefix or the site line, the line naming three causes and the rest as a count', async () => {
          const causes = [
            { text: 'copy(a)', file: 'a.ts', line: 1 },
            { text: 'copy(b)', file: 'b.ts', line: 2 },
            { text: 'copy(c)', file: 'c.ts', line: 3 },
            { text: 'fn(copy)', file: 'd.ts', line: 4 },
          ];
          const LINE = 'This site reads some keys in ways stet cannot follow, so it cannot say which keys are unread: ' +
            'copy(a) at a.ts:1, copy(b) at b.ts:2, copy(c) at c.ts:3 and 1 more';
          const { page } = await badged(usageOf({
            keys: { tier_solo_name: { state: 'unknown', prefix: { prefix: 'tier_', file: 'src/pricing.ts', line: 4 } }, blind_key: { state: 'unknown' } },
            prefixes: [{ prefix: 'tier_', file: 'src/pricing.ts', line: 4 }],
            causes,
          }));
          expect(byId(page, 'siteline').textContent).toBe(LINE);
          expect(await badges(page, 'tier_solo_name')).toContain('unknown');
          expect(await noteOf(page, 'tier_solo_name')).toEqual([
            'tier_solo_name starts with tier_, which src/pricing.ts:4 reads without naming each key, so whether it is read is unknown.',
            'Key prefixes read without naming each key: tier_ (src/pricing.ts:4)',
          ]);
          expect(await noteOf(page, 'blind_key')).toEqual([LINE, 'Key prefixes read without naming each key: tier_ (src/pricing.ts:4)']);
          expect(docOf(page).getElementById('shell')?.textContent).not.toContain('can’t tell');
          expect(docOf(page).getElementById('shell')?.textContent).not.toContain("can't tell");
          page.dom.window.close();
        });

        /** A visit as the frame reports it: the app moves, the route's reads answer as `reads` says, the census follows. */
        const visitWith = async (
          page: Painted,
          agent: ReturnType<typeof agentOf>,
          route: string,
          reads: { status?: number; complete?: boolean; delay?: number } = {},
          shown = route,
        ): Promise<void> => {
          const status = reads.status ?? 200;
          page.answer('/api/site/route-reads', status, status >= 400 ? { error: 'x' } : { route, files: [], keys: [], complete: reads.complete ?? true }, reads.delay);
          await agent.moved(route);
          await agent.census({ route: shown, found: {} });
        };
        const AMONG_FIVE = [SCOPE, '1 of 5 pages not yet checked'];

        it('P8a: one incomplete route among five holds the upgrade until it is read again complete (key-usage: the upgrade)', async () => {
          const { page, agent } = await badged(usageOf());
          await visitWith(page, agent, '/');
          await visitWith(page, agent, '/a');
          expect(await noteOf(page, 'lone_key')).toEqual([SCOPE, '3 of 5 pages not yet checked']);
          await visitWith(page, agent, '/b/');
          await visitWith(page, agent, '/c', { complete: false });
          await visitWith(page, agent, '/d');
          expect(await noteOf(page, 'lone_key')).toEqual(AMONG_FIVE);
          expect(await badges(page, 'lone_key')).not.toContain('may be a leftover');
          await visitWith(page, agent, '/c', { complete: true });
          expect(await noteOf(page, 'lone_key')).toEqual(['may be a leftover']);
          expect(await badges(page, 'lone_key')).toContain('may be a leftover');
          expect(await noteOf(page, 'mail_key')).toEqual([SCOPE]);
          expect(await noteOf(page, 'server_key')).toEqual([SCOPE]);
          page.dom.window.close();
        });

        it('P8b: a query, a trailing slash and a route outside the list count the page they belong to, or none', async () => {
          const { page, agent } = await badged(usageOf());
          await visitWith(page, agent, '/');
          await visitWith(page, agent, '/a', {}, '/a?x=1');
          await visitWith(page, agent, '/b', {}, '/b');
          await visitWith(page, agent, '/c');
          await visitWith(page, agent, '/zzz');
          await visitWith(page, agent, '/blog/hello');
          expect(await noteOf(page, 'lone_key')).toEqual(AMONG_FIVE);
          page.dom.window.close();
        });

        it('P8c: a route whose reads fail (500) is not checked, and the badge never upgrades on it (D42)', async () => {
          const { page, agent } = await badged(usageOf());
          for (const route of ['/', '/a', '/b/', '/c']) await visitWith(page, agent, route);
          await visitWith(page, agent, '/d', { status: 500 });
          expect(await noteOf(page, 'lone_key')).toEqual([...AMONG_FIVE, UNKNOWN]);
          expect(await badges(page, 'lone_key')).not.toContain('may be a leftover');
          page.dom.window.close();
        });

        it('P8d: a census that lands before its page’s reads leaves the page unchecked until they answer complete (D42)', async () => {
          const { page, agent } = await badged(usageOf());
          for (const route of ['/', '/a', '/b/', '/c']) await visitWith(page, agent, route);
          // The last page's reads answer incomplete after 300 ms; its census arrives first.
          page.answer('/api/site/route-reads', 200, { route: '/d', files: [], keys: [], complete: false }, 300);
          await agent.census({ route: '/d', found: {} });
          expect(await noteOf(page, 'lone_key')).toEqual(AMONG_FIVE);
          await wait(500);
          await page.settle();
          expect(await noteOf(page, 'lone_key')).toEqual([...AMONG_FIVE, UNKNOWN]);

          // The same page, its reads slow but complete: unchecked until they answer, then the upgrade.
          const second = await badged(usageOf());
          for (const route of ['/', '/a', '/b/', '/c']) await visitWith(second.page, second.agent, route);
          second.page.answer('/api/site/route-reads', 200, { route: '/d', files: [], keys: [], complete: true }, 300);
          await second.agent.census({ route: '/d', found: {} });
          expect(await noteOf(second.page, 'lone_key')).toEqual(AMONG_FIVE);
          await wait(500);
          await second.page.settle();
          expect(await noteOf(second.page, 'lone_key')).toEqual(['may be a leftover']);
          page.dom.window.close();
          second.page.dom.window.close();
        });

        it('a page whose reads answered complete and later answer incomplete is unchecked again (D42)', async () => {
          const { page, agent } = await badged(usageOf());
          for (const route of ['/', '/a', '/b/', '/c', '/d']) await visitWith(page, agent, route);
          expect(await noteOf(page, 'lone_key')).toEqual(['may be a leftover']);
          await visitWith(page, agent, '/c', { complete: false });
          expect(await noteOf(page, 'lone_key')).toEqual([...AMONG_FIVE, UNKNOWN]);
          page.dom.window.close();
        });

        it('lists the learnt prefixes in the pane for any selected key, a key the scan found read among them (key-usage: the pane lists the learnt prefixes)', async () => {
          const { page } = await badged(usageOf({ prefixes: [{ prefix: 'tier_', file: 'src/pricing.ts', line: 4 }] }));
          expect(await noteOf(page, 'home_key')).toEqual(['Key prefixes read without naming each key: tier_ (src/pricing.ts:4)']);
          page.dom.window.close();
        });

        it('marks a key of the open route the census did not find as not shown on this page', async () => {
          const { page, agent } = await badged(usageOf());
          await agent.census({ route: '/', found: {} });
          expect(await badges(page, 'home_key')).toContain('not shown on this page');
          await agent.census({ route: '/', found: { home_key: 1 } });
          expect(await badges(page, 'home_key')).not.toContain('not shown on this page');
          page.dom.window.close();
        });
      });

      // 7.8 — the frame message boundary
      it('stage 5: a forged pick, typed and save from the frame writes nothing and moves focus to Save (7.8)', async () => {
        let saves = 0;
        const { page, agent } = await bridged({
          routes: [['/api/site/save', 200, () => { saves += 1; return { written: ['stet/defaults.json'], pending: ['stet/defaults.json'] }; }]],
        });
        // A pick naming a key the descriptor does not declare changes nothing.
        for (const key of ['constructor', 'nope']) {
          await agent.pick([{ key }], { again: true });
          expect(selected(page), key).toBe('');
          expect(agent.sent('edit'), key).toEqual([]);
          expect(popover(page).hidden, key).toBe(true);
        }
        await agent.pick([{ key: 'hero_headline' }], { again: true });
        await agent.typed('hero_headline', 'Forged words');
        await agent.typed('loose_key', 'Forged into another key');
        await agent.typed('hero_headline', 'Forged into another locale', { locale: 'de' });
        // Cmd/Ctrl-S pressed in the page: the frame holds focus.
        agent.frame().focus();
        await agent.key('save');
        await wait(150);
        expect(saves).toBe(0);
        expect(page.requested('/api/site/save')).toEqual([]);
        expect(docOf(page).activeElement).toBe(docOf(page).querySelector('#main [data-act="save"]'));
        expect(stateOf(page).draft).toEqual({ 'default hero_headline': 'Forged words' });
        expect(stateOf(page).snapshot['default']?.['hero_headline']).toBe('Ship the copy');
        page.dom.window.close();
      });

      // 7.8 — what the frame cannot do (D41), and the boundary probed from the other side
      it('D41: a forged key:save with a column field focused leaves the focus there, and the next Space saves nothing (7.8)', async () => {
        const { page, agent } = await bridged();
        await page.act('key:hero_headline');
        await page.type('text:hero_headline', 'Drafted');
        const field = docOf(page).querySelector('#main [data-act-input="text:hero_headline"]') as HTMLElement;
        const focused = (): string | null => docOf(page).activeElement?.getAttribute('data-act-input') ?? docOf(page).activeElement?.getAttribute('data-act') ?? null;
        field.focus();
        expect(focused()).toBe('text:hero_headline');
        await agent.key('save');
        expect(focused()).toBe('text:hero_headline');
        // A Space on a focused button presses it, as in a browser.
        const active = docOf(page).activeElement as HTMLElement;
        active.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        if (active.tagName === 'BUTTON') active.click();
        await page.settle();
        await wait(100);
        expect(page.requested('/api/site/save')).toEqual([]);
        page.dom.window.close();
      });

      describe('the frame message boundary, probed', () => {
        const dump = (page: Painted): string =>
          (page.dom.window as unknown as { eval: (code: string) => string }).eval(
            'JSON.stringify({draft:S.draft,base:S.base,edit:S.edit,sel:S.sel,mode:S.mode,moved:S.moved,census:S.census,hover:S.hover,popover:S.popover,unmanaged:S.unmanaged,choose:S.choose,warn:S.warn,locale:S.locale,seenKeys:[...S.seen.keys],seenRoutes:[...S.seen.routes],tmpl:S.tmpl})',
          );
        const writesOf = (page: Painted): string[] => page.sent.filter((r) => r.body !== undefined).map((r) => r.path);

        it('P2: prototype-chain keys and an empty key select nothing and edit nothing, in a pick, a hover, typed, edited and a census', async () => {
          const { page, agent } = await bridged({ site: THREE });
          const before = dump(page);
          for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '']) {
            await agent.pick([{ key }], { again: true });
            await agent.tell({ stet: 'hover', keys: [{ key, attr: null, by: 'whole' }], tag: 'p', rect: RECT, inplace: true });
            await agent.typed(key, 'X');
            await agent.edited(key, 'cancel');
          }
          const found = JSON.parse('{"__proto__":1,"constructor":2,"toString":3,"hero_headline":1}') as Record<string, number>;
          await agent.census({
            found,
            head: [{ key: 'constructor', where: 'title' }, { key: '__proto__', where: 'title' }, { key: 'hero_headline', where: '__proto__' }, { key: 'hero_headline', where: 'constructor' }],
          });
          const after = JSON.parse(dump(page)) as { census: { found: Record<string, number>; head: unknown[] }; seenKeys: string[] };
          expect(Object.keys(after.census.found)).toEqual(['hero_headline']);
          expect(after.census.head).toEqual([]);
          expect(after.seenKeys).toEqual(['hero_headline']);
          const was = JSON.parse(before) as Record<string, unknown>;
          const now = JSON.parse(dump(page)) as Record<string, unknown>;
          for (const field of ['draft', 'base', 'edit', 'sel', 'popover', 'choose', 'hover']) expect(now[field], field).toEqual(was[field]);
          expect(agent.sent('edit')).toEqual([]);
          expect(writesOf(page)).toEqual([]);
          expect(page.errors).toEqual([]);
          page.dom.window.close();
        });

        it('P7: nothing from a frame message is written as HTML', async () => {
          const { page, agent } = await bridged({
            routes: [['/api/site/route-reads', 200, { route: '/', files: [], keys: ['hero_headline'], complete: true }]],
          });
          const evil = '<img src=x onerror="window.__pwn=1"><svg onload="window.__pwn=2">';
          await agent.tell({ stet: 'hover', keys: [{ key: 'hero_headline', attr: evil, by: 'whole' }], tag: evil, rect: RECT, inplace: true });
          await agent.tell({ stet: 'unmanaged', text: evil, tag: evil });
          await agent.moved(evil);
          await agent.census({ route: evil, found: { hero_headline: 1 }, head: [{ key: 'hero_headline', where: 'title' }] });
          await agent.tell({ stet: 'pick', keys: [{ key: 'hero_headline', attr: null, by: evil, inplace: true }, { key: 'loose_key', attr: evil, by: evil }], tag: evil, rect: RECT, again: true });
          await page.act('pageInfo');
          await agent.pick([{ key: 'hero_headline', attr: evil, by: 'whole', inplace: false }], { again: true, tag: evil });
          await agent.tell({ stet: 'located', key: 'hero_headline', found: 0, by: evil, route: evil, hardcoded: false, redrawn: true });
          await agent.tell({ stet: 'edited', key: 'hero_headline', locale: 'default', how: 'lost', proposed: true });
          expect((page.dom.window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
          for (const id of ['hoverlabel', 'panenote', 'panemoved', 'paneinfo', 'panepick', 'popover', 'counter', 'panehead']) {
            expect(byId(page, id).querySelectorAll('img, svg, script').length, id).toBe(0);
          }
          expect(docOf(page).querySelectorAll('[onerror], [onload]').length).toBe(0);
          page.dom.window.close();
        });

        it('P9: no message arm of the frame, and no Enter in the popover, requests a write', async () => {
          const { page, agent } = await bridged({ site: GREETING });
          const arms: Array<Record<string, unknown>> = [
            { stet: 'pick', keys: [{ key: 'hero_headline', attr: null, by: 'whole', inplace: true }], tag: 'h1', rect: RECT, again: true },
            { stet: 'typed', key: 'hero_headline', locale: 'default', value: 'x', force: true },
            { stet: 'hover', keys: [{ key: 'hero_headline', attr: null, by: 'whole' }], tag: 'h1', rect: RECT, inplace: true },
            { stet: 'rect', rect: RECT },
            { stet: 'unmanaged', text: 't', tag: 'p' },
            { stet: 'census', found: { hero_headline: 1 }, head: [], route: '/' },
            { stet: 'moved', how: 'pushState', route: '/x' },
            { stet: 'key', which: 'mode' },
            { stet: 'key', which: 'mode' },
            { stet: 'key', which: 'escape' },
            { stet: 'key', which: 'save' },
            { stet: 'edited', key: 'hero_headline', locale: 'default', how: 'lost', proposed: true },
            { stet: 'edited', key: 'hero_headline', locale: 'default', how: 'cancel' },
            { stet: 'edited', key: 'hero_headline', locale: 'default', how: 'keep' },
          ];
          for (const arm of arms) await agent.tell(arm);
          expect(writesOf(page)).toEqual([]);
          await agent.pick([{ key: 'lab_greeting', by: 'pattern', inplace: false }], { again: true });
          await typeInto(page, poptext(page), 'Hello');
          await press(page, poptext(page), 'Enter');
          expect(writesOf(page)).toEqual([]);
          page.dom.window.close();
        });

        it('P10: every draft removal clears its base: cancel, lost without a proposal, the popover’s Esc, a project switch', async () => {
          const { page, agent } = await bridged({ site: GREETING });
          await agent.pick([{ key: 'hero_headline' }], { again: true });
          await agent.typed('hero_headline', 'During');
          expect(stateOf(page).base).toEqual({ 'default hero_headline': 'Ship the copy' });
          await agent.edited('hero_headline', 'cancel');
          expect(stateOf(page).draft).toEqual({});
          expect(stateOf(page).base).toEqual({});

          await agent.pick([{ key: 'loose_key' }], { again: true, tag: 'p' });
          await agent.typed('loose_key', 'Typed');
          await agent.edited('loose_key', 'lost', { proposed: false });
          expect(stateOf(page).draft).toEqual({});
          expect(stateOf(page).base).toEqual({});

          await agent.pick([{ key: 'lab_greeting', by: 'pattern', inplace: false }], { again: true });
          await typeInto(page, poptext(page), 'Gone');
          expect(Object.keys(stateOf(page).base ?? {})).toEqual(['default lab_greeting']);
          await press(page, poptext(page), 'Escape');
          expect(stateOf(page).draft).toEqual({});
          expect(stateOf(page).base).toEqual({});

          await agent.pick([{ key: 'hero_headline' }]);
          await page.type('text:hero_headline', 'Before the switch');
          expect(Object.keys(stateOf(page).base ?? {})).toEqual(['default hero_headline']);
          await page.act('site:/checkouts/other');
          // The switch asks first, and the edit is lost only on Leave.
          expect(Object.keys(stateOf(page).draft)).toEqual(['default hero_headline']);
          await page.act('leaveGo');
          expect(stateOf(page).draft).toEqual({});
          expect(stateOf(page).base).toEqual({});
          page.dom.window.close();
        });

        it('P11: markup in a frame string stays text in the hover label and the pane note', async () => {
          const { page, agent } = await bridged();
          const evil = '<b id="pwn">x</b>';
          await agent.tell({ stet: 'hover', keys: [{ key: 'hero_headline', attr: evil, by: 'whole' }], tag: evil, rect: RECT, inplace: true });
          expect(byId(page, 'hoverlabel').querySelector('#pwn')).toBeNull();
          expect(byId(page, 'hoverlabel').textContent).toContain(evil);
          await agent.pick([{ key: 'hero_headline' }]);
          await agent.tell({ stet: 'located', key: 'hero_headline', found: 0, by: 'text', route: evil, seq: agent.locates().at(-1)?.['seq'] });
          expect(byId(page, 'panenote').querySelector('#pwn')).toBeNull();
          expect(byId(page, 'panenote').textContent).toContain(evil);
          page.dom.window.close();
        });

        it('P12: a pick of another entry of the same key ends the open edit first', async () => {
          const { page, agent } = await bridged({ site: THREE });
          await agent.pick([{ key: 'hero_bullets', entry: 0 }], { again: true, tag: 'li' });
          expect(stateOf(page).edit).toMatchObject({ key: 'hero_bullets', entry: 0 });
          const at = agent.posts.length;
          await agent.pick([{ key: 'hero_bullets', entry: 1 }], { tag: 'li' });
          expect(agent.posts[at]?.message).toEqual({ stet: 'end', how: 'keep' });
          page.dom.window.close();
        });

        it('P13: a click right after the app moved lists no not-found keys until the new route’s reads arrive (F8)', async () => {
          const { page, agent } = await bridged({
            routes: [['/api/site/route-reads', 200, { route: '/', files: ['index.html'], keys: ['hero_headline', 'loose_key'], complete: true }]],
          });
          await agent.census({ found: {} });
          page.answer('/api/site/route-reads', 200, { route: '/pricing', files: [], keys: ['seo_home_title'], complete: true }, 300);
          await agent.moved('/pricing');
          await agent.tell({ stet: 'unmanaged', text: 'x', tag: 'p' });
          expect(lines(page)).toEqual(['No key matches this text.']);
          await wait(500);
          await page.settle();
          expect(lines(page)).toEqual(['No key matches this text.', 'Keys this page reads that were not found: seo_home_title.']);
          page.dom.window.close();
        });
      });

      // --- fix-preview-editing (8o): the frame holds still, the reads reach the agent, phone width, the keys list, the near-limit count ---
      describe('fix-preview-editing (8o)', () => {
        const evalIn = (page: Painted, code: string): unknown => (page.dom.window as unknown as { eval: (c: string) => unknown }).eval(code);
        const widthOf = (px: number) => (window: Painted['dom']['window']): void => {
          Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => px });
        };
        /** Records every field scroll as `<field> <arg>`; `held` is read from the page at the call. */
        const spyScroll = (window: Painted['dom']['window'], out: string[]): void => {
          (window.HTMLElement.prototype as unknown as { scrollIntoView: (arg: unknown) => void }).scrollIntoView = function (this: HTMLElement, arg: unknown) {
            out.push((this.getAttribute('data-act-input') ?? '') + ' ' + JSON.stringify(arg));
          };
        };
        /** jsdom lays out nothing: the preview box is given a phone pane's width so `fitFrame` runs. */
        const paneWidth = (window: Painted['dom']['window']): void => {
          Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.id === 'devwrap' ? 326 : 0; } });
        };
        /** A touch screen: the primary pointer is coarse. */
        const coarse = (window: Painted['dom']['window']): void => {
          (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => ({ matches: q === '(pointer: coarse)' });
        };
        const hover = (agent: ReturnType<typeof agentOf>): Promise<void> =>
          agent.tell({ stet: 'hover', keys: [{ key: 'hero_headline', attr: null, by: 'whole' }], tag: 'h1', rect: RECT, inplace: true });

        // D1 — the hold
        it('holds the field scroll a pick asks for until the pointer leaves the frame (T1.1)', async () => {
          const scrolled: string[] = [];
          const { page, agent } = await bridged({ prepare: (w) => { widthOf(1280)(w); spyScroll(w, scrolled); } });
          await agent.pick([{ key: 'hero_headline' }]);
          expect(selected(page)).toBe('hero_headline');
          expect(scrolled).toEqual([]);
          await agent.tell({ stet: 'out' });
          expect(scrolled).toEqual(['text:hero_headline {"block":"nearest"}']);
          page.dom.window.close();
        });

        it('opens a hidden key column only once the pointer leaves the frame (T1.2)', async () => {
          const { page, agent } = await bridged({ prepare: widthOf(1280) });
          await page.act('keys');
          expect(byId(page, 'work').className).toBe('wrap content wide');
          await agent.pick([{ key: 'hero_headline' }]);
          expect(byId(page, 'work').className).toBe('wrap content wide');
          await agent.tell({ stet: 'out' });
          expect(byId(page, 'work').className).toBe('wrap content');
          page.dom.window.close();
        });

        it('drops the field scroll when the dashboard is pressed during the hold (T1.3)', async () => {
          const scrolled: string[] = [];
          const { page, agent } = await bridged({ prepare: (w) => { widthOf(1280)(w); spyScroll(w, scrolled); } });
          await agent.pick([{ key: 'hero_headline' }]);
          const save = docOf(page).querySelector('#main [data-act="save"]') as HTMLElement;
          save.dispatchEvent(new page.dom.window.MouseEvent('pointerdown', { bubbles: true }));
          await agent.tell({ stet: 'out' });
          expect(scrolled).toEqual([]);
          page.dom.window.close();
        });

        it('holds the block above the frame at its height while the pointer is in the frame, wider than 760 px (T1.4)', async () => {
          const { page, agent } = await bridged({ prepare: widthOf(1280) });
          const top = byId(page, 'panetop');
          await hover(agent);
          expect([top.style.height, top.style.overflow]).toEqual(['0px', 'hidden']);
          await agent.tell({ stet: 'out' });
          expect([top.style.height, top.style.overflow]).toEqual(['', '']);
          page.dom.window.close();
          const phone = await bridged({ prepare: widthOf(390) });
          await hover(phone.agent);
          expect([byId(phone.page, 'panetop').style.height, byId(phone.page, 'panetop').style.overflow]).toEqual(['', '']);
          phone.page.dom.window.close();
        });

        it('keeps the note’s line above a frame, empty or not, and hides an empty note at phone width (T1.5)', async () => {
          const { page } = await bridged({ prepare: widthOf(1280) });
          expect([note(page).hidden, note(page).textContent]).toEqual([false, '']);
          page.dom.window.close();
          const phone = await bridged({ prepare: widthOf(390) });
          expect(note(phone.page).hidden).toBe(true);
          phone.page.dom.window.close();
        });

        it('hides the hover label when the pointer leaves the frame (T1.6)', async () => {
          const { page, agent } = await bridged();
          await hover(agent);
          expect(byId(page, 'hoverlabel').hidden).toBe(false);
          await agent.tell({ stet: 'out' });
          expect(byId(page, 'hoverlabel').hidden).toBe(true);
          page.dom.window.close();
        });

        it('scrolls to no field when the pointer leaves with an edit open (T1.7)', async () => {
          const scrolled: string[] = [];
          const { page, agent } = await bridged({ prepare: (w) => { widthOf(1280)(w); spyScroll(w, scrolled); } });
          await agent.pick([{ key: 'hero_headline' }], { again: true });
          expect(stateOf(page).edit).toMatchObject({ key: 'hero_headline', form: 'inplace' });
          await agent.tell({ stet: 'out' });
          expect(scrolled).toEqual([]);
          page.dom.window.close();
        });

        it('floats the chooser over the frame, outside the block above it (T1.9)', async () => {
          const { page, agent } = await bridged();
          await agent.pick([{ key: 'hero_headline' }, { key: 'loose_key' }]);
          const box = byId(page, 'panepick');
          expect({ hidden: box.hidden, inTop: byId(page, 'panetop').contains(box), buttons: [...box.querySelectorAll('button')].map((b) => b.textContent), top: box.style.top })
            .toEqual({ hidden: false, inTop: false, buttons: ['hero_headline', 'loose_key'], top: '76px' });
          page.dom.window.close();
        });

        it('holds nothing for a pick made by Enter, and holds for a click (T1.10)', async () => {
          const { page, agent } = await bridged();
          await agent.pick([{ key: 'hero_headline' }], { key: true });
          const byEnter = evalIn(page, 'frameHold === null');
          await agent.pick([{ key: 'hero_headline' }]);
          expect({ byEnter, byClick: evalIn(page, 'frameHold === null') }).toEqual({ byEnter: true, byClick: false });
          page.dom.window.close();
        });

        it('follows the phone rule on a touch screen wider than a phone: the second tap releases the hold and focuses the field (T1.12, R12)', async () => {
          const scrolled: string[] = [];
          const { page, agent } = await bridged({
            prepare: (w) => {
              widthOf(1024)(w);
              coarse(w);
              (w.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: HTMLElement) {
                scrolled.push((this.getAttribute('data-act-input') ?? '') + ' held:' + String((w as unknown as { eval: (c: string) => unknown }).eval('frameHold !== null')));
              };
            },
          });
          await agent.pick([{ key: 'hero_headline' }]);
          expect({ held: evalIn(page, 'frameHold !== null'), scrolled }).toEqual({ held: true, scrolled: [] });
          await agent.pick([{ key: 'hero_headline' }], { again: true });
          expect({ held: evalIn(page, 'frameHold !== null'), scrolled, edits: agent.sent('edit'), popover: popover(page).hidden })
            .toEqual({ held: false, scrolled: ['text:hero_headline held:false'], edits: [], popover: true });
          expect(docOf(page).activeElement?.getAttribute('data-act-input')).toBe('text:hero_headline');
          page.dom.window.close();
        });

        // D2 — the reads reach the agent
        it('sends the held reads before the census on ready, or none where they are incomplete (T2.5)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }]] });
          await agent.census({ found: {} });
          await wait(20); await page.settle();
          const order = (from: number): unknown[] =>
            agent.posts.slice(from).map((p) => p.message).filter((m) => ['mode', 'reads', 'census'].includes(m['stet'] as string))
              .map((m) => (m['stet'] === 'reads' ? { stet: 'reads', route: m['route'], keys: m['keys'] } : m['stet']));
          let at = agent.posts.length;
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/');
          expect(order(at).slice(0, 3)).toEqual(['mode', { stet: 'reads', route: '/', keys: ['hero_headline'] }, 'census']);
          page.answer('/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: false });
          await agent.census({ found: {} });
          await wait(20); await page.settle();
          at = agent.posts.length;
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/');
          expect(order(at).slice(0, 3)).toEqual(['mode', { stet: 'reads', route: '/', keys: null }, 'census']);
          page.dom.window.close();
        });

        it('posts the reads once the route’s reads answer (T2.6)', async () => {
          // The pane's own request is still out when the agent announces itself and its census lands.
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }, 400]] });
          await agent.census({ found: {} });
          expect(agent.sent('reads')).toEqual([{ stet: 'reads', route: '/', keys: null, renders: null, coincident: null }]);
          await wait(500); await page.settle();
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/', keys: ['hero_headline'], renders: {}, coincident: [] });
          page.dom.window.close();
        });

        it('says last in the note that stet cannot tell which keys the page reads, once the reads answer incomplete, in Edit (T2.7)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: false }, 400]] });
          await agent.census({ found: {} });
          expect(lines(page)).not.toContain(UNKNOWN);
          await wait(500); await page.settle();
          expect(lines(page).at(-1)).toBe(UNKNOWN);
          await agent.tell({ stet: 'unmanaged', text: 'x', tag: 'p' });
          expect(lines(page)).toEqual(['No key matches this text.', 'Keys this page reads that were not found: hero_headline.', UNKNOWN]);
          await page.act('mode:use');
          expect(lines(page)).not.toContain(UNKNOWN);
          page.dom.window.close();
        });

        it('asks the route’s reads again on a frame reload and posts the new answer (T2.8, R11)', async () => {
          let asked = 0;
          const { page, agent } = await bridged({
            routes: [['/api/site/route-reads', 200, () => { asked += 1; return { route: '/', files: ['app/page.tsx'], keys: asked === 1 ? ['hero_headline'] : ['hero_headline', 'loose_key'], complete: true }; }]],
          });
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/');
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          expect({ asked, last: agent.sent('reads').at(-1) }).toEqual({ asked: 2, last: { stet: 'reads', route: '/', keys: ['hero_headline', 'loose_key'], renders: {}, coincident: [] } });
          page.dom.window.close();
        });

        it('asks the reads again when the descriptor’s keys change (T2.9)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }]] });
          await agent.census({ found: {} });
          await wait(20); await page.settle();
          const before = page.requested('/api/site/route-reads').length;
          page.answer('/api/site', 200, siteBody({ descriptor: { ...descriptor, keys: { ...descriptor.keys, added_key: { shape: 'text', target: 'web' } } } }));
          evalIn(page, 'void refreshSite()');
          await wait(20); await page.settle();
          expect(page.requested('/api/site/route-reads').length).toBe(before + 1);
          page.dom.window.close();
        });

        it('follows a full page load: the pane and the page keys take the route the frame shows (T2.10)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }]] });
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          page.answer('/api/site/route-reads', 200, { route: '/pricing', files: ['app/pricing/page.tsx'], keys: ['loose_key'], complete: true });
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/pricing');
          await agent.census({ found: {}, route: '/pricing' });
          await wait(50); await page.settle();
          const state = JSON.parse(evalIn(page, 'JSON.stringify({ unknown: readsUnknown(), page: pageKeys() })') as string);
          expect({ state, sent: agent.sent('reads').at(-1) }).toEqual({ state: { unknown: false, page: ['loose_key'] }, sent: { stet: 'reads', route: '/pricing', keys: ['loose_key'], renders: {}, coincident: [] } });
          page.dom.window.close();
        });

        it('follows the app’s own navigation: the reads it asks for go to the agent under the new path, before its census (T2.10, an addition for M2.7)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }]] });
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          page.answer('/api/site/route-reads', 200, { route: '/pricing', files: ['app/pricing/page.tsx'], keys: ['loose_key'], complete: true });
          await agent.moved('/pricing?tier=pro');
          await wait(50); await page.settle();
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/pricing', keys: ['loose_key'], renders: {}, coincident: [] });
          page.dom.window.close();
        });

        // D12 — the sites reach the agent, and a pick stet cannot place says so
        it('sends the route’s render sites and coincident keys with its reads, or none where the reads are incomplete (T12.16)', async () => {
          const renders = { hero_headline: [[{ tag: 'h1', classes: [] }]] };
          const { page, agent } = await bridged({
            routes: [['/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['hero_headline'], complete: true, renders, coincident: ['hero_headline'] }]],
          });
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/', keys: ['hero_headline'], renders, coincident: ['hero_headline'] });
          page.answer('/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['hero_headline'], complete: false, renders, coincident: ['hero_headline'] });
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/');
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/', keys: null, renders: null, coincident: null });
          page.dom.window.close();
        });

        it('says a text shown in several places may not all come from the key, only for a pick stet could not place (T12.17)', async () => {
          const UNSURE = "This text shows in 3 places. stet can't tell which of them come from loose_key; saving changes only those.";
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['loose_key'], complete: true }]] });
          await agent.census({ found: { loose_key: 3 } });
          await wait(50); await page.settle();
          await agent.pick([{ key: 'loose_key' }]);
          expect(lines(page)).toContain(UNSURE);
          await agent.pick([{ key: 'loose_key', sure: true }]);
          expect(lines(page).join(' ')).not.toContain('places. stet');
          await agent.census({ found: { loose_key: 1 } });
          await agent.pick([{ key: 'loose_key' }]);
          expect(lines(page).join(' ')).not.toContain('places. stet');
          await agent.census({ found: { loose_key: 3 } });
          page.answer('/api/site/route-reads', 200, { route: '/', files: ['src/pages/index.astro'], keys: ['loose_key'], complete: false });
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/');
          await agent.census({ found: { loose_key: 3 } });
          await wait(50); await page.settle();
          await agent.pick([{ key: 'loose_key' }]);
          expect(lines(page).join(' ')).not.toContain('places. stet');
          expect(lines(page).at(-1)).toBe(UNKNOWN);
          page.dom.window.close();
        });

        // D8 — phone width
        it('draws the frame at Mobile at phone width, whatever wider width is stored (T8.1)', async () => {
          const { page } = await bridged({ storage: { 'stet.preview.width': 'desktop' }, prepare: (w) => { widthOf(390)(w); paneWidth(w); } });
          evalIn(page, 'fitFrame()');
          const frame = docOf(page).querySelector('#devwrap iframe') as HTMLIFrameElement;
          expect(frame.style.width).toBe('390px');
          expect(byId(page, 'panehead').querySelector('[data-act="width:mobile"]')?.className).toBe('on');
          page.dom.window.close();
        });

        it('keeps a width picked at phone width for the tab only (T8.2)', async () => {
          const { page } = await bridged({ prepare: (w) => { widthOf(390)(w); paneWidth(w); } });
          await page.act('width:desktop');
          evalIn(page, 'fitFrame()');
          expect((docOf(page).querySelector('#devwrap iframe') as HTMLIFrameElement).style.width).toBe('1280px');
          expect(page.storage()['stet.preview.width']).toBeUndefined();
          page.dom.window.close();
        });

        it('scrolls nothing on a first tap at phone width; the second focuses and scrolls the field (T8.3)', async () => {
          const scrolled: string[] = [];
          const { page, agent } = await bridged({ prepare: (w) => { widthOf(390)(w); spyScroll(w, scrolled); } });
          await agent.pick([{ key: 'hero_headline' }]);
          expect(scrolled).toEqual([]);
          await agent.pick([{ key: 'hero_headline' }], { again: true });
          expect(scrolled).toEqual(['text:hero_headline {"block":"nearest"}']);
          expect(docOf(page).activeElement?.getAttribute('data-act-input')).toBe('text:hero_headline');
          page.dom.window.close();
        });

        it('folds the sidebar to one row at phone width with a project open (T8.4, R7)', async () => {
          const page = await paint({ prepare: widthOf(390) });
          const shell = byId(page, 'shell');
          const row = byId(page, 'sidetoggle');
          expect({ picked: shell.classList.contains('picked'), open: shell.classList.contains('sideopen'), text: row.textContent, expanded: row.getAttribute('aria-expanded') })
            .toEqual({ picked: true, open: false, text: 'Project: mini ▾', expanded: 'false' });
          await page.act('sideToggle');
          expect([shell.classList.contains('sideopen'), row.getAttribute('aria-expanded')]).toEqual([true, 'true']);
          await page.act('site:/checkouts/other');
          expect([shell.classList.contains('sideopen'), row.getAttribute('aria-expanded'), row.textContent]).toEqual([false, 'false', 'Project: other ▾']);
          page.dom.window.close();
        });

        it('shows no row with no project open (T8.5)', async () => {
          const page = await paint({ sites: [], prepare: widthOf(390) });
          expect([byId(page, 'shell').classList.contains('picked'), byId(page, 'sidetoggle').textContent]).toEqual([false, '']);
          page.dom.window.close();
        });

        // D9 — the keys list
        it('lists All keys and This page first, opens on All keys, and counts every key (T9.1)', async () => {
          const { page } = await bridged();
          const options = [...docOf(page).querySelectorAll('#gsel option')].map((o) => o.textContent);
          expect(options.slice(0, 2)).toEqual(['All keys', 'This page']);
          expect(evalIn(page, 'S.group')).toBe('all');
          expect(byId(page, 'keycount').textContent).toBe(String(Object.keys(descriptor.keys).length));
          page.dom.window.close();
        });

        it('fills This page from the census, its count with it (T9.2)', async () => {
          const { page, agent } = await bridged();
          await page.change('group', 'page');
          await agent.census({ found: { hero_headline: 1, loose_key: 2 } });
          expect(page.keys()).toEqual(['hero_headline', 'loose_key']);
          expect(byId(page, 'keycount').textContent).toBe('2');
          page.dom.window.close();
        });

        // D10 — the near-limit count
        it('shows the count by text typed in place only near the key’s limit (T10.1)', async () => {
          const { page, agent } = await bridged({ site: GREETING });
          await agent.pick([{ key: 'lab_greeting' }], { again: true });
          expect(stateOf(page).edit).toMatchObject({ key: 'lab_greeting', form: 'inplace' });
          const counter = byId(page, 'counter');
          await agent.typed('lab_greeting', 'x'.repeat(35));
          expect(counter.hidden).toBe(true);
          await agent.typed('lab_greeting', 'x'.repeat(36));
          expect([counter.hidden, counter.textContent, counter.className]).toEqual([false, '36 / 40', 'cnt amb']);
          await agent.typed('lab_greeting', 'x'.repeat(41));
          expect([counter.hidden, counter.textContent, counter.className]).toEqual([false, '41 / 40 · Save asks first', 'cnt bad']);
          page.dom.window.close();
        });

        it('shows no count by text typed in place for a key with no limit (T10.2)', async () => {
          const { page, agent } = await bridged();
          await agent.pick([{ key: 'loose_key' }], { again: true, tag: 'p' });
          expect(stateOf(page).edit).toMatchObject({ key: 'loose_key' });
          for (const n of [1, 200]) {
            await agent.typed('loose_key', 'x'.repeat(n));
            expect(byId(page, 'counter').hidden).toBe(true);
          }
          page.dom.window.close();
        });

        it('REVIEW-H2: a sentence key whose value orders its tags otherwise opens its field, never the sentence form', async () => {
          const site = siteBody({
            descriptor: { ...descriptor, keys: { ...descriptor.keys, lab_sentence: { shape: 'text', target: 'web', tags: 2 } } },
            snapshot: { ...snapshot, default: { ...snapshot.default, lab_sentence: 'Read the <2>docs</2> then run <1>npx x init</1>.' } },
          });
          const { page, agent } = await bridged({ site });
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { tag: 'p' });
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { again: true, tag: 'p' });
          expect(agent.sent('edit').filter((m) => m['form'] === 'sentence')).toEqual([]);
          page.dom.window.close();
        });

        // C9 — typing a sentence key in the page (D16, D18)
        const SENTENCE_VALUE = 'Install: run <1>npx x init</1> and answer.';
        const SENTENCE_PLAIN = 'Install: run npx x init and answer.';
        const SENTENCE_SITE = siteBody({
          descriptor: { ...descriptor, keys: { ...descriptor.keys, lab_sentence: { shape: 'text', target: 'web', tags: 1 }, lab_marked: { shape: 'text', target: 'web', tags: 1 } } },
          snapshot: { ...snapshot, default: { ...snapshot.default, lab_sentence: SENTENCE_VALUE, lab_marked: 'Ship <1>it</1> now' } },
        });

        it('sends a sentence key’s plain text and tags, and types its element hit in the sentence form (T18.1)', async () => {
          const { page, agent } = await bridged({ site: SENTENCE_SITE });
          const entry = (agent.sent('census').at(-1)?.['keys'] as Array<Record<string, unknown>>).find((k) => k['key'] === 'lab_sentence');
          expect(entry).toEqual({ key: 'lab_sentence', texts: [SENTENCE_PLAIN], tags: 1 });
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { tag: 'p' });
          expect(agent.locates().at(-1)).toMatchObject({ key: 'lab_sentence', texts: [SENTENCE_PLAIN], tags: 1 });
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { again: true, tag: 'p' });
          expect(agent.sent('edit').at(-1)).toEqual({ stet: 'edit', key: 'lab_sentence', locale: 'default', form: 'sentence', oneLine: true });
          await agent.typed('lab_sentence', 'Install: go <1>npx x init</1> and answer.');
          // The locate sent while the words were typed matches nothing on the page; its answer is held back while typing.
          agent.say(LOCATED({ key: 'lab_sentence', found: 0, seq: agent.locates().at(-1)?.['seq'] }));
          const asked = agent.locates().length;
          await agent.edited('lab_sentence', 'keep');
          // A kept edit asks again, and the page's answer replaces the stale not-found line.
          expect(agent.locates().length).toBe(asked + 1);
          agent.say(LOCATED({ key: 'lab_sentence', found: 1, seq: agent.locates().at(-1)?.['seq'] }));
          await page.settle();
          expect(lines(page).filter((l) => /was not found/.test(l))).toEqual([]);
          // Another key selected: the sentence's draft rides the layer, matched by its plain text.
          await agent.pick([{ key: 'lab_marked', by: 'mark' }], { again: true, tag: 'h1' });
          expect(agent.sent('edit').at(-1)).toMatchObject({ key: 'lab_marked', form: 'runs' });
          const layered = (agent.sent('layer').at(-1)?.['drafts'] as Array<Record<string, unknown>>).find((d) => d['key'] === 'lab_sentence');
          expect(layered).toMatchObject({ texts: [SENTENCE_PLAIN], tags: 1, draft: 'Install: go <1>npx x init</1> and answer.' });
          page.dom.window.close();
        });

        it('keeps the words typed into a sentence the page redrew, and says so until the next selection (T18.10)', async () => {
          const INTERRUPTED = 'The page redrew this text while you typed. Your words are kept as an unsaved edit in the field.';
          const { page, agent } = await bridged({ site: SENTENCE_SITE });
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { again: true, tag: 'p' });
          await agent.typed('lab_sentence', 'Install: run <1>npx xx init</1> and answer.');
          await agent.edited('lab_sentence', 'lost', { interrupted: true });
          expect(stateOf(page).draft).toEqual({ 'default lab_sentence': 'Install: run <1>npx xx init</1> and answer.' });
          expect(stateOf(page).edit).toBeNull();
          expect([popover(page).hidden, poptext(page).value]).toEqual([false, 'Install: run <1>npx xx init</1> and answer.']);
          expect(lines(page)).toContain(INTERRUPTED);
          await page.act('key:lab_sentence');
          expect(lines(page)).not.toContain(INTERRUPTED);
          // Picking the key again in the page ends the line too (choosePick, not the sidebar).
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { again: true, tag: 'p' });
          await agent.edited('lab_sentence', 'lost', { interrupted: true });
          expect(lines(page)).toContain(INTERRUPTED);
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { tag: 'p' });
          expect(lines(page)).not.toContain(INTERRUPTED);
          page.dom.window.close();
        });

        it('G4: picking an interrupted sentence again shows its kept draft before the edit starts (C9 validation)', async () => {
          const { page, agent } = await bridged({ site: SENTENCE_SITE });
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { again: true, tag: 'p' });
          await agent.typed('lab_sentence', 'Install: run <1>npx xx init</1> and answer.');
          await agent.edited('lab_sentence', 'lost', { interrupted: true });
          await wait(400); await page.settle();
          const locates = agent.locates().length;
          const edits = agent.sent('edit').length;
          await agent.pick([{ key: 'lab_sentence', by: 'element' }], { again: true, tag: 'p' });
          expect(agent.sent('edit').length).toBe(edits + 1);
          expect(agent.locates().slice(locates).at(-1)).toMatchObject({ key: 'lab_sentence', draft: 'Install: run <1>npx xx init</1> and answer.' });
          page.dom.window.close();
        });

        // The validation round: the reads race, the phone row, the chooser, and the guards no case reached
        const held = (page: Painted): unknown[] => [evalIn(page, 'frameHold !== null'), byId(page, 'panetop').style.height];

        it('drops a route-reads answer that arrives for a route the frame has left (F1)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/a', files: [], keys: ['hero_headline'], complete: true }, 400]] });
          await agent.census({ found: {}, route: '/a' });
          page.answer('/api/site/route-reads', 200, { route: '/b', files: [], keys: ['loose_key'], complete: true });
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/b');
          await agent.census({ found: {}, route: '/b' });
          await wait(60); await page.settle();
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/b', keys: ['loose_key'], renders: {}, coincident: [] });
          await wait(500); await page.settle();
          expect(evalIn(page, 'S.routeReads.route')).toBe('/b');
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/b', keys: ['loose_key'], renders: {}, coincident: [] });
          expect(lines(page)).not.toContain(UNKNOWN);
          page.dom.window.close();
        });

        it('cuts a long project name in the phone sidebar row to one line (F2)', async () => {
          const page = await paint({ prepare: widthOf(360) });
          const css = [...docOf(page).querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n');
          const rule = /\.shell\.picked #sidetoggle\{([^}]*)\}/.exec(css);
          const props = (rule?.[1] ?? '').split(';');
          expect(props).toEqual(expect.arrayContaining(['min-height:36px', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']));
          page.dom.window.close();
        });

        it('REVIEW-L1: the two-key chooser goes with the page it was opened on', async () => {
          const { page, agent } = await bridged();
          await agent.pick([{ key: 'hero_headline' }, { key: 'loose_key' }]);
          const box = byId(page, 'panepick');
          expect(box.hidden).toBe(false);
          await agent.moved('/pricing');
          const afterMove = box.hidden;
          await agent.tell({ stet: 'bye' });
          await agent.load();
          expect([afterMove, box.hidden]).toEqual([true, true]);
          page.dom.window.close();
        });

        it('moves the chooser with the picked element when the frame scrolls (F3)', async () => {
          const { page, agent } = await bridged();
          await agent.pick([{ key: 'hero_headline' }, { key: 'loose_key' }]);
          const box = byId(page, 'panepick');
          const before = box.style.top;
          await agent.tell({ stet: 'rect', rect: { left: 100, top: 300, width: 200, height: 20 } });
          expect(before).toBe('76px');
          expect(box.style.top).toBe('326px');
          page.dom.window.close();
        });

        it('puts the chooser where its element is once the hold ends and the frame has moved (F4l)', async () => {
          let frameTop = 0;
          const { page, agent } = await bridged({
            prepare: (w) => {
              widthOf(1280)(w);
              (w.HTMLElement.prototype as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = function (this: HTMLElement) {
                return { left: 0, top: this.tagName === 'IFRAME' ? frameTop : 0, width: 0, height: 0, right: 0, bottom: 0 };
              };
            },
          });
          await agent.pick([{ key: 'hero_headline' }, { key: 'loose_key' }]);
          const box = byId(page, 'panepick');
          expect(box.style.top).toBe('76px');
          frameTop = 40;
          await agent.tell({ stet: 'out' });
          expect(box.style.top).toBe('116px');
          page.dom.window.close();
        });

        it('releases the hold when the page goes away (F4a)', async () => {
          const { page, agent } = await bridged({ prepare: widthOf(1280) });
          await agent.pick([{ key: 'hero_headline' }]);
          expect(held(page)).toEqual([true, '0px']);
          await agent.tell({ stet: 'bye' });
          expect(held(page)).toEqual([false, '']);
          page.dom.window.close();
        });

        it('releases the hold on switching to Use (F4b)', async () => {
          const { page, agent } = await bridged({ prepare: widthOf(1280) });
          await agent.pick([{ key: 'hero_headline' }]);
          expect(held(page)).toEqual([true, '0px']);
          await page.act('mode:use');
          expect(held(page)).toEqual([false, '']);
          page.dom.window.close();
        });

        it('releases the hold on opening a project (F4b)', async () => {
          const { page, agent } = await bridged({ prepare: widthOf(1280) });
          await agent.pick([{ key: 'hero_headline' }]);
          expect(held(page)).toEqual([true, '0px']);
          evalIn(page, 'void loadSite(S.path)');
          await wait(30); await page.settle();
          expect(held(page)).toEqual([false, '']);
          page.dom.window.close();
        });

        it('scrolls to no field when the pointer leaves with the popover open (F4c)', async () => {
          const scrolled: string[] = [];
          const { page, agent } = await bridged({ prepare: (w) => { widthOf(1280)(w); spyScroll(w, scrolled); } });
          await agent.pick([{ key: 'hero_headline', inplace: false }], { again: true });
          expect(popover(page).hidden).toBe(false);
          await agent.tell({ stet: 'out' });
          expect(scrolled).toEqual([]);
          page.dom.window.close();
        });

        it('holds the frame for text no key matches until the pointer leaves (F4d)', async () => {
          const { page, agent } = await bridged({ prepare: widthOf(1280) });
          await agent.tell({ stet: 'unmanaged', text: 'x', tag: 'p' });
          expect(held(page)).toEqual([true, '0px']);
          await agent.tell({ stet: 'out' });
          expect(held(page)).toEqual([false, '']);
          page.dom.window.close();
        });

        it('sends no keys for a page whose reads are another route’s (F4e)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }]] });
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/', keys: ['hero_headline'], renders: {}, coincident: [] });
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/pricing');
          expect(agent.sent('reads').at(-1)).toEqual({ stet: 'reads', route: '/pricing', keys: null, renders: null, coincident: null });
          page.dom.window.close();
        });

        it('judges a pick and the not-found keys by the route the frame shows, not the one the pane asked for (F4f)', async () => {
          const { page, agent } = await bridged({ routes: [['/api/site/route-reads', 200, { route: '/', files: ['app/page.tsx'], keys: ['hero_headline'], complete: true }]] });
          await agent.census({ found: {} });
          await wait(50); await page.settle();
          page.answer('/api/site/route-reads', 200, { route: '/pricing', files: ['app/pricing/page.tsx'], keys: ['loose_key'], complete: true });
          await agent.tell({ stet: 'bye' });
          await agent.load();
          await agent.ready('/pricing');
          await agent.census({ found: {}, route: '/pricing' });
          await wait(50); await page.settle();
          await agent.pick([{ key: 'hero_headline' }]);
          expect(lines(page)).toContain('This text matches hero_headline, but no file on this page reads that key — saving may not change it.');
          await agent.tell({ stet: 'unmanaged', text: 'x', tag: 'p' });
          expect(lines(page)).toEqual(['No key matches this text.', 'Keys this page reads that were not found: loose_key.']);
          page.dom.window.close();
        });

        it('lights Mobile and draws the frame at it when the window narrows past 760 px (F4h)', async () => {
          const { page } = await bridged({ prepare: (w) => { widthOf(1280)(w); paneWidth(w); } });
          evalIn(page, 'fitFrame()');
          const lit = (): string | undefined => byId(page, 'panehead').querySelector('button.on[data-act^="width:"]')?.getAttribute('data-act') ?? undefined;
          expect(lit()).toBe('width:desktop');
          widthOf(390)(page.dom.window);
          page.dom.window.dispatchEvent(new page.dom.window.Event('resize'));
          await page.settle();
          expect(lit()).toBe('width:mobile');
          expect((docOf(page).querySelector('#devwrap iframe') as HTMLIFrameElement).style.width).toBe('390px');
          page.dom.window.close();
        });

        it('keeps the group picked through a refresh while the list still offers it, and falls back to All keys when it does not (F4i)', async () => {
          const { page } = await bridged();
          await page.change('group', 'page');
          evalIn(page, 'void refreshSite()');
          await wait(30); await page.settle();
          expect(evalIn(page, 'S.group')).toBe('page');
          await page.change('group', 'prefix:loose');
          const { loose_key: _gone, ...keys } = descriptor.keys;
          page.answer('/api/site', 200, siteBody({ descriptor: { ...descriptor, keys } }));
          evalIn(page, 'void refreshSite()');
          await wait(30); await page.settle();
          expect(evalIn(page, 'S.group')).toBe('all');
          page.dom.window.close();
        });

        it('shows the count from 90 % of the limit, rounded up (F4j)', async () => {
          const site = siteBody({
            descriptor: {
              ...descriptor,
              keys: {
                ...descriptor.keys,
                lab_hundred: { shape: 'text', target: 'web', limits: { max: 100, severity: 'advisory' } },
                lab_odd: { shape: 'text', target: 'web', limits: { max: 45, severity: 'advisory' } },
              },
            },
            snapshot: { ...snapshot, default: { ...snapshot.default, lab_hundred: 'x', lab_odd: 'x' } },
          });
          const { page, agent } = await bridged({ site });
          const counter = byId(page, 'counter');
          const shownAt = async (key: string, n: number): Promise<boolean> => {
            await agent.typed(key, 'x'.repeat(n));
            return !counter.hidden;
          };
          await agent.pick([{ key: 'lab_hundred' }], { again: true });
          expect([await shownAt('lab_hundred', 89), await shownAt('lab_hundred', 90)]).toEqual([false, true]);
          await agent.pick([{ key: 'lab_odd' }], { again: true });
          expect([await shownAt('lab_odd', 40), await shownAt('lab_odd', 41)]).toEqual([false, true]);
          page.dom.window.close();
        });
      });
    });

    // --- add-preview-editing D9: store-backed sites --------------------------------
    // The page over a real mount: one memory store per environment behind
    // `createStetHandler`, as `stet dev` builds it, so a draft saved by one
    // page is the row the next page reads.
    describe('store-backed sites (D9)', () => {
      const MOUNT_ENV = 'STET_D9_MOUNT_TOKEN';
      beforeAll(() => { process.env[MOUNT_ENV] = 'd9-token'; });
      afterAll(() => { delete process.env[MOUNT_ENV]; });
      afterEach(() => { closeFrames(); });

      const D9: Descriptor = {
        version: 1,
        keys: {
          lab_headline: { shape: 'text', target: 'web', limits: { max: 60, severity: 'advisory' }, pages: ['home'] },
          lab_button: { shape: 'text', target: 'web', pages: ['pricing'] },
          lab_link: { shape: 'text', target: 'web', pages: ['home'] },
          lab_alt: { shape: 'text', target: 'web', pages: ['home'] },
          lab_note: { shape: 'text', target: 'web', limits: { max: 40, severity: 'hard' }, pages: ['home'] },
        },
        pages: { home: { route: '/' }, pricing: { route: '/pricing' } },
      };
      const D9_SNAPSHOT = {
        default: { lab_headline: 'Copy that ships', lab_button: 'Buy', lab_link: 'Read the docs', lab_alt: 'A lab photo', lab_note: 'Small print' },
      };
      const D9_SITE = siteBody({
        mode: 'memory',
        descriptor: D9,
        snapshot: D9_SNAPSHOT,
        keys: 5,
        environments: [
          { name: 'default', adapter: 'memory', vars: [] },
          { name: 'staging', adapter: 'memory', vars: [] },
        ],
      });
      /** The framed page the agent edits: each lab key once, the alt text an attribute. */
      const D9_PAGE = '<h1>Copy that ships</h1><p id="link">Read the docs</p><img alt="A lab photo"><p id="note">Small print</p>';

      type Stores = Record<string, ReturnType<typeof createMemoryStore>>;
      const storesOf = (): Stores => ({ default: createMemoryStore({ project: 'd9' }), staging: createMemoryStore({ project: 'd9' }) });
      /** The mount over one store per environment, answering the page's `/s/<id>/api/stet/…` requests by its `env`. */
      function storeMount(stores: Stores, d: () => Descriptor = () => D9) {
        return async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
          const url = new URL(`http://127.0.0.1:4400${path}`);
          const store = stores[url.searchParams.get('env') ?? 'default'] as StoreAdapter;
          const handler = createStetHandler({ store, descriptor: d(), auth: MOUNT_ENV });
          const init = {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: 'Bearer d9-token', 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          };
          const res = body === undefined ? await handler.GET(new Request(url, init)) : await handler.POST(new Request(url, init));
          return { status: res.status, body: await res.json() };
        };
      }
      /** Every page this describe painted, with where in its requests each Take over was pressed. */
      const audits: Array<{ page: Painted; presses: number[] }> = [];
      /** The page over the stores, the dev pane's agent announced; `framed` plays the agent for real. */
      async function d9Page(stores: Stores, over: Parameters<typeof paint>[0] & { framed?: Framed } = {}) {
        const { framed, ...rest } = over;
        const page = await paint({ site: D9_SITE, preview: DEV_PREVIEW, storage: { 'stet.editor': 'dashboard:neil' }, mount: storeMount(stores), ...rest });
        const presses: number[] = [];
        const act = page.act.bind(page);
        page.act = async (name: string): Promise<void> => {
          if (name === 'takeOver') presses.push(page.sent.length);
          await act(name);
        };
        audits.push({ page, presses });
        const agent = agentOf(page, framed === undefined ? undefined : (message) => {
          framed.send(JSON.parse(JSON.stringify(message)));
          return null;
        });
        await agent.load();
        await agent.ready();
        return { page, agent };
      }
      /** The draft POSTs the page sent, their bodies in order. */
      const draftPosts = (page: Painted): Array<Record<string, unknown>> =>
        page.sent.filter((r) => r.path.split('?')[0] === `/s/${SITE_ID}/api/stet/draft`).map((r) => r.body as Record<string, unknown>);
      /** A store's rows for one key, as the dashboard's read gets them. */
      const rowsOf = async (store: StoreAdapter, key: string) => {
        const rows = await store.read({ preview: true });
        if (!Array.isArray(rows)) throw new Error('read failed');
        return rows.filter((r) => r.key === key);
      };
      /** `HH:MM` of an ISO stamp on this machine's clock, as the page shows a stamp of today. */
      const clockOf = (at: string): string => {
        const d = new Date(at);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };
      const fieldOf = (page: Painted, key: string): HTMLTextAreaElement =>
        docOf(page).querySelector(`[data-act-input="text:${key}"]`) as HTMLTextAreaElement;
      const rowText = (page: Painted, key: string): string => docOf(page).querySelector(`[data-act="key:${key}"]`)?.textContent ?? '';

      describe('the value model (8.3)', () => {
        it('a draft survives a reload: the field, the row and the preview show it (journey B16)', async () => {
          const stores = storesOf();
          const first = await d9Page(stores);
          await first.page.act('key:lab_headline');
          await first.page.type('text:lab_headline', 'Copy changes without a deploy');
          await first.page.act('save');
          expect(draftPosts(first.page)).toHaveLength(1);
          first.page.dom.window.close();

          const [draft] = (await rowsOf(stores['default'] as StoreAdapter, 'lab_headline')).filter((r) => r.status === 'draft');
          const { page, agent } = await d9Page(stores);
          await page.act('key:lab_headline');
          expect(fieldOf(page, 'lab_headline').value).toBe('Copy changes without a deploy');
          expect(rowText(page, 'lab_headline')).toContain(`draft · dashboard:neil · ${clockOf(draft?.createdAt as string)}`);
          const located = agent.locates().at(-1) as Record<string, unknown>;
          expect(located['draft']).toBe('Copy changes without a deploy');
          expect(located['texts']).toEqual(['Copy that ships', 'Copy changes without a deploy']);
          page.dom.window.close();
        });

        it('an environment switch reads that environment’s rows', async () => {
          const stores = storesOf();
          await stores['staging']?.saveDraft({ key: 'lab_headline', value: 'Staging words', target: 'web', editor: 'agent:claude' });
          const { page } = await d9Page(stores);
          await page.act('key:lab_headline');
          expect(fieldOf(page, 'lab_headline').value).toBe('Copy that ships');
          await page.act('cycleEnv');
          expect(page.requested(`/s/${SITE_ID}/api/stet/keys?env=staging`)).toHaveLength(1);
          expect(fieldOf(page, 'lab_headline').value).toBe('Staging words');
          expect(rowText(page, 'lab_headline')).toContain('draft · agent:claude · ');
          await page.act('cycleEnv');
          expect(fieldOf(page, 'lab_headline').value).toBe('Copy that ships');
          page.dom.window.close();
        });

        it('the census offers the snapshot’s, the active row’s and the draft’s words, each once (fork 20)', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          store.seed([
            { key: 'lab_headline', value: 'Copy that shipped' },
            { key: 'lab_headline', value: 'Copy changes without a deploy', state: 'draft', editor: 'agent:claude' },
            { key: 'lab_link', value: 'Read the docs' },
          ]);
          const { agent } = await d9Page(stores);
          const census = agent.sent('census').at(-1) as { keys: Array<{ key: string; texts: string[] }> };
          expect(census.keys.find((k) => k.key === 'lab_headline')?.texts).toEqual(['Copy that ships', 'Copy that shipped', 'Copy changes without a deploy']);
          expect(census.keys.find((k) => k.key === 'lab_link')?.texts).toEqual(['Read the docs']);
        });

        it('several drafts show together: three unsaved edits, an attribute among them, and a fourth key’s saved draft (journey B23, D44)', async () => {
          const stores = storesOf();
          await stores['default']?.saveDraft({ key: 'lab_note', value: 'Fine print', target: 'web', editor: 'agent:claude' });
          const framed = await frameAgent(D9_PAGE, CHANNEL);
          const { page } = await d9Page(stores, { framed });
          for (const [key, value] of [['lab_headline', 'Copy that sells'], ['lab_link', 'Read the guide'], ['lab_alt', 'A lab at night']] as const) {
            await page.act(`key:${key}`);
            await page.type(`text:${key}`, value);
          }
          await page.act('key:lab_note');
          await wait(150);
          await tick();
          const doc = framed.doc;
          expect(doc.querySelector('h1')?.textContent).toBe('Copy that sells');
          expect(doc.getElementById('link')?.textContent).toBe('Read the guide');
          expect(doc.querySelector('img')?.getAttribute('alt')).toBe('A lab at night');
          expect(doc.getElementById('note')?.textContent).toBe('Fine print');
          page.dom.window.close();
        });

        it('a finished in-place draft stays on the page when another key is picked (D44, a snapshot site)', async () => {
          const framed = await frameAgent('<h1>Ship the copy</h1><p>loose</p>', CHANNEL);
          const page = await paint({ preview: DEV_PREVIEW });
          const agent = agentOf(page, (message) => { framed.send(JSON.parse(JSON.stringify(message))); return null; });
          await agent.load();
          await agent.ready();
          await page.act('key:hero_headline');
          await page.type('text:hero_headline', 'Ship the words');
          await page.change('group', 'prefix:loose');
          await page.act('key:loose_key');
          await wait(150);
          await tick();
          expect(framed.doc.querySelector('h1')?.textContent).toBe('Ship the words');
          expect(agent.sent('layer').at(-1)).toEqual({ stet: 'layer', drafts: [{ key: 'hero_headline', texts: ['Ship the copy'], draft: 'Ship the words' }] });
          page.dom.window.close();
        });
      });

      describe('Save and the takeover (8.4, stage 5)', () => {
        const confirmText = (page: Painted): string => docOf(page).querySelector('#takeover .term')?.textContent ?? '';
        /** An agent's draft of `key`, saved before the page loads. */
        const agentHolds = async (stores: Stores, key: string, value: string, env = 'default'): Promise<string> => {
          await stores[env]?.saveDraft({ key, value, target: 'web', editor: 'agent:claude' });
          const [row] = (await rowsOf(stores[env] as StoreAdapter, key)).filter((r) => r.status === 'draft');
          return row?.createdAt as string;
        };

        it('an agent’s draft is taken over: the confirm names it and its time; Keep theirs keeps both, Take over makes the draft the dashboard’s (journey B16)', async () => {
          const stores = storesOf();
          const since = await agentHolds(stores, 'lab_headline', 'The agent’s words');
          const { page } = await d9Page(stores);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'The editor’s words');
          await page.act('save');
          expect(confirmText(page)).toBe(`agent:claude has a draft of lab_headline from ${clockOf(since)}. Save yours over it? Their wording is replaced and the draft becomes yours.`);
          expect([...docOf(page).querySelectorAll('#takeover button')].map((b) => b.textContent)).toEqual(['Take over', 'Keep theirs']);

          await page.act('keepTheirs');
          expect(confirmText(page)).toBe('');
          expect((await rowsOf(stores['default'] as StoreAdapter, 'lab_headline')).find((r) => r.status === 'draft')).toMatchObject({ editor: 'agent:claude', value: 'The agent’s words' });
          expect(fieldOf(page, 'lab_headline').value).toBe('The editor’s words');
          expect(docOf(page).getElementById('dc')?.textContent).toBe('1 unsaved edit');

          await page.act('save');
          await page.act('takeOver');
          const posts = draftPosts(page);
          expect(posts.at(-1)).toEqual({ editor: 'dashboard:neil', key: 'lab_headline', locale: 'default', value: 'The editor’s words', force: true });
          expect((await rowsOf(stores['default'] as StoreAdapter, 'lab_headline')).find((r) => r.status === 'draft')).toMatchObject({ editor: 'dashboard:neil', value: 'The editor’s words' });
          expect(confirmText(page)).toBe('');
          expect(docOf(page).getElementById('dc')?.hidden).toBe(true);
          expect(rowText(page, 'lab_headline')).toContain('draft · dashboard:neil · ');
          page.dom.window.close();
        });

        it('a 409 store conflict without refused shows the error line, stops the loop and queues nothing', async () => {
          const stores = storesOf();
          const mount = storeMount(stores);
          const { page } = await d9Page(stores, {
            mount: async (path, body) => (path.split('?')[0]?.endsWith('/draft')
              ? { status: 409, body: { error: 'concurrent_save:lab_headline', code: 'conflict' } }
              : mount(path, body)),
          });
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Read the guide');
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Another headline');
          await page.act('save');
          expect(draftPosts(page)).toHaveLength(1);
          expect(docOf(page).querySelector('#refusal .err')?.textContent).toBe('concurrent_save:lab_headline');
          expect(docOf(page).getElementById('takeover')).toBeNull();
          expect(docOf(page).getElementById('dc')?.textContent).toBe('2 unsaved edits');
          page.dom.window.close();
        });

        it('Keep theirs writes nothing, and the next held draft follows', async () => {
          const stores = storesOf();
          await agentHolds(stores, 'lab_headline', 'Agent headline');
          await agentHolds(stores, 'lab_link', 'Agent link');
          const { page } = await d9Page(stores);
          for (const [key, value] of [['lab_headline', 'Mine'], ['lab_link', 'Mine too']] as const) {
            await page.act(`key:${key}`);
            await page.type(`text:${key}`, value);
          }
          await page.act('save');
          const sent = page.sent.length;
          expect(confirmText(page)).toContain('agent:claude has a draft of lab_headline from ');
          await page.act('keepTheirs');
          expect(confirmText(page)).toContain('agent:claude has a draft of lab_link from ');
          await page.act('keepTheirs');
          expect(confirmText(page)).toBe('');
          expect(page.sent.slice(sent).filter((r) => r.body !== undefined)).toEqual([]);
          expect((await rowsOf(stores['default'] as StoreAdapter, 'lab_headline')).find((r) => r.status === 'draft')?.value).toBe('Agent headline');
          expect((await rowsOf(stores['default'] as StoreAdapter, 'lab_link')).find((r) => r.status === 'draft')?.value).toBe('Agent link');
          expect(docOf(page).getElementById('dc')?.textContent).toBe('2 unsaved edits');
          page.dom.window.close();
        });

        it('Take over inside an active change resends with force and the change, and the draft joins it', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const opened = (await store.changesets.open({ name: 'Spring pricing' })) as { changeId: number };
          await agentHolds(stores, 'lab_headline', 'Agent headline');
          const { page } = await d9Page(stores, { session: { [`stet.change ${SITE_ID} default`]: String(opened.changeId) } });
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Mine');
          await page.act('save');
          expect(draftPosts(page).at(-1)).toMatchObject({ key: 'lab_headline', change: opened.changeId });
          await page.act('takeOver');
          expect(draftPosts(page).at(-1)).toEqual({ editor: 'dashboard:neil', key: 'lab_headline', locale: 'default', value: 'Mine', change: opened.changeId, force: true });
          expect((await rowsOf(store, 'lab_headline')).find((r) => r.status === 'draft')).toMatchObject({ editor: 'dashboard:neil', changesetId: opened.changeId });
          page.dom.window.close();
        });

        it('a Take over over a hard limit tightened since answers 422, shows the gate’s line, and the other draft stands (journey B16, an addition)', async () => {
          const stores = storesOf();
          await agentHolds(stores, 'lab_note', 'Fine print');
          let descriptor = D9;
          const { page } = await d9Page(stores, { mount: storeMount(stores, () => descriptor) });
          await page.act('key:lab_note');
          await page.type('text:lab_note', 'Small print, said at more length');
          await page.act('save');
          expect(confirmText(page)).toContain('agent:claude has a draft of lab_note from ');
          descriptor = { ...D9, keys: { ...D9.keys, lab_note: { shape: 'text', target: 'web', limits: { max: 10, severity: 'hard' }, pages: ['home'] } } };
          await page.act('takeOver');
          const refusal = docOf(page).querySelector('#refusal .err')?.textContent ?? '';
          expect(refusal).toMatch(/^lab_note: .*10/);
          expect((await rowsOf(stores['default'] as StoreAdapter, 'lab_note')).find((r) => r.status === 'draft')).toMatchObject({ editor: 'agent:claude', value: 'Fine print' });
          expect(docOf(page).getElementById('dc')?.textContent).toBe('1 unsaved edit');
          page.dom.window.close();
        });
      });

      describe('the change bar (8.5)', () => {
        const barText = (page: Painted): string => docOf(page).getElementById('changebar')?.textContent ?? '';
        const barLines = (page: Painted): string[] => [...docOf(page).querySelectorAll('#changebar .cline')].map((el) => el.textContent ?? '');
        const slot = (env = 'default'): string => `stet.change ${SITE_ID} ${env}`;
        const typeIn = async (page: Painted, name: string, value: string): Promise<void> => page.type(name, value);
        /** A change opened in one store, with drafts of the given keys in it. */
        const changeWith = async (store: ReturnType<typeof createMemoryStore>, name: string, drafts: Array<[string, string, string?]>, note?: string): Promise<number> => {
          const opened = (await store.changesets.open({ name, ...(note === undefined ? {} : { note }) })) as { changeId: number };
          for (const [key, value, editor] of drafts) {
            await store.saveDraft({ key, value, target: 'web', editor: editor ?? 'dashboard:neil', change: opened.changeId });
          }
          return opened.changeId;
        };

        it('groups three edits and publishes them together (journey B24)', async () => {
          const stores = storesOf();
          const staging = stores['staging'] as ReturnType<typeof createMemoryStore>;
          const { page } = await d9Page(stores);
          await page.act('cycleEnv');
          expect(barLines(page)).toEqual(['No open change. Edits save and publish key by key.']);
          await page.act('changeNew');
          await typeIn(page, 'changeName', 'Spring pricing');
          await typeIn(page, 'changeNote', 'New plan names');
          await page.act('changeCreate');
          expect(page.sent.find((r) => r.path.startsWith(`/s/${SITE_ID}/api/stet/changes?env=staging`) && r.body !== undefined)?.body).toEqual({ name: 'Spring pricing', note: 'New plan names', editor: 'dashboard:neil' });
          const id = Number(page.dom.window.sessionStorage.getItem(slot('staging')));
          expect(id).toBeGreaterThan(0);

          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Spring headline');
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Spring link');
          await page.change('group', 'page:pricing');
          await page.act('key:lab_button');
          await page.type('text:lab_button', 'Buy the spring plan');
          await page.act('save');
          expect(draftPosts(page).map((b) => b['change'])).toEqual([id, id, id]);
          expect((await staging.read({ preview: true }) as Array<{ status: string; changesetId?: number | null }>).filter((r) => r.status === 'draft').map((r) => r.changesetId)).toEqual([id, id, id]);

          expect(docOf(page).querySelector('#changebar h3')?.textContent).toBe('change · Spring pricing · staging · 3 keys · home, pricing');
          expect(barLines(page)).toEqual([
            'lab_headline  Copy that ships → Spring headline',
            'lab_link  Read the docs → Spring link',
            'lab_button  Buy → Buy the spring plan',
            'Note: New plan names',
          ]);
          // A member's own Publish stays, and says what it does to the change.
          expect(docOf(page).getElementById('alone')?.textContent).toBe('Publishing lab_button alone takes it out of Spring pricing.');

          await page.act('publishChange');
          const live = (await staging.read()) as Array<{ key: string; value: unknown }>;
          expect(Object.fromEntries(live.map((r) => [r.key, r.value]))).toEqual({ lab_button: 'Buy the spring plan', lab_headline: 'Spring headline', lab_link: 'Spring link' });
          expect(page.dom.window.sessionStorage.getItem(slot('staging'))).toBeNull();
          expect(barLines(page)).toEqual(['No open change. Edits save and publish key by key.']);
          page.dom.window.close();
        });

        it('adds an agent’s draft: the confirm names the agent; Take over makes it a member and the dashboard’s, Cancel leaves it loose (journey B24)', async () => {
          for (const answer of ['takeOver', 'keepTheirs'] as const) {
            const stores = storesOf();
            const store = stores['default'] as ReturnType<typeof createMemoryStore>;
            const id = await changeWith(store, 'Spring pricing', [['lab_headline', 'Spring headline']]);
            await store.saveDraft({ key: 'lab_link', value: 'Agent link', target: 'web', editor: 'agent:claude' });
            const since = (await rowsOf(store, 'lab_link')).find((r) => r.status === 'draft')?.createdAt as string;
            const { page } = await d9Page(stores, { session: { [slot()]: String(id) } });
            expect(barText(page)).toContain('1 saved draft(s) is not in this change.');
            await page.act('addToChange');
            expect(docOf(page).querySelector('#takeover .term')?.textContent).toBe(`agent:claude has a draft of lab_link from ${clockOf(since)}. Add it to Spring pricing? The draft becomes yours.`);
            expect([...docOf(page).querySelectorAll('#takeover button')].map((b) => b.textContent)).toEqual(['Take over', 'Cancel']);
            expect(draftPosts(page).at(-1)).toEqual({ editor: 'dashboard:neil', key: 'lab_link', locale: 'default', value: 'Agent link', change: id });
            await page.act(answer);
            const row = (await rowsOf(store, 'lab_link')).find((r) => r.status === 'draft');
            if (answer === 'takeOver') {
              expect(draftPosts(page).at(-1)).toEqual({ editor: 'dashboard:neil', key: 'lab_link', locale: 'default', value: 'Agent link', change: id, force: true });
              expect(row).toMatchObject({ editor: 'dashboard:neil', changesetId: id });
              expect(barLines(page)).toContain('lab_link  Read the docs → Agent link');
            } else {
              expect(row).toMatchObject({ editor: 'agent:claude', changesetId: null });
              expect(barText(page)).toContain('1 saved draft(s) is not in this change.');
            }
            page.dom.window.close();
          }
        });

        it('a reload keeps the open change; after it is published elsewhere the bar says it is closed and Save carries no change (journey B24)', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = await changeWith(store, 'Spring pricing', [['lab_headline', 'Spring headline']]);
          const first = await d9Page(stores, { session: { [slot()]: String(id) } });
          expect(docOf(first.page).querySelector('#changebar h3')?.textContent).toBe('change · Spring pricing · default · 1 key · home');
          await first.page.act('key:lab_link');
          await first.page.type('text:lab_link', 'Spring link');
          await first.page.act('save');
          expect(draftPosts(first.page).at(-1)).toMatchObject({ key: 'lab_link', change: id });
          const session = { [slot()]: first.page.dom.window.sessionStorage.getItem(slot()) as string };
          first.page.dom.window.close();

          await store.changesets.publishChange({ changeId: id, editor: 'sam' });
          const { page } = await d9Page(stores, { session });
          expect(barLines(page)).toEqual([
            'Spring pricing is closed. Edits now save on their own, outside any change.',
            'No open change. Edits save and publish key by key.',
          ]);
          expect(page.dom.window.sessionStorage.getItem(slot())).toBeNull();
          await page.act('key:lab_note');
          await page.type('text:lab_note', 'Fine print');
          await page.act('save');
          expect(draftPosts(page).at(-1)).toEqual({ editor: 'dashboard:neil', key: 'lab_note', locale: 'default', value: 'Fine print' });
          page.dom.window.close();
        });

        it('a remembered change that is gone is named by its id', async () => {
          const { page } = await d9Page(storesOf(), { session: { [slot()]: '41' } });
          expect(barLines(page)[0]).toBe('change 41 is closed. Edits now save on their own, outside any change.');
          page.dom.window.close();
        });

        it('a sessionStorage that throws loads the page with no active change', async () => {
          const stores = storesOf();
          await changeWith(stores['default'] as ReturnType<typeof createMemoryStore>, 'Spring pricing', [['lab_headline', 'Spring headline']]);
          const { page } = await d9Page(stores, {
            prepare: (window) => {
              Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('denied'); } });
            },
          });
          expect(barLines(page)).toEqual(['No open change. Edits save and publish key by key.', 'Open changes in default: Spring pricing · 1 key']);
          await page.act('changeResume:1');
          expect(docOf(page).querySelector('#changebar h3')?.textContent).toBe('change · Spring pricing · default · 1 key · home');
          expect(page.errors).toEqual([]);
          page.dom.window.close();
        });

        it('a refused Remove shows its confirm, and Take over takes the draft out of the change', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = await changeWith(store, 'Spring pricing', [['lab_headline', 'Spring headline'], ['lab_link', 'Agent link', 'agent:claude']]);
          const since = (await rowsOf(store, 'lab_link')).find((r) => r.status === 'draft')?.createdAt as string;
          const version = (await rowsOf(store, 'lab_link')).find((r) => r.status === 'draft')?.version as number;
          const { page } = await d9Page(stores, { session: { [slot()]: String(id) } });
          await page.act(`removeMember:${version}`);
          expect(draftPosts(page).at(-1)).toEqual({ editor: 'dashboard:neil', key: 'lab_link', locale: 'default', value: 'Agent link', change: null });
          expect(docOf(page).querySelector('#takeover .term')?.textContent).toBe(`agent:claude has a draft of lab_link from ${clockOf(since)}. Take it out of Spring pricing? The draft becomes yours.`);
          await page.act('takeOver');
          expect((await rowsOf(store, 'lab_link')).find((r) => r.status === 'draft')).toMatchObject({ editor: 'dashboard:neil', changesetId: null });
          expect(barText(page)).toContain('1 saved draft(s) is not in this change.');
          page.dom.window.close();
        });

        it('discards a change: the confirm names its drafts, the change and its drafts go, the keys keep their live values (journey B24)', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          store.seed([{ key: 'lab_headline', value: 'Live headline' }]);
          const id = await changeWith(store, 'Spring pricing', [['lab_headline', 'A'], ['lab_link', 'B'], ['lab_note', 'C']]);
          const { page } = await d9Page(stores, { session: { [slot()]: String(id) } });
          await page.act('discardAsk');
          expect(docOf(page).querySelector('#changebar .term')?.textContent).toBe('Discard Spring pricing? Its 3 drafts are dropped. Nothing was published, so the keys keep their live values.');
          await page.act('discardChange');
          expect(await store.changesets.list({ status: 'open' })).toEqual({ changes: [], nextBeforeId: null });
          expect((await store.read({ preview: true }) as Array<{ status: string }>).filter((r) => r.status === 'draft')).toEqual([]);
          expect(page.dom.window.sessionStorage.getItem(slot())).toBeNull();
          await page.act('key:lab_headline');
          expect(fieldOf(page, 'lab_headline').value).toBe('Live headline');
          page.dom.window.close();
        });

        it('each environment lists and remembers its own change', async () => {
          const stores = storesOf();
          const id = await changeWith(stores['default'] as ReturnType<typeof createMemoryStore>, 'Spring pricing', []);
          await changeWith(stores['staging'] as ReturnType<typeof createMemoryStore>, 'Staging copy', []);
          await changeWith(stores['staging'] as ReturnType<typeof createMemoryStore>, 'Staging extra', []);
          const { page } = await d9Page(stores);
          await page.act(`changeResume:${id}`);
          expect(page.dom.window.sessionStorage.getItem(slot())).toBe(String(id));
          await page.act('cycleEnv');
          // The store lists the newest first.
          expect(barLines(page)).toEqual(['No open change. Edits save and publish key by key.', 'Open changes in staging: Staging extra · 0 keys', 'Open changes in staging: Staging copy · 0 keys']);
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Staging link');
          await page.act('save');
          expect(draftPosts(page).at(-1)).not.toHaveProperty('change');
          await page.act('cycleEnv');
          expect(docOf(page).querySelector('#changebar h3')?.textContent).toBe('change · Spring pricing · default · 0 keys');
          page.dom.window.close();
        });

        it('Set aside keeps the change open and stops attaching new drafts', async () => {
          const stores = storesOf();
          const id = await changeWith(stores['default'] as ReturnType<typeof createMemoryStore>, 'Spring pricing', []);
          const { page } = await d9Page(stores, { session: { [slot()]: String(id) } });
          await page.act('setAside');
          expect(page.dom.window.sessionStorage.getItem(slot())).toBeNull();
          expect(barLines(page)).toEqual(['No open change. Edits save and publish key by key.', 'Open changes in default: Spring pricing · 0 keys']);
          page.dom.window.close();
        });

        it('Preview layers only the change’s drafts, with a tab per page of its span; Exit preview restores the ordinary layer (an addition)', async () => {
          const stores = storesOf();
          const id = await changeWith(stores['default'] as ReturnType<typeof createMemoryStore>, 'Spring pricing', [['lab_headline', 'Spring headline'], ['lab_button', 'Buy spring']]);
          const { page, agent } = await d9Page(stores, { session: { [slot()]: String(id) } });
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Loose link');
          await page.act('key:lab_note');
          const keysOf = (m: Record<string, unknown> | undefined): string[] => ((m?.['drafts'] as Array<{ key: string }>) ?? []).map((d) => d.key);
          expect(keysOf(agent.sent('layer').at(-1))).toEqual(['lab_link', 'lab_headline', 'lab_button']);
          await page.act('changePreview');
          expect(keysOf(agent.sent('layer').at(-1))).toEqual(['lab_headline', 'lab_button']);
          expect([...docOf(page).querySelectorAll('#paneshow [data-act^="spanPage:"]')].map((b) => b.textContent)).toEqual(['home', 'pricing']);
          await page.act('spanPage:pricing');
          expect(page.requested('/api/site/preview').at(-1)).toContain('route=%2Fpricing');
          await page.act('exitPreview');
          expect(keysOf(agent.sent('layer').at(-1))).toEqual(['lab_link', 'lab_headline', 'lab_button']);
          page.dom.window.close();
        });

        it('the page span is src/preview.ts’s, entry for entry (the parity case)', () => {
          const source = /function pageSpan\(descriptor, keys\) \{[\s\S]*?\n\}/.exec(dashboardPage())?.[0];
          expect(source).toBeDefined();
          const mirror = new Function(`const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k); ${source as string}; return pageSpan;`)() as (d: Descriptor, keys: string[]) => string[];
          const d: Descriptor = {
            version: 1,
            keys: {
              a: { shape: 'text', target: 'web', pages: ['pricing', 'home'] },
              b: { shape: 'text', target: 'web', pages: ['home', 'about'] },
              c: { shape: 'text', target: 'html-email' },
              d: { shape: 'text', target: 'web', pages: [] },
            },
            pages: { home: { route: '/' }, pricing: { route: '/pricing' }, about: { route: '/about' } },
          };
          const inputs: string[][] = [[], ['a'], ['b', 'a'], ['a', 'b', 'c', 'd'], ['gone', 'constructor', 'toString', '__proto__'], ['c', 'a', 'a']];
          for (const keys of inputs) expect({ keys, span: mirror(d, keys) }).toEqual({ keys, span: pageSpan(d, keys) });
        });
      });

      describe('undo of a published change (8.6)', () => {
        /** `Spring pricing` published over three live keys, then `lab_link` published again since. */
        const published = async (stores: Stores): Promise<number> => {
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          store.seed([
            { key: 'lab_headline', value: 'Old headline' },
            { key: 'lab_button', value: 'Old button' },
            { key: 'lab_link', value: 'Old link' },
          ]);
          const opened = (await store.changesets.open({ name: 'Spring pricing' })) as { changeId: number };
          for (const [key, value] of [['lab_headline', 'New headline'], ['lab_button', 'New button'], ['lab_link', 'New link'], ['lab_alt', 'First alt']]) {
            await store.saveDraft({ key: key as string, value, target: 'web', editor: 'dashboard:neil', change: opened.changeId });
          }
          await store.changesets.publishChange({ changeId: opened.changeId, editor: 'dashboard:neil' });
          await store.saveDraft({ key: 'lab_link', value: 'Newer link', target: 'web', editor: 'sam' });
          await store.publish({ key: 'lab_link', editor: 'sam' });
          return opened.changeId;
        };
        const strip = (page: Painted): HTMLElement => docOf(page).getElementById('paneshow') as HTMLElement;

        it('previews a change before and current from Recent, then reverts it, naming the key published since (journey B24)', async () => {
          const stores = storesOf();
          const id = await published(stores);
          const framed = await frameAgent('<h1>New headline</h1><button>New button</button><p id="link">Newer link</p><img alt="First alt">', CHANNEL);
          const { page, agent } = await d9Page(stores, { framed });
          await page.act('tab:Recent');
          await page.act('recentLoad');
          const row = [...docOf(page).querySelectorAll('#main tbody tr')].find((tr) => tr.textContent?.includes('lab_headline'));
          expect(row?.textContent).toContain('New headline · Spring pricing');
          await page.act(`previewChange:${id}`);
          expect(page.requested(`/s/${SITE_ID}/api/stet/changes?id=${id}`)).toHaveLength(1);
          expect(strip(page).querySelector('b')?.textContent).toBe('Previewing the change Spring pricing');
          expect([...strip(page).querySelectorAll('[data-act^="spanPage:"]')].map((b) => b.textContent)).toEqual(['home', 'pricing']);
          await wait(50);
          await tick();
          // Before: each member's before value swapped in where the page shows its snapshot or live words.
          expect(framed.doc.querySelector('h1')?.textContent).toBe('Old headline');
          expect(framed.doc.querySelector('button')?.textContent).toBe('Old button');
          expect(framed.doc.getElementById('link')?.textContent).toBe('Old link');
          expect(framed.doc.querySelector('img')?.getAttribute('alt')).toBe('First alt');
          // Current: the live value over the snapshot's words (F96).
          await page.act('showView:current');
          const current = agent.sent('layer').at(-1) as { drafts: Array<Record<string, unknown>> };
          expect(current.drafts.find((d) => d['key'] === 'lab_headline')).toEqual({ key: 'lab_headline', texts: ['Copy that ships'], draft: 'New headline' });

          await page.act('revertAsk');
          expect(strip(page).querySelector('.term')?.textContent).toBe('Revert Spring pricing? Restores 4 keys on home, pricing to the before values shown here, written forward as a new publish. Drafts are left alone, and a key published again since is skipped and named.');
          await page.act('revertChange');
          expect(page.sent.find((r) => r.path.startsWith(`/s/${SITE_ID}/api/stet/revert-change`))?.body).toEqual({ change: id, editor: 'dashboard:neil' });
          expect([...strip(page).querySelectorAll('.skip')].map((el) => el.textContent)).toEqual([
            'lab_link was published again since — kept as it is',
            'lab_alt had no earlier published value — left as it is',
          ]);
          const live = (await (stores['default'] as StoreAdapter).read()) as Array<{ key: string; value: unknown }>;
          expect(Object.fromEntries(live.map((r) => [r.key, r.value]))).toEqual({ lab_headline: 'Old headline', lab_button: 'Old button', lab_link: 'Newer link', lab_alt: 'First alt' });
          await page.act('exitPreview');
          expect(strip(page).hidden).toBe(true);
          page.dom.window.close();
        });
      });

      describe('the store history card (8.7)', () => {
        it('restores one past value of a key forward and leaves the other members of its change alone (journey B6)', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          store.seed([{ key: 'lab_button', value: 'Buy' }, { key: 'lab_link', value: 'Read the docs' }]);
          const opened = (await store.changesets.open({ name: 'Spring pricing' })) as { changeId: number };
          await store.saveDraft({ key: 'lab_button', value: 'Buy now', target: 'web', editor: 'agent:claude', change: opened.changeId });
          await store.saveDraft({ key: 'lab_link', value: 'Read now', target: 'web', editor: 'agent:claude', change: opened.changeId });
          const minted = (await store.changesets.publishChange({ changeId: opened.changeId, editor: 'dashboard:neil' })) as { published: Array<{ key: string; versionId: number }> };
          const v = minted.published.find((m) => m.key === 'lab_button')?.versionId as number;
          for (const [key, value] of [['lab_button', 'Buy today'], ['lab_link', 'Read later']]) {
            await store.saveDraft({ key: key as string, value: value as string, target: 'web', editor: 'sam' });
            await store.publish({ key: key as string, editor: 'sam' });
          }
          const at = (await store.history({ key: 'lab_button' }) as { rows: Array<{ id: number; publishedAt: string }> }).rows.find((r) => r.id === v)?.publishedAt as string;

          const { page, agent } = await d9Page(stores);
          await page.change('group', 'page:pricing');
          await page.act('key:lab_button');
          expect(page.requested(`/s/${SITE_ID}/api/stet/history?key=lab_button&locale=default`).length).toBeGreaterThan(0);
          const lines = [...docOf(page).querySelectorAll('#keyhistory .hline')].map((el) => el.textContent);
          const d = new Date(at);
          const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockOf(at)}`;
          expect(lines).toContain(`v${v} · ${when} · Buy now · agent:claude · Spring pricing`);
          expect(lines[0]).toMatch(/^v\d+ · .* · Buy today · sam$/);
          expect(docOf(page).querySelector(`#keyhistory [data-act="previewChange:${opened.changeId}"]`)?.textContent).toBe('Preview change');

          await page.act(`historyPreview:${v}`);
          expect(agent.sent('layer').at(-1)).toEqual({ stet: 'layer', drafts: [{ key: 'lab_button', texts: ['Buy', 'Buy today'], draft: 'Buy now' }] });
          await page.act('exitPreview');

          await page.act(`historyRestore:${v}`);
          expect(page.sent.find((r) => r.path.startsWith(`/s/${SITE_ID}/api/stet/revert`))?.body).toEqual({ key: 'lab_button', versionId: v, editor: 'dashboard:neil' });
          const live = (await store.read()) as Array<{ key: string; value: unknown; version?: number }>;
          expect(Object.fromEntries(live.map((r) => [r.key, r.value]))).toEqual({ lab_button: 'Buy now', lab_link: 'Read later' });
          expect((live.find((r) => r.key === 'lab_button')?.version as number) > v).toBe(true);
          expect([...docOf(page).querySelectorAll('#keyhistory .hline')][0]?.textContent).toMatch(/^v\d+ · .* · Buy now · /);
          page.dom.window.close();
        });
      });

      describe('the review round (D45 to D47, F1 to F7)', () => {
        const confirmOf = (page: Painted): string => docOf(page).querySelector('#takeover .term')?.textContent ?? '';
        const slot = (env = 'default'): string => `stet.change ${SITE_ID} ${env}`;
        const draftOf = async (store: StoreAdapter, key: string) => (await rowsOf(store, key)).find((r) => r.status === 'draft');
        const heldBy = async (stores: Stores, key: string) =>
          (stores['default'] as StoreAdapter).saveDraft({ key, value: 'Agent ' + key, target: 'web', editor: 'agent:claude' });
        const barOf = (page: Painted): string => docOf(page).getElementById('changebar')?.textContent ?? '';
        const dcOf = (page: Painted): string => docOf(page).getElementById('dc')?.textContent ?? '';
        const isDraftPath = (path: string): boolean => path.split('?')[0]?.endsWith('/draft') === true;

        it('P1 a plain Save after a Take over carries no force', async () => {
          const stores = storesOf();
          await heldBy(stores, 'lab_headline');
          const { page } = await d9Page(stores);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Mine');
          await page.act('save');
          await page.act('takeOver');
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Next');
          await page.act('save');
          expect(draftPosts(page).map((b) => 'force' in b)).toEqual([false, true, false]);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Mine again');
          await page.act('save');
          expect(draftPosts(page).map((b) => 'force' in b)).toEqual([false, true, false, false]);
          page.dom.window.close();
        });

        it('P2 a Take over the gate refuses (422) leaves no force for the next Save', async () => {
          const stores = storesOf();
          await heldBy(stores, 'lab_headline');
          const mount = storeMount(stores);
          const { page } = await d9Page(stores, {
            mount: async (path, body) => (isDraftPath(path) && (body as { force?: boolean } | undefined)?.force === true
              ? { status: 422, body: { error: 'over the hard limit', findings: [] } }
              : mount(path, body)),
          });
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Mine');
          await page.act('save');
          await page.act('takeOver');
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Next');
          await page.act('save');
          // The refused Take over leaves the headline unsaved, so this Save sends it again, and the agent's draft still holds it.
          expect(draftPosts(page).map((b) => 'force' in b)).toEqual([false, true, false, false]);
          expect((await draftOf(stores['default'] as StoreAdapter, 'lab_link'))?.value).toBe('Next');
          expect(confirmOf(page)).toContain('agent:claude');
          page.dom.window.close();
        });

        it('P3 a value typed after the refused save stays unsaved through Take over', async () => {
          const stores = storesOf();
          await heldBy(stores, 'lab_headline');
          const { page } = await d9Page(stores);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Mine');
          await page.act('save');
          expect(confirmOf(page)).toContain('agent:claude');
          await page.type('text:lab_headline', 'Mine, newer');
          await page.act('takeOver');
          expect((await draftOf(stores['default'] as StoreAdapter, 'lab_headline'))?.value).toBe('Mine');
          expect(fieldOf(page, 'lab_headline').value).toBe('Mine, newer');
          expect(dcOf(page)).toBe('1 unsaved edit');
          page.dom.window.close();
        });

        it('P4 Revert change posts the previewed change, not the active one', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          store.seed([{ key: 'lab_headline', value: 'Old headline' }]);
          const done = (await store.changesets.open({ name: 'Done' })) as { changeId: number };
          await store.saveDraft({ key: 'lab_headline', value: 'New headline', target: 'web', editor: 'dashboard:neil', change: done.changeId });
          await store.changesets.publishChange({ changeId: done.changeId, editor: 'dashboard:neil' });
          const live = (await store.changesets.open({ name: 'Live one' })) as { changeId: number };
          const { page } = await d9Page(stores, { session: { [slot()]: String(live.changeId) } });
          await page.act('tab:Recent');
          await page.act('recentLoad');
          await page.act(`previewChange:${done.changeId}`);
          await page.act('revertAsk');
          await page.act('revertChange');
          expect(page.sent.find((r) => r.path.includes('/revert-change'))?.body).toEqual({ change: done.changeId, editor: 'dashboard:neil' });
          page.dom.window.close();
        });

        it('P5 a slow answer from the environment left behind does not replace the new environment’s rows', async () => {
          const stores = storesOf();
          await (stores['default'] as StoreAdapter).saveDraft({ key: 'lab_headline', value: 'Default only', target: 'web', editor: 'agent:claude' });
          await (stores['staging'] as StoreAdapter).saveDraft({ key: 'lab_link', value: 'Staging only', target: 'web', editor: 'agent:claude' });
          const mount = storeMount(stores);
          let slow = false;
          const { page } = await d9Page(stores, {
            mount: async (path, body) => {
              const res = await mount(path, body);
              if (slow && path.split('?')[0]?.endsWith('/keys') && !path.includes('env=staging')) await new Promise((r) => setTimeout(r, 400));
              return res;
            },
          });
          slow = true;
          // A read of the default environment is in flight when the switch happens, and answers last.
          void page.dom.window.eval('loadRows()');
          await page.act('cycleEnv');
          await page.settle();
          await new Promise((r) => setTimeout(r, 700));
          await page.settle();
          const drafts = (await page.dom.window.eval('JSON.stringify(S.rows.filter((r)=>r.status==="draft").map((r)=>r.key))')) as string;
          expect(drafts).toBe('["lab_link"]');
          page.dom.window.close();
        });

        it('P5b until the new environment answers, the rows of the one left behind are not shown', async () => {
          const stores = storesOf();
          await (stores['default'] as StoreAdapter).saveDraft({ key: 'lab_headline', value: 'Default only', target: 'web', editor: 'agent:claude' });
          const mount = storeMount(stores);
          const { page } = await d9Page(stores, {
            mount: async (path, body) => {
              if (path.split('?')[0]?.endsWith('/keys') && path.includes('env=staging')) await new Promise((r) => setTimeout(r, 400));
              return mount(path, body);
            },
          });
          await page.act('cycleEnv');
          expect(await page.dom.window.eval('S.rows')).toBeNull();
          await new Promise((r) => setTimeout(r, 700));
          await page.settle();
          expect(await page.dom.window.eval('S.rows.some((r) => r.status === "draft")')).toBe(false);
          page.dom.window.close();
        });

        it('P6 a save refused for a closed change says the change is closed, and the next Save goes outside any change', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const { page } = await d9Page(stores);
          await page.act('changeNew');
          await page.type('changeName', 'Held');
          await page.act('changeCreate');
          const id = Number(page.dom.window.sessionStorage.getItem(slot()));
          await store.saveDraft({ key: 'lab_headline', value: 'In', target: 'web', editor: 'dashboard:neil', change: id });
          await store.changesets.publishChange({ changeId: id, editor: 'agent:claude' });
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'After close');
          await page.act('save');
          expect(barOf(page)).toContain('Held is closed. Edits now save on their own, outside any change.');
          expect(barOf(page)).not.toContain('change_closed');
          expect(page.dom.window.sessionStorage.getItem(slot())).toBeNull();
          expect(docOf(page).getElementById('refusal')?.textContent ?? '').not.toContain('change_closed');
          expect(dcOf(page)).toBe('1 unsaved edit');
          await page.act('save');
          expect(draftPosts(page).at(-1)).not.toHaveProperty('change');
          expect(await draftOf(store, 'lab_link')).toMatchObject({ value: 'After close', changesetId: null });
          page.dom.window.close();
        });

        it('P6b a refresh that finds the active change gone from the open list drops it and says it is closed', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = (await store.changesets.open({ name: 'Away' }) as { changeId: number }).changeId;
          const { page } = await d9Page(stores, { session: { [slot()]: String(id) } });
          expect(barOf(page)).toContain('change · Away');
          await store.changesets.abandon({ changeId: id });
          await page.dom.window.eval('loadChanges(false)');
          await page.settle();
          expect(barOf(page)).toContain('Away is closed. Edits now save on their own, outside any change.');
          expect(page.dom.window.sessionStorage.getItem(slot())).toBeNull();
          expect(await page.dom.window.eval('S.change')).toBeNull();
          page.dom.window.close();
        });

        it('P6c Add and Take over refused for a closed change say so too', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = (await store.changesets.open({ name: 'Gone' }) as { changeId: number }).changeId;
          await store.saveDraft({ key: 'lab_link', value: 'loose', target: 'web', editor: 'dashboard:neil' });
          const { page } = await d9Page(stores, { session: { [slot()]: String(id) } });
          await store.changesets.abandon({ changeId: id });
          await page.act('addToChange');
          expect(barOf(page)).toContain('Gone is closed. Edits now save on their own, outside any change.');
          expect(barOf(page)).not.toContain('no_change');
          expect(barOf(page)).not.toContain('change_closed');
          page.dom.window.close();
        });

        it('P7 a failed Remove shows its error in the change bar with no key selected', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = (await store.changesets.open({ name: 'C' }) as { changeId: number }).changeId;
          await store.saveDraft({ key: 'lab_headline', value: 'm', target: 'web', editor: 'dashboard:neil', change: id });
          const mount = storeMount(stores);
          let failing = false;
          const { page } = await d9Page(stores, {
            session: { [slot()]: String(id) },
            mount: async (path, body) => (failing && isDraftPath(path) ? { status: 500, body: { error: 'the store is unreachable' } } : mount(path, body)),
          });
          failing = true;
          const remove = [...docOf(page).querySelectorAll('[data-act^="removeMember:"]')][0]?.getAttribute('data-act') as string;
          await page.act(remove);
          expect(barOf(page)).toContain('the store is unreachable');
          failing = false;
          await page.act(remove);
          expect(barOf(page)).not.toContain('the store is unreachable');
          page.dom.window.close();
        });

        it('P7b a failed Add shows its error in the change bar', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = (await store.changesets.open({ name: 'C' }) as { changeId: number }).changeId;
          await store.saveDraft({ key: 'lab_link', value: 'loose', target: 'web', editor: 'dashboard:neil' });
          const mount = storeMount(stores);
          const { page } = await d9Page(stores, {
            session: { [slot()]: String(id) },
            mount: async (path, body) => (isDraftPath(path) ? { status: 500, body: { error: 'the store is unreachable' } } : mount(path, body)),
          });
          await page.act('addToChange');
          expect(barOf(page)).toContain('the store is unreachable');
          page.dom.window.close();
        });

        it('P7c a failed Create keeps the form and shows its error', async () => {
          const stores = storesOf();
          const mount = storeMount(stores);
          const { page } = await d9Page(stores, {
            mount: async (path, body) => (path.split('?')[0]?.endsWith('/changes') && body !== undefined ? { status: 500, body: { error: 'the store is unreachable' } } : mount(path, body)),
          });
          await page.act('changeNew');
          await page.type('changeName', 'Spring');
          await page.act('changeCreate');
          expect(barOf(page)).toContain('the store is unreachable');
          expect((docOf(page).querySelector('[data-act-input="changeName"]') as HTMLInputElement | null)?.value).toBe('Spring');
          await page.act('changeFormCancel');
          expect(barOf(page)).not.toContain('the store is unreachable');
          page.dom.window.close();
        });

        it('P7d a failed Restore shows its error in the History card', async () => {
          const stores = storesOf();
          const store = stores['default'] as ReturnType<typeof createMemoryStore>;
          store.seed([{ key: 'lab_button', value: 'Buy' }]);
          await store.saveDraft({ key: 'lab_button', value: 'Buy now', target: 'web', editor: 'dashboard:neil' });
          await store.publish({ key: 'lab_button', editor: 'dashboard:neil' });
          const mount = storeMount(stores);
          const { page } = await d9Page(stores, {
            mount: async (path, body) => (path.split('?')[0]?.endsWith('/revert') ? { status: 500, body: { error: 'the store is unreachable' } } : mount(path, body)),
          });
          await page.change('group', 'page:pricing');
          await page.act('key:lab_button');
          const restore = docOf(page).querySelector('#keyhistory [data-act^="historyRestore:"]')?.getAttribute('data-act') as string;
          await page.act(restore);
          expect(docOf(page).getElementById('keyhistory')?.textContent).toContain('the store is unreachable');
          page.dom.window.close();
        });

        it('P8 Save pressed twice over a held draft queues one confirm', async () => {
          const stores = storesOf();
          await heldBy(stores, 'lab_headline');
          const { page } = await d9Page(stores);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Mine');
          await page.act('save');
          await page.act('save');
          expect(await page.dom.window.eval('S.held.length')).toBe(1);
          page.dom.window.close();
        });

        it('P9 Remove, Add and Take over in staging write to staging', async () => {
          const stores = storesOf();
          const staging = stores['staging'] as ReturnType<typeof createMemoryStore>;
          const dflt = stores['default'] as ReturnType<typeof createMemoryStore>;
          const id = (await staging.changesets.open({ name: 'S' }) as { changeId: number }).changeId;
          await staging.saveDraft({ key: 'lab_headline', value: 'member', target: 'web', editor: 'dashboard:neil', change: id });
          await staging.saveDraft({ key: 'lab_link', value: 'agent loose', target: 'web', editor: 'agent:claude' });
          const { page } = await d9Page(stores, { session: { [slot('staging')]: String(id) } });
          await page.act('cycleEnv');
          const remove = [...docOf(page).querySelectorAll('[data-act^="removeMember:"]')][0]?.getAttribute('data-act') as string;
          await page.act(remove);
          await page.act('addToChange');
          await page.act('takeOver');
          const paths = page.sent.filter((r) => r.path.split('?')[0] === `/s/${SITE_ID}/api/stet/draft`).map((r) => r.path);
          expect(paths.length).toBeGreaterThanOrEqual(3);
          for (const p of paths) expect(p).toContain('env=staging');
          expect((await rowsOf(staging, 'lab_link')).find((r) => r.status === 'draft')).toMatchObject({ editor: 'dashboard:neil', changesetId: id });
          expect((await rowsOf(dflt, 'lab_link')).length).toBe(0);
          page.dom.window.close();
        });

        it('D45 unsaved edits belong to their environment: a switch shows that environment’s own, Save writes only those, and switching back restores the first', async () => {
          const stores = storesOf();
          const dflt = stores['default'] as StoreAdapter;
          const staging = stores['staging'] as StoreAdapter;
          const { page, agent } = await d9Page(stores);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Typed on default');
          expect(dcOf(page)).toBe('1 unsaved edit');
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Link on default');
          expect(dcOf(page)).toBe('2 unsaved edits');
          await page.act('key:lab_headline');

          await page.act('cycleEnv');
          expect(dcOf(page)).toBe('');
          expect(fieldOf(page, 'lab_headline').value).toBe('Copy that ships');
          expect((agent.sent('layer').at(-1) as { drafts: unknown[] }).drafts).toEqual([]);
          await page.act('save');
          expect(draftPosts(page)).toEqual([]);
          expect(await draftOf(staging, 'lab_headline')).toBeUndefined();
          expect(await draftOf(dflt, 'lab_headline')).toBeUndefined();

          await page.type('text:lab_headline', 'Typed on staging');
          expect(dcOf(page)).toBe('1 unsaved edit');
          await page.act('cycleEnv');
          expect(dcOf(page)).toBe('2 unsaved edits');
          expect(fieldOf(page, 'lab_headline').value).toBe('Typed on default');
          expect(JSON.stringify(agent.sent('layer').at(-1))).toContain('Link on default');
          await page.act('cycleEnv');
          expect(fieldOf(page, 'lab_headline').value).toBe('Typed on staging');
          expect(dcOf(page)).toBe('1 unsaved edit');
          await page.act('cycleEnv');

          await page.act('save');
          expect(draftPosts(page).map((b) => b['value'])).toEqual(['Typed on default', 'Link on default']);
          for (const r of page.sent.filter((s) => isDraftPath(s.path))) expect(r.path).not.toContain('env=');
          expect((await draftOf(dflt, 'lab_headline'))?.value).toBe('Typed on default');
          expect((await draftOf(dflt, 'lab_link'))?.value).toBe('Link on default');
          expect(await draftOf(staging, 'lab_headline')).toBeUndefined();
          expect(dcOf(page)).toBe('');
          await page.act('cycleEnv');
          expect(dcOf(page)).toBe('1 unsaved edit');
          expect(fieldOf(page, 'lab_headline').value).toBe('Typed on staging');
          page.dom.window.close();
        });

        it('D45 an edit open in the field ends kept before the environment changes, so it stays with the environment it was typed in', async () => {
          const stores = storesOf();
          const { page, agent } = await d9Page(stores);
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'Typed on default');
          await page.dom.window.eval(`S.edit = { key: 'lab_headline', locale: 'default', entry: undefined, form: 'text', before: undefined, rect: { left: 0, top: 0, width: 1, height: 1 } }`);
          await page.act('cycleEnv');
          expect(await page.dom.window.eval('S.edit')).toBeNull();
          expect(agent.sent('end').at(-1)).toEqual({ stet: 'end', how: 'keep' });
          await page.act('cycleEnv');
          expect(fieldOf(page, 'lab_headline').value).toBe('Typed on default');
          page.dom.window.close();
        });

        it('D47 a Save that is running stays in the environment it started in: every key goes there, with its change', async () => {
          const stores = storesOf();
          const dflt = stores['default'] as ReturnType<typeof createMemoryStore>;
          const staging = stores['staging'] as StoreAdapter;
          const id = (await dflt.changesets.open({ name: 'Mid' }) as { changeId: number }).changeId;
          const mount = storeMount(stores);
          let flip: () => void = () => undefined;
          let flipped = false;
          const { page } = await d9Page(stores, {
            session: { [slot()]: String(id) },
            mount: async (path, body) => {
              const res = await mount(path, body);
              if (!flipped && isDraftPath(path)) { flipped = true; flip(); }
              return res;
            },
          });
          flip = () => (docOf(page).querySelector('[data-act="cycleEnv"]') as HTMLElement).click();
          await page.act('key:lab_headline');
          await page.type('text:lab_headline', 'First');
          await page.act('key:lab_link');
          await page.type('text:lab_link', 'Second');
          await page.act('save');
          expect(await page.dom.window.eval('S.env')).toBe('staging');
          const posts = page.sent.filter((r) => isDraftPath(r.path));
          expect(posts).toHaveLength(2);
          for (const r of posts) expect(r.path).not.toContain('env=');
          expect(posts.map((r) => (r.body as { change?: number }).change)).toEqual([id, id]);
          expect(await draftOf(dflt, 'lab_headline')).toMatchObject({ value: 'First', changesetId: id });
          expect(await draftOf(dflt, 'lab_link')).toMatchObject({ value: 'Second', changesetId: id });
          expect(await draftOf(staging, 'lab_headline')).toBeUndefined();
          expect(await draftOf(staging, 'lab_link')).toBeUndefined();
          await page.act('cycleEnv');
          expect(dcOf(page)).toBe('');
          page.dom.window.close();
        });

        it('D46 two tabs of one profile are one editor: the second tab’s Save replaces the first tab’s draft with no confirm', async () => {
          const stores = storesOf();
          const one = await d9Page(stores);
          const two = await d9Page(stores);
          await one.page.act('key:lab_headline');
          await one.page.type('text:lab_headline', 'Tab one');
          await one.page.act('save');
          await two.page.act('key:lab_headline');
          await two.page.type('text:lab_headline', 'Tab two');
          await two.page.act('save');
          expect(confirmOf(two.page)).toBe('');
          expect((await draftOf(stores['default'] as StoreAdapter, 'lab_headline'))?.value).toBe('Tab two');
          one.page.dom.window.close();
          two.page.dom.window.close();
        });
      });

      // D9 marker: later describes go above this line.
      it('force is never sent without the press: every draft POST across these cases carries it only after a Take over (8.4, stage 5)', () => {
        let forced = 0;
        for (const { page, presses } of audits) {
          const drafts = page.sent
            .map((r, i) => ({ i, path: r.path.split('?')[0], body: r.body as Record<string, unknown> | undefined }))
            .filter((r) => r.path === `/s/${SITE_ID}/api/stet/draft`);
          // The first draft POST each press answers: the one write a Take over makes.
          const answers = presses.map((p) => drafts.find((r) => r.i >= p)?.i);
          for (const r of drafts.filter((d) => d.body !== undefined && 'force' in d.body)) {
            expect(r.body?.['force']).toBe(true);
            expect(answers).toContain(r.i);
          }
          forced += drafts.filter((d) => d.body !== undefined && 'force' in d.body).length;
        }
        expect(audits.length).toBeGreaterThan(5);
        expect(forced).toBeGreaterThan(0);
      });
    });
  });

  it('loads the pane when a site opens, and starts nothing (F37)', async () => {
    const html = await paint({
      site: siteBody({ host: 'html' }),
      preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
    });
    expect(html.requested('/api/site/preview')).toHaveLength(1);
    expect(docOf(html).querySelector('#devwrap iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
    html.dom.window.close();

    const js = await paint();
    expect(js.requested('/api/site/preview')).toHaveLength(1);
    expect(js.requested('/api/site/dev-start')).toEqual([]);
    js.dom.window.close();
  });

  it('chooses the first group only once the marks have answered', async () => {
    const late = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 200, allMarkedIn('index.html', null), 50]],
    });
    expect(await until(() => late.keys().length > 0 || painted(late).includes('No keys.'))).toBe(true);
    // The route is the first group's, the document's; the list shows every key.
    expect((docOf(late).getElementById('gsel') as HTMLSelectElement).value).toBe('all');
    expect(late.dom.window.eval('JSON.stringify([firstGroup(), S.route === groupRoute(firstGroup())])')).toBe('["doc:index.html",true]');
    expect(late.keys()).toEqual(Object.keys(descriptor.keys).sort());
    // The page record names `seo_home_title`, so the SEO group holds it and the document the rest.
    await late.change('group', 'doc:index.html');
    expect(late.keys()).toEqual(Object.keys(descriptor.keys).filter((id) => id !== 'seo_home_title').sort());
    late.dom.window.close();

    const refused = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 409, { error: 'index.html could not be read' }]],
    });
    // With no marks there is no document group; the site still opens on its visible text, not on SEO.
    expect((docOf(refused).getElementById('gsel') as HTMLSelectElement).value).toBe('all');
    expect(refused.dom.window.eval('firstGroup()')).toBe('prefix:brand');
    refused.dom.window.close();
  });

  it('keeps a route typed while the start wait repaints the pane, and its caret (journey B19)', async () => {
    let reads = 0;
    const page = await paint({
      routes: [['/api/site/dev-log', 200, () => ({ running: true, state: 'running', lines: [`line ${(reads += 1)}`] })]],
    });
    const doc = docOf(page);
    await page.act('devStart');
    expect(painted(page)).toContain('Starting');
    const route = doc.getElementById('route') as HTMLInputElement;
    route.focus();
    const typeInto = (text: string): void => {
      for (const ch of text) {
        route.value += ch;
        route.selectionStart = route.value.length;
        route.selectionEnd = route.value.length;
        route.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
      }
    };
    typeInto('docs/quick');
    const before = reads;
    expect(await until(() => reads > before, 3_000)).toBe(true);
    await page.settle();
    typeInto('start/');
    expect(doc.getElementById('route')).toBe(route);
    expect(doc.activeElement).toBe(route);
    expect(route.value).toBe('/docs/quickstart/');
    expect(route.selectionStart).toBe(route.value.length);
    expect(page.requested('/api/site/preview').every((path) => path.endsWith('route=%2F'))).toBe(true);
    route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    await page.settle();
    expect(page.requested('/api/site/preview').filter((path) => path.endsWith('route=%2Fdocs%2Fquickstart%2F'))).toHaveLength(1);
    page.dom.window.close();
  }, 10_000);

  // 5.6 — Start shows the site
  it('shows the start, then the site once the dev server answers, with no click (journey B19)', async () => {
    const page = await paint({ preview: DOWN });
    await page.act('devStart');
    expect(painted(page)).toContain('Starting <span class="mono">npx astro dev</span> — waiting for <span class="mono">http://localhost:4321/</span>.');
    expect(docOf(page).querySelector('[data-act="devStart"]')).toBeNull();
    page.answer('/api/site/preview', 200, UP);
    expect(await until(() => docOf(page).querySelector('#devwrap iframe') !== null, 3_000)).toBe(true);
    page.dom.window.close();
  }, 10_000);

  it('ends the wait on a launcher that exits non-zero, with its log', async () => {
    const page = await paint({ preview: DOWN });
    await page.act('devStart');
    page.answer('/api/site/dev-log', 200, { running: false, state: 'exited', code: 1, lines: ['boom'] });
    expect(await until(() => painted(page).includes('The dev server exited before it answered. Its log is below.'), 3_000)).toBe(true);
    expect(docOf(page).querySelector('#panebody .term')?.textContent).toBe('boom');
    page.dom.window.close();
  }, 10_000);

  it('keeps waiting through a launcher’s clean exit, and loads the site it left running', async () => {
    const page = await paint({ preview: DOWN });
    let polls = 0;
    page.answer('/api/site/preview', 200, () => ((polls += 1) >= 2 ? UP : DOWN));
    page.answer('/api/site/dev-log', 200, { running: false, state: 'exited', code: 0, lines: [] });
    await page.act('devStart');
    expect(await until(() => docOf(page).querySelector('#devwrap iframe') !== null, 4_000)).toBe(true);
    expect(painted(page)).not.toContain('exited before it answered');
    page.dom.window.close();
  }, 10_000);

  it('ends a start wait when the site changes', async () => {
    const page = await paint({ preview: DOWN });
    await page.act('devStart');
    await page.act('site:/checkouts/other');
    const mini = (): number => page.requested('/api/site/preview?site=%2Fcheckouts%2Fmini').length;
    const held = mini();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(mini()).toBe(held);
    page.dom.window.close();
  }, 10_000);

  it('ends a start wait on Stop, says it is stopping, and never reads the kill as a failed start (journey B19)', async () => {
    const page = await paint({ preview: DOWN, routes: [['/api/site/dev-log', 200, { running: true, state: 'running', lines: ['up soon'] }]] });
    const doc = docOf(page);
    await page.act('devStart');
    page.answer('/api/site/dev-stop', 200, { running: false, state: 'stopped', lines: [] }, 300);
    page.answer('/api/site/dev-log', 200, { running: false, state: 'exited', code: 143, lines: ['terminated'] });
    const before = page.requested('/api/site/preview').length;
    await page.act('devStop');
    expect(painted(page)).toContain('Stopping the dev server…');
    expect(doc.querySelector('[data-act="devStart"]')).toBeNull();
    expect(doc.querySelector('[data-act="devStop"]')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    // One probe after Stop answers — the pane's own — and no wait probe.
    expect(page.requested('/api/site/preview').length - before).toBe(1);
    expect(painted(page)).not.toContain('exited before it answered');
    expect(doc.querySelector('[data-act="devStart"]')).not.toBeNull();
    page.dom.window.close();
  }, 10_000);

  it('offers Stop while the log says the dev server runs, though the probe answers down', async () => {
    const page = await paint({ preview: DOWN, routes: [['/api/site/dev-log', 200, { running: true, state: 'running', lines: [] }]] });
    expect(docOf(page).querySelector('[data-act="devStop"]')).toBeNull();
    await page.act('devLog');
    expect(docOf(page).querySelector('[data-act="devStop"]')).not.toBeNull();
    page.dom.window.close();
  });

  // 5.7 — groups, search, the row preview, the refusal lines
  it('groups keys by page, then by prefix, with no Other (journey A19)', async () => {
    const page = await paint();
    const labels = [...docOf(page).querySelectorAll('#gsel option')].map((option) => option.textContent);
    expect(labels).toEqual(['All keys', 'This page', 'home — page', 'SEO', 'brand', 'loose', 'unseeded', 'welcome']);
    await page.change('group', 'seo');
    expect(page.keys()).toEqual(['seo_home_title']);
    expect(painted(page)).not.toContain('>Other<');
    page.dom.window.close();
  });

  it('groups an html host’s keys by the document they are marked in, then by its page (journeys A19, B17)', async () => {
    // A query every key name matches lists every key with its group's label beside it.
    const groupOfEveryRow = async (page: Painted): Promise<Record<string, string>> => {
      await page.type('search', '_');
      expect(page.keys()).toEqual(Object.keys(descriptor.keys).sort());
      return Object.fromEntries(
        [...docOf(page).querySelectorAll('[data-act^="key:"]')].map((row) => [
          (row.getAttribute('data-act') ?? '').slice('key:'.length),
          [...row.querySelectorAll('.bdg')].at(-1)?.textContent ?? '',
        ]),
      );
    };
    // Every key in the one group but the page record's SEO title, which the SEO group holds.
    const expected = (label: string): Record<string, string> =>
      Object.fromEntries(Object.keys(descriptor.keys).sort().map((id) => [id, id === 'seo_home_title' ? 'SEO' : label]));
    const byDocument = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 200, allMarkedIn('index.html', null)]],
    });
    // The list opens on every key; the groups are as before.
    expect((docOf(byDocument).getElementById('gsel') as HTMLSelectElement).value).toBe('all');
    expect(await groupOfEveryRow(byDocument)).toEqual(expected('index.html'));
    byDocument.dom.window.close();

    const byPage = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 200, allMarkedIn('index.html', 'home')]],
    });
    expect((docOf(byPage).getElementById('gsel') as HTMLSelectElement).value).toBe('all');
    expect(await groupOfEveryRow(byPage)).toEqual(expected('home — page'));
    byPage.dom.window.close();
  });

  it('searches every group and keeps the key being edited, its row following the typing (journey B18)', async () => {
    const page = await paint({ preview: UP });
    const doc = docOf(page);
    const frame = doc.querySelector('#devwrap iframe');
    await page.change('group', 'prefix:brand');
    await page.type('search', 'Ship');
    expect(page.keys()).toEqual(['hero_headline']);
    const badges = [...(doc.querySelector('[data-act="key:hero_headline"]')?.querySelectorAll('.bdg') ?? [])].map((b) => b.textContent);
    expect(badges).toContain('home — page');
    expect(doc.getElementById('gsel')).toBeNull();

    await page.act('key:hero_headline');
    // The first keystroke flips the page dirty and repaints; the second repaints
    // only the row.
    await page.type('text:hero_headline', 'Unrelated');
    await page.type('text:hero_headline', 'Unrelated words');
    expect(page.keys()).toEqual(['hero_headline']);
    expect(doc.querySelector('.row.on .s')?.textContent).toBe('Unrelated words');
    expect(doc.querySelector('#devwrap iframe')).toBe(frame);

    // Saved: the value on disk no longer matches the query and nothing is
    // unsaved, so only being the key in the editor keeps it listed.
    page.answer('/api/site/save', 200, { written: ['stet/defaults.json'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
    await page.act('save');
    expect(page.keys()).toEqual(['hero_headline']);
    page.dom.window.close();
  });

  it('clears a save’s refusal once the value changes, and draws it again on the next refusal (journey B18)', async () => {
    const page = await paint();
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'x'.repeat(71));
    await page.act('save');
    await page.act('saveAnyway');
    expect(painted(page)).toContain('71 characters over a 60 limit');
    await page.type('text:hero_headline', 'x'.repeat(72));
    expect(painted(page)).not.toContain('71 characters over a 60 limit');
    expect(docOf(page).getElementById('refusal')).toBeNull();
    await page.act('save');
    await page.act('saveAnyway');
    expect(painted(page)).toContain('71 characters over a 60 limit');
    page.dom.window.close();
  });

  it('clears the add-path error on a successful add', async () => {
    const page = await paint();
    const doc = docOf(page);
    const err = (): HTMLElement => doc.getElementById('adderr') as HTMLElement;
    page.answer('/api/workspace/add', 400, { error: 'relative: a workspace path must be absolute' });
    (doc.getElementById('addpath') as HTMLInputElement).value = 'relative';
    await page.act('addSite');
    expect(err().style.display).toBe('');
    expect(err().textContent).toBe('relative: a workspace path must be absolute');
    page.answer('/api/workspace/add', 200, { added: true, path: '/checkouts/mini', sites: page.workspace.sites });
    (doc.getElementById('addpath') as HTMLInputElement).value = '/checkouts/mini';
    await page.act('addSite');
    expect(err().style.display).toBe('none');
    expect(err().textContent).toBe('');
    page.dom.window.close();
  });

  // 5.8 — History, Recent and Setup by host
  it('labels History and Recent by what an html host logs, and gives its Setup no dev-server fields (journeys B17, B19)', async () => {
    const html = await paint({
      site: siteBody({ host: 'html', config: { ...(siteBody()['config'] as object), host: 'html' }, dev: null }),
      preview: { url: `http://127.0.0.1:4400/s/${SITE_ID}/site/`, up: true, static: true },
      routes: [['/api/site/history', 200, { commits: [] }]],
    });
    expect(painted(html)).toContain('the commits that touched the snapshot or the pages');
    await html.act('history');
    expect(painted(html)).toContain('No commits touch the snapshot or the pages yet.');
    await html.act('tab:Recent');
    expect(painted(html)).toContain('A publish here is a commit, so this is the log of the snapshot and the pages.');
    await html.act('tab:Setup');
    expect(painted(html)).toContain('stet dev serves this site’s pages itself, so it needs no dev server.');
    expect(docOf(html).querySelector('[data-act-change="entryDev"]')).toBeNull();
    html.dom.window.close();

    const js = await paint({ routes: [['/api/site/history', 200, { commits: [] }]] });
    expect(painted(js)).toContain('the commits that touched the snapshot</span>');
    await js.act('history');
    expect(painted(js)).toContain('No commits touch the snapshot yet.');
    await js.act('tab:Setup');
    expect((docOf(js).getElementById('devcmd') as HTMLInputElement).placeholder).toBe('npx astro dev');
    expect((docOf(js).getElementById('devurl') as HTMLInputElement).placeholder).toBe('http://localhost:4321');
    js.dom.window.close();
  });

  // --- add-key-context: History inside its card, and the key column's width ---

  it('shows a commit’s date with the minute under it, and its author under the subject', async () => {
    const page = await paint({
      routes: [
        [
          '/api/site/history',
          200,
          {
            commits: [
              { sha: '0044dd9aa', short: '0044dd9', author: 'nj-io', at: '2026-09-25T09:41:09+07:00', subject: 'stet: 1 key updated — understand_what_exists_how_it_was' },
              { sha: '1234567aa', short: '1234567', author: 'dev', at: 'yesterday', subject: 'A <b>bold</b> claim' },
            ],
          },
        ],
      ],
    });
    await page.act('history');
    const rows = [...docOf(page).querySelectorAll('table.fixed tbody tr')];
    const cells = (row: Element): Element[] => [...row.querySelectorAll('td')];
    const [first, second] = rows as [Element, Element];
    expect(cells(first).map((cell) => cell.innerHTML)).toEqual([
      '0044dd9',
      '2026-09-25<br>09:41',
      'stet: 1 key updated — understand_what_exists_how_it_was<div class="muted mono" style="font-size:11px">nj-io</div>',
    ]);
    expect(cells(first)[1]?.getAttribute('title')).toBe('2026-09-25T09:41:09+07:00');
    expect(cells(second)[1]?.textContent).toBe('yesterday');
    expect(cells(second)[2]?.querySelector('b')).toBeNull();
    expect(cells(second)[2]?.firstChild?.textContent).toBe('A <b>bold</b> claim');
    expect([...docOf(page).querySelectorAll('table.fixed th')].map((th) => th.textContent)).toEqual(['Commit', 'When', 'Subject']);
    page.dom.window.close();
  });

  describe('the key column’s width', () => {
    const grip = (page: Painted): HTMLElement => docOf(page).getElementById('grip') as HTMLElement;
    const width = (page: Painted): string => (docOf(page).getElementById('work') as HTMLElement).style.getPropertyValue('--colw');
    const press = async (page: Painted, key: string, shiftKey = false): Promise<void> => {
      grip(page).focus();
      grip(page).dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
      await page.settle();
    };

    it('paints the remembered width, and moves it with the keys', async () => {
      const page = await paint({ storage: { 'stet.column.width': '420' } });
      expect(grip(page).getAttribute('role')).toBe('separator');
      expect(grip(page).getAttribute('aria-label')).toBe('Resize the key column');
      expect(grip(page).getAttribute('title')).toBe('Drag to resize the key column. Double-click to restore its width.');
      expect(width(page)).toBe('420px');
      expect(grip(page).getAttribute('aria-valuenow')).toBe('420');
      await press(page, 'ArrowRight');
      expect([width(page), page.storage()['stet.column.width']]).toEqual(['436px', '436']);
      await press(page, 'ArrowLeft', true);
      expect([width(page), page.storage()['stet.column.width']]).toEqual(['372px', '372']);
      await press(page, 'Home');
      expect(width(page)).toBe('240px');
      await press(page, 'End');
      expect([width(page), grip(page).getAttribute('aria-valuenow')]).toEqual(['720px', '720']);
      page.dom.window.close();
    });

    it('clamps a stored width it cannot show, and keeps it', async () => {
      const wide = await paint({ storage: { 'stet.column.width': '9999' } });
      expect(width(wide)).toBe('720px');
      expect(wide.storage()['stet.column.width']).toBe('9999');
      wide.dom.window.close();
      for (const held of ['abc', '']) {
        const page = await paint({ storage: { 'stet.column.width': held } });
        expect(width(page)).toBe('300px');
        page.dom.window.close();
      }
    });

    it('restores the default on a double-click and forgets the stored width', async () => {
      const page = await paint({ storage: { 'stet.column.width': '420' } });
      grip(page).dispatchEvent(new page.dom.window.MouseEvent('dblclick', { bubbles: true }));
      await page.settle();
      expect([width(page), page.storage()['stet.column.width']]).toEqual(['300px', '']);
      page.dom.window.close();
    });

    it('works with no storage at all', async () => {
      const page = await paint({
        prepare(window) {
          Object.defineProperty(window, 'localStorage', {
            get() {
              throw new Error('storage is disabled');
            },
          });
        },
      });
      expect(page.errors).toEqual([]);
      expect(width(page)).toBe('300px');
      await press(page, 'ArrowRight');
      expect(width(page)).toBe('316px');
      page.dom.window.close();
    });

    it('is hidden with the keys', async () => {
      const page = await paint();
      await page.act('keys');
      expect((docOf(page).getElementById('work') as HTMLElement).className).toContain('wide');
      page.dom.window.close();
    });
  });

  // --- add-psyon-followups: Save, the first page, same words, limits, branch, restore, split ---
  describe('the psyon follow-ups', () => {
    const saveButton = (page: Painted): HTMLButtonElement => docOf(page).querySelector('[data-act="save"]') as HTMLButtonElement;
    const saveState = (page: Painted): { label: string; blue: boolean; grey: boolean } => ({
      label: saveButton(page).textContent ?? '',
      blue: saveButton(page).classList.contains('pri'),
      grey: saveButton(page).disabled,
    });
    const SAVED = { label: 'Saved', blue: false, grey: true };
    const SAVE = { label: 'Save', blue: true, grey: false };

    it('Save greys when nothing differs (journey B18)', async () => {
      const page = await paint({ site: siteBody({ git: { head: 'abc1234', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false } }) });
      await page.act('key:hero_headline');
      expect(saveState(page)).toEqual(SAVED);
      expect(saveButton(page).getAttribute('title')).toBe('Saves to stet/defaults.json on this machine. Commit from the header when the change is ready.');
      await page.type('text:hero_headline', 'Ship the copies');
      expect(saveState(page)).toEqual(SAVE);
      await page.type('text:hero_headline', 'Ship the copy');
      expect(saveState(page)).toEqual(SAVED);
      expect((docOf(page).getElementById('dc') as HTMLElement).hidden).toBe(true);
      await page.type('text:hero_headline', 'Ship the words');
      page.answer('/api/site/save', 200, { written: ['stet/defaults.json', 'stet/defaults.ts'], unchanged: [], findings: [], at: {}, pending: ['stet/defaults.json'] });
      await page.act('save');
      expect(saveState(page)).toEqual(SAVED);
      expect(docOf(page).querySelector('#gitbar span')?.textContent).toBe('1 stet file not yet committed');
      expect(docOf(page).querySelector('#gitbar [data-act="commit"]')?.classList.contains('pri')).toBe(true);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('leaves no draft when a field whose locale holds no value is typed and cleared', async () => {
      const page = await paint();
      await page.change('locale', 'de');
      await page.change('group', 'prefix:loose');
      await page.act('key:loose_key');
      expect(saveState(page)).toEqual(SAVED);
      await page.type('text:loose_key', 'lose');
      expect(saveState(page)).toEqual(SAVE);
      await page.type('text:loose_key', '');
      expect(saveState(page)).toEqual(SAVED);
      await page.act('key:loose_key');
      expect(docOf(page).querySelector('[data-act="key:loose_key"] .bdg.d')).toBeNull();
      page.dom.window.close();
    });

    it('keeps Save draft, always blue and untitled, on a store-backed site', async () => {
      const page = await paint({ site: siteBody({ mode: 'memory' }) });
      await page.act('key:hero_headline');
      expect(saveState(page)).toEqual({ label: 'Save draft', blue: true, grey: false });
      expect(saveButton(page).getAttribute('title')).toBeNull();
      page.dom.window.close();
    });

    it('shows the mount’s content refusal under the field when a store-backed draft is refused', async () => {
      const refusal = 'welcome__subject: 61 characters exceeds the 60-character limit (default)';
      const page = await paint({
        site: siteBody({ mode: 'memory' }),
        routes: [[`/s/${SITE_ID}/api/stet/draft`, 422, { error: refusal, findings: [{ level: 'error', kind: 'limit', key: 'welcome__subject', message: refusal }] }]],
      });
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'A changed headline');
      await page.act('save');
      expect(docOf(page).querySelector('#refusal .err')?.textContent).toBe(refusal);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    /** An html site with two pages, each a document with one marked key. */
    const TWO_PAGES: Descriptor = {
      version: 1,
      keys: { about_text: { shape: 'text', target: 'web' }, home_text: { shape: 'text', target: 'web' } },
      pages: { about: { route: '/about.html' }, home: { route: '/' } },
    };
    const twoPages = (route: string): Promise<Painted> =>
      paint({
        site: siteBody({ host: 'html', descriptor: TWO_PAGES, snapshot: { default: { about_text: 'About', home_text: 'Home' } } }),
        routes: [
          [
            '/api/site/marks',
            200,
            {
              documents: [
                { file: 'about.html', route: '/about.html', page: 'about' },
                { file: 'index.html', route: '/', page: 'home' },
              ],
              keys: { about_text: ['about.html'], home_text: ['index.html'] },
              places: {},
            },
          ],
        ],
        storage: { [`stet.route.${SITE_ID}`]: route },
      });
    const opened = (page: Painted): { group: string; route: string; loads: string[] } => ({
      group: (docOf(page).getElementById('gsel') as HTMLSelectElement).value,
      route: (docOf(page).getElementById('route') as HTMLInputElement).value,
      loads: page.requested('/api/site/preview?'),
    });

    it('opens on the page the preview shows (journey B18, B19)', async () => {
      const about = await twoPages('/about.html?x=1');
      // The route is chosen through the groups as before; the list opens on every key.
      expect(opened(about)).toEqual({ group: 'all', route: '/about.html?x=1', loads: [`/api/site/preview?site=%2Fcheckouts%2Fmini&route=${encodeURIComponent('/about.html?x=1')}`] });
      about.dom.window.close();
      const home = await twoPages('/');
      expect(opened(home)).toMatchObject({ group: 'all', route: '/' });
      expect(home.requested('/api/site/preview?')).toHaveLength(1);
      home.dom.window.close();
      const gone = await twoPages('/retired.html');
      expect(opened(gone)).toMatchObject({ group: 'all', route: '/about.html' });
      expect(gone.requested('/api/site/preview?')).toHaveLength(1);
      gone.dom.window.close();
    });

    /** psyon.ai's forms at 3ca2faf: the header's button in three places, the contact button in one. */
    const BUTTONS: Descriptor = {
      version: 1,
      keys: {
        home_header_link_text: { shape: 'text', target: 'web' },
        home_contact_link_text: { shape: 'text', target: 'web' },
        home_about_text: { shape: 'text', target: 'web' },
      },
      pages: { home: { route: '/' } },
    };
    const BUTTON_VALUES = { default: { home_header_link_text: 'Start a conversation ↗', home_contact_link_text: 'Book an introductory call ↗', home_about_text: 'About us' } };
    const place = (line: number): Record<string, unknown> => ({ file: 'index.html', line, kind: 'link text', tag: 'a' });
    const buttonMarks = (places: Record<string, unknown[]>): Record<string, unknown> => ({
      documents: [{ file: 'index.html', route: '/', page: 'home' }],
      keys: Object.fromEntries(Object.keys(places).map((id) => [id, ['index.html']])),
      places,
    });
    const BUTTON_PLACES = {
      home_header_link_text: [place(3), place(40), place(90)],
      home_contact_link_text: [place(60)],
      home_about_text: [{ file: 'index.html', line: 20, kind: 'paragraph', tag: 'p' }],
    };
    const buttons = (places: Record<string, unknown[]> = BUTTON_PLACES): Promise<Painted> =>
      paint({
        site: siteBody({ host: 'html', descriptor: BUTTONS, snapshot: BUTTON_VALUES }),
        routes: [['/api/site/marks', 200, buttonMarks(places)]],
      });
    const panel = (page: Painted): string => [...docOf(page).querySelectorAll('.bar ~ .cb .term')].map((t) => t.textContent ?? '').join('\n');

    it('asks to link the contact button to the header’s three, and links them (journey G8, merge)', async () => {
      const page = await buttons();
      await page.act('key:home_contact_link_text');
      await page.type('text:home_contact_link_text', 'Start a conversation ↗');
      page.answer('/api/site/save', 200, {
        written: ['content/defaults.json', 'index.html'],
        findings: [],
        pending: ['content/defaults.json', 'index.html'],
        same: [{ key: 'home_contact_link_text', others: ['home_header_link_text'] }],
      });
      await page.act('save');
      expect(panel(page)).toBe('Same words as home_header_link_text, shown in 3 other places');
      expect(docOf(page).querySelector('[data-act="sameLink"]')?.textContent).toBe('Link them');
      expect(docOf(page).querySelector('[data-act="sameKeep"]')?.textContent).toBe('Keep separate');

      // What the checkout reads after the merge.
      const merged = { ...BUTTONS, keys: { home_header_link_text: BUTTONS.keys['home_header_link_text'], home_about_text: BUTTONS.keys['home_about_text'] } } as Descriptor;
      page.answer('/api/site/merge', 200, { written: ['content/descriptor.json', 'content/defaults.json', 'index.html'], pending: ['content/descriptor.json', 'content/defaults.json', 'index.html'] });
      page.answer('/api/site', 200, siteBody({
        host: 'html',
        descriptor: merged,
        snapshot: { default: { home_header_link_text: 'Start a conversation ↗', home_about_text: 'About us' } },
        pending: ['content/descriptor.json', 'content/defaults.json', 'index.html'],
      }));
      page.answer('/api/site/marks', 200, buttonMarks({ home_header_link_text: [place(3), place(40), place(60), place(90)], home_about_text: BUTTON_PLACES.home_about_text }));
      await page.act('sameLink');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/merge')).at(-1)?.body).toEqual({ key: 'home_contact_link_text', into: 'home_header_link_text' });
      expect(page.toast()).toBe('Linked: home_contact_link_text now reads home_header_link_text');
      expect(page.keys()).not.toContain('home_contact_link_text');
      expect(docOf(page).querySelector('.row.on')?.getAttribute('data-act')).toBe('key:home_header_link_text');
      expect(docOf(page).querySelector('.kline')?.textContent).toContain('index.html:60');
      expect(docOf(page).querySelector('#gitbar [data-act="commit"]')?.classList.contains('pri')).toBe(true);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('keeps the edited key when it has more places, and counts the other key’s places', async () => {
      const page = await buttons();
      await page.act('key:home_header_link_text');
      await page.type('text:home_header_link_text', 'Book an introductory call ↗');
      page.answer('/api/site/save', 200, { written: ['content/defaults.json'], findings: [], pending: ['content/defaults.json'], same: [{ key: 'home_header_link_text', others: ['home_contact_link_text'] }] });
      await page.act('save');
      expect(panel(page)).toBe('Same words as home_contact_link_text, shown in 1 other place');
      await page.act('sameLink');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/merge')).at(-1)?.body).toEqual({ key: 'home_contact_link_text', into: 'home_header_link_text' });
      page.dom.window.close();
    });

    it('keeps the key not edited on a tie', async () => {
      const page = await buttons({ ...BUTTON_PLACES, home_header_link_text: [place(3)] });
      await page.act('key:home_contact_link_text');
      await page.type('text:home_contact_link_text', 'Start a conversation ↗');
      page.answer('/api/site/save', 200, { written: ['content/defaults.json'], findings: [], pending: ['content/defaults.json'], same: [{ key: 'home_contact_link_text', others: ['home_header_link_text'] }] });
      await page.act('save');
      expect(panel(page)).toBe('Same words as home_header_link_text, shown in 1 other place');
      await page.act('sameLink');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/merge')).at(-1)?.body).toEqual({ key: 'home_contact_link_text', into: 'home_header_link_text' });
      page.dom.window.close();
    });

    it('asks once: Keep separate closes the question, and a later save asks nothing (journey G8, merge)', async () => {
      const page = await buttons();
      await page.act('key:home_contact_link_text');
      await page.type('text:home_contact_link_text', 'Start a conversation ↗');
      page.answer('/api/site/save', 200, { written: ['content/defaults.json'], findings: [], pending: ['content/defaults.json'], same: [{ key: 'home_contact_link_text', others: ['home_header_link_text'] }] });
      await page.act('save');
      await page.act('sameKeep');
      expect(panel(page)).toBe('');
      page.answer('/api/site/save', 200, { written: ['content/defaults.json'], findings: [], pending: ['content/defaults.json'], same: [] });
      await page.act('key:home_about_text');
      await page.type('text:home_about_text', 'About the team');
      await page.act('save');
      expect(panel(page)).toBe('');
      expect(page.requested('/api/site/merge')).toEqual([]);
      page.dom.window.close();
    });

    /** A title with an advisory 60, a share description derived from the headline with an advisory 70, a hard-limited tagline. */
    const LIMITED: Descriptor = {
      version: 1,
      keys: {
        home_page_title: { shape: 'text', target: 'web', limits: { max: 60, severity: 'advisory' } },
        home_headline: { shape: 'text', target: 'web' },
        home_share_description: { shape: 'text', target: 'web', derivesFrom: 'home_headline', tmpl: '{v} Read on.', limits: { max: 70, severity: 'advisory' } },
        home_tagline: { shape: 'text', target: 'web', limits: { max: 20, severity: 'hard' } },
      },
      pages: { home: { route: '/', seo: { title: 'home_page_title', description: 'home_share_description' } } },
    };
    const limited = (): Promise<Painted> =>
      paint({
        site: siteBody({ host: 'html', descriptor: LIMITED, snapshot: { default: { home_page_title: 'Psyon', home_headline: 'Data for AI teams.', home_tagline: 'Short' } } }),
        routes: [
          [
            '/api/site/marks',
            200,
            buttonMarks({
              home_page_title: [{ file: 'index.html', line: 3, kind: 'page title', tag: 'title', head: true }],
              home_headline: [{ file: 'index.html', line: 9, kind: 'headline', tag: 'h1' }],
              home_share_description: [{ file: 'index.html', line: 4, kind: 'share description', tag: 'meta', attr: 'content', meta: 'og:description', head: true }],
              home_tagline: [{ file: 'index.html', line: 10, kind: 'paragraph', tag: 'p' }],
            }),
          ],
          ['/api/site/save', 200, { written: ['content/defaults.json', 'index.html'], findings: [], pending: ['content/defaults.json', 'index.html'] }],
        ],
      });

    it('asks before saving a 63-character title past its advisory 60 (journey C1)', async () => {
      const page = await limited();
      await page.change('group', 'seo');
      await page.act('key:home_page_title');
      const title = 'P'.repeat(63);
      await page.type('text:home_page_title', title);
      const count = docOf(page).querySelector('.cb .cnt') as HTMLElement;
      expect(count.textContent).toBe('63 / 60');
      expect(count.classList.contains('bad')).toBe(true);
      await page.act('save');
      expect(panel(page)).toBe('Over the 60-character limit for a page title');
      expect(page.requested('/api/site/save')).toEqual([]);
      await page.act('saveCancel');
      expect(panel(page)).toBe('');
      expect(page.requested('/api/site/save')).toEqual([]);
      await page.act('save');
      await page.act('saveAnyway');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/save')).at(-1)?.body).toEqual({
        values: [{ key: 'home_page_title', locale: 'default', value: title, base: 'Psyon' }],
      });
      expect(saveState(page)).toEqual(SAVED);
      page.dom.window.close();
    });

    it('asks where a source’s draft pushes its derived key past an advisory limit, and never for a hard one', async () => {
      const page = await limited();
      await page.act('key:home_headline');
      await page.type('text:home_headline', 'Data labelling, annotation, human evaluation and dataset sourcing for AI teams.');
      await page.act('save');
      expect(panel(page)).toBe('Over the 70-character limit for a share description');
      await page.act('saveCancel');
      await page.type('text:home_headline', 'Data for AI teams.');
      await page.act('key:home_tagline');
      await page.type('text:home_tagline', 'A tagline far past its hard limit');
      await page.act('save');
      expect(panel(page)).toBe('');
      expect(page.requested('/api/site/save')).toHaveLength(1);
      page.dom.window.close();
    });

    const BRANCH = { head: 'c7b3961', branch: 'develop', upstream: 'origin/develop', ahead: 0, behind: 0, dirty: false, live: 'main' };
    const branchBar = (page: Painted): HTMLElement => docOf(page).getElementById('branchbar') as HTMLElement;

    it('shows develop · preview, its preview link, and publishes to live (journey B18, B19)', async () => {
      const page = await paint({
        site: siteBody({ git: BRANCH }),
        routes: [['/api/site/preview-link', 200, { url: 'https://develop.psyon-site.pages.dev' }]],
      });
      expect(branchBar(page).querySelector('.bdg')?.textContent).toBe('develop · preview');
      const link = branchBar(page).querySelector('a') as HTMLAnchorElement;
      expect(link.textContent).toBe('Preview: https://develop.psyon-site.pages.dev ↗');
      expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['https://develop.psyon-site.pages.dev', '_blank', 'noopener']);
      await page.act('publishAsk');
      const ask = docOf(page).getElementById('ask') as HTMLElement;
      expect(ask.hidden).toBe(false);
      expect(ask.querySelector('.term')?.textContent).toBe('Publish develop to main? main is what mini serves.');
      await page.act('publishCancel');
      expect(ask.hidden).toBe(true);
      expect(page.requested('/api/site/publish-live')).toEqual([]);

      page.answer('/api/site/publish-live', 200, { output: 'To origin\n   1111111..c7b3961  HEAD -> main', live: 'main', at: { ...BRANCH, live: undefined } });
      await page.act('publishAsk');
      await page.act('publishLive');
      expect(page.toast()).toBe('Published develop to main.');
      expect(branchBar(page).querySelector('.bdg')?.textContent).toBe('develop · preview');
      page.answer('/api/site/publish-live', 200, { output: '', live: 'main', already: true, at: BRANCH });
      await page.act('publishAsk');
      await page.act('publishLive');
      expect(page.toast()).toBe('Already published');
      page.answer('/api/site/publish-live', 409, { error: 'main has commits develop lacks — bring them into develop first', at: BRANCH });
      await page.act('publishAsk');
      await page.act('publishLive');
      expect(docOf(page).querySelector('#giterr .term')?.textContent).toBe('main has commits develop lacks — bring them into develop first');
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('says no preview was reported, and asks again on Check again', async () => {
      const page = await paint({ site: siteBody({ git: BRANCH }), routes: [['/api/site/preview-link', 200, { url: null }]] });
      expect(branchBar(page).textContent).toContain('No preview reported for develop');
      page.answer('/api/site/preview-link', 200, { url: 'https://develop.psyon-site.pages.dev' });
      await page.act('previewCheck');
      expect(page.requested('/api/site/preview-link')).toHaveLength(2);
      expect(branchBar(page).querySelector('a')?.textContent).toBe('Preview: https://develop.psyon-site.pages.dev ↗');
      page.dom.window.close();
    });

    it('shows no Publish and no preview on the live branch, nor Publish while the branch is ahead or behind', async () => {
      const live = await paint({ site: siteBody({ git: { ...BRANCH, branch: 'main', upstream: 'origin/main' } }) });
      expect(branchBar(live).textContent).toBe('main · live');
      expect(live.requested('/api/site/preview-link')).toEqual([]);
      live.dom.window.close();
      const ahead = await paint({ site: siteBody({ git: { ...BRANCH, ahead: 1 } }), routes: [['/api/site/preview-link', 200, { url: null }]] });
      expect(branchBar(ahead).querySelector('[data-act="publishAsk"]')).toBeNull();
      ahead.dom.window.close();
      const behind = await paint({ site: siteBody({ git: { ...BRANCH, behind: 1 } }), routes: [['/api/site/preview-link', 200, { url: null }]] });
      expect(branchBar(behind).querySelector('[data-act="publishAsk"]')).toBeNull();
      behind.dom.window.close();
      const detached = await paint({ site: siteBody({ git: { ...BRANCH, branch: null, upstream: null } }) });
      expect(branchBar(detached).textContent).toBe('detached · c7b3961');
      detached.dom.window.close();
    });

    const REMOVED_KEYS = [
      { key: 'does_psyon_buy_the_data', section: 'faq', text: 'Does Psyon buy the data?' },
      { key: 'home_operating_card_1_headline', section: 'operating', text: 'Scoped' },
      { key: 'loose_note', section: null, text: 'A note <b>with markup</b>' },
    ];
    const SLICE = '<section id="faq"><h2 data-stet="faq">FAQ</h2><img src=x onerror=alert(1)></section>';
    const historyPage = (copied: string[] = []): Promise<Painted> =>
      paint({
        routes: [
          ['/api/site/history', 200, { commits: [{ sha: '67694e8abc', short: '67694e8', author: 'nj-io', at: '2026-09-26T18:33:29+07:00', subject: 'layout: FAQ removed' }] }],
          ['/api/site/removed', 200, { keys: REMOVED_KEYS }],
        ],
        prepare: (window) => {
          Object.defineProperty(window.navigator, 'clipboard', {
            value: {
              writeText: async (text: string): Promise<void> => {
                copied.push(text);
              },
            },
          });
        },
      });

    it('names where a removed key was shown on a JavaScript host, and Restore stands (journey B22)', async () => {
      const page = await paint({
        routes: [
          ['/api/site/history', 200, { commits: [{ sha: 'b22b22babc', short: 'b22b22b', author: 'nj-io', at: '2026-10-20T10:00:00Z', subject: 'lab: long copy removed' }] }],
          ['/api/site/removed', 200, { keys: [
            { key: 'lab_long', section: null, text: 'A long paragraph', places: [{ file: 'app/(marketing)/lab/page.tsx', line: 20, kind: 'text in app/(marketing)/lab/page.tsx' }] },
            { key: 'lab_aside', section: null, text: 'An aside', places: [{ file: 'src/pages/lab.astro', line: 4, kind: 'paragraph' }, { file: 'src/pages/about.astro', line: 9, kind: 'headline' }] },
            { key: 'lab_note', section: 'lab', text: 'A note', places: [] },
          ] }],
        ],
      });
      await page.act('history');
      await page.act('commitOpen:b22b22babc');
      const listed = docOf(page).querySelector('tr td[colspan="3"] .mono') as HTMLElement;
      expect(listed.innerHTML.split('<br>').map((line) => new page.dom.window.DOMParser().parseFromString(line, 'text/html').body.textContent)).toEqual([
        // The reader's fallback kind only names the file again, so the row leaves it out.
        'lab_long was removed in b22b22b. It was shown at app/(marketing)/lab/page.tsx:20.',
        'lab_aside was removed in b22b22b. It was shown at src/pages/lab.astro:4 (paragraph), src/pages/about.astro:9 (headline).',
        'lab_note — lab — "A note"',
      ]);
      expect(docOf(page).querySelector('[data-act="restoreAsk"]')).not.toBeNull();
      expect([...docOf(page).querySelectorAll('h3')].map((el) => el.textContent)).toContain('Commit history');
      page.dom.window.close();
    });

    it('lists a store-backed site’s commits and the keys one removed, with no Restore', async () => {
      const page = await paint({
        site: siteBody({ mode: 'memory' }),
        routes: [
          ['/api/site/history', 200, { commits: [{ sha: 'cafe00dabc', short: 'cafe00d', author: 'nj-io', at: '2026-10-20T10:00:00Z', subject: 'remove farewell_notice' }] }],
          ['/api/site/removed', 200, { keys: [{ key: 'farewell_notice', section: null, text: 'So long', places: [] }] }],
        ],
      });
      await page.act('history');
      await page.act('commitOpen:cafe00dabc');
      expect((docOf(page).querySelector('tr td[colspan="3"] .mono') as HTMLElement).textContent).toBe('farewell_notice — "So long"');
      expect(docOf(page).querySelector('[data-act="restoreAsk"]')).toBeNull();
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('lists what a commit removed and restores it, handing back the markup (journey B22, restore)', async () => {
      const copied: string[] = [];
      const page = await historyPage(copied);
      await page.act('history');
      await page.act('commitOpen:67694e8abc');
      expect(page.requested('/api/site/removed')).toEqual(['/api/site/removed?site=%2Fcheckouts%2Fmini&sha=67694e8abc']);
      const listed = docOf(page).querySelector('tr td[colspan="3"] .mono') as HTMLElement;
      expect(listed.innerHTML.split('<br>').map((line) => new page.dom.window.DOMParser().parseFromString(line, 'text/html').body.textContent)).toEqual([
        'does_psyon_buy_the_data — faq — "Does Psyon buy the data?"',
        'home_operating_card_1_headline — operating — "Scoped"',
        'loose_note — "A note <b>with markup</b>"',
      ]);
      expect(listed.querySelector('b')).toBeNull();
      await page.act('restoreAsk');
      expect(docOf(page).querySelector('tr td[colspan="3"] .term')?.textContent).toBe('Restore the 3 keys 67694e8 removed?');
      page.answer('/api/site/restore', 200, {
        restored: REMOVED_KEYS.map((k) => k.key),
        skipped: [],
        markup: [{ file: 'index.html', section: 'faq', text: SLICE }],
        sha: 'f00dfeed',
        short: 'f00dfee',
        subject: 'stet: restore 3 keys removed by 67694e8',
        pending: [],
      });
      await page.act('restoreApply');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/restore')).at(-1)?.body).toEqual({ sha: '67694e8abc' });
      expect(page.requested('/api/workspace').length).toBeGreaterThanOrEqual(2);
      const pre = docOf(page).querySelector('pre.term') as HTMLElement;
      expect(pre.textContent).toBe(SLICE);
      expect(pre.querySelector('section, img')).toBeNull();
      expect(painted(page)).toContain('The page could not be restored automatically — later commits changed the same lines. The keys are back; paste each section where it belongs, then save.');
      await page.act('copyMarkup:0');
      expect(copied).toEqual([SLICE]);
      expect(page.toast()).toBe('Copied');
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('shows Restore’s refusal in the row, and greys Restore while anything is unsaved', async () => {
      const page = await historyPage();
      await page.act('history');
      await page.act('commitOpen:67694e8abc');
      page.answer('/api/site/restore', 409, { error: 'Restore waits for the staged changes — commit or unstage them first', pending: [] });
      await page.act('restoreAsk');
      await page.act('restoreApply');
      expect(docOf(page).querySelector('tr td[colspan="3"] .err')?.textContent).toBe('Restore waits for the staged changes — commit or unstage them first');
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'Unsaved');
      expect((docOf(page).querySelector('[data-act="restoreAsk"]') as HTMLButtonElement).disabled).toBe(true);
      page.dom.window.close();
    });

    it('shows nothing new for a commit that removed no key', async () => {
      const page = await paint({
        routes: [
          ['/api/site/history', 200, { commits: [{ sha: 'abc1234def', short: 'abc1234', author: 'dev', at: '2026-09-01T10:00:00Z', subject: 'stet: 1 key updated' }] }],
          ['/api/site/removed', 200, { keys: [] }],
        ],
      });
      await page.act('history');
      await page.act('commitOpen:abc1234def');
      expect(docOf(page).querySelector('tr td[colspan="3"]')).toBeNull();
      expect(docOf(page).querySelector('[data-act="restoreAsk"]')).toBeNull();
      page.dom.window.close();
    });

    it('gives the footer link its own key from the page (journey G9, split)', async () => {
      const NAV: Descriptor = { version: 1, keys: { home_nav_link_text_3: { shape: 'text', target: 'web' } }, pages: { home: { route: '/' } } };
      const navPlaces = { home_nav_link_text_3: [place(453), place(607)] };
      const page = await paint({
        site: siteBody({ host: 'html', descriptor: NAV, snapshot: { default: { home_nav_link_text_3: 'Data sourcing' } } }),
        routes: [['/api/site/marks', 200, buttonMarks(navPlaces)]],
      });
      await page.act('key:home_nav_link_text_3');
      expect(docOf(page).querySelector('[data-act="splitAsk:index.html:453"]')?.textContent).toBe('Give this place its own key');
      page.answer('/api/site/split', 200, { proposed: 'home_footer_link_text_3' });
      await page.act('splitAsk:index.html:607');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/split')).at(-1)?.body).toEqual({ key: 'home_nav_link_text_3', at: 'index.html:607' });
      expect((docOf(page).querySelector('[data-act-input="splitName"]') as HTMLInputElement).value).toBe('home_footer_link_text_3');
      expect(docOf(page).querySelector('[data-act="splitApply"]')?.textContent).toBe('Split');

      page.answer('/api/site/split', 200, { written: ['content/descriptor.json', 'content/defaults.json', 'index.html'], key: 'home_footer_link_text_3', pending: ['content/descriptor.json', 'content/defaults.json', 'index.html'] });
      page.answer('/api/site', 200, siteBody({
        host: 'html',
        descriptor: { ...NAV, keys: { ...NAV.keys, home_footer_link_text_3: { shape: 'text', target: 'web' } } },
        snapshot: { default: { home_nav_link_text_3: 'Data sourcing', home_footer_link_text_3: 'Data sourcing' } },
        pending: ['content/descriptor.json', 'content/defaults.json', 'index.html'],
      }));
      page.answer('/api/site/marks', 200, buttonMarks({ home_nav_link_text_3: [place(453)], home_footer_link_text_3: [place(607)] }));
      await page.act('splitApply');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/split')).at(-1)?.body).toEqual({ key: 'home_nav_link_text_3', at: 'index.html:607', name: 'home_footer_link_text_3' });
      expect(docOf(page).querySelector('.row.on')?.getAttribute('data-act')).toBe('key:home_footer_link_text_3');
      expect(docOf(page).querySelector('#gitbar [data-act="commit"]')?.classList.contains('pri')).toBe(true);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });
  });

  describe('the Lighthouse card (D10)', () => {
    const lighthouse = { version: '13.5.0', formFactor: 'mobile', runs: 1, target: 'http://127.0.0.1:5001/', targetKind: 'documents', protocol: 'h2' };
    const audit = (owner: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id,
      category: 'seo',
      weight: 1,
      score: 0,
      owner,
      remedy: `fix ${id}`,
      ...over,
    });
    const pageOf = (page: string, scores: Record<string, number | null>, audits: unknown[] = [], over: Record<string, unknown> = {}): Record<string, unknown> => ({
      page,
      route: page === 'home' ? '/' : `/${page}`,
      url: 'http://127.0.0.1:5001/',
      scores: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100, ...scores },
      metrics: {},
      audits,
      diagnostics: [],
      thirdParty: [],
      ...over,
    });
    const resultOf = (pages: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
      ok: true,
      lighthouse,
      footprint: [],
      fixes: [],
      findings: [],
      pages,
      ...over,
    });
    const done = (result: unknown, elapsed = 4): Record<string, unknown> => ({ state: 'done', elapsed, lines: [], result });
    const indexPage = (): Record<string, unknown> =>
      pageOf('home', { accessibility: 89, bestPractices: 96 }, [
        audit('copy', 'label', { at: 'index.html:12', snippet: '<textarea id="notes">', key: 'hero_headline', remedy: 'name the field through a key' }),
        audit('copy', 'meta-description', { key: 'hero_story', remedy: 'hero_story is empty' }),
        audit('host', 'target-size', { at: 'index.html:30', snippet: '<a href="/c">c</a>', remedy: 'pad the link' }),
        audit('host', 'is-crawlable', { remedy: 'serve a 404' }),
      ], { file: 'index.html' });

    /** The page over a site, `GET site/audit` answering whatever `held.reply` is; the SEO tab open. */
    async function card(
      site: Record<string, unknown>,
      held: { reply: unknown },
      more: Array<[string, number, unknown, number?]> = [],
    ): Promise<Painted> {
      const page = await paint({
        site,
        routes: [
          ['/api/site/audit', 200, () => held.reply],
          ['/api/site/audit-start', 200, { state: 'running' }],
          ...more,
        ],
        // The page polls every two seconds; the case does not wait that long.
        prepare: (window) => {
          const real = window.setTimeout.bind(window);
          (window as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number) => real(fn, ms === 2000 ? 10 : ms);
        },
      });
      await page.act('tab:SEO');
      return page;
    }
    const htmlSite = (): Record<string, unknown> => siteBody({ host: 'html', config: { ...(siteBody()['config'] as object), host: 'html' }, dev: null });
    const body = (page: Painted): string => painted(page);
    const lastStart = (page: Painted): unknown => page.sent.filter((r) => r.path.startsWith('/api/site/audit-start')).at(-1)?.body;

    it('reads Not run yet by host, and Run fills the card (journey C13)', async () => {
      const held = { reply: { state: 'none', elapsed: 0, lines: [], result: null } as unknown };
      const html = await card(htmlSite(), held);
      expect(body(html)).toContain("Not run yet. Runs against the project's documents.");
      expect(docOf(html).querySelector('[data-act="auditRun"]')?.textContent).toBe('Run');
      held.reply = done(resultOf([indexPage()]));
      await html.act('auditRun');
      expect(lastStart(html)).toEqual({});
      const text = docOf(html).querySelector('.card')?.textContent ?? '';
      expect(text).toContain("lighthouse 13.5.0 · mobile · the project's documents · 1 page · 4 s");
      expect(text).toContain('index.html');
      const tiles = [...docOf(html).querySelectorAll('.lht > div')].map((tile) => [tile.querySelector('.lb')?.textContent, tile.querySelector('.bdg')?.textContent, tile.querySelector('.bdg')?.className]);
      expect(tiles).toEqual([
        ['Performance', '100', 'bdg g'],
        ['Accessibility', '89', 'bdg d'],
        ['Best Practices', '96', 'bdg g'],
        ['SEO', '100', 'bdg g'],
      ]);
      expect(text).toContain('stet fixes (2)');
      expect(text).toContain('The host owns (2)');
      expect(docOf(html).querySelector('[data-act="auditRun"]')?.textContent).toBe('Run again');
      expect([...docOf(html).querySelectorAll('[data-act^="edit:"]')].map((b) => b.getAttribute('data-act'))).toEqual(['edit:hero_headline', 'edit:hero_story']);
      await html.act('edit:hero_headline');
      expect(docOf(html).querySelector('.row.on')?.getAttribute('data-act')).toBe('key:hero_headline');
      expect(html.errors).toEqual([]);
      html.dom.window.close();

      const js = await card(siteBody(), { reply: { state: 'none' } });
      expect(body(js)).toContain('Not run yet. Runs against the production build.');
      js.dom.window.close();
    });

    it('bands the tiles at 90 and 50, a missing score reading a dash', async () => {
      const held = { reply: done(resultOf([pageOf('home', { performance: 90, accessibility: 89, bestPractices: 50, seo: 49 }), pageOf('about', { performance: null })])) };
      const page = await card(htmlSite(), held);
      const classes = [...docOf(page).querySelectorAll('.lht .bdg')].map((b) => `${b.textContent}:${b.className}`);
      expect(classes.slice(0, 4)).toEqual(['90:bdg g', '89:bdg d', '50:bdg d', '49:bdg r']);
      expect(classes[4]).toBe('–:bdg ');
      page.dom.window.close();
    });

    it('applies the head fixes from the card and re-fills it with the re-run (journey C13)', async () => {
      const fixed = pageOf('home', { accessibility: 89 }, [audit('fix', 'html-has-lang'), audit('fix', 'meta-viewport'), audit('fix', 'document-title'), audit('copy', 'link-name', { key: 'home_link' })], { file: 'index.html' });
      const held = { reply: done(resultOf([fixed])) };
      const page = await card(htmlSite(), held);
      expect(body(page)).toContain('3 head edits');
      held.reply = done(resultOf([fixed, pageOf('home', {}, [audit('copy', 'meta-description', { key: 'minted_key', remedy: 'minted_key is empty' })], { file: 'index.html' })]));
      // The write minted the key: the site read after it declares it.
      page.answer('/api/site', 200, siteBody({ host: 'html', descriptor: { ...descriptor, keys: { ...descriptor.keys, minted_key: { shape: 'text', target: 'web' } } } }));
      await page.act('auditFix:home');
      expect(lastStart(page)).toEqual({ fix: true, pages: ['home'] });
      expect(body(page)).not.toContain('head edits');
      expect(docOf(page).querySelector('.card [data-act="edit:minted_key"]')?.textContent).toBe('→ open');
      expect(page.requested('/api/site?')).toHaveLength(2);
      expect(docOf(page).querySelectorAll('.lht').length).toBe(1);
      page.dom.window.close();
    });

    it('keeps the drafts a person has open when Apply fixes reads the site again', async () => {
      const fixed = pageOf('home', { accessibility: 89 }, [audit('fix', 'html-has-lang')], { file: 'index.html' });
      const held = { reply: done(resultOf([fixed])) };
      const page = await card(htmlSite(), held);
      await page.act('tab:Content');
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'A draft the fix must not eat');
      expect(page.html()).toContain('1 unsaved edit');
      await page.act('tab:SEO');
      held.reply = done(resultOf([pageOf('home', {}, [], { file: 'index.html' })]));
      page.answer('/api/site', 200, siteBody({ host: 'html', descriptor: { ...descriptor, keys: { ...descriptor.keys, minted_key: { shape: 'text', target: 'web' } } } }));
      await page.act('auditFix:home');
      expect(page.requested('/api/site?')).toHaveLength(2);
      await page.act('tab:Content');
      expect(page.html()).toContain('1 unsaved edit');
      expect((docOf(page).querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement).value).toBe('A draft the fix must not eat');
      // The refresh did read the site: the key the fix minted is in the list.
      expect(page.html()).toContain('<option value="prefix:minted">minted</option>');
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('keeps the drafts a person has open when the SEO tab declares a page', async () => {
      const page = await paint();
      await page.act('tab:Content');
      await page.act('key:hero_headline');
      await page.type('text:hero_headline', 'A draft declaring must not eat');
      expect(page.html()).toContain('1 unsaved edit');
      await page.act('tab:SEO');
      await page.act('seoLoad');
      await page.act('declare:about');
      expect(page.sent.filter((r) => r.path.startsWith('/api/site/pages/declare')).at(-1)?.body).toEqual({ names: ['about'] });
      await page.act('tab:Content');
      expect(page.html()).toContain('1 unsaved edit');
      expect((docOf(page).querySelector('[data-act-input="text:hero_headline"]') as HTMLTextAreaElement).value).toBe('A draft declaring must not eat');
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('opens a key only where the audit carries it, never for a remedy word that happens to name a declared key', async () => {
      const keyed: Descriptor = { ...descriptor, keys: { ...descriptor.keys, label: { shape: 'text', target: 'web' }, alt: { shape: 'text', target: 'web' }, home_meta_description: { shape: 'text', target: 'web' } } };
      const held = {
        reply: done(
          resultOf([
            pageOf('home', {}, [
              audit('copy', 'label', { at: 'index.html:12', snippet: '<textarea id="notes">', remedy: 'has no label — give it id="notes" and write a <label for="notes">' }),
              audit('copy', 'image-alt', { remedy: 'has no alt — write alt text, or alt="" for a decorative image' }),
              audit('copy', 'meta-description', { key: 'home_meta_description', remedy: 'index.html has no description — in the plan below, bound to home_meta_description' }),
            ], { file: 'index.html' }),
          ]),
        ),
      };
      const page = await card(siteBody({ host: 'html', descriptor: keyed }), held);
      await page.act('auditRun');
      expect([...docOf(page).querySelectorAll('.card [data-act^="edit:"]')].map((b) => b.getAttribute('data-act'))).toEqual(['edit:home_meta_description']);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('audits a JavaScript site’s build, shows the building line, and posts the toggle and the preview url (journey C13)', async () => {
      const held = { reply: { state: 'none' } as unknown };
      const page = await card(siteBody({ git: { head: 'c7b3961', branch: 'develop', upstream: 'origin/develop', ahead: 0, behind: 0, dirty: false, live: 'main' } }), held, [
        ['/api/site/preview-link', 200, { url: 'https://develop.psyon-site.pages.dev' }],
      ]);
      expect(docOf(page).querySelector('[data-act="auditPreview"]')?.textContent).toBe('Audit the deployed preview');
      held.reply = { state: 'running', elapsed: 3, lines: ['building (npm run build)…', 'compiling'], result: null };
      await page.act('auditForm:desktop');
      await page.act('auditRun');
      expect(lastStart(page)).toEqual({ desktop: true });
      expect(body(page)).toContain('Building the production preview (npm run build)…');
      held.reply = done(resultOf([pageOf('home', {})], { lighthouse: { ...lighthouse, formFactor: 'desktop', targetKind: 'build' } }), 41);
      await until(() => body(page).includes('the production build'));
      expect(docOf(page).querySelector('.card')?.textContent).toContain('lighthouse 13.5.0 · desktop · the production build · 1 page · 41 s');
      held.reply = done(resultOf([pageOf('home', {})], { lighthouse: { ...lighthouse, targetKind: 'url', target: 'https://develop.psyon-site.pages.dev' } }));
      await page.act('auditForm:mobile');
      await page.act('auditPreview');
      expect(lastStart(page)).toEqual({ url: 'https://develop.psyon-site.pages.dev' });
      expect(docOf(page).querySelector('.card')?.textContent).toContain('lighthouse 13.5.0 · mobile · https://develop.psyon-site.pages.dev · 1 page');
      page.dom.window.close();
    });

    it('says Auditing <page>… <n> s while a run goes on, and polls until it ends', async () => {
      const held = { reply: { state: 'running', elapsed: 7, lines: ['auditing home… 1/1'], result: null } as unknown };
      const page = await card(htmlSite(), held);
      expect(body(page)).toContain('Auditing home… 7 s');
      expect((docOf(page).querySelector('[data-act="auditRun"]') as HTMLButtonElement).disabled).toBe(true);
      held.reply = done(resultOf([pageOf('home', {})]));
      expect(await until(() => body(page).includes('lighthouse 13.5.0'))).toBe(true);
      const reads = page.requested('/api/site/audit?').length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(page.requested('/api/site/audit?')).toHaveLength(reads);
      page.dom.window.close();
    });

    it('shows the refusals and failures in the card', async () => {
      const held = { reply: { state: 'none' } as unknown };
      const page = await card(siteBody(), held);
      page.answer('/api/site/audit-start', 409, { error: 'stop the dev server first — next build writes the .next folder it is serving from' });
      await page.act('auditRun');
      expect(docOf(page).querySelector('.card .err')?.textContent).toBe('stop the dev server first — next build writes the .next folder it is serving from');
      page.answer('/api/site/audit-start', 200, { state: 'running' });
      held.reply = done({ ok: false, findings: [{ kind: 'lighthouse', level: 'error', message: 'Chrome was not found — Lighthouse needs it; install Google Chrome, or set CHROME_PATH to a Chrome or Chromium binary' }] });
      await page.act('auditRun');
      expect(docOf(page).querySelector('.card .err')?.textContent).toBe('Chrome was not found — install Google Chrome, or set CHROME_PATH in the shell that runs stet dev');
      // The needs-Lighthouse line reaches the card as written, with the folder it names where the dashboard's stet is another checkout's.
      for (const line of [
        'stet audit lighthouse needs Lighthouse — run npm i -D lighthouse@13 chrome-launcher@1 selfsigned@5',
        'stet audit lighthouse needs Lighthouse — run npm i -D lighthouse@13 chrome-launcher@1 selfsigned@5 in /checkouts/a',
        'stet audit lighthouse needs Lighthouse — install @getstet/stet in the project, then run npm i -D lighthouse@13 chrome-launcher@1 selfsigned@5 there',
      ]) {
        held.reply = done({ ok: false, findings: [{ kind: 'lighthouse', level: 'error', message: line }] });
        await page.act('auditRun');
        expect(docOf(page).querySelector('.card .err')?.textContent).toBe(line);
      }
      held.reply = { state: 'done', elapsed: 9, lines: ['building (npm run build)…', 'boom'], result: { ok: false, findings: [{ kind: 'lighthouse', level: 'error', message: 'npm run build exited 1 — its output is above' }] } };
      await page.act('auditRun');
      expect(docOf(page).querySelector('.card .err')?.textContent).toBe('The build failed — its output is under Setup');
      await page.act('tab:Setup');
      expect(body(page)).toContain('Lighthouse output');
      expect(docOf(page).querySelector('.term')?.textContent).toContain('boom');
      page.dom.window.close();
    });

    it('clears the card on a site switch, leaves the child, and reads the finished result on return', async () => {
      const held = { reply: { state: 'running', elapsed: 1, lines: ['auditing home… 1/1'], result: null } as unknown };
      const page = await card(htmlSite(), held);
      const reads = (): number => page.requested('/api/site/audit?').length;
      // The other checkout has no audit; the server keys them by site.
      held.reply = { state: 'none', elapsed: 0, lines: [], result: null };
      await page.act('site:/checkouts/other');
      expect(body(page)).not.toContain('Auditing home');
      const afterSwitch = reads();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(reads()).toBe(afterSwitch);
      held.reply = done(resultOf([pageOf('home', {})]));
      await page.act('site:/checkouts/mini');
      await page.act('tab:SEO');
      expect(body(page)).toContain('lighthouse 13.5.0');
      page.dom.window.close();
    });

    it('escapes every string a result carries (the hostile snippet)', async () => {
      const hostile = '<img src=x onerror=alert(1)>';
      const held = {
        reply: done(
          resultOf([pageOf(hostile, {}, [audit('copy', 'x', { snippet: hostile, remedy: hostile, at: hostile, key: hostile }), audit('host', hostile, { snippet: hostile, remedy: hostile })], { file: hostile, route: hostile })], {
            lighthouse: { ...lighthouse, version: hostile, targetKind: 'url', target: hostile },
          }),
        ),
      };
      const page = await card(htmlSite(), held);
      expect(docOf(page).querySelector('.card img')).toBeNull();
      expect(docOf(page).querySelector('.card')?.textContent).toContain(hostile);
      held.reply = done({ ok: false, findings: [{ kind: 'lighthouse', level: 'error', message: hostile }] });
      await page.act('auditRun');
      expect(docOf(page).querySelector('.card img')).toBeNull();
      expect(docOf(page).querySelector('.card .err')?.textContent).toBe(hostile);
      expect(page.errors).toEqual([]);
      page.dom.window.close();
    });

    it('lays the tiles and lists out for a phone, every line wrapping (journey C13)', async () => {
      const held = { reply: done(resultOf([indexPage()])) };
      const page = await card(htmlSite(), held);
      const window = page.dom.window;
      const tiles = docOf(page).querySelector('.lht') as HTMLElement;
      const row = docOf(page).querySelector('.lhi') as HTMLElement;
      expect(window.getComputedStyle(tiles).gridTemplateColumns).toBe('repeat(auto-fit,minmax(140px,1fr))');
      expect(window.getComputedStyle(row).overflowWrap).toBe('anywhere');
      expect(window.getComputedStyle(docOf(page).querySelector('.lhi code') as HTMLElement).overflowWrap).toBe('anywhere');
      const style = [...docOf(page).querySelectorAll('style')].map((el) => el.textContent).join('');
      expect(style).toContain('@media(max-width:760px){.cards{grid-template-columns:1fr}}');
      expect(style).not.toMatch(/\.(lht|lhi|lhp)[^{]*\{[^}]*[;{]width:/);
      page.dom.window.close();
    });

    it('sets the preview command in Setup, the router’s command its placeholder, a cleared field removing it (journey C13)', async () => {
      const page = await paint({ site: siteBody({ previewDefault: 'npx astro preview --host 127.0.0.1 --port {port} --ignore-lock' }) });
      await page.act('tab:Setup');
      const field = (): HTMLInputElement => docOf(page).getElementById('previewcmd') as HTMLInputElement;
      expect(field().value).toBe('');
      expect(field().placeholder).toBe('npx astro preview --host 127.0.0.1 --port {port} --ignore-lock');
      expect(body(page)).toContain('Preview command');
      expect(body(page)).toContain('Runs after npm run build for stet audit lighthouse --build; {port} and PORT carry the port, and the server must listen on 127.0.0.1');
      await page.change('entryPreview', 'node serve.mjs --port {port}');
      expect(page.sent.filter((r) => r.path.startsWith('/api/workspace/update')).at(-1)?.body).toEqual({ path: '/checkouts/mini', previewCommand: 'node serve.mjs --port {port}' });
      expect(field().value).toBe('node serve.mjs --port {port}');
      await page.change('entryPreview', '');
      expect(page.sent.filter((r) => r.path.startsWith('/api/workspace/update')).at(-1)?.body).toEqual({ path: '/checkouts/mini', previewCommand: '' });
      page.dom.window.close();

      const html = await paint({ site: htmlSite() });
      await html.act('tab:Setup');
      expect(docOf(html).getElementById('previewcmd')).toBeNull();
      html.dom.window.close();
    });
  });
});

describe('stet dev holds its signal listeners through the close (F48)', () => {
  it('absorbs a second SIGINT and a SIGTERM during the close, ends the trapping child, and exits 0', async () => {
    const file = workspaceFile();
    const host = snapshotHost();
    addSite(file, host.cwd);
    const path = realpathSync(host.cwd);
    // The trap fixture, with no output of its own: stet's death cannot end it through a broken pipe.
    updateSite(file, path, { devCommand: `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"; true` });
    const stet = spawn(process.execPath, [join(packageRoot(), 'dist/cli/main.js'), 'dev', '--no-open', '--port', '0'], {
      cwd: tempDir(),
      env: { ...process.env, STET_WORKSPACE: file },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => stet.on('exit', (code) => resolve(code)));
    let printed = '';
    stet.stdout.setEncoding('utf8');
    stet.stdout.on('data', (chunk: string) => {
      printed += chunk;
    });
    const dashboard = await new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no dashboard line: ${printed}`)), 8_000);
      stet.stdout.on('data', () => {
        const line = /dashboard: (\S+)/.exec(printed);
        if (line === null) return;
        clearTimeout(timer);
        resolve(new URL(line[1] as string));
      });
    });
    const port = Number(dashboard.port);
    const token = dashboard.searchParams.get('t') as string;
    const reply = await raw(
      port,
      `POST /api/site/dev-start?site=${encodeURIComponent(path)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${token}\r\ncontent-length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(reply.split('\r\n')[0]).toContain('200');
    const pid = Number(/"pid":(\d+)/.exec(reply)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const began = Date.now();
    stet.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 300));
    stet.kill('SIGINT');
    stet.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(Date.now() - began).toBeLessThan(5_500);
    expect(await gone(-pid, 0)).toBe(true);
  }, 20_000);
});

describe('the audit child (D10)', () => {
  /** Stub CLIs the audit route runs in place of the installed one, each a node script. */
  const STUBS = {
    argv:
      "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.STET_AUDIT_SPAWNS ?? 'spawns.txt', 'x\\n');\n" +
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), token: process.env.STET_DEV_TOKEN ?? null }));\n',
    failing: "process.stdout.write(JSON.stringify({ ok: false }));\nprocess.exit(1);\n",
    forever:
      "import { appendFileSync, writeFileSync } from 'node:fs';\n" +
      "appendFileSync('spawns.txt', 'x\\n');\nwriteFileSync('audit.pid', String(process.pid));\n" +
      "process.stderr.write('auditing home… 1/1\\n');\nsetInterval(() => {}, 1000);\n",
    trap:
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('audit.pid', String(process.pid));\n" +
      "process.on('SIGTERM', () => { process.stderr.write('stopped by SIGTERM\\n'); process.exit(143); });\n" +
      "process.stderr.write('auditing home… 1/1\\n');\nsetInterval(() => {}, 1000);\n",
    slow: "setTimeout(() => process.stdout.write('{}'), 1100);\n",
    pair: "process.stdout.write(JSON.stringify({ token: process.env.STET_POSTGREST_TOKEN ?? null }));\n",
  } as const;

  function stub(kind: keyof typeof STUBS): string {
    const path = join(tempDir('stet-audit-stub-'), `${kind}.mjs`);
    writeFileSync(path, STUBS[kind]);
    return path;
  }

  function auditHost(
    cwd: string,
    kind: keyof typeof STUBS,
    over: Partial<WorkspaceEntry> = {},
    ctxOver: Partial<DevContext> = {},
  ): {
    handler: (r: Request) => Promise<Response>;
    ctx: DevContext;
    query: string;
    path: string;
  } {
    const file = workspaceFile();
    addSite(file, cwd);
    const path = realpathSync(cwd);
    if (Object.keys(over).length > 0) updateSite(file, path, over);
    // Nothing answers: a dev server the case starts is ended by its group, and no stop command runs.
    const refused = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const ctx = contextOver(file, { fetchImpl: refused, auditCli: stub(kind), ...ctxOver });
    return { handler: createDevHandler(ctx), ctx, query: `?site=${encodeURIComponent(path)}`, path };
  }

  async function settled(handler: (r: Request) => Promise<Response>, query: string, ms = 8_000): Promise<any> {
    const deadline = Date.now() + ms;
    let last: any;
    while (Date.now() < deadline) {
      last = await get(handler, `/api/site/audit${query}`);
      if (last.state !== 'running') return last;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return last;
  }

  async function pidFile(cwd: string, ms = 5_000): Promise<number> {
    const deadline = Date.now() + ms;
    while (!existsSync(join(cwd, 'audit.pid')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
    return Number(readFileSync(join(cwd, 'audit.pid'), 'utf8'));
  }

  it('answers none before a run, and passes the arguments per site kind', async () => {
    const html = await makeHtmlHost();
    const h = auditHost(html.cwd, 'argv');
    expect(await get(h.handler, `/api/site/audit${h.query}`)).toEqual({ state: 'none', elapsed: 0, lines: [], result: null });
    expect((await post(h.handler, `/api/site/audit-start${h.query}`, {})).status).toBe(200);
    expect((await settled(h.handler, h.query)).result.argv).toEqual(['audit', 'lighthouse', '--json']);

    const js = auditHost(snapshotHost().cwd, 'argv');
    await post(js.handler, `/api/site/audit-start${js.query}`, { desktop: true, pages: ['home', 'pricing'], fix: true });
    expect((await settled(js.handler, js.query)).result.argv).toEqual([
      'audit', 'lighthouse', '--json', '--desktop', '--pages', 'home,pricing', '--fix', '--write', '--build',
    ]);

    const url = auditHost(snapshotHost().cwd, 'argv');
    await post(url.handler, `/api/site/audit-start${url.query}`, { url: 'https://preview.example.dev/' });
    expect((await settled(url.handler, url.query)).result.argv).toEqual(['audit', 'lighthouse', '--json', '--url', 'https://preview.example.dev/']);
  });

  it('runs the started-in checkout’s audit with the shell’s pair and another checkout’s without it', async () => {
    const PAIR = { project: 't', store: { adapter: 'postgrest', urlEnv: 'STET_POSTGREST_URL', tokenEnv: 'STET_POSTGREST_TOKEN' } };
    const hosts = [makeCliHost({ config: PAIR }), makeCliHost({ config: PAIR })];
    const launched = realpathSync((hosts[0] as CliHost).cwd);
    await withProcessEnv({ STET_POSTGREST_URL: 'http://store.test/rest/v1', STET_POSTGREST_TOKEN: 'proc-token' }, async () => {
      for (const [index, expected] of [[0, 'proc-token'], [1, null]] as const) {
        const h = auditHost((hosts[index] as CliHost).cwd, 'pair', {}, { launched });
        expect((await post(h.handler, `/api/site/audit-start${h.query}`, {})).status).toBe(200);
        expect((await settled(h.handler, h.query)).result).toEqual({ token: expected });
      }
    });
  });

  it('accepts a page an html document proposes, and answers 400 for an unknown page or a non-http url', async () => {
    const html = await makeHtmlHost();
    const h = auditHost(html.cwd, 'argv');
    expect((await post(h.handler, `/api/site/audit-start${h.query}`, { pages: ['nosuch'] })).body).toEqual({ error: 'nosuch is not a declared page' });
    expect((await post(h.handler, `/api/site/audit-start${h.query}`, { pages: ['nosuch'] })).status).toBe(400);
    expect((await post(h.handler, `/api/site/audit-start${h.query}`, { pages: ['home'], fix: true })).status).toBe(200);
    expect((await settled(h.handler, h.query)).result.argv).toEqual(['audit', 'lighthouse', '--json', '--pages', 'home', '--fix', '--write']);

    const js = auditHost(snapshotHost().cwd, 'argv');
    const refused = await post(js.handler, `/api/site/audit-start${js.query}`, { url: 'ftp://example.com/' });
    expect(refused).toEqual({ status: 400, body: { error: 'url must be an http or https address' } });
  });

  it('accepts home on a JavaScript site declaring no page, for the audit and its fixes alike', async () => {
    const js = auditHost(
      snapshotHost((descriptor) => {
        delete (descriptor as { pages?: unknown }).pages;
        for (const def of Object.values(descriptor.keys)) delete (def as { pages?: unknown }).pages;
      }).cwd,
      'argv',
    );
    const started = await post(js.handler, `/api/site/audit-start${js.query}`, { fix: true, pages: ['home'] });
    expect(started.status).toBe(200);
    expect((await settled(js.handler, js.query)).result.argv).toEqual(['audit', 'lighthouse', '--json', '--pages', 'home', '--fix', '--write', '--build']);
    expect((await post(js.handler, `/api/site/audit-start${js.query}`, { pages: ['pricing'] })).body).toEqual({ error: 'pricing is not a declared page' });
  });

  it('refuses --build on a Next site below 16 whose dev server runs, and on one whose version cannot be read', async () => {
    const STOP = 'stop the dev server first — next build writes the .next folder it is serving from';
    const cases: Array<[string, string | null, number]> = [
      ['app', '15.5.26', 409],
      ['app', null, 409],
      ['app', '16.4.1', 200],
      ['astro', '15.5.26', 200],
    ];
    for (const [router, version, status] of cases) {
      const host = makeCliHost({ config: { project: 't', router } });
      if (version !== null) {
        mkdirSync(join(host.cwd, 'node_modules/next'), { recursive: true });
        writeFileSync(join(host.cwd, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version }));
      }
      const h = auditHost(host.cwd, 'argv', { devCommand: 'node -e "setInterval(()=>{},1000)"' });
      expect((await post(h.handler, `/api/site/dev-start${h.query}`, {})).body['running']).toBe(true);
      try {
        const started = await post(h.handler, `/api/site/audit-start${h.query}`, {});
        expect(started.status, `${router} ${version}`).toBe(status);
        if (status === 409) expect(started.body).toEqual({ error: STOP });
        else await settled(h.handler, h.query);
      } finally {
        await post(h.handler, `/api/site/dev-stop${h.query}`, {});
      }
    }
  }, 30_000);

  it('answers the running child on a second start, and spawns once', async () => {
    const html = await makeHtmlHost();
    const h = auditHost(html.cwd, 'forever');
    try {
      const first = await post(h.handler, `/api/site/audit-start${h.query}`, {});
      expect(first.body['state']).toBe('running');
      await pidFile(html.cwd);
      const second = await post(h.handler, `/api/site/audit-start${h.query}`, {});
      expect(second.body['state']).toBe('running');
      // Time for a second child, were one spawned, to record itself.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(readFileSync(join(html.cwd, 'spawns.txt'), 'utf8')).toBe('x\n');
    } finally {
      await stopEveryChild(h.ctx);
    }
  });

  it('reads done from stdout whatever the exit, and failed from a child ended with no JSON, its lines kept', async () => {
    const html = await makeHtmlHost();
    const failing = auditHost(html.cwd, 'failing');
    await post(failing.handler, `/api/site/audit-start${failing.query}`, {});
    expect(await settled(failing.handler, failing.query)).toEqual(expect.objectContaining({ state: 'done', result: { ok: false } }));

    const other = await makeHtmlHost();
    const trap = auditHost(other.cwd, 'trap');
    await post(trap.handler, `/api/site/audit-start${trap.query}`, {});
    const pid = await pidFile(other.cwd);
    process.kill(pid, 'SIGTERM');
    const read = await settled(trap.handler, trap.query);
    expect(read.state).toBe('failed');
    expect(read.lines).toEqual(['auditing home… 1/1', 'stopped by SIGTERM']);
  });

  it('freezes elapsed at the exit', async () => {
    const html = await makeHtmlHost();
    const h = auditHost(html.cwd, 'slow');
    await post(h.handler, `/api/site/audit-start${h.query}`, {});
    const done = await settled(h.handler, h.query);
    expect(done.state).toBe('done');
    expect(done.elapsed).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await get(h.handler, `/api/site/audit${h.query}`)).elapsed).toBe(1);
  });

  it('never hands the child the run token', async () => {
    const html = await makeHtmlHost();
    const h = auditHost(html.cwd, 'argv');
    const held = process.env['STET_DEV_TOKEN'];
    process.env['STET_DEV_TOKEN'] = TOKEN;
    try {
      await post(h.handler, `/api/site/audit-start${h.query}`, {});
      expect((await settled(h.handler, h.query)).result.token).toBeNull();
    } finally {
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
    }
  });

  it("ends the child when the site leaves the workspace, and at the server's close", async () => {
    const html = await makeHtmlHost();
    const h = auditHost(html.cwd, 'forever');
    await post(h.handler, `/api/site/audit-start${h.query}`, {});
    const pid = await pidFile(html.cwd);
    await post(h.handler, '/api/workspace/remove', { path: h.path });
    expect(await waitGone(pid)).toBe(true);

    const other = await makeHtmlHost();
    const closing = auditHost(other.cwd, 'forever');
    await post(closing.handler, `/api/site/audit-start${closing.query}`, {});
    const second = await pidFile(other.cwd);
    await stopEveryChild(closing.ctx);
    expect(await waitGone(second)).toBe(true);
  });
});

describe('GET /api/site/usage and /api/site/route-reads (D6, 5.5)', () => {
  /** The mini project with a Next App tree: a page, a layout importing `@/components/Nav`, a second route importing a missing alias. */
  function nextSite(): CliHost {
    const host = snapshotHost();
    write(host.cwd, 'package.json', JSON.stringify({ name: 'site', dependencies: { react: '^19' } }));
    write(host.cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
    write(
      host.cwd,
      'app/layout.tsx',
      "import { Nav } from '@/components/Nav';\nexport default function Layout({ children }: { children: unknown }) { return <html><body><Nav />{children}</body></html>; }\n",
    );
    write(
      host.cwd,
      'app/page.tsx',
      "import { useState } from 'react';\nimport { copy } from '@/lib/content';\nexport default function Page() { useState(0); return <h1>{copy('hero_headline')}</h1>; }\n",
    );
    write(host.cwd, 'components/Nav.tsx', "import { copy } from '@/lib/content';\nexport const Nav = () => <nav>{copy('footer_links')}</nav>;\n");
    write(
      host.cwd,
      'app/pricing/page.tsx',
      "import { Table } from '@/missing';\nimport { copy } from '@/lib/content';\nexport default function Pricing() { return <Table>{copy('pricing_price')}</Table>; }\n",
    );
    return host;
  }

  /** The route's reads without D12's render sites, which `routeRendersOf` answers alone. */
  const routeReadsOf = async (handler: (r: Request) => Promise<Response>, host: CliHost, route = '/'): Promise<any> => {
    const { renders: _renders, coincident: _coincident, ...body } = await get(handler, `/api/site/route-reads${site(host)}&route=${encodeURIComponent(route)}`);
    return body;
  };
  /** The route's render sites and coincident keys (D12). */
  const routeRendersOf = async (handler: (r: Request) => Promise<Response>, host: CliHost, route = '/'): Promise<any> => {
    const body = await get(handler, `/api/site/route-reads${site(host)}&route=${encodeURIComponent(route)}`);
    return { complete: body.complete, renders: body.renders, coincident: body.coincident };
  };

  it('answers each judged key with its state, the file count and the root', async () => {
    const host = nextSite();
    const { handler } = handlerOver([host.cwd]);
    const body = await get(handler, `/api/site/usage${site(host)}`);
    expect(body.keys).toEqual({
      hero_headline: { state: 'read' },
      hero_body: { state: 'not_found' },
      footer_links: { state: 'read' },
      contact_form_labels: { state: 'not_found' },
      theme_mode: { state: 'not_found' },
      blog_intro: { state: 'not_found' },
      pricing_tier_name: { state: 'not_found' },
      pricing_price: { state: 'read' },
      farewell_notice: { state: 'not_found' },
    });
    expect(body).toMatchObject({ prefixes: [], causes: [], serverOnly: [], files: 4 });
    expect(body.root).toMatch(/^stet-cli-[^/]+\/$/);
  });

  it('F8: no git the usage scan starts holds the run token: an fsmonitor hook sees it unset', async () => {
    const host = nextSite();
    const seen = join(tempDir('stet-fsmonitor-'), 'seen');
    const hook = join(dirname(seen), 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "\${STET_DEV_TOKEN-unset}" >> ${JSON.stringify(seen)}\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: host.cwd });
    const { handler } = handlerOver([host.cwd]);
    const held = process.env['STET_DEV_TOKEN'];
    process.env['STET_DEV_TOKEN'] = 'the-run-token';
    try {
      const body = await get(handler, `/api/site/usage${site(host)}`);
      expect(body.files).toBe(4);
    } finally {
      if (held === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held;
    }
    const lines = readFileSync(seen, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines)).toEqual(new Set(['unset']));
  });

  // An addition beyond F8's fsmonitor case: it guards every git the site routes start, not only the one the hook reaches.
  it('F8: every git the site and usage routes start runs without the run token', async () => {
    const host = nextSite();
    const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
    const shims = tempDir('stet-git-shim-');
    const seen = join(shims, 'seen');
    writeFileSync(join(shims, 'git'), `#!/bin/sh\nprintf '%s\\n' "\${STET_DEV_TOKEN-unset}" >> ${JSON.stringify(seen)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
    const { handler } = handlerOver([host.cwd]);
    const held = { path: process.env['PATH'], token: process.env['STET_DEV_TOKEN'] };
    process.env['PATH'] = `${shims}:${held.path ?? ''}`;
    process.env['STET_DEV_TOKEN'] = 'the-run-token';
    try {
      await get(handler, `/api/site${site(host)}`);
      await get(handler, `/api/site/usage${site(host)}`);
    } finally {
      process.env['PATH'] = held.path as string;
      if (held.token === undefined) delete process.env['STET_DEV_TOKEN'];
      else process.env['STET_DEV_TOKEN'] = held.token;
    }
    const lines = readFileSync(seen, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(new Set(lines)).toEqual(new Set(['unset']));
  });

  it('a second request after one file is touched re-reads that file alone, and answers its new read', async () => {
    const host = nextSite();
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../cli/key-reads.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../cli/key-reads.js')>();
      return {
        ...real,
        codeOf: (...args: Parameters<typeof real.codeOf>) => {
          calls.push(args[1]);
          return real.codeOf(...args);
        },
      };
    });
    try {
      const fresh = await import('./helpers/dashboard-page.js');
      const { handler } = fresh.handlerOver([host.cwd]);
      const first = await get(handler, `/api/site/usage${site(host)}`);
      expect(first.keys.footer_links).toEqual({ state: 'read' });
      expect(calls.sort()).toEqual(['app/layout.tsx', 'app/page.tsx', 'app/pricing/page.tsx', 'components/Nav.tsx']);

      // The same size, a later mtime: only the stamp's mtime tells it moved.
      const nav = join(host.cwd, 'components/Nav.tsx');
      const before = readFileSync(nav, 'utf8');
      writeFileSync(nav, before.replace("copy('footer_links')", "copy('blog_intro'  )"));
      expect(readFileSync(nav, 'utf8').length).toBe(before.length);
      const later = new Date(Date.now() + 60_000);
      utimesSync(nav, later, later);
      calls.length = 0;
      const second = await get(handler, `/api/site/usage${site(host)}`);
      expect(calls).toEqual(['components/Nav.tsx']);
      expect(second.keys.blog_intro).toEqual({ state: 'read' });
      expect(second.keys.footer_links).toEqual({ state: 'not_found' });
    } finally {
      vi.doUnmock('../cli/key-reads.js');
      vi.resetModules();
    }
  });

  it('lists a Next route’s page, its layout and what they import through the alias, complete', async () => {
    const host = nextSite();
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toEqual({
      route: '/',
      files: ['app/layout.tsx', 'app/page.tsx'],
      keys: ['footer_links', 'hero_headline'],
      complete: true,
    });
  });

  it('an alias that resolves nowhere makes the route incomplete', async () => {
    const host = nextSite();
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host, '/pricing')).toEqual({
      route: '/pricing',
      files: ['app/layout.tsx', 'app/pricing/page.tsx'],
      keys: ['footer_links', 'pricing_price'],
      complete: false,
    });
  });

  it('F3a: a specifier resolved through baseUrl alone is followed', async () => {
    const host = nextSite();
    write(host.cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
    write(host.cwd, 'app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) { return <html><body>{children}</body></html>; }\n');
    write(host.cwd, 'app/page.tsx', "import { Nav } from 'components/Nav';\nexport default function Page() { return <Nav />; }\n");
    write(host.cwd, 'components/Nav.tsx', "export const Nav = () => <nav>{'hero_headline'}</nav>;\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toMatchObject({ keys: ['hero_headline'], complete: true });
  });

  it('F3a: a specifier resolved through paths alone is followed, a package that resolves nowhere is not a boundary', async () => {
    const host = nextSite();
    write(host.cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'ui/*': ['./components/*'] } } }));
    write(host.cwd, 'app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) { return <html><body>{children}</body></html>; }\n');
    write(host.cwd, 'components/Nav.tsx', "export const Nav = () => <nav>{'footer_links'}</nav>;\n");
    write(host.cwd, 'app/page.tsx', "import { Nav } from 'ui/Nav';\nimport { useState } from 'react';\nexport default function Page() { useState(0); return <Nav />; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toMatchObject({ keys: ['footer_links'], complete: true });
  });

  it('F3b: a lazy import or a require in the closure makes the route incomplete', async () => {
    for (const body of [
      "import dynamic from 'next/dynamic';\nconst Nav = dynamic(() => import('@/components/Nav'));\nexport default function Page() { return <Nav />; }\n",
      "const Nav = require('@/components/Nav').Nav;\nexport default function Page() { return <Nav />; }\n",
    ]) {
      const host = nextSite();
      write(host.cwd, 'app/page.tsx', `${body}`);
      const { handler } = handlerOver([host.cwd]);
      expect((await routeReadsOf(handler, host)).complete, body).toBe(false);
    }
  });

  it('F3b: the lazy import is found in a file the page reaches, not only the page', async () => {
    const host = nextSite();
    write(host.cwd, 'components/Nav.tsx', "export const Nav = () => { void import('./Menu'); return <nav />; };\n");
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host)).complete).toBe(false);
  });

  it('F4: an import through a symlinked directory out of the checkout is a boundary, its keys unread', async () => {
    const host = nextSite();
    const outside = tempDir('stet-route-out-');
    write(outside, 'Secret.tsx', "export const Secret = () => <p>{'hero_body'}</p>;\n");
    symlinkSync(outside, join(host.cwd, 'linked'));
    write(host.cwd, 'app/page.tsx', "import { Secret } from '../linked/Secret';\nexport default function Page() { return <Secret />; }\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect(body.keys).not.toContain('hero_body');
    expect(body.complete).toBe(false);
  });

  it('D65: a file over 5 MB in the closure is not read: the route is incomplete and its keys unread', async () => {
    const host = nextSite();
    const line = "export const x = () => <p>{'hero_body'}</p>;\n";
    write(host.cwd, 'components/Big.tsx', line.repeat(Math.ceil((6 * 1024 * 1024) / line.length)));
    write(host.cwd, 'app/page.tsx', "import { x } from '@/components/Big';\nexport default function Page() { return x(); }\n");
    const { handler } = handlerOver([host.cwd]);
    const started = Date.now();
    const body = await routeReadsOf(handler, host);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(body.keys).not.toContain('hero_body');
    expect(body.complete).toBe(false);
  });

  it('F4: a symlinked directory inside the checkout is followed', async () => {
    const host = nextSite();
    write(host.cwd, 'shared/Banner.tsx', "export const Banner = () => <p>{'hero_body'}</p>;\n");
    symlinkSync(join(host.cwd, 'shared'), join(host.cwd, 'linked'));
    write(host.cwd, 'app/page.tsx', "import { Banner } from '../linked/Banner';\nexport default function Page() { return <Banner />; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toMatchObject({ keys: expect.arrayContaining(['hero_body']) });
  });

  it('F5: the generated modules the read path imports name no key of the route', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', "import { DEFAULTS } from '../content/defaults';\nexport const copy = (k: string) => (DEFAULTS.default as Record<string, string>)[k];\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect(body.keys).toEqual(['footer_links', 'hero_headline']);
    expect(body.complete).toBe(true);
  });

  it('F5: the read path, the descriptor, the snapshot and every codegen file are skipped, whatever header they carry', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', "import './labels';\nexport const copy = (k: string) => k;\nexport const own = 'blog_intro';\n");
    write(host.cwd, 'lib/labels.ts', "export const L = 'theme_mode';\n");
    write(host.cwd, 'content/keys.ts', "export const K = 'blog_intro';\n");
    write(host.cwd, 'lib/gen.ts', "// generated by stet — source-hash: x\nexport const G = 'farewell_notice';\n");
    write(host.cwd, 'app/page.tsx', "import { copy } from '@/lib/content';\nimport '../content/keys';\nimport '../lib/gen';\nexport default function Page() { return <h1>{copy('hero_headline')}</h1>; }\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect(body.keys).toEqual(['footer_links', 'hero_headline', 'theme_mode']);
  });

  it('F13 (r09): a file nested past the compiler recursion makes the route incomplete, and is answered', async () => {
    const host = nextSite();
    write(host.cwd, 'components/Deep.tsx', `export const d = ${'['.repeat(40000)}1${']'.repeat(40000)};\nexport const Deep = () => <b>{'hero_body'}</b>;\n`);
    write(host.cwd, 'app/page.tsx', "import { Deep } from '@/components/Deep';\nexport default function Page() { return <Deep />; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toEqual({ route: '/', files: ['app/layout.tsx', 'app/page.tsx'], keys: [], complete: false });
  });

  it('F13: a file the walk reads but the key scan cannot walk makes the route incomplete, the other files’ keys kept', async () => {
    const host = nextSite();
    write(host.cwd, 'components/Deep.ts', `export const c = x${'.m()'.repeat(20000)};\nexport const named = 'hero_body';\n`);
    write(
      host.cwd,
      'app/page.tsx',
      "import '@/components/Deep';\nimport { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero_headline')}</h1>; }\n",
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect(body.keys).toEqual(['footer_links', 'hero_body', 'hero_headline']);
    expect(body.complete).toBe(false);
  });

  it('D07: a file too deeply nested to search for a lazy import is taken to hold one', async () => {
    const ts = await loadTypescript();
    const deep = `export const c = x${'.m()'.repeat(20000)};\n// import('./later')\n`;
    expect(importsLazily(ts, 'deep.ts', deep)).toBe(true);
    expect(importsLazily(ts, 'plain.ts', "// import('./later')\nexport const a = 1;\n")).toBe(false);
  });

  it.each([
    [
      'r08: a scoped alias nothing declares',
      {},
      "import { Nav } from '@components/Nav';\nexport default function Page() { return <Nav />; }\n",
    ],
    [
      'r07: an alias the tsconfig reaches through extends, which the route walk does not read',
      {
        'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
        'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@components/*': ['./components/*'] } } }),
      },
      "import { Nav } from '@components/Nav';\nexport default function Page() { return <Nav />; }\n",
    ],
    ['a bare name that is no package of the project', {}, "import { Nav } from 'ui/Nav';\nexport default function Page() { return <Nav />; }\n"],
  ])('F14 %s: the route is incomplete', async (_name, extra, page) => {
    const host = nextSite();
    write(host.cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    write(host.cwd, 'app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) { return <html><body>{children}</body></html>; }\n');
    write(host.cwd, 'components/Nav.tsx', "export const Nav = () => <nav>{'footer_links'}</nav>;\n");
    for (const [rel, text] of Object.entries(extra)) write(host.cwd, rel, text);
    write(host.cwd, 'app/page.tsx', page);
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect(body.complete).toBe(false);
  });

  it('F14: a package the project declares, has installed or gets from Node is no boundary', async () => {
    const host = nextSite();
    write(
      host.cwd,
      'package.json',
      JSON.stringify({ name: 'site', dependencies: { react: '^19' }, devDependencies: { '@acme/ui': '1' }, peerDependencies: { zod: '3' }, optionalDependencies: { sharp: '1' } }),
    );
    write(host.cwd, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
    write(host.cwd, 'node_modules/@scope/kit/index.js', 'module.exports = 1;\n');
    write(host.cwd, 'app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) { return <html><body>{children}</body></html>; }\n');
    write(
      host.cwd,
      'app/page.tsx',
      [
        "import { useState } from 'react';",
        "import { Button } from '@acme/ui/button';",
        "import { z } from 'zod';",
        "import sharp from 'sharp';",
        "import pad from 'left-pad';",
        "import kit from '@scope/kit/deep/path';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "export default function Page() { void [useState, Button, z, sharp, pad, kit, readFileSync, join]; return <h1>{'hero_headline'}</h1>; }",
        '',
      ].join('\n'),
    );
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toMatchObject({ keys: ['hero_headline'], complete: true });
  });

  it('PG01: a layout of another route group is not a frame of this route', async () => {
    const host = nextSite();
    write(host.cwd, 'app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) { return <html>{children}</html>; }\n');
    write(host.cwd, 'app/(marketing)/layout.tsx', "export default function Layout({ children }: { children: unknown }) { return <div>{'footer_links'}{children}</div>; }\n");
    write(host.cwd, 'app/(shop)/layout.tsx', "export default function Layout({ children }: { children: unknown }) { return <div>{'theme_mode'}{children}</div>; }\n");
    write(host.cwd, 'app/(marketing)/about/page.tsx', "export default function Page() { return <p>{'hero_headline'}</p>; }\n");
    write(host.cwd, 'app/(shop)/cart/page.tsx', "export default function Page() { return <p>{'blog_intro'}</p>; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host, '/about')).toEqual({
      route: '/about',
      files: ['app/(marketing)/about/page.tsx', 'app/(marketing)/layout.tsx', 'app/layout.tsx'],
      keys: ['footer_links', 'hero_headline'],
      complete: true,
    });
  });

  it('PG02: a template.tsx is a frame of the pages under it', async () => {
    const host = nextSite();
    write(host.cwd, 'app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) { return <html>{children}</html>; }\n');
    write(host.cwd, 'app/template.tsx', "export default function Template({ children }: { children: unknown }) { return <div>{'footer_links'}{children}</div>; }\n");
    write(host.cwd, 'app/page.tsx', "export default function Page() { return <p>{'hero_headline'}</p>; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toMatchObject({ files: ['app/layout.tsx', 'app/page.tsx', 'app/template.tsx'], keys: ['footer_links', 'hero_headline'] });
  });

  it('PG03: a Pages Router _document.tsx is a frame of every page', async () => {
    const host = nextSite();
    rmSync(join(host.cwd, 'app'), { recursive: true });
    write(host.cwd, 'pages/_document.tsx', "export default function Document() { return <html>{'footer_links'}</html>; }\n");
    write(host.cwd, 'pages/index.tsx', "export default function Page() { return <p>{'hero_headline'}</p>; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toMatchObject({ files: ['pages/_document.tsx', 'pages/index.tsx'], keys: ['footer_links', 'hero_headline'] });
  });

  it('N18: route-reads without a route is a usage error', async () => {
    const host = nextSite();
    const { handler } = handlerOver([host.cwd]);
    const res = await handler(req(`/api/site/route-reads${site(host)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'route is required' });
  });

  it('a Vite site answers no files', async () => {
    const host = snapshotHost();
    write(host.cwd, 'src/main.tsx', "import { copy } from '../lib/content';\ndocument.title = copy('hero_headline');\n");
    const { handler } = handlerOver([host.cwd]);
    expect(await routeReadsOf(handler, host)).toEqual({
      route: '/',
      files: [],
      keys: [],
      complete: false,
    });
  });

  // 8o D2b: the route reads resolve TypeScript's spellings and skip framework modules.
  const astroPage = (host: CliHost, page: string, files: Record<string, string> = {}): void => {
    for (const [rel, text] of Object.entries(files)) write(host.cwd, rel, text);
    write(host.cwd, 'src/pages/custody.astro', page);
  };

  it('T2b.3 an Astro route answers complete: a .js specifier reaches the generated module’s source, astro:assets is not host source', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nimport Fonts from '../components/Fonts.astro';\nimport { title } from '../copy';\n---\n<Fonts /><h1>{title}</h1>\n", {
      'src/copy.ts': "import type { Key } from '../content/keys.js';\nexport const copy = (k: Key | string): string => String(k);\nexport const title = copy('hero_headline');\n",
      'src/components/Fonts.astro': "---\nimport { Font } from 'astro:assets';\n---\n<Font />\n",
    });
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host, '/custody');
    expect([body.complete, body.keys]).toEqual([true, ['hero_headline']]);
  });

  it('T2b.4 guard: an unknown bare alias still ends the walk', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nimport X from 'missing-alias/x';\n---\n<h1>x</h1>\n");
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host, '/custody')).complete).toBe(false);
  });

  it('T2b.5 guard: a path alias spelled with a colon resolves through the mapping first', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nimport { title } from 'app:copy';\n---\n<h1>{title}</h1>\n", {
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'app:*': ['src/*'] } } }),
      'src/copy.ts': "export const copy = (k: string): string => k;\nexport const title = copy('hero_headline');\n",
    });
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host, '/custody');
    expect([body.complete, body.keys]).toEqual([true, ['hero_headline']]);
  });

  // 8o D2c (R9): the route reads take each file's reads from key-usage's walk.
  const plainLayout = 'export default function Layout({ children }: { children: unknown }) { return <html><body>{children as any}</body></html>; }\n';

  it('T2c.1 a prefix read counts every key under it, and the route stays complete', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(
      host.cwd,
      'app/page.tsx',
      "import { copy } from '../lib/content';\nconst tiers = ['tier_name', 'price'];\nexport default function Page() { return <ul>{tiers.map((t) => <li key={t}>{copy(`pricing_${t}`)}</li>)}</ul>; }\n",
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect([body.complete, body.keys]).toEqual([true, ['pricing_price', 'pricing_tier_name']]);
  });

  it('T2c.2 a read key-usage cannot settle (a cause) answers incomplete', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'components/T.tsx', "import { copy } from '../lib/content';\nexport const T = ({ k }: { k: string }) => <b>{copy(k)}</b>;\n");
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(
      host.cwd,
      'app/page.tsx',
      "import { T } from '../components/T';\nconst pick = (n: number) => ['hero', 'body'][n];\nexport default function Page() { return <T k={`${pick(0)}_headline`} />; }\n",
    );
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host)).complete).toBe(false);
  });

  it('T2c.3 a page that loads modules through import.meta.glob answers incomplete', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nconst mods = import.meta.glob('../data/*.ts', { eager: true });\n---\n<h1>{Object.keys(mods).length}</h1>\n", {
      'src/data/a.ts': "export const t = 'hero_headline';\n",
    });
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host, '/custody')).complete).toBe(false);
  });

  it('T2c.4 guard: Astro.glob answers incomplete too', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nconst posts = await Astro.glob('../posts/*.md');\n---\n<h1>{posts.length}</h1>\n");
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host, '/custody')).complete).toBe(false);
  });

  it('a prefix read adds only the keys under its own prefix', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(host.cwd, 'components/Other.tsx', "import { copy } from '../lib/content';\nexport const O = ({ t }: { t: string }) => <i>{copy(`hero_${t}`)}</i>;\n");
    write(host.cwd, 'app/page.tsx', "import { copy } from '../lib/content';\nimport { O } from '../components/Other';\nexport default function Page({ t }: { t: string }) { return <i>{copy(`pricing_${t}`)}{O}</i>; }\n");
    write(host.cwd, 'other/Elsewhere.tsx', "import { copy } from '../lib/content';\nexport const E = ({ t }: { t: string }) => <i>{copy(`blog_${t}`)}</i>;\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect([body.complete, body.keys]).toEqual([true, ['hero_body', 'hero_headline', 'pricing_price', 'pricing_tier_name']]);
  });

  it('a read key-usage cannot settle in a file outside the closure leaves the route complete', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(host.cwd, 'app/page.tsx', "import { copy } from '../lib/content';\nexport default function Page() { return <i>{copy('hero_body')}</i>; }\n");
    write(host.cwd, 'components/Other.tsx', "import { copy } from '../lib/content';\nexport const O = ({ k }: { k: string }) => <i>{copy(k)}</i>;\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect([body.complete, body.keys]).toEqual([true, ['hero_body']]);
  });

  it('a typed import.meta.glob answers incomplete', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nconst m = import.meta.glob<Record<string, unknown>>('../data/*.ts');\n---\n<h1>x</h1>\n");
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host, '/custody')).complete).toBe(false);
  });

  it('a closure source file git ignores answers incomplete, its names kept', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(host.cwd, '.gitignore', 'components/Ignored.tsx\n');
    write(host.cwd, 'components/Ignored.tsx', "export const I = 'hero_body';\n");
    write(host.cwd, 'app/page.tsx', "import { I } from '../components/Ignored';\nexport default function Page() { return <i>{I}</i>; }\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect([body.complete, body.keys]).toEqual([false, ['hero_body']]);
  });

  it('a module another scheme names (virtual:) is not host source', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nimport 'virtual:uno.css';\n---\n<h1>x</h1>\n");
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host, '/custody')).complete).toBe(true);
  });

  it('an alias the host declares that maps to no file ends the walk', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nimport X from 'app:Missing';\n---\n<h1>x</h1>\n", {
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'app:*': ['src/*'] } } }),
    });
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host, '/custody')).complete).toBe(false);
  });

  // 8o L5: a ternary of key names reads both.
  it('a copy() whose argument picks between two key names answers complete with both keys', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(host.cwd, 'app/page.tsx', "import { copy } from '../lib/content';\nexport default function Page({ a }: { a: boolean }) { return <i>{copy(a ? 'blog_intro' : 'hero_body')}</i>; }\n");
    const { handler } = handlerOver([host.cwd]);
    const body = await routeReadsOf(handler, host);
    expect([body.complete, body.keys]).toEqual([true, ['blog_intro', 'hero_body']]);
  });

  it('a copy() whose argument picks between a key name and a variable answers incomplete', async () => {
    const host = nextSite();
    write(host.cwd, 'lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(host.cwd, 'app/page.tsx', "import { copy } from '../lib/content';\nexport default function Page({ a, k }: { a: boolean; k: string }) { return <i>{copy(a ? 'hero_body' : k)}</i>; }\n");
    const { handler } = handlerOver([host.cwd]);
    expect((await routeReadsOf(handler, host)).complete).toBe(false);
  });

  it('the html host answers the document’s marks', async () => {
    const host = await makeHtmlHost({ register: true });
    const { handler } = handlerOver([host.cwd]);
    const marks = await get(handler, `/api/site/marks${site(host)}`);
    const expected = Object.entries(marks.keys as Record<string, string[]>)
      .filter(([, files]) => files.includes('index.html'))
      .map(([key]) => key)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(await routeReadsOf(handler, host)).toEqual({
      route: '/',
      files: ['index.html'],
      keys: expected,
      complete: true,
    });
  });

  // 8o D12: the route reads say where each key renders.
  /** An Astro host whose `/` is `page`, with `files` beside it and the snapshot's `values` over the fixture's. */
  function placedSite(page: string, files: Record<string, string> = {}, values: Record<string, string> = {}): CliHost {
    const host = astroHost(['index.astro']);
    for (const [rel, text] of Object.entries(files)) write(host.cwd, rel, text);
    write(host.cwd, 'src/pages/index.astro', page);
    if (Object.keys(values).length > 0) {
      const at = join(host.cwd, 'content/defaults.json');
      const snapshot = loadSnapshot(JSON.parse(readFileSync(at, 'utf8')));
      Object.assign(snapshot['default'] as Record<string, unknown>, values);
      writeJsonDeterministic(at, snapshot);
      writeFileSync(join(host.cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));
    }
    return host;
  }
  const FRONT = '---\nimport { copy } from "../../lib/content";\n---\n';

  it('T12.1 Astro direct reads are sites; an attribute read is inert', async () => {
    const host = placedSite(
      FRONT + '<main><div class="acts"><span class="install">{copy.hero_headline}<button onclick={`x(${copy.hero_headline})`}>c</button></span></div></main>\n',
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, body.renders.hero_headline]).toEqual([true, [[{ tag: 'span', classes: ['install'] }, { tag: 'div', classes: null }]]]);
  });

  it.each([
    ['a front-matter read', '---\nimport { copy } from "../../lib/content";\nconst t = copy.hero_headline;\n---\n<main><h1>{copy.hero_headline}</h1><p>{t}</p></main>\n'],
    ['a read in a nested brace', FRONT + '<main><h1>{copy.hero_headline}</h1>{Math.random() > 1 && <a>{copy.hero_headline}</a>}</main>\n'],
    ['a brace holding more than the read', FRONT + '<main><h1>{copy.hero_headline}</h1><p>{copy.hero_headline.toUpperCase()}</p></main>\n'],
    ['a component attribute', FRONT + '<main><h1>{copy.hero_headline}</h1><Head label={copy.hero_headline} /></main>\n'],
    ['a component’s content', FRONT + '<main><h1>{copy.hero_headline}</h1><Card>{copy.hero_headline}</Card></main>\n'],
    ['set:html', FRONT + '<main><h1>{copy.hero_headline}</h1><div set:html={copy.hero_headline} /></main>\n'],
    ['a prefix read', '---\nimport { copy } from "../../lib/content";\nconst part = "headline";\n---\n<main><h1>{copy.hero_headline}</h1><p>{copy(`hero_${part}`)}</p></main>\n'],
  ])('T12.2 %s opens the key', async (_name, page) => {
    // A direct read of another key on the page is placed: the file was read.
    const host = placedSite(page.replace('</main>', '<b>{copy.pricing_price}</b></main>'));
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, Object.keys(body.renders)]).toEqual([true, ['pricing_price']]);
  });

  it('T12.3 one open read opens the key across files', async () => {
    const host = placedSite(
      '---\nimport { copy } from "../../lib/content";\nimport Accent from "../components/Accent.astro";\n---\n<main><h1>{copy.hero_headline}</h1><b>{copy.pricing_price}</b><Accent /></main>\n',
      { 'src/components/Accent.astro': '---\nimport { copy } from "../../lib/content";\nconst accent = (s: string) => s;\n---\n<em>{accent(copy.hero_headline)}</em>\n' },
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, Object.keys(body.renders)]).toEqual([true, ['pricing_price']]);
  });

  it('T12.4 the chain’s classes: level 0 static or computed, the climb stops at a component', async () => {
    const host = nextSite();
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(
      host.cwd,
      'app/page.tsx',
      [
        "import { copy } from '@/lib/content';",
        "const s = { x: 'y' };",
        'const Card = ({ children }: { children: unknown }) => <div>{children as any}</div>;',
        'export default function Page() {',
        "  return <main><section><p className=\"lede\">{copy('hero_headline')}</p></section><i className={s.x}>{copy('pricing_price')}</i><Card><b>{copy('pricing_tier_name')}</b></Card></main>;",
        '}',
        '',
      ].join('\n'),
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, body.renders]).toEqual([
      true,
      {
        hero_headline: [[{ tag: 'p', classes: ['lede'] }, { tag: 'section', classes: null }]],
        pricing_price: [[{ tag: 'i', classes: null }, { tag: 'main', classes: null }]],
        pricing_tier_name: [[{ tag: 'b', classes: [] }]],
      },
    ]);
    const astro = placedSite(FRONT + '<main><p class:list={["a", Math.random()]}>{copy.hero_headline}</p></main>\n');
    const other = handlerOver([astro.cwd]).handler;
    expect((await routeRendersOf(other, astro)).renders.hero_headline).toEqual([[{ tag: 'p', classes: null }, { tag: 'main', classes: null }]]);
  });

  it('T12.5 guard: incomplete reads carry no sites', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, "---\nconst mods = import.meta.glob('../data/*.ts', { eager: true });\n---\n<h1>{Object.keys(mods).length}</h1>\n", {
      'src/data/a.ts': "export const t = 'hero_headline';\n",
    });
    const { handler } = handlerOver([host.cwd]);
    expect(await routeRendersOf(handler, host, '/custody')).toEqual({ complete: false, renders: {}, coincident: [] });
  });

  it('T12.5: a complete route carries the sites the same page would (the M12.10 control)', async () => {
    const host = astroHost(['custody.astro']);
    astroPage(host, FRONT + '<main><h1>{copy.hero_headline}</h1></main>\n');
    const { handler } = handlerOver([host.cwd]);
    expect((await routeRendersOf(handler, host, '/custody')).renders).toHaveProperty('hero_headline');
    astroPage(host, '---\nimport { copy } from "../../lib/content";\nconst mods = import.meta.glob("../data/*.ts");\n---\n<main><h1>{copy.hero_headline}</h1></main>\n');
    expect(await routeRendersOf(handler, host, '/custody')).toEqual({ complete: false, renders: {}, coincident: [] });
  });

  it('T12.6 a faulted document opens its reads', async () => {
    const host = placedSite(FRONT + '<main><div><p>{copy.hero_headline}</p></main>\n');
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect(body.complete).toBe(true);
    expect(body.renders).not.toHaveProperty('hero_headline');
  });

  it('T12.7 guard: the html host carries no sites', async () => {
    const host = await makeHtmlHost({ register: true });
    const { handler } = handlerOver([host.cwd]);
    expect(await routeRendersOf(handler, host)).toEqual({ complete: true, renders: {}, coincident: [] });
  });

  it('T12.19 a read KEY_READ does not see opens the key (F1)', async () => {
    const host = placedSite(
      [
        '---',
        'import { copy } from "../../lib/content";',
        'const t = copy;',
        '---',
        '<html><body><main>',
        '<div class="cell"><h3>{copy.hero_headline}</h3></div>',
        '<ul><li>{copy["hero_headline"]}</li></ul>',
        '<p class="lede">{t.pricing_tier_name}</p><h3>{copy.pricing_tier_name}</h3>',
        '<b>{copy.pricing_price}</b>',
        '</main></body></html>',
        '',
      ].join('\n'),
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect(body.complete).toBe(true);
    expect(Object.keys(body.renders)).toEqual(['pricing_price']);

    const next = nextSite();
    write(next.cwd, 'app/layout.tsx', plainLayout);
    write(next.cwd, 'package.json', JSON.stringify({ name: 'site', dependencies: { react: '^19', '@getstet/stet': '1' } }));
    write(
      next.cwd,
      'app/page.tsx',
      "import { copy } from '@/lib/content';\nimport { useCopy } from '@getstet/stet/react';\nexport default function Page() { const t = useCopy(); return <main><p>{t('hero_headline')}</p><h3>{copy('hero_headline')}</h3><b>{copy('pricing_price')}</b></main>; }\n",
    );
    const other = handlerOver([next.cwd]).handler;
    const tsx = await routeRendersOf(other, next);
    expect([tsx.complete, Object.keys(tsx.renders)]).toEqual([true, ['pricing_price']]);
  });

  it('T12.20 only a key whose words a route file writes as text is coincident (R21, N17)', async () => {
    const host = placedSite(
      [
        '---',
        'import { copy } from "../../lib/content";',
        'import { pkg } from "@getstet/stet";',
        'import Promo from "../components/Promo.astro";',
        'import "../copy";',
        '---',
        '<main><h1>{copy.hero_headline}</h1><b>{copy.pricing_tier_name}</b><i>{copy.pricing_price}</i><em>{copy.brand__name}</em><Promo /><s>{pkg}</s></main>',
        '',
      ].join('\n'),
      {
        'package.json': JSON.stringify({ name: 'site', dependencies: { '@getstet/stet': '1' } }),
        'stet.config.json': JSON.stringify({ project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'], copyModules: ['src/copy.ts'] }, null, 2),
        'src/components/Promo.astro': '<aside><p>Never miss a post again.</p></aside>\n',
        'src/copy.ts': 'export const labels = { price: "$16" };\n',
      },
      { brand__name: 'stet' },
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect(body.complete).toBe(true);
    expect(Object.keys(body.renders).sort()).toEqual(['brand__name', 'hero_headline', 'pricing_price', 'pricing_tier_name']);
    expect(body.coincident).toEqual(['hero_headline']);
  });

  it('T12.21 the tree builder’s re-parenting ends the chain (F3)', async () => {
    const host = placedSite(FRONT + '<main><p><div><span>{copy.hero_headline}</span></div></p><p><div>{copy.pricing_price}</div></p></main>\n');
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.renders.hero_headline, body.renders.pricing_price]).toEqual([
      [[{ tag: 'span', classes: [] }, { tag: 'div', classes: null }]],
      [[{ tag: 'div', classes: [] }]],
    ]);
  });

  it('T12.21 (F1, an addition): markup the tree builder repairs past the parent opens the key', async () => {
    const host = placedSite(
      FRONT +
        '<main><p><span><div>{copy.hero_headline}</div></span></p><ul><li><li>{copy.pricing_price}</li></li></ul><section><b>{copy.pricing_tier_name}</b></section></main>\n',
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, Object.keys(body.renders)]).toEqual([true, ['pricing_tier_name']]);

    const next = nextSite();
    write(next.cwd, 'app/layout.tsx', plainLayout);
    write(
      next.cwd,
      'app/page.tsx',
      "import { copy } from '@/lib/content';\nexport default function Page() { return <main><p><span><div>{copy('hero_headline')}</div></span></p><ul><li><li>{copy('pricing_price')}</li></li></ul><section><b>{copy('pricing_tier_name')}</b></section></main>; }\n",
    );
    const other = handlerOver([next.cwd]).handler;
    const tsx = await routeRendersOf(other, next);
    expect([tsx.complete, Object.keys(tsx.renders)]).toEqual([true, ['pricing_tier_name']]);
  });

  it('T12.26 (F3, an addition): a code sample in an is:raw block is no read and no render site', async () => {
    // The shape of the reference host's docs/adopt.astro: a diff sample quoting copy('…') in a raw <pre>.
    const host = placedSite(
      FRONT +
        '<main><h3>{copy.pricing_price}</h3>\n<pre is:raw><code><span class="add">+      &lt;h1&gt;{copy(\'pricing_price\')}&lt;/h1&gt;</span>\n<span class="add">+      &lt;p&gt;{copy(\'hero_headline\')}&lt;/p&gt;</span></code></pre></main>\n',
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, body.renders]).toEqual([true, { pricing_price: [[{ tag: 'h3', classes: [] }, { tag: 'main', classes: null }]] }]);
  });
  /**
   * The Astro host register rewrites (D14): pages read keys by property through
   * the declared copy module `src/copy.ts`, and `hero_install` holds the
   * terminal's words.
   */
  function rewritable(page: string): CliHost {
    const host = astroHost(['index.astro']);
    write(
      host.cwd,
      'stet.config.json',
      JSON.stringify({ project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'], copyModules: ['src/copy.ts'], readPath: { file: 'lib/content.ts', import: '@/lib/content' } }, null, 2),
    );
    write(host.cwd, 'src/copy.ts', 'export const copy: Record<string, string> = {};\n');
    write(host.cwd, 'src/pages/index.astro', page);
    const descriptor = loadDescriptor(JSON.parse(readFileSync(join(host.cwd, 'content/descriptor.json'), 'utf8')));
    descriptor.keys['hero_install'] = { shape: 'text', target: 'web' };
    writeJsonDeterministic(join(host.cwd, 'content/descriptor.json'), descriptor);
    const snapshot = loadSnapshot(JSON.parse(readFileSync(join(host.cwd, 'content/defaults.json'), 'utf8')));
    (snapshot['default'] as Record<string, unknown>)['hero_install'] = 'npx x init';
    writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), snapshot);
    return host;
  }
  const TERMINAL =
    '---\nimport { copy } from "../copy";\n---\n<main>\n<div class="term"><span class="w">npx x init</span></div>\n<div class="box"><span class="install">{copy.hero_install}</span></div>\n</main>\n';

  it('T14.16: the route reads place a text register rewrote: both its sites render the key, and nothing is coincident', async () => {
    const host = rewritable(TERMINAL);
    const { handler } = handlerOver([host.cwd]);
    const before = await routeRendersOf(handler, host);
    expect([before.coincident, before.renders.hero_install]).toEqual([['hero_install'], [[{ tag: 'span', classes: ['install'] }, { tag: 'div', classes: null }]]]);
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.file('src/pages/index.astro')).toContain('<span class="w">{copy.hero_install}</span>');
    const after = await routeRendersOf(handler, host);
    expect([after.coincident, after.renders.hero_install]).toEqual([
      [],
      [
        [{ tag: 'span', classes: ['w'] }, { tag: 'div', classes: null }],
        [{ tag: 'span', classes: ['install'] }, { tag: 'div', classes: null }],
      ],
    ]);
  });

  it('T16.8: a rich read is a render site, and a hard-coded twin of its words makes its key coincident (check 3 F20)', async () => {
    const host = placedSite(
      '---\nimport { copy } from "../../lib/content";\nimport { richParts } from "@getstet/stet";\nimport Promo from "../components/Promo.astro";\n---\n' +
        '<main><p class="lede">{richParts(copy.hero_headline, [(c) => <b>{c}</b>])}</p><Promo /></main>\n',
      {
        'package.json': JSON.stringify({ name: 'site', dependencies: { '@getstet/stet': '1' } }),
        'src/components/Promo.astro': '<aside><span>Run <b>npx</b> now</span></aside>\n',
      },
      { hero_headline: 'Run <1>npx</1> now' },
    );
    const { handler } = handlerOver([host.cwd]);
    const plain = await routeRendersOf(handler, host);
    expect([plain.complete, plain.renders.hero_headline, plain.coincident]).toEqual([true, [[{ tag: 'p', classes: ['lede'] }, { tag: 'main', classes: null }]], []]);
    // Declared as a sentence key, its words are read without their tags: the twin is coincident.
    const at = join(host.cwd, 'content/descriptor.json');
    const descriptor = loadDescriptor(JSON.parse(readFileSync(at, 'utf8')));
    (descriptor.keys['hero_headline'] as { tags?: number }).tags = 1;
    writeJsonDeterministic(at, descriptor);
    const tagged = await routeRendersOf(handler, host);
    expect([tagged.renders.hero_headline, tagged.coincident]).toEqual([[[{ tag: 'p', classes: ['lede'] }, { tag: 'main', classes: null }]], ['hero_headline']]);
  });

  it('T16.16: a JSX rich read is a render site, and site/split proposes a name from the element that holds it', async () => {
    const host = nextSite();
    write(host.cwd, 'package.json', JSON.stringify({ name: 'site', dependencies: { react: '^19', '@getstet/stet': '1' } }));
    write(host.cwd, 'app/layout.tsx', plainLayout);
    write(
      host.cwd,
      'app/page.tsx',
      [
        "import { copy } from '@/lib/content';",
        "import { richParts } from '@getstet/stet/react/server';",
        'export default function Page() {',
        "  return <main><p className=\"lede\">{richParts(copy('hero_headline'), [(c, k) => <b key={k}>{c}</b>])}</p>",
        "    <h2>{copy('hero_headline')}</h2></main>;",
        '}',
        '',
      ].join('\n'),
    );
    const { handler } = handlerOver([host.cwd]);
    const body = await routeRendersOf(handler, host);
    expect([body.complete, body.renders.hero_headline]).toEqual([
      true,
      [
        [{ tag: 'p', classes: ['lede'] }, { tag: 'main', classes: null }],
        [{ tag: 'h2', classes: [] }, { tag: 'main', classes: null }],
      ],
    ]);
    const asked = await post(handler, `/api/site/split${site(host)}`, { key: 'hero_headline', at: 'app/page.tsx:4' });
    expect([asked.status, asked.body]).toEqual([200, { proposed: 'home_page_paragraph' }]);
  });

  it('T14.19: site/split proposes a name for an Astro place and, given it, moves that read alone', async () => {
    const host = rewritable(TERMINAL);
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const { handler } = handlerOver([host.cwd]);
    const asked = await post(handler, `/api/site/split${site(host)}`, { key: 'hero_install', at: 'src/pages/index.astro:5' });
    expect([asked.status, asked.body]).toEqual([200, { proposed: 'home_page_span' }]);
    const split = await post(handler, `/api/site/split${site(host)}`, { key: 'hero_install', at: 'src/pages/index.astro:5', name: 'home_page_span' });
    expect([split.status, split.body['key']]).toEqual([200, 'home_page_span']);
    expect(host.file('src/pages/index.astro')).toContain('<span class="w">{copy.home_page_span}</span></div>\n<div class="box"><span class="install">{copy.hero_install}</span>');
  });
});

describe('REVIEW probe: a second stet write to one page file (PD14)', () => {
  it('REVIEW-H1: commits the page after Declare pages and then Split both wrote it', async () => {
    const host = astroHost(['about.astro']);
    writeFileSync(
      join(host.cwd, 'stet.config.json'),
      JSON.stringify({ project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'], readPath: { file: 'src/lib/content.ts', import: '@/lib/content' } }, null, 2),
    );
    write(host.cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
    write(host.cwd, 'src/lib/content.ts', 'export const copy = (k: string): string => k;\n');
    write(
      host.cwd,
      'src/pages/about.astro',
      "---\nimport { copy } from '@/lib/content';\n---\n<html><head><title>About us</title><meta name=\"description\" content=\"Who we are.\" /></head><body>\n<h1>{copy('hero_headline')}</h1>\n<p>{copy('hero_headline')}</p>\n</body></html>\n",
    );
    git(host.cwd, ['add', '-A']);
    git(host.cwd, ['commit', '-qm', 'pages']);
    const { handler } = handlerOver([host.cwd]);
    const declared = await post(handler, `/api/site/pages/declare${site(host)}`, { names: ['about'] });
    expect(declared.status).toBe(200);
    expect(declared.body['written']).toContain('src/pages/about.astro');
    const first = (await get(handler, `/api/site/carries${site(host)}`)).files as string[];
    expect(first).toContain('src/pages/about.astro');
    const split = await post(handler, `/api/site/split${site(host)}`, { key: 'hero_headline', at: 'src/pages/about.astro:6', name: 'about_para' });
    expect(split.status).toBe(200);
    expect(split.body['written']).toContain('src/pages/about.astro');
    const pending = (await get(handler, `/api/site/carries${site(host)}`)).files as string[];
    expect(pending).toContain('src/pages/about.astro');
  });
});

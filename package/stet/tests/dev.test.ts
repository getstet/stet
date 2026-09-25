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
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { cleanupCliHosts, fakeFetch, htmlFixture, makeCliHost, makeHtmlHost, type CliHost } from '../conformance/cli-host.js';
import { cleanupEmailHosts, makeEmailHost } from './helpers/email-host.js';
import { builtBinExists, installStetShim } from './helpers/stet-shim.js';
import { writeJsonDeterministic } from '../cli/artifacts.js';
import { check } from '../cli/check.js';
import { loadConfig } from '../cli/config.js';
import { planDocuments } from '../cli/html-host.js';
import { Report } from '../cli/report.js';
import {
  captured,
  createDevHandler,
  stopEveryChild,
  withEnvFilesHint,
  type DevContext,
} from '../cli/dev-routes.js';
import { packageRoot } from '../cli/installed.js';
import { dashboardPage, runDev, startDevServer, type DevServerHandle } from '../cli/dev.js';
import { git, gitData, gitRun, gitState, operationInProgress, uncommittedPaths } from '../cli/git.js';
import { runHookInstall } from '../cli/hook.js';
import { gone } from '../cli/liveness.js';
import { runCli, type CliIo } from '../cli/main.js';
import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { loadDescriptor, loadSnapshot } from '../src/index.js';
import type { Descriptor } from '../src/types.js';
import {
  addSite,
  baseEnv,
  childEnv,
  devDefaults,
  loadSite,
  parseEnvText,
  readWorkspace,
  removeSite,
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

    expect(gitState(tempDir())).toEqual({ head: null, branch: null, dirty: false });
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
    const io = siteIo(dir, { out: [], err: [] });
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
      const io = siteIo(dir, { out: [], err: [] });
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

const TOKEN = 'dev-run-token';

/** A handler over a workspace holding the given checkouts, with a page of known text. */
function handlerOver(paths: string[], over: Partial<DevContext> = {}): {
  handler: (req: Request) => Promise<Response>;
  ctx: DevContext;
  file: string;
  origin: string;
} {
  const file = workspaceFile();
  for (const path of paths) addSite(file, path);
  const origin = 'http://127.0.0.1:4400';
  const ctx: DevContext = {
    token: TOKEN,
    origin,
    workspaceFile: file,
    io: { cwd: tempDir(), env: {}, stdout: () => {}, stderr: () => {} },
    page: '<style nonce="__STET_NONCE__"></style><script nonce="__STET_NONCE__"></script>',
    fetchImpl: globalThis.fetch,
    children: new Map(),
    stores: new Map(),
    queues: new Map(),
    ...over,
  };
  return { handler: createDevHandler(ctx), ctx, file, origin };
}

/** A request at the dashboard's own origin, with the run token unless told otherwise. */
function req(
  path: string,
  init: { method?: string; token?: string | null; host?: string | null; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.host !== null) headers['host'] = init.host ?? '127.0.0.1:4400';
  if (init.token !== null) headers['authorization'] = `Bearer ${init.token ?? TOKEN}`;
  const method = init.method ?? 'GET';
  return new Request(`http://127.0.0.1:4400${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

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
    const usage = await captured(ctx, ['check', '--env', 'prod'], { path: host.cwd });
    expect(usage.code).toBe(2);
    expect(usage.err.join('\n')).toContain('usage:');
    expect(usage.json).toBeUndefined();

    const plain = await captured(ctx, ['check'], { path: host.cwd });
    expect(plain.json).toBeUndefined();
    expect(plain.out.join('\n')).toContain('snapshot: 25 keys declared');

    const asJson = await captured(ctx, ['check', '--json'], { path: host.cwd });
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
        "stet dev reads it from the checkout's .env and .env.local",
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
    expect(first.body['written']).toEqual(['content/defaults.json', 'content/defaults.ts']);
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
    expect(written).toHaveLength(2);

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
    expect(made.body['subject']).toBe('stet: 1 key updated — hero_headline');
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

  it('answers git’s own text with no upstream, and lands the commit with one', async () => {
    const host = snapshotHost();
    const { handler } = handlerOver([host.cwd]);
    const saved = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Pushed' }],
    });
    await post(handler, `/api/site/commit${at(host)}`, {
      files: saved.body['written'] as string[],
      keys: ['hero_headline'],
    });

    const bare = join(tempDir(), 'origin.git');
    git(tempDir(), ['init', '--bare', '-q', bare]);
    git(host.cwd, ['remote', 'add', 'origin', bare]);
    const noUpstream = await post(handler, `/api/site/push${at(host)}`, {});
    expect(noUpstream.status).toBe(409);
    expect(String(noUpstream.body['output'])).toContain('no upstream branch');

    const branch = gitState(host.cwd).branch as string;
    git(host.cwd, ['push', '-u', 'origin', branch]);
    const second = await post(handler, `/api/site/save${at(host)}`, {
      values: [{ key: 'hero_headline', value: 'Pushed again' }],
    });
    await post(handler, `/api/site/commit${at(host)}`, {
      files: second.body['written'] as string[],
      keys: ['hero_headline'],
    });
    const pushed = await post(handler, `/api/site/push${at(host)}`, {});
    expect(pushed.status).toBe(200);
    expect(git(bare, ['rev-parse', 'HEAD']).out.trim()).toBe(git(host.cwd, ['rev-parse', 'HEAD']).out.trim());
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
    written: kind === 'js' ? ['content/defaults.json', 'content/defaults.ts'] : ['content/defaults.json', 'index.html'],
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
        expect(made.body['subject']).toBe(`stet: 1 key updated — ${t.key}`);
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
        const keys = [...new Set(Object.values(snapshot).flatMap((block) => Object.keys(block)))].sort();
        expect(keys.length).toBeGreaterThan(1);
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
        expect(refused.body['pending']).toEqual(['content/defaults.json']);
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
        expect(made.body['pending']).toEqual(['content/defaults.json']);
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
        const keys = [...new Set(Object.values(repaired).flatMap((block) => Object.keys(block as object)))].sort();
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
        expect(String(refused.body['output'])).toContain("stet needs 'typescript' to read your source");
        expect(refused.body['pending']).toEqual(t.written);
        expect(head(t.cwd)).toBe(before);
      },
      30_000,
    );
  }
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

  it('names the mount on a store-backed site', async () => {
    const host = makeCliHost({ config: { project: 't', store: { adapter: 'memory' } } });
    const { handler } = handlerOver([host.cwd]);
    const body = await (
      await handler(req(`/api/site/history?site=${encodeURIComponent(realpathSync(host.cwd))}`))
    ).json();
    expect(body).toEqual({ mount: `/s/${siteId(realpathSync(host.cwd))}/api/stet/history` });
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

  it('declares every proposal where no names are given', async () => {
    const host = astroHost();
    const { handler } = handlerOver([host.cwd]);
    await post(handler, `/api/site/pages/declare${site(host)}`, { names: [] });
    const pages = (JSON.parse(host.file('content/descriptor.json')) as { pages: Record<string, unknown> }).pages;
    // `index.astro` maps to `/`, which the mini descriptor already declares as
    // `home`, so the only route left to propose is `about`.
    expect(Object.keys(pages).sort()).toEqual(['about', 'home', 'pricing']);
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

describe('the mounted API under /s/<id>/api/stet', () => {
  const mount = (host: CliHost, route: string, query = ''): string =>
    `/s/${siteId(realpathSync(host.cwd))}/api/stet/${route}${query}`;

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
          "stet dev reads it from the checkout's .env and .env.local",
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

  it('answers nothing on a JavaScript host, and 401 without the Bearer', async () => {
    const js = snapshotHost();
    expect(await marksOf(js)).toEqual({ documents: [], keys: {} });
    const { handler } = handlerOver([js.cwd]);
    const refused = await handler(
      req(`/api/site/marks?site=${encodeURIComponent(realpathSync(js.cwd))}`, { token: null }),
    );
    expect(refused.status).toBe(401);
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
  const NONCE = 'test-nonce';
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
          version: '0.3.1',
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
      ['/api/site/marks', 200, { documents: [], keys: {} }],
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

  interface Painted {
    dom: JSDOM;
    errors: string[];
    /** The body `GET /api/workspace` answers. Mutable, so a case can change what a reload sees. */
    workspace: { sites: Array<Record<string, unknown>> };
    /** Every request the page made, in order, with the body it sent. */
    sent: Array<{ path: string; body: unknown }>;
    /** Change what one route answers from here on: a body, or a function called per request; `delay` holds the reply back. */
    answer(path: string, status: number, body: unknown, delay?: number): void;
    /** The paths of every request sent so far whose path starts with `prefix`. */
    requested(prefix: string): string[];
    /** This page's local storage, as a map a second page can be seeded with. */
    storage(): Record<string, string>;
    /** Clicks the one control carrying this `data-act`, then lets the page settle. */
    act(name: string): Promise<void>;
    /** Sets a `data-act-change` select and fires the event the page listens for. */
    change(name: string, value: string): Promise<void>;
    /** Types into a `data-act-input` field and fires the event the page listens for. */
    type(name: string, value: string): Promise<void>;
    /** The same, with the field focused and the caret where a real keystroke would leave it. */
    typeAt(name: string, value: string, at: number): Promise<void>;
    /** The keys the list is showing right now. */
    keys(): string[];
    settle(): Promise<void>;
    html(): string;
    toast(): string;
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
    } = {},
  ): Promise<Painted> {
    const site = opts.site ?? siteBody();
    const table = new Map<string, [number, unknown, number?]>();
    for (const [path, status, body] of routeTable(site)) table.set(path, [status, body]);
    const workspace = (table.get('/api/workspace') as [number, { sites: Array<Record<string, unknown>> }])[1];
    if (opts.sites !== undefined) workspace.sites = opts.sites;
    const sent: Array<{ path: string; body: unknown }> = [];
    table.set('/api/site', [200, site]);
    table.set('/api/site/preview', [200, opts.preview ?? { url: 'http://localhost:4321/', up: false, start: 'npx astro dev', source: 'astro' }]);
    for (const [path, status, body, delay] of opts.routes ?? []) table.set(path, [status, body, delay]);

    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => errors.push(`${error.name}: ${error.message}`));
    virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));

    const token = opts.token ?? 'fixture-token';
    const accepted = opts.expects ?? token;
    const dom = new JSDOM(dashboardPage().split('__STET_NONCE__').join(NONCE), {
      url: `http://127.0.0.1:4400/${opts.url ?? (token === '' ? '' : `?t=${token}`)}`,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        for (const [name, value] of Object.entries(opts.storage ?? {})) window.localStorage.setItem(name, value);
        for (const [name, value] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(name, value);
        (window as unknown as { fetch: unknown }).fetch = async (
          path: string,
          init?: { headers?: Record<string, string>; body?: string },
        ) => {
          // Every request must carry the run token: a stub that answered
          // without it would hide a broken header.
          if (init?.headers?.['authorization'] !== `Bearer ${accepted}`) {
            return { status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) };
          }
          sent.push({
            path: String(path),
            body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
          });
          const found = table.get(String(path).split('?')[0] ?? '');
          if (found === undefined) return { status: 404, ok: false, json: async () => ({ error: 'not found' }) };
          if (found[2] !== undefined) await new Promise((resolve) => setTimeout(resolve, found[2]));
          const payload = typeof found[1] === 'function' ? (found[1] as () => unknown)() : found[1];
          // A fresh copy per answer, as a real reply is: the page must not hold
          // a reference into the fixture's own tables.
          return {
            status: found[0],
            ok: found[0] < 400,
            json: async () => JSON.parse(JSON.stringify(payload)) as unknown,
          };
        };
      },
    });

    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await settle();

    const painted: Painted = {
      dom,
      errors,
      workspace,
      sent,
      answer(path: string, status: number, body: unknown, delay?: number): void {
        table.set(path, [status, body, delay]);
      },
      requested: (prefix: string) => sent.map((r) => r.path).filter((path) => path.startsWith(prefix)),
      storage(): Record<string, string> {
        const held = dom.window.localStorage;
        const out: Record<string, string> = {};
        for (let i = 0; i < held.length; i += 1) {
          const name = held.key(i) as string;
          out[name] = held.getItem(name) as string;
        }
        return out;
      },
      settle,
      html: () => dom.window.document.body.outerHTML,
      toast: () => dom.window.document.getElementById('tst')?.textContent ?? '',
      async change(name: string, value: string): Promise<void> {
        const el = dom.window.document.querySelector(`[data-act-change="${name}"]`) as HTMLSelectElement | null;
        expect(el, `no control carries data-act-change="${name}"`).not.toBeNull();
        (el as HTMLSelectElement).value = value;
        (el as HTMLSelectElement).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await settle();
        expect(errors, `after ${name}=${value}`).toEqual([]);
      },
      async type(name: string, value: string): Promise<void> {
        const el = dom.window.document.querySelector(`[data-act-input="${name}"]`) as HTMLTextAreaElement | null;
        expect(el, `no control carries data-act-input="${name}"`).not.toBeNull();
        (el as HTMLTextAreaElement).value = value;
        (el as HTMLTextAreaElement).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await settle();
        expect(errors, `after typing into ${name}`).toEqual([]);
      },
      async typeAt(name: string, value: string, at: number): Promise<void> {
        const el = dom.window.document.querySelector(`[data-act-input="${name}"]`) as HTMLTextAreaElement | null;
        expect(el, `no control carries data-act-input="${name}"`).not.toBeNull();
        const field = el as HTMLTextAreaElement;
        field.focus();
        field.value = value;
        field.selectionStart = at;
        field.selectionEnd = at;
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await settle();
        expect(errors, `after typing into ${name}`).toEqual([]);
      },
      keys(): string[] {
        return [...dom.window.document.querySelectorAll('[data-act^="key:"]')].map(
          (el) => (el.getAttribute('data-act') ?? '').slice('key:'.length),
        );
      },
      async act(name: string): Promise<void> {
        const el = dom.window.document.querySelector(`[data-act="${name}"]`);
        expect(el, `no control carries data-act="${name}"`).not.toBeNull();
        (el as HTMLElement).click();
        await settle();
        // A loader's own failure is swallowed by the page's guard and shown as
        // a toast, so the toast is read as an error channel here.
        expect(painted.toast(), `after ${name}`).not.toMatch(/is not defined|is not a function/);
        expect(errors, `after ${name}`).toEqual([]);
      },
    };
    return painted;
  }

  /** Every inline event-handler attribute in a tree — the thing the policy forbids. */
  function inlineHandlers(html: string): string[] {
    return html.match(/\bon[a-z]+="/g) ?? [];
  }

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
    expect(groupIds).toEqual(['page:home', 'prefix:brand', 'prefix:loose', 'prefix:unseeded', 'prefix:welcome']);
    for (const group of groupIds) {
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

  it('offers Push once a commit has landed, and Commit only while stet files are uncommitted (journey B18)', async () => {
    const page = await paint({ site: siteBody({ pending: ['stet/defaults.json'] }) });
    const shows = (act: string): boolean =>
      page.dom.window.document.querySelector(`#gitbar [data-act="${act}"]`) !== null;
    // Files a save left uncommitted, read from the checkout: Commit, no Push.
    expect(shows('commit')).toBe(true);
    expect(shows('push')).toBe(false);

    page.answer('/api/site/commit', 200, {
      sha: 'def5678abc',
      short: 'def5678',
      subject: 'stet: 1 key updated — hero_headline',
      at: { head: 'def5678', branch: 'main', dirty: false },
      pending: [],
    });
    await page.act('commit');
    // The commit landed and the reply lists nothing: Commit goes, Push stays.
    expect(shows('commit')).toBe(false);
    expect(shows('push')).toBe(true);

    // Unsaved work: Push goes until it is saved.
    await page.act('key:hero_headline');
    await page.type('text:hero_headline', 'A headline that fits');
    expect(shows('push')).toBe(false);
    expect(page.errors).toEqual([]);
    page.dom.window.close();
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
    await page.change('enum:hero_tone', 'calm');
    await page.act('save');
    expect(page.dom.window.document.querySelector('#gitbar [data-act="commit"]')).not.toBeNull();

    await page.act('commit');
    const body = page.sent.filter((r) => r.path.startsWith('/api/site/commit')).at(-1)?.body;
    expect(body).toEqual({ files: ['stet/defaults.json'] });
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
    expect(painted(reload)).toContain('project other-site');
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
    expect(doc.querySelector('#gitbar [data-act="commit"]')).not.toBeNull();
    expect(doc.querySelector('[data-act="push"]')).toBeNull();
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
      at: { head: 'def5678', branch: 'main', dirty: false },
      pending: [],
    });
    await page.act('commit');
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
    expect(card().hidden).toBe(false);
    // Held back, so the card is read while the commit is still in flight.
    page.answer('/api/site/commit', 409, { error: 'git commit failed', output: 'no', pending: ['stet/defaults.json'] }, 300);
    await page.act('commit');
    expect(page.requested('/api/site/commit')).toHaveLength(2);
    expect(card().hidden).toBe(true);
    // The held reply lands before the window goes, so nothing paints into a closed page.
    expect(await until(() => !card().hidden)).toBe(true);
    page.dom.window.close();
  });

  // 5.3 — the sidebar
  it('tells two checkouts named alike apart, and names each ready row’s host and project (journey A19)', async () => {
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
      ['stet-website-v1/site', 'js host · astro', 'project default'],
      ['stet-planning/site', 'js host · astro', 'project default'],
      ['psyon-site', 'html host', 'project psyon'],
    ]);
    first.dom.window.close();

    const second = await paint({
      sites: [row('/a/x/site', 'js', 'app', 'a'), row('/b/x/site', 'js', 'app', 'b'), row('/c/y/site', 'js', 'app', 'c')],
    });
    expect(rows(second).map((r) => r[0])).toEqual(['a/x/site', 'b/x/site', 'y/site']);
    second.dom.window.close();
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
    route.value = 'docs/quickstart/';
    route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    await page.settle();
    const storage = page.storage();
    page.dom.window.close();

    const next = await paint({ storage });
    expect(next.requested('/api/site/preview')[0]).toContain('route=%2Fdocs%2Fquickstart%2F');
    expect((docOf(next).getElementById('route') as HTMLInputElement).value).toBe('/docs/quickstart/');
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
      return {
        posts,
        say,
        spy,
        frame,
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
      expect(note(page).hidden).toBe(true);
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
      expect(agent.locates().slice(before).some((m) => JSON.stringify(m['texts']) === JSON.stringify(['In place']))).toBe(true);
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
    expect((docOf(late).getElementById('gsel') as HTMLSelectElement | null)?.value ?? 'doc:index.html').toBe('doc:index.html');
    expect(late.keys()).toEqual(Object.keys(descriptor.keys).sort());
    late.dom.window.close();

    const refused = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 409, { error: 'index.html could not be read' }]],
    });
    expect((docOf(refused).getElementById('gsel') as HTMLSelectElement).value).toBe('prefix:brand');
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
    expect(labels).toEqual(['home — page', 'brand', 'loose', 'unseeded', 'welcome']);
    expect(painted(page)).not.toContain('>Other<');
    page.dom.window.close();
  });

  it('groups an html host’s keys by the document they are marked in, then by its page (journeys A19, B17)', async () => {
    // One group, so no selector: a query that every key name matches puts each
    // row's group label beside it.
    const groupOfEveryRow = async (page: Painted): Promise<string[]> => {
      expect(docOf(page).getElementById('gsel')).toBeNull();
      expect(page.keys()).toEqual(Object.keys(descriptor.keys).sort());
      await page.type('search', '_');
      return [
        ...new Set(
          [...docOf(page).querySelectorAll('[data-act^="key:"]')].map(
            (row) => [...row.querySelectorAll('.bdg')].at(-1)?.textContent ?? '',
          ),
        ),
      ];
    };
    const byDocument = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 200, allMarkedIn('index.html', null)]],
    });
    expect(await groupOfEveryRow(byDocument)).toEqual(['index.html']);
    byDocument.dom.window.close();

    const byPage = await paint({
      site: siteBody({ host: 'html', descriptor: unpaged }),
      routes: [['/api/site/marks', 200, allMarkedIn('index.html', 'home')]],
    });
    expect(await groupOfEveryRow(byPage)).toEqual(['home — page']);
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
    expect(painted(page)).toContain('71 characters over a 60 limit');
    await page.type('text:hero_headline', 'x'.repeat(72));
    expect(painted(page)).not.toContain('71 characters over a 60 limit');
    expect(docOf(page).getElementById('refusal')).toBeNull();
    await page.act('save');
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
});

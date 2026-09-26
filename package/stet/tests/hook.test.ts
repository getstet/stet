/**
 * `stet hook install` — the opt-in pre-commit gate. Each case builds a temp git
 * repo and installs into it, asserting the executable bit, the runner and list
 * in git's common directory, the git-resolved hooks directory (a `core.hooksPath`
 * inside the worktree gets the gate's line as an instruction), the identical-hook
 * no-op, the differing-hook refusal, and the not-a-repo error. The gate's cases
 * commit with the registry unreachable, so a fetch would fail rather than pass.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { cleanupCliHosts, makeHtmlHost } from '../conformance/cli-host.js';
import { runDoctor } from '../cli/doctor.js';
import { runEject } from '../cli/eject.js';
import { GATE_LINE, HOOK_BEFORE_0_3_1, readGate, runHookInstall, runHookRemove, SHARED_GATE_LINE } from '../cli/hook.js';
import { packageRoot } from '../cli/installed.js';
import type { CliIo } from '../cli/main.js';
import { builtBinExists, installStetShim } from './helpers/stet-shim.js';

const shipped = readFileSync(join(packageRoot(), 'templates', 'pre-commit'), 'utf8');
const runner = readFileSync(join(packageRoot(), 'templates', 'stet-gate.mjs'), 'utf8');
const made: string[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-hook-'));
  made.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'stet.config.json'), '{}\n');
  return dir;
}
function io(dir: string): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), out, err };
}

afterAll(() => {
  for (const dir of made) execFileSync('rm', ['-rf', dir]);
});
afterAll(cleanupCliHosts);

describe('runHookInstall', () => {
  it('writes an executable pre-commit gate from the shipped template', async () => {
    const dir = repo();
    expect(await runHookInstall([], io(dir))).toBe(0);
    const hook = join(dir, '.git/hooks/pre-commit');
    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(hook, 'utf8')).toBe(shipped);
    expect(statSync(hook).mode & 0o111).not.toBe(0); // git ignores a non-executable hook
    // The runner beside its list, both in git's common directory.
    expect(readFileSync(join(dir, '.git/stet-gate.mjs'), 'utf8')).toBe(runner);
    expect(JSON.parse(readFileSync(join(dir, '.git/stet-gate.json'), 'utf8'))).toEqual({
      entries: [{ worktree: '', checkout: '', seo: true }],
    });
  });

  it('refuses a folder that holds no stet.config.json, writing nothing', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'notes'));
    const cap = io(join(dir, 'notes'));
    await expect(runHookInstall([], cap)).rejects.toThrow(
      'hook install runs in a stet checkout — cd to the folder that holds stet.config.json',
    );
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
    expect(existsSync(join(dir, '.git/stet-gate.json'))).toBe(false);
  });

  it('resolves the hooks dir from git — a core.hooksPath redirect is honored', async () => {
    const log = logFile();
    // The resolved path, as the CLI's working directory always is: the hooks
    // folder does not exist yet, so it cannot be resolved through a symlinked
    // temp directory (macOS's /var) the way the repository's top is.
    const dir = realpathSync(gitRepo());
    standInCheckout(dir, '', log);
    execFileSync('git', ['config', 'core.hooksPath', 'my-hooks'], { cwd: dir });
    const cap = io(dir);
    expect(await runHookInstall([], cap)).toBe(0);
    // The redirected folder is the hooks manager's: the gate's line is the
    // instruction, and no hook file is written there or in .git/hooks.
    expect(cap.out.join('\n')).toContain(
      `the stet pre-commit gate is ready; add this line to ${join(dir, 'my-hooks/pre-commit')}: ${GATE_LINE}`,
    );
    expect(existsSync(join(dir, 'my-hooks/pre-commit'))).toBe(false);
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
    mkdirSync(join(dir, 'my-hooks'));
    writeFileSync(join(dir, 'my-hooks/pre-commit'), `#!/bin/sh\n${GATE_LINE}\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'page.txt'), 'a change\n');
    expect(commit(dir, 'gated by the pasted line').code).toBe(0);
    expect(drain(log)).toEqual([`check in ${basename(dir)}`, `scan in ${basename(dir)}`, `seo check in ${basename(dir)}`]);
  });

  it('is a no-op when the identical hook is already installed', async () => {
    const dir = repo();
    expect(await runHookInstall([], io(dir))).toBe(0);
    const cap = io(dir);
    expect(await runHookInstall([], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('already installed');
  });

  it('refuses a differing existing hook rather than clobbering it', async () => {
    const dir = repo();
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho custom\n', 'utf8');
    await expect(runHookInstall([], io(dir))).rejects.toThrow(/differs from the shipped hook/);
    expect(readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8')).toContain('echo custom');
  });

  it('errors when run outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-nohook-'));
    made.push(dir);
    await expect(runHookInstall([], io(dir))).rejects.toThrow(/needs a git repository/);
  });
});

// --- the gate: one hook, a list of checkouts ---------------------------------

/** The older gate's warn, as doctor words it. */
const OLDER =
  'hook: the stet pre-commit gate is the older form, which runs npx stet from the top of the repository ' +
  'and can fetch a package that is not stet — run stet hook install to replace it';

/** Every commit's environment: a registry that refuses at once, so a fetch fails rather than passes. */
const REGISTRY_DOWN = { ...process.env, npm_config_registry: 'http://127.0.0.1:9' };

/** A log file outside every fixture repository, for the stand-in stets to append to. */
function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-gate-log-'));
  made.push(dir);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  return log;
}

/** What the stand-ins logged since the last drain, one entry per run; the log is emptied. */
function drain(log: string): string[] {
  const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
  writeFileSync(log, '');
  return lines.map((line) => JSON.parse(line) as string);
}

/** A repository with an identity and `node_modules` ignored at any depth. */
function gitRepo(): string {
  const top = mkdtempSync(join(tmpdir(), 'stet-gate-'));
  made.push(top);
  execFileSync('git', ['init', '-q'], { cwd: top });
  for (const [key, value] of [['user.email', 'gate@test'], ['user.name', 'gate'], ['commit.gpgsign', 'false']]) {
    execFileSync('git', ['config', key as string, value as string], { cwd: top });
  }
  writeFileSync(join(top, '.gitignore'), 'node_modules\ntools\n');
  return top;
}

/**
 * A stand-in `node_modules/.bin/stet` in `dir` that appends `<arguments> in
 * <folder>` to `log`, as JSON so a folder name holding a newline stays one entry.
 */
function standIn(dir: string, log: string): void {
  const bin = join(dir, 'node_modules', '.bin', 'stet');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, ` +
      "JSON.stringify(process.argv.slice(2).join(' ') + ' in ' + require('node:path').basename(process.cwd())) + '\\n');\n",
  );
  chmodSync(bin, 0o755);
}

/** A checkout at `folder` of `top` (empty for the top) that the runner accepts, with a stand-in stet. */
function standInCheckout(top: string, folder: string, log: string): string {
  const dir = folder === '' ? top : join(top, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stet.config.json'), '{}\n');
  standIn(dir, log);
  return dir;
}

/** Everything staged and committed from `cwd` — a worktree's top, where git runs a hook. */
function commit(cwd: string, message: string): { code: number; out: string; ms: number } {
  execFileSync('git', ['add', '-A'], { cwd });
  const started = Date.now();
  const run = spawnSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8', env: REGISTRY_DOWN });
  return { code: run.status ?? 1, out: `${run.stdout}${run.stderr}`, ms: Date.now() - started };
}

const head = (top: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: top, encoding: 'utf8' }).trim();

/**
 * A repository holding an adopted static-HTML checkout in each of `folders`
 * (empty for the repository's top), each with a local stet — the built bin, or
 * a stand-in logging to `log` — committed.
 */
async function gatedRepo(folders: string[], stet: 'built' | { log: string }): Promise<{ top: string; checkouts: string[] }> {
  const top = gitRepo();
  const checkouts: string[] = [];
  for (const folder of folders) {
    const host = await makeHtmlHost({ register: true });
    const checkout = folder === '' ? top : join(top, folder);
    mkdirSync(checkout, { recursive: true });
    cpSync(host.cwd, checkout, { recursive: true });
    if (stet === 'built') installStetShim(checkout);
    else standIn(checkout, stet.log);
    checkouts.push(checkout);
  }
  writeFileSync(join(top, '.gitignore'), 'node_modules\ntools\n');
  commit(top, 'base');
  return { top, checkouts };
}

/** A marked document edited where no mark reaches, which `check` keeps green. */
function editDocument(checkout: string): void {
  const page = join(checkout, 'index.html');
  writeFileSync(page, `${readFileSync(page, 'utf8')}<!-- an edit outside every mark -->\n`);
}

/** The first key's value made a number, which `check` refuses on a text key. */
function breakSnapshot(checkout: string): void {
  const file = join(checkout, 'content/defaults.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { default: Record<string, unknown> };
  const key = Object.keys(snapshot.default)[0] as string;
  snapshot.default[key] = 42;
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Every path under `dir`, recursively. */
function allPaths(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' });
}

describe('the gate runs in the checkouts it lists, and never fetches stet', () => {
  it('(a) gates only the worktree a checkout was installed from', async () => {
    const log = logFile();
    const main = gitRepo();
    standInCheckout(main, 'site', log);
    writeFileSync(join(main, 'notes.md'), 'notes\n');
    commit(main, 'base');
    const linked = join(mkdtempSync(join(tmpdir(), 'stet-gate-wt-')), 'linked');
    made.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: main });
    standIn(join(linked, 'site'), log);
    expect(await runHookInstall([], io(join(linked, 'site')))).toBe(0);
    expect(readGate(join(main, '.git'))).toEqual([{ worktree: 'worktrees/linked', checkout: 'site', seo: true }]);

    appendFileSync(join(main, 'notes.md'), 'more\n');
    const notes = commit(main, 'a planning commit');
    expect(notes.code, notes.out).toBe(0);
    expect(drain(log)).toEqual([]);
    // The main worktree's own `site/` is not the listed one.
    writeFileSync(join(main, 'site/page.txt'), 'main\n');
    const mainSite = commit(main, 'the main worktree touches site/');
    expect(mainSite.code, mainSite.out).toBe(0);
    expect(drain(log)).toEqual([]);

    writeFileSync(join(linked, 'site/page.txt'), 'linked\n');
    const gated = commit(linked, 'the linked worktree touches site/');
    expect(gated.code, gated.out).toBe(0);
    expect(drain(log)).toEqual(['check in site', 'scan in site', 'seo check in site']);
  });

  it('(b) runs only the listed checkouts a commit touches', async () => {
    const log = logFile();
    const top = gitRepo();
    const a = standInCheckout(top, 'a', log);
    const b = standInCheckout(top, 'b', log);
    writeFileSync(join(top, 'notes.md'), 'notes\n');
    commit(top, 'base');
    expect(await runHookInstall([], io(a))).toBe(0);
    expect(await runHookInstall([], io(b))).toBe(0);
    expect(readGate(join(top, '.git'))).toEqual([
      { worktree: '', checkout: 'a', seo: true },
      { worktree: '', checkout: 'b', seo: true },
    ]);

    writeFileSync(join(a, 'page.txt'), 'a\n');
    expect(commit(top, 'a alone').code).toBe(0);
    expect(drain(log)).toEqual(['check in a', 'scan in a', 'seo check in a']);
    writeFileSync(join(a, 'page.txt'), 'a again\n');
    writeFileSync(join(b, 'page.txt'), 'b\n');
    expect(commit(top, 'both').code).toBe(0);
    expect(drain(log)).toEqual(['check in a', 'scan in a', 'seo check in a', 'check in b', 'scan in b', 'seo check in b']);
    appendFileSync(join(top, 'notes.md'), 'more\n');
    expect(commit(top, 'neither').code).toBe(0);
    expect(drain(log)).toEqual([]);
  });

  it('(c) fails at once naming the folder with no local stet, and runs a workspace install above it', async () => {
    const log = logFile();
    const top = gitRepo();
    const b = standInCheckout(top, 'b', log);
    commit(top, 'base');
    expect(await runHookInstall([], io(b))).toBe(0);
    renameSync(join(b, 'node_modules'), join(b, 'node_modules.away'));
    writeFileSync(join(b, 'page.txt'), 'b\n');
    const before = head(top);
    const missing = commit(top, 'no stet in b/');
    expect(missing.code).not.toBe(0);
    expect(missing.ms).toBeLessThan(5_000);
    expect(missing.out).toContain(
      'stet pre-commit gate: stet is not installed in b/ — run npm install there, or take it out of the gate with stet hook remove there',
    );
    expect(head(top)).toBe(before);
    expect(drain(log)).toEqual([]);

    standIn(top, log);
    const hoisted = commit(top, 'a workspace install at the top');
    expect(hoisted.code, hoisted.out).toBe(0);
    expect(drain(log)).toEqual(['check in b', 'scan in b', 'seo check in b']);
  });

  // The runner runs the stet installed in its checkout; here that is the built bin.
  for (const [folder, named] of [
    ['site', 'site/'],
    ['', 'the repository root'],
  ] as const) {
    it.skipIf(!builtBinExists())(
      `(d) commits, refuses a broken snapshot, and names ${named} when stet is not installed`,
      async () => {
        const { top, checkouts } = await gatedRepo([folder], 'built');
        const checkout = checkouts[0] as string;
        expect(await runHookInstall([], io(checkout))).toBe(0);
        expect(readFileSync(join(top, '.git/hooks/pre-commit'), 'utf8')).toBe(shipped);

        editDocument(checkout);
        const landed = commit(top, 'an edit the gate passes');
        expect(landed.code, landed.out).toBe(0);
        expect(landed.ms).toBeLessThan(5_000);
        expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: top, encoding: 'utf8' }).trim()).toBe(
          'an edit the gate passes',
        );

        breakSnapshot(checkout);
        const before = head(top);
        const refused = commit(top, 'a broken snapshot');
        expect(refused.code).not.toBe(0);
        expect(refused.out).toContain('fails the declared text shape');
        expect(head(top)).toBe(before);
        execFileSync('git', ['reset', '-q', '--hard'], { cwd: top });

        renameSync(join(checkout, 'node_modules'), join(checkout, 'node_modules.away'));
        editDocument(checkout);
        const missing = commit(top, 'no stet here');
        expect(missing.code).not.toBe(0);
        expect(missing.out).toContain(
          `stet pre-commit gate: stet is not installed in ${named} — run npm install there, or take it out of the gate with stet hook remove there`,
        );
        expect(head(top)).toBe(before);
      },
      60_000,
    );
  }

  it('(e) lists a hostile folder name exactly, gates it in its own folder, and never executes it', async () => {
    const log = logFile();
    const top = gitRepo();
    const names = ['a b\'c$(touch PWNED1)`touch PWNED2`;"q"', 'new\nline', ' lead', 'ünï cödé ✓'];
    const dirs = names.map((name) => standInCheckout(top, name, log));
    commit(top, 'base');
    for (const dir of dirs) expect(await runHookInstall([], io(dir))).toBe(0);
    expect(readGate(join(top, '.git')).map((entry) => entry.checkout)).toEqual(names);
    for (const [i, name] of names.entries()) {
      writeFileSync(join(dirs[i] as string, 'page.txt'), `${i}\n`);
      const ran = commit(top, `touch ${i}`);
      expect(ran.code, ran.out).toBe(0);
      expect(drain(log)).toEqual([`check in ${name}`, `scan in ${name}`, `seo check in ${name}`]);
    }
    // The first name spells `PWNED1` and `PWNED2`; only a file of that name would mean it ran.
    const pwned = (path: string): boolean => /^PWNED\d$/.test(basename(path));
    expect(allPaths(top).filter(pwned)).toEqual([]);
  }, 30_000);

  it('(f) refuses a hooks folder outside the repository, and its line gates only a repository with a gate', async () => {
    const log = logFile();
    const { top, checkouts } = await gatedRepo(['site'], { log });
    const checkout = checkouts[0] as string;
    const shared = mkdtempSync(join(tmpdir(), 'stet-shared-hooks-'));
    made.push(shared);
    execFileSync('git', ['config', 'core.hooksPath', shared], { cwd: top });
    await expect(runHookInstall([], io(checkout))).rejects.toThrow(
      `core.hooksPath points at ${shared}, which other repositories may share — add this line to the hook there by hand: ${SHARED_GATE_LINE}`,
    );
    expect(readdirSync(shared)).toEqual([]);
    // The runner and the list are in place, so the pasted line gates this repository.
    expect(readGate(join(top, '.git'))).toEqual([{ worktree: '', checkout: 'site', seo: true }]);
    expect(existsSync(join(top, '.git/stet-gate.mjs'))).toBe(true);
    const doctor = io(checkout);
    await runDoctor([], doctor);
    expect(`${doctor.out.join('\n')}\n${doctor.err.join('\n')}`).toContain(
      `hook: core.hooksPath points at ${shared}, outside this repository — stet hook install leaves it alone; add the gate's line there by hand`,
    );

    writeFileSync(join(shared, 'pre-commit'), `#!/bin/sh\n${SHARED_GATE_LINE}\n`, { mode: 0o755 });
    editDocument(checkout);
    expect(commit(top, 'gated through the shared folder').code).toBe(0);
    expect(drain(log)).toEqual(['check in site', 'scan in site', 'seo check in site']);
    // Another repository reading the same folder has no gate: its commit passes untouched.
    const other = gitRepo();
    execFileSync('git', ['config', 'core.hooksPath', shared], { cwd: other });
    writeFileSync(join(other, 'notes.md'), 'notes\n');
    const unrelated = commit(other, 'another repository');
    expect(unrelated.code, unrelated.out).toBe(0);
    expect(drain(log)).toEqual([]);
  });

  it("(f2) gives a hooks manager's folder the gate's line, and gates once the line is pasted", async () => {
    const log = logFile();
    const { top, checkouts } = await gatedRepo(['site'], { log });
    const checkout = checkouts[0] as string;
    const husky = join(top, '.husky/pre-commit');
    mkdirSync(join(top, '.husky'));
    const own = `#!/bin/sh\nprintf '%s\\n' '"husky"' >> ${JSON.stringify(log)}\n`;
    writeFileSync(husky, own, { mode: 0o755 });
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: top });
    commit(top, 'husky');
    drain(log);

    const install = io(checkout);
    expect(await runHookInstall([], install)).toBe(0);
    expect(install.out.join('\n')).toContain(`the stet pre-commit gate is ready; add this line to ${husky}: ${GATE_LINE}`);
    expect(existsSync(join(top, '.git/stet-gate.mjs'))).toBe(true);
    expect(readGate(join(top, '.git'))).toEqual([{ worktree: '', checkout: 'site', seo: true }]);
    expect(readFileSync(husky, 'utf8')).toBe(own);
    expect(existsSync(join(top, '.git/hooks/pre-commit'))).toBe(false);

    editDocument(checkout);
    expect(commit(top, 'before the paste').code).toBe(0);
    expect(drain(log)).toEqual(['husky']);
    const missing = io(checkout);
    await runDoctor([], missing);
    expect(missing.out.join('\n')).toContain(`hook: ${husky} does not run the stet pre-commit gate — add this line to it: ${GATE_LINE}`);

    appendFileSync(husky, `${GATE_LINE}\n`);
    editDocument(checkout);
    expect(commit(top, 'after the paste').code).toBe(0);
    expect(drain(log)).toEqual(['husky', 'check in site', 'scan in site', 'seo check in site']);
    const again = io(checkout);
    expect(await runHookInstall([], again)).toBe(0);
    expect(again.out.join('\n')).toContain(
      `${husky} runs the stet pre-commit gate — it runs stet check, stet scan and stet seo check in site/ when a commit touches it`,
    );
    const present = io(checkout);
    await runDoctor([], present);
    expect(present.out.join('\n')).toContain(`hook: ${husky} runs the stet pre-commit gate`);
  });

  it('(f3) refuses a foreign hook with the gate line, and accepts it once the line is there', async () => {
    const log = logFile();
    const { top, checkouts } = await gatedRepo(['site'], { log });
    const checkout = checkouts[0] as string;
    const hookPath = join(top, '.git/hooks/pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    await expect(runHookInstall([], io(checkout))).rejects.toThrow(
      `${hookPath} already exists and differs from the shipped hook — remove it and re-run, or add this line to it and re-run: ${GATE_LINE}`,
    );
    expect(existsSync(join(top, '.git/stet-gate.mjs'))).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.json'))).toBe(false);

    appendFileSync(hookPath, `${GATE_LINE}\n`);
    const again = io(checkout);
    expect(await runHookInstall([], again)).toBe(0);
    expect(again.out.join('\n')).toContain(`${hookPath} runs the stet pre-commit gate`);
    editDocument(checkout);
    expect(commit(top, 'through the foreign hook').code).toBe(0);
    expect(drain(log)).toEqual(['check in site', 'scan in site', 'seo check in site']);
  });

  it("(f4) under husky v9 names .husky/pre-commit, where the line runs, and never the generated stub", async () => {
    const log = logFile();
    const { top, checkouts } = await gatedRepo(['site'], { log });
    const checkout = checkouts[0] as string;
    // Husky v9's layout: a generated, gitignored `.husky/_` whose stubs source
    // `h`, which runs the operator's `.husky/<hook>` and exits.
    const generated = join(top, '.husky/_');
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, '.gitignore'), '*\n');
    writeFileSync(
      join(generated, 'h'),
      '#!/usr/bin/env sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"\nexit $?\n',
      { mode: 0o755 },
    );
    const stub = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    writeFileSync(join(generated, 'pre-commit'), stub, { mode: 0o755 });
    const husky = join(top, '.husky/pre-commit');
    writeFileSync(husky, `printf '%s\\n' '"husky"' >> ${JSON.stringify(log)}\n`);
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: top });
    commit(top, 'husky');
    drain(log);

    const install = io(checkout);
    expect(await runHookInstall([], install)).toBe(0);
    expect(install.out.join('\n')).toContain(
      `the stet pre-commit gate is ready; add this line to ${husky}, which husky runs from ${generated}: ${GATE_LINE}`,
    );
    const before = io(checkout);
    await runDoctor([], before);
    expect(before.out.join('\n')).toContain(
      `hook: ${husky} does not run the stet pre-commit gate — add this line to it, which husky runs from ${generated}: ${GATE_LINE}`,
    );

    appendFileSync(husky, `${GATE_LINE}\n`);
    editDocument(checkout);
    expect(commit(top, 'through husky').code).toBe(0);
    expect(drain(log)).toEqual(['husky', 'check in site', 'scan in site', 'seo check in site']);
    expect(readFileSync(join(generated, 'pre-commit'), 'utf8')).toBe(stub);
    const again = io(checkout);
    expect(await runHookInstall([], again)).toBe(0);
    expect(again.out.join('\n')).toContain(`${husky} runs the stet pre-commit gate`);
    const after = io(checkout);
    await runDoctor([], after);
    expect(after.out.join('\n')).toContain(`hook: ${husky} runs the stet pre-commit gate`);
  });

  it('(c2) names a local stet that is there but cannot start', async () => {
    const log = logFile();
    // The gate names the resolved path; on macOS the temp folder is a /var → /private/var link.
    const top = realpathSync(gitRepo());
    const site = standInCheckout(top, 'site', log);
    commit(top, 'base');
    expect(await runHookInstall([], io(site))).toBe(0);
    // A folder where the bin should be: it passes the executable test and cannot run.
    const bin = join(site, 'node_modules/.bin/stet');
    rmSync(bin);
    mkdirSync(bin);
    writeFileSync(join(site, 'page.txt'), 'x\n');
    const refused = commit(top, 'a stet that cannot start');
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain(`stet pre-commit gate: ${bin} could not run: `);
  });

  it.skipIf(['/usr/bin/node', '/bin/node'].some((node) => existsSync(node)))(
    '(n) names node when it is not on the PATH a commit runs with',
    async () => {
      const top = gitRepo();
      const site = standInCheckout(top, 'site', logFile());
      commit(top, 'base');
      expect(await runHookInstall([], io(site))).toBe(0);
      writeFileSync(join(top, 'notes.md'), 'notes\n');
      execFileSync('git', ['add', '-A'], { cwd: top });
      const run = spawnSync('git', ['commit', '-qm', 'from a client without node'], {
        cwd: top,
        encoding: 'utf8',
        env: { ...REGISTRY_DOWN, PATH: '/usr/bin:/bin' },
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        'stet pre-commit gate: node is not on PATH — commit from a shell where node runs, or add node to the PATH your git client uses',
      );
    },
  );

  it('(j) asks git whether a checkout is touched, so a commit staging megabytes of names runs the gate once', async () => {
    const log = logFile();
    const top = gitRepo();
    const site = standInCheckout(top, 'site', log);
    commit(top, 'base');
    expect(await runHookInstall([], io(site))).toBe(0);
    // Twenty thousand long names straight into the index, one blob for all:
    // more than 1 MiB of names, with nothing written to disk.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: top, input: 'x\n', encoding: 'utf8' }).trim();
    const name = 'a-page-name-long-enough-that-twenty-thousand-of-them-pass-one-mebibyte';
    const info = Array.from({ length: 20_000 }, (_, i) => `100644 ${blob}\tsite/big/${name}-${i}.html`).join('\n');
    execFileSync('git', ['update-index', '--index-info'], { cwd: top, input: `${info}\n` });
    const run = spawnSync('git', ['commit', '-qm', 'a large commit'], { cwd: top, encoding: 'utf8', env: REGISTRY_DOWN });
    expect(run.status, `${run.stdout}${run.stderr}`.slice(0, 400)).toBe(0);
    expect(drain(log)).toEqual(['check in site', 'scan in site', 'seo check in site']);
  }, 30_000);

  it('(k) reads a checkout folder literally, never as a pattern or as pathspec magic', async () => {
    const log = logFile();
    const top = gitRepo();
    const glob = standInCheckout(top, '[ab]', log);
    // Read as a pathspec, `:!b/` is git's "everything but b/".
    const magic = standInCheckout(top, ':!b', log);
    mkdirSync(join(top, 'a'));
    writeFileSync(join(top, 'a/page.txt'), 'a\n');
    commit(top, 'base');
    expect(await runHookInstall([], io(glob))).toBe(0);
    expect(await runHookInstall([], io(magic))).toBe(0);
    writeFileSync(join(top, 'a/page.txt'), 'a changed\n');
    expect(commit(top, 'touches a/ alone').code).toBe(0);
    expect(drain(log)).toEqual([]);
    writeFileSync(join(glob, 'page.txt'), 'b\n');
    expect(commit(top, 'touches [ab]/').code).toBe(0);
    expect(drain(log)).toEqual(['check in [ab]', 'scan in [ab]', 'seo check in [ab]']);
  });

  it("(l) stops looking for stet at the committing worktree's top, even inside the main checkout", async () => {
    // The operator's layout: linked worktrees under the main checkout's
    // `.claude/worktrees/`, with a stet installed at the main checkout's top.
    const log = logFile();
    const main = gitRepo();
    appendFileSync(join(main, '.gitignore'), '.claude\n');
    standInCheckout(main, 'site', log);
    standIn(main, log);
    commit(main, 'base');
    const nested = join(main, '.claude/worktrees/wt');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', nested], { cwd: main });
    expect(await runHookInstall([], io(join(nested, 'site')))).toBe(0);
    writeFileSync(join(nested, 'site/page.txt'), 'nested\n');
    const refused = commit(nested, 'no stet in this worktree');
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('stet pre-commit gate: stet is not installed in site/');
    expect(drain(log)).toEqual([]);
  });

  it('(g) names the older gate in doctor, replaces it on install, and refuses a hand-written hook', async () => {
    const { top, checkouts } = await gatedRepo(['site'], { log: logFile() });
    const checkout = checkouts[0] as string;
    const hookPath = join(top, '.git/hooks/pre-commit');
    writeFileSync(hookPath, HOOK_BEFORE_0_3_1, { mode: 0o755 });

    const doctorWith = io(checkout);
    const codeWith = await runDoctor([], doctorWith);
    expect(doctorWith.err.join('\n')).toContain(OLDER);

    const install = io(checkout);
    expect(await runHookInstall([], install)).toBe(0);
    expect(install.out.join('\n')).toContain(
      `replaced the older gate with the pre-commit gate at ${hookPath} — it runs stet check, stet scan and stet seo check in site/ when a commit touches it`,
    );
    expect(readFileSync(hookPath, 'utf8')).toBe(shipped);

    const doctorAfter = io(checkout);
    expect(await runDoctor([], doctorAfter)).toBe(codeWith);
    expect(doctorAfter.err.join('\n')).not.toContain('hook:');
    expect(doctorAfter.out.join('\n')).toContain(
      'hook: the stet pre-commit gate runs here — stet hook remove takes this checkout out of it',
    );

    for (const text of ['#!/bin/sh\necho mine\n', `${shipped}echo one more line\n`]) {
      writeFileSync(hookPath, text, { mode: 0o755 });
      await expect(runHookInstall([], io(checkout))).rejects.toThrow(`${hookPath} already exists and differs from the shipped hook`);
      expect(readFileSync(hookPath)).toEqual(Buffer.from(text, 'utf8'));
    }
  });

  it('(h) eject takes its own checkout out, and the last one out removes the gate', async () => {
    const { top, checkouts } = await gatedRepo(['a', 'b'], { log: logFile() });
    const [a, b] = checkouts as [string, string];
    expect(await runHookInstall([], io(a))).toBe(0);
    expect(await runHookInstall([], io(b))).toBe(0);
    const hookPath = join(top, '.git/hooks/pre-commit');

    const first = io(a);
    expect(await runEject(['--write'], first)).toBe(0);
    expect(first.out.join('\n')).toContain('remove this checkout from the stet pre-commit gate');
    expect(readGate(join(top, '.git'))).toEqual([{ worktree: '', checkout: 'b', seo: true }]);
    expect(existsSync(hookPath)).toBe(true);

    const last = io(b);
    expect(await runEject(['--write'], last)).toBe(0);
    expect(last.out.join('\n')).toContain('remove the stet pre-commit hook');
    expect(existsSync(hookPath)).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.mjs'))).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.json'))).toBe(false);
  });

  it("(h2) eject under a hook stet did not write takes the checkout out and names the line to remove", async () => {
    const log = logFile();
    const { top, checkouts } = await gatedRepo(['site'], { log });
    const checkout = checkouts[0] as string;
    const husky = join(top, '.husky/pre-commit');
    mkdirSync(join(top, '.husky'));
    const own = `#!/bin/sh\n${GATE_LINE}\n`;
    writeFileSync(husky, own, { mode: 0o755 });
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: top });
    expect(await runHookInstall([], io(checkout))).toBe(0);
    commit(top, 'husky');
    drain(log);

    const eject = io(checkout);
    expect(await runEject(['--write'], eject)).toBe(0);
    expect(eject.out.join('\n')).toContain('remove this checkout from the stet pre-commit gate');
    expect(eject.out.join('\n')).toContain(`remove this line from ${husky}: ${GATE_LINE}`);
    expect(readGate(join(top, '.git'))).toEqual([]);
    expect(readFileSync(husky, 'utf8')).toBe(own);
    // The line left in the hook finds an empty list and passes: no loop back to eject.
    rmSync(join(checkout, 'node_modules'), { recursive: true });
    editDocument(checkout);
    const after = commit(top, 'after eject, stet uninstalled');
    expect(after.code, after.out).toBe(0);
    expect(drain(log)).toEqual([]);
  });

  it('(h3) eject of the last live checkout removes the gate, whatever a pruned worktree left listed', async () => {
    const { top, checkouts } = await gatedRepo(['site'], { log: logFile() });
    const linked = join(mkdtempSync(join(tmpdir(), 'stet-gate-wt-')), 'gone-wt');
    made.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'gone', linked], { cwd: top });
    expect(await runHookInstall([], io(join(linked, 'site')))).toBe(0);
    expect(await runHookInstall([], io(checkouts[0] as string))).toBe(0);
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: top });

    expect(await runEject(['--write'], io(checkouts[0] as string))).toBe(0);
    expect(existsSync(join(top, '.git/hooks/pre-commit'))).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.json'))).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.mjs'))).toBe(false);
  });

  it('(m) hook remove takes one checkout out, and the last one out removes the gate, needing only git', async () => {
    const log = logFile();
    const { top, checkouts } = await gatedRepo(['a', 'b'], { log });
    const [a, b] = checkouts as [string, string];
    expect(await runHookInstall([], io(a))).toBe(0);
    expect(await runHookInstall([], io(b))).toBe(0);
    const hookPath = join(top, '.git/hooks/pre-commit');
    const before = allPaths(a).sort();

    const first = io(a);
    expect(await runHookRemove([], first)).toBe(0);
    expect(first.out).toEqual(['remove this checkout from the stet pre-commit gate']);
    expect(readGate(join(top, '.git'))).toEqual([{ worktree: '', checkout: 'b', seo: true }]);
    expect(existsSync(hookPath)).toBe(true);
    expect(allPaths(a).sort()).toEqual(before);
    const doctor = io(a);
    await runDoctor([], doctor);
    expect(`${doctor.out.join('\n')}\n${doctor.err.join('\n')}`).not.toContain('stet hook remove');

    editDocument(a);
    editDocument(b);
    expect(commit(top, 'touches both').code).toBe(0);
    expect(drain(log)).toEqual(['check in b', 'scan in b', 'seo check in b']);

    const again = io(a);
    expect(await runHookRemove([], again)).toBe(0);
    expect(again.out).toEqual(['a/ is not in the stet pre-commit gate — no change']);

    // A folder whose stet and config are gone is taken out the same way.
    rmSync(join(b, 'node_modules'), { recursive: true });
    rmSync(join(b, 'stet.config.json'));
    const last = io(b);
    expect(await runHookRemove([], last)).toBe(0);
    expect(last.out).toEqual(['remove the stet pre-commit hook']);
    expect(existsSync(hookPath)).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.mjs'))).toBe(false);
    expect(existsSync(join(top, '.git/stet-gate.json'))).toBe(false);

    const outside = mkdtempSync(join(tmpdir(), 'stet-nogit-'));
    made.push(outside);
    await expect(runHookRemove([], io(outside))).rejects.toThrow('hook remove needs a git repository — run it inside one');
  });

  it('(i) fails naming a listed folder that is no longer a stet checkout', async () => {
    const log = logFile();
    const top = gitRepo();
    const a = standInCheckout(top, 'a', log);
    writeFileSync(join(a, 'page.txt'), 'a\n');
    commit(top, 'base');
    expect(await runHookInstall([], io(a))).toBe(0);
    execFileSync('git', ['mv', 'a', 'z'], { cwd: top });
    // A staged change under the old folder: git reports a rename by its new name alone.
    mkdirSync(a);
    writeFileSync(join(a, 'left-behind.txt'), 'a\n');
    const moved = commit(top, 'a moved away');
    expect(moved.code).not.toBe(0);
    expect(moved.out).toContain(
      'stet pre-commit gate: a/ is no longer a stet checkout in this worktree — run stet hook install in the checkout, or stet hook remove there',
    );
    expect(drain(log)).toEqual([]);
  });
});

// --- the gate's SEO run: per entry, armed by install and a passing upgrade -----

/** The gate list as git's common directory holds it, rewritten by hand the way 0.5.1 wrote it: no `seo`. */
function unarm(top: string, checkout: string): void {
  const path = join(top, '.git/stet-gate.json');
  const list = JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<Record<string, unknown>> };
  for (const entry of list.entries) if (entry['checkout'] === checkout) delete entry['seo'];
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
}

/**
 * An html checkout at `folder` of `top` with the built stet, one page record and
 * a title under a key whose limit each case sets; `description` false leaves the
 * page without one, which `seo check` reports as an error.
 */
async function seoCheckout(
  top: string,
  folder: string,
  opts: { title: string; limits: { max: number; severity: 'advisory' | 'hard' }; description?: boolean },
): Promise<string> {
  const describe = opts.description !== false;
  const host = await makeHtmlHost({
    files: {
      'index.html':
        `<!DOCTYPE html>\n<html><head>\n<title data-stet="home_page_title">${opts.title}</title>\n` +
        '<meta name="description" content="Licensed training data from the companies that already hold it." data-stet-content="home_meta_description">\n' +
        '</head><body>\n<h1 data-stet="home_hero_headline">Data partnerships for AI labs.</h1>\n</body></html>\n',
    },
    keys: {
      home_page_title: { shape: 'text', target: 'web', limits: opts.limits, pages: ['home'] },
      home_meta_description: { shape: 'text', target: 'web', limits: { max: 160, severity: 'advisory' }, ...(describe ? { pages: ['home'] } : {}) },
      home_hero_headline: { shape: 'text', target: 'web' },
    },
    defaults: {
      home_page_title: opts.title,
      home_meta_description: 'Licensed training data from the companies that already hold it.',
      home_hero_headline: 'Data partnerships for AI labs.',
    },
  });
  const descriptor = JSON.parse(host.file('content/descriptor.json'));
  descriptor.pages = { home: { route: '/', seo: { title: 'home_page_title', ...(describe ? { description: 'home_meta_description' } : {}) } } };
  writeFileSync(join(host.cwd, 'content/descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  const checkout = folder === '' ? top : join(top, folder);
  mkdirSync(checkout, { recursive: true });
  cpSync(host.cwd, checkout, { recursive: true });
  installStetShim(checkout);
  return checkout;
}

/** The title's key given `limits` in the checkout's descriptor. */
function setTitleLimits(checkout: string, limits: { max: number; severity: 'advisory' | 'hard' }): void {
  const path = join(checkout, 'content/descriptor.json');
  const descriptor = JSON.parse(readFileSync(path, 'utf8'));
  descriptor.keys.home_page_title.limits = limits;
  writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
}

describe('the gate runs stet seo check where the entry opted in', () => {
  const LONG = 'Psyon — data partnerships for AI labs, all sourced with consent';

  it.skipIf(!builtBinExists())(
    'lands an advisory over-length with its warn, refuses a hard one, and lands a checkout with no page records',
    async () => {
      expect(LONG.length).toBe(63);
      const top = gitRepo();
      const site = await seoCheckout(top, 'site', { title: LONG, limits: { max: 60, severity: 'advisory' } });
      commit(top, 'base');
      expect(await runHookInstall([], io(site))).toBe(0);

      editDocument(site);
      const advisory = commit(top, 'a 63-character title under an advisory limit');
      expect(advisory.code, advisory.out).toBe(0);
      expect(advisory.out).toContain('over the 60-character bound');

      // A hard limit wider than the text passes check, so seo check's own error is what refuses.
      setTitleLimits(site, { max: 70, severity: 'hard' });
      const before = head(top);
      const hard = commit(top, 'the same title under a hard limit');
      expect(hard.code).not.toBe(0);
      expect(hard.out).toMatch(/error: .*over the 60-character bound/);
      expect(head(top)).toBe(before);

      const { top: bare, checkouts } = await gatedRepo(['site'], 'built');
      expect(await runHookInstall([], io(checkouts[0] as string))).toBe(0);
      editDocument(checkouts[0] as string);
      const noPages = commit(bare, 'a checkout with no page records');
      expect(noPages.code, noPages.out).toBe(0);
      expect(noPages.out).toContain('no pages declared — the SEO rules have nothing to check');
    },
    90_000,
  );

  it.skipIf(!builtBinExists())(
    'arms a fresh install whatever seo check answers, beside a checkout 0.5.1 listed without it',
    async () => {
      const log = logFile();
      const top = gitRepo();
      const a = await seoCheckout(top, 'a', { title: 'Psyon data partnerships', limits: { max: 60, severity: 'advisory' }, description: false });
      const b = standInCheckout(top, 'b', log);
      commit(top, 'base');
      writeFileSync(join(top, '.git/stet-gate.json'), `${JSON.stringify({ entries: [{ checkout: 'b', worktree: '' }] }, null, 2)}\n`);
      expect(await runHookInstall([], io(a))).toBe(0);
      expect(readGate(join(top, '.git'))).toEqual([
        { worktree: '', checkout: 'b' },
        { worktree: '', checkout: 'a', seo: true },
      ]);
      editDocument(a);
      writeFileSync(join(b, 'page.txt'), 'b\n');
      const before = head(top);
      const refused = commit(top, 'touches both');
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain('page "home" declares no SEO description');
      expect(head(top)).toBe(before);
      expect(drain(log)).toEqual(['check in b', 'scan in b']);
    },
    90_000,
  );

  it('runs seo check in the armed checkout alone, and a removal keeps the other entry armed', async () => {
    const log = logFile();
    const top = gitRepo();
    const a = standInCheckout(top, 'a', log);
    const b = standInCheckout(top, 'b', log);
    const c = standInCheckout(top, 'c', log);
    writeFileSync(join(top, 'notes.md'), 'notes\n');
    commit(top, 'base');
    for (const dir of [a, b, c]) expect(await runHookInstall([], io(dir))).toBe(0);
    unarm(top, 'b');
    writeFileSync(join(a, 'page.txt'), 'a\n');
    writeFileSync(join(b, 'page.txt'), 'b\n');
    expect(commit(top, 'both').code).toBe(0);
    expect(drain(log)).toEqual(['check in a', 'scan in a', 'seo check in a', 'check in b', 'scan in b']);
    expect(await runHookRemove([], io(c))).toBe(0);
    expect(readGate(join(top, '.git'))).toEqual([
      { worktree: '', checkout: 'a', seo: true },
      { worktree: '', checkout: 'b' },
    ]);
  });

  it('prints the armed line over a 0.5.1 entry, then the no-change line', async () => {
    const top = gitRepo();
    const site = standInCheckout(top, 'site', logFile());
    expect(await runHookInstall([], io(site))).toBe(0);
    unarm(top, 'site');
    const hookPath = join(top, '.git/hooks/pre-commit');
    const armed = io(site);
    expect(await runHookInstall([], armed)).toBe(0);
    expect(armed.out).toEqual([`${hookPath}: the stet pre-commit gate for site/ runs stet seo check from the next commit`]);
    expect(readGate(join(top, '.git'))).toEqual([{ worktree: '', checkout: 'site', seo: true }]);
    const again = io(site);
    expect(await runHookInstall([], again)).toBe(0);
    expect(again.out).toEqual([`${hookPath}: the stet pre-commit gate is already installed for site/ — no change`]);
  });
});

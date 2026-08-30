/**
 * `stet hook install` — the opt-in pre-commit gate. Each case builds a temp git
 * repo and installs into it, asserting the executable bit, the git-resolved
 * hooks directory (a `core.hooksPath` redirect proves the resolution is real,
 * not a hard-coded `.git/hooks`), the identical-hook no-op, the differing-hook
 * refusal, and the not-a-repo error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runHookInstall } from '../cli/hook.js';
import { packageRoot } from '../cli/installed.js';
import type { CliIo } from '../cli/main.js';

const shipped = readFileSync(join(packageRoot(), 'templates', 'pre-commit'), 'utf8');
const made: string[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-hook-'));
  made.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
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

describe('runHookInstall', () => {
  it('writes an executable pre-commit gate from the shipped template', async () => {
    const dir = repo();
    expect(await runHookInstall([], io(dir))).toBe(0);
    const hook = join(dir, '.git/hooks/pre-commit');
    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(hook, 'utf8')).toBe(shipped);
    expect(statSync(hook).mode & 0o111).not.toBe(0); // git ignores a non-executable hook
  });

  it('resolves the hooks dir from git — a core.hooksPath redirect is honored', async () => {
    const dir = repo();
    execFileSync('git', ['config', 'core.hooksPath', 'my-hooks'], { cwd: dir });
    expect(await runHookInstall([], io(dir))).toBe(0);
    // written to the redirected dir, not a hard-coded .git/hooks
    expect(existsSync(join(dir, 'my-hooks/pre-commit'))).toBe(true);
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
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

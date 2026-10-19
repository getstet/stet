/**
 * `gitFiles` (cli/git.ts): the file list git keeps, read in one `ls-files -z`
 * spawn — the email extract's untracked check and the unread-key scan's file
 * set. Each case is a real repository, or a real directory with none.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { gitFiles } from '../cli/git.js';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'stet-git-files-'));
  made.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('gitFiles', () => {
  it('answers the tracked files, or with --others the untracked ones git does not ignore', () => {
    const cwd = dir();
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'stet test');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(cwd, '.gitignore'), 'secret.ts\n');
    writeFileSync(join(cwd, 'tracked.ts'), 'export {};\n');
    git(cwd, 'add', '.gitignore', 'tracked.ts');
    git(cwd, 'commit', '-q', '-m', 'one');
    writeFileSync(join(cwd, 'new file.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'secret.ts'), 'export {};\n');

    expect(gitFiles(cwd, ['--cached'])).toEqual(['.gitignore', 'tracked.ts']);
    expect(gitFiles(cwd, ['--cached', '--others', '--exclude-standard'])?.sort()).toEqual(['.gitignore', 'new file.ts', 'tracked.ts']);
  });

  it('answers null in a directory git does not track', () => {
    expect(gitFiles(dir(), ['--cached'])).toBeNull();
  });

  it('answers null where git cannot be spawned', () => {
    expect(gitFiles(dir(), ['--cached'], { PATH: join(tmpdir(), 'no-such-bin') })).toBeNull();
  });
});

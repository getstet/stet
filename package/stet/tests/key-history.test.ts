/**
 * `keyHistory` (cli/key-history.ts): one key's past values read out of the
 * snapshot's git history in one `git log` and one `git cat-file --batch`. Each
 * case is a real repository, built through `git fast-import` so a thousand
 * commits take a moment.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { keyHistory } from '../cli/key-history.js';

/** The versions alone, for the cases that ask nothing of `truncated`. */
async function versionsOf(...args: Parameters<typeof keyHistory>) {
  return (await keyHistory(...args)).versions;
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/**
 * A repository whose `content/defaults.json` is written once per entry of
 * `snapshots`, oldest first, one commit each by `Ada <ada@test>` an hour apart;
 * a string entry is written as it is, anything else pretty-printed as JSON. A
 * commit whose entry of `paths` differs from the one before it moves the file.
 */
function repo(snapshots: unknown[], paths: string[] = []): string {
  const cwd = dir('stet-key-history-');
  execFileSync('git', ['init', '-q'], { cwd });
  const parts: string[] = [];
  snapshots.forEach((snapshot, i) => {
    const text = typeof snapshot === 'string' ? snapshot : `${JSON.stringify(snapshot, null, 2)}\n`;
    const at = paths[i] ?? 'content/defaults.json';
    const before = paths[i - 1] ?? 'content/defaults.json';
    const bytes = Buffer.byteLength(text, 'utf8');
    const message = `edit ${i}`;
    parts.push(
      `commit refs/heads/main\ncommitter Ada <ada@test> ${1_700_000_000 + i * 3600} +0000\ndata ${message.length}\n${message}\n` +
        `${i > 0 && at !== before ? `D ${before}\n` : ''}M 100644 inline ${at}\ndata ${bytes}\n${text}\n`,
    );
  });
  execFileSync('git', ['fast-import', '--quiet'], { cwd, input: parts.join('') });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd });
  return cwd;
}

const shas = (cwd: string): string[] =>
  execFileSync('git', ['log', '--format=%H', '--reverse'], { cwd, encoding: 'utf8' }).trim().split('\n');

describe('keyHistory', () => {
  it('answers the distinct values newest first, each at the commit that introduced it', async () => {
    const cwd = repo(['a', 'a', 'b', 'a', 'c'].map((v) => ({ default: { lab_headline: v, other: 'x' } })));
    const commits = shas(cwd);
    const versions = await versionsOf(cwd, 'content/defaults.json', 'lab_headline', 'default');
    expect(versions.map((v) => v.value)).toEqual(['c', 'a', 'b', 'a']);
    expect(versions.map((v) => v.commit)).toEqual([commits[4], commits[3], commits[2], commits[0]]);
    expect(versions[0]).toEqual({
      commit: commits[4],
      short: (commits[4] as string).slice(0, versions[0]?.short.length),
      date: '2023-11-15T02:13:20Z',
      author: 'Ada',
      value: 'c',
    });
  });

  it('skips a commit whose snapshot does not parse', async () => {
    const cwd = repo([{ default: { k: 'a' } }, '{ "default": { "k": "b"', { default: { k: 'a' } }, { default: { k: 'c' } }]);
    const commits = shas(cwd);
    const versions = await versionsOf(cwd, 'content/defaults.json', 'k', 'default');
    expect(versions.map((v) => [v.value, v.commit])).toEqual([
      ['c', commits[3]],
      ['a', commits[0]],
    ]);
  });

  it('reads a key a commit does not hold as undefined', async () => {
    const cwd = repo([{ default: { k: 'a' } }, { default: {} }, { default: { k: 'a' } }]);
    const commits = shas(cwd);
    const versions = await versionsOf(cwd, 'content/defaults.json', 'k', 'default');
    expect(versions.map((v) => [v.value, v.commit])).toEqual([
      ['a', commits[2]],
      [undefined, commits[1]],
      ['a', commits[0]],
    ]);
    // A member named like Object.prototype's own is a key the snapshot does not hold.
    expect((await versionsOf(cwd, 'content/defaults.json', 'constructor', 'default')).map((v) => v.value)).toEqual([undefined]);
    expect((await versionsOf(cwd, 'content/defaults.json', 'k', '__proto__')).map((v) => v.value)).toEqual([undefined]);
  });

  it('reads every revision through one git cat-file --batch spawn', async () => {
    const cwd = repo(['a', 'b', 'c', 'd'].map((v) => ({ default: { k: v } })));
    // A git on the PATH that logs each run's arguments and hands it to the real one.
    const bin = dir('stet-git-wrapper-');
    const calls = join(bin, 'calls.log');
    const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${calls}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env['PATH'];
    process.env['PATH'] = `${bin}:${path ?? ''}`;
    try {
      expect(await versionsOf(cwd, 'content/defaults.json', 'k', 'default')).toHaveLength(4);
    } finally {
      process.env['PATH'] = path;
    }
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    expect(lines.filter((line) => line.startsWith('cat-file'))).toEqual(['cat-file --batch']);
    expect(lines).toHaveLength(2);
  });

  it('reads 1,001 commits in under a second', async () => {
    const cwd = repo(Array.from({ length: 1001 }, (_, i) => ({ default: { k: `value ${i % 7}`, filler: 'x'.repeat(200) } })));
    const started = performance.now();
    const versions = await versionsOf(cwd, 'content/defaults.json', 'k', 'default', 1001);
    const took = performance.now() - started;
    expect(versions).toHaveLength(1001);
    expect(took).toBeLessThan(1000);
  });

  it('keeps every version of a snapshot far past the old 32 MB read ceiling', async () => {
    const filler = 'x'.repeat(600_000);
    const cwd = repo(Array.from({ length: 60 }, (_, i) => ({ default: { k: `value ${i}`, filler } })));
    const versions = await versionsOf(cwd, 'content/defaults.json', 'k', 'default');
    expect(versions).toHaveLength(60);
    expect(versions[0]?.value).toBe('value 59');
    expect(versions[59]?.value).toBe('value 0');
  });

  it('follows the snapshot across a move, reading each commit at the path it held', async () => {
    const snaps = ['a', 'b', 'b', 'c', 'd'].map((v) => ({ default: { k: v, filler: 'x'.repeat(300) } }));
    const cwd = repo(snaps, ['content/defaults.json', 'content/defaults.json', 'stet/defaults.json', 'stet/defaults.json', 'stet/defaults.json']);
    const commits = shas(cwd);
    const versions = await versionsOf(cwd, 'stet/defaults.json', 'k', 'default');
    expect(versions.map((v) => [v.value, v.commit])).toEqual([
      ['d', commits[4]],
      ['c', commits[3]],
      ['b', commits[1]],
      ['a', commits[0]],
    ]);
  });

  it('skips a revision too large to parse and answers truncated', async () => {
    const cwd = repo([{ default: { k: 'a', filler: 'x'.repeat(100) } }, { default: { k: 'b', filler: 'x'.repeat(5000) } }, { default: { k: 'c', filler: 'x'.repeat(100) } }]);
    const commits = shas(cwd);
    const all = await keyHistory(cwd, 'content/defaults.json', 'k', 'default');
    expect(all.truncated).toBe(false);
    const capped = await keyHistory(cwd, 'content/defaults.json', 'k', 'default', 1000, 1000);
    expect(capped.truncated).toBe(true);
    expect(capped.versions.map((v) => [v.value, v.commit])).toEqual([
      ['c', commits[2]],
      ['a', commits[0]],
    ]);
  });

  // Mutation guard: green on the first build by design; it fails when a record's
  // fields are compared in the order they arrive.
  it('reads a record whose fields arrive in another order as one version', async () => {
    const cwd = repo([{ a: 1, b: 2 }, { b: 2, a: 1 }, { b: 3, a: 1 }].map((v) => ({ default: { k: v } })));
    const commits = shas(cwd);
    const versions = await versionsOf(cwd, 'content/defaults.json', 'k', 'default');
    expect(versions.map((v) => [v.value, v.commit])).toEqual([
      [{ b: 3, a: 1 }, commits[2]],
      [{ a: 1, b: 2 }, commits[0]],
    ]);
  });

  // Mutation guard: green on the first build by design; it fails when a blob is
  // cut by characters rather than by the bytes git states.
  it('reads a value of multi-byte characters exactly, and the revision after it', async () => {
    const cwd = repo(['café 😀', 'après 😀 ünï', 'café 😀'].map((v) => ({ default: { k: v, other: '日本語' } })));
    const versions = await versionsOf(cwd, 'content/defaults.json', 'k', 'default');
    expect(versions.map((v) => v.value)).toEqual(['café 😀', 'après 😀 ünï', 'café 😀']);
  });
});

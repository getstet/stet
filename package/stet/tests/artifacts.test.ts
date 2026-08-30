/**
 * The plan-then-apply writers. `init` writes seven files into a stranger's repo,
 * so the contract that matters is all-or-nothing: one conflicting file refuses
 * the WHOLE batch before a single byte lands, a pristine re-run changes nothing,
 * and `dryRun` reports what it would do without doing it.
 *
 * `emitMigrations` is the first consumer and its refusal-message assertions live
 * in `cli.test.ts`; these are the writers' own edges.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  asUpdate,
  planJson,
  planWrite,
  writeExecutable,
  writeJsonDeterministic,
  writePlanned,
  writeText,
} from '../cli/artifacts.js';
import { CliError } from '../cli/report.js';

/**
 * A path whose write fails, planned as an ordinary one.
 *
 * A dangling symlink reads as ABSENT — so it plans as a `write` and is not
 * caught by the conflict check — and throws only once the write follows it. A
 * directory would fail in `planWrite`'s own read instead, which proves the
 * refusal rather than the restore, and a permission bit would not fail at all
 * for a root-run suite.
 */
function unwritable(dir: string, name = 'boom.txt'): string {
  const path = join(dir, name);
  symlinkSync(join(dir, 'no-such-directory', 'x.txt'), path);
  return path;
}

const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-artifacts-'));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('planWrite', () => {
  it('is write when absent, unchanged when byte-identical, differs when changed', () => {
    const path = join(tempDir(), 'a.txt');
    expect(planWrite(path, 'hello').status).toBe('write');
    writeText(path, 'hello');
    expect(planWrite(path, 'hello').status).toBe('unchanged');
    expect(planWrite(path, 'world').status).toBe('differs');
  });

  it('labels a plan by its path, or by a caller-supplied repo-relative name', () => {
    const path = join(tempDir(), 'x.txt');
    expect(planWrite(path, 't').label).toBe(path);
    expect(planWrite(path, 't', 'content/x.txt').label).toBe('content/x.txt');
  });
});

describe('planJson', () => {
  it('serializes deterministically — key order-independent, matching the JSON writer', () => {
    const path = join(tempDir(), 'c.json');
    const plan = planJson(path, { b: 1, a: 2 });
    expect(plan.text).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
    expect(plan.status).toBe('write');

    // The same value in any key order is byte-identical, so a re-plan is a no-op.
    writeJsonDeterministic(path, { a: 2, b: 1 });
    expect(planJson(path, { b: 1, a: 2 }).status).toBe('unchanged');
  });
});

describe('writePlanned', () => {
  it('refuses the WHOLE batch on one conflict and writes nothing', () => {
    const cwd = tempDir();
    const ok = join(cwd, 'ok.txt');
    const conflict = join(cwd, 'conflict.txt');
    writeText(conflict, 'the host edited this');

    const plans = [planWrite(ok, 'new'), planWrite(conflict, 'different', 'conflict.txt')];
    expect(() =>
      writePlanned(plans, { refusal: (labels) => `refuse: ${labels.join(', ')}` }),
    ).toThrow(CliError);
    // All-or-nothing: the clean write never landed.
    expect(existsSync(ok)).toBe(false);
  });

  it('applies the writes and skips the unchanged', () => {
    const cwd = tempDir();
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    writeText(b, 'same');

    const result = writePlanned([planWrite(a, 'A'), planWrite(b, 'same')]);
    expect(result.written).toContain(a);
    expect(result.unchanged).toContain(b);
    expect(readFileSync(a, 'utf8')).toBe('A');
  });

  it('dryRun reports both halves but writes nothing', () => {
    const cwd = tempDir();
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    writeText(b, 'same');

    const result = writePlanned([planWrite(a, 'A'), planWrite(b, 'same')], { dryRun: true });
    expect(result.written).toContain(a); // what it WOULD write
    expect(result.unchanged).toContain(b); // the no-op still reported
    expect(existsSync(a)).toBe(false); // but nothing actually written
  });
});

describe('asUpdate', () => {
  it('turns only differs into write, and changes nothing else about the plan', () => {
    const dir = tempDir();
    const absent = join(dir, 'absent.txt');
    const same = join(dir, 'same.txt');
    const edited = join(dir, 'edited.txt');
    writeText(same, 'x');
    writeText(edited, 'the host edited this');

    // `differs` is a conflict for a file stet OWNS and the ordinary case for a
    // file whose new text was computed from its current contents. Only that
    // status moves; absent and identical mean the same thing either way.
    expect(asUpdate(planWrite(absent, 'x')).status).toBe('write');
    expect(asUpdate(planWrite(same, 'x')).status).toBe('unchanged');
    expect(asUpdate(planWrite(edited, 'x')).status).toBe('write');

    const plan = planWrite(edited, 'x', 'content/edited.txt');
    const updated = asUpdate(plan);
    expect(updated.label).toBe(plan.label);
    expect(updated.text).toBe(plan.text);
    expect(updated.path).toBe(plan.path);
  });
});

describe('writePlanned — a failure part way through', () => {
  it('restores what it updated, unlinks what it created, and never reaches the rest', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeText(join(dir, 'updated.txt'), 'ORIGINAL');
    writeText(join(dir, 'sub', 'also-updated.txt'), 'ORIGINAL 2');

    const plans = [
      asUpdate(planWrite(join(dir, 'updated.txt'), 'NEW')),
      planWrite(join(dir, 'created.txt'), 'CREATED'),
      asUpdate(planWrite(join(dir, 'sub', 'also-updated.txt'), 'NEW 2')),
      planWrite(unwritable(dir), 'never lands'),
      planWrite(join(dir, 'after-the-failure.txt'), 'unreached'),
    ];
    expect(() => writePlanned(plans)).toThrow();

    expect(readFileSync(join(dir, 'updated.txt'), 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(join(dir, 'sub', 'also-updated.txt'), 'utf8')).toBe('ORIGINAL 2');
    expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    expect(existsSync(join(dir, 'after-the-failure.txt'))).toBe(false);
  });

  it('restores the ORIGINAL when one path was planned twice', () => {
    const dir = tempDir();
    const twice = join(dir, 'twice.txt');
    writeText(twice, 'ORIGINAL');

    // Restoring in plan order would put back the FIRST write's input and leave
    // the file holding text it never held. Reverse order is what makes the
    // original the one that survives.
    expect(() =>
      writePlanned([
        asUpdate(planWrite(twice, 'FIRST')),
        { path: twice, text: 'SECOND', label: 'twice.txt', status: 'write' as const },
        planWrite(unwritable(dir), 'never lands'),
      ]),
    ).toThrow();
    expect(readFileSync(twice, 'utf8')).toBe('ORIGINAL');
  });

  it('a genuine conflict beside an update still refuses the whole batch', () => {
    const dir = tempDir();
    const owned = join(dir, 'owned.txt');
    const fresh = join(dir, 'new.txt');
    writeText(owned, 'HOST EDIT');

    expect(() => writePlanned([planWrite(fresh, 'x'), planWrite(owned, 'stet version', 'owned.txt')])).toThrow(CliError);
    expect(existsSync(fresh)).toBe(false);
    expect(readFileSync(owned, 'utf8')).toBe('HOST EDIT');

    // The same batch with that plan marked as an update lands — which is the
    // whole distinction: a conflict is refused, an intended edit is not.
    const result = writePlanned([planWrite(fresh, 'x'), asUpdate(planWrite(owned, 'stet version', 'owned.txt'))]);
    expect(result.written).toContain('owned.txt');
    expect(readFileSync(owned, 'utf8')).toBe('stet version');
  });

  it('dryRun over an update writes nothing and leaves nothing to restore', () => {
    const dir = tempDir();
    const a = join(dir, 'a.txt');
    writeText(a, 'ORIGINAL');

    const result = writePlanned([asUpdate(planWrite(a, 'NEW')), planWrite(join(dir, 'b.txt'), 'NEW')], {
      dryRun: true,
    });
    expect(result.written).toEqual([a, join(dir, 'b.txt')]);
    expect(readFileSync(a, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
  });
});

describe('writeExecutable', () => {
  it('writes the file and sets the executable bit git needs on a hook', () => {
    const hook = join(tempDir(), 'pre-commit');
    writeExecutable(hook, '#!/bin/sh\nnpx stet check\n');
    expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\nnpx stet check\n');
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });
});

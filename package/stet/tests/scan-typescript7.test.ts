/**
 * `stet scan` where the resolved `typescript` carries no compiler API (TypeScript
 * 7's package root exports version constants only). stet ships its own 5.x, so
 * this is a broken install. Its own file for the same reason
 * `load-typescript-ts7.test.ts` is: `vi.mock` is file-scoped, and the absent
 * shape and this one need different factories.
 *
 * The refusal reaches scan the same way an absence does — as a finding through
 * the report — and it carries the reinstall line verbatim, so the host reads
 * the remedy rather than a crash somewhere further in.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('typescript', () => ({ version: '7.0.2', versionMajorMinor: '7.0', createSourceFile: undefined }));

import { runScan } from '../cli/scan.js';
import type { CliIo } from '../cli/main.js';
import { TS_BROKEN } from '../cli/source-scan.js';

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

interface Captured extends CliIo {
  out: string[];
  err: string[];
}

describe('runScan — a typescript with no compiler API', () => {
  it('carries the reinstall line as the finding, verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-scan-ts7-'));
    write(
      dir,
      'stet.config.json',
      JSON.stringify({
        project: 't',
        managedSurfaces: ['app/**/*.tsx'],
        readPath: { file: 'lib/content.ts', import: '@/lib/content' },
        router: 'app',
        rootLayout: 'app/layout.tsx',
      }),
    );
    write(dir, 'app/page.tsx', 'export default function Page() {\n  return <h1>Managed copy</h1>;\n}\n');
    const out: string[] = [];
    const err: string[] = [];
    const cap: Captured = { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), out, err };
    expect(await runScan([], cap)).toBe(1);
    expect(TS_BROKEN).toBe('stet could not load the TypeScript compiler it ships with — reinstall stet: npm i @getstet/stet');
    expect(err.join('\n')).toContain('stet could not load the TypeScript compiler it ships with — reinstall stet: npm i @getstet/stet');
    expect(out.join('\n')).toContain('app/page.tsx: not scanned — typescript is unavailable');
  });
});

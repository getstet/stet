/**
 * `stet scan` where the optional `typescript` peer is not there.
 *
 * Its own file because `vi.mock` is file-scoped and shadows ANY real
 * resolution, which is also why the TypeScript 7 shape stands alone in
 * `scan-typescript7.test.ts`: the two need different factories.
 *
 * The contract this file holds down: the refusal is CAPTURED as a finding and
 * delivered through scan's own report, never thrown. A throw escapes before
 * `report.emit` and takes every accumulated warn with it — the dialect warns
 * and the dead-glob lines included — so the host learns nothing but a stack.
 * And the finding is raised only where a matched file NEEDED the compiler: a
 * dialect-only host and a bare repo stay compiler-free and exit 0.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('typescript', () => {
  const error = new Error("Cannot find package 'typescript' imported from scan") as Error & { code?: string };
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
});

import { runScan } from '../cli/scan.js';
import type { CliIo } from '../cli/main.js';

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function project(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-scan-nots-'));
  write(
    dir,
    'stet.config.json',
    JSON.stringify({
      project: 't',
      readPath: { file: 'lib/content.ts', import: '@/lib/content' },
      router: 'app',
      rootLayout: 'app/layout.tsx',
      scan: { severity: 'warn', baseline: '.stet/scan-baseline.json' },
      ...config,
    }),
  );
  return dir;
}

interface Captured extends CliIo {
  out: string[];
  err: string[];
}
function io(dir: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), out, err };
}

const ASTRO = '---\nconst title = "Home";\n---\n<h1>{title}</h1>\n<p>Your week, sorted</p>\n';

describe('runScan — typescript absent', () => {
  it('reports the refusal THROUGH the report, with every other warn still emitted', async () => {
    const dir = project({
      managedSurfaces: ['src/**/*.astro', 'app/**/*.tsx', 'lib/**/*.ts'],
    });
    write(dir, 'src/pages/index.astro', ASTRO);
    write(dir, 'app/page.tsx', 'export default function Page() {\n  return <h1>Managed copy</h1>;\n}\n');
    const cap = io(dir);
    // The "SHALL fail with an actionable message" contract, delivered through
    // the report rather than as an escaping throw.
    expect(await runScan([], cap)).toBe(1);
    const findings = cap.err.join('\n');
    expect(findings).toContain("stet needs 'typescript' to read your source");
    // The dialect detector never touches a compiler, so its warns live…
    expect(findings).toContain('src/pages/index.astro:5 possible copy "Your week, sorted"');
    // …and so does the dead-glob line, which the escaping throw used to discard.
    expect(findings).toContain('glob matched no files: lib/**/*.ts');
    // The file that needed the compiler is named, as not scanned rather than
    // as refused: an absence is not a parse.
    expect(cap.out.join('\n')).toContain('app/page.tsx: not scanned — typescript is unavailable');
    expect(cap.out.join('\n')).not.toContain('could not be parsed cleanly');
    // And it does not increment the parser-refusal counter, so the all-refused
    // warn keys on true parser refusals alone.
    expect(findings).not.toContain('refused by the parser');
  });

  it('scans a dialect-only host with no compiler at all, and exits 0', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(dir, 'src/pages/index.astro', ASTRO);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('possible copy "Your week, sorted"');
    // No file needed the compiler, so no refusal is raised — this host is the
    // one the text detector exists for.
    expect(findings).not.toContain('typescript');
  });

  it('leaves a bare repo silent and green', async () => {
    // The cli capability's bare-repo scenario. An unconditional refusal finding
    // would flip this to exit 1 on a host that declared nothing at all.
    const dir = mkdtempSync(join(tmpdir(), 'stet-scan-nots-bare-'));
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toBe('');
  });

  it('a --baseline run under the refusal still exits 1', async () => {
    // Deliberate: `--baseline` is exempt from the severity promotion, and the
    // refusal rides outside that exemption. A baseline written while half the
    // surfaces are unreadable is not an acceptance of anything.
    const dir = project({ managedSurfaces: ['app/**/*.tsx'] });
    write(dir, 'app/page.tsx', 'export default function Page() {\n  return <h1>Managed copy</h1>;\n}\n');
    const cap = io(dir);
    expect(await runScan(['--baseline'], cap)).toBe(1);
    expect(cap.err.join('\n')).toContain("stet needs 'typescript' to read your source");
  });
});

describe('scan names nothing through a compiler that is not there (F54)', () => {
  it('an Astro-only host with its forms present scans and exits 0 with typescript absent', async () => {
    const dir = project({
      router: 'astro',
      rootLayout: undefined,
      managedSurfaces: ['src/**/*.astro'],
      copyModules: [],
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
    });
    write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
    write(dir, 'content/defaults.json', JSON.stringify({ default: {} }));
    write(dir, 'src/pages/index.astro', '---\nconst title = "Home";\n---\n<h1>{title}</h1>\n<p>Your week, sorted</p>\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('possible copy "Your week, sorted"');
  });
});

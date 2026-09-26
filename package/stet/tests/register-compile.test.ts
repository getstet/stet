/**
 * R-CP6-1: `register --write` regenerates the codegen modules, so the
 * `copy('new_key')` leaf it just wrote typechecks with NO intervening `stet
 * upgrade`. This runs `tsc --noEmit` over a host that loads register's
 * regenerated ambient types via an INCLUDE GLOB (not a `files:` list, which would
 * hide the P1-2 `X.d.ts`-drop bug): the registered key is assignable to the
 * narrowed `ContentKey` (the leaf compiles) and a typo is not (proving the
 * augmentation is real, not a widened `string`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRegister } from '../cli/register.js';
import { packageRoot } from '../cli/installed.js';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const pkg = packageRoot();

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

async function adopted(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stet-reg-tsc-'));
  // `--write` verifies that `readPath.import` maps somewhere before it rewrites
  // host source around it, so the host declares the alias a Next host declares.
  write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
  write(
    dir,
    'stet.config.json',
    JSON.stringify({
      project: 't',
      managedSurfaces: ['app/**/*.tsx'],
      emailSurfaces: [],
      readPath: { file: 'lib/content.ts', import: '@/lib/content' },
      router: 'app',
      rootLayout: 'app/layout.tsx',
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
    }),
  );
  write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
  write(dir, 'content/defaults.json', JSON.stringify({ default: {} }));
  write(dir, 'app/page.tsx', 'export default function Page() {\n  return <h1>Regenerated key</h1>;\n}\n');
  await runRegister(['--from', 'scan', '--write'], { cwd: dir, env: {}, stdout: () => {}, stderr: () => {} });
  return dir;
}

function tscProbe(dir: string, probe: string): { ok: boolean; output: string } {
  write(dir, 'probe.ts', probe);
  writeFileSync(
    join(dir, 'tsconfig.probe.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          lib: ['ES2022'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          baseUrl: '.',
          typeRoots: [join(pkg, '..', 'node_modules', '@types')],
          paths: { '@getstet/stet': [join(pkg, 'src', 'index.ts')] },
        },
        // An include GLOB over content/ (register's regenerated keys.ts +
        // ambient .d.ts) plus the probe — modeling an init'd host's tsconfig, so
        // a colliding ambient name would be dropped here as in the field (P1-2).
        include: ['content/**/*.ts', 'probe.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.probe.json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output: '' };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const LEAF = (key: string): string =>
  "import { createAccessor, type Descriptor } from '@getstet/stet';\n" +
  "import descriptorJson from './content/descriptor.json';\n" +
  'const copy = createAccessor(descriptorJson as unknown as Descriptor, {});\n' +
  `export const s: string = copy('${key}');\n`;

describe('register regenerates the codegen so the leaf typechecks (R-CP6-1)', () => {
  it('the registered key is assignable to the narrowed ContentKey', async () => {
    const dir = await adopted();
    const r = tscProbe(dir, LEAF('home_page_headline'));
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  });

  it('a typo is NOT — the .d.ts is a real narrowing, not a widened string', async () => {
    const dir = await adopted();
    const r = tscProbe(dir, LEAF('not_a_registered_key'));
    expect(r.ok).toBe(false);
  });
});

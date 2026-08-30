/**
 * `stet.config.json` — the parse, the defaults, and the write-then-read
 * round-trip `init` depends on. `init` writes this file and `loadConfig` reads
 * it back, so a field that does not survive the round-trip is a field a later
 * command reads as its default: `mountRoute` in particular is `eject`'s only
 * channel to the route it must delete.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CONFIG_FILE, defaultConfig, loadConfig, writeConfig, type StetConfig } from '../cli/config.js';

const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-config-'));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('stet.config.json', () => {
  it('writeConfig then loadConfig round-trips every field, mountRoute included', () => {
    const cwd = tempDir();
    const config: StetConfig = {
      ...defaultConfig(),
      project: 'dash',
      store: { adapter: 'pg', urlEnv: 'MY_DB_URL', tokenEnv: 'MY_TOKEN' },
      managedSurfaces: ['app/**/*.tsx', 'lib/email/**/*.ts'],
      emailSurfaces: ['lib/email/**/*.ts'],
      // The declared copy modules, one glob per extension: stet's matcher has no
      // brace expansion, so `src/**/*.{ts,astro}` matches nothing while the walk
      // still runs. An exact path matches as itself.
      copyModules: ['src/copy.ts'],
      scan: { severity: 'fail', baseline: '.stet/accepted.json' },
      router: 'pages',
      readPath: { file: 'src/lib/content.ts', import: '@/lib/content' },
      rootLayout: 'src/app/layout.tsx',
      apiTokenEnv: 'DASH_API_TOKEN',
      mountRoute: 'src/app/api/stet/[...stet]/route.ts',
    };

    writeConfig(join(cwd, CONFIG_FILE), config);
    expect(loadConfig(cwd)).toEqual(config);
  });

  it('loads the new fields from a hand-written config (the cli MODIFIED scenario)', () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, CONFIG_FILE),
      JSON.stringify({
        managedSurfaces: ['app/**/*.tsx', 'lib/email/**/*.ts'],
        emailSurfaces: ['lib/email/**/*.ts'],
        copyModules: ['src/copy.ts', 'src/emails/strings.ts'],
        scan: { severity: 'fail', baseline: '.stet/b.json' },
        router: 'pages',
        readPath: { file: 'src/lib/content.ts', import: '@/lib/content' },
        rootLayout: 'src/app/layout.tsx',
        apiTokenEnv: 'DASH_API_TOKEN',
        mountRoute: 'src/app/api/stet/[...stet]/route.ts',
      }),
    );
    const config = loadConfig(cwd);
    expect(config.managedSurfaces).toEqual(['app/**/*.tsx', 'lib/email/**/*.ts']);
    expect(config.emailSurfaces).toEqual(['lib/email/**/*.ts']);
    expect(config.copyModules).toEqual(['src/copy.ts', 'src/emails/strings.ts']);
    expect(config.scan).toEqual({ severity: 'fail', baseline: '.stet/b.json' });
    expect(config.router).toBe('pages');
    expect(config.readPath).toEqual({ file: 'src/lib/content.ts', import: '@/lib/content' });
    expect(config.rootLayout).toBe('src/app/layout.tsx');
    expect(config.apiTokenEnv).toBe('DASH_API_TOKEN');
    expect(config.mountRoute).toBe('src/app/api/stet/[...stet]/route.ts');
  });

  it('an omitted field falls back to its default; an absent mountRoute stays undefined', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ project: 'x' }));
    const config = loadConfig(cwd);
    expect(config.rootLayout).toBe('app/layout.tsx');
    expect(config.apiTokenEnv).toBe('STET_API_TOKEN');
    expect(config.router).toBe('app');
    expect(config.readPath).toEqual({ file: 'lib/content.ts', import: '@/lib/content' });
    expect(config.scan).toEqual({ severity: 'warn', baseline: '.stet/scan-baseline.json' });
    expect(config.managedSurfaces).toEqual([]);
    expect(config.emailSurfaces).toEqual([]);
    // Absent is empty, not an error — a downlevel config declares no copy modules.
    expect(config.copyModules).toEqual([]);
    expect(config.mountRoute).toBeUndefined();
  });

  it('constrains router to the two values and scan.severity to warn|fail', () => {
    const badRouter = tempDir();
    writeFileSync(join(badRouter, CONFIG_FILE), JSON.stringify({ router: 'nuxt' }));
    expect(() => loadConfig(badRouter)).toThrow(/router must be "app" or "pages"/);

    const badScan = tempDir();
    writeFileSync(join(badScan, CONFIG_FILE), JSON.stringify({ scan: { severity: 'boom' } }));
    expect(() => loadConfig(badScan)).toThrow(/scan\.severity must be/);
  });
});

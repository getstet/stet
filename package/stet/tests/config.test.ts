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

import {
  CONFIG_FILE,
  defaultConfig,
  formsSecretEnvOf,
  isHtmlHost,
  loadConfig,
  selectStoreBlock,
  writeConfig,
  type StetConfig,
} from '../cli/config.js';

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

  it('round-trips the html host, and reads an absent host as a JavaScript one', () => {
    const cwd = tempDir();
    const config: StetConfig = {
      ...defaultConfig(),
      host: 'html',
      managedSurfaces: ['**/*.html'],
    };
    writeConfig(join(cwd, CONFIG_FILE), config);
    const read = loadConfig(cwd);
    expect(read).toEqual(config);
    expect(read.host).toBe('html');
    expect(isHtmlHost(read)).toBe(true);

    const plain = tempDir();
    writeFileSync(join(plain, CONFIG_FILE), JSON.stringify({ project: 'x' }));
    const javascript = loadConfig(plain);
    expect(javascript.host).toBeUndefined();
    expect(isHtmlHost(javascript)).toBe(false);
  });

  it('constrains host to "html" or absent, naming both states', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ host: 'static' }));
    expect(() => loadConfig(cwd)).toThrow(
      /host must be "html", or absent for a JavaScript host — got "static"/,
    );
  });

  it('constrains router to the three values and scan.severity to warn|fail', () => {
    const badRouter = tempDir();
    writeFileSync(join(badRouter, CONFIG_FILE), JSON.stringify({ router: 'nuxt' }));
    expect(() => loadConfig(badRouter)).toThrow(/router must be "app", "pages" or "astro"/);

    const badScan = tempDir();
    writeFileSync(join(badScan, CONFIG_FILE), JSON.stringify({ scan: { severity: 'boom' } }));
    expect(() => loadConfig(badScan)).toThrow(/scan\.severity must be/);
  });

  it('fills the root-layout default on a Next host and leaves it absent on an Astro one', () => {
    // `undefined` is the Astro truth: there is no root React layout, and
    // `app/layout.tsx` would name a file that is not there.
    const astro = tempDir();
    writeFileSync(join(astro, CONFIG_FILE), JSON.stringify({ router: 'astro' }));
    expect(loadConfig(astro).rootLayout).toBeUndefined();

    // A declared value on an Astro host is still the host's word.
    const declared = tempDir();
    writeFileSync(join(declared, CONFIG_FILE), JSON.stringify({ router: 'astro', rootLayout: 'x.astro' }));
    expect(loadConfig(declared).rootLayout).toBe('x.astro');

    const next = tempDir();
    writeFileSync(join(next, CONFIG_FILE), JSON.stringify({ router: 'app' }));
    expect(loadConfig(next).rootLayout).toBe('app/layout.tsx');
  });

  /** A config file holding `source`, loaded — or the error it raises. */
  function loaded(source: unknown): StetConfig {
    const cwd = tempDir();
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify(source));
    return loadConfig(cwd);
  }

  it('reads the forms secret’s name and a contacts store, and round-trips them', () => {
    const PG = { adapter: 'pg', urlEnv: 'STET_CONTACTS_DATABASE_URL' };
    const config = loaded({
      formsSecretEnv: 'FORMS_KEY',
      contacts: { store: PG, environments: { prod: { adapter: 'pg', urlEnv: 'PROD_URL' } } },
    });
    expect(config.formsSecretEnv).toBe('FORMS_KEY');
    expect(formsSecretEnvOf(config)).toBe('FORMS_KEY');
    expect(config.contacts).toMatchObject({ store: PG, environments: { prod: { adapter: 'pg', urlEnv: 'PROD_URL' } } });
    expect(Object.keys(config.contacts ?? {})).toEqual(['store', 'environments']);

    const cwd = tempDir();
    writeConfig(join(cwd, CONFIG_FILE), config);
    expect(loadConfig(cwd)).toEqual(config);

    // Neither field is required: a site with no form gets no forms setting.
    const bare = loaded({ project: 'x' });
    expect(bare.formsSecretEnv).toBeUndefined();
    expect(bare.contacts).toBeUndefined();
    expect(formsSecretEnvOf(bare)).toBe('STET_FORMS_SECRET');
    expect(Object.hasOwn(defaultConfig(), 'formsSecretEnv')).toBe(false);
    expect(Object.hasOwn(defaultConfig(), 'contacts')).toBe(false);
  });

  it('validates the contacts block as it validates the top-level store and its map', () => {
    expect(() => loaded({ contacts: { store: { adapter: 'mysql' } } })).toThrow(/contacts\.store\.adapter/);
    expect(() => loaded({ contacts: {} })).toThrow(/contacts\.store/);
    const pg = { adapter: 'pg', urlEnv: 'DB' };
    expect(() => loaded({ contacts: { store: pg, environments: { default: pg } } })).toThrow(
      'stet.config.json: contacts.environments must not declare "default" — the bare store block IS the default environment, ' +
        "and 'default' is its reserved selector",
    );
    expect(() => loaded({ contacts: { store: pg, environments: { '-x': pg } } })).toThrow(
      'stet.config.json: "-x" is not a usable environment name — it must not be blank, and a leading dash would read as an option after --env',
    );
    // The top-level map keeps its words.
    expect(() => loaded({ environments: { default: pg } })).toThrow('stet.config.json: environments must not declare "default"');
  });

  it('refuses a blank forms secret name, and one the mount’s Bearer already names', () => {
    expect(() => loaded({ formsSecretEnv: ' ' })).toThrow(
      'stet.config.json: formsSecretEnv is blank — name the variable holding the forms secret, or leave it out',
    );
    expect(() => loaded({ formsSecretEnv: 'STET_API_TOKEN' })).toThrow(
      'stet.config.json: formsSecretEnv and apiTokenEnv both name STET_API_TOKEN — the forms secret needs a variable of its own',
    );
    expect(() => loaded({ apiTokenEnv: 'TOK', formsSecretEnv: 'TOK' })).toThrow(
      'stet.config.json: formsSecretEnv and apiTokenEnv both name TOK — the forms secret needs a variable of its own',
    );
  });

  it('selects an environment by own key alone, in the words it always used', () => {
    const none = loaded({ store: { adapter: 'memory' } });
    expect(() => selectStoreBlock(none, 'prod')).toThrow(
      "--env prod: no environments are declared in stet.config.json — only 'default', the bare store block",
    );
    const declared = loaded({ store: { adapter: 'memory' }, environments: { b: { adapter: 'memory' } } });
    expect(selectStoreBlock(declared, 'b')).toMatchObject({ name: 'b', block: { adapter: 'memory' } });
    expect(() => selectStoreBlock(declared, 'prod')).toThrow(
      "--env prod: not a declared environment — declared: b (and 'default', the bare store block)",
    );
    // `constructor` is on every object's prototype and names no environment.
    expect(() => selectStoreBlock(declared, 'constructor')).toThrow(
      "--env constructor: not a declared environment — declared: b (and 'default', the bare store block)",
    );
  });
});


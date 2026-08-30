/**
 * The scaffolded artifacts must COMPILE in a real host — init writes source into
 * a stranger's repo, so a route that type-errors is a broken adopt. Each case
 * runs `runInit`, then `tsc --noEmit` over a Next-shaped host tsconfig whose
 * `stet` subpaths map to the package sources. The route resolves its relative
 * specifiers on both a root-layout and a `src/` host (R8-P2-2, not `@/`), and
 * the client-safe provider map compiles with no descriptor widening and no
 * Snapshot-as-Bundle (R6-P1-4/P2-4). The CopyProvider/createServerCopy imports
 * land with the react/ layer (CP8), so those files' full compile is proven then.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runInit } from '../cli/init.js';
import { packageRoot } from '../cli/installed.js';
import { generateRegistry, loadDescriptor } from '../src/index.js';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const pkg = packageRoot();

const LAYOUT =
  'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
  '  return <html><body>{children}</body></html>;\n}\n';

function nextTsconfig(include: string[]): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        jsx: 'react-jsx',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        baseUrl: '.',
        // A real Next host carries @types/node (and @types/react); the temp
        // fixture has no node_modules, so point at the package's own so
        // `node:crypto` and friends resolve as they would in an adopter's repo.
        typeRoots: [join(pkg, '..', 'node_modules', '@types')],
        paths: {
          '@getstet/stet': [join(pkg, 'src', 'index.ts')],
          '@getstet/stet/server': [join(pkg, 'server', 'index.ts')],
          '@getstet/stet/store-pg': [join(pkg, 'adapters', 'store-pg.ts')],
        },
      },
      include,
    },
    null,
    2,
  )}\n`;
}

async function scaffold(env: NodeJS.ProcessEnv, layoutRel: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stet-route-'));
  mkdirSync(join(dir, dirname(layoutRel)), { recursive: true });
  writeFileSync(join(dir, layoutRel), LAYOUT, 'utf8');
  await runInit([], { cwd: dir, env, stdout: () => {}, stderr: () => {} });
  return dir;
}

function tscHost(dir: string, include: string[]): { ok: boolean; output: string } {
  writeFileSync(join(dir, 'tsconfig.json'), nextTsconfig(include), 'utf8');
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
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

describe('the scaffolded route compiles', () => {
  it('root-layout host', async () => {
    const dir = await scaffold({ STET_DATABASE_URL: 'postgres://localhost/x' }, 'app/layout.tsx');
    const r = tscHost(dir, ['app/api/stet/[...stet]/route.ts']);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  });

  it('src/ host — the relative specifiers resolve, no @/ alias', async () => {
    const dir = await scaffold({ STET_DATABASE_URL: 'postgres://localhost/x' }, 'src/app/layout.tsx');
    const r = tscHost(dir, ['src/app/api/stet/[...stet]/route.ts']);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  });

  /**
   * The scaffolded map is typed over the STRING-valued keys alone, so reading a
   * structured key by property is a compile error in the host rather than a
   * value of the wrong type at render. The proof has to be a real typecheck of a
   * real scaffold: the cast is the only thing standing between the two.
   *
   * `init` refuses a pre-written descriptor (its writes are all-or-nothing), so
   * the shapes the starter does not ship are added AFTER the scaffold and the
   * registry regenerated through `generateRegistry` — init's own call. Both
   * outputs are rewritten, because the ambient `.d.ts` is what carries
   * `ContentKey`; without it in the program `ContentKey` falls back to `string`
   * and the `get()` arm below would pass for any string at all.
   *
   * Hosts scaffolded BEFORE this change keep their own `Record<ContentKey,
   * string>` cast: init never edits an existing scaffold, so nothing here
   * rewrites a host-owned file.
   */
  function withStructuredKeys(dir: string): void {
    const path = join(dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(path, 'utf8')) as {
      keys: Record<string, { shape: string; target: string; values?: string[] }>;
    };
    descriptor.keys['footer_links'] = { shape: 'list', target: 'web' };
    descriptor.keys['blog_intro'] = { shape: 'richtext', target: 'web' };
    descriptor.keys['brand__logo'] = { shape: 'media', target: 'web' };
    descriptor.keys['theme_mode'] = { shape: 'enum', target: 'web', values: ['light', 'dark'] };
    descriptor.keys['accent_color'] = { shape: 'color', target: 'web' };
    writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    const registry = generateRegistry(loadDescriptor(descriptor));
    writeFileSync(join(dir, 'content/keys.ts'), registry.keysTs, 'utf8');
    writeFileSync(join(dir, 'content/stet-env.d.ts'), registry.dts, 'utf8');
  }

  const PROBE = 'string-key-probe.ts';

  it('the scaffolded map takes every string-shaped key and refuses the structured ones', async () => {
    const dir = await scaffold({}, 'app/layout.tsx');
    withStructuredKeys(dir);

    // The five string shapes, read by property — the whole point of the map.
    writeFileSync(
      join(dir, PROBE),
      "import { copyMap } from './lib/content';\n" +
        'export const a: string = copyMap.hero_headline;\n' +
        'export const b: string = copyMap.blog_intro;\n' +
        'export const c: string = copyMap.brand__logo;\n' +
        'export const d: string = copyMap.theme_mode;\n' +
        'export const e: string = copyMap.accent_color;\n',
      'utf8',
    );
    const ok = tscHost(dir, [PROBE, 'content/stet-env.d.ts']);
    expect(ok.output).toBe('');
    expect(ok.ok).toBe(true);
  }, 60_000);

  it('a list key on the map is a compile error, and the accessor still serves it', async () => {
    const dir = await scaffold({}, 'app/layout.tsx');
    withStructuredKeys(dir);

    writeFileSync(
      join(dir, PROBE),
      "import { copy, copyMap } from './lib/content';\n" +
        'export const bad = copyMap.footer_links;\n' +
        // The route that stays honest about a structured key.
        "export const served = copy.get('footer_links');\n",
      'utf8',
    );
    const bad = tscHost(dir, [PROBE, 'content/stet-env.d.ts']);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("Property 'footer_links' does not exist on type");
    // ONE error: the property access. The `get('footer_links')` beside it
    // typechecks, so the structured key is refused on the map and served by the
    // accessor — which is the whole remedy the compile error points at.
    expect(bad.output.trim().split('\n')).toHaveLength(1);
    // The map's own type is the STRING_KEYS union, and neither the list key nor
    // the starter's number key is in it.
    expect(bad.output).toContain('"accent_color" | "blog_intro" | "brand__ink" | "brand__logo"');
    expect(bad.output).not.toContain('brand__radius');
  }, 60_000);

  it('proves the ambient registry is in the program, so the get() arm above is not vacuous', async () => {
    // `ContentKey` degrades to `string` when the ambient augmentation is not in
    // the program (src/types.ts), and `copy.get(anything)` would then typecheck
    // — which would make the `get('footer_links')` half of the case above prove
    // nothing at all. This is the control: the same probe passes without the
    // ambient file and fails with it, so the include is load-bearing rather than
    // habit.
    const dir = await scaffold({}, 'app/layout.tsx');
    withStructuredKeys(dir);
    writeFileSync(
      join(dir, PROBE),
      "import { copy } from './lib/content';\nexport const unknown = copy.get('not_a_key');\n",
      'utf8',
    );

    const withAmbient = tscHost(dir, [PROBE, 'content/stet-env.d.ts']);
    expect(withAmbient.ok).toBe(false);
    expect(withAmbient.output).toContain('not_a_key');

    const without = tscHost(dir, [PROBE]);
    expect(without.ok).toBe(true);
  }, 60_000);

  it('the starter’s own number key is refused too — a zero-edit negative arm', async () => {
    // `brand__radius` ships in every fresh scaffold, so this arm isolates the
    // emission from the regeneration mechanics above: no descriptor edit, no
    // regenerate, and the map still refuses it.
    const dir = await scaffold({}, 'app/layout.tsx');
    writeFileSync(
      join(dir, PROBE),
      "import { copyMap } from './lib/content';\nexport const bad = copyMap.brand__radius;\n",
      'utf8',
    );
    const bad = tscHost(dir, [PROBE, 'content/stet-env.d.ts']);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('brand__radius');
  }, 60_000);

  it('a registry with no string-shaped keys emits a StringKey of never that still compiles', async () => {
    const dir = await scaffold({}, 'app/layout.tsx');
    const registry = generateRegistry(
      loadDescriptor({
        version: 1,
        keys: {
          footer_links: { shape: 'list', target: 'web' },
          brand__radius: { shape: 'number', target: 'web' },
        },
      }),
    );
    writeFileSync(join(dir, 'content/keys.ts'), registry.keysTs, 'utf8');
    const r = tscHost(dir, ['content/keys.ts']);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  }, 60_000);

  it('the client-safe provider map compiles', async () => {
    const dir = await scaffold({}, 'app/layout.tsx');
    writeFileSync(
      join(dir, 'provider-map.ts'),
      "import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';\n" +
        "import descriptorJson from './content/descriptor.json';\n" +
        "import { DEFAULTS } from './content/defaults';\n" +
        'export const { resolved } = resolveAll(descriptorJson as unknown as Descriptor, readBundle(DEFAULTS));\n',
      'utf8',
    );
    const r = tscHost(dir, ['provider-map.ts']);
    expect(r.output).toBe('');
    expect(r.ok).toBe(true);
  });
});

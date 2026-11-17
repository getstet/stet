/**
 * `stet eject` — reverse the adoption. Each case builds a temp host in the
 * post-adoption state (init's mounted layout + register's rewritten leaf + the
 * files init wrote), then runs `runEject`. It asserts the whole-command
 * `--write` gate, the un-rewrite + serialized values, the WHOLE layout-mount
 * reversal, the deletions, the dep drop, the hook removal, the history export,
 * and — the headline — that the result imports no `stet` of any kind and a `tsc`
 * over it is clean (it still builds).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterAll, describe, expect, it, vi } from 'vitest';

/** Read-backs made to fail on demand (T15.4, T15.9): every other export is the real one. */
const planted = vi.hoisted(() => ({ jsxUnrewrittenClean: false, decode: false }));
vi.mock('../cli/rewrite.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cli/rewrite.js')>();
  return {
    ...real,
    jsxUnrewrittenClean: (...args: Parameters<typeof real.jsxUnrewrittenClean>) =>
      planted.jsxUnrewrittenClean ? Promise.resolve(false) : real.jsxUnrewrittenClean(...args),
  };
});
// The Astro read-back's check 5 decodes each restored text; a planted decode makes it fail.
vi.mock('../cli/source-scan.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cli/source-scan.js')>();
  return { ...real, decodeEntities: (text: string) => (planted.decode ? `${real.decodeEntities(text)}\u0000` : real.decodeEntities(text)) };
});

import { createMemoryStore } from '../adapters/store-memory.js';
import { cleanupCliHosts, htmlFixture, makeHtmlHost } from '../conformance/cli-host.js';
import { unrewrittenClean } from '../cli/astro-rewrite.js';
import { runEject } from '../cli/eject.js';
import { HOOK_BEFORE_0_3_1 } from '../cli/hook.js';
import { packageRoot } from '../cli/installed.js';
import { runCli, type CliIo } from '../cli/main.js';
import { locateWrapTarget, providerEdits } from '../cli/provider-mount.js';
import { runRegister } from '../cli/register.js';
import { applyFileEdits, jsxUnrewrittenClean } from '../cli/rewrite.js';
import { loadTypescript } from '../cli/source-scan.js';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const pkg = packageRoot();

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8');

const LAYOUT = `import type { ReactNode } from 'react';
import { CopyProvider } from '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';
import descriptorJson from '../content/descriptor.json';
import { DEFAULTS } from '../content/defaults';

const { resolved } = resolveAll(descriptorJson as unknown as Descriptor, readBundle(DEFAULTS));

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={resolved}>{children}</CopyProvider>
      </body>
    </html>
  );
}
`;

const PAGE = `import { copy } from '@/lib/content';

export default function Page() {
  return (
    <div>
      <h1>{copy('hero')}</h1>
      <p>{copy('tricky')}</p>
    </div>
  );
}
`;

const READ_PATH = `import { createServerCopy } from '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';
import descriptorJson from '../content/descriptor.json';
const descriptor = descriptorJson as unknown as Descriptor;
const { resolved } = resolveAll(descriptor, readBundle({ default: {} }));
export const copy = createServerCopy(descriptor, resolved);
`;

const DTS = `import '@getstet/stet';
declare module '@getstet/stet' {
  interface StetRegistry {
    keys: 'hero' | 'tricky';
  }
}
`;

/** A layout with no CopyProvider mount — eject leaves it untouched. */
const PLAIN_LAYOUT = `import type { ReactNode } from 'react';
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`;

interface HostOpts {
  store?: boolean;
  pkgHasStet?: boolean;
}
/** The `@/*` alias every host using `@/lib/content` has to declare to build at all. */
const HOST_TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } });

function host(opts: HostOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-eject-'));
  const store = opts.store === true;
  write(dir, 'tsconfig.json', HOST_TSCONFIG);
  write(
    dir,
    'stet.config.json',
    JSON.stringify({
      project: 't',
      ...(store ? { store: { adapter: 'pg', urlEnv: 'DB', tokenEnv: 'TOK' } } : {}),
      managedSurfaces: ['app/**/*.tsx'],
      readPath: { file: 'lib/content.ts', import: '@/lib/content' },
      router: 'app',
      rootLayout: 'app/layout.tsx',
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
      codegen: { registry: 'content/keys.ts', defaults: 'content/defaults.ts', dts: 'content/stet-env.d.ts' },
      ...(store ? { mountRoute: 'app/api/stet/[...stet]/route.ts' } : {}),
    }),
  );
  write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: { hero: { shape: 'text', target: 'web' }, tricky: { shape: 'text', target: 'web' } } }));
  write(dir, 'content/defaults.json', JSON.stringify({ default: { hero: 'Hello world', tricky: "It's <b> & >" } }));
  write(dir, 'content/defaults.ts', "export const DEFAULTS = { default: { hero: 'Hello world', tricky: \"It's <b> & >\" } } as const;\n");
  write(dir, 'content/stet-env.d.ts', DTS);
  // The generated registry — no stet import (KEYS/ContentKey only), so eject
  // leaves it and the whole-host backstop must tolerate it.
  write(dir, 'content/keys.ts', "export const KEYS = ['hero', 'tricky'] as const;\nexport type ContentKey = (typeof KEYS)[number];\n");
  write(dir, 'lib/content.ts', READ_PATH);
  write(dir, 'app/layout.tsx', LAYOUT);
  write(dir, 'app/page.tsx', PAGE);
  if (store) write(dir, 'app/api/stet/[...stet]/route.ts', "import { createStetHandler } from '@getstet/stet/server';\nexport const { GET, POST } = createStetHandler({} as never);\n");
  if (opts.pkgHasStet !== false) {
    write(dir, 'package.json', JSON.stringify({ name: 'host', dependencies: { '@getstet/stet': '^1.0.0', react: '^18' } }, null, 2));
  }
  return dir;
}

/** A base config the focused cases override one field of. */
const BASE_CONFIG = {
  project: 't',
  managedSurfaces: ['app/**/*.tsx'],
  emailSurfaces: [],
  readPath: { file: 'lib/content.ts', import: '@/lib/content' },
  router: 'app',
  rootLayout: 'app/layout.tsx',
  descriptorPath: 'content/descriptor.json',
  snapshotPath: 'content/defaults.json',
  codegen: { registry: 'content/keys.ts', defaults: 'content/defaults.ts', dts: 'content/stet-env.d.ts' },
};

/** A temp host from an explicit config + file set — the focused cases' fixture. */
function scaffold(opts: {
  config: Record<string, unknown>;
  descriptor?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  files: Record<string, string>;
  pkg?: boolean;
  /** The host's own path aliases, where a case needs a shape other than plain `@/*`. */
  tsconfig?: Record<string, unknown>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-eject-'));
  write(dir, 'tsconfig.json', opts.tsconfig === undefined ? HOST_TSCONFIG : JSON.stringify(opts.tsconfig));
  write(dir, 'stet.config.json', JSON.stringify(opts.config));
  const descriptor = opts.descriptor ?? { version: 1, keys: { hero: { shape: 'text', target: 'web' } } };
  write(dir, 'content/descriptor.json', JSON.stringify(descriptor));
  const defaults = opts.defaults ?? { default: { hero: 'Hello world' } };
  write(dir, 'content/defaults.json', JSON.stringify(defaults));
  write(dir, 'content/defaults.ts', `export const DEFAULTS = ${JSON.stringify(defaults)} as const;\n`);
  for (const [rel, text] of Object.entries(opts.files)) write(dir, rel, text);
  if (opts.pkg !== false) {
    write(dir, 'package.json', JSON.stringify({ name: 'host', dependencies: { '@getstet/stet': '^1.0.0', react: '^18' } }, null, 2));
  }
  return dir;
}

interface Captured extends CliIo {
  out: string[];
}
function io(dir: string, store?: ReturnType<typeof createMemoryStore>): Captured {
  const out: string[] = [];
  const cap: Captured = { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: () => {}, out };
  if (store) cap.store = store;
  return cap;
}

/** Recursively read every host file's text (for the whole-host stet grep). */
function allText(dir: string): string {
  let text = '';
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else text += readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return text;
}

function tscClean(dir: string): { ok: boolean; output: string } {
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({
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
        typeRoots: [join(pkg, '..', 'node_modules', '@types')],
      },
      // The whole host, not just app/** — a stet import surviving in lib/ or
      // components/ must fail the build too, the same tree the backstop sweeps.
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    })}\n`,
    'utf8',
  );
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output: '' };
  } catch (error) {
    const f = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${f.stdout ?? ''}${f.stderr ?? ''}` };
  }
}

describe('runEject — the --write gate', () => {
  it('without --write touches nothing and prints the plan', async () => {
    const dir = host();
    const before = { page: read(dir, 'app/page.tsx'), layout: read(dir, 'app/layout.tsx'), pkg: read(dir, 'package.json') };
    const cap = io(dir);
    const code = await runEject([], cap);
    expect(code).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe(before.page);
    expect(read(dir, 'app/layout.tsx')).toBe(before.layout);
    expect(read(dir, 'package.json')).toBe(before.pkg);
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(true);
    expect(existsSync(join(dir, 'content/stet-env.d.ts'))).toBe(true);
    expect(cap.out.join('\n')).toContain('plan only');
  });
});

describe('runEject --write — snapshot-only', () => {
  it('un-rewrites, unwraps the layout WHOLE, deletes stet files, drops the dep, and the host has no stet + builds', async () => {
    const dir = host();
    const code = await runEject(['--write'], io(dir));
    expect(code).toBe(0);

    // (2) leaf un-rewritten, serialized per context; the read-path import gone
    const page = read(dir, 'app/page.tsx');
    expect(page).toContain('<h1>Hello world</h1>');
    expect(page).toContain('<p>{"It\'s <b> & >"}</p>'); // < > round-trip via a JSX expression container
    expect(page).not.toContain('@/lib/content');
    expect(page).not.toContain('copy(');

    // (3) layout mount reversed WHOLE
    const layout = read(dir, 'app/layout.tsx');
    expect(layout).not.toContain('CopyProvider');
    expect(layout).not.toContain("from '@getstet/stet'");
    expect(layout).not.toContain("from '@getstet/stet/react'");
    expect(layout).not.toContain('resolveAll');
    expect(layout).toContain('{children}');

    // (3) the other stet-importing files deleted
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(false);
    expect(existsSync(join(dir, 'content/stet-env.d.ts'))).toBe(false);

    // (5) dep dropped
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
    expect(JSON.parse(read(dir, 'package.json')).dependencies.react).toBe('^18');

    // the headline: no stet specifier anywhere, and the host tsc is clean
    const text = allText(dir);
    expect(text).not.toMatch(/from ['"]stet/);
    expect(text).not.toMatch(/import ['"]stet/);
    const compiled = tscClean(dir);
    expect(compiled.output).toBe('');
    expect(compiled.ok).toBe(true);
  });

  it('takes a hand-edited mount\'s RESOLVED import with the unwrap, and the stays line names the resolved module (D8)', async () => {
    const dir = host();
    write(
      dir,
      'app/layout.tsx',
      `import type { ReactNode } from 'react';
import { CopyProvider } from '@getstet/stet/react';
import type { Descriptor } from '@getstet/stet';
import descriptorJson from '../content/descriptor.json';
import { RESOLVED } from '../content/resolved';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <CopyProvider
          descriptor={descriptorJson as unknown as Descriptor}
          resolved={RESOLVED}
        >
          {children}
        </CopyProvider>
      </body>
    </html>
  );
}
`,
    );
    write(dir, 'content/resolved.ts', 'export const RESOLVED = { hero: "Hello world" } as const;\n');
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    const layout = read(dir, 'app/layout.tsx');
    expect(layout).not.toContain('RESOLVED');
    expect(layout).not.toContain('CopyProvider');
    expect(layout).not.toContain('descriptorJson');
    expect(cap.out.find((line) => line.startsWith('stays (no stet imports):'))).toContain('content/resolved.ts');
    // Regenerated from the written-back snapshot, beside the defaults module.
    expect(read(dir, 'content/resolved.ts')).toContain('export const RESOLVED = {');
    expect(read(dir, 'content/resolved.ts')).not.toMatch(/^import /m);
    const compiled = tscClean(dir);
    expect(compiled.output).toBe('');
  });

  it('exports no history on a snapshot-only project', async () => {
    const dir = host();
    await runEject(['--write'], io(dir));
    expect(existsSync(join(dir, 'stet-history.json'))).toBe(false);
  });

  it('REVIEW-N1: a write that fails on a later file puts every earlier file back and exits nonzero', async () => {
    const dir = host();
    // The snapshot and the layout are written before the page the run cannot write.
    chmodSync(join(dir, 'app/page.tsx'), 0o444);
    const before = hostBytes(dir);
    const cap = io(dir);
    try {
      expect(await runCli(['eject', '--write'], cap), cap.out.join('\n')).toBe(1);
    } finally {
      chmodSync(join(dir, 'app/page.tsx'), 0o644);
    }
    expectUnchanged(dir, before);
  });
});

describe('runEject --write — store-backed', () => {
  it('deletes the mount route and exports per-key history', async () => {
    const dir = host({ store: true });
    const store = createMemoryStore({ project: 't' });
    store.seed([
      { key: 'hero', value: 'Hello world', state: 'published', is_active: true },
      { key: 'tricky', value: "It's <b> & >", state: 'published', is_active: true },
    ]);
    const code = await runEject(['--write'], io(dir, store));
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'app/api/stet/[...stet]/route.ts'))).toBe(false);
    expect(existsSync(join(dir, 'stet-history.json'))).toBe(true);
    const history = JSON.parse(read(dir, 'stet-history.json'));
    expect(Object.keys(history).sort()).toEqual(['hero', 'tricky']);
    // no stet specifier remains anywhere
    expect(allText(dir)).not.toMatch(/from ['"]stet/);
  });
});

describe('runEject --write — the pre-commit hook', () => {
  function gitInit(dir: string): void {
    execFileSync('git', ['init', '-q'], { cwd: dir });
  }
  it('deletes a byte-identical shipped hook', async () => {
    const dir = host();
    gitInit(dir);
    const shipped = readFileSync(join(pkg, 'templates', 'pre-commit'), 'utf8');
    write(dir, '.git/hooks/pre-commit', shipped);
    await runEject(['--write'], io(dir));
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('deletes the older gate 0.3.0 and earlier shipped', async () => {
    const dir = host();
    gitInit(dir);
    write(dir, '.git/hooks/pre-commit', HOOK_BEFORE_0_3_1);
    await runEject(['--write'], io(dir));
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('reports, never deletes, a differing hook', async () => {
    const dir = host();
    gitInit(dir);
    write(dir, '.git/hooks/pre-commit', '#!/bin/sh\necho custom\n');
    const cap = io(dir);
    await runEject(['--write'], cap);
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(true);
    expect(cap.out.join('\n')).toContain('differs from the shipped hook');
  });
});

describe('runEject --write — the root layout outside the surface globs (a JS host)', () => {
  it('un-rewrites the layout via rootLayout even when the globs never match it', async () => {
    // The surface globs are `.jsx`; the layout is `app/layout.js`. Only because
    // rootLayout is added to the file set does the un-rewrite reach it — the
    // fix for the JS host whose layout no glob names.
    const layout = `import { CopyProvider } from '@getstet/stet/react';
import { readBundle, resolveAll } from '@getstet/stet';
import descriptorJson from '../content/descriptor.json';
import { DEFAULTS } from '../content/defaults';

const { resolved } = resolveAll(descriptorJson, readBundle(DEFAULTS));

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <CopyProvider descriptor={descriptorJson} resolved={resolved}>{children}</CopyProvider>
      </body>
    </html>
  );
}
`;
    const dir = scaffold({
      config: {
        ...BASE_CONFIG,
        managedSurfaces: ['app/**/*.jsx'],
        rootLayout: 'app/layout.js',
        readPath: { file: 'lib/content.js', import: '@/lib/content' },
      },
      files: {
        'app/layout.js': layout,
        'app/page.jsx': `import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n`,
        'lib/content.js': 'export const copy = (k) => k;\n',
      },
    });
    const code = await runEject(['--write'], io(dir));
    expect(code).toBe(0);

    const layoutOut = read(dir, 'app/layout.js');
    expect(layoutOut).not.toContain('CopyProvider');
    expect(layoutOut).not.toContain("from '@getstet/stet");
    expect(layoutOut).not.toContain('resolveAll');
    expect(layoutOut).toContain('{children}');

    const page = read(dir, 'app/page.jsx');
    expect(page).toContain('<h1>Hello world</h1>');
    expect(page).not.toContain('@/lib/content');

    expect(allText(dir)).not.toMatch(/from ['"]stet/);
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
  });
});

describe('runEject — the whole-host backstop refuses a surviving stet import', () => {
  it('refuses (nothing written) when the root layout cannot be parsed', async () => {
    const dir = host();
    // A layout the compiler cannot parse is not un-rewritten, so its stet
    // imports survive — the backstop must refuse the dep drop, not exit 0.
    write(dir, 'app/layout.tsx', "import { CopyProvider } from '@getstet/stet/react';\nexport default function RootLayout({ children }) {\n  return ( <CopyProvider>{children}\n}\n");
    const before = read(dir, 'package.json');
    const cap = io(dir);
    await expect(runEject(['--write'], cap)).rejects.toThrow(/still importing stet/);
    // nothing was written: the dep, the read path and the leaf are all intact
    expect(read(dir, 'package.json')).toBe(before);
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(true);
    expect(read(dir, 'app/page.tsx')).toContain("copy('hero')");
    expect(cap.out.join('\n')).toContain('still imports stet: app/layout.tsx');
  });

  it('refuses when a consumer outside the managed surfaces still imports the read path', async () => {
    const dir = scaffold({
      config: BASE_CONFIG,
      files: {
        'app/layout.tsx': LAYOUT,
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': READ_PATH,
        // Not in app/** and not the root layout — never visited by the un-rewrite.
        'components/widget.tsx': "import { copy } from '@/lib/content';\nexport function Widget() { return <span>{copy('hero')}</span>; }\n",
      },
    });
    const before = read(dir, 'package.json');
    const cap = io(dir);
    await expect(runEject(['--write'], cap)).rejects.toThrow(/still importing stet/);
    expect(read(dir, 'package.json')).toBe(before);
    const out = cap.out.join('\n');
    expect(out).toContain('still imports stet: components/widget.tsx');

    // The widget also KEEPS the read path alive: deleting a file a host wired
    // itself onto would break the widget's import, so it is kept and named —
    // and being kept, it rejoins the survivors, which is why two files are
    // listed rather than one.
    expect(out).toContain(
      'lib/content.ts: kept — imported by components/widget.tsx; un-wire that import first, then re-run eject',
    );
    expect(out).not.toContain('delete lib/content.ts');
    expect(out).toContain('still imports stet: lib/content.ts');
    expect(cap.out.filter((l) => l.startsWith('still imports stet:'))).toHaveLength(2);
  });
});

/**
 * F7: a host file that hand-wired itself onto the scaffold. eject deleting the
 * read path out from under it would leave a host that does not build — so the
 * deletion flips to kept, the kept file rejoins the survivors sweep, and the
 * existing refusal aborts the whole run in both modes.
 */
describe('runEject — a deletion with consumers is kept, and the run refuses whole', () => {
  /** The site's own shape: a hand-written module importing the read path relatively. */
  const SITE_FILES = {
    'app/layout.tsx': LAYOUT,
    'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
    'lib/content.ts': READ_PATH,
    'lib/copy.ts': "import { copy } from './content';\n\nexport const hero = (): string => copy('hero');\n",
  };

  /** Every host file's bytes — "nothing was written" as a Buffer compare. */
  function bytes(dir: string): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const walk = (sub: string): void => {
      for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
        const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else files.set(rel, readFileSync(join(dir, rel)));
      }
    };
    walk('');
    return files;
  }

  it('plan-only prints the FULL manifest and then exits nonzero', async () => {
    const dir = scaffold({ config: BASE_CONFIG, files: SITE_FILES });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    const out = cap.out.join('\n');

    // The kept line is the only one naming the importer and the remedy — the
    // survivors line names the read path, which carries the stet imports.
    expect(out).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
    expect(out).toContain('still imports stet: lib/content.ts');
    // What STAYS, so the manifest is complete on both sides.
    expect(out).toContain('stays (no stet imports): stet.config.json, content/descriptor.json, content/defaults.json');
    // …and the rest of the plan printed BEFORE the refusal, which today's
    // truncating throw never reached: the snapshot, hook and dependency lines.
    expect(out).toContain('content/defaults.json, + content/defaults.ts');
    expect(out).toContain('drop the stet dependency from package.json');
  });

  it('--write refuses with not one byte written', async () => {
    const dir = scaffold({ config: BASE_CONFIG, files: SITE_FILES });
    const before = bytes(dir);
    await expect(runEject(['--write'], io(dir))).rejects.toThrow(/still importing stet/);
    const after = bytes(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, buf] of after) expect(buf.equals(before.get(rel) as Buffer), rel).toBe(true);
  });

  it('catches an .astro importer, which the survivors sweep never parses', async () => {
    const dir = scaffold({
      config: BASE_CONFIG,
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "export const nothing = 1;\n", // the .astro file is the only consumer
        'src/pages/index.astro': "---\nimport { copy } from '@/lib/content';\n---\n<h1>{copy('hero')}</h1>\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by src/pages/index.astro; un-wire that import first, then re-run eject',
    );
  });

  it('resolves an EXACT-key alias onto the read path, which no other net catches', async () => {
    // The host maps a name of its own onto the read path. The import it writes
    // (`@copy`) is not the configured read-path specifier and is not `stet`, so
    // the backstop's literal-specifier sweep never sees this importer — the
    // exact-key clause in the alias resolver is the only thing standing between
    // `--write` and deleting lib/content.ts out from under lib/copy.ts.
    const dir = scaffold({
      config: BASE_CONFIG,
      tsconfig: {
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'], '@copy': ['./lib/content.ts'] } },
      },
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "import { copy } from '@copy';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
    // The importer itself is NOT a survivor: nothing in its text matches the
    // stet-import pattern, which is exactly why the deletion had to be kept.
    expect(cap.out.join('\n')).not.toContain('still imports stet: lib/copy.ts');
  });

  it.each([
    ['lib/copy.mts', "import { copy } from './content.js';\n\nexport const hero = (): string => copy('hero');\n"],
    ['lib/copy.cts', "import { copy } from './content';\n\nexport const hero = (): string => copy('hero');\n"],
    ['src/pages/index.mdx', "import { copy } from '@/lib/content';\n\n# {copy('hero')}\n"],
  ])('catches a %s importer — every extension node itself will load', async (rel, body) => {
    // The consumers channel only sees a file the walk opens. An extension
    // missing from either filter is an importer that does not exist as far as
    // eject is concerned: the deletion goes through, `--write` exits 0, and
    // the host is left with a dangling import and no dependency.
    const dir = scaffold({
      config: BASE_CONFIG,
      files: { ...SITE_FILES, 'lib/copy.ts': 'export const nothing = 1;\n', [rel]: body },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      `lib/content.ts: kept — imported by ${rel}; un-wire that import first, then re-run eject`,
    );
  });

  it('resolves a bare specifier through a baseUrl-only tsconfig', async () => {
    // No `paths` at all: `baseUrl` alone roots every non-relative specifier,
    // which is a resolution rule and not an absent one. Reading it as "this
    // project declares nothing" left the consumer invisible.
    const dir = scaffold({
      config: BASE_CONFIG,
      tsconfig: { compilerOptions: { baseUrl: '.' } },
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "import { copy } from 'lib/content';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
  });

  it('substitutes at a `*` anywhere in the destination, not only a /* suffix', async () => {
    // `"~/*": ["*"]` is legal tsconfig and tsc resolves it. A destination rule
    // that insisted on a trailing `/*` skipped the mapping entirely.
    const dir = scaffold({
      config: BASE_CONFIG,
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '~/*': ['*'] } } },
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "import { copy } from '~/lib/content';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
  });

  it('matches a `*` anywhere in the PATTERN, not only a /* suffix', async () => {
    // `"@c-*": ["./lib/*"]` is legal tsconfig, and tsc resolves `@c-content`
    // through it — verified against tsc itself, which reports `matched pattern
    // '@c-*'`. A pattern rule that insisted on a trailing `/*` skipped the
    // entry, so this consumer resolved nowhere and the read path was deleted
    // out from under a file that imports it.
    const dir = scaffold({
      config: BASE_CONFIG,
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@c-*': ['./lib/*'] } } },
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "import { copy } from '@c-content';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
  });

  it('resolves through the LONGEST matching pattern, which is the only one tsc tries', async () => {
    // Both patterns match `@/lib/content`, and they land in different places:
    // `@/*` says `src/lib/content`, `@/lib/*` says `lib/content`. tsc takes the
    // longest prefix and never falls back, so the read path IS this consumer's
    // target. Taking the first match instead sends the lookup to `src/` and the
    // deletion goes through with the importer still pointing at it.
    const dir = scaffold({
      config: BASE_CONFIG,
      tsconfig: {
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'], '@/lib/*': ['./lib/*'] } },
      },
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "import { copy } from '@/lib/content';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
  });

  it('takes a destination with no `*` verbatim — a whole prefix funnelled onto one module', async () => {
    // `"@c-*": ["./lib/content.ts"]` resolves EVERY `@c-…` specifier onto the
    // one file; tsc confirms `@c-anything` lands on `lib/content.ts`. Skipping
    // starless destinations made this importer invisible.
    const dir = scaffold({
      config: BASE_CONFIG,
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@c-*': ['./lib/content.ts'] } } },
      files: {
        ...SITE_FILES,
        'lib/copy.ts': "import { copy } from '@c-anything';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
  });

  it('keeps a hand-rewritten read path WITHOUT refusing — the run succeeds', async () => {
    // The site's own hand-fixed shape: the read path no longer imports stet at
    // all, and a host module imports it. It must not be deleted (something
    // reads it), and it must not refuse (nothing is left importing stet) — so
    // the kept line carries NO un-wire remedy, because there is nothing to
    // re-run after a run that completed.
    const dir = scaffold({
      config: BASE_CONFIG,
      files: {
        'app/layout.tsx': PLAIN_LAYOUT,
        'app/page.tsx': 'export default function Page() {\n  return <h1>Hello world</h1>;\n}\n',
        'lib/content.ts':
          "const VALUES: Record<string, string> = { hero: 'Hello world' };\n" +
          'export const copy = (key: string): string => VALUES[key] ?? \'\';\n',
        'lib/copy.ts': "import { copy } from './content';\n\nexport const hero = (): string => copy('hero');\n",
      },
    });
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    const out = cap.out.join('\n');

    expect(out).toContain('lib/content.ts: kept — imported by lib/copy.ts');
    expect(out).not.toContain('un-wire');
    expect(out).not.toContain('still imports stet');
    // Retained on disk, and the rest of eject completed around it.
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(true);
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
    const compiled = tscClean(dir);
    expect(compiled.output).toBe('');
    expect(compiled.ok).toBe(true);
  });

  it('names every importer, and ejects end to end once the import is un-wired', async () => {
    const two = scaffold({
      config: BASE_CONFIG,
      files: { ...SITE_FILES, 'lib/more.ts': "import { copy } from '@/lib/content';\nexport const x = copy('hero');\n" },
    });
    const cap = io(two);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out.join('\n')).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts, lib/more.ts; un-wire those imports first, then re-run eject',
    );

    // Un-wire it, and the same host ejects: the read path is deleted and the
    // dependency goes with it.
    const unwired = scaffold({
      config: BASE_CONFIG,
      files: { ...SITE_FILES, 'lib/copy.ts': "export const hero = (): string => 'Hello world';\n" },
    });
    const done = io(unwired);
    expect(await runEject(['--write'], done)).toBe(0);
    expect(done.out.join('\n')).toContain('delete lib/content.ts');
    expect(existsSync(join(unwired, 'lib/content.ts'))).toBe(false);
    expect(JSON.parse(read(unwired, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
    expect(allText(unwired)).not.toMatch(/from ['"]stet/);
  });
});

describe('runEject --write — every enabled locale is written back', () => {
  it('writes the default and non-default blocks from their own rows', async () => {
    const dir = scaffold({
      config: {
        ...BASE_CONFIG,
        store: { adapter: 'pg', urlEnv: 'DB', tokenEnv: 'TOK' },
        mountRoute: 'app/api/stet/[...stet]/route.ts',
        locales: { default: 'default', enabled: ['default', 'es'] },
      },
      files: {
        'app/layout.tsx': LAYOUT,
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': READ_PATH,
        'content/stet-env.d.ts':
          "import '@getstet/stet';\ndeclare module '@getstet/stet' { interface StetRegistry { keys: 'hero'; } }\n",
        'app/api/stet/[...stet]/route.ts': "import { createStetHandler } from '@getstet/stet/server';\nexport const { GET, POST } = createStetHandler({} as never);\n",
      },
    });
    const store = createMemoryStore({ project: 't' });
    store.seed([
      { key: 'hero', value: 'Hello world', state: 'published', is_active: true },
      { key: 'hero', value: 'Hola mundo', state: 'published', is_active: true, locale: 'es' },
    ]);
    const code = await runEject(['--write'], io(dir, store));
    expect(code).toBe(0);

    const snapshot = JSON.parse(read(dir, 'content/defaults.json'));
    expect(snapshot.default.hero).toBe('Hello world');
    expect(snapshot.es.hero).toBe('Hola mundo');
    const defaults = read(dir, 'content/defaults.ts');
    expect(defaults).toContain('Hola mundo');
    expect(defaults).toContain('Hello world');
    // the leaf un-rewrite uses the default locale
    expect(read(dir, 'app/page.tsx')).toContain('<h1>Hello world</h1>');
  });
});

describe('runEject — imports the host wrapped across a line', () => {
  it('counts and reverses a line-broken stet import', async () => {
    // A formatter that wraps after `from` writes real host code. Missing it,
    // the F8 probe counts zero on a file that imports stet, the un-rewrite
    // never runs, and the backstop then refuses a host that should have ejected.
    const layout = `import { CopyProvider } from
  '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from
  '@getstet/stet';
import descriptorJson from '../content/descriptor.json';
import { DEFAULTS } from '../content/defaults';

const { resolved } = resolveAll(descriptorJson as unknown as Descriptor, readBundle(DEFAULTS));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body><CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={resolved}>{children}</CopyProvider></body>
    </html>
  );
}
`;
    // The line-broken layout is the ONLY stet-importing HOST file: the page
    // imports nothing, and the read path is stet-written (excluded from the
    // probe, and deleted rather than swept). So the pattern is what decides —
    // miss it and the probe counts zero, the un-rewrite never runs, the
    // backstop misses it the same way, and eject reports success over a host
    // that still imports stet.
    const dir = scaffold({
      config: BASE_CONFIG,
      files: {
        'app/layout.tsx': layout,
        'app/page.tsx': 'export default function Page() {\n  return <h1>Hello world</h1>;\n}\n',
        'lib/content.ts': READ_PATH,
      },
    });
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('un-rewrite: nothing to reverse');

    const out = read(dir, 'app/layout.tsx');
    expect(out).not.toContain('CopyProvider');
    expect(out).not.toContain('resolveAll');
    // The whole-host grep is the headline: no stet specifier survives, wrapped
    // across a line or not.
    expect(allText(dir)).not.toMatch(/['"]@getstet\/stet(?:\/[^'"]*)?['"]/);
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
  });
});

describe('runEject --write — the layout unwrap shape', () => {
  it('fragment-wraps a lone returned expression so it never becomes an object literal', async () => {
    const layout = `import type { ReactNode } from 'react';
import { CopyProvider } from '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';
import descriptorJson from '../content/descriptor.json';
import { DEFAULTS } from '../content/defaults';

const { resolved } = resolveAll(descriptorJson as unknown as Descriptor, readBundle(DEFAULTS));

export default function RootLayout({ children }: { children: ReactNode }) {
  return <CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={resolved}>{children}</CopyProvider>;
}
`;
    const dir = scaffold({
      config: BASE_CONFIG,
      files: {
        'app/layout.tsx': layout,
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': READ_PATH,
      },
    });
    const code = await runEject(['--write'], io(dir));
    expect(code).toBe(0);
    const out = read(dir, 'app/layout.tsx');
    expect(out).toContain('<>{children}</>');
    expect(out).not.toMatch(/return\s*\{children\}/); // never a bare object literal
    const compiled = tscClean(dir);
    expect(compiled.output).toBe('');
    expect(compiled.ok).toBe(true);
  });
});

describe('runEject --write — the exact unwrap (F11)', () => {
  /** A root layout as the host wrote it before any mount: imports, a blank line, and `<body>` content over three lines. */
  const BEFORE = `import type { ReactNode } from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
`;
  /** The layout as 0.6.0's `init` (resolveAll) or 0.7.0's `register` (resolved) mounted it. */
  async function mounted(form: 'resolved' | 'resolveAll', dir: string, before: string = BEFORE): Promise<string> {
    const ts = await loadTypescript();
    const path = join(dir, 'app/layout.tsx');
    const sf = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const wrap = locateWrapTarget(ts, sf, 'app', form);
    if (wrap === null) throw new Error('no wrap target');
    const config = { ...BASE_CONFIG, codegen: { ...BASE_CONFIG.codegen, resolved: 'content/resolved.ts' } } as never;
    return applyFileEdits(before, providerEdits(ts, sf, before, path, dir, config, wrap, form));
  }
  /** The layout with a read of its own beside `{children}`: the read lies inside the mount's element. */
  const BEFORE_READ = BEFORE.replace("import './globals.css';", "import { copy } from '@/lib/content';\nimport './globals.css';").replace(
    '        {children}\n',
    "        <p>{copy('brand')}</p>\n        {children}\n",
  );
  const AFTER_READ = BEFORE.replace('        {children}\n', '        <p>Northwind Studio</p>\n        {children}\n');
  const readHost = (): string =>
    scaffold({
      config: BASE_CONFIG,
      descriptor: { version: 1, keys: { hero: { shape: 'text', target: 'web' }, brand: { shape: 'text', target: 'web' } } },
      defaults: { default: { hero: 'Hello world', brand: 'Northwind Studio' } },
      files: {
        'app/globals.css': '',
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': READ_PATH,
        'content/resolved.ts': 'export const RESOLVED = {} as const;\n',
      },
    });
  const ejectHost = (): string =>
    scaffold({
      config: BASE_CONFIG,
      files: {
        'app/globals.css': '',
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': READ_PATH,
        'content/resolved.ts': 'export const RESOLVED = {} as const;\n',
      },
    });

  for (const form of ['resolveAll', 'resolved'] as const) {
    it(`leaves the layout byte-identical to the file before the ${form === 'resolveAll' ? "0.6.0 init" : "0.7.0 register"} mount, and the host builds`, async () => {
      const dir = ejectHost();
      const layout = await mounted(form, dir);
      expect(layout).toContain('<CopyProvider ');
      write(dir, 'app/layout.tsx', layout);
      const cap = io(dir);
      expect(await runEject(['--write'], cap)).toBe(0);
      expect(read(dir, 'app/layout.tsx')).toBe(BEFORE);
      expect(cap.out.join('\n')).toContain('app/layout.tsx: un-rewrite + unwrap CopyProvider');
      const compiled = tscClean(dir);
      expect(compiled.output).toBe('');
      expect(compiled.ok).toBe(true);
    });
  }

  for (const form of ['resolveAll', 'resolved'] as const) {
    it(`unwraps the ${form === 'resolveAll' ? '0.6.0' : '0.7.0'} mount around the layout's own copy() read, and the host builds`, async () => {
      const dir = readHost();
      write(dir, 'app/layout.tsx', await mounted(form, dir, BEFORE_READ));
      expect(await runEject(['--write'], io(dir))).toBe(0);
      expect(read(dir, 'app/layout.tsx')).toBe(AFTER_READ);
      const compiled = tscClean(dir);
      expect(compiled.output).toBe('');
      expect(compiled.ok).toBe(true);
    });
  }

  for (const eol of ['\n', '\r\n']) {
    for (const form of ['resolveAll', 'resolved'] as const) {
      it(`ejects to the exact original bytes when the layout's copy import is the last import above the ${form === 'resolveAll' ? '0.6.0' : '0.7.0'} block (${eol === '\n' ? 'LF' : 'CRLF'})`, async () => {
        const dir = readHost();
        // `copy` sits below `./globals.css`, so the block goes in directly after it.
        const before = BEFORE_READ.replace("import { copy } from '@/lib/content';\nimport './globals.css';", "import './globals.css';\nimport { copy } from '@/lib/content';").replace(/\n/g, eol);
        write(dir, 'app/layout.tsx', await mounted(form, dir, before));
        expect(await runEject(['--write'], io(dir))).toBe(0);
        expect(read(dir, 'app/layout.tsx')).toBe(AFTER_READ.replace(/\n/g, eol));
      });
    }

    it(`ejects a layout two plain register runs produced to its exact original bytes (${eol === '\n' ? 'LF' : 'CRLF'})`, async () => {
      // Run 1 adopts the layout literal (server kind) and writes `import { copy }` last; run 2 adopts a client Nav and mounts right after it.
      const dir = scaffold({
        config: { ...BASE_CONFIG, managedSurfaces: ['app/**/*.tsx', 'components/**/*.tsx'], codegen: { ...BASE_CONFIG.codegen, resolved: 'content/resolved.ts' } },
        descriptor: { version: 1, keys: {} },
        defaults: { default: {} },
        files: { 'app/globals.css': '', 'lib/content.ts': READ_PATH.replace("'@getstet/stet/react'", "'@getstet/stet/react/server'") },
      });
      write(dir, 'content/resolved.ts', 'export const RESOLVED = {} as const;\n');
      const layout = BEFORE.replace('        {children}\n', '        <p>Northwind Studio makes furniture</p>\n        {children}\n').replace(/\n/g, eol);
      write(dir, 'app/layout.tsx', layout);
      const first = io(dir);
      expect(await runCli(['register', '--from', 'scan', '--write'], first), first.out.join('\n')).toBe(0);
      write(dir, 'components/Nav.tsx', "'use client';\n\nexport function Nav() {\n  return <nav>Shop the spring collection</nav>;\n}\n");
      const second = io(dir);
      expect(await runCli(['register', '--from', 'scan', '--write'], second), second.out.join('\n')).toBe(0);
      expect(read(dir, 'app/layout.tsx')).toContain('<CopyProvider ');
      const cap = io(dir);
      expect(await runEject(['--write'], cap), cap.out.join('\n')).toBe(0);
      expect(read(dir, 'app/layout.tsx')).toBe(layout);
    });
  }

  it('ejects a CRLF 0.7.0 mount whose RESOLVED import carries a trailing comment to a layout that parses, the comment kept', async () => {
    const dir = readHost();
    const layout = (await mounted('resolved', dir, BEFORE_READ.replace(/\n/g, '\r\n'))).replace("from '../content/resolved';", "from '../content/resolved'; // generated by stet");
    expect(layout).toContain("resolved'; // generated by stet");
    write(dir, 'app/layout.tsx', layout);
    expect(await runEject(['--write'], io(dir))).toBe(0);
    const out = read(dir, 'app/layout.tsx');
    const ts = await loadTypescript();
    const sf = ts.createSourceFile('layout.tsx', out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
    expect(out).toContain('// generated by stet');
    expect(out).not.toContain('@getstet');
    expect(out).not.toContain('CopyProvider');
  });

  for (const eol of ['\n', '\r\n']) {
    it(`ejects a mount whose first import is joined onto the line above to a layout that parses (${eol === '\n' ? 'LF' : 'CRLF'})`, async () => {
      const dir = readHost();
      const layout = (await mounted('resolved', dir, BEFORE_READ.replace(/\n/g, eol))).replace(`';${eol}import { CopyProvider }`, "'; import { CopyProvider }");
      expect(layout).toContain("'; import { CopyProvider }");
      write(dir, 'app/layout.tsx', layout);
      expect(await runEject(['--write'], io(dir))).toBe(0);
      const out = read(dir, 'app/layout.tsx');
      const ts = await loadTypescript();
      const sf = ts.createSourceFile('layout.tsx', out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      expect((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
      expect(out).toContain("import './globals.css';");
      expect(out).not.toContain('@getstet');
      expect(out).not.toContain('CopyProvider');
    });
  }

  for (const eol of ['\n', '\r\n']) {
    for (const atStart of [false, true]) {
      it(`ejects two register runs, the mount first and then a layout literal, to the exact original bytes (${eol === '\n' ? 'LF' : 'CRLF'}, block ${atStart ? 'at offset 0' : 'after the imports'})`, async () => {
        // Run 1 mounts for a client Nav; the host then adds a literal to the mounted layout, and run 2 adopts it, writing `import { copy }` right below the block.
        const dir = scaffold({
          config: { ...BASE_CONFIG, managedSurfaces: ['app/**/*.tsx', 'components/**/*.tsx'], codegen: { ...BASE_CONFIG.codegen, resolved: 'content/resolved.ts' } },
          descriptor: { version: 1, keys: {} },
          defaults: { default: {} },
          files: { 'app/globals.css': '', 'lib/content.ts': READ_PATH.replace("'@getstet/stet/react'", "'@getstet/stet/react/server'") },
        });
        write(dir, 'content/resolved.ts', 'export const RESOLVED = {} as const;\n');
        write(dir, 'components/Nav.tsx', "'use client';\n\nexport function Nav() {\n  return <nav>Shop the spring collection</nav>;\n}\n");
        const base = atStart ? BEFORE.replace("import type { ReactNode } from 'react';\nimport './globals.css';\n\n", '') : BEFORE;
        write(dir, 'app/layout.tsx', base.replace(/\n/g, eol));
        const first = io(dir);
        expect(await runCli(['register', '--from', 'scan', '--write'], first), first.out.join('\n')).toBe(0);
        const run1 = read(dir, 'app/layout.tsx');
        expect(run1).toContain('<CopyProvider ');
        const literal = `        <p>Northwind Studio makes furniture</p>${eol}`;
        const original = base.replace(/\n/g, eol).replace(`        {children}${eol}`, `${literal}        {children}${eol}`);
        write(dir, 'app/layout.tsx', run1.replace(`        {children}${eol}`, `${literal}        {children}${eol}`));
        const second = io(dir);
        expect(await runCli(['register', '--from', 'scan', '--write'], second), second.out.join('\n')).toBe(0);
        expect(read(dir, 'app/layout.tsx')).toContain("import { copy } from '@/lib/content';");
        const cap = io(dir);
        expect(await runEject(['--write'], cap), cap.out.join('\n')).toBe(0);
        expect(read(dir, 'app/layout.tsx')).toBe(original);
      });
    }
  }

  it("unwraps a reformatted mount around the layout's own copy() read through the 0.6.0 path", async () => {
    const dir = readHost();
    const layout = (await mounted('resolved', dir, BEFORE_READ)).replace(
      '<CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={RESOLVED}>',
      '<CopyProvider\n          descriptor={descriptorJson as unknown as Descriptor}\n          resolved={RESOLVED}>',
    );
    expect(layout).toContain('<CopyProvider\n');
    write(dir, 'app/layout.tsx', layout);
    expect(await runEject(['--write'], io(dir))).toBe(0);
    const out = read(dir, 'app/layout.tsx');
    expect(out).not.toContain('CopyProvider');
    expect(out).not.toContain('@getstet/stet');
    expect(out).toContain('<p>Northwind Studio</p>');
    expect(out).toContain('{children}');
    const compiled = tscClean(dir);
    expect(compiled.output).toBe('');
    expect(compiled.ok).toBe(true);
  });

  it('unwraps a reformatted mount through the 0.6.0 path, and the host builds', async () => {
    const dir = ejectHost();
    const layout = (await mounted('resolveAll', dir)).replace(
      '<CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={resolved}>',
      '<CopyProvider\n          descriptor={descriptorJson as unknown as Descriptor}\n          resolved={resolved}>',
    );
    write(dir, 'app/layout.tsx', layout);
    expect(await runEject(['--write'], io(dir))).toBe(0);
    const out = read(dir, 'app/layout.tsx');
    expect(out).not.toContain('CopyProvider');
    expect(out).not.toContain('@getstet/stet');
    expect(out).not.toContain('resolveAll');
    expect(out).toContain('{children}');
    const compiled = tscClean(dir);
    expect(compiled.output).toBe('');
    expect(compiled.ok).toBe(true);
  });
});

describe('runEject --write — a foreign copy binding', () => {
  it('leaves a non-stet copy() call untouched and reports it', async () => {
    const clip = `'use client';
export default function Clip() {
  const copy = (t: string) => navigator.clipboard.writeText(t);
  return <button onClick={() => copy('some text')}>Copy</button>;
}
`;
    const dir = scaffold({
      config: BASE_CONFIG,
      files: {
        'app/layout.tsx': LAYOUT,
        'app/clip.tsx': clip,
        'lib/content.ts': READ_PATH,
      },
    });
    const cap = io(dir);
    const code = await runEject(['--write'], cap);
    expect(code).toBe(0);
    // the foreign copy() survives verbatim
    expect(read(dir, 'app/clip.tsx')).toContain("copy('some text')");
    expect(cap.out.join('\n')).toContain("left copy('some text')");
    expect(cap.out.join('\n')).toContain('foreign copy binding');
  });
});

describe('runEject — the plan diff', () => {
  it('prints a per-file unified diff in plan mode', async () => {
    const dir = host();
    const cap = io(dir);
    await runEject([], cap);
    const out = cap.out.join('\n');
    expect(out).toContain('--- a/app/page.tsx');
    expect(out).toContain('+++ b/app/page.tsx');
    expect(out).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });
});

describe('runEject --write — value serialization', () => {
  it('rides an ampersand-bearing value on a JSX expression container', async () => {
    const dir = scaffold({
      config: BASE_CONFIG,
      descriptor: { version: 1, keys: { amp: { shape: 'text', target: 'web' } } },
      defaults: { default: { amp: 'Tom & Jerry' } },
      files: {
        'app/layout.tsx': PLAIN_LAYOUT,
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <p>{copy('amp')}</p>; }\n",
        'lib/content.ts': READ_PATH,
      },
    });
    const code = await runEject(['--write'], io(dir));
    expect(code).toBe(0);
    // a bare `&` in JSX text re-decodes as an entity, so it must ride `{…}`
    expect(read(dir, 'app/page.tsx')).toContain('<p>{"Tom & Jerry"}</p>');
  });
});

/**
 * The refusal wall. The site's redo printed 29 per-file refusal lines over a
 * 9-line plan — the plan being the thing the operator ran the command for. More
 * than three collapse to one count line naming the same consequence, and
 * `--verbose` restores the list exactly.
 *
 * Every host here carries a stet-importing page beside the refusals ON PURPOSE:
 * with no importer the compiler-less probe never loads typescript, the
 * un-rewrite loop is skipped whole, and not one refusal would print — a fixture
 * that passes while proving nothing.
 */
describe('runEject — the parse-refusal wall', () => {
  /** A dialect file the TypeScript parser refuses — the shape that built the wall. An `.astro` file goes to the Astro un-rewrite instead (D15). */
  const REFUSED = '<template>\n  <h1>Chapter</h1>\n</template>\n';
  const IMPORTER = "import { copy } from '@/lib/content';\nexport const title = copy('hero');\n";

  const REFUSAL_CONFIG = {
    ...BASE_CONFIG,
    managedSurfaces: ['src/**/*.vue', 'src/**/*.ts'],
    rootLayout: 'app/layout.tsx',
  };

  function refusingHost(count: number): string {
    const files: Record<string, string> = {
      'app/layout.tsx': PLAIN_LAYOUT,
      'lib/content.ts': READ_PATH,
      // The importer, without which the whole loop is unreachable.
      'src/page.ts': IMPORTER,
    };
    for (let i = 0; i < count; i++) files[`src/pages/p${i}.vue`] = REFUSED;
    return scaffold({ config: REFUSAL_CONFIG, files });
  }

  it('collapses five refusals to one count line, the rest of the plan intact', async () => {
    const dir = refusingHost(5);
    const cap = io(dir);
    expect(await runEject([], cap)).toBe(0);
    const out = cap.out.join('\n');

    expect(out).toContain(
      '5 file(s) could not be parsed cleanly — not un-rewritten ' +
        '(the backstop refuses the dep drop if they still import stet); run with --verbose to list them',
    );
    // Not one per-file line survives.
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.vue: could not be parsed/.test(l))).toEqual([]);

    // The plan's other sections are all still there — asserted by what they say,
    // never by counting lines, so the case does not break on an unrelated line.
    expect(out).toContain('eject: plan only (pass --write to apply)');
    expect(out).toContain('un-rewrite:');
    expect(out).toContain('stays (no stet imports):');
    expect(out).toContain('snapshot:');
    expect(out).toContain('drop the stet dependency from package.json');
  });

  it('--verbose restores every per-file line and drops the count', async () => {
    const dir = refusingHost(5);
    const cap = io(dir);
    expect(await runEject(['--verbose'], cap)).toBe(0);
    const perFile = cap.out.filter((l) => /^src\/pages\/p\d\.vue: could not be parsed/.test(l));
    expect(perFile).toHaveLength(5);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('prints two refusals as before — a short list is information, not a wall', async () => {
    const dir = refusingHost(2);
    const cap = io(dir);
    expect(await runEject([], cap)).toBe(0);
    const perFile = cap.out.filter((l) => /^src\/pages\/p\d\.vue: could not be parsed/.test(l));
    expect(perFile).toHaveLength(2);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('turns over at three: three list, four collapse', async () => {
    // The threshold itself, at both sides of the boundary — the cases above sit
    // well clear of it and would pass under an off-by-one.
    const three = io(refusingHost(3));
    expect(await runEject([], three)).toBe(0);
    expect(three.out.filter((l) => /^src\/pages\/p\d\.vue: could not be parsed/.test(l))).toHaveLength(3);
    expect(three.out.join('\n')).not.toContain('run with --verbose to list them');

    const four = io(refusingHost(4));
    expect(await runEject([], four)).toBe(0);
    expect(four.out.filter((l) => /^src\/pages\/p\d\.vue: could not be parsed/.test(l))).toEqual([]);
    expect(four.out.join('\n')).toContain('4 file(s) could not be parsed cleanly');
  });

  it('would print nothing at all without a stet-importing file — the vacuity the host avoids', async () => {
    // Stated as a test rather than a comment: with no importer the compiler-less
    // probe loads no typescript and the un-rewrite loop never runs, so every
    // case above would pass while proving nothing. This is why `src/page.ts` is
    // in the host.
    const dir = scaffold({
      config: REFUSAL_CONFIG,
      files: {
        'app/layout.tsx': PLAIN_LAYOUT,
        'lib/content.ts': READ_PATH,
        'src/pages/p0.vue': REFUSED,
        'src/pages/p1.vue': REFUSED,
        'src/pages/p2.vue': REFUSED,
        'src/pages/p3.vue': REFUSED,
        'src/pages/p4.vue': REFUSED,
      },
    });
    const cap = io(dir);
    expect(await runEject([], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('un-rewrite: nothing to reverse');
    expect(cap.out.join('\n')).not.toContain('could not be parsed cleanly');
  });
});

/**
 * The whole-host sweep walks through `pages`' dirent walk — the same bound
 * `filesForGlobs` already puts on scan, register and eject's own surface set.
 * Symlinked host files are outside every walk stet makes, and the sweep says so
 * rather than being the one place that follows them.
 */
describe('runEject — the sweep walks what every other host walk walks', () => {
  it('does not report a symlinked guidance carrier as a moved block', async () => {
    const dir = host();
    const block = '# Notes\n\n<!-- stet:agent-guidance:begin -->\nCopy is stet-managed.\n<!-- stet:agent-guidance:end -->\n';
    write(dir, 'shared/agent-notes.md', block);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    symlinkSync(join(dir, 'shared/agent-notes.md'), join(dir, 'docs/linked-notes.md'));

    const cap = io(dir);
    expect(await runEject([], cap)).toBe(0);
    // The real file is reported; the link to it is not visited at all, so the
    // same block is never named twice under two paths.
    expect(cap.out.join('\n')).toContain('shared/agent-notes.md: carries the stet agent-guidance markers');
    expect(cap.out.join('\n')).not.toContain('docs/linked-notes.md');
  });

  it('runs through a dangling symlink instead of crashing on it', async () => {
    const dir = host();
    // A source-shaped link with no target: the inline walker read it at the
    // bare `readFileSync` and took the run down with an ENOENT.
    symlinkSync(join(dir, 'lib/gone.ts'), join(dir, 'app/dangling.ts'));
    const cap = io(dir);
    expect(await runEject([], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('dangling.ts');
  });
});

describe('eject — the static-HTML host', () => {
  afterAll(cleanupCliHosts);

  /** An adopted html host with the guidance and hook installed, inside a git checkout. */
  async function adopted() {
    const host = await makeHtmlHost({ register: true, git: true });
    expect(await host.run('agents', 'install')).toBe(0);
    expect(await host.run('hook', 'install')).toBe(0);
    host.out.length = 0;
    host.err.length = 0;
    return host;
  }

  it('plans the strip and touches nothing', async () => {
    const host = await adopted();
    const before = Buffer.from(host.file('index.html'), 'utf8');
    expect(await host.run('eject')).toBe(0);
    expect(host.stdout()).toContain('document: index.html — every mark removed, the text stays');
    expect(host.stdout()).toContain(
      'stays (no stet imports): stet.config.json, content/descriptor.json, content/defaults.json',
    );
    // There is nothing to reverse on this host, so the line about reversing
    // nothing never prints.
    expect(host.stdout()).not.toContain('un-rewrite');
    expect(Buffer.from(host.file('index.html'), 'utf8')).toEqual(before);
    expect(host.exists('AGENTS.md')).toBe(true);
  });

  it('--write strips every mark and leaves the page as its snapshot says', async () => {
    const host = await adopted();
    expect(await host.run('eject', '--write')).toBe(0);
    const page = host.file('index.html');
    expect(/data-stet/.test(page)).toBe(false);
    // The text stands exactly as the fixture wrote it: nothing in that document
    // normalises, so the regenerated-then-stripped page is byte-identical.
    expect(Buffer.from(page, 'utf8')).toEqual(Buffer.from(htmlFixture('index.html'), 'utf8'));

    expect(host.exists('AGENTS.md')).toBe(false);
    expect(host.exists('CLAUDE.md')).toBe(false);
    expect(host.exists('.git/hooks/pre-commit')).toBe(false);
    expect(host.file('package.json')).not.toContain('@getstet/stet');
    // The forms stay, exactly as the plan said.
    expect(host.exists('stet.config.json')).toBe(true);
    expect(host.exists('content/descriptor.json')).toBe(true);
    expect(host.exists('content/defaults.json')).toBe(true);
  });

  it('refuses whole when a document cannot be regenerated', async () => {
    const host = await adopted();
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    const key = Object.entries(snapshot.default).find(
      ([, v]) => v === 'You may already have the data<1> our AI lab partners need.</1>',
    )![0];
    snapshot.default[key] = 'You may already have the data our AI lab partners need.';
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    const before = Buffer.from(host.file('index.html'), 'utf8');

    expect(await host.run('eject', '--write')).toBe(1);
    expect(host.stderr()).toContain(
      'eject found 1 document(s) it cannot regenerate — index.html:25 tag-count-mismatch; nothing was written',
    );
    expect(Buffer.from(host.file('index.html'), 'utf8')).toEqual(before);
    expect(host.file('package.json')).toContain('@getstet/stet');
  });
});

describe('eject — the stage-5 fold, prose that quotes stet\'s own syntax', () => {
  it('removes every real mark and leaves a quoted one byte-identical', async () => {
    const page =
      '<html><body>\n' +
      '<p data-stet="lead">The attribute form is <code>data-stet-alt="image_caption"</code> instead.</p>\n' +
      '<p>Write data-stet="unclosed and then keep going</p>\n' +
      '<p>Second para with a "quote" here</p>\n' +
      '</body></html>\n';
    const host = await makeHtmlHost({
      files: { 'index.html': page },
      keys: { lead: { shape: 'text', target: 'web', tags: 1 } },
      defaults: { lead: 'The attribute form is <1>data-stet-alt="image_caption"</1> instead.' },
    });
    expect(await host.run('eject', '--write')).toBe(0);
    const out = host.file('index.html');
    // The real mark goes.
    expect(out).not.toContain('data-stet="lead"');
    // Every literal in prose survives: a regex strip deleted the <code> sample
    // outright, and its unbounded quote match ate 89 characters across two
    // paragraphs including a </p> and a <p>.
    expect(out).toContain('<code>data-stet-alt="image_caption"</code>');
    expect(out).toContain('Write data-stet="unclosed and then keep going');
    expect(out).toContain('<p>Second para with a "quote" here</p>');
    expect(out.split('</p>')).toHaveLength(4);
  });
});

describe('eject — the contacts tables stay in the database', () => {
  afterAll(cleanupCliHosts);
  const STAYS =
    'stays in the database: the contacts tables (stet_groups, stet_contacts, stet_group_memberships, stet_suppressions, ' +
    'stet_erasures) — eject drops no table; run stet contacts export <email> before --write to write a person to a file';

  it('names them on a store-backed plan, right after what stays in the repo', async () => {
    const dir = host({ store: true });
    const cap = io(dir, createMemoryStore({ project: 't' }));
    expect(await runEject([], cap)).toBe(0);
    const stays = cap.out.findIndex((line) => line.startsWith('stays (no stet imports):'));
    expect(stays).toBeGreaterThanOrEqual(0);
    expect(cap.out[stays + 1]).toBe(STAYS);
  });

  it('says nothing of them on a snapshot-only project with no contacts block', async () => {
    const cap = io(host());
    expect(await runEject([], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('stays in the database');
  });

  it('names them on an html host whose contacts have a store of their own', async () => {
    const html = await makeHtmlHost({
      register: true,
      config: { contacts: { store: { adapter: 'pg', urlEnv: 'STET_CONTACTS_DATABASE_URL' } } },
    });
    expect(await html.run('eject')).toBe(0);
    const lines = html.stdout().split('\n');
    const stays = lines.findIndex((line) => line.startsWith('stays (no stet imports):'));
    expect(lines[stays + 1]).toBe(STAYS);
  });
});


/** Every host file's bytes, for "nothing was written". */
function hostBytes(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (sub: string): void => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else files.set(rel, readFileSync(join(dir, rel)));
    }
  };
  walk('');
  return files;
}

function expectUnchanged(dir: string, before: Map<string, Buffer>): void {
  const after = hostBytes(dir);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rel, buf] of after) expect(buf.equals(before.get(rel) as Buffer), rel).toBe(true);
}

/** The line a file eject cannot prove refuses the run with (D15). */
const refusedLine = (file: string, reason: string): string => `${file}: ${reason} — restore its reads by hand, then re-run eject`;

describe('eject — an Astro host\'s reads go back as text (D15)', () => {
  const ASTRO_CONFIG = {
    project: 't',
    managedSurfaces: ['src/**/*.astro'],
    emailSurfaces: [],
    copyModules: [],
    readPath: { file: 'src/lib/content.ts', import: '@/lib/content' },
    router: 'astro',
    descriptorPath: 'content/descriptor.json',
    snapshotPath: 'content/defaults.json',
    codegen: { registry: 'content/keys.ts', defaults: 'content/defaults.ts', dts: 'content/stet-env.d.ts' },
  };
  /** An Astro host whose read path no host module imports, with `keys` declared and seeded. */
  const astroHost = (files: Record<string, string>, keys: Record<string, string> = { hero: 'Hello world' }, opts: { tagged?: boolean; readPath?: string } = {}): string =>
    scaffold({
      config: ASTRO_CONFIG,
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
      descriptor: { version: 1, keys: Object.fromEntries(Object.keys(keys).map((k) => [k, opts.tagged === true ? { shape: 'text', target: 'web', tags: 1 } : { shape: 'text', target: 'web' }])) },
      defaults: { default: keys },
      files: { 'src/lib/content.ts': opts.readPath ?? 'export const copy = (key: string): string => key;\n', ...files },
    });
  const PAGE = 'src/pages/index.astro';
  const CALLED = (body: string, front = ''): string => `---\nimport { copy } from '@/lib/content';\n${front}---\n${body}`;

  it('T15.4: refuses a file whose reads it cannot prove, naming it, and writes nothing', async () => {
    const cases: Array<[string, string]> = [
      [CALLED("<h1>{copy('hero')}</h1>\n{items.map((copy) => <p>{copy.t}</p>)}\n", "const items = [{ t: 'x' }];\n"), 'copy is rebound in a brace'],
      [CALLED('<h1>{copy.get(name)}</h1>\n', "const name = 'hero';\n"), 'copy.get(name) is no declared key stet can restore'],
      [
        CALLED("<p>{richParts(copy('hero'), [(c) => <b>{c.toUpperCase()}</b>])}</p>\n", "import { richParts } from '@getstet/stet';\n"),
        'a richParts call stet cannot read back',
      ],
    ];
    for (const [page, reason] of cases) {
      const dir = astroHost({ [PAGE]: page });
      const before = hostBytes(dir);
      const cap = io(dir);
      await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
      expect(cap.out).toContain(refusedLine(PAGE, reason));
      // The whole plan printed before the refusal.
      expect(cap.out.join('\n')).toContain('drop the stet dependency from package.json');
      await expect(runEject(['--write'], io(dir))).rejects.toThrow(/still importing stet/);
      expectUnchanged(dir, before);
    }
    // A read-back that fails (planted) refuses the same way.
    const dir = astroHost({ [PAGE]: CALLED("<h1>{copy('hero')}</h1>\n") });
    const cap = io(dir);
    planted.decode = true;
    try {
      await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    } finally {
      planted.decode = false;
    }
    expect(cap.out).toContain(refusedLine(PAGE, 'the un-rewrite did not read back cleanly'));
    // A key with no value aborts, as for a JSX leaf.
    const ghost = astroHost({ [PAGE]: CALLED("<h1>{copy('ghost')}</h1>\n") });
    await expect(runEject(['--write'], io(ghost))).rejects.toThrow('eject: no resolved value for key ghost');
  });

  it('un-rewrites a file whose only reads go through a declared copy module that imports no stet (addition: the import probe)', async () => {
    const page = '---\nimport { copy } from "../copy";\n---\n<h1>{copy.hero}</h1>\n';
    const dir = scaffold({
      config: { ...ASTRO_CONFIG, copyModules: ['src/copy.ts'] },
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
      descriptor: { version: 1, keys: { hero: { shape: 'text', target: 'web' } } },
      defaults: { default: { hero: 'Hello world' } },
      files: { 'src/copy.ts': 'export const copy: Record<string, string> = { hero: "Hello world" };\n', [PAGE]: page },
    });
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, PAGE)).toBe('<h1>Hello world</h1>\n');
  });

  it('T15.5: register then eject gives every .astro file back as it was, and leaves no stet anywhere', async () => {
    const original: Record<string, string> = {
      'src/components/Head.astro': '---\ninterface Props { label: string; sub?: string }\nconst { label, sub } = Astro.props;\n---\n<div><span>{label}</span>{sub && <p>{sub}</p>}</div>\n',
      [PAGE]: [
        '---',
        'import Head from "../components/Head.astro";',
        'const surfaces = [',
        '  { id: "a", label: "Site copy", note: "Every page holds words" },',
        '  { id: "b", label: "Email slots", note: "Every email holds words" },',
        '];',
        'const flags = { changelog: true };',
        'const flag = true;',
        '---',
        '<h3>Fixing a word</h3>',
        '<button title="Copy the command" class="b">x</button>',
        '<img alt="A team at work" src="/t.png">',
        '<a href="/docs" title="Tom &amp; Jerry">z</a>',
        '<Head label="Capabilities" sub="One registry holds them all" />',
        '<Head label="Tom &amp; Jerry" />',
        '{flags.changelog && <a class="i" href="/changelog">Changelog</a>}',
        '{flag && <img alt="Brace alt words" src="/x.png">}',
        '{[1, 2].map((i) => <a href="/x" title="Brace title words">{i}</a>)}',
        '{surfaces.map((s) => (<a id={"x-" + s.id}><h3>{s.label}</h3><p>{s.note}</p></a>))}',
        '<p>Install: run <b>npx x init</b> and answer.</p>',
        "<p>See <a class='i'  href=\"/docs\"><code>stet</code> docs</a> now</p>",
        '<p>Was <del>old</del> <span class="w">new</span></p>',
        '<div class="cell"><h3>Capture</h3><code>t("hero_headline")</code></div>',
        '',
      ].join('\n'),
      'src/pages/bare.astro': '<h3>Fenceless word here</h3>\n',
      'src/pages/noted.astro': "---\nimport x from './x'; // note\n---\n<h3>Noted word here</h3>\n",
      'src/pages/plain.astro': '---\nconst n = 1;\n---\n<h3>Plain front word</h3>\n',
      'src/pages/marked.astro': '﻿<html>\r\n<body>\r\n<h3>Fixing a word</h3>\r\n</body>\r\n</html>\r\n',
    };
    const dir = astroHost(original, {});
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const registered = Object.keys(original).map((rel) => read(dir, rel));
    expect(registered.filter((text, i) => text !== Object.values(original)[i])).toHaveLength(Object.keys(original).length - 1);
    expect(read(dir, PAGE)).toContain('{richParts(copy(');
    expect(read(dir, PAGE)).toMatch(/<code>\{copy\('\w+'\)\}<\/code><\/div>/);
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    for (const [rel, text] of Object.entries(original)) expect(read(dir, rel), rel).toBe(text);
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
    expect(allText(dir)).not.toMatch(/@getstet\/stet|from ['"]@\/lib\/content/);
    expect(existsSync(join(dir, 'src/lib/content.ts'))).toBe(false);
  }, 60_000);

  const RICH = "import { richParts } from '@getstet/stet';\n";

  it('refuses an Astro renderer whose open tag names its own parameter', async () => {
    const dir = astroHost({ [PAGE]: `---\nimport { copy } from '@/lib/content';\n${RICH}---\n<p>{richParts(copy('hero'), [(c) => <a href={c}>{c}</a>])}</p>\n` }, { hero: 'Run <1>x</1> now' }, { tagged: true });
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out).toContain(refusedLine(PAGE, 'a richParts call stet cannot read back'));
  });

  it('refuses a sentence read through a copy that is not stet\'s', async () => {
    const dir = astroHost(
      {
        [PAGE]: `---\nimport { copy } from './mine';\n${RICH}---\n<p>{richParts(copy('hero'), [(c) => <b>{c}</b>])}</p>\n`,
        'src/pages/mine.ts': 'export const copy = (k: string) => "Other <1>x</1>";\n',
      },
      { hero: 'Run <1>x</1> now' },
      { tagged: true },
    );
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out).toContain(refusedLine(PAGE, 'a richParts call stet cannot read back'));
  });

  it('keeps the line break between two restored braces in a pre', async () => {
    const dir = astroHost({ [PAGE]: CALLED("<pre>\n{copy('hero')}\n{copy('hero')}\n</pre>\n") });
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, PAGE)).toBe('<pre>\nHello world\nHello world\n</pre>\n');
  });

  it('writes an attribute value holding an unmatched brace as an expression', async () => {
    const dir = astroHost({ [PAGE]: CALLED("<button title={copy('hero')}>x</button>\n") }, { hero: 'Use { name here' });
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, PAGE)).toBe('<button title={"Use { name here"}>x</button>\n');
  });

  it('writes a component prop value holding an unmatched brace as an expression', async () => {
    const dir = astroHost({ [PAGE]: CALLED("<Card label={copy('hero')} />\n") }, { hero: 'Use { name here' });
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, PAGE)).toBe('<Card label={"Use { name here"} />\n');
  });

  it('an is:raw code sample naming the read path is no consumer of it', async () => {
    const dir = astroHost(
      { [PAGE]: CALLED("<h1>{copy('hero')}</h1>\n<pre is:raw><code>import { copy } from \"@/lib/content\";</code></pre>\n") },
      { hero: 'Hello world' },
      { readPath: "import { readBundle } from '@getstet/stet';\nexport const copy = (key: string): string => String(readBundle) + key;\n" },
    );
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, PAGE)).toBe('<h1>Hello world</h1>\n<pre is:raw><code>import { copy } from "@/lib/content";</code></pre>\n');
    expect(existsSync(join(dir, 'src/lib/content.ts'))).toBe(false);
  });

  it('REVIEW-S1: a value closing a script is written into a client script with its "<" escaped, and the script count stays', async () => {
    const value = '</script><script>alert(1)</script><script>';
    const page = "<h1>x</h1>\n<script>\nimport { copy } from '@/lib/content';\nconsole.log(copy('hero'));\n</script>\n";
    const dir = astroHost({ [PAGE]: page }, { hero: value });
    const cap = io(dir);
    expect(await runEject(['--write'], cap), cap.out.join('\n')).toBe(0);
    const after = read(dir, PAGE);
    expect(after.match(/<script/gi)).toHaveLength(1);
    expect(after.match(/<\/script/gi)).toHaveLength(1);
    // The restored literal still evaluates to the editor's value.
    const logged: unknown[] = [];
    const body = /<script>\n([\s\S]*?)\n<\/script>/.exec(after)?.[1] ?? '';
    runInNewContext(body.replace(/^import .*\n/, ''), { console: { log: (v: unknown) => logged.push(v) } });
    expect(logged).toEqual([value]);
  });

  it('REVIEW-S1: the read-back refuses a rewrite that split a client script into balanced pairs', async () => {
    const ts = await loadTypescript();
    const before = "<h1>x</h1>\n<script>\nconsole.log(copy('hero'));\n</script>\n";
    const split = '<h1>x</h1>\n<script>\nconsole.log("</script><script>alert(1)</script><script>");\n</script>\n';
    const intact = '<h1>x</h1>\n<script>\nconsole.log("\\u003c/script>");\n</script>\n';
    const expected = { elements: 0, names: new Set(['copy']) };
    expect(unrewrittenClean(ts, PAGE, before, split, [], expected)).toBe(false);
    expect(unrewrittenClean(ts, PAGE, before, intact, [], expected)).toBe(true);
  });
});

describe('eject — a JSX sentence key goes back to markup (D15)', () => {
  /** A Next app-router host with a typed read path and no keys yet. */
  const nextHost = (files: Record<string, string>, opts: { keys?: Record<string, unknown>; defaults?: Record<string, unknown> } = {}): string =>
    scaffold({
      config: BASE_CONFIG,
      descriptor: { version: 1, keys: opts.keys ?? {} },
      defaults: { default: opts.defaults ?? {} },
      files: { 'app/layout.tsx': PLAIN_LAYOUT, 'lib/content.ts': 'export const copy = (key: string): string => key;\n', ...files },
    });
  const SERVER_SENTENCES =
    "const k = 'x';\nexport default function Page() {\n  return (\n    <main>\n      <p>Run <b>npx x init</b> now.</p>\n" +
    '      <p>Keep <b key="x">this</b> key.</p>\n      <p>Mind <b data-k={k}>the</b> name.</p>\n    </main>\n  );\n}\n';
  const WIDGET = "'use client';\nexport default function Widget() {\n  return <p>Read the <a href=\"/docs\">docs</a> first.</p>;\n}\n";
  const IMPORTING = "import { richParts } from '@getstet/stet';\nexport default function Page() {\n  return <p>Run <b>npx x init</b> now.</p>;\n}\n";
  const SPACED = 'export default function Page() {\n  return <p><b>x</b> <i>y</i> words</p>;\n}\n';

  it('T15.8: each sentence comes back as the markup register replaced, and the host typechecks', async () => {
    const dir = nextHost({ 'app/page.tsx': SERVER_SENTENCES, 'app/widget.tsx': WIDGET, 'app/other/page.tsx': IMPORTING, 'app/spaced/page.tsx': SPACED });
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/page.tsx')).toContain('[(c, k) => <b key={k}>{c}</b>]');
    expect(read(dir, 'app/widget.tsx')).toContain("import { richParts } from '@getstet/stet/react';");
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe(SERVER_SENTENCES);
    expect(read(dir, 'app/widget.tsx')).toBe(WIDGET);
    expect(read(dir, 'app/layout.tsx')).toBe(PLAIN_LAYOUT);
    // The host's own renderer import goes with stet's.
    expect(read(dir, 'app/other/page.tsx')).toBe(IMPORTING.slice(IMPORTING.indexOf('\n') + 1));
    // A part that is white space alone rides a container, which JSX would otherwise drop.
    expect(read(dir, 'app/spaced/page.tsx')).toBe('export default function Page() {\n  return <p><b>x</b>{" "}<i>y</i> words</p>;\n}\n');
    expect(allText(dir)).not.toMatch(/@getstet\/stet|from ['"]@\/lib\/content/);
    const typed = tscClean(dir);
    expect(typed.output).toBe('');

    // Prettier 3's output over a registered sentence, byte for byte (check 4 K5): the
    // restored file, formatted again, is the original byte for byte (checked with
    // Prettier 3.9.10 over this exact text, check 4 K6).
    const formatted =
      'import { richParts } from "@getstet/stet/react/server";\nimport { copy } from "@/lib/content";\nexport default function Page() {\n  return (\n    <main>\n' +
      '      <p className="lede">\n        {richParts(copy("home_page_paragraph"), [\n          (c, k) => (\n            <b key={k} className="cmd">\n              {c}\n' +
      '            </b>\n          ),\n        ])}\n      </p>\n    </main>\n  );\n}\n';
    const pretty = nextHost(
      { 'app/page.tsx': formatted },
      {
        keys: { home_page_paragraph: { shape: 'text', target: 'web', tags: 1 } },
        defaults: { home_page_paragraph: 'Install: run <1>npx @getstet/stet@latest init --yes</1> and answer its questions.' },
      },
    );
    expect(await runEject(['--write'], io(pretty))).toBe(0);
    expect(read(pretty, 'app/page.tsx')).toBe(
      'export default function Page() {\n  return (\n    <main>\n      <p className="lede">\n' +
        '        Install: run <b className="cmd">npx @getstet/stet@latest init --yes</b> and answer its questions.\n      </p>\n    </main>\n  );\n}\n',
    );
  }, 60_000);

  it('T15.10: a value in any script reads back (check 4 K12)', async () => {
    const page = 'export default function Page() {\n  return (\n    <main>\n      <p>Run now <b>npx x init</b> please</p>\n      <p>Then read <b>the docs</b> first</p>\n    </main>\n  );\n}\n';
    const dir = nextHost({ 'app/page.tsx': page });
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const defaults = JSON.parse(read(dir, 'content/defaults.json')) as { default: Record<string, string> };
    const keyOf = (start: string): string => Object.keys(defaults.default).find((k) => defaults.default[k]?.startsWith(start)) as string;
    // The plan's value, and one with no Latin word anywhere, which scan's copy gate would refuse.
    const values = { [keyOf('Run now')]: '今すぐ <1>npx x init</1> を実行', [keyOf('Then read')]: '次に <1>説明書</1> を読む' };
    Object.assign(defaults.default, values);
    write(dir, 'content/defaults.json', JSON.stringify(defaults));
    expect(await runEject(['--write'], io(dir))).toBe(0);
    const after = read(dir, 'app/page.tsx');
    expect(after).toBe('export default function Page() {\n  return (\n    <main>\n      <p>今すぐ <b>npx x init</b> を実行</p>\n      <p>次に <b>説明書</b> を読む</p>\n    </main>\n  );\n}\n');
    const at = after.indexOf('今');
    const end = after.indexOf('</p>');
    expect(await jsxUnrewrittenClean(await loadTypescript(), 'app/page.tsx', after, [{ at, end, value: '今すぐ <1>npx x init</1> を実行' }])).toBe(true);
  }, 60_000);

  it('T15.9: refuses a sentence it cannot rebuild or read back, naming the file, and writes nothing', async () => {
    const imports = "import { copy } from '@/lib/content';\nimport { richParts } from '@getstet/stet/react/server';\n";
    const upper = nextHost(
      { 'app/page.tsx': `${imports}export default function Page() {\n  return <p>{richParts(copy('hero'), [(c, k) => <b key={k}>{c.toUpperCase()}</b>])}</p>;\n}\n` },
      { keys: { hero: { shape: 'text', target: 'web', tags: 1 } }, defaults: { hero: 'Run <1>x</1> now' } },
    );
    const before = hostBytes(upper);
    const cap = io(upper);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out).toContain(refusedLine('app/page.tsx', 'a richParts call stet cannot read back'));
    await expect(runEject(['--write'], io(upper))).rejects.toThrow(/still importing stet/);
    expectUnchanged(upper, before);

    const readable = nextHost(
      { 'app/page.tsx': `${imports}export default function Page() {\n  return <p>{richParts(copy('hero'), [(c, k) => <b key={k}>{c}</b>])}</p>;\n}\n` },
      { keys: { hero: { shape: 'text', target: 'web', tags: 1 } }, defaults: { hero: 'Run <1>x</1> now' } },
    );
    const kept = hostBytes(readable);
    const planned = io(readable);
    planted.jsxUnrewrittenClean = true;
    try {
      await expect(runEject([], planned)).rejects.toThrow(/still importing stet/);
      expect(planned.out).toContain(refusedLine('app/page.tsx', 'the un-rewrite did not read back cleanly'));
      await expect(runEject(['--write'], io(readable))).rejects.toThrow(/still importing stet/);
    } finally {
      planted.jsxUnrewrittenClean = false;
    }
    expectUnchanged(readable, kept);
  }, 60_000);

  const IMPORTS = "import { copy } from '@/lib/content';\nimport { richParts } from '@getstet/stet/react/server';\n";
  const tagged = (defaults: Record<string, string>): { keys: Record<string, unknown>; defaults: Record<string, string> } => ({
    keys: Object.fromEntries(Object.keys(defaults).map((k) => [k, { shape: 'text', target: 'web', tags: 1 }])),
    defaults,
  });

  it('refuses a renderer whose open tag still names k after the key attribute goes', async () => {
    const dir = nextHost({ 'app/page.tsx': `${IMPORTS}export default function P() {\n  return <p>{richParts(copy('hero'), [(c, k) => <b key={k} title={k}>{c}</b>])}</p>;\n}\n` }, tagged({ hero: 'Run <1>x</1> now' }));
    const cap = io(dir);
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    expect(cap.out).toContain(refusedLine('app/page.tsx', 'a richParts call stet cannot read back'));
  });

  it('writes a value holding an entity-looking & into a container', async () => {
    const dir = nextHost({ 'app/page.tsx': `${IMPORTS}export default function P() {\n  return <p>{richParts(copy('hero'), [(c, k) => <b key={k}>{c}</b>])}</p>;\n}\n` }, tagged({ hero: 'A &amp; B <1>&lt;x</1> now' }));
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe('export default function P() {\n  return <p>{"A &amp; B "}<b>{"&lt;x"}</b> now</p>;\n}\n');
  });

  it('restores a renderer whose open tag a formatter broke over lines', async () => {
    const page = `${IMPORTS}export default function P() {\n  return (\n    <p>\n      {richParts(copy('hero'), [\n        (c, k) => (\n          <b\n            key={k}\n            className="cmd"\n          >\n            {c}\n          </b>\n        ),\n      ])}\n    </p>\n  );\n}\n`;
    const dir = nextHost({ 'app/page.tsx': page }, tagged({ hero: 'Run <1>x</1> now' }));
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe('export default function P() {\n  return (\n    <p>\n      Run <b\n            className="cmd"\n          >x</b> now\n    </p>\n  );\n}\n');
  });

  it('restores a value whose tags were reordered to the markup of each number', async () => {
    const page = `${IMPORTS}export default function P() {\n  return <p>{richParts(copy('hero'), [(c, k) => <b key={k}>{c}</b>, (c, k) => <a key={k} href="/d">{c}</a>])}</p>;\n}\n`;
    const dir = nextHost({ 'app/page.tsx': page }, tagged({ hero: 'Read <2>docs</2> then run <1>x</1>.' }));
    expect(await runEject(['--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe('export default function P() {\n  return <p>Read <a href="/d">docs</a> then run <b>x</b>.</p>;\n}\n');
  });
});

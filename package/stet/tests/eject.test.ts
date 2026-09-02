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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { runEject } from '../cli/eject.js';
import { packageRoot } from '../cli/installed.js';
import type { CliIo } from '../cli/main.js';

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

  it('exports no history on a snapshot-only project', async () => {
    const dir = host();
    await runEject(['--write'], io(dir));
    expect(existsSync(join(dir, 'stet-history.json'))).toBe(false);
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
  /** A dialect file the TypeScript parser refuses — the shape that built the wall. */
  const REFUSED = '---\nconst t = 1;\n---\n<h1>Chapter</h1>\n';
  const IMPORTER = "import { copy } from '@/lib/content';\nexport const title = copy('hero');\n";

  const REFUSAL_CONFIG = {
    ...BASE_CONFIG,
    managedSurfaces: ['src/**/*.astro', 'src/**/*.ts'],
    rootLayout: 'app/layout.tsx',
  };

  function refusingHost(count: number): string {
    const files: Record<string, string> = {
      'app/layout.tsx': PLAIN_LAYOUT,
      'lib/content.ts': READ_PATH,
      // The importer, without which the whole loop is unreachable.
      'src/page.ts': IMPORTER,
    };
    for (let i = 0; i < count; i++) files[`src/pages/p${i}.astro`] = REFUSED;
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
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toEqual([]);

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
    const perFile = cap.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l));
    expect(perFile).toHaveLength(5);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('prints two refusals as before — a short list is information, not a wall', async () => {
    const dir = refusingHost(2);
    const cap = io(dir);
    expect(await runEject([], cap)).toBe(0);
    const perFile = cap.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l));
    expect(perFile).toHaveLength(2);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('turns over at three: three list, four collapse', async () => {
    // The threshold itself, at both sides of the boundary — the cases above sit
    // well clear of it and would pass under an off-by-one.
    const three = io(refusingHost(3));
    expect(await runEject([], three)).toBe(0);
    expect(three.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toHaveLength(3);
    expect(three.out.join('\n')).not.toContain('run with --verbose to list them');

    const four = io(refusingHost(4));
    expect(await runEject([], four)).toBe(0);
    expect(four.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toEqual([]);
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
        'src/pages/p0.astro': REFUSED,
        'src/pages/p1.astro': REFUSED,
        'src/pages/p2.astro': REFUSED,
        'src/pages/p3.astro': REFUSED,
        'src/pages/p4.astro': REFUSED,
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

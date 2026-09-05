/**
 * `stet init` — the scaffold. Each case runs `runInit` over a fresh temp
 * project with a captured `CliIo`, then asserts the files it wrote, the config
 * it detected, and the single root-layout edit (shown, gated, idempotent,
 * skipped-on-ambiguity). The scaffolded route's COMPILE is proven separately in
 * the CP5 compile-proof fixture.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfig, writeConfig, CONFIG_FILE } from '../cli/config.js';
import { runInit } from '../cli/init.js';
import { packageRoot } from '../cli/installed.js';
import { runCli, type CliIo } from '../cli/main.js';

/**
 * A fresh host. It DECLARES `react` unless asked not to: init scaffolds its
 * read path against the host's own dependencies, and a manifest-less directory
 * has no react at all — so a fixture standing in for a Next project has to say
 * so, the way a real one does.
 */
function project(opts: HostManifest = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-init-'));
  write(dir, 'package.json', hostManifest(opts));
  return dir;
}

interface HostManifest {
  react?: boolean;
  /** `'module'` where a case LOADS the scaffold with node rather than reading it. */
  type?: string;
}

function hostManifest(opts: HostManifest = {}): string {
  return `${JSON.stringify(
    {
      name: 'host',
      private: true,
      ...(opts.type === undefined ? {} : { type: opts.type }),
      ...(opts.react === false ? {} : { dependencies: { react: '^19' } }),
    },
    null,
    2,
  )}\n`;
}

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

const APP_LAYOUT = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const PAGES_APP = `import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`;

// A JS (not TS) root layout — no type annotations, so the mount parses it under
// ScriptKind.JS and the scaffold it writes must carry no TypeScript syntax.
const JS_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

interface Captured extends CliIo {
  out: string[];
  err: string[];
}
function makeIo(
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; email?: boolean; mount?: boolean; guidance?: boolean; ask?: string } = {},
): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: Captured = {
    cwd,
    env: opts.env ?? {},
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    out,
    err,
  };
  // One confirm channel serves three questions; route by the question text, the
  // way a person answering each prompt would.
  if (opts.email !== undefined || opts.mount !== undefined || opts.guidance !== undefined) {
    io.confirm = async (q: string) => {
      const asked = q.toLowerCase();
      if (asked.includes('send email')) return opts.email ?? false;
      if (asked.includes('agent-guidance')) return opts.guidance ?? false;
      return opts.mount ?? false;
    };
  }
  if (opts.ask !== undefined) io.ask = async () => opts.ask as string;
  return io;
}

function readConfig(dir: string, base = ''): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, base, 'stet.config.json'), 'utf8')) as Record<string, unknown>;
}

describe('runInit — snapshot-only', () => {
  it('writes the new files, no mount route, and the offline check is green', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir);
    const code = await runInit([], io);
    expect(code).toBe(0);

    for (const f of [
      'content/descriptor.json',
      'content/defaults.json',
      'content/keys.ts',
      'content/stet-env.d.ts',
      'content/defaults.ts',
      'lib/content.ts',
      'stet.config.json',
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    // a migration was copied
    expect(existsSync(join(dir, 'stet', 'migrations'))).toBe(true);
    // no store -> no route
    expect(existsSync(join(dir, 'app/api/stet/[...stet]/route.ts'))).toBe(false);

    const config = readConfig(dir);
    expect(config['router']).toBe('app');
    expect(config['rootLayout']).toBe('app/layout.tsx');
    expect(config['managedSurfaces']).toEqual(['app/**/*.tsx']);
    expect(config['mountRoute']).toBeUndefined();
    expect(config['store']).toBeUndefined();
    // snapshot-only has DEFAULTS already — no pull step
    expect(io.out.join('\n')).toContain('next: stet scan');
    expect(io.out.join('\n')).not.toContain('stet pull');
  });

  it('skips the provider mount non-interactively and prints the snippet', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir);
    await runInit([], io);
    // layout untouched
    expect(readFileSync(join(dir, 'app/layout.tsx'), 'utf8')).toBe(APP_LAYOUT);
    const joined = io.out.join('\n');
    expect(joined).toContain('non-interactive');
    expect(joined).toContain("import { CopyProvider } from '@getstet/stet/react'");
  });
});

describe('runInit — store-backed', () => {
  it('also writes the compile-shaped mount route and records the store', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir, { env: { STET_DATABASE_URL: 'postgres://localhost/x' } });
    const code = await runInit([], io);
    expect(code).toBe(0);

    const routePath = join(dir, 'app/api/stet/[...stet]/route.ts');
    expect(existsSync(routePath)).toBe(true);
    const route = readFileSync(routePath, 'utf8');
    expect(route).toContain("import { createStetHandler } from '@getstet/stet/server'");
    expect(route).toContain("import { createPgStore } from '@getstet/stet/store-pg'");
    expect(route).toContain('descriptor: descriptorJson as unknown as Descriptor');
    expect(route).toContain('// renderEmail:');
    // relative specifiers, never @/ aliases
    expect(route).toContain("from '../../../../stet.config.json'");
    expect(route).not.toContain("'@/");

    const config = readConfig(dir);
    expect(config['mountRoute']).toBe('app/api/stet/[...stet]/route.ts');
    expect(config['store']).toMatchObject({ adapter: 'pg' });
    // the read path serves the bundle that pull writes — the completion says so
    expect(io.out.join('\n')).toContain('stet pull');
  });
});

describe('runInit — the provider mount edit', () => {
  it('applies on confirm: imports CopyProvider and wraps {children}', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir, { mount: true });
    await runInit([], io);
    const layout = readFileSync(join(dir, 'app/layout.tsx'), 'utf8');
    expect(layout).toContain("import { CopyProvider } from '@getstet/stet/react'");
    expect(layout).toContain('const { resolved } = resolveAll(descriptorJson as unknown as Descriptor, readBundle(DEFAULTS))');
    expect(layout).toContain('<CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={resolved}>{children}</CopyProvider>');
    // client-safe: no server-only builtins reach the layout
    expect(layout).not.toContain('node:');
    expect(layout).not.toContain('readFileSync');
  });

  it('applies with --yes even when non-interactive', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir);
    await runInit(['--yes'], io);
    expect(readFileSync(join(dir, 'app/layout.tsx'), 'utf8')).toContain('<CopyProvider');
  });

  it('is idempotent — a second init with the provider present makes no change', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit(['--yes'], makeIo(dir));
    const afterFirst = readFileSync(join(dir, 'app/layout.tsx'), 'utf8');
    const io = makeIo(dir, { mount: true });
    await runInit([], io);
    expect(readFileSync(join(dir, 'app/layout.tsx'), 'utf8')).toBe(afterFirst);
    expect(io.out.join('\n')).toContain('already mounted');
  });

  it('skips and prints the snippet where the wrap point is ambiguous', async () => {
    const dir = project();
    write(
      dir,
      'app/layout.tsx',
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<div>{children}<aside>{children}</aside></div>);
}
`,
    );
    const io = makeIo(dir, { mount: true });
    await runInit([], io);
    expect(readFileSync(join(dir, 'app/layout.tsx'), 'utf8')).not.toContain('CopyProvider');
    expect(io.out.join('\n')).toContain('could not locate the wrap point');
  });

  it('writes the layout its OWN line endings', async () => {
    // A `\n` inserted into a CRLF file leaves mixed endings in a file stet did
    // not write (P3-13). The census is the assertion: every LF in the result
    // must be part of a CRLF pair, which a `toContain` could never show.
    const dir = project();
    const crlf = APP_LAYOUT.replace(/\n/g, '\r\n');
    write(dir, 'app/layout.tsx', crlf);
    await runInit(['--yes'], makeIo(dir));

    const out = readFileSync(join(dir, 'app/layout.tsx'));
    expect(out.includes('<CopyProvider')).toBe(true); // the mount did apply
    const lf = (out.toString('utf8').match(/\n/g) ?? []).length;
    const pairs = (out.toString('utf8').match(/\r\n/g) ?? []).length;
    expect(`bare LF: ${lf - pairs}`).toBe('bare LF: 0');
  });

  it('wraps <Component> on a Pages Router _app', async () => {
    const dir = project();
    write(dir, 'pages/_app.tsx', PAGES_APP);
    const io = makeIo(dir, { mount: true });
    const code = await runInit([], io);
    expect(code).toBe(0);
    const app = readFileSync(join(dir, 'pages/_app.tsx'), 'utf8');
    expect(app).toContain('<CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={resolved}><Component {...pageProps} /></CopyProvider>');
    expect(readConfig(dir)['router']).toBe('pages');
    expect(readConfig(dir)['managedSurfaces']).toEqual(['pages/**/*.tsx']);
  });
});

describe('runInit — layout probing and rebasing', () => {
  it('a src/app host is scaffolded and located under src/', async () => {
    const dir = project();
    write(dir, 'src/app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir, { env: { STET_DATABASE_URL: 'postgres://x' } });
    await runInit([], io);
    const config = readConfig(dir);
    expect(config['rootLayout']).toBe('src/app/layout.tsx');
    expect(config['mountRoute']).toBe('src/app/api/stet/[...stet]/route.ts');
    expect(config['managedSurfaces']).toEqual(['src/app/**/*.tsx']);
    expect(existsSync(join(dir, 'src/app/api/stet/[...stet]/route.ts'))).toBe(true);
  });

  it('a JS host probes rootLayout to app/layout.js', async () => {
    const dir = project();
    write(dir, 'app/layout.js', APP_LAYOUT);
    await runInit([], makeIo(dir));
    expect(readConfig(dir)['rootLayout']).toBe('app/layout.js');
  });

  it('P1-3/P2-11 — a JS host scaffolds JS surfaces and TypeScript-free modules', async () => {
    const dir = project();
    write(dir, 'app/layout.js', JS_LAYOUT);
    const io = makeIo(dir, { mount: true });
    await runInit([], io);

    // P2-11: the surface globs widen to .jsx AND .js alongside .tsx (create-next-app
    // JS mode generates app/page.js; stet's matcher has no brace expansion, so it is
    // three separate entries), and the read path is a .js module.
    const config = readConfig(dir);
    expect(config['managedSurfaces']).toEqual(['app/**/*.tsx', 'app/**/*.jsx', 'app/**/*.js']);
    expect((config['readPath'] as Record<string, unknown>)['file']).toBe('lib/content.js');
    expect(existsSync(join(dir, 'lib/content.js'))).toBe(true);
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(false);

    // P1-3: no TypeScript syntax reaches a JS file — else `next build` dies after
    // init reported success. The read-path module first.
    const readPath = readFileSync(join(dir, 'lib/content.js'), 'utf8');
    expect(readPath).toContain('const descriptor = descriptorJson;');
    for (const ts of ['as unknown as Descriptor', 'type Descriptor', ': unknown', ': Descriptor']) {
      expect(readPath, `read path must not contain ${ts}`).not.toContain(ts);
    }
    // And the mounted JS layout: no cast, no type-only import.
    const layout = readFileSync(join(dir, 'app/layout.js'), 'utf8');
    expect(layout).toContain('<CopyProvider descriptor={descriptorJson} resolved={resolved}>');
    expect(layout).toContain("import { readBundle, resolveAll } from '@getstet/stet';");
    expect(layout).not.toContain('as unknown as Descriptor');
    expect(layout).not.toContain('type Descriptor');
  });
});

describe('runInit — the router is detected by route files', () => {
  const ASTRO_PAGE = '---\nconst title = "Home";\n---\n<h1>{title}</h1>\n';

  it('records an Astro host as astro, with no root layout and the astro surface', async () => {
    const dir = project();
    write(dir, 'src/pages/index.astro', ASTRO_PAGE);
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);

    const config = readConfig(dir);
    expect(config['router']).toBe('astro');
    // ABSENT, not a placeholder path: an Astro host has no root React layout,
    // and a path naming a file that is not there is the lie this fixes.
    expect(Object.hasOwn(config, 'rootLayout')).toBe(false);
    expect(config['managedSurfaces']).toEqual(['src/**/*.astro']);
    expect(config['readPath']).toMatchObject({ file: 'src/lib/content.ts' });

    // The react-free scaffold, whether or not react is declared: an island's
    // React tree is not the site's layout.
    const readPath = readFileSync(join(dir, 'src/lib/content.ts'), 'utf8');
    expect(readPath).toContain("from '@getstet/stet'");
    expect(readPath).toContain('createAccessor');
    expect(readPath).toContain('export const copyMap');
    expect(existsSync(join(dir, 'src/app'))).toBe(false);

    const out = [...io.out, ...io.err].join('\n');
    expect(out).toContain('router: astro (src/pages carries .astro files)');
    expect(out).toContain(
      "no CopyProvider mount: an Astro host has no root React layout — read copy from '@/lib/content', " +
        "either copy('key') for text or copyMap.key by property",
    );
    expect(out).not.toContain('stet/react');
  });

  it('writes no Next-shaped mount route on a store-backed Astro host', async () => {
    const dir = project();
    write(dir, 'src/pages/index.astro', ASTRO_PAGE);
    const io = makeIo(dir, { env: { STET_DATABASE_URL: 'postgres://localhost/x' } });
    expect(await runInit(['--yes'], io)).toBe(0);

    const config = readConfig(dir);
    expect(config['store']).toBeDefined();
    expect(config['mountRoute']).toBeUndefined();
    expect(existsSync(join(dir, 'src/app/api/stet/[...stet]/route.ts'))).toBe(false);

    const out = [...io.out, ...io.err].join('\n');
    expect(out).toContain(
      'mount route: not scaffolded on an Astro host — mount createStetHandler in an Astro endpoint by hand',
    );
    // The read path serves the bundle `pull` writes, store route or not — so
    // the store host is still told to run it.
    expect(out).toContain('next: stet pull');
  });

  it('records an Astro host with no .astro page through its root config file', async () => {
    // A content-collections or Starlight site may carry no `.astro` file under
    // `src/pages` at all. Without this arm it takes the directory fallback and
    // records the very lie the file probe fixes.
    const dir = project();
    write(dir, 'astro.config.mjs', "export default {};\n");
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);
    expect(readConfig(dir)['router']).toBe('astro');
    expect([...io.out, ...io.err].join('\n')).toContain('router: astro (astro.config.mjs at the root)');
  });

  it('gives an Astro host the Astro reason even where it declares no react', async () => {
    const dir = project({ react: false });
    write(dir, 'src/pages/index.astro', ASTRO_PAGE);
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);
    const out = [...io.out, ...io.err].join('\n');
    expect(out).toContain('no CopyProvider mount: an Astro host has no root React layout');
    expect(out).not.toContain('this host declares no react');
  });

  it('still records a Next App host by its page file, root layout and all', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    write(dir, 'app/page.tsx', 'export default function Page() { return null; }\n');
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);
    const config = readConfig(dir);
    expect(config['router']).toBe('app');
    expect(config['rootLayout']).toBe('app/layout.tsx');
    expect([...io.out, ...io.err].join('\n')).toContain('router: app (app carries a page file)');
  });

  it('ejects an Astro host at exit 0 without touching a layout', async () => {
    const dir = project();
    write(dir, 'src/pages/index.astro', ASTRO_PAGE);
    expect(await runInit(['--yes'], makeIo(dir))).toBe(0);
    // The unwrap path is unreachable with no recorded layout, and the sweep
    // still runs over the `.astro` surface.
    const io = makeIo(dir);
    expect(await runCli(['eject'], io)).toBe(0);
  });
});

describe('runInit — the read path matches the host (F5)', () => {
  /** The workspace's installed packages: what makes `from '@getstet/stet'` resolve in a temp host. */
  const WORKSPACE_MODULES = join(packageRoot(), '..', 'node_modules');

  /** The built package a host resolves `stet` to. `npm test` builds first; a bare vitest run may not have. */
  function ensureBuilt(): void {
    if (existsSync(join(packageRoot(), 'dist', 'src', 'index.js'))) return;
    execFileSync('npm', ['run', 'build'], { cwd: packageRoot(), stdio: 'pipe' });
  }

  // The react branch, pinned whole: F5 changed which module a react-LESS host
  // gets, and a host that declares react must still receive exactly this.
  const REACT_READ_PATH = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createServerCopy } from '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';

import descriptorJson from '../content/descriptor.json';

const descriptor = descriptorJson as unknown as Descriptor;

// The committed bundle (or the snapshot, snapshot-only), read at request
// time so a published change is served without a rebuild.
function currentBundle() {
  const raw: unknown = JSON.parse(readFileSync(join(process.cwd(), 'content/defaults.json'), 'utf8'));
  return readBundle(raw);
}

const { resolved } = resolveAll(descriptor, currentBundle());

// stet register inserts: import { copy } from '@/lib/content'
export const copy = createServerCopy(descriptor, resolved);
`;

  it('a host declaring react gets the @getstet/stet/react module, byte for byte', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit([], makeIo(dir));
    expect(readFileSync(join(dir, 'lib/content.ts'))).toEqual(Buffer.from(REACT_READ_PATH, 'utf8'));
  });

  it('a react-less TS host gets a module plain node loads and executes', async () => {
    ensureBuilt();
    // No root layout: the react-less host's real shape (the Astro install), so
    // the mount degrades to a printed snippet and the scaffold stands alone.
    const dir = project({ react: false, type: 'module' });
    await runInit(['--yes'], makeIo(dir));

    const readPath = readFileSync(join(dir, 'lib/content.ts'), 'utf8');
    // Nothing under @getstet/stet/react: its index re-exports the provider, which
    // imports the optional react peer this host does not have.
    expect(readPath).not.toContain('@getstet/stet/react');
    expect(readPath).toContain(
      "import { createAccessor, readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    );
    // `.js`-suffixed: the extensionless form is TS2835 under nodenext, which
    // is the resolution a plain-Node TypeScript host uses.
    expect(readPath).toContain("import type { StringKey } from '../content/keys.js';");
    expect(readPath).toContain('export const copy = createAccessor(descriptor, resolved);');
    expect(readPath).toContain('export const copyMap = resolved as Record<StringKey, string>;');
    // The descriptor is read, never imported: an attribute-less JSON import is
    // a load error under plain node, and this host has no bundler to hide it.
    expect(readPath).not.toContain('import descriptorJson from');

    symlinkSync(WORKSPACE_MODULES, join(dir, 'node_modules'), 'dir');
    const probe = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        "const m = await import('./lib/content.ts');" +
          'process.stdout.write(JSON.stringify({' +
          ' map: m.copyMap.hero_headline,' +
          ' call: m.copy("hero_headline"),' +
          ' prop: typeof m.copy.hero_headline,' +
          ' }));',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    const seen = JSON.parse(probe) as { map: string; call: string; prop: string };
    expect(typeof seen.map).toBe('string');
    expect(seen.map).toBe(seen.call);
    // Why the map is exported at all: the accessor is callable-only, so
    // `{copy.hero_headline}` in a template renders nothing and says nothing.
    expect(seen.prop).toBe('undefined');
  });

  it('mounts no provider on a react-less host, on the TS and the JS layout shape alike', async () => {
    // The layout EXISTS in both, which is the case that would otherwise be
    // REWRITTEN: `--yes` applies the mount edit unattended, and the import it
    // inserts cannot load on a host with no react.
    for (const [layout, body] of [
      ['app/layout.tsx', APP_LAYOUT],
      ['app/layout.js', JS_LAYOUT],
    ] as const) {
      const dir = project({ react: false });
      write(dir, layout, body);
      const io = makeIo(dir);
      expect(await runInit(['--yes'], io)).toBe(0);

      // Byte-unchanged: not the wrap, not the import, not a reformat.
      expect(readFileSync(join(dir, layout)), layout).toEqual(Buffer.from(body, 'utf8'));
      // The step is named, with the read route this host actually has.
      const printed = [...io.out, ...io.err].join('\n');
      expect(printed, layout).toContain(
        "no CopyProvider mount: this host declares no react — read copy from '@/lib/content', " +
          "either copy('key') for text or copyMap.key by property",
      );
      // Not one line of output names the module that cannot load here — not
      // the applied edit, and not the wrap-point-miss snippet either. The
      // skip line says `no CopyProvider mount`, so the mount is recognised by
      // the two forms that mean one happened: the import and the wrap.
      expect(printed, layout).not.toContain('@getstet/stet/react');
      expect(printed, layout).not.toContain('import { CopyProvider }');
      expect(printed, layout).not.toContain('<CopyProvider');
    }
  });

  it('skips the mount on a react-less host whose wrap point cannot be found', async () => {
    // The site's own shape: the probe misses, and the fallback prints the
    // manual snippet — which on this host names an import that cannot load.
    const dir = project({ react: false });
    write(dir, 'app/layout.tsx', 'export default function RootLayout({ children }: { children: unknown }) {\n  return (<div>{children}<aside>{children}</aside></div>);\n}\n');
    const io = makeIo(dir, { mount: true });
    expect(await runInit([], io)).toBe(0);
    const printed = [...io.out, ...io.err].join('\n');
    expect(printed).toContain('no CopyProvider mount: this host declares no react');
    expect(printed).not.toContain('could not locate the wrap point');
    expect(printed).not.toContain('@getstet/stet/react');
  });

  it('reads react from the monorepo ROOT when --app targets a sub-package', async () => {
    // Hoisted monorepos declare react once at the top. Reading only the
    // sub-package called such a host react-less and printed the skip line
    // while its layout sat there waiting to be wrapped.
    const dir = project(); // root declares react
    write(dir, 'apps/web/package.json', hostManifest({ react: false }));
    write(dir, 'apps/web/app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir);
    expect(await runInit(['--app', 'apps/web', '--yes'], io)).toBe(0);

    // The react module, and the mount actually applied.
    expect(readFileSync(join(dir, 'apps/web/lib/content.ts'), 'utf8')).toContain(
      "import { createServerCopy } from '@getstet/stet/react';",
    );
    expect(readFileSync(join(dir, 'apps/web/app/layout.tsx'), 'utf8')).toContain('<CopyProvider');
    expect(io.out.join('\n')).not.toContain('no CopyProvider mount');

    // Root AND sub react-less stays react-free, as before.
    const bare = project({ react: false });
    write(bare, 'apps/web/package.json', hostManifest({ react: false }));
    write(bare, 'apps/web/app/layout.tsx', APP_LAYOUT);
    const bareIo = makeIo(bare);
    expect(await runInit(['--app', 'apps/web', '--yes'], bareIo)).toBe(0);
    expect(readFileSync(join(bare, 'apps/web/lib/content.ts'), 'utf8')).toContain(
      "import { createAccessor, readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    );
    expect(bareIo.out.join('\n')).toContain('no CopyProvider mount');
  });

  it('declares react as a PEER and is still a react host', async () => {
    // A component library declares react as a peer. Reading two of the three
    // dependency maps called it react-less.
    const dir = mkdtempSync(join(tmpdir(), 'stet-init-'));
    write(dir, 'package.json', `${JSON.stringify({ name: 'lib', peerDependencies: { react: '>=18' } }, null, 2)}\n`);
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit(['--yes'], makeIo(dir));
    expect(readFileSync(join(dir, 'lib/content.ts'), 'utf8')).toContain(
      "import { createServerCopy } from '@getstet/stet/react';",
    );
  });

  it('a react-less JS host gets a module plain node runs with no flag at all', async () => {
    ensureBuilt();
    const dir = project({ react: false, type: 'module' });
    write(dir, 'app/layout.js', JS_LAYOUT);
    await runInit([], makeIo(dir));
    const readPath = readFileSync(join(dir, 'lib/content.js'), 'utf8');
    expect(readPath).toContain("import { createAccessor, readBundle, resolveAll } from '@getstet/stet';");
    expect(readPath).toContain('export const copyMap = resolved;');
    for (const ts of ['type Descriptor', 'StringKey', ': unknown', ' as Descriptor', 'Record<']) {
      expect(readPath, `the JS read path must not contain ${ts}`).not.toContain(ts);
    }

    // The cheaper leg of the same proof: a `.js` module needs no type
    // stripping, so plain `node` with NO flag has to run it as written.
    symlinkSync(WORKSPACE_MODULES, join(dir, 'node_modules'), 'dir');
    const probe = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const m = await import('./lib/content.js');" +
          'process.stdout.write(JSON.stringify({' +
          ' map: m.copyMap.hero_headline,' +
          ' call: m.copy("hero_headline"),' +
          ' prop: typeof m.copy.hero_headline,' +
          ' }));',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    const seen = JSON.parse(probe) as { map: string; call: string; prop: string };
    expect(typeof seen.map).toBe('string');
    expect(seen.map).toBe(seen.call);
    expect(seen.prop).toBe('undefined');
  });
});

describe('runInit — the read-path import alias (P2-10)', () => {
  const importOf = (dir: string): unknown => (readConfig(dir)['readPath'] as Record<string, unknown>)['import'];

  it('derives readPath.import from a src-mapped @/* alias', async () => {
    const dir = project();
    write(dir, 'src/app/layout.tsx', APP_LAYOUT);
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
    await runInit([], makeIo(dir));
    // @/* -> ./src/* and the read path is src/lib/content.ts, so @/lib/content resolves.
    expect(importOf(dir)).toBe('@/lib/content');
  });

  it('detects a non-@ alias prefix and uses it verbatim', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./*'] } } }));
    await runInit([], makeIo(dir));
    expect(importOf(dir)).toBe('~/lib/content');
  });

  it('falls back to @/lib/content with a note when no path alias is declared', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir);
    await runInit([], io);
    expect(importOf(dir)).toBe('@/lib/content');
    expect(io.out.join('\n')).toContain('no tsconfig/jsconfig path alias');
  });
});

describe('runInit — --app and plan-then-apply', () => {
  it('--app targets a sub-package and its check runs there', async () => {
    const dir = project();
    write(dir, 'apps/web/package.json', hostManifest());
    write(dir, 'apps/web/app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir);
    const code = await runInit(['--app', 'apps/web'], io);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'apps/web/content/descriptor.json'))).toBe(true);
    expect(existsSync(join(dir, 'content/descriptor.json'))).toBe(false);
    // the check ran against the sub-package (its snapshot line is present)
    expect(io.out.join('\n')).toContain('snapshot:');
  });

  it('a pristine re-run changes nothing', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit(['--yes'], makeIo(dir));
    const io = makeIo(dir);
    const code = await runInit([], io);
    expect(code).toBe(0);
    const joined = io.out.join('\n');
    expect(joined).toContain('already present, identical');
    expect(joined).not.toContain('wrote content/descriptor.json');
  });

  it('a run after a real edit to a written file is a named refusal', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit([], makeIo(dir));
    writeFileSync(join(dir, 'content/descriptor.json'), '{"version":1,"keys":{}}\n', 'utf8');
    await expect(runInit([], makeIo(dir))).rejects.toThrow(/content\/descriptor\.json/);
    // nothing overwritten — the hand-edited file stands
    expect(readFileSync(join(dir, 'content/descriptor.json'), 'utf8')).toBe('{"version":1,"keys":{}}\n');
  });
});

describe('runInit — the agent-guidance write', () => {
  // The gate is operator-ruled (proposal R4), and a gate proven by nothing is a
  // gate that can be deleted silently: these two cases are what make the
  // confirm branch and the shown block load-bearing.
  it('writes the pair on a confirmed yes, and SHOWS the block it is about to write', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir, { guidance: true });
    await runInit([], io);

    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'));

    // The block's own text is in the report, indented, ahead of the line saying
    // it was written — the diff-shaped transparency the mount edit gets.
    const shown = io.out.findIndex((line) => line === '  <!-- stet:agent-guidance:begin -->');
    const wrote = io.out.findIndex((line) => line === 'wrote AGENTS.md (agent guidance)');
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(wrote).toBeGreaterThan(shown);
    expect(io.out).toContain('create AGENTS.md — the agent-guidance block:');
  });

  it('writes nothing on a declined prompt and names the command that writes it later', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir, { guidance: false });
    const code = await runInit([], io);
    expect(code).toBe(0); // a decline is not a failed init
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(io.out.join('\n')).toContain('agent guidance not written — stet agents install writes it later');
  });
});

describe('runInit — the email question', () => {
  it('adds the lib/email glob when the site sends email', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const io = makeIo(dir, { email: true });
    await runInit([], io);
    expect(readConfig(dir)['managedSurfaces']).toEqual([
      'app/**/*.tsx',
      'lib/email/**/*.ts',
      'lib/email/**/*.tsx',
    ]);
    // the email globs are also the target-derivation list (R-CP6-2), and `.tsx`
    // is in it because a react-email template IS a `.tsx` component
    expect(readConfig(dir)['emailSurfaces']).toEqual(['lib/email/**/*.ts', 'lib/email/**/*.tsx']);
  });

  it('covers .jsx on a JavaScript host, the same way .tsx is covered', async () => {
    // Symmetry with the TypeScript branch: a react-email template on a JS host
    // is a `.jsx` component, and a glob pair that stopped at `.js` made the
    // no-argument walk skip it.
    const dir = project();
    write(dir, 'app/layout.js', JS_LAYOUT);
    await runInit([], makeIo(dir, { email: true }));
    expect(readConfig(dir)['emailSurfaces']).toEqual([
      'lib/email/**/*.ts',
      'lib/email/**/*.js',
      'lib/email/**/*.jsx',
    ]);
    expect(readConfig(dir)['managedSurfaces']).toContain('lib/email/**/*.jsx');
  });

  it('leaves emailSurfaces empty for a web-only site', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit([], makeIo(dir));
    expect(readConfig(dir)['emailSurfaces']).toEqual([]);
  });
});

describe('runInit — the declared copy modules', () => {
  it('writes copyModules as [], and a host that declared one is refused rather than overwritten', async () => {
    const dir = project();
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    await runInit([], makeIo(dir));
    expect(readConfig(dir)['copyModules']).toEqual([]);

    // Declared through the config's own writer, so the ONLY difference from the
    // file init would write is the list itself. The config then differs from the
    // planned one, and the plan-all-then-apply batch refuses the whole run —
    // which is what keeps a host's declaration off the overwrite path.
    // stet's glob matcher has no brace expansion: `src/**/*.{ts,astro}` matches
    // nothing while the walk still runs, so a declaration is one glob per
    // extension and an exact path matches as itself.
    writeConfig(join(dir, CONFIG_FILE), { ...loadConfig(dir), copyModules: ['src/copy.ts'] });
    const io = makeIo(dir);
    expect(await runCli(['init'], io)).toBe(1);
    expect(io.err.join('\n')).toContain('refusing to overwrite');
    expect(readConfig(dir)['copyModules']).toEqual(['src/copy.ts']);
  });
});

describe('runInit — the static-HTML host', () => {
  /** The shared fixture page: the reduced psyon shape every html section reads. */
  const PAGE = readFileSync(
    fileURLToPath(new URL('./fixtures/html-host/index.html', import.meta.url)),
    'utf8',
  );

  /** A folder carrying a page and a manifest that names only stet. */
  function htmlProject(manifest: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'stet-init-html-'));
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'site', private: true, devDependencies: { '@getstet/stet': '^0.1.2' }, ...manifest }, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'index.html'), PAGE, 'utf8');
    return dir;
  }

  it('detects the host from a root page and a framework-free manifest', async () => {
    const dir = htmlProject();
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);
    expect(io.out[0]).toBe('host: html (index.html at the root, no framework in package.json)');
    expect(io.out.join('\n')).not.toContain('router:');
  });

  it('leaves a Vite host with a root index.html a JavaScript host', async () => {
    const dir = htmlProject({ devDependencies: { vite: '^5' } });
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);
    expect(io.out[0]).toBe('router: app (default — no route files found)');
    expect(readConfig(dir)['host']).toBeUndefined();
  });

  it('forces the shape with --host html, even on a folder with no page yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-init-html-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"site","private":true}\n');
    const io = makeIo(dir);
    expect(await runInit(['--host', 'html', '--yes'], io)).toBe(0);
    expect(io.out[0]).toBe('host: html (--host html)');
    expect(readConfig(dir)['host']).toBe('html');
  });

  it('refuses any other --host value, naming the one it takes', async () => {
    const dir = htmlProject();
    const io = makeIo(dir);
    const code = await runCli(['init', '--host', 'next', '--yes'], io);
    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('stet init --host takes one value, html');
  });

  it('reads root names only — a page under docs/ is not a host, nor is a directory named x.html', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'stet-init-html-'));
    writeFileSync(join(nested, 'package.json'), '{"name":"site","private":true}\n');
    write(nested, 'docs/index.html', PAGE);
    const io = makeIo(nested);
    expect(await runInit(['--yes'], io)).toBe(0);
    expect(io.out[0]).toBe('router: app (default — no route files found)');

    const dirNamed = mkdtempSync(join(tmpdir(), 'stet-init-html-'));
    writeFileSync(join(dirNamed, 'package.json'), '{"name":"site","private":true}\n');
    mkdirSync(join(dirNamed, 'x.html'));
    const io2 = makeIo(dirNamed);
    expect(await runInit(['--yes'], io2)).toBe(0);
    expect(io2.out[0]).toBe('router: app (default — no route files found)');
  });

  it('writes three files and no JavaScript scaffold at all', async () => {
    const dir = htmlProject();
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);

    expect(new Set(readdirSync(dir))).toEqual(
      new Set(['package.json', 'index.html', 'content', 'stet.config.json', 'AGENTS.md', 'CLAUDE.md']),
    );
    expect(new Set(readdirSync(join(dir, 'content')))).toEqual(
      new Set(['descriptor.json', 'defaults.json']),
    );
    expect(existsSync(join(dir, 'lib'))).toBe(false);
    expect(existsSync(join(dir, 'stet'))).toBe(false);
  });

  it('writes the config projection and nothing this host does not use', async () => {
    const dir = htmlProject();
    await runInit(['--yes'], makeIo(dir));

    // Buffer-compared against the canonical form the deterministic serializer
    // produces, so an extra key is a failure rather than a passing superset.
    const expected = `${JSON.stringify(
      {
        bundlePath: '.stet/bundle.json',
        copyModules: [],
        descriptorPath: 'content/descriptor.json',
        emailSurfaces: [],
        host: 'html',
        locales: { default: 'default', enabled: ['default'] },
        managedSurfaces: ['**/*.html'],
        project: 'default',
        scan: { baseline: '.stet/scan-baseline.json', severity: 'warn' },
        snapshotPath: 'content/defaults.json',
      },
      null,
      2,
    )}\n`;
    expect(readFileSync(join(dir, CONFIG_FILE))).toEqual(Buffer.from(expected, 'utf8'));

    // And it still loads, with the unwritten fields defaulted in memory.
    const config = loadConfig(dir);
    expect(config.host).toBe('html');
    expect(config.readPath.file).toBe('lib/content.ts');
  });

  it('writes an EMPTY descriptor and snapshot — the page already carries its copy', async () => {
    const dir = htmlProject();
    const io = makeIo(dir);
    await runInit(['--yes'], io);
    expect(JSON.parse(readFileSync(join(dir, 'content/descriptor.json'), 'utf8'))).toEqual({
      version: 1,
      keys: {},
    });
    expect(JSON.parse(readFileSync(join(dir, 'content/defaults.json'), 'utf8'))).toEqual({
      default: {},
    });
    expect(io.out).toContain('snapshot: 0 keys declared, 0 missing, 0 stale');
    expect(io.out).toContain('document: index.html current (0 marks)');
  });

  it('closes with the page’s own counts and names the hook as the next step', async () => {
    const dir = htmlProject();
    const io = makeIo(dir);
    await runInit(['--yes'], io);
    expect(io.out[io.out.length - 1]).toBe(
      '1 page, 22 text elements, 6 attributes — next: stet scan, then stet hook install',
    );
    // No read path was written, so its alias was never resolved and never noted.
    expect(io.out.join('\n')).not.toContain('note:');
    expect(io.out.join('\n')).not.toContain('CopyProvider');
  });

  it('writes the guidance block in its html wording', async () => {
    const dir = htmlProject();
    await runInit(['--yes'], makeIo(dir));
    const block = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(block).toContain('data-stet');
    expect(block).toContain('stet pull');
    expect(block).toContain('content/defaults.json');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(block);
  });

  it('never writes the hook, on this host as on every other', async () => {
    const dir = htmlProject();
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    await runInit(['--yes'], makeIo(dir));
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('changes nothing on a second run', async () => {
    const dir = htmlProject();
    await runInit(['--yes'], makeIo(dir));
    const before = readFileSync(join(dir, 'index.html'));
    const io = makeIo(dir);
    expect(await runInit(['--yes'], io)).toBe(0);
    for (const name of ['content/descriptor.json', 'content/defaults.json', CONFIG_FILE]) {
      expect(io.out).toContain(`${name}: already present, identical`);
    }
    expect(readFileSync(join(dir, 'index.html'))).toEqual(before);
  });
});

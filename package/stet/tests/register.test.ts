/**
 * `stet register --from scan` — adopt scanned literals. Each case runs
 * `runRegister` over a temp project, then asserts the descriptor/default it
 * added, the ONE import + ONE `const copy` per file, the collision suffix, the
 * never-touch-a-published-value guarantee, idempotence, the server/client
 * choice, and every refusal (ambiguous, no-provider, foreign `copy`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * A write outside the temp directory is refused as the disk would refuse a
 * write under `/`, whoever runs the suite: the absolute `--plan-out` case
 * aims at `/index.html`, and a run as root must not leave one there.
 */
vi.mock('../cli/artifacts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cli/artifacts.js')>();
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const roots = [tmpdir(), realpathSync(tmpdir())];
  return {
    ...real,
    writeText: (path: string, text: string) => {
      if (!roots.some((root) => path.startsWith(root))) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
      }
      return real.writeText(path, text);
    },
  };
});

import { astroReads } from '../cli/astro-rewrite.js';
import { loadConfig } from '../cli/config.js';
import { runRegister } from '../cli/register.js';
import { runCli, type CliIo } from '../cli/main.js';
import { planDocuments, planHtmlRegister } from '../cli/html-host.js';
import { packageRoot } from '../cli/installed.js';
import { fileHash } from '../cli/key-plan.js';
import { Report } from '../cli/report.js';
import { loadTypescript } from '../cli/source-scan.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import { cleanupCliHosts, makeHtmlHost } from '../conformance/cli-host.js';

interface SetupOpts {
  router?: 'app' | 'pages';
  provider?: boolean;
  keys?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  managedSurfaces?: string[];
  emailSurfaces?: string[];
  copyModules?: string[];
  /**
   * The host's own tsconfig. It declares the `@/*` alias by default, because
   * `readPath.import` is `@/lib/content` and `--write` refuses to rewrite host
   * source around a specifier the project declares no mapping for. `null`
   * writes no config file — the refusal's own fixture.
   */
  tsconfig?: Record<string, unknown> | null;
  readPathImport?: string;
  /** Where the read path sits — the guard resolves the specifier ONTO this file. */
  readPathFile?: string;
  /** The root layout's text, in place of the one-line `<html><body>{children}</body></html>` layout. */
  layout?: string;
}
function project(opts: SetupOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-register-'));
  const router = opts.router ?? 'app';
  const tsconfig =
    opts.tsconfig === undefined ? { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } } : opts.tsconfig;
  if (tsconfig !== null) write(dir, 'tsconfig.json', JSON.stringify(tsconfig, null, 2));
  write(
    dir,
    'stet.config.json',
    JSON.stringify({
      project: 't',
      managedSurfaces: opts.managedSurfaces ?? [`${router}/**/*.tsx`],
      emailSurfaces: opts.emailSurfaces ?? [],
      copyModules: opts.copyModules ?? [],
      readPath: {
        file: opts.readPathFile ?? 'lib/content.ts',
        import: opts.readPathImport ?? '@/lib/content',
      },
      router,
      rootLayout: `${router}/layout.tsx`,
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
    }),
  );
  write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: opts.keys ?? {} }));
  write(dir, 'content/defaults.json', JSON.stringify({ default: opts.defaults ?? {} }));
  const providerImport = opts.provider ? "import { CopyProvider } from '@getstet/stet/react';\n" : '';
  write(
    dir,
    `${router}/layout.tsx`,
    opts.layout ??
      `${providerImport}export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n`,
  );
  return dir;
}

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8');
const descriptor = (dir: string): { keys: Record<string, unknown> } => JSON.parse(read(dir, 'content/descriptor.json'));
const defaults = (dir: string): { default: Record<string, unknown> } => JSON.parse(read(dir, 'content/defaults.json'));

interface Captured extends CliIo {
  out: string[];
  err: string[];
}
function io(dir: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), out, err };
}

/** A root layout with no `<body>` and `{children}` twice: the mount cannot be located. */
const UNLOCATABLE_LAYOUT =
  'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
  '  return <>{children}<aside>{children}</aside></>;\n' +
  '}\n';
const SERVER_PAGE = (body: string): string => `export default function Page() {\n  return ${body};\n}\n`;
const CLIENT_WIDGET = (body: string): string => `'use client';\nexport default function Widget() {\n  return ${body};\n}\n`;

describe('runRegister — descriptor and default', () => {
  it('without --write prints a diff and writes nothing: no entry, no default, no source edit', async () => {
    const dir = project();
    const before = SERVER_PAGE('<h1>Adopt me now</h1>');
    write(dir, 'app/page.tsx', before);
    const forms = [read(dir, 'content/descriptor.json'), read(dir, 'content/defaults.json')];
    const cap = io(dir);
    const code = await runRegister(['--from', 'scan'], cap);
    expect(code).toBe(0);
    expect([read(dir, 'content/descriptor.json'), read(dir, 'content/defaults.json')]).toEqual(forms);
    expect(cap.out.join('\n')).toContain('+++ b/app/page.tsx'); // a diff was shown
    expect(cap.out.at(-1)).toBe('register: run with --write to add 1 key and apply the leaf edits');
    expect(read(dir, 'app/page.tsx')).toBe(before); // source untouched
  });

  it('--write applies the leaf rewrite and inserts the server read-path import', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Server copy</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const edited = read(dir, 'app/page.tsx');
    expect(edited).toContain("import { copy } from '@/lib/content'");
    expect(edited).toContain("{copy('home_page_headline')}");
  });
  it('--write writes content/resolved.ts in its batch, the new key resolved (D8)', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Resolved here</h1>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'content/resolved.ts')).toContain('"home_page_headline": "Resolved here"');
  });
});

describe('runRegister — batching and collisions', () => {
  it('two literals in one client file get ONE import and ONE const copy', async () => {
    const dir = project({ provider: true });
    write(dir, 'app/widget.tsx', CLIENT_WIDGET('<div><h1>First copy</h1><p>Second copy</p></div>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const edited = read(dir, 'app/widget.tsx');
    expect(edited.match(/import \{ useCopy \} from '@getstet\/stet\/react'/g)?.length).toBe(1);
    expect(edited.match(/const copy = useCopy\(\)/g)?.length).toBe(1);
    expect(edited).toContain("{copy('widget_headline')}");
    expect(edited).toContain("{copy('widget_paragraph')}");
  });

  it('a taken role name continues at _2', async () => {
    const dir = project({
      keys: { home_page_headline: { shape: 'text', target: 'web' } },
      defaults: { home_page_headline: 'existing' },
    });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Your week</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(descriptor(dir).keys['home_page_headline_2']).toBeDefined();
    expect(read(dir, 'app/page.tsx')).toContain("{copy('home_page_headline_2')}");
  });

  it('never alters an existing published value', async () => {
    const dir = project({ keys: { hero_headline: { shape: 'text', target: 'web' } }, defaults: { hero_headline: 'Live headline' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Brand new copy</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(descriptor(dir).keys['hero_headline']).toEqual({ shape: 'text', target: 'web' });
    expect(defaults(dir).default['hero_headline']).toBe('Live headline');
    expect(descriptor(dir).keys['home_page_headline']).toBeDefined();
  });

  it('is idempotent — a re-scan after --write finds zero literals', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Once only</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(cap.out.join('\n')).toContain('nothing to adopt');
    // only one key exists — the second run added none
    expect(Object.keys(descriptor(dir).keys)).toEqual(['home_page_headline']);
  });
});

describe('runRegister — the server/client choice and refusals', () => {
  it('a Pages-Router file is client (needs a provider)', async () => {
    const dir = project({ router: 'pages', provider: true });
    write(dir, 'pages/index.tsx', SERVER_PAGE('<h1>Pages copy</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(read(dir, 'pages/index.tsx')).toContain("import { useCopy } from '@getstet/stet/react'");
  });

  it('an un-directived App-Router non-route file is ambiguous — skipped without --kind, adopted with it', async () => {
    const dir = project();
    write(dir, 'app/widget.tsx', SERVER_PAGE('<h1>Ambiguous copy</h1>'));
    const skip = io(dir);
    await runRegister(['--from', 'scan'], skip);
    expect(skip.err.join('\n')).toContain('ambiguous');
    expect(descriptor(dir).keys['page_headline']).toBeUndefined();

    const dir2 = project();
    write(dir2, 'app/widget.tsx', SERVER_PAGE('<h1>Ambiguous copy</h1>'));
    await runRegister(['--from', 'scan', '--write', '--kind', 'server'], io(dir2));
    expect(read(dir2, 'app/widget.tsx')).toContain("{copy('page_headline')}");
  });

  it('a client rewrite where the CopyProvider mount cannot be located is skipped with the by-hand message', async () => {
    const dir = project({ layout: UNLOCATABLE_LAYOUT });
    write(dir, 'app/widget.tsx', CLIENT_WIDGET('<h1>Needs provider</h1>'));
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(descriptor(dir).keys['widget_headline']).toBeUndefined();
    expect(cap.err.join('\n')).toContain(
      'app/widget.tsx: "widget_headline" needs a client rewrite, but the CopyProvider mount could not be located in app/layout.tsx — mount it by hand, then run stet register again',
    );
    expect(read(dir, 'app/widget.tsx')).not.toContain('useCopy');
  });

  it('a literal whose scope binds a foreign copy is reported and skipped', async () => {
    const dir = project({ provider: true });
    write(
      dir,
      'app/widget.tsx',
      "'use client';\nimport copy from 'copy-to-clipboard';\nexport default function Widget() {\n  return <button onClick={() => copy('x')}><h1>Press me</h1></button>;\n}\n",
    );
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(descriptor(dir).keys['widget_headline']).toBeUndefined();
    expect(cap.err.join('\n')).toContain('foreign');
  });
});

/** A Next root layout rendering a client `Nav` beside `{children}` (the A2 scenario). */
const NAV_LAYOUT =
  "import { Nav } from '../components/Nav';\n" +
  '\n' +
  'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
  '  return (\n' +
  '    <html lang="en">\n' +
  '      <body className="antialiased">\n' +
  '        <Nav />\n' +
  '        {children}\n' +
  '      </body>\n' +
  '    </html>\n' +
  '  );\n' +
  '}\n';
const NAV = "'use client';\nexport function Nav() {\n  return <nav><a href=\"/about\">About the studio</a></nav>;\n}\n";
/** The `resolved` form's block from `app/layout.tsx`, in a TypeScript layout. */
const RESOLVED_BLOCK =
  "import { CopyProvider } from '@getstet/stet/react';\n" +
  "import type { Descriptor } from '@getstet/stet';\n" +
  "import descriptorJson from '../content/descriptor.json';\n" +
  "import { RESOLVED } from '../content/resolved';";
const OPEN = '<CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={RESOLVED}>';

/**
 * The layout rendered on the server, its imports loaded from the temp host:
 * each `.tsx`/`.ts` transpiled to CommonJS, JSON read as data, and
 * `@getstet/stet/react` the package's own provider.
 */
async function renderLayout(dir: string, layoutRel: string): Promise<string> {
  const ts = (await import('typescript')).default;
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { createElement } = req('react') as typeof import('react');
  const { renderToString } = req('react-dom/server') as typeof import('react-dom/server');
  // By a path tsc does not follow: the provider is `.tsx`, which the tests' compile has no JSX setting for.
  const reactLayer = '../react/index.js';
  const stetReact: unknown = await import(/* @vite-ignore */ reactLayer);
  const cache = new Map<string, unknown>();
  const resolveFile = (from: string, spec: string): string => {
    const base = join(from, spec);
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    throw new Error(`unresolved ${spec} from ${from}`);
  };
  const load = (abs: string): unknown => {
    if (cache.has(abs)) return cache.get(abs);
    if (abs.endsWith('.json')) {
      const data: unknown = JSON.parse(readFileSync(abs, 'utf8'));
      cache.set(abs, data);
      return data;
    }
    const code = ts.transpileModule(readFileSync(abs, 'utf8'), {
      fileName: abs,
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} as Record<string, unknown> };
    cache.set(abs, mod.exports);
    const localRequire = (spec: string): unknown =>
      spec === '@getstet/stet/react' ? stetReact : spec.startsWith('.') ? load(resolveFile(dirname(abs), spec)) : req(spec);
    new Function('require', 'module', 'exports', code)(localRequire, mod, mod.exports);
    return mod.exports;
  };
  const layout = load(join(dir, layoutRel)) as { default: (props: { children: unknown }) => unknown };
  return renderToString(createElement(layout.default as never, { children: createElement('main', null, 'the page') }));
}

describe('runRegister — the provider mount (P15)', () => {
  const navHost = (layout = NAV_LAYOUT): string => {
    const dir = project({ layout, managedSurfaces: ['app/**/*.tsx', 'components/**/*.tsx'] });
    write(dir, 'components/Nav.tsx', NAV);
    return dir;
  };

  it('mounts over everything inside <body> where the layout renders a client Nav beside {children}, and the layout renders with Nav reading copy (A2)', async () => {
    const dir = navHost();
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'components/Nav.tsx')).toContain("import { useCopy } from '@getstet/stet/react';");
    expect(read(dir, 'app/layout.tsx')).toBe(
      NAV_LAYOUT.replace("'../components/Nav';\n", `'../components/Nav';\n${RESOLVED_BLOCK}\n\n`)
        .replace('<body className="antialiased">', `<body className="antialiased">${OPEN}`)
        .replace('        {children}\n      </body>', '        {children}\n      </CopyProvider></body>'),
    );
    const out = cap.out.join('\n');
    expect(out).toContain('app/layout.tsx: the one edit to existing code — mount the CopyProvider:');
    expect(out.indexOf('mount the CopyProvider:')).toBeLessThan(out.indexOf('--- a/app/layout.tsx'));
    expect(out).toMatch(/^app\/layout\.tsx: mounted CopyProvider$/m);
    expect(existsSync(join(dir, 'content/resolved.ts'))).toBe(true);
    expect(await runCli(['check'], io(dir))).toBe(0);
    const html = await renderLayout(dir, 'app/layout.tsx');
    expect(html).toContain('About the studio');
    expect(html).toContain('the page');
  });

  it('wraps the sole {children} where the layout has two <body> elements', async () => {
    const layout =
      'export default function RootLayout({ children, ok }: { children: React.ReactNode; ok: boolean }) {\n' +
      '  return ok ? <html><body>{children}</body></html> : <html><body><main /></body></html>;\n' +
      '}\n';
    const dir = navHost(layout);
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/layout.tsx')).toBe(
      `${RESOLVED_BLOCK}\n\n` + layout.replace('<body>{children}</body>', `<body>${OPEN}{children}</CopyProvider></body>`),
    );
  });

  it('applies with no io.confirm, and never calls one that is present', async () => {
    const dir = navHost();
    const confirm = vi.fn(async () => false);
    expect(await runRegister(['--from', 'scan', '--write'], { ...io(dir), confirm })).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(read(dir, 'app/layout.tsx')).toContain(OPEN);
  });

  it('a second run mounts nothing, and its new client literal adopts with no warn', async () => {
    const dir = navHost();
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const mounted = read(dir, 'app/layout.tsx');
    write(dir, 'components/Footer.tsx', "'use client';\nexport function Footer() {\n  return <footer><p>Made in Lisbon</p></footer>;\n}\n");
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'app/layout.tsx')).toBe(mounted);
    expect(read(dir, 'components/Footer.tsx')).toContain('useCopy()');
    expect(cap.out.join('\n')).not.toContain('CopyProvider');
    expect(cap.err.join('\n')).not.toContain('CopyProvider');
  });

  it('an unlocatable layout adopts no client literal, adopts the server ones with no gap, leaves the layout and prints the snippet', async () => {
    const dir = project({ layout: UNLOCATABLE_LAYOUT });
    write(dir, 'app/components/Cta.tsx', CLIENT_WIDGET('<a href="#contact">Book a call</a>'));
    write(dir, 'app/page.tsx', SERVER_PAGE('<main><h1>Your data, sorted</h1><p>Every week</p></main>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'app/layout.tsx')).toBe(UNLOCATABLE_LAYOUT);
    expect(read(dir, 'app/components/Cta.tsx')).not.toContain('useCopy');
    expect(cap.err.join('\n')).toContain('app/components/Cta.tsx: "');
    expect(cap.err.join('\n')).toContain('needs a client rewrite, but the CopyProvider mount could not be located in app/layout.tsx');
    expect(Object.keys(descriptor(dir).keys).sort()).toEqual(['home_page_headline', 'home_page_paragraph']);
    const out = cap.out.join('\n');
    expect(out).toContain('app/layout.tsx: could not locate the wrap point unambiguously — mount the CopyProvider by hand:');
    expect(out).toContain('  wrap everything inside <body> in:');
    expect(out).toContain(`  ${OPEN}…</CopyProvider>`);
    expect(out).not.toContain('mounted CopyProvider');
  });

  it('wraps <Component /> on a Pages Router _app, in the resolved form', async () => {
    const app =
      "import type { AppProps } from 'next/app';\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />;\n}\n";
    const dir = project({ router: 'pages', layout: app });
    write(dir, 'pages/index.tsx', SERVER_PAGE('<h1>Pages copy</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(read(dir, 'pages/layout.tsx')).toBe(
      app
        .replace("'next/app';\n", `'next/app';\n${RESOLVED_BLOCK}\n\n`)
        .replace('<Component {...pageProps} />', `${OPEN}<Component {...pageProps} /></CopyProvider>`),
    );
  });

  it('writes the layout in its own line endings (CRLF)', async () => {
    const crlf = NAV_LAYOUT.replace(/\n/g, '\r\n');
    const dir = navHost(crlf);
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const layout = read(dir, 'app/layout.tsx');
    expect(layout).toContain(RESOLVED_BLOCK.replace(/\n/g, '\r\n'));
    expect(layout).toContain(OPEN);
    expect(layout).not.toMatch(/(?<!\r)\n/);
  });

  it('writes a JS layout no TypeScript syntax', async () => {
    const dir = project({ managedSurfaces: ['app/**/*.jsx', 'components/**/*.jsx'] });
    const config = JSON.parse(read(dir, 'stet.config.json')) as Record<string, unknown>;
    write(dir, 'stet.config.json', JSON.stringify({ ...config, rootLayout: 'app/layout.jsx' }));
    write(dir, 'app/layout.jsx', 'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n');
    write(dir, 'components/Nav.jsx', NAV);
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/layout.jsx')).toBe(
      "import { CopyProvider } from '@getstet/stet/react';\nimport descriptorJson from '../content/descriptor.json';\nimport { RESOLVED } from '../content/resolved';\n\n" +
        'export default function RootLayout({ children }) {\n  return <html><body><CopyProvider descriptor={descriptorJson} resolved={RESOLVED}>{children}</CopyProvider></body></html>;\n}\n',
    );
  });

  it('a run with only server-kind literals mounts nothing', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Server only</h1>'));
    const before = read(dir, 'app/layout.tsx');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'app/layout.tsx')).toBe(before);
    expect(cap.out.join('\n')).not.toContain('CopyProvider');
  });

  it('a layout with its own server literal and a client file planned out takes no mount, its diff the leaf edit alone', async () => {
    const layout =
      'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
      '  return <html><body><header>Northwind Studio</header>{children}</body></html>;\n' +
      '}\n';
    const dir = project({ layout });
    write(dir, 'app/widget.tsx', CLIENT_WIDGET('<p>Planned out</p>'));
    expect(await runCli(['register', '--from', 'scan', '--plan-out', 'naming.json'], io(dir))).toBe(0);
    const plan = JSON.parse(read(dir, 'naming.json')) as { keys: Array<Record<string, unknown>> };
    const widget = plan.keys.find((e) => String(e['places']).startsWith('app/widget.tsx')) as Record<string, unknown>;
    widget['adopt'] = false;
    writeFileSync(join(dir, 'naming.json'), JSON.stringify(plan, null, 2));
    const cap = io(dir);
    expect(await runCli(['register', '--from', 'scan', '--plan', 'naming.json', '--write'], cap)).toBe(0);
    const written = read(dir, 'app/layout.tsx');
    expect(written).toContain("{copy('");
    expect(written).not.toContain('CopyProvider');
    expect(cap.out.join('\n')).not.toContain('mount the CopyProvider');
    expect(read(dir, 'app/widget.tsx')).not.toContain('useCopy');
  });

  it('a layout with its own literal takes the mount and its rewrite in one write', async () => {
    const layout = NAV_LAYOUT.replace('        <Nav />\n', '        <Nav />\n        <p>Northwind Studio</p>\n');
    const dir = navHost(layout);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const written = read(dir, 'app/layout.tsx');
    expect(written).toContain(OPEN);
    expect(written).toMatch(/<p>\{copy\('[a-z_]+'\)\}<\/p>/);
    expect(written).toContain("import { copy } from '@/lib/content';");
    expect(cap.out.join('\n')).toMatch(/^app\/layout\.tsx: rewrote \d+ edits$/m);
    expect(cap.out.join('\n').match(/^--- a\/app\/layout\.tsx/gm)).toHaveLength(1);
    expect(await runCli(['check'], io(dir))).toBe(0);
  });

  it('prints the header and the mounted line once where two client files are rewritten', async () => {
    const dir = navHost();
    write(dir, 'components/Footer.tsx', "'use client';\nexport function Footer() {\n  return <footer><p>Made in Lisbon</p></footer>;\n}\n");
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const out = cap.out.join('\n');
    expect(out.match(/the one edit to existing code — mount the CopyProvider:/g)).toHaveLength(1);
    expect(out.match(/^app\/layout\.tsx: mounted CopyProvider$/gm)).toHaveLength(1);
    expect(read(dir, 'app/layout.tsx').match(/<CopyProvider /g)).toHaveLength(1);
  });

  it('prints the could-not-locate line and the snippet once, above the per-file warns', async () => {
    const dir = project({ layout: UNLOCATABLE_LAYOUT });
    write(dir, 'app/components/Cta.tsx', CLIENT_WIDGET('<a href="#contact">Book a call</a>'));
    write(dir, 'app/components/Nav.tsx', CLIENT_WIDGET('<a href="/about">About the studio</a>'));
    const all: string[] = [];
    const sink = (line: string): void => {
      all.push(line);
    };
    expect(await runRegister(['--from', 'scan', '--write'], { cwd: dir, env: {}, stdout: sink, stderr: sink })).toBe(0);
    const text = all.join('\n');
    expect(text.match(/could not locate the wrap point unambiguously/g)).toHaveLength(1);
    expect(text.match(/wrap everything inside <body> in:/g)).toHaveLength(1);
    expect(text.match(/needs a client rewrite, but the CopyProvider mount could not be located in app\/layout\.tsx/g)).toHaveLength(2);
    expect(text.indexOf('wrap everything inside <body> in:')).toBeLessThan(text.indexOf('needs a client rewrite'));
  });

  it('names the root layout in the warn, and prints no snippet, where the config names none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-register-'));
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
    write(dir, 'stet.config.json', JSON.stringify({ project: 't', router: 'vite', managedSurfaces: ['src/**/*.tsx'] }));
    write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
    write(dir, 'content/defaults.json', JSON.stringify({ default: {} }));
    write(dir, 'src/Cta.tsx', CLIENT_WIDGET('<a href="#contact">Book a call</a>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('needs a client rewrite, but the CopyProvider mount could not be located in the root layout — mount it by hand, then run stet register again');
    expect(cap.out.join('\n')).not.toContain('could not locate the wrap point');
    expect(cap.out.join('\n')).not.toContain('CopyProvider descriptor=');
  });

  it("prints the Vite snippet line where the entry's render cannot be located", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-register-'));
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
    write(dir, 'stet.config.json', JSON.stringify({ project: 't', router: 'vite', rootLayout: 'src/main.tsx', managedSurfaces: ['src/**/*.tsx'] }));
    write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
    write(dir, 'content/defaults.json', JSON.stringify({ default: {} }));
    const twice =
      "import { createRoot } from 'react-dom/client';\nimport App from './App';\n\n" +
      "createRoot(document.getElementById('a')!).render(<App />);\ncreateRoot(document.getElementById('b')!).render(<App />);\n";
    write(dir, 'src/main.tsx', twice);
    write(dir, 'src/App.tsx', CLIENT_WIDGET('<a href="#contact">Book a call</a>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'src/main.tsx')).toBe(twice);
    const out = cap.out.join('\n');
    expect(out).toContain('src/main.tsx: could not locate the wrap point unambiguously — mount the CopyProvider by hand:');
    expect(out).toContain('  wrap the element createRoot(...).render() receives in:');
  });

  it('mounts <CopyProvider …></CopyProvider> into an empty <body></body>', async () => {
    const layout = 'export default function RootLayout() {\n  return <html><body></body></html>;\n}\n';
    const dir = navHost(layout);
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(read(dir, 'app/layout.tsx')).toBe(`${RESOLVED_BLOCK}\n\n` + layout.replace('<body></body>', `<body>${OPEN}</CopyProvider></body>`));
  });

  it("lands a literal starting right after <body>, and one ending right before </body>, inside the provider", async () => {
    const layout =
      'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
      '  return <html><body>Northwind Studio<Nav />{children}Made in Lisbon</body></html>;\n' +
      '}\n';
    const dir = navHost(`import { Nav } from '../components/Nav';\n\n${layout}`);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const written = read(dir, 'app/layout.tsx');
    expect(written).toMatch(/<body><CopyProvider [^>]+>\{copy\('[a-z0-9_]+'\)\}<Nav \/>\{children\}\{copy\('[a-z0-9_]+'\)\}<\/CopyProvider><\/body>/);
    expect(await runCli(['check'], io(dir))).toBe(0);
  });

  it('scan over the same host plans no mount and writes nothing', async () => {
    const dir = navHost();
    const before = tree(dir);
    const cap = io(dir);
    await runCli(['scan'], cap);
    expect(tree(dir)).toEqual(before);
    expect(cap.out.join('\n')).not.toContain('mount the CopyProvider');
  });
});

describe('runRegister — the Vite arm (D9)', () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vite-host');
  const viteHost = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-register-vite-'));
    cpSync(FIXTURE, dir, { recursive: true });
    expect(await runCli(['init', '--yes'], io(dir))).toBe(0);
    return dir;
  };

  it('rewrites every literal to useCopy(), mounts over the render argument, and the entry type-checks', async () => {
    const dir = await viteHost();
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const app = read(dir, 'src/App.tsx');
    expect(app).toContain("import { useCopy } from '@getstet/stet/react';");
    expect(app).not.toContain('<h1>Get started</h1>');
    expect(app).not.toContain("'@/lib/content'");
    expect(cap.err.join('\n')).not.toContain('needs a client rewrite');
    const main = read(dir, 'src/main.tsx');
    expect(main).toContain("import { RESOLVED } from '../content/resolved';");
    expect(main).toContain('.render(\n  <CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={RESOLVED}><StrictMode>');
    expect(main).toContain('</StrictMode></CopyProvider>,\n)');
    expect(cap.out).toContain('src/main.tsx: mounted CopyProvider');

    // tsc over the entry and the app, `@getstet/stet` resolved to the built package.
    if (!existsSync(join(packageRoot(), 'dist', 'src', 'index.js'))) execFileSync('npm', ['run', 'build'], { cwd: packageRoot(), stdio: 'pipe' });
    symlinkSync(join(packageRoot(), '..', 'node_modules'), join(dir, 'node_modules'), 'dir');
    write(dir, 'src/assets.d.ts', "declare module '*.png' { const src: string; export default src; }\ndeclare module '*.svg' { const src: string; export default src; }\ndeclare module '*.css';\n");
    write(
      dir,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          resolveJsonModule: true,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src'],
      }),
    );
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    let output = '';
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? error);
    }
    expect(output).toBe('');
  }, 60_000);

  it('adopts no literal where main.tsx renders twice, or passes render a second argument', async () => {
    for (const main of [
      "import { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('a')!).render(<App />)\ncreateRoot(document.getElementById('b')!).render(<App />)\n",
      "import { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(<App />, document.body)\n",
    ]) {
      const dir = await viteHost();
      write(dir, 'src/main.tsx', main);
      const before = read(dir, 'src/App.tsx');
      const cap = io(dir);
      expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
      expect(read(dir, 'src/main.tsx')).toBe(main);
      expect(read(dir, 'src/App.tsx')).toBe(before);
      expect(cap.err.join('\n')).toContain('needs a client rewrite, but the CopyProvider mount could not be located in src/main.tsx');
    }
  });
});

describe('runRegister — the CP6 fold', () => {
  it('a .ts email mailer adopts as server WITHOUT --kind, and its target is EMAIL_TARGET', async () => {
    const dir = project({ managedSurfaces: ['lib/email/**/*.ts'], emailSurfaces: ['lib/email/**/*.ts'] });
    write(
      dir,
      'lib/email/welcome.ts',
      "import { send } from './mailer';\nexport function welcome() {\n  return send({ subject: 'Welcome aboard now', to: 'a@b.co' });\n}\n",
    );
    const cap = io(dir);
    const code = await runRegister(['--from', 'scan', '--write'], cap);
    expect(code).toBe(0);
    // a non-JSX file is unambiguously server — no ambiguity message, no --kind needed
    expect(cap.err.join('\n')).not.toContain('ambiguous');
    expect(descriptor(dir).keys['welcome_aboard_now']).toEqual({ shape: 'text', target: 'html-email' });
    const edited = read(dir, 'lib/email/welcome.ts');
    expect(edited).toContain("copy('welcome_aboard_now')");
    expect(edited).toContain("import { copy } from '@/lib/content'");
  });

  it('a .ts mailer on a Pages host still adopts as server with EMAIL_TARGET', async () => {
    const dir = project({ router: 'pages', managedSurfaces: ['lib/email/**/*.ts'], emailSurfaces: ['lib/email/**/*.ts'] });
    write(
      dir,
      'lib/email/welcome.ts',
      "import { send } from './mailer';\nexport function welcome() {\n  return send({ subject: 'Pages mailer copy', to: 'a@b.co' });\n}\n",
    );
    const cap = io(dir);
    const code = await runRegister(['--from', 'scan', '--write'], cap);
    expect(code).toBe(0);
    // non-JSX is server on ANY router — no provider needed, EMAIL_TARGET reached
    expect(cap.err.join('\n')).not.toContain('provider');
    expect(descriptor(dir).keys['pages_mailer_copy']).toEqual({ shape: 'text', target: 'html-email' });
    expect(read(dir, 'lib/email/welcome.ts')).toContain("copy('pages_mailer_copy')");
  });

  it('regenerates all three codegen modules when a key is added', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Fresh key here</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(read(dir, 'content/stet-env.d.ts')).toContain('home_page_headline');
    expect(read(dir, 'content/keys.ts')).toContain('home_page_headline');
    expect(read(dir, 'content/defaults.ts')).toContain('home_page_headline');
  });
});

/**
 * `init` records `readPath.import` from a probe that may have found no alias
 * and defaulted to `@/lib/content`. Applying a rewrite around a specifier the
 * host maps nowhere breaks every file it touched, silently, at the next build —
 * so `--write` verifies the mapping before it touches anything.
 */
describe('runRegister — the read-path import must resolve before --write', () => {
  /** Every file of the host, so "nothing was touched" is a content compare. */
  function snapshotDir(dir: string): Map<string, Buffer> {
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

  it('refuses --write with NO file touched when the host declares no alias at all', async () => {
    const dir = project({ tsconfig: null });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Unresolvable copy</h1>'));
    const before = snapshotDir(dir);

    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(
      /readPath\.import is '@\/lib\/content'/,
    );

    // The descriptor and snapshot writes run in BOTH modes, so "nothing was
    // touched" has to be the whole host, byte for byte — not just the leaf.
    const after = snapshotDir(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, bytes] of after) expect(bytes.equals(before.get(rel) as Buffer), rel).toBe(true);
  });

  it('names both remedies and the extends limit', async () => {
    const dir = project({ tsconfig: null });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Named remedies</h1>'));
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(
      /Declare the alias in the project file, or edit readPath\.import in stet\.config\.json/,
    );
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(/extends not followed/);
  });

  it('refuses a host whose declared mapping does not cover the specifier', async () => {
    // The truthiness trap: this host DOES declare paths, just not one that
    // covers `@/lib/content`.
    const dir = project({ tsconfig: { compilerOptions: { paths: { '~/*': ['./*'] } } } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Wrong prefix</h1>'));
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(
      /no tsconfig\/jsconfig path mapping in this project resolves it to lib\/content\.ts/,
    );
  });

  it('refuses a mapping that matches the PREFIX but lands somewhere else', async () => {
    // The `@/*` alias is declared and the specifier matches its prefix — but
    // it resolves to `src/lib/content`, and the read path is at `lib/content`.
    // A prefix test passes this host and the applied rewrite fails TS2307 in
    // every file it touched; coverage has to mean resolution onto the module.
    const dir = project({ tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Prefix but elsewhere</h1>'));
    const before = read(dir, 'app/page.tsx');
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(
      /no tsconfig\/jsconfig path mapping in this project resolves it to lib\/content\.ts/,
    );
    expect(read(dir, 'app/page.tsx')).toBe(before);

    // Move the read path under `src/` and the SAME mapping now resolves onto
    // it, so the write proceeds — the rule is resolution, not the prefix.
    const matched = project({
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
      readPathFile: 'src/lib/content.ts',
    });
    write(matched, 'app/page.tsx', SERVER_PAGE('<h1>Resolved onto it</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(matched))).toBe(0);
    expect(read(matched, 'app/page.tsx')).toContain("{copy('home_page_headline')}");
  });

  it('resolves a `~*` pattern, whose `*` carries no slash of its own', async () => {
    // `"~*": ["./src/*"]` is legal tsconfig — the `*` sits straight after the
    // sigil — and tsc matches `~/lib/content` through it, substituting
    // `/lib/content`. A rule that only understood a trailing `/*` skipped the
    // entry and refused a host that resolves perfectly well.
    const covered = project({
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '~*': ['./src/*'] } } },
      readPathImport: '~/lib/content',
      readPathFile: 'src/lib/content.ts',
    });
    write(covered, 'app/page.tsx', SERVER_PAGE('<h1>Tilde covered</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(covered))).toBe(0);
    expect(read(covered, 'app/page.tsx')).toContain("{copy('home_page_headline')}");

    // The same mapping with the read path left under `lib/` lands in `src/lib/`
    // instead: declared, matching, and still not covering.
    const missed = project({
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '~*': ['./src/*'] } } },
      readPathImport: '~/lib/content',
    });
    write(missed, 'app/page.tsx', SERVER_PAGE('<h1>Tilde missed</h1>'));
    await expect(runRegister(['--from', 'scan', '--write'], io(missed))).rejects.toThrow(
      /no tsconfig\/jsconfig path mapping in this project resolves it to lib\/content\.ts/,
    );
  });

  it('refuses where the LONGEST pattern lands elsewhere, though a shorter one covers', async () => {
    // The monorepo shape: `@/*` to `src/`, with `@/lib/*` carved back out to
    // `lib/`. tsc resolves `@/lib/content` through the LONGER pattern and only
    // that one, so a read path at `src/lib/content.ts` is unreachable and the
    // rewrite would fail TS2307 in every file it touched. Reading every
    // matching pattern instead lets `@/*` vouch for a host tsc rejects.
    const shadowed = project({
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'], '@/lib/*': ['./lib/*'] } } },
      readPathFile: 'src/lib/content.ts',
    });
    write(shadowed, 'app/page.tsx', SERVER_PAGE('<h1>Shadowed by the longer</h1>'));
    const before = read(shadowed, 'app/page.tsx');
    await expect(runRegister(['--from', 'scan', '--write'], io(shadowed))).rejects.toThrow(
      /no tsconfig\/jsconfig path mapping in this project resolves it to src\/lib\/content\.ts/,
    );
    expect(read(shadowed, 'app/page.tsx')).toBe(before);

    // The same tsconfig covers a read path sitting where the longer pattern
    // actually points.
    const matched = project({
      tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'], '@/lib/*': ['./lib/*'] } } },
    });
    write(matched, 'app/page.tsx', SERVER_PAGE('<h1>Carved out</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(matched))).toBe(0);
    expect(read(matched, 'app/page.tsx')).toContain("{copy('home_page_headline')}");
  });

  it('refuses an extends-only host, which is the Astro shape', async () => {
    const dir = project({ tsconfig: { extends: 'astro/tsconfigs/base' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Extended only</h1>'));
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(/extends not followed/);
  });

  it('proceeds where a mapping covers the specifier — by prefix, or by an exact key', async () => {
    const prefixed = project({ tsconfig: { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } } });
    write(prefixed, 'app/page.tsx', SERVER_PAGE('<h1>Prefix covered</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(prefixed))).toBe(0);
    expect(read(prefixed, 'app/page.tsx')).toContain("{copy('home_page_headline')}");

    // An exact-key mapping is legal tsconfig that the `/*`-only grammar of
    // init's own probe never emits, and it covers by equality.
    const exact = project({ tsconfig: { compilerOptions: { paths: { '@/lib/content': ['./lib/content.ts'] } } } });
    write(exact, 'app/page.tsx', SERVER_PAGE('<h1>Exactly covered</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(exact))).toBe(0);
    expect(read(exact, 'app/page.tsx')).toContain("{copy('home_page_headline')}");
  });

  it('leaves relative and bare specifiers alone — there is no alias to declare', async () => {
    const relative = project({ tsconfig: null, readPathImport: './lib/content' });
    write(relative, 'app/page.tsx', SERVER_PAGE('<h1>Relative import</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(relative))).toBe(0);

    // `@scope/pkg` starts with `@` and is not alias-shaped — an npm name.
    const scoped = project({ tsconfig: null, readPathImport: '@acme/content' });
    write(scoped, 'app/page.tsx', SERVER_PAGE('<h1>Scoped package</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(scoped))).toBe(0);
  });

  it('still prints the diff without --write on the very host it would refuse', async () => {
    const dir = project({ tsconfig: null });
    const before = SERVER_PAGE('<h1>Printed anyway</h1>');
    write(dir, 'app/page.tsx', before);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('+++ b/app/page.tsx');
    expect(read(dir, 'app/page.tsx')).toBe(before);
  });
});

/**
 * The declared copy modules — adopted as RECORD. No component kind, no provider
 * check, no import, no rewrite: the module keeps its literals, and byte-equality
 * against the snapshot is what the drift gate then watches.
 */
describe('runRegister — declared copy modules', () => {
  it('adopts a property under its OWN name, never a suffixed one', async () => {
    const dir = project({ copyModules: ['src/copy.ts'] });
    write(dir, 'src/copy.ts', 'export const copy = {\n  hero_headline: "Change the content",\n};\n');
    const before = read(dir, 'src/copy.ts');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(descriptor(dir).keys['hero_headline']).toEqual({ shape: 'text', target: 'web' });
    expect(defaults(dir).default['hero_headline']).toBe('Change the content');
    // A suffixed module key forks the registry from the module it was read out
    // of, so a module shape is never numbered.
    expect(descriptor(dir).keys['hero_headline_2']).toBeUndefined();
    // Record only: one line, no diff, and the module untouched.
    expect(cap.out.join('\n')).toContain('adopted hero_headline = Change the content');
    expect(cap.out.join('\n')).not.toContain('+++ b/src/copy.ts');
    expect(read(dir, 'src/copy.ts')).toBe(before);
  });

  it('takes the EMAIL target for a module declared into the email surfaces', async () => {
    // Target rides the same surface-membership rule a stray literal's does, so
    // an email copy module's keys land with email validation rules.
    const dir = project({
      copyModules: ['lib/email/strings.ts'],
      emailSurfaces: ['lib/email/**/*.ts'],
    });
    write(dir, 'lib/email/strings.ts', 'export const strings = {\n  welcome_subject: "Welcome aboard",\n};\n');
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(descriptor(dir).keys['welcome_subject']).toEqual({ shape: 'text', target: 'html-email' });
  });

  it('reports a derived-key collision the run itself authored', async () => {
    // Two plain literals whose derived keys collide: the first adopts
    // `sign_in`, and the second then classifies against the descriptor the same
    // run just wrote — so it reports as a divergence THIS run authored rather
    // than one the host did. Accepted as-is: the alternative is a suffixed key,
    // which is the fork the own-name rule exists to prevent, and the site's 77
    // keys are all distinct property names. A `property` finding cannot hit it
    // at all — those key off the name, never the text.
    const dir = project({ copyModules: ['src/copy.ts'] });
    write(dir, 'src/copy.ts', 'export const a = "Sign in!";\nexport const b = "Sign in?";\n');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    // The first wins the key; the second is reported and never adopted over it.
    expect(defaults(dir).default['sign_in']).toBe('Sign in!');
    expect(descriptor(dir).keys['sign_in_2']).toBeUndefined();
    expect(cap.err.join('\n')).toContain('sign_in diverged from the snapshot default');
  });

  it('adopts a JSX leaf and a module property in ONE run, through one write block', async () => {
    // The two-loop integration point. The site redo cannot cover it — its pages
    // are `.astro`, so nothing there feeds the JSX loop — which leaves this the
    // only place the halves are proven to compose.
    const dir = project({ copyModules: ['src/copy.ts'] });
    const page = SERVER_PAGE('<h1>Adopt this leaf</h1>');
    write(dir, 'app/page.tsx', page);
    write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
    const forms = read(dir, 'content/descriptor.json');
    const plain = io(dir);
    expect(await runRegister(['--from', 'scan'], plain)).toBe(0);
    // A diff for the leaf, an `adopts` line for the property — each half
    // reports in its own register — and nothing written without --write.
    expect(plain.out.join('\n')).toContain('+++ b/app/page.tsx');
    expect(plain.out.join('\n')).toContain('adopts footer_note = A working name');
    expect(plain.out.at(-1)).toBe('register: run with --write to add 2 keys and apply the leaf edits');
    expect(read(dir, 'content/descriptor.json')).toBe(forms);
    expect(read(dir, 'app/page.tsx')).toBe(page);

    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    // Both halves landed: the leaf's derived key and the module's own name.
    expect(descriptor(dir).keys['home_page_headline']).toBeDefined();
    expect(descriptor(dir).keys['footer_note']).toBeDefined();
    const out = cap.out.join('\n');
    expect(out).toContain('adopted footer_note = A working name');
    expect(out).not.toContain('+++ b/src/copy.ts');
    // `added` SUMS both loops and the shared write block runs exactly once, so
    // the codegen is written once rather than per loop.
    expect(out).toContain('and the codegen modules: 2 keys added');
    expect(cap.out.filter((l) => l.includes('and the codegen modules'))).toHaveLength(1);
    expect(cap.out.at(-1)).toBe('register: applied');
    expect(read(dir, 'src/copy.ts')).toContain('footer_note: "A working name"');
  });

  it('honours an ignore comment on a dual-declared file the SAME run rewrites', async () => {
    // The handoff carries the tree parsed BEFORE the surface loop applied its
    // leaf edit, so every offset in it indexes that tree — not the file now on
    // disk. Reading the caller's text against those offsets slid the ignore
    // comment out of view and adopted the very key it opted out, with a `raw`
    // sliced from the wrong bytes.
    const dir = project({ managedSurfaces: ['app/**/*.tsx'], copyModules: ['app/**/*.tsx'] });
    write(
      dir,
      'app/page.tsx',
      'export default function Page() {\n' +
        '  // stet-ignore-next-line\n' +
        '  const secret_key = "Do not adopt this";\n' +
        '  return <h1>Adopt this leaf</h1>;\n' +
        '}\n',
    );
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    // The leaf WAS rewritten, so the offsets really did move…
    expect(read(dir, 'app/page.tsx')).toContain("copy('home_page_headline')");
    // …and the opted-out literal is still opted out.
    expect(descriptor(dir).keys['secret_key']).toBeUndefined();
    expect(descriptor(dir).keys['do_not_adopt_this']).toBeUndefined();
    expect(defaults(dir).default['secret_key']).toBeUndefined();
  });

  it('adds nothing on a second run, and never rewrites the module', async () => {
    const dir = project({ copyModules: ['src/copy.ts'] });
    write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
    const before = read(dir, 'src/copy.ts');
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const after = read(dir, 'content/descriptor.json');

    const second = io(dir);
    expect(await runRegister(['--from', 'scan'], second)).toBe(0);
    expect(second.out.join('\n')).toContain('register: nothing to adopt');
    expect(read(dir, 'content/descriptor.json')).toBe(after);
    // A module shape has no source edit, on either run.
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(read(dir, 'src/copy.ts')).toBe(before);
  });
});

/**
 * The same wall eject grew, in register's step-7 output. Fixing one command's
 * noise while its sibling prints the identical block is half a fix, so the two
 * share the one helper and the one threshold.
 */
describe('runRegister — the parse-refusal wall', () => {
  // A broken `.tsx`: a template dialect is named apart and never reaches the parser (F46).
  const REFUSED = 'export default function P() {\n  return <h1>Chapter</h1\n}\n';

  /**
   * `copyModules` is empty by construction, so the module loop never runs and
   * the count is the surface loop's own — the two loops share ONE collection,
   * and this pins which one filled it.
   */
  function refusingHost(count: number): string {
    const dir = project({ managedSurfaces: ['src/**/*.tsx'], copyModules: [] });
    for (let i = 0; i < count; i++) write(dir, `src/pages/p${i}.tsx`, REFUSED);
    return dir;
  }

  it('collapses five refusals to one count line', async () => {
    const dir = refusingHost(5);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    const counts = cap.out.filter((l) => l.includes('run with --verbose to list them'));
    expect(counts).toEqual([
      '5 file(s) could not be parsed cleanly — reported, not adopted; run with --verbose to list them',
    ]);
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.tsx: could not be parsed/.test(l))).toEqual([]);
    // Below the adopted lines and above nothing else it displaced.
    expect(cap.out.join('\n')).toContain('register: nothing to adopt');
  });

  it('--verbose restores every per-file line', async () => {
    const dir = refusingHost(5);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--verbose'], cap)).toBe(0);
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.tsx: could not be parsed/.test(l))).toHaveLength(5);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('prints two refusals as before', async () => {
    const dir = refusingHost(2);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.tsx: could not be parsed/.test(l))).toHaveLength(2);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('prints the count BELOW the adopted-key lines', async () => {
    // The refusals moved from interleaved-in-loop to one block, and the block's
    // position is part of the contract: what the run ACHIEVED reads first, and
    // what it could not read follows. One adoptable module beside four refusals
    // is the smallest host that can tell the two orders apart.
    const dir = project({ managedSurfaces: ['src/**/*.tsx'], copyModules: ['src/copy.ts'] });
    for (let i = 0; i < 4; i++) write(dir, `src/pages/p${i}.tsx`, REFUSED);
    write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');

    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const adopted = cap.out.findIndex((l) => l.startsWith('adopted footer_note'));
    const count = cap.out.findIndex((l) => l.includes('4 file(s) could not be parsed cleanly'));
    expect(adopted).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(adopted);
  });

  it('gathers both loops into one collection, and a dual-declared file refuses once', async () => {
    // The count is per RUN, not per loop. A copy module that is not also a
    // managed surface is refused by the module loop alone and has to reach the
    // same collection — the case above, with an empty `copyModules`, could never
    // see that half.
    const dir = project({ managedSurfaces: ['src/**/*.tsx'], copyModules: ['mod/**/*.tsx'] });
    for (let i = 0; i < 3; i++) write(dir, `src/pages/p${i}.tsx`, REFUSED);
    for (let i = 0; i < 2; i++) write(dir, `mod/m${i}.tsx`, REFUSED);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--verbose'], cap)).toBe(0);
    expect(cap.out.filter((l) => l.includes('could not be parsed cleanly'))).toHaveLength(5);

    // …and collapsed, the count is 5 — one run, one number.
    const collapsed = io(dir);
    expect(await runRegister(['--from', 'scan'], collapsed)).toBe(0);
    expect(collapsed.out.join('\n')).toContain('5 file(s) could not be parsed cleanly');

    // A file BOTH globs match is refused once: the walked map hands the module
    // loop the surface loop's own verdict rather than a second parse.
    const dual = project({ managedSurfaces: ['both/**/*.tsx'], copyModules: ['both/**/*.tsx'] });
    write(dual, 'both/one.tsx', REFUSED);
    const dualCap = io(dual);
    expect(await runRegister(['--from', 'scan'], dualCap)).toBe(0);
    expect(dualCap.out.filter((l) => l.includes('could not be parsed cleanly'))).toEqual([
      'both/one.tsx: could not be parsed cleanly — reported, not adopted',
    ]);
  });
});

describe('runRegister — template-dialect files (F46)', () => {
  /** A Vue host: its whole managed surface is `.vue`, `.svelte` and `.mdx`, which register never rewrites (an `.astro` file has its own rewriter). */
  function dialectHost(count: number): string {
    const dir = project({ managedSurfaces: ['src/**/*.vue', 'src/**/*.svelte', 'src/**/*.mdx'], copyModules: [] });
    write(dir, 'src/pages/index.vue', '<template>\n  <h1>Chapter one</h1>\n</template>\n');
    for (let i = 1; i < count; i++) write(dir, `src/pages/p${i}.${['svelte', 'mdx', 'vue'][i % 3] as string}`, '<h1>Another chapter</h1>\n');
    return dir;
  }

  it('names one .vue page with its hand step, and no parse line', async () => {
    const cap = io(dialectHost(1));
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out).toContain("src/pages/index.vue: .vue is not rewritten — place copy('<key>') by hand");
    expect(cap.out.join('\n')).not.toContain('could not be parsed');
  });

  it('collapses five to one line, and --verbose lists the five', async () => {
    const dir = dialectHost(5);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.filter((l) => l.includes('not rewritten'))).toEqual([
      "5 files are not rewritten (.mdx, .svelte, .vue) — place copy('<key>') by hand; run with --verbose to list them",
    ]);
    const verbose = io(dir);
    expect(await runRegister(['--from', 'scan', '--verbose'], verbose)).toBe(0);
    expect(verbose.out.filter((l) => /^src\/pages\/.*: \.(vue|svelte|mdx) is not rewritten/.test(l))).toHaveLength(5);
  });

  it('still refuses a genuinely broken .tsx with the parse line', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.tsx', 'src/**/*.vue'], copyModules: [] });
    write(dir, 'src/pages/broken.tsx', 'export default function P() {\n  return <h1>Chapter</h1\n}\n');
    write(dir, 'src/pages/index.vue', '<template><h1>Chapter one</h1></template>\n');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out).toContain('src/pages/broken.tsx: could not be parsed cleanly — reported, not adopted');
    expect(cap.out).toContain("src/pages/index.vue: .vue is not rewritten — place copy('<key>') by hand");
  });
});

describe('runRegister — what scan now finds in props and data (D13)', () => {
  it("rewrites a component's prose prop and leaves a structural one (T13.7)", async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<SectionHead sub="One registry holds them all" variant="primary" />'));
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const edited = read(dir, 'app/page.tsx');
    expect(edited).toMatch(/sub=\{copy\('[a-z0-9_]+'\)\}/);
    expect(edited).toContain('variant="primary"');
  });

  it('rewrites the prose prop alone and names the props it leaves (T13.12)', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<Field aria-describedby="hint error" testID="login button" event="Signup started" sub="One registry holds them all" />'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const edited = read(dir, 'app/page.tsx');
    expect(edited).toMatch(/sub=\{copy\('[a-z0-9_]+'\)\}/);
    for (const kept of ['aria-describedby="hint error"', 'testID="login button"', 'event="Signup started"']) expect(edited).toContain(kept);
    const lines = [...cap.out, ...cap.err].filter((l) => l.includes('is a prop stet does not rewrite (aria-*, testid, event) — adopt by hand'));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/app\/page\.tsx: "[a-z0-9_]+" is a prop stet does not rewrite \(aria-\*, testid, event\) — adopt by hand$/);
  });

  it('rewrites aria-label, which is copy, and never a wiring prop', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<Field aria-label="Close dialog here" wrapperClass="flex items-center gap-2" gradient="from-blue-500 to-indigo-600" only="Fast sync here" />'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const edited = read(dir, 'app/page.tsx');
    expect(edited).toMatch(/aria-label=\{copy\('[a-z0-9_]+'\)\}/);
    expect(edited).toMatch(/only=\{copy\('[a-z0-9_]+'\)\}/);
    for (const kept of ['wrapperClass="flex items-center gap-2"', 'gradient="from-blue-500 to-indigo-600"']) expect(edited).toContain(kept);
    expect([...cap.out, ...cap.err].filter((l) => l.includes('is a prop stet does not rewrite'))).toEqual([]);
  });

  it('leaves module data byte-identical and lists it (T13.8)', async () => {
    const dir = project();
    const items = ['First data text', 'Second data text', 'Third data text', 'Fourth data text'];
    const page = `const items = [${items.map((t) => `{ title: "${t}" }`).join(', ')}];\n${SERVER_PAGE('<ul>{items.map((i) => <h3>{i.title}</h3>)}</ul>')}`;
    write(dir, 'app/page.tsx', page);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe(page);
    expect(cap.out).toContain("4 strings in data (arrays and objects) are not rewritten — place copy('<key>') by hand; run with --verbose to list them");
    const verbose = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], verbose)).toBe(0);
    expect(read(dir, 'app/page.tsx')).toBe(page);
    expect(verbose.out).toContain("app/page.tsx:1: \"First data text\" sits in data — place copy('<key>') by hand");
    expect(verbose.out.filter((l) => l.includes('sits in data'))).toHaveLength(4);
  });

  it('prints a single data string on its own line (T13.8)', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', `const items = [{ title: "Fixing a word" }];\n${SERVER_PAGE('<ul>{items.map((i) => <h3>{i.title}</h3>)}</ul>')}`);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out).toContain("app/page.tsx:1: \"Fixing a word\" sits in data — place copy('<key>') by hand");
  });

  it('leaves .vue, .svelte and .mdx files byte-identical, and names each (T13.10)', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.vue', 'src/**/*.svelte', 'src/**/*.mdx'], copyModules: [] });
    const shapes = [
      '<SectionHead label="Capabilities" sub="One registry holds them all" variant="primary" />',
      '<button title="Copy">Go</button>',
      '<p>Install: run <b>npx x init</b> and answer.</p>',
      '{flags.changelog && <a class="i" href="/changelog">Changelog</a>}',
      '',
    ].join('\n');
    const files = ['src/a.vue', 'src/b.svelte', 'src/c.mdx'];
    for (const file of files) write(dir, file, shapes);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    for (const file of files) {
      expect(read(dir, file)).toBe(shapes);
      expect(cap.out).toContain(`${file}: ${file.slice(file.lastIndexOf('.'))} is not rewritten — place copy('<key>') by hand`);
    }
  });
});

describe('runRegister — the static-HTML host', () => {
  const PAGE = readFileSync(
    fileURLToPath(new URL('./fixtures/html-host/index.html', import.meta.url)),
    'utf8',
  );

  /**
   * An html host, and deliberately NO tsconfig: the config's defaulted
   * `@/lib/content` alias resolves nowhere, so a run that succeeds here is the
   * witness that the alias guard never ran and the compiler was never asked for.
   */
  function htmlProject(opts: { keys?: Record<string, unknown>; defaults?: Record<string, unknown> } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'stet-register-html-'));
    write(
      dir,
      'stet.config.json',
      JSON.stringify({
        project: 't',
        host: 'html',
        managedSurfaces: ['**/*.html'],
        descriptorPath: 'content/descriptor.json',
        snapshotPath: 'content/defaults.json',
      }),
    );
    write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: opts.keys ?? {} }));
    write(dir, 'content/defaults.json', JSON.stringify({ default: opts.defaults ?? {} }));
    write(dir, 'index.html', PAGE);
    return dir;
  }

  it('prints the diff and writes NOTHING on the plain run', async () => {
    const dir = htmlProject();
    const before = {
      descriptor: readFileSync(join(dir, 'content/descriptor.json')),
      snapshot: readFileSync(join(dir, 'content/defaults.json')),
      page: readFileSync(join(dir, 'index.html')),
    };
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    const out = cap.out.join('\n');
    // The section's <h3> under its <h2> is a subheadline (P4), so neither is numbered.
    expect(out).toContain('+      <h3 data-stet="home_qualify_subheadline">');
    expect(out).toContain('register: run with --write to apply 28 marks across 1 document');
    // The divergence from the JavaScript branch: a descriptor entry without its
    // mark is half a batch, so the plain run commits none of it.
    expect(readFileSync(join(dir, 'content/descriptor.json'))).toEqual(before.descriptor);
    expect(readFileSync(join(dir, 'content/defaults.json'))).toEqual(before.snapshot);
    expect(readFileSync(join(dir, 'index.html'))).toEqual(before.page);
  });

  it('--write lands the keys, the values and the marks in one batch', async () => {
    const dir = htmlProject();
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain(
      'wrote content/descriptor.json, content/defaults.json and 1 document: 26 keys added, 2 shared',
    );
    expect(cap.out.join('\n')).toContain('register: applied');

    const keys = descriptor(dir).keys;
    // The headline sits directly in `<main>`, which names no section.
    expect(keys['home_page_headline']).toEqual({
      shape: 'text',
      target: 'web',
      tags: 1,
    });
    expect(defaults(dir).default['home_page_headline']).toBe(
      'You may already have the data<1> our AI lab partners need.</1>',
    );
    // `&amp;` read back as the character it denotes.
    expect(defaults(dir).default['home_page_paragraph_1']).toBe('Research & development notes.');

    // The document is byte-identical outside the inserted attributes.
    const written = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(Buffer.from(written.replace(/ data-stet[^ >]*="[^"]*"/g, ''), 'utf8')).toEqual(
      Buffer.from(PAGE, 'utf8'),
    );
    expect(written.match(/data-stet/g)).toHaveLength(28);
  });

  it('shares one key for identical text and names the rest by their roles', async () => {
    const dir = htmlProject();
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const values = defaults(dir).default;
    const holding = Object.keys(values).filter((k) => String(values[k]).startsWith('How it works')).sort();
    expect(holding).toEqual(['home_contact_button_text', 'home_nav_link_text', 'home_qualify_headline']);
    expect(values['home_nav_link_text']).toBe('How it works');
    expect(values['home_qualify_headline']).toBe('How it works.');
    expect(values['home_contact_button_text']).toBe('How it works →');
    // One key, marked on BOTH links.
    const page = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(page.match(/data-stet="home_nav_link_text"/g)).toHaveLength(2);
  });

  it('marks a link carrying both text and a copy title with both, in the stated order', async () => {
    const dir = htmlProject();
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      // One key for the equal text and title, named for its first mark: the title.
      '<a href="/book" title="Book now" data-stet="home_contact_tooltip" data-stet-title="home_contact_tooltip">',
    );
  });

  it('shares an existing web text key, and never an email one', async () => {
    const shared = htmlProject({
      keys: { existing_heading: { shape: 'text', target: 'web' } },
      defaults: { existing_heading: 'Software, product and engineering histories' },
    });
    await runRegister(['--from', 'scan', '--write'], io(shared));
    // The subheadline shares the key, and the section's headline is minted beside it.
    expect(descriptor(shared).keys['home_qualify_subheadline']).toBeUndefined();
    expect(descriptor(shared).keys['home_qualify_headline']).toBeDefined();
    expect(readFileSync(join(shared, 'index.html'), 'utf8')).toContain(
      '<h3 data-stet="existing_heading">',
    );

    const email = htmlProject({
      keys: { existing_heading: { shape: 'text', target: 'html-email' } },
      defaults: { existing_heading: 'Software, product and engineering histories' },
    });
    await runRegister(['--from', 'scan', '--write'], io(email));
    expect(descriptor(email).keys['home_qualify_subheadline']).toEqual({
      shape: 'text',
      target: 'web',
      section: 'qualify',
    });
  });

  it('adopts nothing on a second run, and changes no byte', async () => {
    const dir = htmlProject();
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const before = {
      descriptor: readFileSync(join(dir, 'content/descriptor.json')),
      snapshot: readFileSync(join(dir, 'content/defaults.json')),
      page: readFileSync(join(dir, 'index.html')),
    };
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('register: nothing to adopt');
    expect(readFileSync(join(dir, 'content/descriptor.json'))).toEqual(before.descriptor);
    expect(readFileSync(join(dir, 'content/defaults.json'))).toEqual(before.snapshot);
    expect(readFileSync(join(dir, 'index.html'))).toEqual(before.page);
  });

  it('never writes a codegen module, and never asks for the compiler', async () => {
    const dir = htmlProject();
    // No tsconfig at all, so the defaulted `@/lib/content` alias resolves
    // nowhere: the run succeeding IS the alias-guard witness.
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(readdirSync(join(dir, 'content')).sort()).toEqual(['defaults.json', 'descriptor.json']);
  });
});

describe('runRegister — a decorative image takes no key (P8, F68)', () => {
  it('adopts no empty alt on a JSX component, and a second walk proposes nothing', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<div><img src="/hero.png" alt="" /><h1>Adopt the heading</h1></div>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(Object.keys(descriptor(dir).keys)).toEqual(['home_page_headline']);
    expect(Object.values(defaults(dir).default)).not.toContain('');
    expect(read(dir, 'app/page.tsx')).toContain('alt=""');
    const again = io(dir);
    expect(await runRegister(['--from', 'scan'], again)).toBe(0);
    expect(again.out.at(-1)).toBe('register: nothing to adopt');
  });
});

describe('runRegister — the JavaScript branch writes through the same batch', () => {
  it('rolls back the descriptor when a codegen write fails mid-batch', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Fresh key here</h1>'));
    // The codegen directory exists and is read-only, so the third file in the
    // batch cannot be written. `content/` is where the descriptor lives too, so
    // the batch has already written two files by then.
    mkdirSync(join(dir, 'content'), { recursive: true });
    const before = readFileSync(join(dir, 'content/descriptor.json'));
    chmodSync(join(dir, 'content'), 0o500);
    const cap = io(dir);
    let failed = false;
    try {
      await runRegister(['--from', 'scan', '--write'], cap);
    } catch (error) {
      failed = true;
      expect((error as Error).message).toContain('the write batch failed');
      expect((error as Error).message).toContain('Every file this run had already written was put back');
    } finally {
      chmodSync(join(dir, 'content'), 0o700);
    }
    expect(failed).toBe(true);
    // F17 narrows rather than closes: `writeFileSync` gives no cross-file
    // atomicity, so a scan landing INSIDE the batch can still read a half-written
    // tree. What the batch does guarantee is that the failure put everything back.
    expect(readFileSync(join(dir, 'content/descriptor.json'))).toEqual(before);
  });
});

/** The key a written document marks `<open tag start>` with, read back from the page. */
const markOf = (page: string, open: string, attr = '(?:-content)?'): string => {
  const found = new RegExp(`${open}[^>]*? data-stet${attr}="([^"]+)"`).exec(page);
  if (found === null) throw new Error(`no mark on ${open}`);
  return found[1] as string;
};

describe('register derives head texts', () => {
  afterAll(cleanupCliHosts);
  const DERIVE = readFileSync(fileURLToPath(new URL('./fixtures/html-host/derive.html', import.meta.url)), 'utf8');
  /** The plan over ad-hoc documents, with the descriptor and snapshot it mutated. */
  function plan(files: Record<string, string>, keys: Record<string, KeyDef> = {}, values: Snapshot = { default: {} }) {
    const dir = mkdtempSync(join(tmpdir(), 'stet-register-derive-'));
    for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
    const d: Descriptor = { version: 1, keys: structuredClone(keys) };
    const s: Snapshot = structuredClone(values);
    const result = planHtmlRegister({
      cwd: dir,
      files: Object.keys(files).sort(),
      descriptor: d,
      snapshot: s,
      report: new Report(),
      pageOf: () => 'home',
    });
    const page = (rel: string): string => result.edited.find((e) => e.rel === rel)?.text ?? (files[rel] as string);
    return { dir, result, descriptor: d, snapshot: s, page };
  }
  const doc = (head: string, body: string): string =>
    `<!DOCTYPE html>\n<html><head>\n${head}\n</head><body>\n${body}\n</body></html>\n`;

  it('derives the title and the meta description from the visible text they repeat (derive.html)', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': DERIVE } });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const keys = JSON.parse(host.file('content/descriptor.json')).keys as Record<string, KeyDef>;
    const values = JSON.parse(host.file('content/defaults.json')).default as Record<string, unknown>;
    const page = host.file('index.html');
    const h1 = markOf(page, '<h1');
    const title = markOf(page, '<title');
    const description = markOf(page, '<meta name="description"');
    const p = markOf(page, '<p');
    expect(keys[title]).toEqual({ shape: 'text', target: 'web', derivesFrom: h1, tmpl: '{v}', limits: { max: 60, severity: 'advisory' } });
    expect(keys[description]).toEqual({ shape: 'text', target: 'web', derivesFrom: p, tmpl: '{v} Book a call.', limits: { max: 160, severity: 'advisory' } });
    expect(Object.hasOwn(values, title) || Object.hasOwn(values, description)).toBe(false);
    // Head texts share among themselves; the rest take literal keys.
    expect(markOf(page, '<meta property="og:title"')).toBe(title);
    const og = markOf(page, '<meta property="og:description"');
    const twitter = markOf(page, '<meta name="twitter:description"');
    expect([keys[og]?.derivesFrom, values[og]]).toEqual([undefined, 'Start a trial today and see the whole catalogue for yourself.']);
    expect([keys[twitter]?.derivesFrom, values[twitter]]).toEqual([undefined, 'Reship the whole catalogue']);
    // The aria label shares the heading's key, as identical visible text does.
    expect(markOf(page, '<nav aria-label="Everything we ship"', '-aria-label')).toBe(markOf(page, '<h3'));
    expect(host.stdout()).toContain(`index.html:5 ${title} derives from ${h1} through "{v}"`);
    expect(host.stdout()).toContain(`index.html:6 ${description} derives from ${p} through "{v} Book a call."`);
    expect(Buffer.from(page.replace(/ data-stet[^ >]*="[^"]*"/g, ''))).toEqual(Buffer.from(DERIVE));

    host.out.length = 0;
    expect(await host.run('check')).toBe(0);
    const before = readFileSync(join(host.cwd, 'index.html'));
    expect(await host.run('pull')).toBe(0);
    expect(host.stdout()).toContain('pull: documents current');
    expect(readFileSync(join(host.cwd, 'index.html'))).toEqual(before);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.stdout()).toContain('register: nothing to adopt');
  });

  it('derives a share description from a tagged headline', () => {
    const { result, descriptor: d, page } = plan({
      'index.html': doc(
        '<meta property="og:description" content="You may already have the data our AI lab partners need. No raw data is needed to start.">',
        '<h1>You may already have the data<span class="tail"> our AI lab partners need.</span></h1>',
      ),
    });
    const h1 = markOf(page('index.html'), '<h1');
    const share = markOf(page('index.html'), '<meta property="og:description"');
    expect(d.keys[h1]?.tags).toBe(1);
    expect(d.keys[share]).toEqual({ shape: 'text', target: 'web', derivesFrom: h1, tmpl: '{v} No raw data is needed to start.', limits: { max: 160, severity: 'advisory' } });
    expect(result.derived.map((x) => x.key)).toEqual([share]);
  });

  it('derives a title placed before its headline in the document (the two passes)', () => {
    const { descriptor: d, page } = plan({
      'index.html': doc('<title>Widgets for everyone</title>', '<h1>Widgets for everyone</h1>'),
    });
    const title = markOf(page('index.html'), '<title');
    expect(d.keys[title]?.derivesFrom).toBe(markOf(page('index.html'), '<h1'));
  });

  describe('the conversion of an adopted site', () => {
    const HEAD = 'You may already have the data our AI lab partners need. No raw data is needed to start.';
    const HEADLINE = 'You may already have the data<1> our AI lab partners need.</1>';
    const adoptedPage = (extra = ''): string =>
      doc(
        `<title data-stet="site_title">Acme</title>\n<meta property="og:description" content="${HEAD}" data-stet-content="share">`,
        `<h1 data-stet="hero">You may already have the data<span class="tail"> our AI lab partners need.</span></h1>${extra}`,
      );
    const adoptedKeys = (): Record<string, KeyDef> => ({
      hero: { shape: 'text', target: 'web', tags: 1 },
      share: { shape: 'text', target: 'web' },
      site_title: { shape: 'text', target: 'web' },
    });
    const adoptedValues = (): Snapshot => ({ default: { hero: HEADLINE, share: HEAD, site_title: 'Acme' } });

    it('turns a literal head key into a derivation, keeping its name, and changes no document', () => {
      const { dir, result, descriptor: d, snapshot: s } = plan({ 'index.html': adoptedPage() }, adoptedKeys(), adoptedValues());
      expect(result.converted).toEqual([
        { key: 'share', source: 'hero', tmpl: '{v} No raw data is needed to start.', file: 'index.html', line: 4 },
      ]);
      expect(result.edited).toEqual([]);
      expect(d.keys['share']).toEqual({
        shape: 'text',
        target: 'web',
        derivesFrom: 'hero',
        tmpl: '{v} No raw data is needed to start.',
        limits: { max: 160, severity: 'advisory' },
      });
      expect(Object.hasOwn(s['default'] ?? {}, 'share')).toBe(false);
      expect(d.keys['site_title']?.derivesFrom).toBeUndefined();
      expect(planDocuments(dir, ['index.html'], d, s, new Report()).writes).toEqual([]);
    });

    it('leaves literal a head key with a de value, one also visible, one declaring tags, and one another derives from', () => {
      const de = adoptedValues();
      de['de'] = { share: 'Vielleicht haben Sie die Daten schon.' };
      expect(plan({ 'index.html': adoptedPage() }, adoptedKeys(), de).result.converted).toEqual([]);

      const visible = plan({ 'index.html': adoptedPage(`\n<h2 data-stet="share">${HEAD}</h2>`) }, adoptedKeys(), adoptedValues());
      expect(visible.result.converted).toEqual([]);

      const tagged = adoptedKeys();
      tagged['share'] = { shape: 'text', target: 'web', tags: 1 };
      expect(plan({ 'index.html': adoptedPage() }, tagged, adoptedValues()).result.converted).toEqual([]);

      const followed = adoptedKeys();
      followed['echo'] = { shape: 'text', target: 'web', derivesFrom: 'share', tmpl: '{v}' };
      expect(plan({ 'index.html': adoptedPage() }, followed, adoptedValues()).result.converted).toEqual([]);
    });

    it('leaves literal a head key marked in two documents (stage-5 R2)', () => {
      const { result, descriptor: d } = plan(
        {
          'index.html': doc('<title data-stet="t">Widgets for everyone</title>', '<h1 data-stet="h">Widgets for everyone</h1>'),
          'z.html': doc('<title data-stet="t">Widgets for everyone</title>', '<p data-stet="z">Another page.</p>'),
        },
        { h: { shape: 'text', target: 'web' }, t: { shape: 'text', target: 'web' }, z: { shape: 'text', target: 'web' } },
        { default: { h: 'Widgets for everyone', t: 'Widgets for everyone', z: 'Another page.' } },
      );
      expect(result.converted).toEqual([]);
      // Left literal, and given its SEO bound as a head-only key.
      expect(d.keys['t']).toEqual({ shape: 'text', target: 'web', limits: { max: 60, severity: 'advisory' } });
    });

    it('gives a new visible text equal to a head-only key’s value a fresh key', () => {
      const { descriptor: d, page } = plan({ 'index.html': adoptedPage('\n<h2>Acme</h2>') }, adoptedKeys(), adoptedValues());
      const h2 = markOf(page('index.html'), '<h2');
      expect(h2).not.toBe('site_title');
      expect(d.keys[h2]).toEqual({ shape: 'text', target: 'web' });
    });
  });

  it('never derives from a key another page also carries', () => {
    const nav = '<nav><a href="/">Home</a> <a href="/about.html">About</a></nav>';
    const { result, descriptor: d, page } = plan({
      'index.html': doc('<title>Acme widgets</title>', `${nav}\n<h1>Widgets for everyone</h1>`),
      'about.html': doc('<title>About</title>', `${nav}\n<h1>Who we are</h1>`),
    });
    expect(result.derived).toEqual([]);
    expect(d.keys[markOf(page('about.html'), '<title')]?.derivesFrom).toBeUndefined();
  });

  it('mints a fresh key for a derivation source’s text on a page a later run adopts (stage-5 R3)', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': doc('<title>Widgets for everyone</title>', '<h1>Widgets for everyone</h1>') },
    });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const source = markOf(host.file('index.html'), '<h1');
    const title = markOf(host.file('index.html'), '<title');
    expect(JSON.parse(host.file('content/descriptor.json')).keys[title].derivesFrom).toBe(source);
    writeFileSync(join(host.cwd, 'about.html'), doc('<title>About us</title>', '<h1>Widgets for everyone</h1>'));
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(markOf(host.file('about.html'), '<h1')).not.toBe(source);
    // One headline edit rewrites index.html alone.
    const snapshot = JSON.parse(host.file('content/defaults.json')) as { default: Record<string, unknown> };
    snapshot.default[source] = 'Widgets for all';
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    const about = readFileSync(join(host.cwd, 'about.html'));
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toContain('>Widgets for all</title>');
    expect(host.file('index.html')).toContain('>Widgets for all</h1>');
    expect(readFileSync(join(host.cwd, 'about.html'))).toEqual(about);
  });

  it('never shares one page’s derived title onto another page', () => {
    const pair = plan({
      'a.html': doc('<title>Widgets for everyone</title>', '<h1>Widgets for everyone</h1>'),
      'b.html': doc('<title>Widgets for everyone</title>', '<h1>Other page heading</h1>'),
    });
    const a = markOf(pair.page('a.html'), '<title');
    const b = markOf(pair.page('b.html'), '<title');
    expect(pair.descriptor.keys[a]?.derivesFrom).toBe(markOf(pair.page('a.html'), '<h1'));
    expect(b).not.toBe(a);
    expect(pair.descriptor.keys[b]?.derivesFrom).toBeUndefined();
    expect(pair.snapshot['default']?.[b]).toBe('Widgets for everyone');
  });

  it('never shares a head text’s key with an aria label', () => {
    const fresh = plan({
      'index.html': doc(
        '<meta property="og:title" content="Psyon home page">',
        '<a href="/" aria-label="Psyon home page">P</a><p>Some body text here.</p>',
      ),
    });
    expect(fresh.result.shared).toBe(0);
    const og = markOf(fresh.page('index.html'), '<meta property="og:title"');
    expect(og).not.toBe(markOf(fresh.page('index.html'), '<a href="/" aria-label', '-aria-label'));

    const declared = plan(
      {
        'index.html': doc(
          '<meta property="og:title" content="Psyon home page">',
          '<a href="/" aria-label="Psyon home page" data-stet-aria-label="home">P</a><p>Some body text here.</p>',
        ),
      },
      { home: { shape: 'text', target: 'web' } },
      { default: { home: 'Psyon home page' } },
    );
    expect(declared.result.shared).toBe(0);
    expect(markOf(declared.page('index.html'), '<meta property="og:title"')).not.toBe('home');
  });
});

describe('register derives head texts — the lines', () => {
  afterAll(cleanupCliHosts);
  const HEAD = 'You may already have the data our AI lab partners need. No raw data is needed to start.';
  const HEADLINE = 'You may already have the data<1> our AI lab partners need.</1>';
  /** An adopted page whose share description, at line 9, is a literal key repeating the headline. */
  const ADOPTED = (extra = ''): string =>
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<title data-stet="site_title">Acme</title>\n' +
    '<link rel="stylesheet" href="/a.css">\n<link rel="stylesheet" href="/b.css">\n<link rel="icon" href="/i.ico">\n' +
    `<meta property="og:description" content="${HEAD}" data-stet-content="share">\n` +
    '</head>\n<body>\n' +
    `<h1 data-stet="hero">You may already have the data<span class="tail"> our AI lab partners need.</span></h1>${extra}\n` +
    '</body>\n</html>\n';
  const KEYS = {
    hero: { shape: 'text', target: 'web', tags: 1 },
    share: { shape: 'text', target: 'web' },
    site_title: { shape: 'text', target: 'web' },
  };
  const VALUES = { hero: HEADLINE, share: HEAD, site_title: 'Acme' };
  const DERIVES = 'index.html:9 share derives from hero through "{v} No raw data is needed to start."';

  it('converts an adopted site’s head key, printing the plan, then the write, with the page unchanged', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': ADOPTED() }, keys: KEYS, defaults: VALUES });
    const page = readFileSync(join(host.cwd, 'index.html'));
    const forms = () => [host.file('content/descriptor.json'), host.file('content/defaults.json')];
    const before = forms();

    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.out).toEqual([
      DERIVES,
      'site_title: limit 60 added',
      'share: limit 160 added',
      "register: run with --write to derive 1 key from the page's visible text and add the SEO limit to 2 keys",
    ]);
    expect(forms()).toEqual(before);
    expect(readFileSync(join(host.cwd, 'index.html'))).toEqual(page);

    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.out).toEqual([
      DERIVES,
      'site_title: limit 60 added',
      'share: limit 160 added',
      "wrote content/descriptor.json and content/defaults.json: 1 key now derived from the page's visible text; their documents are unchanged",
      'wrote content/descriptor.json: the SEO limit added to 2 keys',
      'register: applied',
    ]);
    expect(JSON.parse(host.file('content/descriptor.json')).keys.share).toEqual({
      derivesFrom: 'hero',
      limits: { max: 160, severity: 'advisory' },
      shape: 'text',
      target: 'web',
      tmpl: '{v} No raw data is needed to start.',
    });
    expect(Object.hasOwn(JSON.parse(host.file('content/defaults.json')).default, 'share')).toBe(false);
    expect(readFileSync(join(host.cwd, 'index.html'))).toEqual(page);

    host.out.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(await host.run('pull')).toBe(0);
    expect(host.stdout()).toContain('pull: documents current');
    expect(readFileSync(join(host.cwd, 'index.html'))).toEqual(page);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.out).toEqual(['register: nothing to adopt']);
  });

  it('prints both parts and both written lines when a run marks and converts', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': ADOPTED('\n<p>A paragraph nobody has marked yet.</p>') },
      keys: KEYS,
      defaults: VALUES,
    });
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.out.slice(-4)).toEqual([
      DERIVES,
      'site_title: limit 60 added',
      'share: limit 160 added',
      "register: run with --write to apply 1 mark across 1 document, derive 1 key from the page's visible text and add the SEO limit to 2 keys",
    ]);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.out.slice(-5)).toEqual([
      'share: limit 160 added',
      'wrote content/descriptor.json, content/defaults.json and 1 document: 1 key added, 0 shared',
      "wrote content/descriptor.json and content/defaults.json: 1 key now derived from the page's visible text; their documents are unchanged",
      'wrote content/descriptor.json: the SEO limit added to 2 keys',
      'register: applied',
    ]);
  });

  it('prints the derivations in file, then line order', async () => {
    const host = await makeHtmlHost({
      files: {
        'about.html': ADOPTED(),
        'index.html': '<!DOCTYPE html>\n<html><head>\n<title>Widgets for everyone</title>\n</head><body>\n<h1>Widgets for everyone</h1>\n</body></html>\n',
      },
      keys: KEYS,
      defaults: VALUES,
    });
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    const lines = host.out.filter((line) => line.includes(' derives from '));
    expect(lines).toEqual([
      'about.html:9 share derives from hero through "{v} No raw data is needed to start."',
      'index.html:3 home_page_title derives from home_page_headline through "{v}"',
    ]);
  });
});

describe('register names by role', () => {
  afterAll(cleanupCliHosts);
  const ROLES = readFileSync(fileURLToPath(new URL('./fixtures/html-host/roles.html', import.meta.url)), 'utf8');
  const NAMES = [
    'home_page_link_text',
    'home_header_span',
    'home_nav_link_text_1',
    'home_nav_link_text_2',
    'home_top_headline',
    'home_top_paragraph_1',
    'home_top_paragraph_2',
    'home_faq_item_1_headline',
    'home_faq_item_1_paragraph',
    'home_faq_item_2_headline',
    'home_faq_item_2_paragraph',
    'home_footer_paragraph',
    'home_page_title',
    'home_share_description',
  ];
  /** Every mark a written page carries, in document order. */
  const marksIn = (page: string): string[] => [...page.matchAll(/ data-stet(?:-[a-z-]+)?="([^"]*)"/g)].map((m) => m[1] as string);
  type Forms = { keys: Record<string, KeyDef & { section?: string; label?: string; help?: string }> };

  it('names every key by its page, section and role, numbered across the run', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const keys = (JSON.parse(host.file('content/descriptor.json')) as Forms).keys;
    expect(Object.keys(keys).sort()).toEqual([...NAMES].sort());
    // The body's marks in document order, the head texts ahead of them.
    expect(marksIn(host.file('index.html'))).toEqual([
      'home_page_title',
      'home_share_description',
      ...NAMES.slice(0, 12),
    ]);
    // The section word lands on each entry where one answered; the skip link
    // and the head texts carry none.
    expect(keys['home_top_headline']?.section).toBe('top');
    // A <details> holding a heading and an answer is a repeated item, named by its place.
    expect(keys['home_faq_item_2_paragraph']?.section).toBe('faq');
    expect(keys['home_header_span']?.section).toBe('header');
    expect(keys['home_nav_link_text_1']?.section).toBe('nav');
    expect(keys['home_footer_paragraph']?.section).toBe('footer');
    for (const name of ['home_page_link_text', 'home_page_title', 'home_share_description']) {
      expect(keys[name]).not.toHaveProperty('section');
    }
    expect(keys['home_share_description']?.derivesFrom).toBe('home_top_headline');
    expect(host.stdout()).toContain(
      'index.html:6 home_share_description derives from home_top_headline through "{v} Start today."',
    );
    // The placeholder a fresh key is minted under reaches no file and no line.
    for (const rel of ['content/descriptor.json', 'content/defaults.json', 'index.html']) {
      expect(readFileSync(join(host.cwd, rel)).includes(0x01)).toBe(false);
    }
    expect(`${host.stdout()}${host.stderr()}`).not.toMatch(/[\u0001�]/);
  });

  it("tells a gate refusal by the element's file and line, never by the placeholder", async () => {
    const page = ROLES.replace('<p>Sometimes, depending on the case.</p>', '<p>Unsubscribe here: {{unsubscribe_url}}</p>');
    const host = await makeHtmlHost({ files: { 'index.html': page } });
    expect(await host.run('register', '--from', 'scan')).toBe(1);
    expect(host.stderr()).toContain(
      'index.html:26: undeclared variable {{unsubscribe_url}} — declare them on the key or fix the placeholder (default)',
    );
    expect(`${host.stdout()}${host.stderr()}`).not.toMatch(/[\u0001�]/);
  });

  it('never gives a declared name: the heading continues at _2', async () => {
    const bare = await makeHtmlHost({
      files: { 'index.html': ROLES },
      keys: { home_top_headline: { shape: 'text', target: 'web' } },
      defaults: { home_top_headline: 'An older headline' },
    });
    expect(await bare.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(bare.file('index.html')).toContain('<h1 data-stet="home_top_headline_2">');

    const first = await makeHtmlHost({
      files: { 'index.html': ROLES },
      keys: { home_top_headline_1: { shape: 'text', target: 'web' } },
      defaults: { home_top_headline_1: 'An older headline' },
    });
    expect(await first.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(first.file('index.html')).toContain('<h1 data-stet="home_top_headline_2">');
  });

  it("shares the second page's key with a third page, past a derivation's source (F40)", async () => {
    const A =
      '<!doctype html><html><head><title>A</title><meta property="og:description" content="Ship the catalogue in a day. Start today."></head>' +
      '<body><p>Ship the catalogue in a day.</p></body></html>\n';
    const other = (title: string): string =>
      `<!doctype html><html><head><title>${title}</title></head><body><p>Ship the catalogue in a day.</p></body></html>\n`;
    // `a.html` is adopted first, alone: its share description derives from its paragraph.
    const host = await makeHtmlHost({ files: { 'index.html': '<!doctype html><html><body></body></html>\n', 'a.html': A } });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.file('a.html')).toContain('<p data-stet="a_page_paragraph">');
    expect(host.file('a.html')).toContain('data-stet-content="a_share_description"');

    write(host.cwd, 'b.html', other('b'));
    write(host.cwd, 'c.html', other('c'));
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.stdout()).toContain('1 key added, 1 shared');
    expect(host.file('b.html')).toContain('<p data-stet="site_page_paragraph">');
    expect(host.file('c.html')).toContain('<p data-stet="site_page_paragraph">');
    expect(host.file('a.html')).toContain('<p data-stet="a_page_paragraph">');
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
  });

  describe("a plan's choices", () => {
    function planWith(chosen: Parameters<typeof planHtmlRegister>[0]['chosen'], page = ROLES) {
      const dir = mkdtempSync(join(tmpdir(), 'stet-register-chosen-'));
      write(dir, 'index.html', page);
      const d: Descriptor = { version: 1, keys: {} };
      const s: Snapshot = { default: {} };
      const result = planHtmlRegister({
        cwd: dir,
        files: ['index.html'],
        descriptor: d,
        snapshot: s,
        report: new Report(),
        pageOf: () => 'home',
        ...(chosen === undefined ? {} : { chosen }),
      });
      return { result, descriptor: d, snapshot: s, page: result.edited[0]?.text ?? page };
    }

    it('renames the entry, its value, what derives from it, its derivation and its mark', () => {
      const { result, descriptor: d, snapshot: s, page } = planWith((proposed) =>
        proposed === 'home_top_headline'
          ? { key: 'home_hero_headline', label: 'Hero headline', help: 'The line at the top.', section: 'hero' }
          : undefined,
      );
      expect(d.keys['home_top_headline']).toBeUndefined();
      expect(d.keys['home_hero_headline']).toEqual({
        shape: 'text',
        target: 'web',
        section: 'hero',
        label: 'Hero headline',
        help: 'The line at the top.',
      });
      expect(s['default']?.['home_hero_headline']).toBe('Ship the catalogue in a day.');
      expect(s['default']).not.toHaveProperty('home_top_headline');
      expect(d.keys['home_share_description']?.derivesFrom).toBe('home_hero_headline');
      expect(result.derived.map((x) => `${x.key} ${x.source}`)).toEqual(['home_share_description home_hero_headline']);
      expect(page).toContain('<h1 data-stet="home_hero_headline">');
    });

    it('leaves a proposal the plan drops out: no entry, no value, no mark', () => {
      const { result, descriptor: d, snapshot: s, page } = planWith((proposed) =>
        proposed === 'home_header_span' ? { adopt: false, key: 'home_header_span' } : undefined,
      );
      expect(d.keys['home_header_span']).toBeUndefined();
      expect(s['default']).not.toHaveProperty('home_header_span');
      expect(page).toContain('<span>Acme wordmark</span>');
      expect(marksIn(page)).not.toContain('home_header_span');
      expect(page.includes('\u0001')).toBe(false);
      expect(result.added).toBe(NAMES.length - 1);
    });

    it('counts what lands: a shared key left out adds and shares nothing', async () => {
      const page =
        '<!DOCTYPE html>\n<html><body>\n<footer>\n<p>Same words, twice over.</p>\n<p>Same words, twice over.</p>\n' +
        '<p>Other words in here.</p>\n</footer>\n</body></html>\n';
      const host = await makeHtmlHost({ files: { 'index.html': page } });
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'p.json')).toBe(0);
      const plan = JSON.parse(host.file('p.json')) as { keys: Array<{ proposed: string; adopt: boolean }> };
      expect(plan.keys.map((e) => e.proposed)).toEqual(['home_footer_paragraph_1', 'home_footer_paragraph_2']);
      (plan.keys[0] as { adopt: boolean }).adopt = false;
      write(host.cwd, 'p.json', JSON.stringify(plan));
      host.out.length = 0;
      expect(await host.run('register', '--from', 'scan', '--plan', 'p.json', '--write')).toBe(0);
      expect(host.stdout()).toContain('1 key added, 0 shared');
      expect(marksIn(host.file('index.html'))).toEqual(['home_footer_paragraph_2']);
    });
  });
});

/** The App Router fixture: a home page with a hero and a headed section, a pricing page, a component. */
const HOME =
  'export default function Page() {\n' +
  '  return (\n' +
  '    <main>\n' +
  '      <section id="hero">\n' +
  '        <h1>Your week, sorted</h1>\n' +
  '        <p>One brief a week, from the feeds you follow.</p>\n' +
  '      </section>\n' +
  '      <section>\n' +
  '        <h2>Frequently asked</h2>\n' +
  '        <h3>Does it read my mail?</h3>\n' +
  '        <h3>Can I stop it anytime?</h3>\n' +
  '      </section>\n' +
  '    </main>\n' +
  '  );\n' +
  '}\n';
const PRICING =
  'export default function Pricing() {\n' +
  '  return (\n' +
  '    <>\n' +
  '      <main><h1>Plans for every team</h1></main>\n' +
  '      <footer><p>Prices exclude tax.</p></footer>\n' +
  '    </>\n' +
  '  );\n' +
  '}\n';
const CARD = 'export function PricingCard() {\n  return <div><h2>Premium plan</h2></div>;\n}\n';
const footer = (name: string, text: string, head = ''): string =>
  `${head}export function ${name}() {\n  return <footer><p>${text}</p></footer>;\n}\n`;

describe('register shares JSX text within a run', () => {
  const SHARED_PAGE =
    'export default function Page() {\n' +
    '  return (\n' +
    '    <main>\n' +
    '      <section id="hero"><h1>Your data, sorted</h1><a href="#contact">Start a conversation</a></section>\n' +
    '      <footer><a href="#contact">Start a conversation</a></footer>\n' +
    '    </main>\n' +
    '  );\n' +
    '}\n';
  /** Every `copy('<key>')` a file reads. */
  const readsIn = (text: string): string[] => [...text.matchAll(/copy\('([^']+)'\)/g)].map((m) => m[1] as string);

  it('gives identical text one key, named for its first literal, the later one sharing it', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SHARED_PAGE);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const out = cap.out.join('\n');
    expect(out).toContain('app/page.tsx: shares home_hero_link_text = Start a conversation');
    expect(out).toMatch(/: 2 keys added, 1 shared$/m);
    const keys = descriptor(dir).keys;
    expect(Object.keys(keys).sort()).toEqual(['home_hero_headline', 'home_hero_link_text']);
    expect(readsIn(read(dir, 'app/page.tsx'))).toEqual(['home_hero_headline', 'home_hero_link_text', 'home_hero_link_text']);
  });

  it('leaves a follower unrewritten where its leader was refused', async () => {
    const dir = project({ layout: UNLOCATABLE_LAYOUT });
    // The home page's literal leads: it is a client component, and with the
    // CopyProvider mount unlocatable its rewrite is refused.
    write(dir, 'app/page.tsx', CLIENT_WIDGET('<a href="#contact">Start a conversation</a>'));
    write(dir, 'app/other/page.tsx', 'export default function Page() {\n  return <main><h1>Your data, sorted</h1><a href="#c">Start a conversation</a></main>;\n}\n');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    const page = read(dir, 'app/other/page.tsx');
    expect(page).toContain('<a href="#c">Start a conversation</a>');
    const declared = Object.keys(descriptor(dir).keys);
    for (const key of readsIn(page)) expect(declared).toContain(key);
    expect(cap.out.join('\n')).not.toMatch(/: shares /);
    expect(cap.out).toContain('app/other/page.tsx:2 "Start a conversation" not rewritten (the text it shares was not rewritten) — adopt by hand');
    expect(await runCli(['check'], io(dir))).toBe(0);
  });

  it('adopts neither literal where the plan leaves the leader out', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SHARED_PAGE);
    const { run } = { run: (...argv: string[]) => runCli(argv, io(dir)) };
    expect(await run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
    const plan = JSON.parse(read(dir, 'naming.json')) as { keys: Array<Record<string, unknown>> };
    const entry = plan.keys.find((e) => e['proposed'] === 'home_hero_link_text') as Record<string, unknown>;
    expect(entry['places']).toEqual(['app/page.tsx:4 <a>', 'app/page.tsx:5 <a>']);
    expect(plan.keys.map((e) => e['proposed'])).toEqual(['home_hero_headline', 'home_hero_link_text']);
    entry['adopt'] = false;
    writeFileSync(join(dir, 'naming.json'), JSON.stringify(plan, null, 2));
    expect(await run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(0);
    const page = read(dir, 'app/page.tsx');
    expect(page.match(/>Start a conversation</g)).toHaveLength(2);
    expect(Object.keys(descriptor(dir).keys)).toEqual(['home_hero_headline']);
  });

  it('gives a head <title> and a visible <h1> of the same text two keys', async () => {
    const dir = project();
    write(
      dir,
      'app/page.tsx',
      'export default function Page() {\n  return <><title>Your data, sorted</title><main><h1>Your data, sorted</h1></main></>;\n}\n',
    );
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    expect(Object.keys(descriptor(dir).keys).sort()).toEqual(['home_page_headline', 'home_page_title']);
  });
});

describe('register names JSX by role', () => {
  type Entry = { section?: string };

  function appHost(): string {
    const dir = project({
      managedSurfaces: ['app/**/*.tsx', 'components/**/*.tsx'],
      keys: { home_hero_headline: { shape: 'text', target: 'web' } },
      defaults: { home_hero_headline: 'An older headline' },
    });
    write(dir, 'app/page.tsx', HOME);
    write(dir, 'app/pricing/page.tsx', PRICING);
    write(dir, 'components/PricingCard.tsx', CARD);
    return dir;
  }

  it('names each leaf by page, section and role, numbered across the run past a declared name', async () => {
    const dir = appHost();
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const keys = descriptor(dir).keys as Record<string, Entry>;
    const added = Object.keys(keys).filter((k) => k !== 'home_hero_headline');
    expect(added.sort()).toEqual(
      [
        'home_hero_headline_2',
        'home_hero_paragraph',
        // The section's <h2> is its headline and its <h3>s subheadlines (P4).
        'home_frequently_asked_headline',
        'home_frequently_asked_subheadline_1',
        'home_frequently_asked_subheadline_2',
        'pricing_page_headline',
        'pricing_footer_paragraph',
      ].sort(),
    );
    expect(keys['home_hero_headline_2']?.section).toBe('hero');
    expect(keys['home_hero_paragraph']?.section).toBe('hero');
    expect(keys['home_frequently_asked_subheadline_2']?.section).toBe('frequently_asked');
    expect(keys['pricing_footer_paragraph']?.section).toBe('footer');
    expect(keys['pricing_page_headline']).not.toHaveProperty('section');
    const home = read(dir, 'app/page.tsx');
    for (const name of ['home_hero_headline_2', 'home_hero_paragraph', 'home_frequently_asked_headline', 'home_frequently_asked_subheadline_2']) {
      expect(home).toContain(`{copy('${name}')}`);
    }
    expect(read(dir, 'app/pricing/page.tsx')).toContain("{copy('pricing_footer_paragraph')}");
    // The component is ambiguous without --kind, so it takes no name here.
    expect(read(dir, 'components/PricingCard.tsx')).toBe(CARD);
  });

  it('names a component by its own name under --kind server, with no page part', async () => {
    const dir = appHost();
    expect(await runRegister(['--from', 'scan', '--write', '--kind', 'server'], io(dir))).toBe(0);
    expect(read(dir, 'components/PricingCard.tsx')).toContain("{copy('pricing_card_headline')}");
    expect((descriptor(dir).keys as Record<string, Entry>)['pricing_card_headline']?.section).toBe('pricing_card');
  });

  it('numbers a role that repeats across files', async () => {
    const dir = project({ managedSurfaces: ['components/**/*.tsx'] });
    write(dir, 'components/A.tsx', footer('SiteFooter', 'The first footer line.'));
    write(dir, 'components/B.tsx', footer('PageFooter', 'The second footer line.'));
    expect(await runRegister(['--from', 'scan', '--write', '--kind', 'server'], io(dir))).toBe(0);
    expect(read(dir, 'components/A.tsx')).toContain("{copy('footer_paragraph_1')}");
    expect(read(dir, 'components/B.tsx')).toContain("{copy('footer_paragraph_2')}");
  });

  it('gives a literal the gate refuses no name, so the numbers have no gap', async () => {
    const dir = project();
    write(
      dir,
      'app/page.tsx',
      SERVER_PAGE('<section id="a"><img alt="Use {{x}} here now" /><img alt="A picture of a cat" /></section>'),
    );
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(cap.err.join('\n')).toContain('undeclared variable {{x}}');
    expect(Object.keys(descriptor(dir).keys)).toEqual(['home_a_image_alt_text']);
    expect(read(dir, 'app/page.tsx')).toContain('alt="Use {{x}} here now"');
  });

  it('gives a literal the rewrite skips no name, and reports it to adopt by hand', async () => {
    const dir = project({ managedSurfaces: ['components/**/*.tsx'] });
    write(dir, 'components/A.tsx', footer('SiteFooter', 'The first footer line.', "import copy from 'copy-to-clipboard';\n"));
    write(dir, 'components/B.tsx', footer('PageFooter', 'The second footer line.'));
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write', '--kind', 'server'], cap);
    expect(cap.err.join('\n')).toContain(
      'components/A.tsx: "footer_paragraph" a foreign `copy` is already bound in scope — adopt by hand',
    );
    expect(Object.keys(descriptor(dir).keys)).toEqual(['footer_paragraph']);
    expect(read(dir, 'components/B.tsx')).toContain("{copy('footer_paragraph')}");
  });

  it("never gives a declared copy module's property name to a leaf", async () => {
    const dir = project({ managedSurfaces: ['components/**/*.tsx'], copyModules: ['lib/copy.ts'] });
    write(dir, 'lib/copy.ts', 'export const copy = {\n  hero_title: "The hero title",\n};\n');
    write(dir, 'components/Hero.tsx', 'export function Hero() {\n  return <Title>Welcome to the site</Title>;\n}\n');
    expect(await runRegister(['--from', 'scan', '--write', '--kind', 'server'], io(dir))).toBe(0);
    expect(read(dir, 'components/Hero.tsx')).toContain("{copy('hero_title_2')}");
    expect(defaults(dir).default['hero_title']).toBe('The hero title');
  });
});

describe('register --plan', () => {
  afterAll(cleanupCliHosts);
  const ROLES = readFileSync(fileURLToPath(new URL('./fixtures/html-host/roles.html', import.meta.url)), 'utf8');
  interface PlanFile {
    plan: string;
    version: number;
    made: Record<string, string>;
    keys: Array<{
      proposed: string;
      key: string;
      label: string | null;
      help: string | null;
      section: string | null;
      adopt: boolean;
      kind: string;
      places: string[];
      text: string;
    }>;
  }
  /** Every file of a checkout, so "nothing else was written" is a byte compare. */
  function filesOf(dir: string): Map<string, Buffer> {
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
  function sameFiles(dir: string, before: Map<string, Buffer>, except: string[] = []): void {
    const after = filesOf(dir);
    for (const rel of except) after.delete(rel);
    expect([...after.keys()].sort()).toEqual([...before.keys()].filter((k) => !except.includes(k)).sort());
    for (const [rel, bytes] of after) expect(bytes.equals(before.get(rel) as Buffer), rel).toBe(true);
  }
  const edit = (dir: string, rel: string, change: (plan: PlanFile) => void): void => {
    const plan = JSON.parse(readFileSync(join(dir, rel), 'utf8')) as PlanFile;
    change(plan);
    write(dir, rel, JSON.stringify(plan, null, 2));
  };
  const entryOf = (plan: PlanFile, proposed: string) => plan.keys.find((e) => e.proposed === proposed) as PlanFile['keys'][number];
  /** A JavaScript host run through the dispatcher, so usage errors exit 2 as a person sees them. */
  function cli(dir: string) {
    const cap = io(dir);
    return { cap, run: (...argv: string[]) => runCli(argv, cap) };
  }
  function appHost(extra: { copyModules?: string[] } = {}): string {
    const dir = project({ managedSurfaces: ['app/**/*.tsx'], ...extra });
    write(dir, 'app/page.tsx', HOME);
    write(dir, 'app/pricing/page.tsx', PRICING);
    return dir;
  }

  describe('on the static-HTML host', () => {
    it('--plan-out writes the plan and nothing else, its entries in run order', async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      const before = filesOf(host.cwd);
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      expect(host.stdout()).toContain(
        'wrote naming.json: the naming plan for 14 keys — edit key, label and help, then run stet register --from scan --plan naming.json',
      );
      sameFiles(host.cwd, before, ['naming.json']);
      const plan = JSON.parse(host.file('naming.json')) as PlanFile;
      expect(plan.plan).toBe('stet register');
      expect(plan.version).toBe(1);
      expect(plan.made).toEqual({
        'content/defaults.json': fileHash(host.cwd, 'content/defaults.json'),
        'content/descriptor.json': fileHash(host.cwd, 'content/descriptor.json'),
        'index.html': fileHash(host.cwd, 'index.html'),
      });
      expect(plan.keys.map((e) => e.proposed)).toEqual([
        'home_page_link_text',
        'home_header_span',
        'home_nav_link_text_1',
        'home_nav_link_text_2',
        'home_top_headline',
        'home_top_paragraph_1',
        'home_top_paragraph_2',
        'home_faq_item_1_headline',
        'home_faq_item_1_paragraph',
        'home_faq_item_2_headline',
        'home_faq_item_2_paragraph',
        'home_footer_paragraph',
        'home_page_title',
        'home_share_description',
      ]);
      expect(plan.keys[0]).toEqual({
        proposed: 'home_page_link_text',
        key: 'home_page_link_text',
        label: null,
        help: null,
        section: null,
        adopt: true,
        kind: 'link text',
        places: ['index.html:9 <a>'],
        text: 'Skip to content',
      });
      expect(entryOf(plan, 'home_top_headline')).toMatchObject({ section: 'top', kind: 'headline', places: ['index.html:19 <h1>'] });
      expect(entryOf(plan, 'home_share_description')).toMatchObject({
        section: null,
        kind: 'share description',
        places: ['index.html:6 <meta> og:description'],
        text: '{v} Start today.',
      });
    });

    it('applies the edited names, labels, help and sections, and leaves a dropped proposal out', async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      edit(host.cwd, 'naming.json', (plan) => {
        Object.assign(entryOf(plan, 'home_top_headline'), {
          key: 'home_hero_headline',
          label: 'Hero headline',
          help: 'The headline at the top of the home page.',
          section: 'hero',
        });
        entryOf(plan, 'home_header_span').adopt = false;
      });
      host.out.length = 0;
      expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(0);
      const keys = (JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, unknown> }).keys;
      expect(keys['home_hero_headline']).toEqual({
        shape: 'text',
        target: 'web',
        section: 'hero',
        label: 'Hero headline',
        help: 'The headline at the top of the home page.',
      });
      expect(keys['home_top_headline']).toBeUndefined();
      expect(keys['home_header_span']).toBeUndefined();
      expect(JSON.parse(host.file('content/defaults.json')).default).not.toHaveProperty('home_header_span');
      expect(host.file('index.html')).toContain('<span>Acme wordmark</span>');
      expect(host.stdout()).toContain(
        'index.html:6 home_share_description derives from home_hero_headline through "{v} Start today."',
      );
      host.out.length = 0;
      expect(await host.run('check')).toBe(0);
    });

    it('refuses a plan with every problem listed, and changes nothing', async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      edit(host.cwd, 'naming.json', (plan) => {
        entryOf(plan, 'home_top_paragraph_1').key = 'home_hero__eyebrow';
        entryOf(plan, 'home_faq_item_1_headline').key = 'home_faq_question';
        entryOf(plan, 'home_faq_item_2_headline').key = 'home_faq_question';
        entryOf(plan, 'home_top_headline').label = 'x'.repeat(61);
      });
      const before = filesOf(host.cwd);
      expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(1);
      expect(host.err).toEqual([
        'error: stet register: naming.json is refused — nothing written',
        'error: home_top_headline: its label is longer than 60 characters',
        'error: home_top_paragraph_1: "home_hero__eyebrow" uses "__", which names a template slot or the brand group',
        'error: home_faq_item_1_headline and home_faq_item_2_headline: both are named "home_faq_question"',
      ]);
      sameFiles(host.cwd, before);
    });

    it('refuses a plan whose files have changed since it was written', async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      write(host.cwd, 'index.html', ROLES.replace('Questions asked', 'Questions we get'));
      const before = filesOf(host.cwd);
      expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(1);
      expect(host.err).toEqual([
        'error: stet register: naming.json is refused — nothing written',
        'error: naming.json: the files it was made from have changed — run the command with --plan-out again',
      ]);
      sameFiles(host.cwd, before);
    });

    it("refuses a plan that drops a derivation's source and keeps the derived key", async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      edit(host.cwd, 'naming.json', (plan) => {
        entryOf(plan, 'home_top_headline').adopt = false;
      });
      const before = filesOf(host.cwd);
      expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(1);
      expect(host.stderr()).toContain('home_top_headline: home_share_description derives from it — adopt both or neither');
      sameFiles(host.cwd, before);
    });

    it('takes --plan or --plan-out, and --plan-out never with --write', async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      expect(await host.run('register', '--from', 'scan', '--plan', 'a.json', '--plan-out', 'b.json')).toBe(2);
      expect(host.stderr()).toContain('usage: stet register takes --plan or --plan-out, not both');
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'b.json', '--write')).toBe(2);
      expect(host.stderr()).toContain(
        'usage: stet register --plan-out writes the plan alone — run --plan with --write to apply it',
      );
      expect(host.exists('b.json')).toBe(false);
    });

    it('--plan-out refuses a file that exists and is not a plan, and replaces an earlier plan', async () => {
      const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
      // A case-insensitive disk (macOS's default) reads `INDEX.html` as the page itself.
      const folds = existsSync(join(host.cwd, 'INDEX.html'));
      for (const rel of ['index.html', ...(folds ? ['INDEX.html'] : []), 'stet.config.json', 'content/descriptor.json']) {
        const bytes = readFileSync(join(host.cwd, rel));
        host.err.length = 0;
        expect(await host.run('register', '--from', 'scan', '--plan-out', rel)).toBe(1);
        expect(host.stderr()).toBe(
          `error: --plan-out ${rel}: the file exists and is not a stet plan — name a new file, or an earlier plan to replace`,
        );
        expect(readFileSync(join(host.cwd, rel)).equals(bytes), rel).toBe(true);
      }
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'p.json')).toBe(0);
      const first = host.file('p.json');
      write(host.cwd, 'index.html', ROLES.replace('Questions asked', 'Questions we get'));
      expect(await host.run('register', '--from', 'scan', '--plan-out', 'p.json')).toBe(0);
      expect(host.file('p.json')).not.toBe(first);
      expect((JSON.parse(host.file('p.json')) as PlanFile).made['index.html']).toBe(fileHash(host.cwd, 'index.html'));
    });

    it('passes an unedited plan, digit-first section words included', async () => {
      for (const page of [
        ROLES,
        '<!DOCTYPE html>\n<html><body>\n<section id="2col"><p>Two columns of text.</p></section>\n' +
          '<section><h2>2026 annual report</h2><p>The year in review.</p></section>\n</body></html>\n',
      ]) {
        const host = await makeHtmlHost({ files: { 'index.html': page } });
        expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
        expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(0);
        expect(host.stderr()).toBe('');
        if (page !== ROLES) {
          const keys = (JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, { section?: string }> }).keys;
          expect(keys['home_2col_paragraph']?.section).toBe('2col');
          expect(keys['home_2026_annual_report_paragraph']?.section).toBe('2026_annual_report');
        }
      }
    });
  });

  describe('on a JavaScript host', () => {
    it('--plan-out writes the plan and nothing else', async () => {
      const dir = appHost();
      const before = filesOf(dir);
      const { cap, run } = cli(dir);
      expect(await run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      expect(cap.out.join('\n')).toContain('wrote naming.json: the naming plan for 7 keys');
      sameFiles(dir, before, ['naming.json']);
      const plan = JSON.parse(read(dir, 'naming.json')) as PlanFile;
      expect(Object.keys(plan.made)).toEqual([
        'app/layout.tsx',
        'app/page.tsx',
        'app/pricing/page.tsx',
        'content/defaults.json',
        'content/descriptor.json',
      ]);
      expect(plan.keys.map((e) => e.proposed)).toEqual([
        'home_hero_headline',
        'home_hero_paragraph',
        'home_frequently_asked_headline',
        'home_frequently_asked_subheadline_1',
        'home_frequently_asked_subheadline_2',
        'pricing_page_headline',
        'pricing_footer_paragraph',
      ]);
      expect(plan.keys[0]).toMatchObject({ section: 'hero', kind: 'headline', places: ['app/page.tsx:5 <h1>'], text: 'Your week, sorted' });
    });

    it('--plan without --write shows the run and writes nothing; --write applies it', async () => {
      const dir = appHost();
      const { cap, run } = cli(dir);
      expect(await run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      edit(dir, 'naming.json', (plan) => {
        Object.assign(entryOf(plan, 'home_hero_headline'), { key: 'home_hero_title', label: 'Hero title' });
      });
      const before = filesOf(dir);
      cap.out.length = 0;
      expect(await run('register', '--from', 'scan', '--plan', 'naming.json')).toBe(0);
      expect(cap.out.join('\n')).toContain('register: run with --write to apply the plan');
      sameFiles(dir, before);
      expect(await run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(0);
      expect(read(dir, 'app/page.tsx')).toContain("{copy('home_hero_title')}");
      expect(descriptor(dir).keys['home_hero_title']).toEqual({ shape: 'text', target: 'web', section: 'hero', label: 'Hero title' });
    });

    it("refuses a name a declared copy module's property holds", async () => {
      const dir = appHost({ copyModules: ['lib/copy.ts'] });
      write(dir, 'lib/copy.ts', 'export const copy = {\n  hero_title: "The hero title",\n};\n');
      const { cap, run } = cli(dir);
      expect(await run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      edit(dir, 'naming.json', (plan) => {
        entryOf(plan, 'home_hero_paragraph').key = 'hero_title';
      });
      const before = filesOf(dir);
      expect(await run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(1);
      expect(cap.err.join('\n')).toContain(
        'home_hero_paragraph: "hero_title" is a property of lib/copy.ts, which adopts under its own name',
      );
      sameFiles(dir, before);
    });

    it('--plan-out refuses a copy module', async () => {
      const dir = appHost({ copyModules: ['src/copy.ts'] });
      write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
      const bytes = readFileSync(join(dir, 'src/copy.ts'));
      const { run } = cli(dir);
      expect(await run('register', '--from', 'scan', '--plan-out', 'src/copy.ts')).toBe(1);
      expect(readFileSync(join(dir, 'src/copy.ts')).equals(bytes)).toBe(true);
    });

    it('passes an unedited plan, a long component name included', async () => {
      const app = appHost();
      const { run } = cli(app);
      expect(await run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
      expect(await run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(0);
      expect(read(app, 'app/page.tsx')).toContain("{copy('home_frequently_asked_subheadline_2')}");

      const long = project({ managedSurfaces: ['components/**/*.tsx'] });
      write(
        long,
        'components/Long.tsx',
        'export function VeryLongComponentNameForTheMarketingHeroSection() {\n  return <section><p>Some words here</p><Image alt="A friendly face" /></section>;\n}\n',
      );
      const second = cli(long);
      expect(await second.run('register', '--from', 'scan', '--kind', 'server', '--plan-out', 'naming.json')).toBe(0);
      expect((JSON.parse(read(long, 'naming.json')) as PlanFile).keys.map((e) => e.proposed)).toEqual([
        'very_long_component_paragraph',
        'very_long_component_image_alt',
      ]);
      expect(await second.run('register', '--from', 'scan', '--kind', 'server', '--plan', 'naming.json', '--write')).toBe(0);
      expect(second.cap.err.join('\n')).toBe('');
    });
  });
});

// --- Stage-5 review ------------------------------------------------------------------

describe('register — the stage-5 review', () => {
  afterAll(cleanupCliHosts);
  const ROLES = readFileSync(fileURLToPath(new URL('./fixtures/html-host/roles.html', import.meta.url)), 'utf8');

  it("writes a --plan-out spelled /index.html where it names, never over the repo's own page (F2)", async () => {
    const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
    const page = readFileSync(join(host.cwd, 'index.html'));
    expect(await host.run('register', '--from', 'scan', '--plan-out', '/index.html')).toBe(1);
    expect(host.err).toHaveLength(1);
    expect(host.err[0]).toMatch(/^error: --plan-out \/index\.html: the plan cannot be written there — EACCES\b/);
    expect(readFileSync(join(host.cwd, 'index.html')).equals(page)).toBe(true);
  });

  it('reads and writes a plan through an absolute path (F2)', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
    const abs = join(host.cwd, 'naming.json');
    expect(await host.run('register', '--from', 'scan', '--plan-out', abs)).toBe(0);
    expect(existsSync(abs)).toBe(true);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--plan', abs)).toBe(0);
    expect(host.stderr()).toBe('');
  });

  it('refuses a --plan-out it cannot write in one line (F2)', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
    expect(await host.run('register', '--from', 'scan', '--plan-out', 'index.html/naming.json')).toBe(1);
    expect(host.err).toHaveLength(1);
    expect(host.err[0]).toMatch(/^error: --plan-out index\.html\/naming\.json: the plan cannot be written there — E[A-Z]+\b/);
  });

  it('writes no section where the plan sets it to null, on both hosts (F9)', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': ROLES } });
    expect(await host.run('register', '--from', 'scan', '--plan-out', 'naming.json')).toBe(0);
    const plan = JSON.parse(host.file('naming.json')) as { keys: Array<{ proposed: string; section: string | null }> };
    const entry = plan.keys.find((e) => e.proposed === 'home_top_headline') as { section: string | null };
    expect(entry.section).toBe('top');
    entry.section = null;
    writeFileSync(join(host.cwd, 'naming.json'), JSON.stringify(plan, null, 2));
    expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(0);
    expect(JSON.parse(host.file('content/descriptor.json')).keys['home_top_headline']).not.toHaveProperty('section');

    const dir = project({ managedSurfaces: ['app/**/*.tsx'] });
    write(dir, 'app/page.tsx', HOME);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--plan-out', 'naming.json'], cap)).toBe(0);
    const jsx = JSON.parse(read(dir, 'naming.json')) as { keys: Array<{ proposed: string; section: string | null }> };
    const hero = jsx.keys.find((e) => e.proposed === 'home_hero_headline') as { section: string | null };
    expect(hero.section).toBe('hero');
    hero.section = null;
    write(dir, 'naming.json', JSON.stringify(jsx, null, 2));
    expect(await runRegister(['--from', 'scan', '--plan', 'naming.json', '--write'], io(dir))).toBe(0);
    expect(descriptor(dir).keys['home_hero_headline']).not.toHaveProperty('section');
  });

  it("names a component prop that spells a kind as a prop, apart from the page's own <title> (F6)", async () => {
    const dir = project({ managedSurfaces: ['app/**/*.tsx'] });
    write(
      dir,
      'app/hk/page.tsx',
      'export default function Page() {\n  return (\n    <html>\n      <head><title>The page title</title></head>\n' +
        '      <body><section id="intro"><Page title="A prop that names a title" /></section></body>\n    </html>\n  );\n}\n',
    );
    expect(await runRegister(['--from', 'scan', '--kind', 'server', '--plan-out', 'naming.json'], io(dir))).toBe(0);
    const plan = JSON.parse(read(dir, 'naming.json')) as { keys: Array<{ proposed: string; kind: string }> };
    expect(plan.keys.map((e) => [e.proposed, e.kind])).toEqual(
      expect.arrayContaining([
        ['hk_page_title', 'page title'],
        ['hk_intro_page_title_prop', 'page title prop'],
      ]),
    );
  });

  it('prints its diffs and lines with control characters replaced (F5)', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': ROLES.replace('<h1>', '<!-- \u001b[2J\u001b]0;PWNED\u0007 -->\n      <h1>') },
    });
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.stdout()).not.toMatch(/[\u001b\u0007]/);
    expect(host.stdout()).toContain('�[2J');

    const dir = project({ managedSurfaces: ['app/**/*.tsx'] });
    write(dir, 'app/page.tsx', 'export default function Page() {\n  return (\n    <main>\n      {/* \u001b[2J */}\n      <h1>Your week, sorted</h1>\n    </main>\n  );\n}\n');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('\u001b');
    expect(cap.out.join('\n')).toContain('�[2J');
  });
});

/** Every file under `dir`, hashed: what "byte-identical" is measured by. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out[r] = createHash('sha256').update(readFileSync(join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

describe('register — the run without --write writes nothing (F55)', () => {
  const PAGES_INDEX = SERVER_PAGE('<main><h1>Welcome</h1><p>A paragraph of copy.</p><a href="/about">Read more</a></main>');

  it('a plain run leaves every file byte-identical; --write adds the three keys with no _2; a third run adds nothing', async () => {
    const dir = project({ router: 'pages', provider: true });
    write(dir, 'pages/index.tsx', PAGES_INDEX);
    const before = tree(dir);
    const plain = io(dir);
    expect(await runRegister(['--from', 'scan'], plain)).toBe(0);
    expect(tree(dir)).toEqual(before);
    expect(plain.out.join('\n')).toContain('+++ b/pages/index.tsx');
    expect(plain.out.at(-1)).toBe('register: run with --write to add 3 keys and apply the leaf edits');

    const applied = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], applied)).toBe(0);
    expect(Object.keys(descriptor(dir).keys).sort()).toEqual(['home_page_headline', 'home_page_link_text', 'home_page_paragraph']);
    expect(applied.out.slice(-3)).toEqual([
      'pages/index.tsx: rewrote 9 edits',
      'wrote content/descriptor.json, content/defaults.json and the codegen modules: 3 keys added',
      'register: applied',
    ]);
    expect(read(dir, 'pages/index.tsx')).toContain("copy('home_page_headline')");

    const third = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], third)).toBe(0);
    expect(third.out).toEqual(['register: nothing to adopt']);
  });

  it('a copy-module-only run prints adopts and writes nothing; --write lands it', async () => {
    const dir = project({ copyModules: ['src/copy.ts'] });
    write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
    const before = tree(dir);
    const plain = io(dir);
    expect(await runRegister(['--from', 'scan'], plain)).toBe(0);
    expect(plain.out).toEqual(['adopts footer_note = A working name', 'register: run with --write to add 1 key']);
    expect(tree(dir)).toEqual(before);

    const applied = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], applied)).toBe(0);
    expect(applied.out).toEqual([
      'adopted footer_note = A working name',
      'wrote content/descriptor.json, content/defaults.json and the codegen modules: 1 key added',
      'register: adopted as record — there are no source edits to apply',
    ]);
    expect(defaults(dir).default['footer_note']).toBe('A working name');
  });

  it('a batch refused part-way (an unwritable leaf) leaves every file as it was', async () => {
    const dir = project();
    write(dir, 'app/a/page.tsx', SERVER_PAGE('<h1>First page copy</h1>'));
    write(dir, 'app/b/page.tsx', SERVER_PAGE('<h1>Second page copy</h1>'));
    // The later leaf in file order cannot be written, so the batch has already
    // written the repo forms and the first leaf when it fails.
    chmodSync(join(dir, 'app/b/page.tsx'), 0o400);
    const before = tree(dir);
    let failed = false;
    try {
      await runRegister(['--from', 'scan', '--write'], io(dir));
    } catch (error) {
      failed = true;
      expect((error as Error).message).toContain('the write batch failed');
    } finally {
      chmodSync(join(dir, 'app/b/page.tsx'), 0o600);
    }
    expect(failed).toBe(true);
    expect(tree(dir)).toEqual(before);
  });
});

describe('register — a literal whose text a declared key holds reuses it (F55)', () => {
  const WEB = { shape: 'text', target: 'web' } as const;

  it('never reuses a key a page reads for its SEO', async () => {
    const dir = project({ keys: { seo_about_title: WEB }, defaults: { seo_about_title: 'About' } });
    const d = descriptor(dir) as { keys: Record<string, unknown>; pages?: unknown };
    d.pages = { about: { route: '/about', seo: { title: 'seo_about_title' } } };
    write(dir, 'content/descriptor.json', JSON.stringify(d));
    write(dir, 'app/page.tsx', SERVER_PAGE('<nav><a href="/about">About</a></nav>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('reuses');
    expect(read(dir, 'app/page.tsx')).toContain("copy('home_nav_link_text')");
  });

  it("never reuses a template's slot key", async () => {
    const dir = project({ keys: { welcome__headline: WEB }, defaults: { welcome__headline: 'Welcome aboard' } });
    const d = descriptor(dir) as { keys: Record<string, unknown>; templates?: unknown };
    d.templates = { welcome: { class: 'transactional', trigger: 'app-event', slots: ['headline'] } };
    write(dir, 'content/descriptor.json', JSON.stringify(d));
    write(dir, 'app/page.tsx', SERVER_PAGE('<nav><a href="/start">Welcome aboard</a></nav>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('reuses');
    expect(read(dir, 'app/page.tsx')).toContain("copy('home_nav_link_text')");
  });

  it('never reuses a brand__ key', async () => {
    const dir = project({ keys: { brand__name: WEB }, defaults: { brand__name: 'Acme' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Acme</h1>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('reuses');
    expect(read(dir, 'app/page.tsx')).toContain("copy('home_page_headline')");
  });

  it('reuses the orphan key a preview run left, adds no entry, mints no _2; a different text takes its own key', async () => {
    const dir = project({ keys: { home_page_headline: WEB }, defaults: { home_page_headline: 'Welcome' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<main><h1>Welcome</h1><h1>Welcome!</h1></main>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out).toContain('app/page.tsx: reuses home_page_headline = Welcome');
    expect(Object.keys(descriptor(dir).keys).sort()).toEqual(['home_page_headline', 'home_page_headline_2']);
    expect(defaults(dir).default['home_page_headline_2']).toBe('Welcome!');
    expect(cap.out).toContain(
      'wrote content/descriptor.json, content/defaults.json and the codegen modules: 1 key added, 1 reused',
    );
    const page = read(dir, 'app/page.tsx');
    expect(page).toContain("<h1>{copy('home_page_headline')}</h1>");
    expect(page).toContain("<h1>{copy('home_page_headline_2')}</h1>");
  });

  it('closes a reuse-only plain run with the leaf-edit line and writes nothing', async () => {
    const dir = project({ keys: { home_page_headline: WEB }, defaults: { home_page_headline: 'Welcome' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Welcome</h1>'));
    const before = tree(dir);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.at(-1)).toBe('register: run with --write to apply the leaf edits');
    expect(tree(dir)).toEqual(before);
  });

  it('never reuses across targets: a web literal beside an email key, an email literal beside a web key', async () => {
    const web = project({ keys: { welcome_mail: { shape: 'text', target: 'html-email' } }, defaults: { welcome_mail: 'Welcome' } });
    write(web, 'app/page.tsx', SERVER_PAGE('<h1>Welcome</h1>'));
    const webCap = io(web);
    expect(await runRegister(['--from', 'scan', '--write'], webCap)).toBe(0);
    expect(webCap.out.join('\n')).not.toContain('reuses');
    expect(read(web, 'app/page.tsx')).toContain("copy('home_page_headline')");

    const mail = project({
      managedSurfaces: ['lib/email/**/*.ts'],
      emailSurfaces: ['lib/email/**/*.ts'],
      keys: { site_greeting: WEB },
      defaults: { site_greeting: 'Welcome aboard now' },
    });
    write(
      mail,
      'lib/email/welcome.ts',
      "import { send } from './mailer';\nexport function welcome() {\n  return send({ subject: 'Welcome aboard now', to: 'a@b.co' });\n}\n",
    );
    const mailCap = io(mail);
    expect(await runRegister(['--from', 'scan', '--write'], mailCap)).toBe(0);
    expect(mailCap.out.join('\n')).not.toContain('reuses');
    expect(descriptor(mail).keys['welcome_aboard_now']).toEqual({ shape: 'text', target: 'html-email' });
  });

  it('never reuses a key that derives or declares tags', async () => {
    const dir = project({
      keys: {
        home_source: WEB,
        home_title: { shape: 'text', target: 'web', derivesFrom: 'home_source', tmpl: '{v}' },
        home_tagged: { shape: 'text', target: 'web', tags: 1 },
      },
      defaults: { home_source: 'Source text', home_title: 'Welcome', home_tagged: 'Hello there' },
    });
    write(dir, 'app/page.tsx', SERVER_PAGE('<main><h1>Welcome</h1><p>Hello there</p></main>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('reuses');
    expect(descriptor(dir).keys['home_page_headline']).toBeDefined();
    expect(descriptor(dir).keys['home_page_paragraph']).toBeDefined();
  });

  it('takes the first of two declared keys by name', async () => {
    const dir = project({ keys: { b_welcome: WEB, a_welcome: WEB }, defaults: { b_welcome: 'Welcome', a_welcome: 'Welcome' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Welcome</h1>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out).toContain('app/page.tsx: reuses a_welcome = Welcome');
    expect(read(dir, 'app/page.tsx')).toContain("copy('a_welcome')");
  });

  it('leaves a reused literal out of --plan-out', async () => {
    const dir = project({ keys: { home_page_headline: WEB }, defaults: { home_page_headline: 'Welcome' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<main><h1>Welcome</h1><p>Fresh paragraph</p></main>'));
    expect(await runRegister(['--from', 'scan', '--plan-out', 'naming.json'], io(dir))).toBe(0);
    const plan = JSON.parse(read(dir, 'naming.json')) as { keys: Array<{ proposed: string }> };
    expect(plan.keys.map((k) => k.proposed)).toEqual(['home_page_paragraph']);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--plan', 'naming.json', '--write'], cap)).toBe(0);
    expect(cap.out).toContain('app/page.tsx: reuses home_page_headline = Welcome');
    expect(read(dir, 'app/page.tsx')).toContain("copy('home_page_paragraph')");
  });

  it('reads a declared key named constructor as an own key', async () => {
    const dir = project({ keys: { constructor: WEB }, defaults: { constructor: 'Welcome' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<main><h1>Welcome</h1><p>Constructor text</p></main>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out).toContain('app/page.tsx: reuses constructor = Welcome');
    expect(read(dir, 'app/page.tsx')).toContain("copy('constructor')");
    expect(Object.keys(descriptor(dir).keys).sort()).toEqual(['constructor', 'home_page_paragraph']);
  });

  it("reuses a key declared for another page, a copy module's property, and onto a copy attribute", async () => {
    const dir = project({
      copyModules: ['src/copy.ts'],
      keys: { about_page_headline: WEB, hero_title: WEB },
      defaults: { about_page_headline: 'Welcome', hero_title: 'Our logo' },
    });
    write(dir, 'src/copy.ts', 'export const copy = {\n  hero_title: "Our logo",\n};\n');
    write(dir, 'app/page.tsx', SERVER_PAGE('<main><h1>Welcome</h1><img src="/l.png" alt="Our logo" /></main>'));
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(cap.out).toContain('app/page.tsx: reuses about_page_headline = Welcome');
    expect(cap.out).toContain('app/page.tsx: reuses hero_title = Our logo');
    const page = read(dir, 'app/page.tsx');
    expect(page).toContain("copy('about_page_headline')");
    expect(page).toContain("alt={copy('hero_title')}");
  });
});

describe('register — the alias guard runs only where a leaf edit is applied', () => {
  it('a module-only --write lands its keys on a host whose alias resolves nowhere; a leaf edit there still refuses', async () => {
    const dir = project({ tsconfig: null, copyModules: ['src/copy.ts'] });
    write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(defaults(dir).default['footer_note']).toBe('A working name');
    expect(cap.out.at(-1)).toBe('register: adopted as record — there are no source edits to apply');

    const page = SERVER_PAGE('<h1>Adopt me now</h1>');
    write(dir, 'app/page.tsx', page);
    const before = tree(dir);
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(/no tsconfig\/jsconfig path mapping/);
    expect(tree(dir)).toEqual(before);
  });
});

describe('register gives head keys their SEO bound', () => {
  afterAll(cleanupCliHosts);
  const ADVISORY = (max: number) => ({ max, severity: 'advisory' });
  const TITLE = 'Psyon — data partnerships for AI labs, sourced with consent.';
  const LONG_TITLE = 'Psyon — data partnerships for AI labs, all sourced with consent';
  const DESCRIPTION = 'Psyon sources licensed training data from the companies that already hold it.';
  const HEADLINE = 'You may already have the data<1> our AI lab partners need.</1>';
  const HEAD = 'You may already have the data our AI lab partners need. No raw data is needed to start.';
  /** psyon.ai's head at `c7b3961`: a title, a meta description and a share description derived from the headline. */
  const PSYON = (title = TITLE): string =>
    '<!DOCTYPE html>\n<html><head>\n' +
    `<title data-stet="home_page_title">${title}</title>\n` +
    `<meta name="description" content="${DESCRIPTION}" data-stet-content="home_meta_description">\n` +
    `<meta property="og:description" content="${HEAD}" data-stet-content="home_share_description">\n` +
    '</head><body>\n' +
    '<h1 data-stet="home_hero_headline">You may already have the data<span class="tail"> our AI lab partners need.</span></h1>\n' +
    '</body></html>\n';
  const psyonKeys = (): Record<string, KeyDef> => ({
    home_page_title: { shape: 'text', target: 'web' },
    home_meta_description: { shape: 'text', target: 'web' },
    home_share_description: { shape: 'text', target: 'web', derivesFrom: 'home_hero_headline', tmpl: '{v} No raw data is needed to start.' },
    home_hero_headline: { shape: 'text', target: 'web', tags: 1 },
  });
  const psyonValues = (title = TITLE) => ({ home_page_title: title, home_meta_description: DESCRIPTION, home_hero_headline: HEADLINE });
  const keysOf = (host: { file: (rel: string) => string }): Record<string, KeyDef> => JSON.parse(host.file('content/descriptor.json')).keys;

  it('gives a newly adopted title 60 and its description 160, a share title equal to the title sharing its key', async () => {
    const host = await makeHtmlHost({
      files: {
        'index.html':
          '<!DOCTYPE html>\n<html><head>\n<title>Widgets for every team, shipped</title>\n' +
          '<meta name="description" content="Widgets for every team, shipped the day you order them, with nothing to assemble.">\n' +
          '<meta property="og:title" content="Widgets for every team, shipped">\n' +
          '</head><body>\n<p>Ordinary page copy that repeats nothing.</p>\n</body></html>\n',
      },
    });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const page = host.file('index.html');
    const title = markOf(page, '<title');
    expect(markOf(page, '<meta property="og:title"')).toBe(title);
    expect(keysOf(host)[title]?.limits).toEqual(ADVISORY(60));
    expect(keysOf(host)[markOf(page, '<meta name="description"')]?.limits).toEqual(ADVISORY(160));
    expect(keysOf(host)[markOf(page, '<p')]?.limits).toBeUndefined();
  });

  it('backfills psyon’s three head keys, the derived share description among them, then adopts nothing', async () => {
    const host = await makeHtmlHost({ files: { 'index.html': PSYON(LONG_TITLE) }, keys: psyonKeys(), defaults: psyonValues(LONG_TITLE) });
    const before = [host.file('content/descriptor.json'), host.file('content/defaults.json'), host.file('index.html')];
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.out).toEqual([
      'home_page_title: limit 60 added',
      'home_meta_description: limit 160 added',
      'home_share_description: limit 160 added',
      'register: run with --write to add the SEO limit to 3 keys',
    ]);
    expect([host.file('content/descriptor.json'), host.file('content/defaults.json'), host.file('index.html')]).toEqual(before);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.out).toContain('wrote content/descriptor.json: the SEO limit added to 3 keys');
    const keys = keysOf(host);
    expect(keys['home_page_title']?.limits).toEqual(ADVISORY(60));
    expect(keys['home_meta_description']?.limits).toEqual(ADVISORY(160));
    expect(keys['home_share_description']?.limits).toEqual(ADVISORY(160));
    expect(keys['home_hero_headline']?.limits).toBeUndefined();
    expect(host.file('index.html')).toBe(before[2]);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.out).toEqual(['register: nothing to adopt']);
    // The 63-character title warns, and check still passes.
    expect(LONG_TITLE.length).toBe(63);
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(host.stderr()).toContain('home_page_title: 63 characters exceeds the 60-character limit');
  });

  it('never touches a key already carrying limits', async () => {
    const keys = psyonKeys();
    keys['home_page_title'] = { shape: 'text', target: 'web', limits: { max: 70, severity: 'hard' } };
    const host = await makeHtmlHost({ files: { 'index.html': PSYON() }, keys, defaults: psyonValues() });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.stdout()).not.toContain('home_page_title: limit');
    expect(keysOf(host)['home_page_title']?.limits).toEqual({ max: 70, severity: 'hard' });
  });

  it('gives a key marked on an og:title alone 60, and one on a title and an og:title 60', async () => {
    const page =
      '<!DOCTYPE html>\n<html><head>\n<title data-stet="both">Widgets for every team, shipped</title>\n' +
      '<meta property="og:title" content="Widgets for every team, shipped" data-stet-content="both">\n' +
      '<meta name="twitter:title" content="Widgets, shipped the same day to every team" data-stet-content="share_only">\n' +
      '</head><body>\n<p data-stet="body">Ordinary page copy that repeats nothing.</p>\n</body></html>\n';
    const host = await makeHtmlHost({
      files: { 'index.html': page },
      keys: { both: { shape: 'text', target: 'web' }, share_only: { shape: 'text', target: 'web' }, body: { shape: 'text', target: 'web' } },
      defaults: { both: 'Widgets for every team, shipped', share_only: 'Widgets, shipped the same day to every team', body: 'Ordinary page copy that repeats nothing.' },
    });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(keysOf(host)['both']?.limits).toEqual(ADVISORY(60));
    expect(keysOf(host)['share_only']?.limits).toEqual(ADVISORY(60));
    expect(keysOf(host)['body']?.limits).toBeUndefined();
  });

  it('gives a JSX head literal its bound as it mints the key', async () => {
    const dir = project();
    write(
      dir,
      'app/page.tsx',
      SERVER_PAGE('<><title>Widgets for every team, shipped</title><p>Ordinary page copy that repeats nothing.</p></>'),
    );
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const keys = descriptor(dir).keys as Record<string, KeyDef>;
    const title = Object.keys(keys).find((key) => key.endsWith('page_title')) as string;
    expect(keys[title]?.limits).toEqual(ADVISORY(60));
    expect(Object.values(keys).filter((def) => def.limits !== undefined)).toHaveLength(1);
  });
});

/**
 * A temp Astro host: `src/**\/*.astro` managed, the read path at
 * `src/lib/content.ts` imported as `@/lib/content` through its `paths` mapping,
 * and `src/copy.ts` a declared copy module re-exporting the map, as the
 * reference host's is. `keys` are declared web text keys with their values.
 */
function astroSite(
  files: Record<string, string>,
  opts: { keys?: Record<string, string>; tsconfig?: Record<string, unknown> | null; managedSurfaces?: string[] } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-astro-'));
  const tsconfig = opts.tsconfig === undefined ? { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } } : opts.tsconfig;
  if (tsconfig !== null) write(dir, 'tsconfig.json', JSON.stringify(tsconfig, null, 2));
  write(
    dir,
    'stet.config.json',
    JSON.stringify({
      project: 't',
      managedSurfaces: opts.managedSurfaces ?? ['src/**/*.astro'],
      emailSurfaces: [],
      copyModules: ['src/copy.ts'],
      readPath: { file: 'src/lib/content.ts', import: '@/lib/content' },
      router: 'astro',
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
    }),
  );
  const keys = opts.keys ?? {};
  write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: Object.fromEntries(Object.keys(keys).map((k) => [k, { shape: 'text', target: 'web' }])) }));
  write(dir, 'content/defaults.json', JSON.stringify({ default: keys }));
  write(dir, 'src/lib/content.ts', 'export const copy = (key: string): string => key;\nexport const copyMap: Record<string, string> = {};\n');
  write(dir, 'src/copy.ts', "import { copyMap } from '@/lib/content';\nexport const copy = copyMap;\n");
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}

/** A page that reads keys by property through the declared copy module. */
const BY_PROPERTY = (body: string, front = ''): string => `---\nimport { copy } from "../copy";\n${front}---\n<p>{copy.hero_sub}</p>\n${body}`;
/** A page that imports the read path's accessor and reads nothing yet. */
const BY_CALL = (body: string, front = ''): string => `---\nimport { copy } from '@/lib/content';\n${front}---\n${body}`;

/** The not-rewritten lines a run printed, by file, text and reason. */
const notRewritten = (cap: Captured): string[] => cap.out.filter((l) => l.includes(' not rewritten ('));

describe('register — the Astro rewriter (D14)', () => {
  it('reads by property, by call, or through an inserted import, as the file reads keys (T14.1)', async () => {
    const dir = astroSite(
      {
        'src/pages/index.astro': BY_PROPERTY('<h3>Fixing a word</h3>\n<p>Short promise text</p>\n'),
        'src/pages/call.astro': BY_CALL('<h3>Calling a word</h3>\n'),
        'src/pages/imports.astro': "---\nimport Card from '../components/Card.astro';\n---\n<h3>Importing a word</h3>\n",
        'src/pages/plain.astro': '---\nconst n = 1;\n---\n<h3>Plain front word</h3>\n',
        'src/pages/bare.astro': '<h3>Fenceless word here</h3>\n',
        'src/pages/noted.astro': "---\nimport x from './x'; // note\n---\n<h3>Noted word here</h3>\n",
        'src/pages/four.astro': BY_PROPERTY('<h1>Not found here</h1>\n<p>Find another way</p>\n'),
      },
      { keys: { hero_sub: 'Sub words', '404_title': 'Not found here' } },
    );
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const index = read(dir, 'src/pages/index.astro');
    expect(index).toMatch(/^---\nimport \{ copy \} from "\.\.\/copy";\n---\n<p>\{copy\.hero_sub\}<\/p>\n<h3>\{copy\.home_[a-z0-9_]+\}<\/h3>\n<p>\{copy\.home_[a-z0-9_]+\}<\/p>\n$/);
    expect(read(dir, 'src/pages/call.astro')).toMatch(/^---\nimport \{ copy \} from '@\/lib\/content';\n---\n<h3>\{copy\('call_[a-z0-9_]+'\)\}<\/h3>\n$/);
    expect(read(dir, 'src/pages/imports.astro')).toMatch(
      /^---\nimport Card from '\.\.\/components\/Card\.astro';\nimport \{ copy \} from '@\/lib\/content';\n---\n<h3>\{copy\('imports_[a-z0-9_]+'\)\}<\/h3>\n$/,
    );
    expect(read(dir, 'src/pages/plain.astro')).toMatch(/^---\nimport \{ copy \} from '@\/lib\/content';\nconst n = 1;\n---\n<h3>\{copy\('plain_[a-z0-9_]+'\)\}<\/h3>\n$/);
    expect(read(dir, 'src/pages/bare.astro')).toMatch(/^---\nimport \{ copy \} from '@\/lib\/content';\n---\n<h3>\{copy\('bare_[a-z0-9_]+'\)\}<\/h3>\n$/);
    expect(read(dir, 'src/pages/noted.astro')).toMatch(
      /^---\nimport x from '\.\/x'; \/\/ note\nimport \{ copy \} from '@\/lib\/content';\n---\n<h3>\{copy\('noted_[a-z0-9_]+'\)\}<\/h3>\n$/,
    );
    // A digit-led key cannot be read as a property: that literal alone is listed (N7).
    const four = read(dir, 'src/pages/four.astro');
    expect(four).toContain('<h1>Not found here</h1>');
    expect(four).toMatch(/<p>\{copy\.\w+\}<\/p>/);
    expect(notRewritten(cap)).toContain('src/pages/four.astro:5 "Not found here" not rewritten (404_title cannot be read as copy.404_title) — adopt by hand');
    const values = defaults(dir).default;
    expect(Object.values(values)).toEqual(expect.arrayContaining(['Fixing a word', 'Calling a word', 'Importing a word', 'Fenceless word here', 'Find another way']));
  });

  it('rewrites the copy attributes of an HTML element and refuses entities it cannot read (T14.2)', async () => {
    const page = BY_PROPERTY(
      [
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<button title="Copy" class="b" id="c">x</button>',
        '<button aria-label="Copy install command">y</button>',
        '<img alt="A team" src="/t.png"><img alt="" src="/d.png">',
        '<input placeholder="Your email">',
        '<a href="/docs" title="Tom &amp; Jerry">z</a>',
        '<a href="/a" title="&check; done">z</a>',
        '<a href="/b" title="AT&amp T">z</a>',
        '<p>&copy 2026 Acme</p>',
        '',
      ].join('\n'),
    );
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(out).toMatch(/<button title=\{copy\.\w+\} class="b" id="c">x<\/button>/);
    expect(out).toMatch(/<button aria-label=\{copy\.\w+\}>y<\/button>/);
    expect(out).toMatch(/<img alt=\{copy\.\w+\} src="\/t\.png"><img alt="" src="\/d\.png">/);
    expect(out).toMatch(/<input placeholder=\{copy\.\w+\}>/);
    expect(out).toMatch(/<a href="\/docs" title=\{copy\.\w+\}>z<\/a>/);
    expect(Object.values(defaults(dir).default)).toContain('Tom & Jerry');
    expect(out).toContain('<a href="/a" title="&check; done">z</a>');
    expect(out).toContain('<a href="/b" title="AT&amp T">z</a>');
    expect(out).toContain('<p>&copy 2026 Acme</p>');
    expect(notRewritten(cap)).toEqual([
      'src/pages/index.astro:11 "&check; done" not rewritten (an entity stet cannot read: &check;) — adopt by hand',
      'src/pages/index.astro:12 "AT&amp T" not rewritten (an entity stet cannot read: &amp T) — adopt by hand',
      'src/pages/index.astro:13 "&copy 2026 Acme" not rewritten (an entity stet cannot read: &copy 20) — adopt by hand',
    ]);
  });

  it('follows a component prop one hop and rewrites it only where every use displays it (T14.3)', async () => {
    const component = (body: string, front = ''): string => `---\n${front}const { label } = Astro.props;\n---\n${body}\n`;
    const imports = ['Head', 'Tab', 'Btn', 'Wrap', 'Cls', 'Tpl', 'Direct', 'Spread'].map((c) => `import ${c} from "../components/${c}.astro";`).join('\n');
    const dir = astroSite(
      {
        'src/components/Head.astro':
          '---\ninterface Props { label: string; sub?: string }\nconst { label, sub, flag, href } = Astro.props;\n---\n' +
          '<div style={`--f: ${flag}`}><span>{label}</span>{sub && <p>{sub}</p>}<a href={href}>go</a></div>\n',
        'src/components/Tab.astro': component('<a id={label}>{label}</a>'),
        'src/components/Btn.astro': component('<button data-tab={label}>{label}</button>'),
        'src/components/Wrap.astro': component('<Inner text={label} /><p>{label}</p>', 'import Inner from "./Inner.astro";\n'),
        'src/components/Cls.astro': component('<p class={label}>{label}</p>'),
        'src/components/Tpl.astro': component('<p>{`${label}!`}</p>'),
        'src/components/Direct.astro': '---\nconst x = 1;\n---\n<h2>{Astro.props.label}</h2>\n',
        'src/components/Spread.astro': component('<div {...Astro.props}>{label}</div>'),
        'src/components/Island.tsx': 'export default function Island(p: { label: string }) { return <b>{p.label}</b>; }\n',
        'src/pages/index.astro': BY_PROPERTY(
          [
            '<Head label="Capabilities" sub="One registry holds them all" flag="var(--x)" href="/docs" />',
            '<Tab label="Tab words here" />',
            '<Btn label="Button words here" />',
            '<Wrap label="Wrapped words here" />',
            '<Cls label="Class words here" />',
            '<Tpl label="Template words here" />',
            '<Direct label="Direct words here" />',
            '<Spread label="Spread words here" />',
            '<Island label="Island words here" client:load />',
            '<Head aria-describedby="hint error" testID="login button" event="Signup started" />',
            '<Head label="Tom &amp; Jerry" />',
            '',
          ].join('\n'),
          `${imports}\nimport Island from "../components/Island.tsx";\n`,
        ),
      },
      { keys: { hero_sub: 'Sub words' } },
    );
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toMatch(/<Head label=\{copy\.\w+\} sub=\{copy\.\w+\} flag="var\(--x\)" href="\/docs" \/>/);
    expect(out).toMatch(/<Head label=\{copy\.\w+\} \/>/);
    expect(Object.values(defaults(dir).default)).toEqual(expect.arrayContaining(['Capabilities', 'One registry holds them all', 'Tom &amp; Jerry']));
    expect(out).toContain('<Head aria-describedby="hint error" testID="login button" event="Signup started" />');
    const listed = notRewritten(cap).map((l) => l.replace(/^src\/pages\/index\.astro:\d+ /, ''));
    expect(listed).toEqual([
      '"Tab words here" not rewritten (used in code) — adopt by hand',
      '"Button words here" not rewritten (used in code) — adopt by hand',
      '"Wrapped words here" not rewritten (used in code) — adopt by hand',
      '"Class words here" not rewritten (used in code) — adopt by hand',
      '"Template words here" not rewritten (used in code) — adopt by hand',
      '"Direct words here" not rewritten (shown where stet cannot follow) — adopt by hand',
      '"Spread words here" not rewritten (shown where stet cannot follow) — adopt by hand',
      '"Island words here" not rewritten (shown where stet cannot follow) — adopt by hand',
      '"hint error" not rewritten (a prop stet does not rewrite) — adopt by hand',
      '"login button" not rewritten (a prop stet does not rewrite) — adopt by hand',
      '"Signup started" not rewritten (a prop stet does not rewrite) — adopt by hand',
    ]);
    for (const text of ['Tab words here', 'Button words here', 'Wrapped words here', 'Class words here', 'Template words here', 'Direct words here', 'Spread words here', 'Island words here']) {
      expect(out).toContain(`label="${text}"`);
    }
  });

  it('rewrites the whole content of one element inside a content brace, and nothing an attribute prints (T14.4)', async () => {
    const page = BY_PROPERTY(
      [
        '{flags.changelog && <a class="i" href="/changelog">Changelog</a>}',
        '{flag && <p>Run <b>this</b> now</p>}',
        '',
        '<div set:html={`<p>Welcome back</p>`} />',
        '',
      ].join('\n'),
      'const flags = { changelog: true };\nconst flag = true;\n',
    );
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toMatch(/\{flags\.changelog && <a class="i" href="\/changelog">\{copy\.\w+\}<\/a>\}/);
    expect(out).toContain('{flag && <p>Run <b>this</b> now</p>}');
    expect(out).toContain('<div set:html={`<p>Welcome back</p>`} />');
    expect(notRewritten(cap)).toEqual(expect.arrayContaining([
      'src/pages/index.astro:8 "Run" not rewritten (a sentence with markup inside an expression) — adopt by hand',
      'src/pages/index.astro:8 "this" not rewritten (a sentence with markup inside an expression) — adopt by hand',
    ]));
  });

  it('rewrites the copy attributes of tags inside a content brace (T14.4, PD8)', async () => {
    const page = BY_PROPERTY(
      ['{flag && <img alt="Brace alt words" src="/x.png">}', '{[1, 2].map((i) => <a href="/x" title="Brace title words">{i}</a>)}', '{flag && <img alt={flag ? "Dynamic alt words" : "Other alt words"} src="/y.png">}', ''].join('\n'),
      'const flag = true;\n',
    );
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toMatch(/\{flag && <img alt=\{copy\.\w+\} src="\/x\.png">\}/);
    expect(out).toMatch(/\{\[1, 2\]\.map\(\(i\) => <a href="\/x" title=\{copy\.\w+\}>\{i\}<\/a>\)\}/);
    expect(out).toContain('<img alt={flag ? "Dynamic alt words" : "Other alt words"} src="/y.png">');
    const values = Object.values(defaults(dir).default);
    expect(values).toEqual(expect.arrayContaining(['Brace alt words', 'Brace title words']));
    expect(values).not.toContain('Dynamic alt words');
    expect(notRewritten(cap)).toEqual([]);
    // The rewritten reads keep the names register gave them when renamed from the dashboard or `rename --propose`.
    const keys = Object.entries(defaults(dir).default).filter(([, v]) => v === 'Brace alt words' || v === 'Brace title words');
    const proposed = astroReads(await loadTypescript(), dir, loadConfig(dir), 'src/pages/index.astro', out, 'home').filter((x) => keys.some(([k]) => k === x.key));
    expect(proposed.map((x) => x.base).sort()).toEqual(keys.map(([k]) => k).sort());
  });

  it('leaves a sentence with inline markup as written until its key lands (T14.5)', async () => {
    const page = BY_PROPERTY('<p>Install: run <b>npx x init</b> and answer.</p>\n');
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    expect(read(dir, 'src/pages/index.astro')).toBe(page);
    expect(notRewritten(cap)).toEqual(['src/pages/index.astro:5 "Install: run npx x init and answer." not rewritten (stet cannot place this text) — adopt by hand']);
  });

  it('rewrites front-matter data only where every use is traced to a display (T14.6)', async () => {
    const front = [
      'const surfaces = [',
      '  { id: "a", label: "Site copy", note: "Every page holds words" },',
      '  { id: "b", label: "Email slots", note: "Every email holds words" },',
      '];',
      'const flags = { changelog: true };',
      'const groups = [',
      '  { h: "Product", links: [["Cloud waitlist", "/waitlist"], ...(flags.changelog ? [["Changelog", "/changelog"]] : []), ["All features", "/features"]] },',
      '];',
      'const tiers = [{ label: "Tier words here" }];',
      'const a1 = ["First const words"] as const;',
      'export const a2 = ["Second const words"];',
      'const a3 = ["Third const words"];',
      'const n3 = a3.length;',
      'const a4 = ["Fourth const words"];',
      'const a5 = [{ a: "Fifth const words", b: "Sixth const words" }];',
      'const g2 = [{ links: [["Seventh const words", "/seven"]] }];',
      'const g3 = [{ t: "Ninth const words", links: [{ t: "Tenth const words" }] }];',
      '',
    ].join('\n');
    const body = [
      '{surfaces.map((s) => (<a id={"x-" + s.id}><h3>{s.label}</h3><p>{s.note}</p></a>))}',
      '{groups.map((g) => (<div><p class="colhead">{g.h}</p>{g.links.map(([label, href]) => <a href={href}>{label}</a>)}</div>))}',
      '{tiers.map((t) => t.label === "SEO" && <h3>{t.label}</h3>)}',
      '{a1.map((x) => <p>{x}</p>)}',
      '{a2.map((x) => <p>{x}</p>)}',
      '{a3.map((x) => <p>{x}</p>)}',
      '<List items={a4} />',
      '{a5.map((s) => <p>{n3 ? s.a : s.b}</p>)}',
      '{g2.map((g) => g.links.map((g) => <a href={g[0]}>{g[0]}</a>))}',
      // The inner `g` is its own binding: its code use is the link's, never the heading's (N13).
      '{g3.map((g) => <div><h3>{g.t}</h3>{g.links.map((g) => <a href={g.t}>x</a>)}</div>)}',
      '',
    ].join('\n\n');
    const page = BY_PROPERTY(body, front);
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toMatch(/\{ id: "a", label: copy\.\w+, note: copy\.\w+ \},/);
    expect(out).toMatch(/\{ h: copy\.\w+, links: \[\[copy\.\w+, "\/waitlist"\], \.\.\.\(flags\.changelog \? \[\[copy\.\w+, "\/changelog"\]\] : \[\]\), \[copy\.\w+, "\/features"\]\] \},/);
    expect(out).toMatch(/const g3 = \[\{ t: copy\.\w+, links: \[\{ t: "Tenth const words" \}\] \}\];/);
    expect(out.slice(out.indexOf('---', 3))).toBe(page.slice(page.indexOf('---', 3)));
    const listed = notRewritten(cap).map((l) => l.replace(/^src\/pages\/index\.astro:\d+ /, '')).filter((l) => l.includes('words'));
    expect(listed).toEqual([
      '"Tier words here" not rewritten (used in code) — adopt by hand',
      '"First const words" not rewritten (used in code) — adopt by hand',
      '"Second const words" not rewritten (used in code) — adopt by hand',
      '"Third const words" not rewritten (used in code) — adopt by hand',
      '"Fourth const words" not rewritten (used in code) — adopt by hand',
      '"Fifth const words" not rewritten (used in code) — adopt by hand',
      '"Sixth const words" not rewritten (used in code) — adopt by hand',
      '"Seventh const words" not rewritten (used in code) — adopt by hand',
      '"Tenth const words" not rewritten (used in code) — adopt by hand',
    ]);
  });

  it('lists every text in a context it cannot rewrite safely, and rewrites the rest (T14.7)', async () => {
    const dir = astroSite(
      {
        'src/components/Slug.astro': '---\nconst t = await Astro.slots.render("default");\n---\n<h2 id={t} title={t}>{t}</h2>\n',
        'src/components/Card.astro': '---\nconst c = 1;\n---\n<div><slot /></div>\n',
        'src/styles/x.css': '.y { white-space: pre; }\n',
        'src/pages/index.astro': BY_PROPERTY(
          [
            '<pre>Preformatted words here</pre>',
            '<code>Code words here</code>',
            '<kbd>Keyboard words here</kbd>',
            '<textarea>Area words here</textarea>',
            '<svg><text>Graphic words here</text></svg>',
            '<slot>fallback words</slot>',
            '<div is:raw>Raw words here</div>',
            '<div set:html={html}>Fallback words here</div>',
            '<p>Hello {name}, welcome</p>',
            '<p>two  spaces</p>',
            '<p>a&nbsp;b</p>',
            '<Card>Plain words</Card>',
            "<Slug>Don't panic</Slug>",
            '',
          ].join('\n'),
          'import Card from "../components/Card.astro";\nimport Slug from "../components/Slug.astro";\nconst html = "";\nconst name = "x";\n',
        ),
        'src/pages/wrap.astro': BY_PROPERTY('<p>two  spaces</p>\n<p class="t">one\n  <b>x</b></p>\n<style>.t { white-space: pre-wrap; }</style>\n'),
        'src/pages/css.astro': BY_PROPERTY('<p>two  spaces</p>\n', 'import "../styles/x.css";\n'),
      },
      { keys: { hero_sub: 'Sub words' } },
    );
    const before = read(dir, 'src/pages/index.astro');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(notRewritten(cap)).toEqual([
      'src/pages/css.astro:6 "two spaces" not rewritten (spacing the page may show) — adopt by hand',
      'src/pages/index.astro:9 "Preformatted words here" not rewritten (inside <pre>) — adopt by hand',
      'src/pages/index.astro:10 "Code words here" not rewritten (inside <code>) — adopt by hand',
      'src/pages/index.astro:11 "Keyboard words here" not rewritten (inside <kbd>) — adopt by hand',
      'src/pages/index.astro:12 "Area words here" not rewritten (inside <textarea>) — adopt by hand',
      'src/pages/index.astro:13 "Graphic words here" not rewritten (inside <svg>) — adopt by hand',
      'src/pages/index.astro:14 "fallback words" not rewritten (inside <slot>) — adopt by hand',
      'src/pages/index.astro:15 "Raw words here" not rewritten (inside an element with is:raw) — adopt by hand',
      'src/pages/index.astro:16 "Fallback words here" not rewritten (inside an element with set:html) — adopt by hand',
      'src/pages/index.astro:17 "Hello" not rewritten (beside an expression) — adopt by hand',
      'src/pages/index.astro:17 ", welcome" not rewritten (beside an expression) — adopt by hand',
      'src/pages/index.astro:21 "Don\'t panic" not rewritten (shown where stet cannot follow) — adopt by hand',
      'src/pages/wrap.astro:5 "two spaces" not rewritten (spacing the page may show) — adopt by hand',
      'src/pages/wrap.astro:6 "one x" not rewritten (spacing the page may show) — adopt by hand',
    ]);
    const lines = (text: string): string[] => text.split('\n');
    const changed = lines(out).filter((line, i) => line !== lines(before)[i]);
    expect(changed).toEqual([expect.stringMatching(/^<p>\{copy\.\w+\}<\/p>$/), expect.stringMatching(/^<p>\{copy\.\w+\}<\/p>$/), expect.stringMatching(/^<Card>\{copy\.\w+\}<\/Card>$/)]);
    expect(Object.values(defaults(dir).default)).toEqual(expect.arrayContaining(['two spaces', 'a\u00a0b', 'Plain words']));
  });

  it('reads the copy binding and the form from the front matter and the markup braces alone (T14.8)', async () => {
    const files = {
      'src/pages/foreign.astro': "---\nimport copy from 'copy-to-clipboard';\n---\n<h3>Foreign words here</h3>\n<button title=\"Copy it now\">x</button>\n",
      'src/pages/unread.astro': '---\nimport { copy } from "../copy";\n---\n<h3>Module words here</h3>\n',
      'src/pages/both.astro': BY_PROPERTY("<p>{copy('b')}</p>\n<h3>Both forms here</h3>\n"),
      'src/pages/param.astro': '---\nconst items = [1];\n---\n{items.map((copy) => <p>{copy.t}</p>)}\n<h3>Parameter words here</h3>\n',
      'src/pages/rebound.astro': BY_PROPERTY(
        '{items.map((copy) => <li>Read more</li>)}\n\n{items.map(({ copy }) => <a title="Open">Read the docs</a>)}\n\n<h3>Other words here</h3>\n',
        'const items = [1];\n',
      ),
      'src/pages/adopt.astro': "<h3>Words for adopting</h3>\n<pre is:raw><code>{copy('home_page_headline')}</code></pre>\n",
      'src/pages/script.astro': BY_CALL("<h3>Script words here</h3>\n<script>const copy = document.querySelector('#c'); copy.addEventListener('click', f)</script>\n"),
      'src/pages/front.astro': BY_CALL('<h3>Front words here</h3>\n', 'const t = copy.k;\n'),
    };
    const dir = astroSite(files, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    for (const rel of ['src/pages/foreign.astro', 'src/pages/unread.astro', 'src/pages/both.astro', 'src/pages/param.astro', 'src/pages/front.astro']) {
      expect(read(dir, rel)).toBe(files[rel as keyof typeof files]);
    }
    const listed = notRewritten(cap);
    expect(listed).toEqual(
      expect.arrayContaining([
        'src/pages/foreign.astro:4 "Foreign words here" not rewritten (a foreign copy is bound in this file) — adopt by hand',
        'src/pages/foreign.astro:5 "Copy it now" not rewritten (a foreign copy is bound in this file) — adopt by hand',
        'src/pages/unread.astro:4 "Module words here" not rewritten (stet cannot tell how copy reads keys in this file) — adopt by hand',
        'src/pages/both.astro:6 "Both forms here" not rewritten (stet cannot tell how copy reads keys in this file) — adopt by hand',
        'src/pages/param.astro:5 "Parameter words here" not rewritten (stet cannot tell how copy reads keys in this file) — adopt by hand',
        'src/pages/rebound.astro:6 "Read more" not rewritten (copy is rebound here) — adopt by hand',
        'src/pages/rebound.astro:8 "Read the docs" not rewritten (copy is rebound here) — adopt by hand',
        'src/pages/front.astro:5 "Front words here" not rewritten (stet cannot tell how copy reads keys in this file) — adopt by hand',
      ]),
    );
    const rebound = read(dir, 'src/pages/rebound.astro');
    expect(rebound).toContain('{items.map((copy) => <li>Read more</li>)}\n\n{items.map(({ copy }) => <a title="Open">Read the docs</a>)}');
    expect(rebound).toMatch(/<h3>\{copy\.\w+\}<\/h3>/);
    expect(read(dir, 'src/pages/adopt.astro')).toMatch(
      /^---\nimport \{ copy \} from '@\/lib\/content';\n---\n<h3>\{copy\('adopt_[a-z0-9_]+'\)\}<\/h3>\n<pre is:raw><code>\{copy\('home_page_headline'\)\}<\/code><\/pre>\n$/,
    );
    expect(read(dir, 'src/pages/script.astro')).toMatch(/<h3>\{copy\('script_[a-z0-9_]+'\)\}<\/h3>\n<script>const copy = document/);
  });

  it("keeps every byte outside its spans, past a byte-order mark, in the file's own line endings (T14.9)", async () => {
    const crlf = '﻿<html>\r\n<body>\r\n<h3>Fixing a word</h3>\r\n</body>\r\n</html>\r\n';
    const bom = '﻿---\r\nimport { copy } from "../copy";\r\n---\r\n<p>{copy.hero_sub}</p>\r\n<h3>Byte order words</h3>\r\n';
    const dir = astroSite({ 'src/pages/crlf.astro': crlf, 'src/pages/bom.astro': bom }, { keys: { hero_sub: 'Sub words' } });
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const out = read(dir, 'src/pages/crlf.astro');
    expect(out).toMatch(/^﻿---\r\nimport \{ copy \} from '@\/lib\/content';\r\n---\r\n<html>\r\n<body>\r\n<h3>\{copy\('crlf_[a-z0-9_]+'\)\}<\/h3>\r\n<\/body>\r\n<\/html>\r\n$/);
    expect(read(dir, 'src/pages/bom.astro')).toMatch(/^﻿---\r\nimport \{ copy \} from "\.\.\/copy";\r\n---\r\n<p>\{copy\.hero_sub\}<\/p>\r\n<h3>\{copy\.bom_[a-z0-9_]+\}<\/h3>\r\n$/);
    const second = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], second)).toBe(0);
    expect(second.out.at(-1)).toBe('register: nothing to adopt');
  });

  it('lists every finding of a file whose markup does not pair, and keeps its bytes (T14.10)', async () => {
    const page = BY_PROPERTY('<div><p>Fault words here</div>\n');
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'src/pages/index.astro')).toBe(page);
    expect(notRewritten(cap)).toEqual(['src/pages/index.astro:5 "Fault words here" not rewritten (markup stet cannot pair) — adopt by hand']);
  });

  it('pairs the markup around an is:raw sample whose tags do not close (T14.10, F2)', async () => {
    const page = BY_PROPERTY('<div is:raw><span class="p">$ go</div>\n<h2>Heading after raw words</h2>\n');
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'src/pages/index.astro')).toMatch(/<div is:raw><span class="p">\$ go<\/div>\n<h2>\{copy\.\w+\}<\/h2>\n$/);
    expect(notRewritten(cap).filter((l) => l.includes('markup stet cannot pair'))).toEqual([]);
  });

  it('lists a document nested past the stack, keeps its bytes, and leaves scan running (T14.10, F3)', async () => {
    const depth = 3000;
    const page = BY_PROPERTY(`${'<div>'.repeat(depth)}<p>Deep nest words</p>${'</div>'.repeat(depth)}\n`);
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'src/pages/index.astro')).toBe(page);
    expect(notRewritten(cap).some((l) => l.includes('"Deep nest words"') && l.includes('(markup stet cannot pair)'))).toBe(true);
    expect(await runCli(['scan'], io(dir))).toBe(0);
  });

  it('reads a file whose front matter is empty (F11)', async () => {
    const dir = astroSite({ 'src/pages/index.astro': '---\n---\n<h1>Empty fence words</h1>\n' }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'src/pages/index.astro')).toMatch(/^---\nimport \{ copy \} from '@\/lib\/content';\n---\n<h1>\{copy\('\w+'\)\}<\/h1>\n$/);
    expect(notRewritten(cap)).toEqual([]);
  });

  it('links identical texts across files into one key, and keeps a head text apart (T14.11)', async () => {
    const dir = astroSite(
      {
        'src/pages/index.astro': BY_PROPERTY('<span class="w">npx x init</span>\n<p>Shared tip words</p>\n<b>Twice in one file</b>\n<i>Twice in one file</i>\n'),
        'src/components/Tip.tsx': 'export default function Tip() {\n  return <p>Shared tip words</p>;\n}\n',
      },
      { keys: { hero_sub: 'Sub words', hero_install: 'npx x init' }, managedSurfaces: ['src/**/*.astro', 'src/**/*.tsx'] },
    );
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--kind', 'server'], cap)).toBe(0);
    const page = read(dir, 'src/pages/index.astro');
    expect(cap.out).toContain('src/pages/index.astro: reuses hero_install = npx x init');
    expect(page).toContain('<span class="w">{copy.hero_install}</span>');
    const tipKey = Object.entries(defaults(dir).default).filter(([, v]) => v === 'Shared tip words').map(([k]) => k);
    expect(tipKey).toHaveLength(1);
    expect(cap.out.filter((l) => l.includes(`shares ${tipKey[0]} = Shared tip words`))).toHaveLength(1);
    expect(read(dir, 'src/components/Tip.tsx')).toContain(`{copy('${tipKey[0]}')}`);
    expect(page).toContain(`<p>{copy.${tipKey[0]}}</p>`);
    const twice = Object.entries(defaults(dir).default).filter(([, v]) => v === 'Twice in one file').map(([k]) => k);
    expect(twice).toHaveLength(1);
    expect(cap.out).toContain(`src/pages/index.astro: shares ${twice[0]} = Twice in one file`);

    // A head text never reads a visible key (R32).
    const app = project({ keys: { nav_pricing: { shape: 'text', target: 'web' } }, defaults: { nav_pricing: 'Pricing' } });
    write(app, 'app/page.tsx', SERVER_PAGE('<><title>Pricing</title><a href="/p">Pricing</a></>'));
    const jsx = io(app);
    expect(await runRegister(['--from', 'scan', '--write'], jsx)).toBe(0);
    const written = read(app, 'app/page.tsx');
    expect(written).toMatch(/<title>\{copy\('home_page_title'\)\}<\/title>/);
    expect(written).toContain(`<a href="/p">{copy('nav_pricing')}</a>`);
    expect(defaults(app).default['home_page_title']).toBe('Pricing');
  });

  it('names a shared key after the home page, then the shallowest route, then the file path (PD13)', async () => {
    const dir = astroSite(
      {
        'src/pages/gallery.astro': BY_CALL('<button>For developers</button>\n<p>Shared tie words</p>\n'),
        'src/pages/index.astro': BY_CALL('<button>For developers</button>\n'),
        'src/pages/about/team.astro': BY_CALL('<p>Shared deep words</p>\n'),
        'src/pages/zeta.astro': BY_CALL('<p>Shared deep words</p>\n<p>Shared tie words</p>\n<p>Shared part words</p>\n'),
        'src/components/Part.astro': BY_CALL('<p>Shared part words</p>\n'),
      },
      { keys: { hero_sub: 'Sub words' } },
    );
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(notRewritten(cap)).toEqual([]);
    const keyOf = (text: string): string[] => Object.entries(defaults(dir).default).filter(([, v]) => v === text).map(([k]) => k);
    // The home page, then the shallowest route (zeta over about/team), then the file path (gallery over zeta), a route before a component.
    expect(keyOf('For developers')).toEqual([expect.stringMatching(/^home_/)]);
    expect(keyOf('Shared deep words')).toEqual([expect.stringMatching(/^zeta_/)]);
    expect(keyOf('Shared tie words')).toEqual([expect.stringMatching(/^gallery_/)]);
    expect(keyOf('Shared part words')).toEqual([expect.stringMatching(/^zeta_/)]);
    // The followers, met before their leader's file in path order, read the leader's key.
    expect(read(dir, 'src/pages/gallery.astro')).toContain(`<button>{copy('${keyOf('For developers')[0]}')}</button>`);
    expect(read(dir, 'src/components/Part.astro')).toContain(`<p>{copy('${keyOf('Shared part words')[0]}')}</p>`);

    const app = project();
    write(app, 'app/gallery/page.tsx', SERVER_PAGE('<button>For developers</button>'));
    write(app, 'app/page.tsx', SERVER_PAGE('<button>For developers</button>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(app))).toBe(0);
    const shared = Object.entries(defaults(app).default).filter(([, v]) => v === 'For developers').map(([k]) => k);
    expect(shared).toEqual([expect.stringMatching(/^home_/)]);
    expect(read(app, 'app/gallery/page.tsx')).toContain(`{copy('${shared[0]}')}`);
  });

  it('adopts nothing the second time, and scan reports none of the rewritten texts (T14.12)', async () => {
    const dir = astroSite(
      {
        'src/components/Head.astro': '---\nconst { label, sub } = Astro.props;\n---\n<span>{label}</span>{sub && <p>{sub}</p>}\n',
        'src/pages/index.astro': BY_PROPERTY(
          '<h3>Fixing a word</h3>\n<button title="Copy install command">x</button>\n<Head label="Capabilities" sub="One registry holds them all" />\n' +
            '{flags.changelog && <a class="i" href="/changelog">Changelog</a>}\n\n{surfaces.map((s) => <h3>{s.label}</h3>)}\n',
          'import Head from "../components/Head.astro";\nconst flags = { changelog: true };\nconst surfaces = [{ label: "Site copy" }];\n',
        ),
        'src/pages/bare.astro': '<h3>Fenceless word here</h3>\n',
      },
      { keys: { hero_sub: 'Sub words' } },
    );
    expect(await runRegister(['--from', 'scan', '--write'], io(dir))).toBe(0);
    const after = { index: read(dir, 'src/pages/index.astro'), bare: read(dir, 'src/pages/bare.astro') };
    const second = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], second)).toBe(0);
    expect(second.out.at(-1)).toBe('register: nothing to adopt');
    expect({ index: read(dir, 'src/pages/index.astro'), bare: read(dir, 'src/pages/bare.astro') }).toEqual(after);
    const scan = io(dir);
    await runCli(['scan'], scan);
    const said = [...scan.out, ...scan.err].join('\n');
    for (const text of ['Fixing a word', 'Copy install command', 'Capabilities', 'One registry holds them all', 'Changelog', 'Site copy', 'Fenceless word here']) {
      expect(said).not.toContain(text);
    }
  });

  it('rewrites only what scan reported: a template is listed, code spillover is neither rewritten nor listed (T14.13)', async () => {
    const page = BY_PROPERTY('<template><p>Template words here</p></template>\n<nav>{prev && (\n  <a href={prev.href}>Previous page</a>\n)}</nav>\n', 'const prev = null;\n');
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toContain('<template><p>Template words here</p></template>\n<nav>{prev && (\n');
    expect(notRewritten(cap)).toEqual(['src/pages/index.astro:6 "Template words here" not rewritten (inside <template>) — adopt by hand']);
  });

  it('shows its diffs without --write, lists its keys in a plan, and leaves a planned-out text (T14.14)', async () => {
    const page = BY_PROPERTY('<h3>Fixing a word</h3>\n<p>Short promise text</p>\n');
    const dir = astroSite({ 'src/pages/index.astro': page }, { keys: { hero_sub: 'Sub words' } });
    const forms = [read(dir, 'content/descriptor.json'), read(dir, 'content/defaults.json')];
    const dry = io(dir);
    expect(await runRegister(['--from', 'scan'], dry)).toBe(0);
    expect(dry.out.join('\n')).toContain('+++ b/src/pages/index.astro');
    expect(dry.out.at(-1)).toBe('register: run with --write to add 2 keys and apply the leaf edits');
    expect([read(dir, 'src/pages/index.astro'), read(dir, 'content/descriptor.json'), read(dir, 'content/defaults.json')]).toEqual([page, ...forms]);
    expect(await runCli(['register', '--from', 'scan', '--plan-out', 'naming.json'], io(dir))).toBe(0);
    const plan = JSON.parse(read(dir, 'naming.json')) as { keys: Array<Record<string, unknown>> };
    expect(plan.keys.map((e) => [e['text'], e['places']])).toEqual([
      ['Fixing a word', [expect.stringMatching(/^src\/pages\/index\.astro:5 /)]],
      ['Short promise text', [expect.stringMatching(/^src\/pages\/index\.astro:6 /)]],
    ]);
    (plan.keys[0] as Record<string, unknown>)['adopt'] = false;
    writeFileSync(join(dir, 'naming.json'), JSON.stringify(plan, null, 2));
    expect(await runCli(['register', '--from', 'scan', '--plan', 'naming.json', '--write'], io(dir))).toBe(0);
    const out = read(dir, 'src/pages/index.astro');
    expect(out).toContain('<h3>Fixing a word</h3>');
    expect(out).toMatch(/<p>\{copy\.\w+\}<\/p>/);
  });

  it('refuses an inserting run whose import resolves nowhere, writing nothing (T14.15)', async () => {
    const page = '<h3>Fenceless word here</h3>\n';
    const dir = astroSite({ 'src/pages/bare.astro': page }, { tsconfig: null });
    const forms = [read(dir, 'content/descriptor.json'), read(dir, 'content/defaults.json')];
    await expect(runRegister(['--from', 'scan', '--write'], io(dir))).rejects.toThrow(/readPath\.import is '@\/lib\/content'/);
    expect([read(dir, 'src/pages/bare.astro'), read(dir, 'content/descriptor.json'), read(dir, 'content/defaults.json')]).toEqual([page, ...forms]);
  });

  it('lists a follower whose leader was not rewritten, on Astro and JSX alike (T14.17)', async () => {
    // The first file's markup holds a brace that does not parse, so its rewrite does not read back.
    const dir = astroSite({ 'src/pages/a.astro': '<h3>Shared words here</h3>\n<p>{1 +}</p>\n', 'src/pages/b.astro': '<h3>Shared words here</h3>\n' });
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write'], cap)).toBe(0);
    expect(read(dir, 'src/pages/b.astro')).toBe('<h3>Shared words here</h3>\n');
    expect(notRewritten(cap)).toEqual([
      'src/pages/a.astro:1 "Shared words here" not rewritten (the rewrite did not read back cleanly) — adopt by hand',
      'src/pages/b.astro:1 "Shared words here" not rewritten (the text it shares was not rewritten) — adopt by hand',
    ]);

    const planned = astroSite({ 'src/pages/a.astro': '<h3>Planned words here</h3>\n', 'src/pages/b.astro': '<h3>Planned words here</h3>\n' });
    expect(await runCli(['register', '--from', 'scan', '--plan-out', 'naming.json'], io(planned))).toBe(0);
    const plan = JSON.parse(read(planned, 'naming.json')) as { keys: Array<Record<string, unknown>> };
    (plan.keys[0] as Record<string, unknown>)['adopt'] = false;
    writeFileSync(join(planned, 'naming.json'), JSON.stringify(plan, null, 2));
    const out = io(planned);
    expect(await runCli(['register', '--from', 'scan', '--plan', 'naming.json', '--write'], out)).toBe(0);
    expect(read(planned, 'src/pages/b.astro')).toBe('<h3>Planned words here</h3>\n');
    expect(notRewritten(out)).toEqual(['src/pages/b.astro:1 "Planned words here" not rewritten (the text it shares was not rewritten) — adopt by hand']);

    // A JSX leader the rewrite refuses (a foreign copy) leaves its follower with the same line.
    const jsx = project({ managedSurfaces: ['components/**/*.tsx'] });
    write(jsx, 'components/A.tsx', "import copy from 'copy-to-clipboard';\nexport default function A() {\n  return <p>The footer line.</p>;\n}\n");
    write(jsx, 'components/B.tsx', 'export default function B() {\n  return <p>The footer line.</p>;\n}\n');
    const both = io(jsx);
    expect(await runRegister(['--from', 'scan', '--write', '--kind', 'server'], both)).toBe(0);
    expect(read(jsx, 'components/B.tsx')).not.toContain('copy(');
    expect(notRewritten(both)).toEqual(['components/B.tsx:2 "The footer line." not rewritten (the text it shares was not rewritten) — adopt by hand']);
  });

  it('lists the page title and description for pages scan, and keeps other head text apart from visible keys (T14.18)', async () => {
    const dir = astroSite(
      {
        'src/layouts/Base.astro':
          '---\nconst { title } = Astro.props;\n---\n<html><head><title>{title}</title><meta name="description" content="Shared layout words"></head><body><slot /></body></html>\n',
        'src/layouts/Slotted.astro': '---\nconst x = 1;\n---\n<html><head><title><slot name="title" /></title></head><body><slot /></body></html>\n',
        'src/components/Share.astro':
          '---\nconst { t, u } = Astro.props;\n---\n<p>{t}</p>\n<meta property="og:title" content={t} />\n<meta property="og:url" content={u} />\n<p>{u}</p>\n',
        'src/pages/pricing.astro':
          '---\nimport Share from "../components/Share.astro";\n---\n<html><head><title>Pricing plans</title><meta name="description" content="Plain words">' +
          '<meta property="og:title" content="Share this page"><meta name="twitter:description" content="Short words here">' +
          '<link rel="alternate" title="stet changelog" href="/rss.xml"></head>\n<body>\n<h1>Pricing words here</h1>\n<script type="application/ld+json">{"a": 1}</script>\n' +
          '<svg><title>Close menu</title></svg>\n<Share t="Shown both ways" u="Two words" />\n</body></html>\n',
        'src/pages/plans.astro': '---\nimport Base from "../layouts/Base.astro";\n---\n<Base title="Pricing plans"><h1>Plans words here</h1></Base>\n',
        'src/pages/changes.astro': '---\nconst x = "y";\n---\n<html><head><title>{`stet — ${x}`}</title></head><body><h1>Changes words here</h1></body></html>\n',
        'src/pages/slotted.astro':
          '---\nimport Slotted from "../layouts/Slotted.astro";\nimport Lost from "../layouts/Lost.astro";\n---\n<Slotted><Fragment slot="title">Slotted title words</Fragment></Slotted>\n' +
          '<Lost><Fragment slot="title">Lost title words</Fragment></Lost>\n',
      },
      { keys: { nav_changelog: 'stet changelog' } },
    );
    const before = read(dir, 'src/pages/pricing.astro');
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--write', '--verbose'], cap)).toBe(0);
    const listed = notRewritten(cap);
    expect(listed).toEqual(
      expect.arrayContaining([
        'src/layouts/Base.astro:4 "Shared layout words" not rewritten (a page description stet pages scan cannot bind: set in a layout every page shares) — adopt by hand',
        'src/pages/pricing.astro:4 "Pricing plans" not rewritten (SEO text — adopt it with stet pages scan) — adopt by hand',
        'src/pages/pricing.astro:4 "Plain words" not rewritten (SEO text — adopt it with stet pages scan) — adopt by hand',
        'src/pages/pricing.astro:9 "Shown both ways" not rewritten (shown in the page and in its head) — adopt by hand',
        'src/pages/pricing.astro:9 "Two words" not rewritten (used in code) — adopt by hand',
        'src/pages/plans.astro:4 "Pricing plans" not rewritten (SEO text — adopt it with stet pages scan) — adopt by hand',
        'src/pages/changes.astro:4 "{`stet — $" not rewritten (a page title stet pages scan cannot bind: written as an expression) — adopt by hand',
        'src/pages/slotted.astro:5 "Slotted title words" not rewritten (a page title stet pages scan cannot bind: shown where stet cannot follow) — adopt by hand',
        'src/pages/slotted.astro:6 "Lost title words" not rewritten (shown where stet cannot follow) — adopt by hand',
      ]),
    );
    expect(cap.out).toContain('src/pages/pricing.astro:7: structured data — edit it in the file');
    const out = read(dir, 'src/pages/pricing.astro');
    expect(out).toContain('<title>Pricing plans</title><meta name="description" content="Plain words">');
    expect(out).toMatch(/<meta property="og:title" content=\{copy\('\w+'\)\}><meta name="twitter:description" content=\{copy\('\w+'\)\}><link rel="alternate" title=\{copy\('\w+'\)\} href="\/rss\.xml">/);
    expect(out).not.toContain('nav_changelog');
    expect(out).toContain('<script type="application/ld+json">{"a": 1}</script>');
    expect(out).toMatch(/<svg><title>\{copy\('\w+'\)\}<\/title><\/svg>/);
    const holding = Object.entries(defaults(dir).default).filter(([, v]) => v === 'stet changelog').map(([k]) => k);
    expect(holding).toHaveLength(2);
    expect(holding).toContain('nav_changelog');
  });
});

/**
 * `stet register --from scan` — adopt scanned literals. Each case runs
 * `runRegister` over a temp project, then asserts the descriptor/default it
 * added, the ONE import + ONE `const copy` per file, the collision suffix, the
 * never-touch-a-published-value guarantee, idempotence, the server/client
 * choice, and every refusal (ambiguous, no-provider, foreign `copy`).
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

import { runRegister } from '../cli/register.js';
import { runCli, type CliIo } from '../cli/main.js';
import { planDocuments, planHtmlRegister } from '../cli/html-host.js';
import { fileHash } from '../cli/key-plan.js';
import { Report } from '../cli/report.js';
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

  it('a client rewrite with no CopyProvider mounted is skipped with a mount-first message', async () => {
    const dir = project({ provider: false });
    write(dir, 'app/widget.tsx', CLIENT_WIDGET('<h1>Needs provider</h1>'));
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(descriptor(dir).keys['widget_headline']).toBeUndefined();
    expect(cap.err.join('\n')).toContain('CopyProvider');
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
  const REFUSED = '---\nconst t = 1;\n---\n<h1>Chapter</h1>\n';

  /**
   * `copyModules` is empty by construction, so the module loop never runs and
   * the count is the surface loop's own — the two loops share ONE collection,
   * and this pins which one filled it.
   */
  function refusingHost(count: number): string {
    const dir = project({ managedSurfaces: ['src/**/*.astro'], copyModules: [] });
    for (let i = 0; i < count; i++) write(dir, `src/pages/p${i}.astro`, REFUSED);
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
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toEqual([]);
    // Below the adopted lines and above nothing else it displaced.
    expect(cap.out.join('\n')).toContain('register: nothing to adopt');
  });

  it('--verbose restores every per-file line', async () => {
    const dir = refusingHost(5);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--verbose'], cap)).toBe(0);
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toHaveLength(5);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('prints two refusals as before', async () => {
    const dir = refusingHost(2);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(cap.out.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toHaveLength(2);
    expect(cap.out.join('\n')).not.toContain('run with --verbose to list them');
  });

  it('prints the count BELOW the adopted-key lines', async () => {
    // The refusals moved from interleaved-in-loop to one block, and the block's
    // position is part of the contract: what the run ACHIEVED reads first, and
    // what it could not read follows. One adoptable module beside four refusals
    // is the smallest host that can tell the two orders apart.
    const dir = project({ managedSurfaces: ['src/**/*.astro'], copyModules: ['src/copy.ts'] });
    for (let i = 0; i < 4; i++) write(dir, `src/pages/p${i}.astro`, REFUSED);
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
    const dir = project({ managedSurfaces: ['src/**/*.astro'], copyModules: ['mod/**/*.astro'] });
    for (let i = 0; i < 3; i++) write(dir, `src/pages/p${i}.astro`, REFUSED);
    for (let i = 0; i < 2; i++) write(dir, `mod/m${i}.astro`, REFUSED);
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan', '--verbose'], cap)).toBe(0);
    expect(cap.out.filter((l) => l.includes('could not be parsed cleanly'))).toHaveLength(5);

    // …and collapsed, the count is 5 — one run, one number.
    const collapsed = io(dir);
    expect(await runRegister(['--from', 'scan'], collapsed)).toBe(0);
    expect(collapsed.out.join('\n')).toContain('5 file(s) could not be parsed cleanly');

    // A file BOTH globs match is refused once: the walked map hands the module
    // loop the surface loop's own verdict rather than a second parse.
    const dual = project({ managedSurfaces: ['both/**/*.astro'], copyModules: ['both/**/*.astro'] });
    write(dual, 'both/one.astro', REFUSED);
    const dualCap = io(dual);
    expect(await runRegister(['--from', 'scan'], dualCap)).toBe(0);
    expect(dualCap.out.filter((l) => l.includes('could not be parsed cleanly'))).toEqual([
      'both/one.astro: could not be parsed cleanly — reported, not adopted',
    ]);
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
    expect(out).toContain('+      <h3 data-stet="home_qualify_headline_2">');
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
    expect(holding).toEqual(['home_contact_button_text', 'home_nav_link_text', 'home_qualify_headline_1']);
    expect(values['home_nav_link_text']).toBe('How it works');
    expect(values['home_qualify_headline_1']).toBe('How it works.');
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
    // The heading shares the key, so the section's one other headline goes unnumbered.
    expect(descriptor(shared).keys['home_qualify_headline_2']).toBeUndefined();
    expect(descriptor(shared).keys['home_qualify_headline']).toBeDefined();
    expect(readFileSync(join(shared, 'index.html'), 'utf8')).toContain(
      '<h3 data-stet="existing_heading">',
    );

    const email = htmlProject({
      keys: { existing_heading: { shape: 'text', target: 'html-email' } },
      defaults: { existing_heading: 'Software, product and engineering histories' },
    });
    await runRegister(['--from', 'scan', '--write'], io(email));
    expect(descriptor(email).keys['home_qualify_headline_2']).toEqual({
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

describe('register derives head texts', () => {
  afterAll(cleanupCliHosts);
  const DERIVE = readFileSync(fileURLToPath(new URL('./fixtures/html-host/derive.html', import.meta.url)), 'utf8');
  /** The key a written document marks `<open tag start>` with, read back from the page. */
  const markOf = (page: string, open: string, attr = '(?:-content)?'): string => {
    const found = new RegExp(`${open}[^>]*? data-stet${attr}="([^"]+)"`).exec(page);
    if (found === null) throw new Error(`no mark on ${open}`);
    return found[1] as string;
  };
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
    expect(keys[title]).toEqual({ shape: 'text', target: 'web', derivesFrom: h1, tmpl: '{v}' });
    expect(keys[description]).toEqual({ shape: 'text', target: 'web', derivesFrom: p, tmpl: '{v} Book a call.' });
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
    expect(d.keys[share]).toEqual({ shape: 'text', target: 'web', derivesFrom: h1, tmpl: '{v} No raw data is needed to start.' });
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
      expect(d.keys['share']).toEqual({ shape: 'text', target: 'web', derivesFrom: 'hero', tmpl: '{v} No raw data is needed to start.' });
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
      expect(d.keys['t']).toEqual({ shape: 'text', target: 'web' });
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
    expect(host.out).toEqual([DERIVES, "register: run with --write to derive 1 key from the page's visible text"]);
    expect(forms()).toEqual(before);
    expect(readFileSync(join(host.cwd, 'index.html'))).toEqual(page);

    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.out).toEqual([
      DERIVES,
      "wrote content/descriptor.json and content/defaults.json: 1 key now derived from the page's visible text; their documents are unchanged",
      'register: applied',
    ]);
    expect(JSON.parse(host.file('content/descriptor.json')).keys.share).toEqual({
      derivesFrom: 'hero',
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
    expect(host.out.slice(-2)).toEqual([
      DERIVES,
      "register: run with --write to apply 1 mark across 1 document and derive 1 key from the page's visible text",
    ]);
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(host.out.slice(-4)).toEqual([
      DERIVES,
      'wrote content/descriptor.json, content/defaults.json and 1 document: 1 key added, 0 shared',
      "wrote content/descriptor.json and content/defaults.json: 1 key now derived from the page's visible text; their documents are unchanged",
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
    'home_faq_headline_1',
    'home_faq_paragraph_1',
    'home_faq_headline_2',
    'home_faq_paragraph_2',
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
    expect(keys['home_faq_paragraph_2']?.section).toBe('faq');
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
        'home_frequently_asked_headline_1',
        'home_frequently_asked_headline_2',
        'home_frequently_asked_headline_3',
        'pricing_page_headline',
        'pricing_footer_paragraph',
      ].sort(),
    );
    expect(keys['home_hero_headline_2']?.section).toBe('hero');
    expect(keys['home_hero_paragraph']?.section).toBe('hero');
    expect(keys['home_frequently_asked_headline_3']?.section).toBe('frequently_asked');
    expect(keys['pricing_footer_paragraph']?.section).toBe('footer');
    expect(keys['pricing_page_headline']).not.toHaveProperty('section');
    const home = read(dir, 'app/page.tsx');
    for (const name of ['home_hero_headline_2', 'home_hero_paragraph', 'home_frequently_asked_headline_1', 'home_frequently_asked_headline_3']) {
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
        'home_faq_headline_1',
        'home_faq_paragraph_1',
        'home_faq_headline_2',
        'home_faq_paragraph_2',
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
        entryOf(plan, 'home_faq_headline_1').key = 'home_faq_question';
        entryOf(plan, 'home_faq_headline_2').key = 'home_faq_question';
        entryOf(plan, 'home_top_headline').label = 'x'.repeat(61);
      });
      const before = filesOf(host.cwd);
      expect(await host.run('register', '--from', 'scan', '--plan', 'naming.json', '--write')).toBe(1);
      expect(host.err).toEqual([
        'error: stet register: naming.json is refused — nothing written',
        'error: home_top_headline: its label is longer than 60 characters',
        'error: home_top_paragraph_1: "home_hero__eyebrow" uses "__", which names a template slot or the brand group',
        'error: home_faq_headline_1 and home_faq_headline_2: both are named "home_faq_question"',
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
        'home_frequently_asked_headline_1',
        'home_frequently_asked_headline_2',
        'home_frequently_asked_headline_3',
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
      expect(read(app, 'app/page.tsx')).toContain("{copy('home_frequently_asked_headline_3')}");

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

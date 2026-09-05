/**
 * `stet register --from scan` — adopt scanned literals. Each case runs
 * `runRegister` over a temp project, then asserts the descriptor/default it
 * added, the ONE import + ONE `const copy` per file, the collision suffix, the
 * never-touch-a-published-value guarantee, idempotence, the server/client
 * choice, and every refusal (ambiguous, no-provider, foreign `copy`).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runRegister } from '../cli/register.js';
import type { CliIo } from '../cli/main.js';

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
  it('without --write writes descriptor+default and prints a diff, edits no source', async () => {
    const dir = project();
    const before = SERVER_PAGE('<h1>Adopt me now</h1>');
    write(dir, 'app/page.tsx', before);
    const cap = io(dir);
    const code = await runRegister(['--from', 'scan'], cap);
    expect(code).toBe(0);
    expect(descriptor(dir).keys['adopt_me_now']).toEqual({ shape: 'text', target: 'web' });
    expect(defaults(dir).default['adopt_me_now']).toBe('Adopt me now');
    expect(cap.out.join('\n')).toContain('+++ b/app/page.tsx'); // a diff was shown
    expect(read(dir, 'app/page.tsx')).toBe(before); // source untouched
  });

  it('--write applies the leaf rewrite and inserts the server read-path import', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Server copy</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const edited = read(dir, 'app/page.tsx');
    expect(edited).toContain("import { copy } from '@/lib/content'");
    expect(edited).toContain("{copy('server_copy')}");
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
    expect(edited).toContain("{copy('first_copy')}");
    expect(edited).toContain("{copy('second_copy')}");
  });

  it('a colliding proposed key gets a _2 suffix', async () => {
    const dir = project({ keys: { your_week: { shape: 'text', target: 'web' } }, defaults: { your_week: 'existing' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Your week</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(descriptor(dir).keys['your_week_2']).toBeDefined();
    expect(read(dir, 'app/page.tsx')).toContain("{copy('your_week_2')}");
  });

  it('never alters an existing published value', async () => {
    const dir = project({ keys: { hero_headline: { shape: 'text', target: 'web' } }, defaults: { hero_headline: 'Live headline' } });
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Brand new copy</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(descriptor(dir).keys['hero_headline']).toEqual({ shape: 'text', target: 'web' });
    expect(defaults(dir).default['hero_headline']).toBe('Live headline');
    expect(descriptor(dir).keys['brand_new_copy']).toBeDefined();
  });

  it('is idempotent — a re-scan after --write finds zero literals', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', SERVER_PAGE('<h1>Once only</h1>'));
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(cap.out.join('\n')).toContain('nothing to adopt');
    // only one key exists — the second run added none
    expect(Object.keys(descriptor(dir).keys)).toEqual(['once_only']);
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
    expect(descriptor(dir).keys['ambiguous_copy']).toBeUndefined();

    const dir2 = project();
    write(dir2, 'app/widget.tsx', SERVER_PAGE('<h1>Ambiguous copy</h1>'));
    await runRegister(['--from', 'scan', '--write', '--kind', 'server'], io(dir2));
    expect(read(dir2, 'app/widget.tsx')).toContain("{copy('ambiguous_copy')}");
  });

  it('a client rewrite with no CopyProvider mounted is skipped with a mount-first message', async () => {
    const dir = project({ provider: false });
    write(dir, 'app/widget.tsx', CLIENT_WIDGET('<h1>Needs provider</h1>'));
    const cap = io(dir);
    await runRegister(['--from', 'scan', '--write'], cap);
    expect(cap.err.join('\n')).toContain('CopyProvider');
    expect(descriptor(dir).keys['needs_provider']).toBeUndefined();
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
    expect(cap.err.join('\n')).toContain('foreign');
    expect(descriptor(dir).keys['press_me']).toBeUndefined();
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
    expect(read(dir, 'content/stet-env.d.ts')).toContain('fresh_key_here');
    expect(read(dir, 'content/keys.ts')).toContain('fresh_key_here');
    expect(read(dir, 'content/defaults.ts')).toContain('fresh_key_here');
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
    expect(read(matched, 'app/page.tsx')).toContain("{copy('resolved_onto_it')}");
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
    expect(read(covered, 'app/page.tsx')).toContain("{copy('tilde_covered')}");

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
    expect(read(matched, 'app/page.tsx')).toContain("{copy('carved_out')}");
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
    expect(read(prefixed, 'app/page.tsx')).toContain("{copy('prefix_covered')}");

    // An exact-key mapping is legal tsconfig that the `/*`-only grammar of
    // init's own probe never emits, and it covers by equality.
    const exact = project({ tsconfig: { compilerOptions: { paths: { '@/lib/content': ['./lib/content.ts'] } } } });
    write(exact, 'app/page.tsx', SERVER_PAGE('<h1>Exactly covered</h1>'));
    expect(await runRegister(['--from', 'scan', '--write'], io(exact))).toBe(0);
    expect(read(exact, 'app/page.tsx')).toContain("{copy('exactly_covered')}");
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
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
    expect(descriptor(dir).keys['hero_headline']).toEqual({ shape: 'text', target: 'web' });
    expect(defaults(dir).default['hero_headline']).toBe('Change the content');
    // A suffixed module key forks the registry from the module it was read out
    // of, so `freeKey` is never reached for a module shape.
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
    expect(await runRegister(['--from', 'scan'], io(dir))).toBe(0);
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
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
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
    const cap = io(dir);
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);

    // Both halves landed: the leaf's derived key and the module's own name.
    expect(descriptor(dir).keys['adopt_this_leaf']).toBeDefined();
    expect(descriptor(dir).keys['footer_note']).toBeDefined();
    const out = cap.out.join('\n');
    // A diff for the leaf, an `adopted` line for the property — each half
    // reports in its own register, in one run.
    expect(out).toContain('+++ b/app/page.tsx');
    expect(out).toContain('adopted footer_note = A working name');
    expect(out).not.toContain('+++ b/src/copy.ts');
    // `added` SUMS both loops and the shared write block runs exactly once, so
    // the codegen is written once rather than per loop.
    expect(out).toContain('and the codegen modules: 2 keys added');
    expect(cap.out.filter((l) => l.includes('and the codegen modules'))).toHaveLength(1);
    // There IS a leaf edit pending here, so the closing line says so.
    expect(out).toContain('register: run with --write to apply the leaf edits');
    // Neither file was touched without --write.
    expect(read(dir, 'app/page.tsx')).toBe(page);
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
    expect(read(dir, 'app/page.tsx')).toContain("copy('adopt_this_leaf')");
    // …and the opted-out literal is still opted out.
    expect(descriptor(dir).keys['secret_key']).toBeUndefined();
    expect(descriptor(dir).keys['do_not_adopt_this']).toBeUndefined();
    expect(defaults(dir).default['secret_key']).toBeUndefined();
  });

  it('adds nothing on a second run, and never rewrites the module', async () => {
    const dir = project({ copyModules: ['src/copy.ts'] });
    write(dir, 'src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
    const before = read(dir, 'src/copy.ts');
    expect(await runRegister(['--from', 'scan'], io(dir))).toBe(0);
    const after = read(dir, 'content/descriptor.json');

    const second = io(dir);
    expect(await runRegister(['--from', 'scan'], second)).toBe(0);
    expect(second.out.join('\n')).toContain('register: nothing to adopt');
    expect(read(dir, 'content/descriptor.json')).toBe(after);
    // `--write` is the source-edit gate, and a module shape has no source edit.
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
    expect(await runRegister(['--from', 'scan'], cap)).toBe(0);
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
    expect(out).toContain('+      <h3 data-stet="software_product_and_engineering">');
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
    expect(keys['you_may_already_have_the_data_our_ai']).toEqual({
      shape: 'text',
      target: 'web',
      tags: 1,
    });
    expect(defaults(dir).default['you_may_already_have_the_data_our_ai']).toBe(
      'You may already have the data<1> our AI lab partners need.</1>',
    );
    // `&amp;` read back as the character it denotes.
    expect(defaults(dir).default['research_development_notes']).toBe('Research & development notes.');

    // The document is byte-identical outside the inserted attributes.
    const written = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(Buffer.from(written.replace(/ data-stet[^ >]*="[^"]*"/g, ''), 'utf8')).toEqual(
      Buffer.from(PAGE, 'utf8'),
    );
    expect(written.match(/data-stet/g)).toHaveLength(28);
  });

  it('shares one key for identical text and suffixes the rest in document order', async () => {
    const dir = htmlProject();
    await runRegister(['--from', 'scan', '--write'], io(dir));
    const keys = Object.keys(descriptor(dir).keys).filter((k) => k.startsWith('how_it_works'));
    expect(keys.sort()).toEqual(['how_it_works', 'how_it_works_2', 'how_it_works_3']);
    const values = defaults(dir).default;
    expect(values['how_it_works']).toBe('How it works');
    expect(values['how_it_works_2']).toBe('How it works.');
    expect(values['how_it_works_3']).toBe('How it works →');
    // One key, marked on BOTH links.
    const page = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(page.match(/data-stet="how_it_works"/g)).toHaveLength(2);
  });

  it('marks a link carrying both text and a copy title with both, in the stated order', async () => {
    const dir = htmlProject();
    await runRegister(['--from', 'scan', '--write'], io(dir));
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '<a href="/book" title="Book now" data-stet="book_now" data-stet-title="book_now">',
    );
  });

  it('shares an existing web text key, and never an email one', async () => {
    const shared = htmlProject({
      keys: { existing_heading: { shape: 'text', target: 'web' } },
      defaults: { existing_heading: 'Software, product and engineering histories' },
    });
    await runRegister(['--from', 'scan', '--write'], io(shared));
    expect(descriptor(shared).keys['software_product_and_engineering']).toBeUndefined();
    expect(readFileSync(join(shared, 'index.html'), 'utf8')).toContain(
      '<h3 data-stet="existing_heading">',
    );

    const email = htmlProject({
      keys: { existing_heading: { shape: 'text', target: 'html-email' } },
      defaults: { existing_heading: 'Software, product and engineering histories' },
    });
    await runRegister(['--from', 'scan', '--write'], io(email));
    expect(descriptor(email).keys['software_product_and_engineering']).toEqual({
      shape: 'text',
      target: 'web',
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

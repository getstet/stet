/**
 * `stet eject` where the optional `typescript` peer is not there.
 *
 * Its own file because `vi.mock` is file-scoped and shadows ANY real
 * resolution — an ambient `node_modules/typescript` in an ancestor directory
 * included, which is exactly why the site's own eject never hit this and a
 * fixture under a typescript-free tree is the only place it can be proven
 * (`init-no-typescript.test.ts` and `email-doctor-no-typescript.test.ts` stand
 * alone for the same reason).
 *
 * The gate is the backstop's own import-position pattern, run over the managed
 * surfaces plus the configured root layout with the stet-written files
 * excluded. Zero matches is provably nothing to un-rewrite — a register rewrite
 * always inserts an import that pattern matches — so every compiler-free step
 * proceeds. Nonzero refuses `--write` by count, and plan-only prints the
 * section unverifiable and still exits nonzero, because the plan it printed is
 * the one it could not verify.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('typescript', () => {
  const error = new Error("Cannot find package 'typescript' imported from eject") as Error & { code?: string };
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
});

import { runEject } from '../cli/eject.js';
import { packageRoot } from '../cli/installed.js';
import type { CliIo } from '../cli/main.js';

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8');

interface Captured extends CliIo {
  out: string[];
}
function io(dir: string): Captured {
  const out: string[] = [];
  return { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: () => {}, out };
}

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

/** A host with the guidance block, the shipped hook and the dependency — every typescript-free step. */
function host(opts: { config?: Record<string, unknown>; files: Record<string, string> }): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-eject-nots-'));
  const config = opts.config ?? BASE_CONFIG;
  write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
  write(dir, 'stet.config.json', JSON.stringify(config));
  write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: { hero: { shape: 'text', target: 'web' } } }));
  write(dir, 'content/defaults.json', JSON.stringify({ default: { hero: 'Hello world' } }));
  write(dir, 'content/defaults.ts', "export const DEFAULTS = { default: { hero: 'Hello world' } } as const;\n");
  write(
    dir,
    'AGENTS.md',
    '<!-- stet:agent-guidance:begin -->\nCopy in this project is stet-managed.\n<!-- stet:agent-guidance:end -->\n',
  );
  write(dir, 'package.json', JSON.stringify({ name: 'host', dependencies: { '@getstet/stet': '^1.0.0' } }, null, 2));
  // A real git repo carrying the shipped pre-commit hook, so the hook removal
  // is exercised rather than skipped for want of a hooks directory.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.git/hooks/pre-commit'), readFileSync(join(packageRoot(), 'templates', 'pre-commit'), 'utf8'));
  for (const [rel, text] of Object.entries(opts.files)) write(dir, rel, text);
  return dir;
}

describe('runEject — typescript absent', () => {
  it('ejects END TO END where no host file imports the accessor', async () => {
    // A JS host that never adopted a leaf: nothing to un-rewrite, and nothing
    // else eject does needs a compiler. Before F8 this host could not eject at
    // all — the compiler load was unconditional and came first.
    const dir = host({
      files: {
        'app/layout.tsx': 'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
        'app/page.tsx': 'export default function Page() {\n  return <h1>Hello world</h1>;\n}\n',
      },
    });
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    const out = cap.out.join('\n');

    expect(out).toContain('un-rewrite: nothing to reverse (no stet imports in the managed surfaces)');
    // Every typescript-free step ran: guidance gone, hook gone, snapshot
    // written, dependency dropped.
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false);
    expect(JSON.parse(read(dir, 'content/defaults.json')).default.hero).toBe('Hello world');
    expect(read(dir, 'content/defaults.ts')).toContain('Hello world');
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
  });

  it('refuses --write by count where a surface file DOES import the accessor', async () => {
    const dir = host({
      files: {
        'app/layout.tsx': 'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': "import { createServerCopy } from '@getstet/stet/react';\nexport const copy = createServerCopy({} as never, {});\n",
      },
    });
    const pkgBefore = read(dir, 'package.json');
    await expect(runEject(['--write'], io(dir))).rejects.toThrow(
      /cannot reverse the accessor calls without typescript: 1 file\(s\)/,
    );
    await expect(runEject(['--write'], io(dir))).rejects.toThrow(/npm i -D typescript/);
    // Nothing was written: the guidance, the hook and the dependency all stand.
    expect(read(dir, 'package.json')).toBe(pkgBefore);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(true);
  });

  it('plan-only prints the un-rewrite as unverifiable and STILL exits nonzero', async () => {
    const dir = host({
      files: {
        'app/layout.tsx': 'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
        'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('hero')}</h1>; }\n",
        'lib/content.ts': "import { createServerCopy } from '@getstet/stet/react';\nexport const copy = createServerCopy({} as never, {});\n",
      },
    });
    const cap = io(dir);
    // Never `toBe(0)`: with the loop gated off the backstop reads un-edited
    // text, every stet-importing file is a survivor, and the deferred refusal
    // fires. That is the honest exit — the plan could not be verified.
    await expect(runEject([], cap)).rejects.toThrow(/still importing stet/);
    const out = cap.out.join('\n');
    expect(out).toContain('un-rewrite: unverifiable — typescript is not installed (1 file(s) import the accessor)');
    expect(out).toContain('still imports stet: app/page.tsx');
    // The unverifiable line prints ABOVE the survivors lines.
    expect(cap.out.findIndex((l) => l.startsWith('un-rewrite: unverifiable'))).toBeLessThan(
      cap.out.findIndex((l) => l.startsWith('still imports stet:')),
    );
    // And NO kept line: with the loop gated off, the consumers verdict read
    // un-edited text and would name imports the un-rewrite itself removes.
    // Claiming a file is kept on the strength of a plan nobody could verify is
    // the one thing this output must not do.
    expect(out).not.toContain(': kept — imported by');
  });

  it('still names a kept deletion in the ZERO-shape, where the compiler was never needed', async () => {
    // The contrast that keeps the suppression honest: nothing imports the
    // accessor, so the un-rewrite had nothing to verify and the consumers
    // verdict stands on its own. `lib/copy.ts` imports the read path
    // relatively, which the stet-import pattern does not match, so the file is
    // kept and the run still completes.
    const dir = host({
      files: {
        'app/layout.tsx': 'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
        'app/page.tsx': 'export default function Page() {\n  return <h1>Hello world</h1>;\n}\n',
        'lib/content.ts': "const VALUES = { hero: 'Hello world' };\nexport const copy = (k) => VALUES[k];\n",
        'lib/copy.ts': "import { copy } from './content';\nexport const hero = () => copy('hero');\n",
      },
    });
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    const out = cap.out.join('\n');
    expect(out).toContain('un-rewrite: nothing to reverse (no stet imports in the managed surfaces)');
    expect(out).toContain('lib/content.ts: kept — imported by lib/copy.ts');
    expect(out).not.toContain('un-wire');
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(true);
  });

  it('counts the configured root layout, which a JS host keeps outside its globs', async () => {
    // The live shape of that config: jsx globs with a mounted `app/layout.js`
    // that no glob matches. A mounted provider needs the compiler at ZERO
    // accessor calls, so the layout has to be in the counted surface.
    const dir = host({
      config: {
        ...BASE_CONFIG,
        managedSurfaces: ['app/**/*.jsx'],
        rootLayout: 'app/layout.js',
        readPath: { file: 'lib/content.js', import: '@/lib/content' },
      },
      files: {
        'app/layout.js':
          "import { CopyProvider } from '@getstet/stet/react';\n" +
          'export default function RootLayout({ children }) {\n' +
          '  return <html><body><CopyProvider>{children}</CopyProvider></body></html>;\n' +
          '}\n',
        'app/page.jsx': 'export default function Page() { return <h1>Hello world</h1>; }\n',
      },
    });
    await expect(runEject(['--write'], io(dir))).rejects.toThrow(
      /cannot reverse the accessor calls without typescript: 1 file\(s\)/,
    );
  });

  it('does not count the files eject writes or deletes itself', async () => {
    // A host whose globs happen to cover the generated modules must not read as
    // having rewrites: eject deletes or regenerates those files itself.
    const dir = host({
      config: { ...BASE_CONFIG, managedSurfaces: ['**/*.ts', '**/*.tsx'] },
      files: {
        'app/layout.tsx': 'export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
        'app/page.tsx': 'export default function Page() {\n  return <h1>Hello world</h1>;\n}\n',
        'lib/content.ts': "import { createServerCopy } from '@getstet/stet/react';\nexport const copy = createServerCopy({} as never, {});\n",
        'content/stet-env.d.ts':
          "import '@getstet/stet';\ndeclare module '@getstet/stet' { interface StetRegistry { keys: 'hero'; } }\n",
      },
    });
    const cap = io(dir);
    expect(await runEject(['--write'], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('un-rewrite: nothing to reverse (no stet imports in the managed surfaces)');
    expect(existsSync(join(dir, 'lib/content.ts'))).toBe(false);
    expect(existsSync(join(dir, 'content/stet-env.d.ts'))).toBe(false);
    expect(JSON.parse(read(dir, 'package.json')).dependencies['@getstet/stet']).toBeUndefined();
  });
});

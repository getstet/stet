/**
 * A project on disk, for driving the CLI in process.
 *
 * `runCli` takes its cwd, environment, output and store from the caller, so a
 * case here is a real command run — argument parsing, config loading,
 * resolution, store calls, exit code — with no child process and no
 * infrastructure. The injected memory store is what makes a multi-command
 * scenario possible at all: a fresh process would build a new empty store
 * between `draft` and `publish` and lose the row.
 *
 * The host is the mini-project fixture plus the two generated files the
 * fixture directory does not carry, because a project without them has no
 * currency section for `check` and `doctor` to report on.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { MemoryStore } from '../adapters/store-memory.js';
import { runCli, type CliIo } from '../cli/main.js';
import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { loadDescriptor, loadSnapshot, type StoreAdapter } from '../src/index.js';

const FIXTURE = new URL('./fixtures/mini-project/', import.meta.url);
const made: string[] = [];

/** Every temp host this run created. Each test file calls it from `afterAll`. */
export function cleanupCliHosts(): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.length = 0;
}

export interface CliHost {
  cwd: string;
  io: CliIo;
  out: string[];
  err: string[];
  run(...argv: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  json<T>(): T;
  file(rel: string): string;
  exists(rel: string): boolean;
}

export interface CliHostOptions {
  /** `null` writes no config file at all — the bare-repo case. */
  config?: Record<string, unknown> | null;
  store?: StoreAdapter;
  /** One store per environment, keyed by selector — how a case drives `--env`. */
  stores?: Record<string, StoreAdapter>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
}

export function makeCliHost(opts: CliHostOptions = {}): CliHost {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-cli-'));
  made.push(cwd);
  mkdirSync(join(cwd, 'content'));
  for (const name of ['descriptor.json', 'defaults.json']) {
    cpSync(new URL(name, FIXTURE), join(cwd, 'content', name));
  }

  const descriptor = loadDescriptor(
    JSON.parse(readFileSync(join(cwd, 'content/descriptor.json'), 'utf8')),
  );
  const snapshot = loadSnapshot(
    JSON.parse(readFileSync(join(cwd, 'content/defaults.json'), 'utf8')),
  );
  const registry = generateRegistry(descriptor);
  writeFileSync(join(cwd, 'content/keys.ts'), registry.keysTs);
  writeFileSync(join(cwd, 'content/stet-env.d.ts'), registry.dts);
  writeFileSync(join(cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));

  const config = opts.config === undefined ? { store: { adapter: 'memory' } } : opts.config;
  if (config !== null) writeFileSync(join(cwd, 'stet.config.json'), JSON.stringify(config, null, 2));

  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd,
    env: opts.env ?? {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...(opts.store === undefined ? {} : { store: opts.store }),
    ...(opts.stores === undefined ? {} : { stores: opts.stores }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  };

  return {
    cwd,
    io,
    out,
    err,
    run: (...argv: string[]) => runCli(argv, io),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    json: <T>() => JSON.parse(out[out.length - 1] ?? 'null') as T,
    file: (rel: string) => readFileSync(join(cwd, rel), 'utf8'),
    exists: (rel: string) => {
      try {
        readFileSync(join(cwd, rel));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface AdoptionHost {
  cwd: string;
  io: CliIo;
  out: string[];
  err: string[];
  run(...argv: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  file(rel: string): string;
  exists(rel: string): boolean;
  write(rel: string, text: string): void;
  /** Every host source file's text, for the whole-host "no stet import" grep. */
  allText(): string;
}

/**
 * A bare Next App-Router repo for the host-rewriting walk (`init`/`scan`/
 * `register`/`eject`/`hook`). `init` detects the layout and scaffolds into it;
 * the page carries one unkeyed literal for scan/register to adopt. Everything
 * lands in a temp dir cleaned by `cleanupCliHosts`.
 */
export function makeAdoptionHost(
  opts: {
    page?: string;
    env?: NodeJS.ProcessEnv;
    store?: StoreAdapter;
    yes?: boolean;
    /** `false` declares no react and writes no root layout — the Astro shape init must also serve. */
    react?: boolean;
  } = {},
): AdoptionHost {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-adopt-'));
  made.push(cwd);
  const put = (rel: string, text: string): void => {
    const path = join(cwd, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };
  const react = opts.react ?? true;
  put(
    'package.json',
    JSON.stringify(
      { name: 'host', dependencies: react ? { '@getstet/stet': '^1.0.0', react: '^18' } : { '@getstet/stet': '^1.0.0' } },
      null,
      2,
    ),
  );
  // BOTH shapes carry a root layout: the react-less host needs one for the
  // mount path to be reachable at all, which is what makes "no provider is
  // mounted there" an assertion rather than an accident of the fixture.
  put(
    'app/layout.tsx',
    react
      ? 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
        '  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n'
      : 'export default function RootLayout({ children }: { children: unknown }) {\n' +
        '  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n',
  );
  // The `@/*` alias a Next host is generated with. It is what `init` probes for
  // `readPath.import` and what `register --write` verifies before it writes a
  // rewrite around that specifier — a host declaring none is refused.
  put('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }, null, 2));
  put('app/page.tsx', opts.page ?? 'export default function Page() {\n  return <h1>Your week, sorted</h1>;\n}\n');

  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd,
    env: opts.env ?? {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...(opts.store === undefined ? {} : { store: opts.store }),
  };

  const allText = (): string => {
    let text = '';
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) text += readFileSync(p, 'utf8');
      }
    };
    walk(cwd);
    return text;
  };

  return {
    cwd,
    io,
    out,
    err,
    run: (...argv: string[]) => runCli(argv, io),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    file: (rel: string) => readFileSync(join(cwd, rel), 'utf8'),
    exists: (rel: string) => existsSync(join(cwd, rel)),
    write: put,
    allText,
  };
}

/** A store that records every call, so "it never dialed" is assertable. */
export function countingStore(inner: StoreAdapter): StoreAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    project: inner.project,
    canApplyDDL: inner.canApplyDDL,
    read: (q) => {
      calls.push('read');
      return inner.read(q);
    },
    saveDraft: (p) => {
      calls.push('saveDraft');
      return inner.saveDraft(p);
    },
    publish: (p) => {
      calls.push('publish');
      return inner.publish(p);
    },
    revert: (p) => {
      calls.push('revert');
      return inner.revert(p);
    },
    rename: (p) => {
      calls.push('rename');
      return inner.rename(p);
    },
    history: (q) => {
      calls.push('history');
      return inner.history(q);
    },
    recent: (q) => {
      calls.push('recent');
      return inner.recent(q);
    },
    // Forwarded whole: this wrapper counts the seven methods, and the
    // capability is the wrapped store's own.
    changesets: inner.changesets,
  };
}

/** The store a crashed seed run leaves behind: the first publish never lands. */
export function publishFailsOnce(inner: MemoryStore): StoreAdapter {
  let failed = false;
  return {
    ...inner,
    publish: (p) => {
      if (failed) return inner.publish(p);
      failed = true;
      return Promise.resolve({
        storeError: true as const,
        code: 'unreachable' as const,
        message: 'simulated crash between saveDraft and publish',
      });
    },
  };
}

/** One canned HTTP response — `doctor --url` and the PostgREST meta reads. */
export function fakeFetch(body: string, status = 200): typeof globalThis.fetch {
  return (async () => new Response(body, { status })) as typeof globalThis.fetch;
}

// --- The static-HTML host ---------------------------------------------------

/** The shared fixture documents every html section reads. */
const HTML_FIXTURE = new URL('../tests/fixtures/html-host/', import.meta.url);

/** One of the shared fixture documents, by name. */
export function htmlFixture(name: string): string {
  return readFileSync(new URL(name, HTML_FIXTURE), 'utf8');
}

export interface HtmlHostOptions {
  /** Repo-relative path → content. `index.html` defaults to the shared fixture page. */
  files?: Record<string, string>;
  /** Merged over the config this writes. */
  config?: Record<string, unknown>;
  /** Descriptor keys and default values, where a case wants them pre-declared. */
  keys?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  /** Run `register --from scan --write`, so the host arrives with its marks. */
  register?: boolean;
  /** `git init` the checkout — what "publish is a commit" needs to be true. */
  git?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * A static-HTML host in a temp directory: the shared fixture page, an html
 * config, and empty forms — the shape `stet init` writes on that host, built
 * directly so a case does not depend on `init` to reach `check` or `pull`.
 *
 * `register: true` adopts it first, which is the state most cases start from.
 * The output buffers are cleared after any setup run, so a case reads only its
 * own lines.
 */
export async function makeHtmlHost(opts: HtmlHostOptions = {}): Promise<CliHost> {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-html-'));
  made.push(cwd);
  writeFileSync(
    join(cwd, 'package.json'),
    `${JSON.stringify({ name: 'site', private: true, devDependencies: { '@getstet/stet': '^0.1.2' } }, null, 2)}\n`,
  );
  const files = { 'index.html': htmlFixture('index.html'), ...opts.files };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text, 'utf8');
  }
  mkdirSync(join(cwd, 'content'), { recursive: true });
  writeFileSync(
    join(cwd, 'content/descriptor.json'),
    `${JSON.stringify({ version: 1, keys: opts.keys ?? {} }, null, 2)}\n`,
  );
  writeFileSync(
    join(cwd, 'content/defaults.json'),
    `${JSON.stringify({ default: opts.defaults ?? {} }, null, 2)}\n`,
  );
  writeFileSync(
    join(cwd, 'stet.config.json'),
    `${JSON.stringify(
      {
        project: 'default',
        host: 'html',
        managedSurfaces: ['**/*.html'],
        emailSurfaces: [],
        copyModules: [],
        scan: { severity: 'warn', baseline: '.stet/scan-baseline.json' },
        descriptorPath: 'content/descriptor.json',
        snapshotPath: 'content/defaults.json',
        bundlePath: '.stet/bundle.json',
        locales: { default: 'default', enabled: ['default'] },
        ...opts.config,
      },
      null,
      2,
    )}\n`,
  );
  if (opts.git === true) execFileSync('git', ['init'], { cwd, stdio: 'ignore' });

  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd,
    env: opts.env ?? {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  const host: CliHost = {
    cwd,
    io,
    out,
    err,
    run: (...argv: string[]) => runCli(argv, io),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    json: <T,>() => JSON.parse(out[out.length - 1] ?? 'null') as T,
    file: (rel: string) => readFileSync(join(cwd, rel), 'utf8'),
    exists: (rel: string) => existsSync(join(cwd, rel)),
  };
  if (opts.register === true) {
    const code = await host.run('register', '--from', 'scan', '--write');
    if (code !== 0) throw new Error(`register failed in the html fixture host: ${host.stderr()}`);
    out.length = 0;
    err.length = 0;
  }
  return host;
}

/**
 * A folder an `init` has NOT yet touched: the fixture page, a manifest naming
 * only stet, and a git checkout. What the adoption walk starts from.
 */
export function bareHtmlHost(files: Record<string, string> = {}): CliHost {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-html-bare-'));
  made.push(cwd);
  writeFileSync(
    join(cwd, 'package.json'),
    `${JSON.stringify({ name: 'site', private: true, devDependencies: { '@getstet/stet': '^0.1.2' } }, null, 2)}\n`,
  );
  for (const [rel, text] of Object.entries({ 'index.html': htmlFixture('index.html'), ...files })) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text, 'utf8');
  }
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });

  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { cwd, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  return {
    cwd,
    io,
    out,
    err,
    run: (...argv: string[]) => runCli(argv, io),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    json: <T,>() => JSON.parse(out[out.length - 1] ?? 'null') as T,
    file: (rel: string) => readFileSync(join(cwd, rel), 'utf8'),
    exists: (rel: string) => existsSync(join(cwd, rel)),
  };
}

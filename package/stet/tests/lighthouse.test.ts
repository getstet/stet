/**
 * `stet audit lighthouse` with the runner injected through `io.lighthouse`: the
 * flags and their refusals, the run in order, the first line by target, the
 * footprint lines, the progress on stderr, the target down, and the one
 * `finally` that ends what the run started. The html host's documents are
 * served by the real HTTP/2 front; Chrome is never started.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http, { ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { INIT_READ_IMPORT } from '../cli/footprint.js';
import { ChromeMissing, type LighthouseResult } from '../cli/lighthouse-run.js';
import { runCli, type CliIo } from '../cli/main.js';
import { PREVIEW_COMMANDS, readWorkspace, updateSite } from '../cli/workspace.js';
import { cleanLhr, fakeLighthouse, savedLhr, type FakeLighthouse } from './helpers/lighthouse.js';
import { BUILT_BIN, builtBinExists } from './helpers/stet-shim.js';

const HTML_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'html-host');

interface Host {
  cwd: string;
  out: string[];
  err: string[];
  io: CliIo;
  run: (...argv: string[]) => Promise<number>;
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
}

function host(cwd: string, extra: Partial<CliIo> = {}): Host {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { cwd, env: { STET_WORKSPACE: join(cwd, '.no-workspace.json') }, stdout: (l) => out.push(l), stderr: (l) => err.push(l), ...extra };
  return { cwd, out, err, io, run: (...argv) => runCli(['audit', 'lighthouse', ...argv], io) };
}

/** A copy of the html-host fixture's documents, `home` declared at `/` (or no page at all). */
function htmlHost(fake: FakeLighthouse | null, opts: { pages?: Record<string, { route: string }> } = {}): Host {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-'));
  for (const name of ['index.html', 'edges.html']) cpSync(join(HTML_FIXTURE, name), join(cwd, name));
  write(cwd, 'stet.config.json', JSON.stringify({ project: 't', host: 'html', managedSurfaces: ['**/*.html'] }));
  write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {}, pages: opts.pages ?? { home: { route: '/' } } }));
  write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
  return host(cwd, fake === null ? {} : { lighthouse: fake.start });
}

/** A Next-shaped JavaScript host, 0.6.0's footprint optional: init's read path line and a mount no client reads. */
function nextHost(fake: FakeLighthouse | null, opts: { footprint?: boolean } = {}): Host {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-next-'));
  write(cwd, 'stet.config.json', JSON.stringify({ project: 't', managedSurfaces: ['app/**/*.tsx'] }));
  write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {}, pages: { home: { route: '/' } } }));
  write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
  const mount = opts.footprint === true ? "import { CopyProvider } from '@getstet/stet/react';\n" : '';
  write(
    cwd,
    'app/layout.tsx',
    `${mount}export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>${opts.footprint === true ? '<CopyProvider descriptor={d} resolved={r}>{children}</CopyProvider>' : '{children}'}</body></html>;\n}\n`,
  );
  write(cwd, 'lib/content.ts', `${opts.footprint === true ? INIT_READ_IMPORT : "import { createServerCopy } from '@getstet/stet/react/server';"}\nexport const copy = createServerCopy(d, r);\n`);
  const answering = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  return host(cwd, { ...(fake === null ? {} : { lighthouse: fake.start }), fetchImpl: answering });
}

describe('stet audit lighthouse — the html host (journey C11)', () => {
  it("measures the fixture's documents: the first line, the page line, the findings and the closing line", async () => {
    const fake = fakeLighthouse({ '/': savedLhr('index.html') });
    const h = htmlHost(fake);
    const listeners = process.listenerCount('SIGINT');
    expect(await h.run()).toBe(0);
    const out = h.out.join('\n');
    expect(h.out[0]).toMatch(/^lighthouse 13\.5\.0 · mobile · https:\/\/127\.0\.0\.1:\d+\/ serves the checkout's documents as deployed \(HTTP\/2\)$/);
    expect(out).toContain('index.html  /  Performance 100 · Accessibility 89 · Best Practices 96 · SEO 100');
    expect(out).toContain(
      '  copy  label  index.html:50 <textarea name="notes"> has no label — give it id="notes" and write a <label for="notes">; stet register adopts its words as home_contact_label',
    );
    expect(out).toContain('  host  errors-in-console  /bench.jpg and /favicon.ico answered 404 — add the files, or drop the references');
    expect(h.out[h.out.length - 1]).toBe('1 page · 3 failing audits · stet fixes 1 (copy) · the host owns 2');
    expect(fake.starts).toEqual([true]);
    expect(fake.runs.map((r) => new URL(r.url).pathname)).toEqual(['/']);
    expect(fake.closed).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('audits / alone where no page is declared, and refuses --pages naming no page on a JavaScript host', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = htmlHost(fake, { pages: {} });
    expect(await h.run()).toBe(0);
    expect(h.out).toContain('no pages declared — audited / alone; run stet pages scan to declare them');
    expect(fake.runs).toHaveLength(1);
    const next = nextHost(fake);
    write(next.cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
    expect(await next.run('--url', 'http://127.0.0.1:3999/', '--pages', 'home')).toBe(2);
    expect(next.err.join('\n')).toContain('stet audit lighthouse --pages: home is not a declared page');
    expect(fake.starts).toHaveLength(1);
  });

  it('prints the median of five, the audit lines from the first run', async () => {
    const scores = [92, 99, 92, 100, 92];
    const fake = fakeLighthouse({
      '/': (n: number): LighthouseResult => {
        const lhr = n === 0 ? savedLhr('index.html') : cleanLhr();
        (lhr.categories['performance'] as { score: number | null }).score = (scores[n] as number) / 100;
        return lhr;
      },
    });
    const h = htmlHost(fake);
    expect(await h.run('--runs', '5')).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('index.html  /  Performance 92 (median of 5: 92 · 99 · 92 · 100 · 92) · Accessibility 100');
    expect(out).toContain('copy  label');
    expect(h.err).toEqual(['auditing home… 1/5', 'auditing home… 2/5', 'auditing home… 3/5', 'auditing home… 4/5', 'auditing home… 5/5']);
  });

  it('writes the progress to stderr in both modes, and stdout holds the report alone', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const plain = htmlHost(fake);
    expect(await plain.run('--runs', '2')).toBe(0);
    expect(plain.err).toEqual(['auditing home… 1/2', 'auditing home… 2/2']);
    expect(plain.out.join('\n')).not.toContain('auditing');
    const json = htmlHost(fake);
    expect(await json.run('--runs', '2', '--json')).toBe(0);
    expect(json.err).toEqual(['auditing home… 1/2', 'auditing home… 2/2']);
    expect(json.out).toHaveLength(1);
    const parsed = JSON.parse(json.out[0] as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['findings', 'fixes', 'footprint', 'lighthouse', 'ok', 'pages']);
  });

  it('reads Chrome missing as an error, with or without --strict, and leaves no front', async () => {
    for (const strict of [[], ['--strict']]) {
      const h = htmlHost(null);
      h.io.lighthouse = async () => {
        throw new ChromeMissing();
      };
      expect(await h.run(...strict)).toBe(1);
      expect(h.err).toContain('error: Chrome was not found — Lighthouse needs it; install Google Chrome, or set CHROME_PATH to a Chrome or Chromium binary');
    }
  });

  it('closes the runner when a run throws, and releases the signal listeners', async () => {
    const listeners = process.listenerCount('SIGINT');
    const fake = fakeLighthouse({});
    const h = htmlHost(fake);
    await expect(h.run()).rejects.toThrow('fake lighthouse: no result for /');
    expect(fake.closed).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });
});

describe('stet audit lighthouse — refusals before anything starts', () => {
  it('each usage error exits 2 and starts nothing', async () => {
    const cases: Array<[string[], string]> = [
      [['--url', 'http://127.0.0.1:3000/', '--build'], 'stet audit lighthouse takes --url or --build, not both'],
      [['--runs', '10'], 'stet audit lighthouse --runs takes a whole number from 1 to 9'],
      [['--runs', '0'], 'stet audit lighthouse --runs takes a whole number from 1 to 9'],
      [['--write'], "stet audit lighthouse --write applies --fix's plan — pass both"],
      [['--raw', 'out'], 'stet audit lighthouse --raw writes beside --json — pass both'],
    ];
    for (const [argv, message] of cases) {
      const fake = fakeLighthouse({ '/': cleanLhr() });
      const h = htmlHost(fake);
      expect(await h.run(...argv)).toBe(2);
      expect(h.err.join('\n')).toContain(message);
      expect(fake.starts).toEqual([]);
    }
  });

  it('asks a JavaScript host for a target before Chrome starts', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = nextHost(fake);
    expect(await h.run()).toBe(1);
    expect(h.err).toContain('error: this host builds before it serves — pass --url <server>, or --build to build and serve the production output here');
    expect(fake.starts).toEqual([]);
  });

  it('stops at a --url that does not answer, and never starts Chrome', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = nextHost(fake);
    delete h.io.fetchImpl;
    expect(await h.run('--url', 'http://127.0.0.1:1/')).toBe(1);
    expect(h.err).toContain('error: http://127.0.0.1:1/ did not answer — start the server, or pass --url');
    expect(fake.starts).toEqual([]);
  });

  it("reads a result carrying Lighthouse's runtime error as the target down, with its message, and closes the runner", async () => {
    const down = cleanLhr();
    down.runtimeError = { code: 'FAILED_DOCUMENT_REQUEST', message: 'Lighthouse was unable to reliably load the page you requested.' };
    const fake = fakeLighthouse({ '/': down });
    const h = nextHost(fake);
    expect(await h.run('--url', 'http://127.0.0.1:3999/')).toBe(1);
    expect(h.err).toContain(
      'error: http://127.0.0.1:3999/ did not answer — start the server, or pass --url (Lighthouse was unable to reliably load the page you requested.)',
    );
    expect(fake.starts).toEqual([false]);
    expect(fake.closed).toBe(1);
  });
});

describe("stet audit lighthouse — stet's own footprint (journey C11)", () => {
  it('names the read path and the mount on a 0.6.0 adoption, counting both under stet', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = nextHost(fake, { footprint: true });
    expect(await h.run('--url', 'http://127.0.0.1:3999/')).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain(
      "stet  lib/content.ts imports from '@getstet/stet/react', which ships the client provider with every page — stet upgrade rewrites it to '@getstet/stet/react/server'",
    );
    expect(out).toContain('stet  app/layout.tsx mounts CopyProvider and no client component reads copy — stet upgrade unmounts it');
    expect(h.out[h.out.length - 1]).toBe('1 page · 2 failing audits · stet fixes 2 (stet) · the host owns 0');
    expect(fake.starts).toEqual([false]);
  });

  it('prints the footprint lines before the no-target refusal', async () => {
    const h = nextHost(fakeLighthouse({}), { footprint: true });
    expect(await h.run()).toBe(1);
    expect(h.out.some((line) => line.startsWith('stet  lib/content.ts imports'))).toBe(true);
  });

  it('prints nothing of the footprint on an upgraded host', async () => {
    const h = nextHost(fakeLighthouse({ '/': cleanLhr() }));
    expect(await h.run('--url', 'http://127.0.0.1:3999/')).toBe(0);
    expect(h.out.join('\n')).not.toMatch(/^stet {2}/m);
    expect(h.out[h.out.length - 1]).toBe('1 page · 0 failing audits · stet fixes 0 · the host owns 0');
  });
});

describe('stet audit lighthouse — no other command loads Lighthouse', () => {
  it('check, seo check and the dashboard module run with lighthouse, chrome-launcher and selfsigned unimportable', async () => {
    vi.resetModules();
    for (const name of ['lighthouse', 'chrome-launcher', 'selfsigned']) {
      vi.doMock(name, () => {
        throw Object.assign(new Error(`Cannot find package '${name}'`), { code: 'ERR_MODULE_NOT_FOUND' });
      });
    }
    try {
      const fresh = await import('../cli/main.js');
      const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-broken-'));
      for (const name of ['index.html']) cpSync(join(HTML_FIXTURE, name), join(cwd, name));
      write(cwd, 'stet.config.json', JSON.stringify({ project: 't', host: 'html', managedSurfaces: ['**/*.html'] }));
      write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
      write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
      const io: CliIo = { cwd, env: {}, stdout: () => undefined, stderr: () => undefined };
      expect(typeof (await fresh.runCli(['check'], io))).toBe('number');
      expect(typeof (await fresh.runCli(['seo', 'check'], io))).toBe('number');
      await expect(import('../cli/dev.js')).resolves.toBeDefined();
    } finally {
      for (const name of ['lighthouse', 'chrome-launcher', 'selfsigned']) vi.doUnmock(name);
      vi.resetModules();
    }
  });
});

describe('stet audit lighthouse — the page URL on the html host (D3)', () => {
  const paths = (fake: FakeLighthouse): string[] => fake.runs.map((r) => new URL(r.url).pathname);

  it("audits home at / through index.html alone, though home.html stands beside it", async () => {
    const fake = fakeLighthouse({ '/': cleanLhr(), '/home.html': cleanLhr() });
    const h = htmlHost(fake);
    cpSync(join(HTML_FIXTURE, 'index.html'), join(h.cwd, 'home.html'));
    expect(await h.run()).toBe(0);
    expect(paths(fake)).toEqual(['/']);
    expect(h.out.join('\n')).toContain('index.html  /  Performance');
  });

  it('audits about declared at /about, and at /about/, through about.html', async () => {
    for (const route of ['/about', '/about/']) {
      const fake = fakeLighthouse({ '/about.html': cleanLhr() });
      const h = htmlHost(fake, { pages: { about: { route } } });
      cpSync(join(HTML_FIXTURE, 'index.html'), join(h.cwd, 'about.html'));
      expect(await h.run(), route).toBe(0);
      expect(paths(fake), route).toEqual(['/about.html']);
      expect(h.out.join('\n'), route).toContain(`about.html  ${route}  Performance`);
    }
  });

  it('audits about hand-declared at /about.html at that route', async () => {
    const fake = fakeLighthouse({ '/about.html': cleanLhr() });
    const h = htmlHost(fake, { pages: { about: { route: '/about.html' } } });
    cpSync(join(HTML_FIXTURE, 'index.html'), join(h.cwd, 'about.html'));
    expect(await h.run()).toBe(0);
    expect(paths(fake)).toEqual(['/about.html']);
  });

  it('names a page a document proposes on the adopted fixture, which declares none (C12)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-adopted-'));
    for (const name of ['index.html', 'edges.html']) cpSync(join(HTML_FIXTURE, name), join(cwd, name));
    // The four marks `check` refuses, removed as the C12 scenario removes them.
    const edgesDoc = readFileSync(join(cwd, 'edges.html'), 'utf8');
    writeFileSync(join(cwd, 'edges.html'), edgesDoc.replace(/ data-stet(?:-content|-href)?="edge_(?:url|noscript|list|href)"/g, ''));
    const quiet = { cwd, env: {}, stdout: () => undefined, stderr: () => undefined };
    await runCli(['init', '--yes'], quiet);
    expect(await runCli(['register', '--from', 'scan', '--write'], quiet)).toBe(0);
    const adopted = JSON.parse(readFileSync(join(cwd, 'content/descriptor.json'), 'utf8')) as { keys: object; pages?: unknown };
    expect(Object.keys(adopted.keys).length).toBeGreaterThan(0);
    expect(adopted.pages).toBeUndefined();

    const fake = fakeLighthouse({ '/': cleanLhr(), '/edges.html': cleanLhr(savedLhr('edges.html')) });
    const edges = host(cwd, { lighthouse: fake.start });
    expect(await edges.run('--pages', 'edges')).toBe(0);
    expect(paths(fake)).toEqual(['/edges.html']);
    expect(fake.runs[0]?.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/edges\.html$/);
    expect(edges.out.join('\n')).toMatch(/^edges\.html {2}\/edges {2}Performance/m);
    expect(edges.out).not.toContain('no pages declared — audited / alone; run stet pages scan to declare them');

    const home = host(cwd, { lighthouse: fake.start });
    expect(await home.run('--pages', 'home')).toBe(0);
    expect(paths(fake).slice(1)).toEqual(['/']);

    const bare = host(cwd, { lighthouse: fake.start });
    expect(await bare.run()).toBe(0);
    expect(paths(fake).slice(2)).toEqual(['/']);
    expect(bare.out).toContain('no pages declared — audited / alone; run stet pages scan to declare them');

    const nosuch = host(cwd, { lighthouse: fake.start });
    expect(await nosuch.run('--pages', 'nosuch')).toBe(2);
    expect(nosuch.err.join('\n')).toContain('stet audit lighthouse --pages: nosuch is not a declared page');
    expect(fake.starts).toHaveLength(3);
  });

  it('audits about.html, the first in file order, where about/index.html proposes about too', async () => {
    const fake = fakeLighthouse({ '/about.html': cleanLhr() });
    const h = htmlHost(fake, { pages: {} });
    cpSync(join(HTML_FIXTURE, 'index.html'), join(h.cwd, 'about.html'));
    mkdirSync(join(h.cwd, 'about'));
    cpSync(join(HTML_FIXTURE, 'index.html'), join(h.cwd, 'about/index.html'));
    expect(await h.run('--pages', 'about')).toBe(0);
    expect(paths(fake)).toEqual(['/about.html']);
  });

  it('skips a page no managed document serves, and audits the rest', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = htmlHost(fake, { pages: { home: { route: '/' }, missing: { route: '/missing' } } });
    expect(await h.run()).toBe(0);
    expect(h.out).toContain('missing: no managed document serves /missing — skipped');
    expect(paths(fake)).toEqual(['/']);
  });
});

describe('stet audit lighthouse --build (D3)', () => {
  /**
   * The offline guard replaces `http.request`; the preview and the relay are
   * loopback servers this file starts, so the real client is back for these
   * cases, and the wait's fetch is a loopback request through it.
   */
  const guarded = http.request;
  beforeAll(() => {
    http.request = ((...args: ConstructorParameters<typeof ClientRequest>) => new ClientRequest(...args)) as typeof http.request;
  });
  afterAll(() => {
    http.request = guarded;
  });
  const loopFetch = ((url: string, init?: { method?: string }) =>
    new Promise<Response>((resolve, reject) => {
      const at = new URL(url);
      const req = new ClientRequest({ hostname: at.hostname, port: at.port, path: at.pathname, method: init?.method ?? 'GET' }, (res) => {
        res.resume();
        resolve(new Response(null, { status: res.statusCode ?? 200 }));
      });
      req.on('error', reject);
      req.end();
    })) as unknown as typeof fetch;

  /** A preview that writes its pid, then serves on the given host and port. */
  const SERVE = [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('preview.pid', String(process.pid));",
    "const at = process.argv.indexOf('--port');",
    "const port = Number(at === -1 ? process.env.PORT : process.argv[at + 1]);",
    "const host = process.argv.includes('--v6') ? '::1' : '127.0.0.1';",
    "createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>built</title>'); }).listen(port, host);",
  ].join('\n');

  function buildHost(fake: FakeLighthouse, opts: { build?: string; preview?: string } = {}): Host & { workspace: string } {
    const h = nextHost(fake);
    write(h.cwd, 'package.json', JSON.stringify({ name: 'h', private: true, scripts: { build: opts.build ?? "node -e \"require('fs').writeFileSync('built.txt','ok')\"" } }));
    write(h.cwd, 'serve.mjs', SERVE);
    const workspace = join(h.cwd, '.workspace.json');
    writeFileSync(workspace, JSON.stringify({ sites: [{ path: realpathSync(h.cwd), previewCommand: opts.preview ?? 'node serve.mjs --port {port}' }] }));
    h.io.env = { ...h.io.env, STET_WORKSPACE: workspace };
    h.io.fetchImpl = loopFetch;
    h.io.previewWaitMs = 3_000;
    return { ...h, workspace };
  }
  /** Whether the preview has ended, given a moment for this process to reap it: an ended child stays a zombie until then. */
  const previewGone = async (cwd: string): Promise<boolean> => {
    const pid = Number(readFileSync(join(cwd, 'preview.pid'), 'utf8'));
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('builds, serves the override with the port substituted, audits through the front, and ends the preview', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = buildHost(fake);
    expect(await h.run('--build')).toBe(0);
    expect(existsSync(join(h.cwd, 'built.txt'))).toBe(true);
    const out = h.out.join('\n');
    expect(out).toMatch(/^serving the build on https:\/\/127\.0\.0\.1:\d+\/ \(node serve\.mjs --port \d+\)$/m);
    expect(out).toMatch(/^lighthouse 13\.5\.0 · mobile · https:\/\/127\.0\.0\.1:\d+\/ \(the production build, HTTP\/2\)$/m);
    expect(fake.starts).toEqual([true]);
    expect(fake.runs).toHaveLength(1);
    expect(await previewGone(h.cwd)).toBe(true);
  }, 30_000);

  it('builds and serves again for the re-run after --fix --write, to the same Chrome', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    let closed = false;
    const start: FakeLighthouse['start'] = async (insecure) => {
      const inner = await fake.start(insecure);
      return {
        run: async (url, options) => {
          if (closed) throw new Error('run after close');
          return inner.run(url, options);
        },
        close: async () => {
          closed = true;
          await inner.close();
        },
      };
    };
    const h = buildHost(fake);
    h.io.lighthouse = start;
    write(h.cwd, 'app/layout.tsx', 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n');
    write(h.cwd, 'stet.config.json', JSON.stringify({ project: 't', managedSurfaces: ['app/**/*.tsx'], language: 'en' }));
    expect(await h.run('--build', '--fix', '--write')).toBe(0);
    expect(readFileSync(join(h.cwd, 'app/layout.tsx'), 'utf8')).toContain('<html lang="en">');
    expect(fake.runs).toHaveLength(2);
    expect(new URL(fake.runs[1]?.url ?? '').port).not.toBe(new URL(fake.runs[0]?.url ?? '').port);
    expect(h.err.filter((line) => line === 'building (npm run build)…')).toHaveLength(2);
    expect(fake.starts).toEqual([true]);
    expect(fake.closed).toBe(1);
    expect(await previewGone(h.cwd)).toBe(true);
  }, 30_000);

  it('ends the preview when the audit throws', async () => {
    const h = buildHost(fakeLighthouse({}));
    await expect(h.run('--build')).rejects.toThrow('fake lighthouse');
    expect(await previewGone(h.cwd)).toBe(true);
  }, 30_000);

  it('stops at a failed build with its line, and starts no preview and no Chrome', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = buildHost(fake, { build: "node -e \"console.error('compile error in app/page.tsx'); process.exit(1)\"" });
    expect(await h.run('--build')).toBe(1);
    expect(h.err).toContain('error: npm run build exited 1 — its output is above');
    expect(h.err.join('\n')).toContain('compile error in app/page.tsx');
    expect(existsSync(join(h.cwd, 'preview.pid'))).toBe(false);
    expect(fake.starts).toEqual([]);
  }, 30_000);

  it('names a preview that exits first, with its last lines', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = buildHost(fake, { preview: "node -e \"console.log('booting the preview'); process.exit(3)\"" });
    expect(await h.run('--build')).toBe(1);
    const err = h.err.join('\n');
    expect(err).toContain("error: the production preview did not start (node -e \"console.log('booting the preview'); process.exit(3)\") — its last lines:");
    expect(err).toContain('booting the preview');
    expect(fake.starts).toEqual([]);
  }, 30_000);

  it('names a preview listening on [::1] alone as not started', async () => {
    const h = buildHost(fakeLighthouse({ '/': cleanLhr() }), { preview: 'node serve.mjs --port {port} --v6' });
    expect(await h.run('--build')).toBe(1);
    expect(h.err.join('\n')).toContain('the production preview did not start (node serve.mjs --port');
    expect(await previewGone(h.cwd)).toBe(true);
  }, 30_000);

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it.skipIf(!builtBinExists())(`ends the preview's group on ${signal} and exits ${code}`, async () => {
      const h = buildHost(fakeLighthouse({}), {
        preview: "node -e \"require('fs').writeFileSync('preview.pid', String(process.pid)); setInterval(() => {}, 1000)\"",
      });
      const stet = spawn(process.execPath, [BUILT_BIN, 'audit', 'lighthouse', '--build'], {
        cwd: h.cwd,
        env: { ...process.env, STET_WORKSPACE: h.workspace },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const exited = new Promise<number | null>((resolve) => stet.on('exit', (exit) => resolve(exit)));
      const deadline = Date.now() + 15_000;
      while (!existsSync(join(h.cwd, 'preview.pid')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(join(h.cwd, 'preview.pid'))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      stet.kill(signal);
      expect(await exited).toBe(code);
      expect(await previewGone(h.cwd)).toBe(true);
    }, 30_000);
  }

  it('names the bundle before the paint on a Vite build below 100, and nowhere else', async () => {
    const vite = (performance: number): LighthouseResult => {
      const lhr = cleanLhr();
      (lhr.categories['performance'] as { score: number | null }).score = performance;
      lhr.audits['network-requests'] = {
        id: 'network-requests',
        title: 'Network Requests',
        description: '',
        score: 1,
        scoreDisplayMode: 'informative',
        details: { type: 'table', items: [{ url: 'https://127.0.0.1:1/assets/index.js', resourceType: 'Script', transferSize: 194_000 }, { url: 'https://127.0.0.1:1/assets/small.js', resourceType: 'Script', transferSize: 2_000 }] },
      };
      return lhr;
    };
    const NOTE = '  note  the bundle (189 KB) arrives before the first paint on this connection — Performance is a floor here; run with --applied, or audit the deployed preview, for the production number';
    const viteHost = (performance: number, router = 'vite'): Host => {
      const h = buildHost(fakeLighthouse({ '/': vite(performance) }));
      write(h.cwd, 'stet.config.json', JSON.stringify({ project: 't', router, rootLayout: 'src/main.tsx', managedSurfaces: ['src/**/*.tsx'] }));
      return h;
    };
    const built = viteHost(0.96);
    expect(await built.run('--build')).toBe(0);
    expect(built.out).toContain(NOTE);
    const applied = viteHost(0.96);
    expect(await applied.run('--build', '--applied')).toBe(0);
    expect(applied.out).not.toContain(NOTE);
    const url = viteHost(0.96);
    url.io.fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    expect(await url.run('--url', 'https://preview.example.com/')).toBe(0);
    expect(url.out).not.toContain(NOTE);
    const next = viteHost(0.96, 'app');
    expect(await next.run('--build')).toBe(0);
    expect(next.out).not.toContain(NOTE);
    const hundred = viteHost(1);
    expect(await hundred.run('--build')).toBe(0);
    expect(hundred.out).not.toContain(NOTE);
  }, 60_000);

  it('reads the preview command from the entry, and an update clearing it goes back to the router’s', () => {
    const h = buildHost(fakeLighthouse({}));
    const path = realpathSync(h.cwd);
    updateSite(h.workspace, path, { previewCommand: 'node serve.mjs --port {port} --custom' });
    expect(readWorkspace(h.workspace).sites[0]?.previewCommand).toBe('node serve.mjs --port {port} --custom');
    updateSite(h.workspace, path, { previewCommand: '' });
    expect(Object.hasOwn(readWorkspace(h.workspace).sites[0] ?? {}, 'previewCommand')).toBe(false);
  });

  it("carries each router's preview command with its loopback host", () => {
    expect(PREVIEW_COMMANDS.vite).toBe('npx vite preview --host 127.0.0.1 --port {port} --strictPort');
    expect(PREVIEW_COMMANDS.astro).toBe('npx astro preview --host 127.0.0.1 --port {port} --ignore-lock');
    expect(PREVIEW_COMMANDS.app).toBe('npx next start -H 127.0.0.1 -p {port}');
    expect(PREVIEW_COMMANDS.pages).toBe('npx next start -H 127.0.0.1 -p {port}');
  });
});

describe('stet audit lighthouse — the notes (D3)', () => {
  /** A clean run whose network requests are the given items. */
  const withRequests = (items: Array<Record<string, unknown>>, performance = 1): LighthouseResult => {
    const lhr = cleanLhr();
    (lhr.categories['performance'] as { score: number | null }).score = performance;
    lhr.audits['network-requests'] = { id: 'network-requests', title: 'Network Requests', description: '', score: 1, scoreDisplayMode: 'informative', details: { type: 'table', items } };
    return lhr;
  };

  it('names the third-party origins once each in first-seen order, and an http asset on the page host among them', async () => {
    const fake = fakeLighthouse({
      '/': withRequests([
        { url: 'https://127.0.0.1:1/index.html', resourceType: 'Document', protocol: 'h2' },
        { url: 'https://fonts.googleapis.com/css2?family=Geist', resourceType: 'Stylesheet' },
        { url: 'https://fonts.gstatic.com/s/geist/a.woff2', resourceType: 'Font' },
        { url: 'https://fonts.googleapis.com/css2?family=Other', resourceType: 'Stylesheet' },
      ]),
    });
    const h = htmlHost(fake);
    expect(await h.run()).toBe(0);
    expect(h.out).toContain('  note  fonts.googleapis.com and fonts.gstatic.com are third-party requests — Performance moves with the network; run with --runs 3 before acting on one number');

    const plain = fakeLighthouse({
      '/': (): LighthouseResult => withRequests([{ url: `${new URL(plain.runs[0]?.url ?? 'https://127.0.0.1:1/').origin.replace('https:', 'http:')}/x.js`, resourceType: 'Script' }]),
    });
    const h2 = htmlHost(plain);
    expect(await h2.run()).toBe(0);
    expect(h2.out.find((line) => line.includes('are third-party requests'))).toMatch(/^ {2}note {2}http:\/\/127\.0\.0\.1:\d+ are third-party requests/);
  });

  it('names an HTTP/1.1 main document on a --url run', async () => {
    const fake = fakeLighthouse({ '/': withRequests([{ url: 'http://127.0.0.1:3999/', resourceType: 'Document', protocol: 'http/1.1' }]) });
    const h = nextHost(fake);
    expect(await h.run('--url', 'http://127.0.0.1:3999/')).toBe(0);
    expect(h.out).toContain(
      '  note  http://127.0.0.1:3999/ serves HTTP/1.1 — Lighthouse queues its requests six at a time, which production over HTTP/2 does not; treat Performance as a floor',
    );
  });

  it("names the entry's dev server by its port on a loopback host, and not another port", async () => {
    for (const [url, dev] of [
      ['http://localhost:3000/', true],
      ['http://localhost:3001/', false],
    ] as const) {
      const fake = fakeLighthouse({ '/': cleanLhr() });
      const h = nextHost(fake);
      const workspace = join(h.cwd, '.workspace.json');
      writeFileSync(workspace, JSON.stringify({ sites: [{ path: realpathSync(h.cwd), dev: 'http://127.0.0.1:3000' }] }));
      h.io.env = { ...h.io.env, STET_WORKSPACE: workspace };
      expect(await h.run('--url', url)).toBe(0);
      const out = h.out.join('\n');
      expect(out.includes('note  Performance is measured on the dev server — run with --build for the production number'), url).toBe(dev);
      expect(out.includes('Performance 100 (dev server)'), url).toBe(dev);
    }
  });
});

describe('stet audit lighthouse --fix --write (D5)', () => {
  /** A one-document html host: `<head>` with a marked `<title>` and an `og:url` meta, nothing else. */
  const EDGES =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title data-stet="edges_title">An edge case</title>\n  <meta property="og:url" content="https://psyon.ai/edges">\n</head>\n<body>\n  <main><p data-stet="edges_intro">An ordinary marked paragraph.</p></main>\n</body>\n</html>\n';
  function edgesHost(fake: FakeLighthouse, opts: { declared?: boolean; snapshotPath?: string } = {}): Host {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-fix-'));
    write(cwd, 'edges.html', EDGES);
    const snapshotPath = opts.snapshotPath ?? 'content/defaults.json';
    write(cwd, 'stet.config.json', JSON.stringify({ project: 't', host: 'html', managedSurfaces: ['**/*.html'], snapshotPath }));
    const keys = { edges_title: { shape: 'text', target: 'web', pages: ['edges'] }, edges_intro: { shape: 'text', target: 'web' } };
    const pages = opts.declared === false ? {} : { edges: { route: '/edges', seo: { title: 'edges_title' } } };
    if (opts.declared === false) delete (keys.edges_title as { pages?: string[] }).pages;
    write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys, pages }));
    write(cwd, snapshotPath, JSON.stringify({ default: { edges_title: 'An edge case', edges_intro: 'An ordinary marked paragraph.' } }));
    return host(cwd, { lighthouse: fake.start });
  }
  const descriptorOf = (h: Host): { keys: Record<string, { pages?: string[]; limits?: unknown }>; pages?: Record<string, { route: string; seo?: Record<string, string> }> } =>
    JSON.parse(readFileSync(join(h.cwd, 'content/descriptor.json'), 'utf8'));

  it('plans without --write and writes nothing; with it writes once, fills the page, and measures again', async () => {
    const fake = fakeLighthouse({ '/edges.html': cleanLhr(savedLhr('edges.html')) });
    const plan = edgesHost(fake);
    expect(await plan.run('--fix', '--pages', 'edges')).toBe(0);
    const out = plan.out.join('\n');
    expect(out).toContain(
      [
        'fixes (3) — edges.html:',
        '  <meta charset="utf-8"> as the first element of <head>',
        '  <meta name="viewport" content="width=device-width, initial-scale=1"> after it',
        '  <meta name="description" content="" data-stet-content="edges_meta_description"> — edges is declared as a page and the key is empty until you write it',
      ].join('\n'),
    );
    expect(readFileSync(join(plan.cwd, 'edges.html'), 'utf8')).toBe(EDGES);

    const fake2 = fakeLighthouse({ '/edges.html': cleanLhr(savedLhr('edges.html')) });
    const h = edgesHost(fake2);
    expect(await h.run('--fix', '--write', '--pages', 'edges')).toBe(0);
    expect(readFileSync(join(h.cwd, 'edges.html'), 'utf8')).toBe(
      EDGES.replace(
        '<head>\n',
        '<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="description" content="" data-stet-content="edges_meta_description">\n',
      ),
    );
    expect(h.out).toContain('edges.html: 3 edits applied');
    expect(h.out).toContain("edges: declared (/edges) — edges_meta_description is empty; fill it in the dashboard's SEO group or content/defaults.json");
    const descriptor = descriptorOf(h);
    expect(descriptor.pages?.['edges']?.seo?.['description']).toBe('edges_meta_description');
    expect(descriptor.keys['edges_meta_description']?.pages).toEqual(['edges']);
    expect(descriptor.keys['edges_meta_description']?.limits).toEqual({ max: 160, severity: 'advisory' });
    expect(fake2.runs).toHaveLength(2);
    expect(await runCli(['check'], { ...h.io, stdout: () => undefined, stderr: () => undefined })).toBe(0);
  });

  it('declares a page --pages named before it was declared, and fills it (C12)', async () => {
    const fake = fakeLighthouse({ '/edges.html': cleanLhr(savedLhr('edges.html')) });
    const plan = edgesHost(fake, { declared: false });
    expect(await plan.run('--fix', '--pages', 'edges')).toBe(0);
    expect(plan.out.join('\n')).toContain(
      [
        'fixes (3) — edges.html:',
        '  <meta charset="utf-8"> as the first element of <head>',
        '  <meta name="viewport" content="width=device-width, initial-scale=1"> after it',
      ].join('\n'),
    );
    expect(plan.out.join('\n')).toContain('data-stet-content="edges_meta_description">');
    expect(plan.out.join('\n')).not.toMatch(/lang=/);
    expect(readFileSync(join(plan.cwd, 'edges.html'), 'utf8')).toBe(EDGES);

    const fake2 = fakeLighthouse({ '/edges.html': cleanLhr(savedLhr('edges.html')) });
    const h = edgesHost(fake2, { declared: false });
    expect(await h.run('--fix', '--write', '--pages', 'edges')).toBe(0);
    expect(h.out).toContain('edges.html: 3 edits applied');
    expect(h.out).toContain("edges: declared (/edges) — edges_meta_description is empty; fill it in the dashboard's SEO group or content/defaults.json");
    const descriptor = descriptorOf(h);
    expect(descriptor.pages?.['edges']?.route).toBe('/edges');
    expect(descriptor.pages?.['edges']?.seo?.['description']).toBe('edges_meta_description');
    expect(descriptor.keys['edges_meta_description']?.pages).toEqual(['edges']);
    expect(fake2.runs).toHaveLength(2);
    expect(await runCli(['check'], { ...h.io, stdout: () => undefined, stderr: () => undefined })).toBe(0);
  });

  it('declares home at / where no page was declared, for the keys minted on index.html', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-fix-'));
    write(cwd, 'index.html', '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body><main><p>Hi</p></main></body>\n</html>\n');
    write(cwd, 'stet.config.json', JSON.stringify({ project: 't', host: 'html', managedSurfaces: ['**/*.html'] }));
    write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
    write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = host(cwd, { lighthouse: fake.start });
    expect(await h.run('--fix', '--write')).toBe(0);
    expect(h.out).toContain(
      "home: declared (/) — home_page_title and home_meta_description are empty; fill them in the dashboard's SEO group or content/defaults.json",
    );
    const descriptor = descriptorOf(h);
    expect(descriptor.pages?.['home']?.route).toBe('/');
    expect(descriptor.keys['home_page_title']?.pages).toEqual(['home']);
    expect(await runCli(['check'], { ...h.io, stdout: () => undefined, stderr: () => undefined })).toBe(0);
  });

  it('writes nothing where the snapshot write fails, and names the failure', async () => {
    const fake = fakeLighthouse({ '/edges.html': cleanLhr() });
    const h = edgesHost(fake, { snapshotPath: 'snapshot/defaults.json' });
    const before = { doc: readFileSync(join(h.cwd, 'edges.html'), 'utf8'), descriptor: readFileSync(join(h.cwd, 'content/descriptor.json'), 'utf8') };
    chmodSync(join(h.cwd, 'snapshot/defaults.json'), 0o400);
    chmodSync(join(h.cwd, 'snapshot'), 0o500);
    try {
      expect(await h.run('--fix', '--write', '--pages', 'edges')).toBe(1);
    } finally {
      chmodSync(join(h.cwd, 'snapshot'), 0o700);
      chmodSync(join(h.cwd, 'snapshot/defaults.json'), 0o600);
    }
    expect(h.err.join('\n')).toContain('stet audit lighthouse --fix --write: the write batch failed');
    expect(readFileSync(join(h.cwd, 'edges.html'), 'utf8')).toBe(before.doc);
    expect(readFileSync(join(h.cwd, 'content/descriptor.json'), 'utf8')).toBe(before.descriptor);
  });

  it('leaves the documents and the keys written where the declaration fails, check green', async () => {
    vi.resetModules();
    vi.doMock('../cli/pages.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../cli/pages.js')>()),
      applyPages: () => {
        throw new Error('the declaration failed');
      },
    }));
    try {
      const fresh = await import('../cli/main.js');
      const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-fix-'));
      write(cwd, 'index.html', '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body><main><p>Hi</p></main></body>\n</html>\n');
      write(cwd, 'stet.config.json', JSON.stringify({ project: 't', host: 'html', managedSurfaces: ['**/*.html'] }));
      write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
      write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
      const out: string[] = [];
      const io: CliIo = { cwd, env: {}, stdout: (l) => out.push(l), stderr: () => undefined, lighthouse: fakeLighthouse({ '/': cleanLhr() }).start };
      expect(await fresh.runCli(['audit', 'lighthouse', '--fix', '--write'], io)).toBe(0);
      expect(out).toContain('home: not declared — run stet pages scan --apply home');
      expect(readFileSync(join(cwd, 'index.html'), 'utf8')).toContain('<title data-stet="home_page_title"></title>');
      const descriptor = JSON.parse(readFileSync(join(cwd, 'content/descriptor.json'), 'utf8')) as { keys: Record<string, { pages?: string[] }> };
      expect(descriptor.keys['home_page_title']).toBeDefined();
      expect(descriptor.keys['home_page_title']?.pages).toBeUndefined();
      expect(await fresh.runCli(['check'], { ...io, stdout: () => undefined })).toBe(0);
    } finally {
      vi.doUnmock('../cli/pages.js');
      vi.resetModules();
    }
  });

  it('prints the re-run line under --url and measures once', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = nextHost(fake);
    write(h.cwd, 'app/layout.tsx', 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n');
    write(h.cwd, 'stet.config.json', JSON.stringify({ project: 't', managedSurfaces: ['app/**/*.tsx'], language: 'en' }));
    expect(await h.run('--url', 'http://127.0.0.1:3999/', '--fix', '--write')).toBe(0);
    expect(readFileSync(join(h.cwd, 'app/layout.tsx'), 'utf8')).toContain('<html lang="en">');
    expect(h.out).toContain('run stet audit lighthouse again once http://127.0.0.1:3999/ serves the edit');
    expect(fake.runs).toHaveLength(1);
  });
});

describe('stet audit lighthouse — the exit, the JSON and --raw (D2)', () => {
  /** An Astro-shaped host measured over --url: accessibility 94 and seo 90, the template before its description and `<main>` are written. */
  function astroHost(lhr: LighthouseResult): Host & { fake: FakeLighthouse } {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-astro-'));
    write(cwd, 'stet.config.json', JSON.stringify({ project: 't', router: 'astro', managedSurfaces: ['src/**/*.astro'] }));
    write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {}, pages: { home: { route: '/' } } }));
    write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
    write(cwd, 'src/pages/index.astro', '<html lang="en"><head><title>Astro</title></head><body><h1>Astro</h1></body></html>\n');
    const fake = fakeLighthouse({ '/': lhr });
    const answering = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    return { ...host(cwd, { lighthouse: fake.start, fetchImpl: answering }), fake };
  }
  const scored = (accessibility: number, seo: number): LighthouseResult => {
    const lhr = cleanLhr();
    (lhr.categories['accessibility'] as { score: number }).score = accessibility;
    (lhr.categories['seo'] as { score: number }).score = seo;
    return lhr;
  };
  const jsonOf = (h: Host): Record<string, unknown> => JSON.parse(h.out.join('\n')) as Record<string, unknown>;

  it('exits 1 under --strict with one lighthouse finding below 100, and 0 once every score is 100', async () => {
    const before = astroHost(scored(0.94, 0.9));
    expect(await before.run('--url', 'http://127.0.0.1:4399/', '--strict', '--json')).toBe(1);
    const report = jsonOf(before);
    expect(report['ok']).toBe(false);
    expect(report['findings']).toEqual([expect.objectContaining({ kind: 'lighthouse', level: 'error', message: 'home: accessibility 94, seo 90 below 100' })]);

    const plain = astroHost(scored(0.94, 0.9));
    expect(await plain.run('--url', 'http://127.0.0.1:4399/', '--json')).toBe(0);

    const after = astroHost(cleanLhr());
    expect(await after.run('--url', 'http://127.0.0.1:4399/', '--strict', '--json')).toBe(0);
    const pages = jsonOf(after)['pages'] as Array<{ scores: Record<string, number> }>;
    expect(pages[0]?.scores).toEqual({ performance: 100, accessibility: 100, bestPractices: 100, seo: 100 });
  });

  it('names / audited alone home in the finding, the progress line and the JSON', async () => {
    const h = astroHost(scored(0.94, 0.9));
    write(h.cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {} }));
    expect(await h.run('--url', 'http://127.0.0.1:4399/', '--strict', '--json')).toBe(1);
    const report = jsonOf(h);
    expect(report['findings']).toEqual([expect.objectContaining({ kind: 'lighthouse', message: 'home: accessibility 94, seo 90 below 100' })]);
    expect((report['pages'] as Array<{ page: string; route: string }>)[0]).toEqual(expect.objectContaining({ page: 'home', route: '/' }));
    expect(h.err).toContain('auditing home… 1/1');
  });

  it("carries the walkthrough's shape and the footprint in --json, each page's runs with --runs", async () => {
    const h = astroHost(cleanLhr());
    expect(await h.run('--url', 'http://127.0.0.1:4399/', '--json', '--runs', '3')).toBe(0);
    const report = jsonOf(h);
    expect(Object.keys(report).sort()).toEqual(['findings', 'fixes', 'footprint', 'lighthouse', 'ok', 'pages']);
    expect(Object.keys(report['lighthouse'] as object).sort()).toEqual(['formFactor', 'protocol', 'runs', 'target', 'targetKind', 'version']);
    const page = (report['pages'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(page).sort()).toEqual(['audits', 'diagnostics', 'metrics', 'page', 'route', 'runs', 'scores', 'thirdParty', 'url']);
    expect(Object.keys(page['metrics'] as object).sort()).toEqual(['cls', 'fcp', 'lcp', 'si', 'tbt']);
    expect(page['runs']).toEqual([
      [100, 100, 100],
      [100, 100, 100],
      [100, 100, 100],
      [100, 100, 100],
    ]);
  });

  it('gives an image-alt failing in Accessibility and SEO one audits entry, under accessibility', async () => {
    const lhr = cleanLhr();
    const audit = lhr.audits['image-alt'] as { score: number | null; details?: { items?: unknown[] } };
    audit.score = 0;
    audit.details = { ...(audit.details ?? {}), items: [{ node: { snippet: '<img src="/a.png">', selector: 'body > img' } }] };
    const h = astroHost(lhr);
    expect(await h.run('--url', 'http://127.0.0.1:4399/', '--json')).toBe(0);
    const audits = ((jsonOf(h)['pages'] as Array<{ audits: Array<{ id: string; category: string }> }>)[0] as { audits: Array<{ id: string; category: string }> }).audits;
    expect(audits.filter((a) => a.id === 'image-alt')).toEqual([expect.objectContaining({ id: 'image-alt', category: 'accessibility' })]);
  });

  it('refuses a --raw directory git would track, and writes one result per page into an ignored one', async () => {
    const fake = fakeLighthouse({ '/': cleanLhr() });
    const h = htmlHost(fake);
    const git = (...args: string[]): void => {
      spawnSync('git', args, { cwd: h.cwd, stdio: 'ignore' });
    };
    git('init', '-q');
    write(h.cwd, '.gitignore', 'raw/\n');
    expect(await h.run('--json', '--raw', 'out')).toBe(1);
    expect(jsonOf(h)['findings']).toEqual([expect.objectContaining({ kind: 'lighthouse', message: '--raw out: git would track it — name a directory git ignores' })]);
    expect(existsSync(join(h.cwd, 'out'))).toBe(false);

    h.out.length = 0;
    expect(await h.run('--json', '--raw', 'raw')).toBe(0);
    const saved = JSON.parse(readFileSync(join(h.cwd, 'raw/home.json'), 'utf8')) as LighthouseResult;
    expect(saved.categories['accessibility']?.score).toBe(1);
    expect(saved.finalDisplayedUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/$/);
  });
});

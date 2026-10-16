/**
 * The live leg of `stet audit lighthouse`'s runner: one real headless Chrome
 * measuring a one-line page. Skipped where `CHROME_PATH` is unset and
 * chrome-launcher finds no Chrome.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Launcher } from 'chrome-launcher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATEGORIES, chromeRunner } from '../cli/lighthouse-run.js';
import { BUILT_BIN, builtBinExists } from './helpers/stet-shim.js';

const haveChrome = process.env['CHROME_PATH'] !== undefined || Launcher.getInstallations().length > 0;
const live = haveChrome ? describe : describe.skip;

/** The pids of every process started with a remote-debugging port — the Chromes on this machine. */
function chromePids(): Set<string> {
  try {
    return new Set(execFileSync('pgrep', ['-f', '--', '--remote-debugging-port'], { encoding: 'utf8' }).split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

live('chromeRunner — one headless Chrome', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>One line</title></head><body><p>One line.</p></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('measures the four categories alone, adds no SIGINT listener, and close leaves no Chrome', async () => {
    const before = chromePids();
    const listeners = process.listenerCount('SIGINT');
    const { run, close } = await chromeRunner(false);
    let started: string[] = [];
    try {
      started = [...chromePids()].filter((pid) => !before.has(pid));
      expect(started.length).toBeGreaterThan(0);
      expect(process.listenerCount('SIGINT')).toBe(listeners);
      const result = await run(url, { formFactor: 'mobile', applied: false });
      expect(Object.keys(result.categories).sort()).toEqual([...CATEGORIES].sort());
      expect(result.runtimeError).toBeUndefined();
      expect(result.categories['accessibility']?.score).toBeTypeOf('number');
    } finally {
      await close();
    }
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    const deadline = Date.now() + 5_000;
    let left = started;
    while (Date.now() < deadline) {
      const now = chromePids();
      left = started.filter((pid) => now.has(pid));
      if (left.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(left).toEqual([]);
  }, 120_000);
});

live('stet audit lighthouse --build — a signal mid-run', () => {
  it.skipIf(!builtBinExists())('ends Chrome and the preview group on SIGINT once a page is auditing, and exits 130', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-live-'));
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), text);
    };
    put('package.json', JSON.stringify({ name: 'h', private: true, scripts: { build: 'node -e ""' } }));
    put('stet.config.json', JSON.stringify({ project: 't', managedSurfaces: ['app/**/*.tsx'] }));
    put('content/descriptor.json', JSON.stringify({ version: 1, keys: {}, pages: { home: { route: '/' } } }));
    put('content/defaults.json', JSON.stringify({ default: {} }));
    put(
      'serve.mjs',
      "import { createServer } from 'node:http';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('preview.pid', String(process.pid));\n" +
        "createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html lang=\"en\"><title>t</title><p>One line.</p></html>'); }).listen(Number(process.env.PORT), '127.0.0.1');\n",
    );
    const workspace = join(cwd, '.workspace.json');
    writeFileSync(workspace, JSON.stringify({ sites: [{ path: realpathSync(cwd), previewCommand: 'node serve.mjs' }] }));
    const before = chromePids();
    const stet = spawn(process.execPath, [BUILT_BIN, 'audit', 'lighthouse', '--build'], {
      cwd,
      env: { ...process.env, STET_WORKSPACE: workspace },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => stet.on('exit', (code) => resolve(code)));
    let err = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no auditing line: ${err}`)), 60_000);
      stet.stderr.setEncoding('utf8');
      stet.stderr.on('data', (chunk: string) => {
        err += chunk;
        if (err.includes('auditing home')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const during = [...chromePids()].filter((pid) => !before.has(pid));
    expect(during.length).toBeGreaterThan(0);
    stet.kill('SIGINT');
    expect(await exited).toBe(130);
    const pid = Number(readFileSync(join(cwd, 'preview.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    const deadline = Date.now() + 5_000;
    let left = during;
    while (Date.now() < deadline) {
      const now = chromePids();
      left = during.filter((p) => now.has(p));
      if (left.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(left).toEqual([]);
    expect(existsSync(join(cwd, 'preview.pid'))).toBe(true);
  }, 120_000);
});

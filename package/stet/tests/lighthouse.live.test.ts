/**
 * The live leg of `stet audit lighthouse`'s runner: one real headless Chrome
 * measuring a one-line page. Skipped where `CHROME_PATH` is unset and
 * chrome-launcher finds no Chrome.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Launcher } from 'chrome-launcher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATEGORIES, chromeRunner } from '../cli/lighthouse-run.js';

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

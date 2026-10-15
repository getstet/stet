import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { alive, answers, endGroup, untilInterrupted } from '../cli/liveness.js';

describe('answers — whether a server answers at all (D1)', () => {
  it('counts any response as up, a 500 included', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    expect(await answers(fetchImpl, 'http://127.0.0.1:1/', 1_000)).toBe(true);
  });

  it('counts a refused connection as down', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await answers(fetchImpl, 'http://127.0.0.1:1/', 1_000)).toBe(false);
  });

  it('answers down at the deadline when the server never answers, a signal-deaf fetch included', async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    expect(await answers(fetchImpl, 'http://127.0.0.1:1/', 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('endGroup — a detached child ended by its process group (D1)', () => {
  it('ends a group that ignores SIGTERM with SIGKILL and answers true', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const pid = child.pid as number;
    try {
      expect(alive(-pid)).toBe(true);
      expect(await endGroup(pid)).toBe(true);
      expect(alive(-pid)).toBe(false);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* ended */
      }
    }
  }, 15_000);

  it('answers false where there is no group', async () => {
    expect(await endGroup(0)).toBe(false);
  });
});

describe('untilInterrupted — the run held open until a signal (D1)', () => {
  it('adds one listener per signal and release takes each away', () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    const run = untilInterrupted();
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before.map((n) => n + 1));
    run.release();
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it('resolves with the signal that arrived', async () => {
    const run = untilInterrupted();
    try {
      process.emit('SIGHUP', 'SIGHUP');
      expect(await run.interrupted).toBe('SIGHUP');
    } finally {
      run.release();
    }
  });
});

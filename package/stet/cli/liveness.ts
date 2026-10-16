/**
 * Whether a process, or a process group, is still running.
 *
 * `kill(…, 0)` succeeds on a zombie, a process that has exited and waits for
 * its parent to reap it. A killed group member whose parent is gone passes to
 * PID 1, and where PID 1 never reaps (a container started without an init) it
 * stays a zombie for good, so a check on `kill` alone waits out every
 * deadline. On Linux `/proc` names each process's run state, and a member
 * that is only a zombie counts as ended; where there is no `/proc` (macOS),
 * `kill` alone decides.
 *
 * A target is a pid, or a process group written as `-pgid` — the `kill`
 * convention. Beside the two reads: `answers`, whether a server answers at
 * all, `endGroup`, the one way a detached child's group is ended, and
 * `untilInterrupted`, a run held open until a signal.
 */

import { readdirSync, readFileSync } from 'node:fs';

/** Whether anything `target` names is still running. `kill(…, 0)` answers first. */
export function alive(target: number): boolean {
  try {
    process.kill(target, 0);
  } catch {
    return false;
  }
  const states = procStates(target);
  return states === null || states.some((state) => state !== 'Z' && state !== 'X');
}

/** Whether `target` has nothing left running, within a deadline. */
export async function gone(target: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(target)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** The run state of each process `target` names, or null where there is no `/proc`. */
function procStates(target: number): string[] | null {
  if (procStat('self') === undefined) return null;
  if (target > 0) {
    const own = procStat(String(target));
    return own === undefined ? [] : [own.state];
  }
  const states: string[] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = procStat(pid);
    if (stat !== undefined && stat.pgrp === -target) states.push(stat.state);
  }
  return states;
}

/** A process's run state and group from `/proc/<pid>/stat`, or undefined once it is gone. */
function procStat(pid: string): { state: string; pgrp: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name sits in parentheses and may itself hold spaces or `)`;
    // the fields after it run state, ppid, pgrp.
    const [state = '', , pgrp = ''] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state, pgrp: Number(pgrp) };
  } catch {
    return undefined;
  }
}

/**
 * Whether `url` answers at all within `ms` — any response is up, a throw or the deadline is down.
 *
 * The fetch's own abort signal is RACED against a timer of its own: an
 * implementation that ignores the signal — a fake among them — must still
 * settle. A server answering 404 or 500 is still a server.
 */
export async function answers(fetchImpl: typeof globalThis.fetch, url: string, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    let answered: Promise<boolean>;
    try {
      answered = Promise.resolve(fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(ms), redirect: 'manual' })).then(
        () => true,
        () => false,
      );
    } catch {
      return false;
    }
    return await Promise.race([answered, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A process group ended: SIGTERM, two seconds, SIGKILL, and the wait for it to go. False where there was no group. */
export async function endGroup(pid: number): Promise<boolean> {
  if (pid === 0) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return false;
  }
  if (await gone(-pid, 2_000)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  // SIGKILL is delivered asynchronously: without this the caller can answer
  // "stopped" while the port is still held.
  await gone(-pid, 2_000);
  return true;
}

/**
 * A run held open until the operator ends it: `interrupted` resolves with the
 * signal that arrived. The listeners stay until `release`, so a signal during
 * the close is absorbed (F48).
 */
export function untilInterrupted(): { interrupted: Promise<NodeJS.Signals>; release: () => void } {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let resolve: (signal: NodeJS.Signals) => void = () => {};
  const interrupted = new Promise<NodeJS.Signals>((r) => {
    resolve = r;
  });
  const stop = (signal: NodeJS.Signals): void => resolve(signal);
  for (const signal of signals) process.on(signal, stop);
  return { interrupted, release: () => signals.forEach((signal) => process.off(signal, stop)) };
}

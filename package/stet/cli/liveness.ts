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
 * convention.
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

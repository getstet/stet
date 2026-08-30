/**
 * The fixture project doctor's wrapper-chain cases run against: snapshot-only,
 * so doctor runs entirely offline, with one or more pointered templates.
 *
 * It needs no `node_modules` — the chain walk reads the host's own files and
 * never resolves a package — which is what separates it from
 * `tests/helpers/email-host.ts`, the home for hosts that RENDER.
 *
 * Consumers: `tests/email-doctor.test.ts` and
 * `tests/email-doctor-no-typescript.test.ts`, which mocks the compiler away and
 * so has to live in a file of its own.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runDoctor } from '../../cli/doctor.js';
import type { CliIo } from '../../cli/main.js';
import type { TemplateDef } from '../../src/types.js';

const made: string[] = [];

/** Every project this run created, removed. */
export function cleanupChainProjects(): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.length = 0;
}

/** Write a file into a project, creating its directories. */
export function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** A snapshot-only project — no store block, so doctor runs entirely offline. */
export function chainProject(
  templates: Record<string, TemplateDef>,
  snapshot: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-chain-'));
  made.push(dir);
  write(dir, 'stet.config.json', JSON.stringify({ project: 't', managedSurfaces: [], emailSurfaces: [] }));
  // Every declared slot needs its flattened key and a value, or the folded
  // `stet check` output buries the chain findings under currency warnings.
  const keys: Record<string, unknown> = {};
  const values: Record<string, unknown> = { ...snapshot };
  for (const [name, entry] of Object.entries(templates)) {
    for (const slot of entry.slots) {
      keys[`${name}__${slot}`] = { shape: 'text', target: 'html-email' };
      values[`${name}__${slot}`] ??= 'Hello';
    }
  }
  for (const key of Object.keys(values)) keys[key] ??= { shape: 'text', target: 'html-email' };
  write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys, templates }));
  write(dir, 'content/defaults.json', JSON.stringify({ default: values }));
  return dir;
}

export interface DoctorRun {
  code: number;
  out: string;
  err: string;
}

export async function doctor(dir: string): Promise<DoctorRun> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = await runDoctor([], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export const POINTER = { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: {} };

/** A marketing template pointing at `file`, declaring the given wrapper tokens. */
export const MARKETING = (wrapperProvides: string[], file = POINTER.file): TemplateDef => ({
  class: 'marketing',
  trigger: 'manual',
  slots: ['headline'],
  wrapperProvides,
  render: { ...POINTER, file },
});

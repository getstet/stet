import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig } from '../../cli/config.js';

const hostUrl = new URL('../fixtures/ts-host/', import.meta.url);
const hostDir = fileURLToPath(hostUrl);
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/**
 * The ambient file is named EXACTLY as the product default writes it
 * (`config.codegen.dts`), installed into a `content/` dir that ALSO holds a
 * `keys.ts` — so the host's include-globbed tsconfig exercises the real
 * `X.d.ts`-vs-`X.ts` output-collision rule (P1-2). If the default ever regressed
 * to `keys.d.ts`, the glob would drop it (a sibling `keys.ts` is present), the
 * ambient augmentation would never load, and the typo test would fail — the
 * property the old files-list fixture (which named a `stet-registry.d.ts` the
 * product never writes and forced its inclusion) silently lacked.
 */
const dtsName = basename(defaultConfig().codegen.dts);

/**
 * Put today's generated ambient types in the host, so tsc checks what codegen
 * emits. Written through a rename: two test files install the same content in
 * parallel, and a reader must never catch a truncated file.
 */
export function installRegistryDts(dts: string): void {
  mkdirSync(new URL('content/', hostUrl), { recursive: true });
  const staged = new URL(`content/.${dtsName}.${process.pid}.tmp`, hostUrl);
  writeFileSync(staged, dts);
  renameSync(staged, new URL(`content/${dtsName}`, hostUrl));
}

export interface TypecheckResult {
  ok: boolean;
  output: string;
}

/** `tsc --noEmit` over one of the host's projects. */
export function typecheckHost(project: 'tsconfig.ok.json' | 'tsconfig.bad.json'): TypecheckResult {
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', project], {
      cwd: hostDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output: '' };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

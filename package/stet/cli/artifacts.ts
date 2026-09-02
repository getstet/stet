/**
 * Writing an emitted artifact to disk, the same way every time.
 *
 * `pull` emits three files and every one of them goes through here, because
 * "sorted keys" is only a guarantee while there is exactly one serializer: a
 * top-level sort and a deep sort cannot drift apart when neither exists twice.
 * The sorter itself is `canonicalize` from `src/codegen.ts` — the one
 * `sourceHash` already hashes over, so an artifact and its hash agree by
 * construction.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalize, generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import type { StetConfig } from './config.js';
import { CliError, UsageError } from './report.js';

/** JSON, keys sorted at every depth, two-space indent, one trailing newline. */
export function writeJsonDeterministic(path: string, value: unknown): void {
  writeText(path, jsonText(value));
}

/** Generated TypeScript and anything else already serialized by its generator. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * A hook, which git silently ignores unless the executable bit is set — so the
 * mode is part of writing the file, not a step a caller remembers.
 */
export function writeExecutable(path: string, text: string): void {
  writeText(path, text);
  chmodSync(path, 0o755);
}

/** The bytes `writeJsonDeterministic` would write, without writing them. */
function jsonText(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export type PlanStatus = 'write' | 'unchanged' | 'differs';

export interface WritePlan {
  path: string;
  text: string;
  /** What a refusal NAMES — repo-relative where the real path is absolute. */
  label: string;
  status: PlanStatus;
}

/**
 * One planned write, checked against what is on disk and not yet applied.
 *
 * Three states because they need three answers: absent is the write, identical
 * is a no-op that makes a second `init` change nothing, and DIFFERING is a host
 * edit — overwriting it behind a success exit would delete work with no warning
 * and no way back.
 *
 * `label` exists because the path a command writes is absolute while the name
 * an operator recognizes is repo-relative; a refusal that names a temp
 * directory teaches nothing.
 */
export function planWrite(path: string, text: string, label?: string): WritePlan {
  const named = label ?? path;
  if (!existsSync(path)) return { path, text, label: named, status: 'write' };
  const held = readFileSync(path, 'utf8');
  return { path, text, label: named, status: held === text ? 'unchanged' : 'differs' };
}

/** `planWrite` over a value the deterministic JSON writer would serialize. */
export function planJson(path: string, value: unknown, label?: string): WritePlan {
  return planWrite(path, jsonText(value), label);
}

/**
 * A planned write over a file stet is UPDATING rather than scaffolding.
 *
 * `differs` means "what is on disk is not what stet would write". For a file
 * stet owns that is a host edit and a refusal; for a file whose new text was
 * computed FROM its current contents it is the ordinary case, and refusing it
 * would refuse every edit. Saying which of the two a plan is keeps one batch
 * able to carry both — a genuine conflict still refuses the whole run.
 */
export function asUpdate(plan: WritePlan): WritePlan {
  return plan.status === 'differs' ? { ...plan, status: 'write' } : plan;
}

/**
 * A batch, applied all-or-nothing. One conflicting file refuses the WHOLE plan
 * before a single byte is written: a partial emit followed by a refusal is its
 * own mess, and `init` writes seven files into a stranger's repo.
 *
 * A write that throws PART WAY THROUGH is put back: each target's prior
 * contents are held until the batch completes, and a failure restores them (and
 * unlinks what did not exist). Without it the guarantee would hold only for the
 * conflict check — a permission error on the fourth file would leave three
 * written and the caller's descriptor describing a rewrite that never landed.
 *
 * `dryRun` reports both halves — what it WOULD write and what is already
 * current — because a run that dropped the no-ops would read as if a pristine
 * re-run had nothing planned at all. Printing is the caller's: this module has
 * no report channel.
 */
export function writePlanned(
  plans: WritePlan[],
  opts: { dryRun?: boolean; refusal?: (labels: string[]) => string } = {},
): { written: string[]; unchanged: string[] } {
  const conflicts = plans.filter((p) => p.status === 'differs').map((p) => p.label);
  if (conflicts.length > 0) {
    throw new CliError(
      opts.refusal?.(conflicts) ??
        `refusing to overwrite ${conflicts.join(', ')} — the file in this repo differs from the one stet would write. ` +
          'Nothing was written. Diff them and delete the local copy if the generated version is the one you want',
    );
  }

  const written: string[] = [];
  const unchanged: string[] = [];
  const prior: Array<{ path: string; text: string | null }> = [];
  try {
    for (const plan of plans) {
      if (plan.status === 'unchanged') {
        unchanged.push(plan.label);
        continue;
      }
      written.push(plan.label);
      if (opts.dryRun === true) continue;
      // Captured BEFORE the write, so a target that throws mid-write is still
      // covered — restoring bytes that never changed costs nothing.
      prior.push({ path: plan.path, text: existsSync(plan.path) ? readFileSync(plan.path, 'utf8') : null });
      writeText(plan.path, plan.text);
    }
  } catch (error) {
    for (const held of prior.reverse()) {
      try {
        if (held.text === null) rmSync(held.path, { force: true });
        else writeText(held.path, held.text);
      } catch {
        // A restore that cannot run leaves that one file as the failed write
        // left it. The original failure is still what the caller must see, so
        // it propagates rather than being replaced by this one.
      }
    }
    throw error;
  }
  return { written, unchanged };
}

/**
 * The five repo forms as one update batch — the descriptor, the snapshot and
 * the regenerated codegen trio.
 *
 * The three commands that write keys write exactly these five, and a batch that
 * missed one would leave a permanent finding: `generateRegistry` stamps the
 * WHOLE descriptor's source hash, so a descriptor edit alone stales the
 * currency gate. Every plan is `asUpdate` — each file's new text was computed
 * FROM its current contents, so `differs` is the ordinary case here rather than
 * a host edit — and each is labeled with the REPO-RELATIVE path, because a
 * refusal that names a temp directory teaches nothing.
 *
 * MANDATORY among them: a stale ambient union keeps `copy('removed_key')`
 * compiling in the host, and it is the residue a write that outran its codegen
 * leaves behind.
 *
 * The `StetConfig` import is type-only and erased under `verbatimModuleSyntax`;
 * config.ts's runtime import of this module is the only runtime edge between
 * the two.
 */
export function planRepoForms(
  cwd: string,
  config: Pick<StetConfig, 'descriptorPath' | 'snapshotPath' | 'codegen'>,
  descriptor: Descriptor,
  snapshot: Snapshot,
): WritePlan[] {
  const at = (rel: string): string => join(cwd, rel);
  const { keysTs, dts } = generateRegistry(descriptor);
  return [
    asUpdate(planJson(at(config.descriptorPath), descriptor, config.descriptorPath)),
    asUpdate(planJson(at(config.snapshotPath), snapshot, config.snapshotPath)),
    asUpdate(planWrite(at(config.codegen.registry), keysTs, config.codegen.registry)),
    asUpdate(planWrite(at(config.codegen.dts), dts, config.codegen.dts)),
    asUpdate(planWrite(at(config.codegen.defaults), generateDefaultsModule(snapshot), config.codegen.defaults)),
  ];
}

/**
 * What a failed write batch says. A refusal already names what it refused and
 * that nothing was written; an I/O failure names neither, and the batch's whole
 * promise is that a failure left nothing behind. Raised as a `CliError` so it
 * prints as one line and exits 1 rather than reaching the terminal as a stack.
 */
export function rethrowBatchFailure(command: string, error: unknown): never {
  if (error instanceof CliError || error instanceof UsageError) throw error;
  const path = (error as { path?: string }).path;
  throw new CliError(
    `${command}: the write batch failed${path === undefined ? '' : ` at ${path}`} — ` +
      `${(error as Error).message}. Every file this run had already written was put back.`,
  );
}

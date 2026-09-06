/**
 * Load the project once, read the store in one place.
 *
 * Five commands need the same four things — config, descriptor, snapshot, an
 * adapter — and every one of them has to answer the same question when the
 * store does not: is this absence, or is it failure? The answer lives here so
 * it is answered once (§2.2 invariant 4, and the split that qualifies it):
 *
 *   render-reads   (`list`, `get`)                     degrade to the snapshot
 *   compare-reads  (`diff`, `audit`, `pull`, `--due`)  fail loudly
 *
 * A comparison against absence reports nonsense, and a mirror against absence
 * overwrites good committed artifacts with degraded ones. `readRows` reports
 * the fact; each command applies its own half of the rule.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDescriptorWithWarnings, type DescriptorWarning } from '../src/descriptor.js';
import type { StoreRow } from '../src/resolve.js';
import { loadSnapshot, type Snapshot } from '../src/snapshot.js';
import type { StoreAdapter, StoreError } from '../src/store.js';
import type { Descriptor } from '../src/types.js';
import { loadConfig, selectStoreBlock, type StetConfig, type StoreBlock } from './config.js';
import type { CliIo } from './main.js';
import { CliError } from './report.js';
import { resolveStore } from './store.js';

export interface RowsAnswer {
  rows: StoreRow[];
  /** The configured store did not answer. Never true on a snapshot-only project. */
  storeDown: boolean;
  message?: string;
}

export interface LoadedProject {
  config: StetConfig;
  descriptor: Descriptor;
  descriptorWarnings: DescriptorWarning[];
  snapshot: Snapshot;
  store: StoreAdapter;
  /**
   * Which store connection this load selected, and the block behind it. Command
   * bodies read the selection from here and never from `config.store` — that is
   * what keeps `--env` from applying to the adapter while the meta bridge, the
   * store-backed test and doctor's prints stay pointed at the default database.
   */
  environment: { name: string; block: StoreBlock | undefined };
  /**
   * Set only under `tolerateStoreConfig`: the store block is configured and
   * broken, and the caller (`doctor`) reports it rather than dying on it.
   */
  storeProblem?: string;
  readRows(q?: { keys?: string[]; locale?: string; preview?: boolean }): Promise<RowsAnswer>;
  /**
   * Release what this load opened. A command that CONSTRUCTED an adapter ends
   * it before returning; an INJECTED one belongs to its caller and is never
   * touched — the in-process consumers (`stet mcp`, the tests) hand the same
   * store to many calls and would lose it. Without this a long-lived caller
   * leaks a connection pool per command.
   */
  dispose(): Promise<void>;
}

/**
 * One adapter, closed.
 *
 * `StoreAdapter` declares no teardown — a memory or snapshot adapter has
 * nothing to close — so the connection-holding ones are found by the `end`
 * they do declare. This is the one place that duck-type lives: the loaded
 * project's `dispose` and the dashboard's `close()` both come here.
 */
export async function disposeStore(store: StoreAdapter): Promise<void> {
  const closable = store as { end?: () => Promise<void> };
  if (typeof closable.end === 'function') await closable.end();
}

export interface LoadProjectOptions {
  /** `upgrade --store` seeds against a store block the repo does not have yet. */
  config?: StetConfig;
  /** `doctor` diagnoses a broken store block instead of exiting on it. */
  tolerateStoreConfig?: boolean;
  /** `--env <name>`; absent selects the bare `store` block. */
  env?: string;
}

/**
 * The adapter a caller injected for this environment, if any. `io.store` is the
 * shorthand for the default one, so the single-store consumers — `stet mcp`,
 * every one-environment test — keep working untouched.
 */
function injectedFor(io: CliIo, name: string): StoreAdapter | undefined {
  return io.stores?.[name] ?? (name === 'default' ? io.store : undefined);
}

export async function loadProject(
  io: CliIo,
  opts: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const config = opts.config ?? loadConfig(io.cwd);
  // Selection FIRST, before injection is even looked up: an unknown `--env` is
  // a usage error whether or not a store was handed to us, so a typo can never
  // ride an injected adapter past the check.
  const environment = selectStoreBlock(config, opts.env);
  const { descriptor, warnings } = readDescriptor(io.cwd, config.descriptorPath);
  const snapshot = readSnapshot(io.cwd, config.snapshotPath);

  let store: StoreAdapter;
  let storeProblem: string | undefined;
  const injected = injectedFor(io, environment.name) !== undefined;
  try {
    store = await resolveStore(config, io.env, injectedFor(io, environment.name), opts.env);
  } catch (error) {
    if (!(opts.tolerateStoreConfig === true) || !(error instanceof CliError)) throw error;
    storeProblem = error.message;
    // Diagnosis continues against a store that answers as empty, so every
    // section below the store section still reports. The SELECTED environment
    // is what has to be neutralized, not just the bare block: dropping `store`
    // alone would leave `doctor --env b` resolving b's broken block again and
    // dying on the command whose job is to diagnose it.
    const bare: StetConfig = { ...config, store: undefined, environments: undefined };
    store = await resolveStore(bare, io.env);
  }

  const project: LoadedProject = {
    config,
    descriptor,
    descriptorWarnings: warnings,
    snapshot,
    store,
    environment,
    async readRows(q = {}): Promise<RowsAnswer> {
      const answer = await store.read(q);
      if (Array.isArray(answer)) return { rows: answer, storeDown: false };
      return { rows: [], storeDown: true, message: (answer as StoreError).message };
    },
    async dispose(): Promise<void> {
      if (injected) return;
      await disposeStore(store);
    },
  };
  return storeProblem === undefined ? project : { ...project, storeProblem };
}

/** The compare/mirror half of the rule, in one sentence and one place. */
export function refuseAbsence(answer: RowsAnswer, command: string): void {
  if (!answer.storeDown) return;
  throw new CliError(
    `${command} needs the configured store and it did not answer: ${answer.message ?? 'unreachable'} — ` +
      'a comparison or a mirror against absence would report nonsense, so nothing was written or published',
  );
}

/**
 * A descriptor or snapshot the project cannot be read without. Both loaders
 * reject with their own error types; both become a `CliError` here, because a
 * bad project file is the operator's to fix and a stack trace helps nobody
 * fix it.
 */
function readDescriptor(
  cwd: string,
  path: string,
): { descriptor: Descriptor; warnings: DescriptorWarning[] } {
  const raw = readJson(cwd, path, 'descriptor');
  try {
    const loaded = loadDescriptorWithWarnings(raw);
    return { descriptor: loaded.descriptor, warnings: loaded.warnings };
  } catch (error) {
    throw new CliError(`${path}: ${(error as Error).message}`);
  }
}

function readSnapshot(cwd: string, path: string): Snapshot {
  const raw = readJson(cwd, path, 'snapshot');
  try {
    return loadSnapshot(raw);
  } catch (error) {
    throw new CliError(`${path}: ${(error as Error).message}`);
  }
}

function readJson(cwd: string, path: string, what: string): unknown {
  const full = join(cwd, path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new CliError(`no ${what} at ${path} — is this a stet project? (looked in ${cwd})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

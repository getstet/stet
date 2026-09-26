/**
 * The bridge between a command, which holds a `StoreAdapter`, and the
 * install-time helpers, which are connection-shaped module exports beside the
 * factories (§13.6 C: the interface stays seven methods plus the flag). It
 * re-derives the connection from the config and the environment — the same
 * derivation `cli/store.ts` makes when it builds the adapter, through the same
 * `selectStoreBlock`, so the stamp lands in the database the command was
 * pointed at — and `seed`, `upgrade` and `doctor` never import an adapter
 * module themselves.
 *
 * Every `stet_meta` function here answers `'unsupported'`/null for a project whose store
 * has no `stet_meta` to speak of: memory, snapshot, and an injected test store
 * with no config store block. That is a reported outcome, never an error — a
 * project without a database is a mode.
 */

import type { MemoryStore } from '../adapters/store-memory.js';
import {
  readStetMeta as readPostgrestMeta,
  renameRecorded as postgrestRenameRecorded,
  writeDescriptorVersion as writePostgrestVersion,
} from '../adapters/store-postgrest.js';
import type { StetMeta } from '../adapters/store-shared.js';
import type { StoreAdapter } from '../src/store.js';
import { selectStoreBlock, type StetConfig, type StoreBlock } from './config.js';
import { CliError } from './report.js';
import { loadPgAdapter, requireEnv } from './store.js';

export type StampResult = 'stamped' | 'unchanged' | 'unsupported';

/**
 * The transport a fetch-based helper uses. Threaded from `CliIo` so the
 * offline suite drives the whole PostgREST meta path with a fake, the same way
 * the adapter's own tests do.
 */
type Fetch = typeof globalThis.fetch;

/** What kind of connection this project's store block describes, if any. */
type Connection =
  | { kind: 'pg'; connectionString: string }
  | { kind: 'postgrest'; url: string; token: string }
  | { kind: 'none' };

function connectionOf(config: StetConfig, env: NodeJS.ProcessEnv, selection?: string): Connection {
  return connectionOfBlock(selectStoreBlock(config, selection).block, env);
}

/**
 * The same derivation from an ALREADY-resolved block — what `applyMigrationSql`
 * takes, because that path has no `fetchImpl` to make a forgotten selector a
 * compile error.
 */
function connectionOfBlock(store: StoreBlock | undefined, env: NodeJS.ProcessEnv): Connection {
  if (!store) return { kind: 'none' };
  switch (store.adapter) {
    case 'pg':
      return { kind: 'pg', connectionString: requireEnv(env, store.urlEnv, store.adapter) };
    case 'postgrest':
      return {
        kind: 'postgrest',
        url: requireEnv(env, store.urlEnv, store.adapter),
        token: requireEnv(env, store.tokenEnv, store.adapter),
      };
    case 'memory':
    case 'snapshot':
      return { kind: 'none' };
  }
}

/**
 * The installed `stet_meta`, null where the table is absent (an unversioned
 * database), or `'unsupported'` where no database is configured at all. The
 * three are different answers and `upgrade` branches on all three.
 */
export async function readProjectMeta(
  config: StetConfig,
  env: NodeJS.ProcessEnv,
  selection?: string,
  fetchImpl?: Fetch,
): Promise<StetMeta | null | 'unsupported'> {
  const conn = connectionOf(config, env, selection);
  switch (conn.kind) {
    case 'none':
      return 'unsupported';
    case 'pg': {
      // Lazy, for the same reason `cli/store.ts` is: `pg` is an optional peer.
      const { readStetMeta } = await loadPgAdapter();
      return readStetMeta(conn.connectionString);
    }
    case 'postgrest':
      return readPostgrestMeta({ url: conn.url, token: conn.token, fetchImpl });
  }
}

/**
 * Whether the selected store's rename log (`stet_renames`) holds `oldKey`
 * renamed to `newKey`: a rename that store finished, whoever ran it. The memory
 * reference answers from its own log; a store with no log answers false.
 */
export async function renameRecorded(
  config: StetConfig,
  env: NodeJS.ProcessEnv,
  selection: string,
  store: StoreAdapter,
  pair: { oldKey: string; newKey: string },
  fetchImpl?: Fetch,
): Promise<boolean> {
  const conn = connectionOf(config, env, selection);
  const p = { project: config.project, ...pair };
  switch (conn.kind) {
    case 'pg': {
      const { renameRecorded: pgRenameRecorded } = await loadPgAdapter();
      return pgRenameRecorded(conn.connectionString, p);
    }
    case 'postgrest':
      return postgrestRenameRecorded({ url: conn.url, token: conn.token, fetchImpl }, p);
    case 'none': {
      const log = (store as Partial<MemoryStore>).renameLog;
      return typeof log === 'function' && log.call(store).some((r) => r.old_key === p.oldKey && r.new_key === p.newKey);
    }
  }
}

/**
 * `descriptor_version` from the descriptor's own `version` field — the promise
 * migration 1's `''` makes, kept by the two commands it names. Compared before
 * writing, so a re-run reports `unchanged` rather than churning the row.
 */
export async function stampDescriptorVersion(
  config: StetConfig,
  env: NodeJS.ProcessEnv,
  version: string,
  selection?: string,
  fetchImpl?: Fetch,
): Promise<StampResult> {
  const conn = connectionOf(config, env, selection);
  if (conn.kind === 'none') return 'unsupported';

  const installed = await readProjectMeta(config, env, selection, fetchImpl);
  // No row means no `stet_meta` table: the adapter has nothing to stamp, which
  // `upgrade` reports and then fixes by applying the migration.
  if (installed === null || installed === 'unsupported') return 'unsupported';
  if (installed.descriptorVersion === version) return 'unchanged';

  if (conn.kind === 'pg') {
    const { writeDescriptorVersion } = await loadPgAdapter();
    await writeDescriptorVersion(conn.connectionString, version);
  } else {
    await writePostgrestVersion({ url: conn.url, token: conn.token, fetchImpl }, version);
  }
  return 'stamped';
}

/**
 * One migration file against the SELECTED store. Only `store-pg` reaches here —
 * every other adapter declares `canApplyDDL: false` and `upgrade` takes the
 * print-and-verify branch instead.
 *
 * It takes the resolved block, not the config plus a trailing selector: this is
 * the one helper here with no `fetchImpl`, so an added optional parameter would
 * be compile-silent at its call site — and a forgotten thread would apply DDL
 * to the default database while the operator read a `--env` on the command
 * line, then misdiagnose it through the 42P07 handler.
 */
export async function applyMigrationSql(
  block: StoreBlock | undefined,
  env: NodeJS.ProcessEnv,
  sql: string,
): Promise<void> {
  const conn = connectionOfBlock(block, env);
  if (conn.kind !== 'pg') {
    throw new CliError(
      'this store cannot apply DDL — that branch prints the SQL and verifies instead of applying it',
    );
  }
  const { applySql } = await loadPgAdapter();
  await applySql(conn.connectionString, sql);
}

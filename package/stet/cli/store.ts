/**
 * Config → adapter. A static map over the four factories this package already
 * ships: no dynamic import, no registry, no adapter code duplicated here.
 *
 * No store block means snapshot-only, silently — the mode is detected, never
 * asked (§13.1). A CONFIGURED adapter whose connection variable is unset is the
 * opposite: an actionable error naming the variable, because configured-and-
 * broken must never degrade quietly into snapshot-only.
 */

import { createMemoryStore } from '../adapters/store-memory.js';
import { createSnapshotStore } from '../adapters/store-snapshot.js';
import { createPostgrestStore } from '../adapters/store-postgrest.js';
import type { StoreAdapter } from '../src/store.js';
import { environmentBlock, selectStoreBlock, type StetConfig as Cfg, type StoreBlock } from './config.js';
import { CliError } from './report.js';

/**
 * How long a connection attempt may hang before it counts as unreachable.
 *
 * `pg.Pool` parses a `connect_timeout` in the URL and then ignores it, so
 * without this option a black-holed host — packets dropped, no RST — waits out
 * the OS TCP stack's ~75 seconds. A degrade that arrives after 75 seconds is an
 * outage, not a degrade, and a refused socket is the easy case; the dropped one
 * is the common real failure.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * The pg adapter, imported only on the path that constructs it.
 *
 * `pg` is an OPTIONAL peer dependency. A static import chain from the CLI
 * would make EVERY command — `check` included, which must run offline with no
 * database at all — fail at module load on the default install with
 * `ERR_MODULE_NOT_FOUND`. The one caller that needs a driver is the one that
 * pays for it, and the failure it can still hit is actionable.
 */
export async function loadPgAdapter(): Promise<typeof import('../adapters/store-pg.js')> {
  try {
    return await import('../adapters/store-pg.js');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module) 'pg'/.test((error as Error).message)) {
      throw new CliError(
        "store adapter 'pg' needs the optional peer dependency `pg`, which is not installed — " +
          'run `npm install pg`, or switch store.adapter to postgrest/snapshot',
      );
    }
    throw error;
  }
}

/**
 * A connection variable's value, or the error that names it. Shared with
 * `cli/meta.ts`, which re-derives the same connection for the install-time
 * helpers — one message for one condition.
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string, adapter: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new CliError(
      `store adapter '${adapter}' is configured but ${name} is unset — set it or remove the store block`,
    );
  }
  return value;
}

/**
 * The adapter this project's config describes, for the selected environment.
 * Async only because of the lazy pg import above — every other arm resolves
 * without awaiting anything.
 *
 * The selection is resolved BEFORE the injected store is consulted, so a
 * `--env` typo cannot ride an injected adapter past the check. `cli/project.ts`
 * has already selected by the time it calls here; the second lookup is a pure
 * one and the duplication is deliberate, because this function is also callable
 * on its own.
 */
export async function resolveStore(
  config: Cfg,
  env: NodeJS.ProcessEnv,
  injected?: StoreAdapter,
  selection?: string,
): Promise<StoreAdapter> {
  const s = selectStoreBlock(config, selection).block;
  if (injected) return injected;
  if (!s) return createSnapshotStore({ project: config.project });
  const need = (name: string): string => requireEnv(env, name, s.adapter);
  switch (s.adapter) {
    case 'memory':    return createMemoryStore({ project: config.project });
    case 'snapshot':  return createSnapshotStore({ project: config.project });
    case 'pg': {
      const connectionString = need(s.urlEnv);
      const { createPgStore } = await loadPgAdapter();
      return createPgStore({
        connectionString,
        project: config.project,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });
    }
    case 'postgrest': return createPostgrestStore({ url: need(s.urlEnv), token: need(s.tokenEnv), project: config.project });
  }
}

/**
 * Whether the SELECTED environment's writes and version metadata have a
 * database behind them. A snapshot-only project's committed `defaults.json` IS
 * its bundle, so `pull` emits no separate artifact for one.
 *
 * It takes the resolved block rather than the config and a selector: a trailing
 * optional selector would let a caller forget the thread and still compile,
 * which is the half-applied `--env` this change exists to prevent. Callers hand
 * over `project.environment.block`.
 */
export function isStoreBacked(block: StoreBlock | undefined): boolean {
  return block !== undefined && block.adapter !== 'snapshot';
}

/**
 * The store contacts live in, for the selected environment. With a declared
 * `contacts` block: its `store` for the default selection, else the block's
 * own `environments[name]`. Without one: the content store's block for that
 * selection. One resolution for `stet contacts`, `doctor` and `upgrade`, so the
 * three never disagree about which database holds the list. The name is the
 * `io.stores` key a test injects under: `contacts` or `contacts.<env>` for a
 * declared block, the content environment's name otherwise.
 */
export function contactsBlock(config: Cfg, selection?: string): { name: string; block: StoreBlock | undefined; own: boolean } {
  const contacts = config.contacts;
  if (contacts === undefined) return { ...selectStoreBlock(config, selection), own: false };
  if (selection === undefined || selection === 'default') return { name: 'contacts', block: contacts.store, own: true };
  return { name: `contacts.${selection}`, block: environmentBlock(contacts.environments, selection, 'contacts'), own: true };
}

/**
 * The config a contacts store is reached through: the content config with the
 * selected contacts block standing as its bare store. Every connection-shaped
 * helper (`resolveStore`, `cli/meta.ts`, `upgrade`'s apply path) takes a
 * config, so this is how they reach the contacts database without a second
 * derivation. Without a contacts block it is the config itself.
 */
export function contactsConfig(config: Cfg, selection?: string): Cfg {
  if (config.contacts === undefined) return config;
  return { ...config, store: contactsBlock(config, selection).block, environments: undefined };
}

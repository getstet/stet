/**
 * `stet upgrade` — two jobs, one command.
 *
 * With no argument: read `stet_meta`, resolve the pending numbered migrations
 * in order, branch on the adapter's declared `canApplyDDL`, regenerate the
 * registry, and stamp the descriptor version. Idempotent — a second run has
 * nothing pending and says so.
 *
 * With `--store <adapter>`: write the migration into the host repo, print the
 * config block to add, apply or print per the capability, and seed every key
 * from the committed snapshot as version 1 — so content written in
 * snapshot-only mode becomes the first history entry rather than being
 * re-typed.
 *
 * An unversioned database reports "migration 1 pending", never "up to date":
 * `stet_meta` missing means nobody has applied anything, and guessing the
 * other way would skip the whole schema.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateRegistry } from '../src/codegen.js';
import { ENV_OPTION, flag, noPositionals, parse, text } from './args.js';
import { planWrite, writePlanned, writeText } from './artifacts.js';
import {
  CONFIG_FILE,
  HOST_MIGRATIONS,
  STORE_ADAPTERS,
  defaultStoreBlock,
  loadConfig,
  type StetConfig,
  type StoreAdapterName,
  type StoreBlock,
} from './config.js';
import { migrations, type Migration } from './installed.js';
import type { CliIo } from './main.js';
import { applyMigrationSql, readProjectMeta, stampDescriptorVersion } from './meta.js';
import { loadProject, type LoadedProject } from './project.js';
import { CliError, Report, UsageError } from './report.js';
import { isStoreBacked } from './store.js';
import { seed } from './write.js';

export async function runUpgrade(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...ENV_OPTION,
    store: 'string',
    'dry-run': 'boolean',
    verify: 'boolean',
  });
  noPositionals(positionals, 'upgrade');
  const dryRun = flag(values, 'dry-run');
  const adapter = text(values, 'store');

  const report = new Report();
  const config = adapter === undefined ? undefined : storeConfig(io.cwd, adapter);
  const project = await loadProject(io, { config, env: text(values, 'env') });
  report.environment(project.environment.name);

  // The one command that mutates a stranger's database never exits silent
  // about DDL it already ran: whatever happened before a failure is reported,
  // and the failure joins the report rather than arriving as a stack trace.
  // (A `finally` that returns would swallow control flow; this catch is the
  // same guarantee written where a reader can see it.)
  try {
    if (adapter !== undefined) await install(io, project, report, dryRun, adapter);
    else await migrate(io, project, report, dryRun, flag(values, 'verify'));
    regenerate(io, project, report, dryRun);
  } catch (error) {
    // A usage mistake keeps its exit code and its silence: it is raised before
    // any work, so there is no partial report worth printing over it.
    if (error instanceof UsageError) throw error;
    report.error(
      'store',
      error instanceof CliError
        ? error.message
        : `unexpected failure: ${(error as Error).message}`,
    );
  } finally {
    await project.dispose();
  }
  return report.emit(io);
}

/**
 * `--store <adapter>`: the store block this project does not have on disk yet.
 * Everything else — paths, project id, locales, the declared environments —
 * still comes from the repo's own config, because only the store half is what
 * the flag supplies. Under a non-default `--env` the selection wins and this
 * block is never read: the environment is already declared, so there is nothing
 * to stand in for.
 */
function storeConfig(cwd: string, adapter: string): StetConfig {
  if (!(STORE_ADAPTERS as readonly string[]).includes(adapter)) {
    throw new UsageError(`--store must be one of: ${STORE_ADAPTERS.join(', ')}`);
  }
  return { ...loadConfig(cwd), store: defaultStoreBlock(adapter as StoreAdapterName) };
}

/**
 * The install path: the migration into the repo, the config block to add, the
 * apply-or-print branch, then the seed.
 *
 * Under a non-default selection the environment decides the connection, so
 * `--store` may only agree with it — a mismatch is the operator believing they
 * are installing one adapter into a database that speaks another, and it is
 * refused by name before anything is written. The migration files emitted into
 * the repo are the same files either way: they are the package's, not a
 * connection's.
 */
async function install(
  io: CliIo,
  project: LoadedProject,
  report: Report,
  dryRun: boolean,
  requested: string,
): Promise<void> {
  const { name, block: store } = project.environment;
  if (!store) throw new CliError('--store needs an adapter');
  if (name !== 'default' && store.adapter !== requested) {
    throw new UsageError(
      `--store ${requested} contradicts --env ${name}, which declares adapter ${store.adapter} — ` +
        'the selected environment decides the connection; drop --store or name the adapter it declares',
    );
  }

  emitMigrations(io, report, dryRun);

  report.line('');
  report.line(`add this to ${CONFIG_FILE} (this command never edits it):`);
  report.line(
    JSON.stringify(
      name === 'default' ? { store: storeBlock(store) } : { environments: { [name]: storeBlock(store) } },
      null,
      2,
    ),
  );
  report.line('');

  await applyPending(io, project, report, dryRun);
  if (dryRun) {
    report.line('dry run: nothing applied, nothing seeded');
    return;
  }
  // The stamp already ran with the apply; seed must not print a second one.
  if (project.store.canApplyDDL) await seed(io, project, report, { stamp: false });
}

/**
 * The migration files into the host repo — three branches, and the third is
 * the one that matters.
 *
 * This is the only file stet writes into a stranger's repository. An identical
 * copy is a no-op and an absent one is the install; a DIFFERING one is a host
 * edit, and overwriting it behind a success exit would delete work with no
 * warning and no way back. It is refused by name instead, before anything at
 * all is written — a partial emit followed by a refusal would be its own mess.
 */
function emitMigrations(io: CliIo, report: Report, dryRun: boolean): void {
  // The plan-then-apply pair is `artifacts.ts`'s — `init` is its second
  // consumer and writes seven files under the same all-or-nothing contract.
  // The refusal text stays this command's, because it names what THIS stet
  // ships and the repo-relative copy an operator would diff.
  const plans = migrations().map((migration) =>
    planWrite(
      join(io.cwd, HOST_MIGRATIONS, migration.name),
      readFileSync(migration.path, 'utf8'),
      `${HOST_MIGRATIONS}/${migration.name}`,
    ),
  );

  const { written, unchanged } = writePlanned(plans, {
    dryRun,
    refusal: (labels) =>
      `refusing to overwrite ${labels.join(', ')} — the file in this repo differs from the one this stet ships. ` +
      'Nothing was written. Diff them and delete the local copy if the package version is the one you want',
  });

  for (const label of unchanged) report.line(`${label}: already present, identical`);
  for (const label of written) report.line(dryRun ? `would write ${label}` : `wrote ${label}`);
}

/** The block an operator pastes. PostgREST reads a token too, so it says so. */
function storeBlock(store: StoreBlock): Record<string, string> {
  return store.adapter === 'postgrest'
    ? { adapter: store.adapter, urlEnv: store.urlEnv, tokenEnv: store.tokenEnv }
    : { adapter: store.adapter, urlEnv: store.urlEnv };
}

/** The plain path: whatever is pending, then the stamp. */
async function migrate(
  io: CliIo,
  project: LoadedProject,
  report: Report,
  dryRun: boolean,
  verify: boolean,
): Promise<void> {
  if (verify) {
    await verifyMoved(io, project, report);
    return;
  }
  await applyPending(io, project, report, dryRun);
}

async function applyPending(
  io: CliIo,
  project: LoadedProject,
  report: Report,
  dryRun: boolean,
): Promise<void> {
  if (!isStoreBacked(project.environment.block)) {
    report.line('store: snapshot-only — there is no schema to migrate');
    return;
  }

  const installed = await installedVersion(io, project, report);
  if (installed === null) return;

  const shipped = migrations();
  const newest = shipped[shipped.length - 1]?.number ?? 0;
  if (installed > newest) {
    // The database was written by a newer stet than this one. Reported, never
    // acted on: this package does not know what those migrations did, and
    // "nothing pending" would read as agreement.
    report.warn(
      'store',
      `this stet package is older than the database (schema_version ${installed} > ${newest} shipped) — upgrade the package`,
    );
    return;
  }

  const pending = shipped.filter((m) => m.number > installed);
  if (pending.length === 0) {
    report.line(`migrations: up to date at ${installed}`);
    // The schema has not moved and the descriptor still may have: the stamp is
    // "where a store answers and the value moved", not "where a migration ran".
    await stamp(io, project, report);
    return;
  }
  report.line(
    `migrations: installed ${installed}, pending ${pending.map((m) => m.number).join(', ')}`,
  );

  if (dryRun) {
    for (const migration of pending) report.line(`would apply ${migration.name}`);
    return;
  }

  if (project.store.canApplyDDL) {
    for (const migration of pending) {
      // Each file is its own transaction — the file's own begin/commit — so a
      // failure leaves nothing behind and never a stamped half-schema.
      try {
        await applyMigrationSql(
          project.environment.block,
          io.env,
          readFileSync(migration.path, 'utf8'),
        );
      } catch (error) {
        // 42P07 is duplicate_table: the schema is there and `stet_meta` is not,
        // so this database was migrated by something that lost the stamp.
        // Re-applying would abort at the first `create table` and change
        // nothing; the fix is the missing row, not the whole file.
        if ((error as { code?: string }).code === '42P07') {
          throw new CliError(
            `migration ${migration.number} appears to be already applied — its tables exist but the stet_meta row is missing. ` +
              `Restore the row (insert into stet_meta (id, schema_version, descriptor_version) values (1, ${migration.number}, '')) ` +
              'rather than re-applying the file',
          );
        }
        throw error;
      }
      report.line(`applied ${migration.name}`);
    }
    await stamp(io, project, report);
    return;
  }

  printForOutOfBandApply(io, project, pending, report);
}

/**
 * The `canApplyDDL: false` branch. DDL does not ride REST, so the SQL is
 * printed with its apply paths and the access check that makes the promise
 * verifiable — the path that promises verification verifies ACCESS, not only
 * application. Nothing is applied and the exit code stays 0.
 */
function printForOutOfBandApply(
  io: CliIo,
  project: LoadedProject,
  pending: Migration[],
  report: Report,
): void {
  // The SELECTED environment's variable: the apply instructions must name the
  // variable of the database being migrated, not the default one's.
  const urlEnv = project.environment.block?.urlEnv ?? 'STET_DATABASE_URL';
  report.line('this adapter cannot apply DDL (canApplyDDL: false) — apply it out of band:');

  for (const migration of pending) {
    // The file to apply is the copy in THIS repo, never the one inside
    // node_modules: `npm ci` deletes that tree, and an apply path that stops
    // working after a clean install is not an apply path.
    const durable = `${HOST_MIGRATIONS}/${migration.name}`;
    const inRepo = join(io.cwd, HOST_MIGRATIONS, migration.name);
    const source = readFileSync(migration.path, 'utf8');
    report.line('');
    if (existsSync(inRepo) && readFileSync(inRepo, 'utf8') === source) {
      report.line(`--- ${durable}`);
    } else {
      report.line(`--- ${durable} (not in this repo yet — \`stet upgrade --store <adapter>\` writes it)`);
      report.line(source);
    }
  }

  report.line('');
  report.line('apply paths:');
  report.line(`  psql "$${urlEnv}" -f ${HOST_MIGRATIONS}/<the file above>`);
  report.line("  the platform's SQL console (Supabase's SQL editor, the Management API)");
  report.line('');
  report.line('then reload the schema cache and check access:');
  report.line("  notify pgrst, 'reload schema';");
  report.line(
    "  select has_table_privilege('<your anon role>', 'content_versions', 'SELECT');  -- expected: f",
  );
  report.line('');
  report.line('then, in order:');
  report.line('  stet upgrade --verify');
  report.line('  stet seed');
}

async function verifyMoved(io: CliIo, project: LoadedProject, report: Report): Promise<void> {
  const installed = await installedVersion(io, project, report);
  if (installed === null) return;
  const pending = migrations().filter((m) => m.number > installed);
  if (pending.length > 0) {
    report.error(
      'store',
      `stet_meta still reports schema_version ${installed}: migration ${pending[0]?.number} has not been applied`,
    );
    return;
  }
  report.line(`verified: stet_meta reports schema_version ${installed}`);
  await stamp(io, project, report);
}

/**
 * The installed schema version. `null` here means "nothing more to do" and the
 * caller returns — either the store cannot answer, or it has no meta to read.
 * A missing `stet_meta` is version 0, which makes migration 1 pending.
 */
async function installedVersion(
  io: CliIo,
  project: LoadedProject,
  report: Report,
): Promise<number | null> {
  let meta: Awaited<ReturnType<typeof readProjectMeta>>;
  try {
    meta = await readProjectMeta(project.config, io.env, project.environment.name, io.fetchImpl);
  } catch (error) {
    report.error('store', `could not read stet_meta: ${(error as Error).message}`);
    return null;
  }
  if (meta === 'unsupported') {
    report.line('store: this adapter has no stet_meta — nothing to migrate');
    return null;
  }
  return meta === null ? 0 : meta.schemaVersion;
}

async function stamp(io: CliIo, project: LoadedProject, report: Report): Promise<void> {
  const version = String(project.descriptor.version);
  const result = await stampDescriptorVersion(
    project.config,
    io.env,
    version,
    project.environment.name,
    io.fetchImpl,
  );
  report.line(
    result === 'unsupported'
      ? 'descriptor_version: not stamped (adapter has no stet_meta)'
      : `descriptor_version: ${result} (${version})`,
  );
}

/** The registry always regenerates: the descriptor is its only source. */
function regenerate(io: CliIo, project: LoadedProject, report: Report, dryRun: boolean): void {
  const { keysTs, dts } = generateRegistry(project.descriptor);
  const files: { path: string; text: string }[] = [
    { path: project.config.codegen.registry, text: keysTs },
    { path: project.config.codegen.dts, text: dts },
  ];
  for (const file of files) {
    const full = join(io.cwd, file.path);
    const current = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (current === file.text) {
      report.line(`${file.path}: unchanged`);
      continue;
    }
    if (dryRun) {
      report.line(`would regenerate ${file.path}`);
      continue;
    }
    writeText(full, file.text);
    report.line(`${file.path}: regenerated`);
  }
}

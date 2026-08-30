/**
 * The store conformance suite's offline legs. The memory adapter is the
 * reference implementation, so it runs in the default suite on every commit;
 * the snapshot adapter passes the same suite by answering `NotSupported` on the
 * write half, which is a passing result, not a skipped one.
 *
 * The SQL adapters run this same suite behind `STET_TEST_DATABASE_URL` —
 * `tests/store-pg.live.test.ts`.
 */
import { createMemoryDb, createMemoryStore } from '../adapters/store-memory.js';
import { createSnapshotStore } from '../adapters/store-snapshot.js';
import { runStoreConformance } from './store.suite.js';

// One database, many projects — the way a monorepo's apps share a store.
const db = createMemoryDb();
runStoreConformance('memory', (project) => createMemoryStore({ project, db }));

runStoreConformance('snapshot', (project) => createSnapshotStore({ project }));

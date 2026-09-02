import { defineConfig } from 'vitest/config';

/**
 * The live leg: tests that need infrastructure the default suite refuses to
 * touch. They are named `*.live.test.ts`, excluded from `vitest.config.ts`, and
 * run only through this config — which deliberately does NOT load
 * `setup.offline.ts`. Each file gates itself on its own env var
 * (`STET_TEST_DATABASE_URL`, `STET_TEST_POSTGREST_URL`) and skips when unset.
 *
 * The default `npm test` stays fully offline. That guard intercepts HTTP only —
 * `pg` speaks raw sockets — so the pg leg is kept out of the default suite by
 * the file convention, not by interception.
 */
export default defineConfig({
  test: {
    include: ['stet/**/*.live.test.ts'],
    // Serial, because these files share ONE database and at least one assertion
    // measures it globally: the CLI leg's pool-leak check counts every backend
    // on the database before and after its own calls, so a file running beside
    // it lands inside that window and the count stops meaning what the
    // assertion says. Serial files make it mean it again. The alternative —
    // narrowing the count to the CLI's own connections — would need the adapter
    // to carry an `application_name`, which is a product change and belongs
    // behind a gate rather than in a test config.
    fileParallelism: false,
  },
});

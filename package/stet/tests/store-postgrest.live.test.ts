/**
 * The PostgREST leg. `store-postgrest` faces the same suite every other adapter
 * passes, the contacts block included, against a live PostgREST, and the
 * equality filters below prove each character PostgREST reads as syntax still
 * finds its row.
 *
 *   STET_TEST_POSTGREST_URL=http://localhost:3000 \
 *   STET_TEST_POSTGREST_TOKEN=<service token> npm run test:live
 *
 * The schema must already hold migrations 1 to 3, the token's role must bypass
 * row level security with the service grants, and PostgREST must have reloaded:
 *   notify pgrst, 'reload schema';
 */
import { describe, expect, it } from 'vitest';

import { createPostgrestStore } from '../adapters/store-postgrest.js';
import { ok, runStoreConformance } from '../conformance/store.suite.js';

const URL = process.env['STET_TEST_POSTGREST_URL'];
const TOKEN = process.env['STET_TEST_POSTGREST_TOKEN'] ?? '';

if (URL) {
  runStoreConformance('postgrest', (project) =>
    createPostgrestStore({ url: URL, token: TOKEN, project }),
  );

  describe('equality filters (the 0.3.2 quoting defect)', () => {
    // PostgREST reads everything after `eq.` as the value, so a quoted value
    // matched no row and every content read on a clean database came back
    // empty. Each character PostgREST treats as syntax somewhere, in a project
    // and a key, must still find its one row.
    for (const c of [',', '.', ':', '(', ')', '"', '\\', ' ', '%', '&', '#', '*']) {
      it(`a project and a key holding ${JSON.stringify(c)} read back their row`, async () => {
        const store = createPostgrestStore({ url: URL, token: TOKEN, project: `p${c}q` });
        const key = `k${c}y`;
        ok(await store.saveDraft({ key, value: 'wording', target: 'web', editor: 'neil' }));
        ok(await store.publish({ key, editor: 'neil' }));
        const rows = ok(await store.read({ keys: [key] }));
        expect(rows.map((r) => [r.key, r.value])).toEqual([[key, 'wording']]);
        expect(ok(await store.history({ key })).rows).toHaveLength(1);
      });
    }
  });
} else {
  describe.skip('store conformance — postgrest', () => {
    it('needs STET_TEST_POSTGREST_URL', () => {
      // Silently skipped by design: the mandatory proof is the Mirra install.
    });
  });
}

/**
 * The optional PostgREST leg. `store-postgrest` is the reference install's
 * transport, and it is NOT conformance-proven against a live PostgREST in this
 * change: the mandatory proof lands at the Mirra install, and the residual risk
 * until then is carried deliberately (design §Risks).
 *
 * When a PostgREST is available, point this at it and the adapter faces the
 * same suite every other adapter passes:
 *
 *   STET_TEST_POSTGREST_URL=http://localhost:3000 \
 *   STET_TEST_POSTGREST_TOKEN=<service token> npm run test:live
 *
 * The schema must already hold migration 1, and PostgREST must have reloaded:
 *   notify pgrst, 'reload schema';
 */
import { describe, it } from 'vitest';

import { createPostgrestStore } from '../adapters/store-postgrest.js';
import { runStoreConformance } from '../conformance/store.suite.js';

const URL = process.env['STET_TEST_POSTGREST_URL'];
const TOKEN = process.env['STET_TEST_POSTGREST_TOKEN'] ?? '';

if (URL) {
  runStoreConformance('postgrest', (project) =>
    createPostgrestStore({ url: URL, token: TOKEN, project }),
  );
} else {
  describe.skip('store conformance — postgrest', () => {
    it('needs STET_TEST_POSTGREST_URL', () => {
      // Silently skipped by design: the mandatory proof is the Mirra install.
    });
  });
}

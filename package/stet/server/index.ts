/**
 * `@getstet/stet/server` — the package's HTTP API surface. A store-backed host mounts it
 * from one catch-all route (`app/api/stet/[...stet]/route.ts`), re-exporting the
 * `{ GET, POST }` the factory returns.
 *
 * The preview token pair — `mintPreviewToken` and `verifyPreviewToken` — ships
 * here beside it: minting needs the signing secret and verifying guards a
 * route, both of which are this layer's job. The state they name, `PreviewState`,
 * comes with them, and the resolver that renders one is on the root.
 */

export { createStetHandler } from './mount.js';
export type { PublishEvent, StetHandlerOptions } from './mount.js';
export { mintPreviewToken, verifyPreviewToken } from '../src/preview-token.js';
export type { PreviewState } from '../src/preview.js';

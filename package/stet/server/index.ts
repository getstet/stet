/**
 * `@getstet/stet/server` — the package's HTTP API surface. A store-backed host mounts it
 * from one catch-all route (`app/api/stet/[...stet]/route.ts`), re-exporting the
 * `{ GET, POST }` the factory returns.
 */

export { createStetHandler } from './mount.js';
export type { PublishEvent, StetHandlerOptions } from './mount.js';

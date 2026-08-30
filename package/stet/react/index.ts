/**
 * `@getstet/stet/react` — the React read layer: the client `CopyProvider`/`useCopy`
 * binding and the `createServerCopy` server accessor. Both build on the
 * framework-free `createAccessor` contract in `src/access.ts`.
 */

export { CopyProvider, useCopy } from './provider.js';
export type { CopyProviderProps } from './provider.js';
export { createServerCopy } from './server.js';

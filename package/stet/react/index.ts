/**
 * `@getstet/stet/react` — the React read layer: the client `CopyProvider`/`useCopy`
 * binding, the `createServerCopy` server accessor, and `richParts`, the renderer a
 * sentence key is read through. Both accessors build on the framework-free
 * `createAccessor` contract in `src/access.ts`.
 */

export { CopyProvider, useCopy } from './provider.js';
export type { CopyProviderProps } from './provider.js';
export { createServerCopy, richParts } from './server.js';
export type { RichChildren } from './server.js';

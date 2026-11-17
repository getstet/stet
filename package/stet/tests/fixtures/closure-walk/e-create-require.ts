import { createRequire } from 'node:module';

export const mod: unknown = createRequire(import.meta.url)('marker-leaf');

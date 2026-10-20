import { createServerCopy } from '@getstet/stet/react/server';
import { DEFAULTS } from '../content/defaults';
export const copy = createServerCopy(descriptor, resolved);
export const copyMap = resolved as Record<string, string>;

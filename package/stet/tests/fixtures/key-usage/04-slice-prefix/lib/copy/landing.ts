import { DEFAULTS } from '@/content/defaults';
export const slice = (v: Record<string, string>, ps: readonly string[]) => Object.fromEntries(Object.entries(v).filter(([k]) => ps.some((p) => k.startsWith(p))));
export const liveDefaults = slice(DEFAULTS.default, ['home_live_']);

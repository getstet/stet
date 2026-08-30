// The generated key registry an init'd host carries beside the ambient types.
// Its ONLY job in this fixture is to be `keys.ts`: with it present, an ambient
// file named `keys.d.ts` would be treated as this file's declaration output and
// DROPPED from the include-globbed program — so the ambient MUST use a distinct
// stem (`stet-env.d.ts`). That is the field failure P1-2 pins.
export const KEYS = ['hero_headline'] as const;
export type ContentKey = (typeof KEYS)[number];

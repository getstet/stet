/**
 * The cross-adapter vocabulary itself: the conflict markers, and the one code
 * table derived from them. The adapters are proven through the conformance
 * suite; what is proven here is the property that keeps the table honest — it
 * is DERIVED from the markers, so a raise added to the SQL is classified
 * without anyone remembering to edit a second list.
 */
import { describe, expect, it } from 'vitest';

import {
  changeClosed,
  groupedSchedule,
  mapError,
  noChange,
  noMembers,
  staleActive,
  wrongProjectChange,
} from '../adapters/store-shared.js';

describe('the conflict vocabulary', () => {
  it('classifies every changeset raise as a conflict with no table edit', () => {
    // `CONFLICTS = Object.values(MARKERS)`, so adding a marker extends the
    // table by construction. A raise the table has never heard of would come
    // back `unknown` and a surface would report a transport failure for what is
    // really a refusal the operator can act on.
    const raises = [
      noChange(7),
      changeClosed(7),
      noMembers(7),
      staleActive('hero_headline', 12),
      groupedSchedule('hero_headline'),
      wrongProjectChange('site', 7, 'other'),
    ];
    for (const raise of raises) {
      expect({ raise, code: mapError(raise).code }).toEqual({ raise, code: 'conflict' });
    }
  });

  it('keeps the raw server text on the answer', () => {
    // The message is what names the key or the change, and every surface that
    // reports a refusal reports this string.
    expect(mapError(staleActive('hero_headline', 12)).message).toBe(
      'stale_active:hero_headline (expected active 12, it has moved)',
    );
    expect(mapError(noChange(0)).message).toBe('no_change:0');
  });

  it('still calls an unmarked raise unknown, not a conflict', () => {
    // The table is derived, not permissive: text carrying no marker is not
    // silently promoted to a refusal.
    expect(mapError('something the SQL never raises').code).toBe('unknown');
  });

  it('reads a connection failure as unreachable whatever the text says', () => {
    // Class 08 and 57 are decided before the marker table, so a shutdown
    // mid-deploy degrades to the snapshot instead of reading as a refusal.
    expect(mapError(noChange(7), { sqlstate: '08006' }).code).toBe('unreachable');
    expect(mapError(noChange(7), { sqlstate: '57P01' }).code).toBe('unreachable');
  });
});

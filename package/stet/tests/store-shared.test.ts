/**
 * The cross-adapter vocabulary itself: the conflict markers, and the one code
 * table derived from them. The adapters are proven through the conformance
 * suite; what is proven here is the property that keeps the table honest — it
 * is DERIVED from the markers, so a raise added to the SQL is classified
 * without anyone remembering to edit a second list.
 */
import { describe, expect, it } from 'vitest';

import {
  asImportOutcome,
  asJoin,
  asVoid,
  changeClosed,
  contactsMarker,
  groupedSchedule,
  isStoreError,
  mapContactRecord,
  mapError,
  mapGroupDef,
  mapGroupRow,
  mapMemberRow,
  noChange,
  noMembers,
  staleActive,
  unknownGroup,
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

describe('the contacts mapping', () => {
  const pgGroup = {
    key: 'cloud-waitlist',
    name: 'stet Cloud',
    state: 'open',
    properties: [{ name: 'tier', type: 'enum', values: ['solo', 'team'], required: true }],
    created_at: new Date('2026-10-02T14:02:00.000Z'),
    members: '3',
  };
  const restGroup = { ...pgGroup, created_at: '2026-10-02T14:02:00+00:00', members: 3 };

  it('reads a group the same over pg and over PostgREST', () => {
    // `pg` hands a timestamptz as a Date and a bigint count as text; PostgREST
    // sends strings and a number. The mapped shapes cannot tell them apart.
    expect(mapGroupRow(pgGroup)).toEqual(mapGroupRow(restGroup));
    expect(mapGroupRow(pgGroup).members).toBe(3);
    const def = mapGroupDef(pgGroup);
    expect(def).toEqual(mapGroupDef(restGroup));
    expect(def).not.toHaveProperty('members');
    expect(def.createdAt).toBe('2026-10-02T14:02:00.000Z');
  });

  it('reads an empty record as none, and anything but an object as a broken contract', () => {
    expect(mapContactRecord(null)).toEqual({ record: null });
    expect(isStoreError(mapContactRecord('x'))).toBe(true);
  });

  it('answers a join with the stored time, form and page', () => {
    const answer = asJoin({
      body: {
        contact_id: 1,
        is_new: true,
        suppressed: false,
        joined_at: '2026-10-02T14:02:00+00:00',
        form: 'f',
        page: null,
      },
    });
    expect(answer).toEqual({
      contactId: 1,
      isNew: true,
      suppressed: false,
      joinedAt: '2026-10-02T14:02:00.000Z',
      form: 'f',
      page: null,
    });
  });

  it('accepts only the four import outcomes and a void answer', () => {
    expect(asImportOutcome({ body: 'erased' })).toEqual({ outcome: 'erased' });
    expect(isStoreError(asImportOutcome({ body: 'maybe' }))).toBe(true);
    expect(asVoid({ body: null }, 'contacts.addGroup')).toBe(true);
    expect(asVoid({ body: '' }, 'contacts.addGroup')).toBe(true);
    expect(isStoreError(asVoid({ body: {} }, 'contacts.addGroup'))).toBe(true);
  });

  it('classifies a contacts raise as a conflict and names its marker', () => {
    const error = mapError(unknownGroup('x'));
    expect(error.code).toBe('conflict');
    expect(error.message).toBe('unknown_group:x');
    expect(contactsMarker(error)).toBe('unknown_group');
    expect(contactsMarker(mapError(groupedSchedule('x')))).toBeNull();
  });

  it('keeps only the string answers of a stored membership', () => {
    const row = mapMemberRow(
      {
        id: 4,
        contact_id: 2,
        email: 'ana@x.co',
        joined_at: new Date('2026-10-02T14:02:00.000Z'),
        form: null,
        page: null,
        properties: { tier: 'team', seats: 5 },
        updated_at: '2026-10-02T14:03:00+00:00',
        suppressed: false,
      },
      'cloud-waitlist',
    );
    expect(row.properties).toEqual({ tier: 'team' });
    expect(row).toMatchObject({ id: 4, contactId: 2, group: 'cloud-waitlist', updatedAt: '2026-10-02T14:03:00.000Z' });
  });
});

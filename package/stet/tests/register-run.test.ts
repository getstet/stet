/**
 * The one shared-text index (cli/register-run.ts `sharedTextIndex`): the keys
 * each text is held by, which a JSX literal's reuse and a save's same-words
 * reply both read.
 */
import { describe, expect, it } from 'vitest';

import { sharedTextIndex } from '../cli/register-run.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';

const DESCRIPTOR: Descriptor = {
  version: 1,
  keys: {
    home_title: { shape: 'text', target: 'web' },
    brand__name: { shape: 'text', target: 'web' },
    hero__headline: { shape: 'text', target: 'web' },
    tagged: { shape: 'text', target: 'web', tags: 1 },
    derived: { shape: 'text', target: 'web', derivesFrom: 'b_plain', tmpl: '{v}' },
    b_plain: { shape: 'text', target: 'web' },
    a_plain: { shape: 'text', target: 'web' },
    mail_subject: { shape: 'text', target: 'html-email' },
  },
  templates: { hero: { slots: ['headline'] } },
  pages: { home: { route: '/', seo: { title: 'home_title' } } },
} as unknown as Descriptor;

const SNAPSHOT: Snapshot = {
  default: {
    home_title: 'Shared words',
    brand__name: 'Shared words',
    hero__headline: 'Shared words',
    tagged: 'Shared <1>words</1>',
    b_plain: 'Shared words',
    a_plain: 'Shared words',
    mail_subject: 'Shared words',
  },
};

describe('sharedTextIndex', () => {
  it("leaves out a key a page's seo names, a brand__ key, a slot key, a tagged key and a derived key", () => {
    const index = sharedTextIndex(DESCRIPTOR, SNAPSHOT);
    const all = [...index.values()].flat();
    for (const key of ['home_title', 'brand__name', 'hero__headline', 'tagged', 'derived', 'mail_subject']) {
      expect(all).not.toContain(key);
    }
  });

  it('lists two keys holding one text sorted by name', () => {
    expect(sharedTextIndex(DESCRIPTOR, SNAPSHOT).get('Shared words')).toEqual(['a_plain', 'b_plain']);
  });
});

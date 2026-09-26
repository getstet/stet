/**
 * The operator docs as a reader meets them: the sections, sentences and anchors
 * other surfaces point at. `init` links the contacts doc's two recipes by their
 * GitHub anchors, so a renamed heading is a dead link in a stranger's terminal.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const contacts = readFileSync(new URL('../../docs/operator/contacts.md', import.meta.url), 'utf8');
/** One paragraph or bullet as one line, so a sentence reads whole across its wrap. */
const flat = contacts.replace(/\n(?!\n|#|\||```|- )\s*/g, ' ');

/** A heading's anchor as GitHub makes it: lowercased, punctuation dropped, spaces as hyphens. */
const anchor = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

describe('the contacts doc', () => {
  const headings = [...contacts.matchAll(/^## (.+)$/gm)].map((m) => m[1] as string);

  it('carries Where it runs after the two recipes', () => {
    const at = headings.indexOf('Where it runs');
    expect(at).toBeGreaterThan(headings.indexOf('The Next.js recipe'));
    expect(at).toBeGreaterThan(headings.indexOf('The Worker recipe'));
    expect(flat).toContain('The handler takes a web `Request` and answers a web `Response`.');
    expect(flat).toContain('Astro in server mode, SvelteKit, Remix, Nuxt, Hono, Bun and Deno each hand a route a web `Request`, and are untested.');
    expect(flat).toContain('needs an adapter that builds a `Request` from it and writes the `Response` back');
  });

  it('states the origin rule, which page is stored, and the security notes’ origin paragraph', () => {
    expect(flat).toContain('from any origin unless `allowedOrigins` narrows it');
    expect(flat).toContain('so the stored page\'s origin is always the one the browser asserted');
    expect(flat).toContain(
      "Any web page can post a join to an open group, from its visitors' browsers, unless allowedOrigins narrows the route to your own origin and the ones you list. " +
        'Each membership records the origin of the page that posted it, which the browser asserts and a page cannot forge. ' +
        'An onJoin that sends mail turns every such join into a message to the address it names: pair it with allowedOrigins or a confirmation step.',
    );
  });

  it('says a host that installs pg after next build builds again, and answers the anchors init links', () => {
    expect(flat).toContain('a host that installs `pg` after `next build` builds again');
    const anchors = headings.map(anchor);
    expect(anchors).toContain('the-nextjs-recipe');
    expect(anchors).toContain('the-worker-recipe');
  });
});

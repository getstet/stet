// @vitest-environment jsdom
/**
 * The conformance walk for the `content-read` MODIFIED requirement. It lives
 * here, not in `conformance.test.ts`, because its scenarios use JSX (`useCopy`
 * under a `CopyProvider`, the typed-key proof) — TS17004 in the non-jsx
 * conformance program. One Requirement test, the same walk shape.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readBundle, resolveAll } from '../src/bundle.js';
import type { Descriptor } from '../src/types.js';
import { CopyProvider, useCopy } from './provider.js';
import { createServerCopy } from './server.js';

const descriptor: Descriptor = {
  version: 1,
  keys: {
    hero_headline: { shape: 'text', target: 'web' },
    plan_count: { shape: 'number', target: 'web' },
    unset_key: { shape: 'text', target: 'web' },
  },
};

describe('content-read', () => {
  it('Requirement: Ambient copy access is provided, never mandated', () => {
    // resolveAll builds the map the read boundary hands the accessor.
    const bundle = readBundle({ default: { hero_headline: 'Never miss a post again.', plan_count: 3 } });
    const { resolved, warnings } = resolveAll(descriptor, bundle);

    // A leaf adopts with no caller changes: useCopy() under a provider serves it.
    function Hero() {
      const copy = useCopy();
      return <h1>{copy('hero_headline')}</h1>;
    }
    const html = renderToStaticMarkup(
      <CopyProvider descriptor={descriptor} resolved={resolved}>
        <Hero />
      </CopyProvider>,
    );
    expect(html).toBe('<h1>Never miss a post again.</h1>');

    // The server accessor serves the same map, and a host that threads the same
    // value through its own props seam is equally conformant — same value.
    const server = createServerCopy(descriptor, resolved);
    expect(server('hero_headline')).toBe('Never miss a post again.');
    expect(server.get('plan_count')).toBe(3);

    // Typed access holds: a call for a key outside the generated union does not
    // typecheck where codegen has run (type-only, never invoked).
    void ((): void => {
      const copy = createServerCopy<'hero_headline' | 'plan_count'>(descriptor, resolved);
      // @ts-expect-error — 'nope' is not a registered key
      copy('nope');
    });

    // A missing value warns and is absent — no {{token}} or literal key renders.
    expect(warnings.some((w) => w.code === 'no_value' && w.key === 'unset_key')).toBe(true);
    expect('unset_key' in resolved).toBe(false);
  });
});

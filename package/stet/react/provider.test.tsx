// @vitest-environment jsdom
/**
 * The React read layer, rendered. Each case renders a component through
 * `react-dom/server` and asserts the accessor's behavior: `useCopy` under a
 * provider, `.get()` for a non-text key, the `AccessError` path, the clear
 * error outside a provider, and the server accessor without a provider. The
 * typed-key proof is a type-only `@ts-expect-error` — this file typechecks under
 * `react/tsconfig.test.json`, so a call the generic rejects fails the build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AccessError } from '../src/access.js';
import type { Descriptor } from '../src/types.js';
import { CopyProvider, useCopy } from './provider.js';
import { createServerCopy } from './server.js';

const descriptor: Descriptor = {
  version: 1,
  keys: {
    hero_headline: { shape: 'text', target: 'web' },
    plan_count: { shape: 'number', target: 'web' },
  },
};
const resolved: Record<string, unknown> = { hero_headline: 'Never miss a post again.', plan_count: 3 };

describe('useCopy under a CopyProvider', () => {
  it('serves a text key', () => {
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
  });

  it('.get() serves a non-text key', () => {
    let seen: unknown;
    function Count() {
      seen = useCopy().get('plan_count');
      return null;
    }
    renderToStaticMarkup(
      <CopyProvider descriptor={descriptor} resolved={resolved}>
        <Count />
      </CopyProvider>,
    );
    expect(seen).toBe(3);
  });

  it('a key declared but absent from the resolved map follows AccessError', () => {
    function Missing() {
      return <p>{useCopy()('hero_headline')}</p>;
    }
    expect(() =>
      renderToStaticMarkup(
        <CopyProvider descriptor={descriptor} resolved={{}}>
          <Missing />
        </CopyProvider>,
      ),
    ).toThrow(AccessError);
  });

  it('throws a clear error outside a provider', () => {
    function Bare() {
      return <span>{useCopy()('hero_headline')}</span>;
    }
    expect(() => renderToStaticMarkup(<Bare />)).toThrow(/outside a <CopyProvider>/);
  });
});

describe("the 'use client' directive (P1-1)", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('provider.tsx carries a use client directive as its first statement', () => {
    // A string-expression statement is only a directive in the prologue, so the
    // FIRST statement must be it — createContext throws under the react-server
    // condition otherwise, failing every App-Router `next build` init mounts.
    const body = read('./provider.tsx')
      .replace(/^\uFEFF/, '')
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''); // strip a leading block comment
    expect(body.startsWith("'use client';")).toBe(true);
  });

  it('index.ts and server.ts stay undirected — createServerCopy must be server-evaluable', () => {
    expect(read('./index.ts')).not.toContain("'use client'");
    expect(read('./server.ts')).not.toContain("'use client'");
  });
});

describe('createServerCopy', () => {
  it('serves the same map with no provider', () => {
    const copy = createServerCopy(descriptor, resolved);
    expect(copy('hero_headline')).toBe('Never miss a post again.');
    expect(copy.get('plan_count')).toBe(3);
  });

  it('the accessor is generic: an unregistered key does not typecheck', () => {
    // Type-only — never invoked. A call outside the key union must fail the build.
    void ((): void => {
      const copy = createServerCopy<'hero_headline' | 'plan_count'>(descriptor, resolved);
      // @ts-expect-error — 'nope' is not in the key union
      copy('nope');
      copy('hero_headline');
    });
    expect(createServerCopy<'hero_headline'>(descriptor, resolved)('hero_headline')).toBe(
      'Never miss a post again.',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { miniDescriptor, miniRows, miniSnapshot } from '../conformance/fixture.js';
import { AccessError, createAccessor, resolve } from '../src/index.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();
const rows = miniRows();

/** What a host hands the accessor: one resolution per key, done once per request. */
function resolvedMap(): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const key of Object.keys(descriptor.keys)) {
    map[key] = resolve(descriptor, snapshot, rows, { key }).value;
  }
  return map;
}

describe('createAccessor', () => {
  it('serves exactly what the read path resolved', () => {
    const copy = createAccessor(descriptor, resolvedMap());
    expect(copy('hero_headline')).toBe(
      resolve(descriptor, snapshot, rows, { key: 'hero_headline' }).value,
    );
    expect(copy.get('footer_links')).toEqual(['Privacy', 'Terms', 'Status']);
  });

  it('lets a leaf adopt a key without its callers passing anything', () => {
    // The accessor is the only argument a leaf needs; no ancestor is involved.
    const copy = createAccessor(descriptor, resolvedMap());
    const leaf = () => copy('hero_body');
    expect(leaf()).toContain('{{handle}}');
  });

  it('throws on an unknown key by default — no environment sniffing', () => {
    const copy = createAccessor(descriptor, resolvedMap());
    expect(() => copy('hero_headlin' as never)).toThrowError(AccessError);
  });

  it('serves the resolved map’s value for an unknown key in fallback mode', () => {
    const copy = createAccessor(
      descriptor,
      { ...resolvedMap(), legacy_banner: 'Still rendered.' },
      { onUnknownKey: 'fallback' },
    );
    expect(copy('legacy_banner' as never)).toBe('Still rendered.');
    expect(copy.get('legacy_banner' as never)).toBe('Still rendered.');
  });

  it('sends non-text shapes through get, rather than guessing at a string', () => {
    const copy = createAccessor(descriptor, resolvedMap());
    expect(() => copy('footer_links' as never)).toThrowError(/shape: list/);
    expect(() => copy('brand__radius' as never)).toThrowError(AccessError);
    expect(copy.get('brand__radius')).toBe(8);
  });

  it('refuses a declared key that was never resolved, instead of rendering nothing', () => {
    const copy = createAccessor(descriptor, { hero_headline: 'Only this one.' });
    expect(() => copy('hero_body')).toThrowError(/resolved map/);
  });
});

import { describe, expect, it } from 'vitest';

import { miniDescriptor, mutable } from '../conformance/fixture.js';
import { embeddedHash, generateRegistry, generatedBody, sourceHash } from '../src/codegen.js';
import { DESCRIPTOR_SCHEMA, loadDescriptor } from '../src/index.js';
import { installRegistryDts, typecheckHost } from './helpers/ts-host.js';

const descriptor = miniDescriptor();

/** The entries of one emitted `export const <name> = [ … ] as const;` block. */
function entriesOf(keysTs: string, name: string): string[] {
  const block = new RegExp(`^export const ${name} = \\[\\n([\\s\\S]*?)^\\] as const;$`, 'm').exec(keysTs);
  return [...(block?.[1] ?? '').matchAll(/^ {2}'([a-z0-9_]+)',$/gm)].map((m) => m[1] as string);
}

describe('generateRegistry', () => {
  it('emits keys sorted, so the registry is a stable diff', () => {
    const { keysTs } = generateRegistry(descriptor);
    const listed = entriesOf(keysTs, 'KEYS');
    expect(listed).toEqual([...listed].sort());
    expect(listed).toEqual(Object.keys(descriptor.keys).sort());
  });

  it('emits StringKey over the string-valued shapes alone, sorted', () => {
    // The mini descriptor declares all eight shapes, so this reads the whole
    // membership rule in one pass: the five that resolve to a string are in, and
    // list, record and number — the three a `Record<StringKey, string>` has to
    // refuse — are out. Membership is by shape, never a per-key list.
    const { keysTs } = generateRegistry(descriptor);
    const strings = entriesOf(keysTs, 'STRING_KEYS');
    const byShape = (...shapes: string[]): string[] =>
      Object.entries(descriptor.keys)
        .filter(([, def]) => shapes.includes(def.shape))
        .map(([key]) => key)
        .sort();

    expect(strings).toEqual(byShape('text', 'richtext', 'media', 'enum', 'color'));
    expect(strings).toEqual([...strings].sort());
    for (const excluded of byShape('list', 'record', 'number')) {
      expect(strings).not.toContain(excluded);
    }
    // The three exclusions are real keys, so the assertion above is not vacuous.
    expect(byShape('list', 'record', 'number')).toEqual(['brand__radius', 'contact_form_labels', 'footer_links']);
    expect(keysTs).toContain('export type StringKey = (typeof STRING_KEYS)[number];\n');
  });

  it('classifies EVERY shape the schema declares — the guard a ninth shape trips', () => {
    // The fixtures around this one are written from the shapes that exist
    // today, so a ninth shape would land with no key of its own and none of
    // them would notice. This reads the enum out of the published schema at
    // runtime and puts one key of every declared shape through the generator:
    // each shape must come out either in `STRING_KEYS` or out of it, and a
    // shape the emission has never heard of fails here rather than in a host.
    const shapes = (
      DESCRIPTOR_SCHEMA as unknown as {
        $defs: { keyDef: { properties: { shape: { enum: string[] } } } };
      }
    ).$defs.keyDef.properties.shape.enum;
    const stringValued = ['text', 'richtext', 'media', 'enum', 'color'];
    const structured = ['list', 'record', 'number'];
    // The ENUMERATION first. A ninth shape in the schema fails right here, and
    // that is the whole point: somebody has to decide whether its value is a
    // string before the emission can be right about it either way.
    expect([...shapes].sort()).toEqual([...stringValued, ...structured].sort());

    const keys: Record<string, unknown> = {};
    for (const shape of shapes) {
      keys[`k_${shape.replace(/-/g, '_')}`] =
        shape === 'enum' ? { shape, target: 'web', values: ['a'] } : { shape, target: 'web' };
    }
    const { keysTs } = generateRegistry(loadDescriptor({ version: 1, keys }));
    const strings = new Set(entriesOf(keysTs, 'STRING_KEYS'));
    const all = entriesOf(keysTs, 'KEYS');

    // Every declared shape is accounted for, in one bucket or the other.
    expect(all).toHaveLength(shapes.length);
    for (const shape of shapes) {
      const key = `k_${shape.replace(/-/g, '_')}`;
      expect(all).toContain(key);
      expect(strings.has(key)).toBe(stringValued.includes(shape));
    }
    // …and the classification is not vacuously all-in or all-out.
    expect(strings.size).toBeGreaterThan(0);
    expect(strings.size).toBeLessThan(all.length);
  });

  it('yields never for a descriptor with no string-shaped keys', () => {
    const none = mutable(descriptor);
    none.keys = { footer_links: { shape: 'list', target: 'web' }, brand__radius: { shape: 'number', target: 'web' } };
    const { keysTs } = generateRegistry(none);
    // The same `(typeof [])[number]` mechanics as `KEYS`, with no special arm:
    // an empty array literal's element type IS `never`.
    expect(entriesOf(keysTs, 'STRING_KEYS')).toEqual([]);
    expect(keysTs).toContain('export const STRING_KEYS = [\n] as const;\n');
  });

  it('carries a header naming its source and that source’s hash', () => {
    const { keysTs, dts } = generateRegistry(descriptor);
    expect(keysTs.startsWith('// generated by stet — source-hash: ')).toBe(true);
    expect(embeddedHash(keysTs)).toBe(sourceHash(descriptor));
    expect(embeddedHash(dts)).toBe(sourceHash(descriptor));
    expect(keysTs.split('\n')[1]).toContain('source: descriptor.json');
  });

  it('is reproducible — same descriptor in, byte-identical registry out', () => {
    const first = generateRegistry(descriptor);
    const second = generateRegistry(mutable(descriptor));
    expect(second.keysTs).toBe(first.keysTs);
    expect(second.dts).toBe(first.dts);
    // Compared as BYTES, not as strings: a CI diff is over bytes, and the second
    // emission has to reproduce as exactly as the first.
    expect(Buffer.from(second.keysTs, 'utf8').equals(Buffer.from(first.keysTs, 'utf8'))).toBe(true);
    expect(Buffer.from(second.dts, 'utf8').equals(Buffer.from(first.dts, 'utf8'))).toBe(true);
    // Including the second union's own block, which is what this change added.
    const block = (text: string): string => /^export const STRING_KEYS = \[[\s\S]*?^\] as const;$/m.exec(text)![0];
    expect(Buffer.from(block(second.keysTs), 'utf8').equals(Buffer.from(block(first.keysTs), 'utf8'))).toBe(true);
  });

  it('emits the ambient module augmentation whether or not the host is TypeScript', () => {
    const { dts } = generateRegistry(descriptor);
    expect(generatedBody(dts)).toContain("declare module '@getstet/stet'");
    expect(generatedBody(dts)).toContain('interface StetRegistry');
    expect(generatedBody(dts)).toContain("| 'hero_headline'");
  });

  it('refuses to emit a key name that would need escaping', () => {
    const broken = mutable(descriptor);
    broken.keys["it's"] = { shape: 'text', target: 'web' };
    expect(() => generateRegistry(broken)).toThrowError(/key names/);
  });
});

describe('sourceHash', () => {
  it('ignores key order, so a reformat is not a stale report', () => {
    expect(sourceHash({ a: 1, b: { c: 2, d: 3 } })).toBe(sourceHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(sourceHash({ a: 1 })).not.toBe(sourceHash({ a: 2 }));
  });
});

describe('the generated types in a host', () => {
  it('accepts a registered key and fails a typo, before any runtime path is exercised', () => {
    installRegistryDts(generateRegistry(descriptor).dts);

    const ok = typecheckHost('tsconfig.ok.json');
    expect(ok.output).toBe('');
    expect(ok.ok).toBe(true);

    const bad = typecheckHost('tsconfig.bad.json');
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('hero_headlin');
  }, 60_000);
});

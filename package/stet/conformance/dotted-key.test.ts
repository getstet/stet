// add-plain-js-hosts (0.9.0), Q32: a dotted key walks the conformance contract on a project of its own, so the shared mini-project keeps its keys and counts.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateDefaultsModule, generateRegistry, generateResolvedModule } from '../src/codegen.js';
import { loadDescriptor, loadSnapshot } from '../src/index.js';
import { makeCliHost } from './cli-host.js';

const DOTTED = 'waitlist.use.music_videos';
const dir = new URL('./fixtures/dotted-project/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

/** The entries of one emitted `export const <name> = [ … ] as const;` block, read the way the shared walk reads them. */
function entriesOf(keysTs: string, name: string): string[] {
  const block = new RegExp(`^export const ${name} = \\[\\n([\\s\\S]*?)^\\] as const;$`, 'm').exec(keysTs);
  return [...(block?.[1] ?? '').matchAll(/^ {2}'([a-z0-9_.]+)',$/gm)].map((m) => m[1] as string);
}

describe('dotted-project conformance', () => {
  const descriptor = loadDescriptor(read('descriptor.json'));
  const snapshot = loadSnapshot(read('defaults.json'));

  it('the registry, defaults and resolved modules carry the dotted key beside its underscore sibling', () => {
    const { keysTs, dts } = generateRegistry(descriptor);
    expect(entriesOf(keysTs, 'KEYS')).toEqual(['home.title', 'waitlist.count', DOTTED, 'waitlist_use'].sort());
    expect(entriesOf(keysTs, 'STRING_KEYS')).toContain(DOTTED);
    expect(dts).toContain(`| '${DOTTED}'`);
    expect(generateDefaultsModule(snapshot)).toContain(`"${DOTTED}": "Music videos"`);
    expect(generateResolvedModule(descriptor, snapshot)).toContain(`"${DOTTED}"`);
  });

  it('stet check accepts a project whose forms carry a dotted key', async () => {
    const host = makeCliHost({ config: {} });
    cpSync(new URL('descriptor.json', dir), join(host.cwd, 'content/descriptor.json'));
    cpSync(new URL('defaults.json', dir), join(host.cwd, 'content/defaults.json'));
    const registry = generateRegistry(descriptor);
    writeFileSync(join(host.cwd, 'content/keys.ts'), registry.keysTs);
    writeFileSync(join(host.cwd, 'content/stet-env.d.ts'), registry.dts);
    writeFileSync(join(host.cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));
    writeFileSync(join(host.cwd, 'content/resolved.ts'), generateResolvedModule(descriptor, snapshot));
    expect(await host.run('check')).toBe(0);
    expect(host.file('content/keys.ts')).toContain(`'${DOTTED}'`);
  });
});

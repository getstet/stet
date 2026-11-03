// add-plain-js-hosts (0.9.0), chunk C2: `stet import`, the copy module's pair and object shapes, placeholders converted on the way in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { scanModule } from '../cli/source-scan.js';
import { cleanupCliHosts, makeHtmlHost, type CliHost } from '../conformance/cli-host.js';

afterAll(() => cleanupCliHosts());

/** An html host with no keys, the files given, and the config's own fields. */
async function site(files: Record<string, string>, config: Record<string, unknown> = {}, keys: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): Promise<CliHost> {
  return await makeHtmlHost({ files: { 'index.html': '<!doctype html><html><body><p>Nothing marked here yet.</p></body></html>\n', ...files }, config, keys, defaults });
}

/** The bytes of every form an import may write, for the nothing-written guards. */
function forms(host: CliHost): Record<string, string | null> {
  const read = (rel: string): string | null => (host.exists(rel) ? host.file(rel) : null);
  return Object.fromEntries(['content/descriptor.json', 'content/defaults.json', 'content/status.json', 'stet.config.json'].map((rel) => [rel, read(rel)]));
}

describe('add-plain-js-hosts (0.9.0) C2', () => {
  it('P2.1 toStet, toHost and varsOf on {n}, {{n}}, {a} {b} and a { with no name', async () => {
    const { toStet, toHost, varsOf } = await import('../src/placeholders.js');
    expect(toStet('{n} people are waiting', '{name}')).toBe('{{n}} people are waiting');
    expect(toStet('{{n}} people are waiting', '{name}')).toBe('{{n}} people are waiting');
    expect(toStet('{a} {b}', '{name}')).toBe('{{a}} {{b}}');
    expect(toStet('a { b and {} and { c }', '{name}')).toBe('a { b and {} and { c }');
    expect(toStet('{n} people', '{{name}}')).toBe('{n} people');
    expect(toHost('{{n}} people are waiting', '{name}')).toBe('{n} people are waiting');
    expect(toHost('{{a}} {{b}}', '{name}')).toBe('{a} {b}');
    expect(toHost('a { b', '{name}')).toBe('a { b');
    expect(toHost('{{n}} people', '{{name}}')).toBe('{{n}} people');
    expect(varsOf('{{b}} and {{a}} and {{b}}')).toEqual(['a', 'b']);
    expect(varsOf('{n} and a { b')).toEqual([]);
  });

  it('P2.2 a pair proposes its element 0 under the property name, an object its value member, and neither proposes a sibling', async () => {
    const result = await scanModule(
      'design/data/copy.js',
      'window.TS = window.TS || {};\n' +
        'TS.copyTable = {\n' +
        '  "home.title": ["Make your whole ad campaign.", "approved"],\n' +
        '  "home.lead": { value: "Every variant, one run.", note: 1, hint: "A note for the writer only." },\n' +
        '  "home.sub": "A bare string reads as it always has.",\n' +
        '};\n',
    );
    expect(result.literals.map((l) => [l.proposedKey, l.text, l.shape, l.form ?? null])).toEqual([
      ['home.title', 'Make your whole ad campaign.', 'property', 'pair'],
      ['home.lead', 'Every variant, one run.', 'property', 'object'],
      ['home.sub', 'A bare string reads as it always has.', 'property', null],
    ]);
  });

  it('P2.3 import from JSON, a classic script, an ES module; --export, the default export and the refusals', async () => {
    const host = await site(
      {
        'strings.json': JSON.stringify({ 'home.title': 'Welcome', 'home.count': '{n} waiting' }),
        'copy.js': 'window.TS = window.TS || {};\nTS.copyTable = { "a.b": "Alpha" };\n',
        'strings.mjs': 'export const STRINGS = { "w.x": "Hi {name}" };\nexport function t(key) { return STRINGS[key]; }\n',
        'nested.mjs': 'export const ALL = { en: { "p.q": "Queue" } };\n',
        'default.mjs': 'export default { "d.e": "Default words" };\nexport const OTHER = { "o.p": "Other words" };\n',
        'two.mjs': 'export const A = { "a.a": "A" };\nexport const B = { "b.b": "B" };\n',
        'imports.mjs': "import x from './y.js';\nexport const S = { 's.t': x };\n",
        'broken.js': 'throw new Error("boom");\n',
      },
      { placeholders: '{name}' },
    );
    expect(await host.run('import', 'strings.json', '--write')).toBe(0);
    expect(host.stdout()).toContain('import: 2 keys from strings.json');
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, unknown> };
    expect(descriptor.keys['home.title']).toEqual({ shape: 'text', target: 'web' });
    expect(descriptor.keys['home.count']).toEqual({ shape: 'text', target: 'web', vars: ['n'] });
    expect(JSON.parse(host.file('content/defaults.json')).default['home.count']).toBe('{{n}} waiting');

    host.out.length = 0;
    expect(await host.run('import', 'copy.js', '--export', 'TS.copyTable')).toBe(0);
    expect(host.out).toEqual(['import: 1 keys from copy.js (TS.copyTable)', '  new 1 · same 0 · differs 0 · skipped 0', '  a.b  "Alpha"', '  status: 0 approved, 1 proposed']);

    host.out.length = 0;
    expect(await host.run('import', 'strings.mjs')).toBe(0);
    expect(host.out.slice(0, 3)).toEqual(['import: 1 keys from strings.mjs (STRINGS)', '  new 1 · same 0 · differs 0 · skipped 0', '  w.x  "Hi {{name}}"  vars: name']);

    host.out.length = 0;
    expect(await host.run('import', 'nested.mjs', '--export', 'ALL.en')).toBe(0);
    expect(host.out[2]).toBe('  p.q  "Queue"');

    host.out.length = 0;
    expect(await host.run('import', 'default.mjs')).toBe(0);
    expect(host.out.slice(0, 3)).toEqual(['import: 1 keys from default.mjs (default)', '  new 1 · same 0 · differs 0 · skipped 0', '  d.e  "Default words"']);

    expect(await host.run('import', 'two.mjs')).toBe(1);
    expect(host.stderr()).toContain('import: two.mjs exports several objects — name one with --export');
    expect(await host.run('import', 'strings.mjs', '--export', 'NOPE')).toBe(1);
    expect(host.stderr()).toContain('import: strings.mjs exports no NOPE');
    expect(await host.run('import', 'imports.mjs')).toBe(1);
    expect(host.stderr()).toContain('import: imports.mjs imports ./y.js — import a module that stands alone');
    expect(await host.run('import', 'broken.js')).toBe(1);
    expect(host.stderr()).toContain('import: broken.js could not be evaluated: boom');
  });

  it('P2.4 the plan prints its four sections, and a differing key refuses without --replace', async () => {
    const host = await site(
      { 't.json': JSON.stringify({ 'home.title': 'B', 'home.lead': 'Same words', 'home.new': '{n} new', 'Bad Key': 'q', 'home.empty': '', 'home.num': 3 }) },
      { placeholders: '{name}' },
      { 'home.title': { shape: 'text', target: 'web' }, 'home.lead': { shape: 'text', target: 'web' } },
      { 'home.title': 'A', 'home.lead': 'Same words' },
    );
    expect(await host.run('import', 't.json')).toBe(1);
    expect(host.out).toEqual([
      'import: 6 keys from t.json',
      '  new 1 · same 1 · differs 1 · skipped 3',
      `  home.title  differs: "B" — the snapshot holds "A"; pass --replace to take the file's`,
      '  home.new  "{{n}} new"  vars: n',
      '  Bad Key  skipped: not a key name',
      '  home.empty  skipped: an empty value',
      '  home.num  skipped: not a string, a [value, meta] pair or a { value } object',
      '  status: 0 approved, 1 proposed',
    ]);
    expect(host.err).toEqual(['error: import: 1 keys differ — nothing written; pass --replace to take the file\'s values, or --only to leave them out']);

    expect(await host.run('import', 't.json', '--replace', '--write')).toBe(0);
    expect(JSON.parse(host.file('content/defaults.json')).default['home.title']).toBe('B');
  });

  it('P2.5 --only keeps 43 of a 360-key table; --section, vars, keyStyle and the status file are written', async () => {
    const rows: string[] = [];
    for (let i = 0; i < 317; i += 1) rows.push(`  "nav.item_${i}": ["Menu entry number ${i}", "${i % 2 === 0 ? 'approved' : 'ask'}"],`);
    for (let i = 0; i < 39; i += 1) rows.push(`  "${i < 10 ? 'home' : 'waitlist'}.line_${i}": ["Line ${i} of the waitlist pages", "new"],`);
    rows.push('  "waitlist.count": ["{n} people are waiting", "new"],');
    rows.push('  "home.title": ["Make your whole ad campaign.", "approved"],');
    rows.push('  "waitlist.pill": ["For ads, music videos and films", "approved"],');
    rows.push('  "waitlist.join": ["Join the waitlist", "approved"],');
    const host = await site(
      {
        'design/data/copy.js': `window.TS = window.TS || {};\nTS.copyTable = {\n${rows.join('\n')}\n};\n`,
        'index.html': '<!doctype html><html><body><section id="hero"><h2>Pick the plan that fits you</h2></section></body></html>\n',
      },
      { placeholders: '{name}', copyModules: ['design/data/copy.js'] },
    );
    expect(await host.run('import', 'design/data/copy.js', '--export', 'TS.copyTable', '--only', 'home.', 'waitlist.', '--section', 'design', '--by', 'nj-io', '--write')).toBe(0);
    expect(host.out[0]).toBe('import: 43 keys from design/data/copy.js (TS.copyTable)');
    expect(host.out[1]).toBe('  new 43 · same 0 · differs 0 · skipped 0');
    expect(host.out).toContain('  waitlist.count  "{{n}} people are waiting"  vars: n');
    expect(host.out).toContain('  status: 3 approved, 40 proposed');
    for (const rel of ['content/descriptor.json', 'content/defaults.json', 'content/status.json', 'stet.config.json']) expect(host.out).toContain(`wrote ${rel}`);

    const descriptor = JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, { section?: string; vars?: string[] }> };
    expect(Object.keys(descriptor.keys)).toHaveLength(43);
    expect(Object.values(descriptor.keys).every((def) => def.section === 'design')).toBe(true);
    expect(descriptor.keys['waitlist.count']?.vars).toEqual(['n']);
    expect(JSON.parse(host.file('stet.config.json')).keyStyle).toBe('dotted');
    const status = JSON.parse(host.file('content/status.json')) as Record<string, { status: string; by?: string; at?: string }>;
    expect(Object.keys(status)).toHaveLength(43);
    const approved = Object.entries(status).filter(([, entry]) => entry.status === 'approved');
    expect(approved.map(([key]) => key).sort()).toEqual(['home.title', 'waitlist.join', 'waitlist.pill']);
    expect(approved.every(([, entry]) => entry.by === 'nj-io' && /^\d{4}-\d{2}-\d{2}$/.test(entry.at ?? ''))).toBe(true);

    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);

    // The scan on the dotted project: the table's undeclared rows name their shape, and a page's proposal joins its parts with a dot.
    host.out.length = 0;
    host.err.length = 0;
    await host.run('scan');
    const lines = host.stderr().split('\n');
    expect(lines.filter((l) => / unkeyed copy ".*" \(pair\) — propose key nav\.item_\d+$/.test(l))).toHaveLength(317);
    expect(lines.some((l) => /"approved"|propose key (approved|ask|new)\b|diverged/.test(l))).toBe(false);
    expect(lines.some((l) => /index\.html:1 possible copy "Pick the plan that fits you" — propose key home\.hero\./.test(l))).toBe(true);
  });

  it('P2.6 a differing key without --replace writes nothing', async () => {
    const host = await site({ 't.json': JSON.stringify({ 'home.title': 'B', 'home.new': 'New words' }) }, {}, { 'home.title': { shape: 'text', target: 'web' } }, { 'home.title': 'A' });
    const before = forms(host);
    expect(await host.run('import', 't.json', '--write')).toBe(1);
    expect(forms(host)).toEqual(before);
  });

  it('P2.7 a value the gate refuses writes nothing', async () => {
    const host = await site(
      { 't.json': JSON.stringify({ 'home.count': '{m} waiting', 'home.new': 'New words' }) },
      { placeholders: '{name}' },
      { 'home.count': { shape: 'text', target: 'web', vars: ['n'] } },
      { 'home.count': '{{n}} waiting' },
    );
    const before = forms(host);
    expect(await host.run('import', 't.json', '--replace', '--write')).toBe(1);
    expect(host.stderr()).toContain('home.count: undeclared variable {{m}}');
    expect(forms(host)).toEqual(before);
  });

  it('P2.8 the sandbox holds no process, require or fetch', async () => {
    const host = await site({
      'env.mjs': 'export const S = { "a.b": process.env.HOME };\n',
      'escape.mjs': 'export const S = { "a.b": this.constructor.constructor("return process")().env.HOME };\n',
      'probe.mjs': 'export const S = { "a.b": typeof require + " " + typeof fetch + " " + typeof process };\n',
    });
    const before = forms(host);
    expect(await host.run('import', 'env.mjs', '--write')).toBe(1);
    expect(host.stderr()).toContain('import: env.mjs could not be evaluated: process is not defined');
    expect(await host.run('import', 'escape.mjs', '--write')).toBe(1);
    expect(host.stderr()).toContain('import: escape.mjs could not be evaluated:');
    expect(forms(host)).toEqual(before);
    host.out.length = 0;
    expect(await host.run('import', 'probe.mjs')).toBe(0);
    expect(host.out[2]).toBe('  a.b  "undefined undefined undefined"');
    expect(readFileSync(join(host.cwd, 'content/descriptor.json'), 'utf8')).toBe(before['content/descriptor.json']);
  });
});

// add-plain-js-hosts (0.9.0), chunk C2: `stet import`, the copy module's pair and object shapes, placeholders converted on the way in.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { packageRoot } from '../cli/installed.js';
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
    // A name is what the stored grammar accepts, a digit start included.
    expect(toStet('{1} of {2b}', '{name}')).toBe('{{1}} of {{2b}}');
    expect(toHost('{{1}} of {{2b}}', '{name}')).toBe('{1} of {2b}');
    expect(toHost('{{n}} people are waiting', '{name}')).toBe('{n} people are waiting');
    expect(toHost('{{a}} {{b}}', '{name}')).toBe('{a} {b}');
    expect(toHost('a { b', '{name}')).toBe('a { b');
    expect(toHost('{{n}} people', '{{name}}')).toBe('{{n}} people');
    expect(varsOf('{{b}} and {{a}} and {{b}}')).toEqual(['a', 'b']);
    expect(varsOf('{n} and a { b')).toEqual([]);
  });

  it('P2.2 in a uniform table a pair proposes its element 0 under the property name and an object its value member, and neither proposes a sibling', async () => {
    const shape = async (source: string): Promise<Array<[string | undefined, string, string, string | null]>> =>
      (await scanModule('design/data/copy.js', source, { tables: true })).literals.map((l) => [l.proposedKey, l.text, l.shape, l.form ?? null]);
    // Every member a pair, one with a cast element.
    expect(
      await shape(
        'window.TS = window.TS || {};\n' +
          'TS.copyTable = {\n' +
          '  "home.title": ["Make your whole ad campaign.", "approved"],\n' +
          '  "home.sub": ["Every variant, one run." as const, "ask"],\n' +
          '};\n',
      ),
    ).toEqual([
      ['home.title', 'Make your whole ad campaign.', 'property', 'pair'],
      ['home.sub', 'Every variant, one run.', 'property', 'pair'],
    ]);
    // Every member an object with a string `value`.
    expect(
      await shape(
        'TS.copyTable = {\n' +
          '  "home.lead": { value: "Every variant, one run.", note: 1, hint: "A note for the writer only." },\n' +
          '  "home.tail": { value: "Last words on the page.", hint: "Another note." },\n' +
          '};\n',
      ),
    ).toEqual([
      ['home.lead', 'Every variant, one run.', 'property', 'object'],
      ['home.tail', 'Last words on the page.', 'property', 'object'],
    ]);
  });

  it('P2.2b a pair or an object in an ordinary object, a mixed table or a lone member reads as it did before', async () => {
    const keys = async (source: string): Promise<string[]> => (await scanModule('copy.js', source, { tables: true })).literals.map((l) => `${l.proposedKey}|${l.form ?? ''}`);
    // A list in an object of unlike members.
    expect(await keys('export const plan = { title: "Pricing page headline", features: ["Fast shipping", "Cheap prices"] };\n')).toEqual([
      'title|',
      'fast_shipping|',
      'cheap_prices|',
    ]);
    // An object with a `value` beside a bare string.
    expect(await keys('export const t = { cta: { value: "Buy now", label: "Purchase button" }, home: "Welcome home" };\n')).toEqual([
      'value|',
      'label|',
      'home|',
    ]);
    // One pair among bare strings: its status word is copy again.
    expect(await keys('export const t = { "home.title": ["Make your ad", "approved"], "home.sub": "A bare string here" };\n')).toEqual([
      'make_your_ad|',
      'approved|',
      'home.sub|',
    ]);
    // A table of one member is no evidence of a table.
    expect(await keys('export const t = { features: ["Fast shipping", "Cheap prices"] };\n')).toEqual(['fast_shipping|', 'cheap_prices|']);
  });

  it('P2.2c without reads or generated a table of pairs or objects reads as it did in 0.8.1', async () => {
    const { copyTablesOf } = await import('../cli/source-scan.js');
    const keys = async (source: string, tables?: boolean): Promise<string[]> =>
      (await scanModule('copy.js', source, tables === undefined ? {} : { tables })).literals.map((l) => l.proposedKey as string);
    const nav = 'export const nav = { primary: ["Home page", "About us"], secondary: ["Terms of use", "Privacy policy"] };\n';
    expect(await keys(nav)).toEqual(['home_page', 'about_us', 'terms_of_use', 'privacy_policy']);
    expect(await keys(nav, true)).toEqual(['primary', 'secondary']);
    const objects = 'export const t = { x: { value: "Buy now", label: "Purchase button" }, y: { value: "Sell now", label: "Sale button" } };\n';
    expect(await keys(objects)).toEqual(['value', 'label', 'sell_now', 'sale_button']);
    expect(copyTablesOf({ generated: [] })).toBe(false);
    expect(copyTablesOf({ reads: {}, generated: [] })).toBe(true);
    expect(copyTablesOf({ generated: [{}] })).toBe(true);
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

    host.out.length = 0;
    expect(await host.run('import', 't.json', '--replace', '--write')).toBe(0);
    expect(host.out).toContain('  home.title  differs: "B" — the snapshot holds "A"');
    expect(host.out.some((line) => line.includes('pass --replace'))).toBe(false);
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
      { placeholders: '{name}', copyModules: ['design/data/copy.js'], reads: { functions: ['TS.t'], attribute: 'data-copy' } },
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

  it('P2.8b a file that hangs the host stack answers inside the ceiling and writes nothing', async () => {
    const host = await site({
      'throw-proxy.mjs': 'throw new Proxy({}, { get() { while (true) {} } });\n',
      'throw-getter.mjs': 'throw { get message() { while (true) {} } };\n',
      'proto-default.mjs': 'Object.defineProperty(Object.prototype, "default", { get() { while (true) {} } });\nexport const S = { "a.b": "Alpha" };\n',
      'trap.mjs': 'export const S = new Proxy({}, { getOwnPropertyDescriptor() { while (true) {} } });\n',
    });
    const before = forms(host);
    for (const file of ['throw-proxy.mjs', 'throw-getter.mjs']) {
      expect(await host.run('import', file, '--write')).toBe(1);
      expect(host.stderr()).toContain(`import: ${file} could not be evaluated: an error that could not be read`);
    }
    expect(await host.run('import', 'trap.mjs', '--export', 'S.x', '--write')).toBe(1);
    expect(host.stderr()).toContain('import: trap.mjs could not be evaluated:');
    // An accessor the file put on Object.prototype never runs on stet's stack: the table imports as it stands.
    host.out.length = 0;
    expect(await host.run('import', 'proto-default.mjs')).toBe(0);
    expect(host.out[2]).toBe('  a.b  "Alpha"');
    expect(forms(host)).toEqual(before);
  }, 30_000);

  it('P2.8c a table past the size cap, or one the file made unreadable, is refused', async () => {
    const host = await site({
      'big.mjs': 'export const S = { "a.b": "x".repeat(2 ** 25) };\n',
      'json.mjs': 'JSON.stringify = () => ({ toString() { while (true) {} } });\nexport const S = { "a.b": "Alpha" };\n',
    });
    const before = forms(host);
    expect(await host.run('import', 'big.mjs', '--write')).toBe(1);
    expect(host.stderr()).toContain('import: big.mjs could not be evaluated: the table is too large');
    expect(await host.run('import', 'json.mjs', '--write')).toBe(1);
    expect(host.stderr()).toContain('import: json.mjs could not be evaluated: the table could not be read as data');
    expect(forms(host)).toEqual(before);
  }, 30_000);

  it('P2.9 a module whose comment holds an export line imports its real export; a second declarator exports too; unsupported syntax is named', async () => {
    const host = await site({
      'comment.mjs': 'export default { "d.e": "Default words" };\n/*\nexport const X = { "x.y": "in a comment" };\n*/\n',
      'second.mjs': 'export const A = { "a.b": "Alpha" }, B = { "b.c": "Beta" };\n',
      'destructure.mjs': 'export const { A } = { A: { "a.b": "x" } };\n',
      'await.mjs': 'export const A = { "a.b": await Promise.resolve("x") };\n',
    });
    expect(await host.run('import', 'comment.mjs')).toBe(0);
    expect(host.out[2]).toBe('  d.e  "Default words"');
    host.out.length = 0;
    expect(await host.run('import', 'second.mjs', '--export', 'B')).toBe(0);
    expect(host.out[2]).toBe('  b.c  "Beta"');
    expect(await host.run('import', 'destructure.mjs')).toBe(1);
    expect(host.stderr()).toContain('import: destructure.mjs could not be evaluated: a destructuring export is not supported — export each name on its own');
    expect(await host.run('import', 'await.mjs')).toBe(1);
    expect(host.stderr()).toContain('import: await.mjs could not be evaluated: top-level await is not supported');
  });

  it('P2.10 a declared key with no default is filled without --replace', async () => {
    const host = await site(
      { 't.json': JSON.stringify({ 'home.title': 'Welcome', 'home.lead': 'Lead words' }) },
      {},
      { 'home.title': { shape: 'text', target: 'web' }, 'home.lead': { shape: 'text', target: 'web' } },
      { 'home.lead': 'Lead words' },
    );
    expect(await host.run('import', 't.json', '--write')).toBe(0);
    expect(host.out.slice(0, 3)).toEqual(['import: 2 keys from t.json', '  new 1 · same 1 · differs 0 · skipped 0', '  home.title  "Welcome"']);
    expect(JSON.parse(host.file('content/defaults.json')).default['home.title']).toBe('Welcome');
  });

  it('P2.8d a setter on the thrown-value carrier never runs: the file is refused with its message', async () => {
    const host = await site({
      's1.js': 'Object.defineProperty(globalThis, "__stet_thrown", { set(v) { while (true) {} }, configurable: true });\nthrow new Error("boom");\n',
    });
    // A loop on the host stack ignores vitest's timeout, so the CLI runs as a child under its own.
    const child = importChild(host.cwd, 's1.js');
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('import: s1.js could not be evaluated: boom');
  }, 30_000);

  it('P2.8e a file of 200,000 blank lines imports inside the ceiling', async () => {
    const host = await site({ 'r1.js': `${'\n'.repeat(200_000)}export const T = { "a.b": "x" };\n` });
    const child = importChild(host.cwd, 'r1.js');
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('  a.b  "x"');
  }, 30_000);

  it('P2.11 a declared derived key is skipped, and the snapshot is byte-equal', async () => {
    const host = await site(
      { 'imp.json': JSON.stringify({ 'home.sub': 'Hand written sub' }) },
      {},
      {
        'home.lead': { shape: 'text', target: 'web' },
        'home.sub': { shape: 'text', target: 'web', derivesFrom: 'home.lead', tmpl: '{v} More.' },
      },
      { 'home.lead': 'Lead words' },
    );
    const before = host.file('content/defaults.json');
    expect(await host.run('import', 'imp.json', '--write')).toBe(0);
    expect(host.out).toContain('  new 0 · same 0 · differs 0 · skipped 1');
    expect(host.out).toContain('  home.sub  skipped: derives from home.lead — edit its template');
    expect(host.file('content/defaults.json')).toBe(before);
  });

  it('Q95 import is the first command after the config: with no content folder it starts from empty forms and writes them', async () => {
    const host = await site({ 't.json': JSON.stringify({ 'home.title': 'Welcome', 'home.lead': 'Lead words' }) });
    rmSync(join(host.cwd, 'content'), { recursive: true });
    expect(await host.run('import', 't.json', '--write')).toBe(0);
    expect(host.out.slice(0, 2)).toEqual(['import: 2 keys from t.json', '  new 2 · same 0 · differs 0 · skipped 0']);
    expect(Object.keys(JSON.parse(host.file('content/descriptor.json')).keys).sort()).toEqual(['home.lead', 'home.title']);
    expect(JSON.parse(host.file('content/defaults.json')).default['home.title']).toBe('Welcome');
    // A plan alone writes nothing, folder included.
    const planned = await site({ 't.json': JSON.stringify({ 'home.title': 'Welcome' }) });
    rmSync(join(planned.cwd, 'content'), { recursive: true });
    expect(await planned.run('import', 't.json')).toBe(0);
    expect(planned.exists('content/descriptor.json')).toBe(false);
  });

  it('N5 import --write in a folder with no stet.config.json is refused like any other command, and the tree is unchanged', async () => {
    const host = await site({ 't.json': JSON.stringify({ 'home.title': 'Welcome' }) });
    rmSync(join(host.cwd, 'stet.config.json'));
    rmSync(join(host.cwd, 'content'), { recursive: true });
    const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
    const before = tree(host.cwd);
    expect(await host.run('import', 't.json', '--write')).toBe(1);
    expect(host.stderr()).toContain('is this a stet project?');
    expect(tree(host.cwd)).toEqual(before);
  });

  it('Q98 under the default grammar a value with {name} text prints one hint naming the setting; under {name} it prints none', async () => {
    const table = { 't.json': JSON.stringify({ 'home.count': '{n} people are waiting', 'home.sub': '{m} more', 'home.plain': 'No braces' }) };
    const hint = '  2 values carry {name} placeholders — set "placeholders": "{name}" in stet.config.json to declare them as variables';
    const plain = await site(table);
    expect(await plain.run('import', 't.json')).toBe(0);
    expect(plain.out.filter((line) => line.includes('placeholders'))).toEqual([hint]);
    const declared = await site(table, { placeholders: '{name}' });
    expect(await declared.run('import', 't.json')).toBe(0);
    expect(declared.out.filter((line) => line.includes('placeholders'))).toEqual([]);
  });

  it('P2.12 a top-level return answers the compiler, not the await line', async () => {
    const host = await site({
      'ret.mjs': 'export const T = { "a.b": "x" };\nif (T) { return; }\n',
      'str.mjs': 'export const T = { "a.b": "await it" }; // await\nif (T) { return; }\n',
    });
    for (const file of ['ret.mjs', 'str.mjs']) {
      expect(await host.run('import', file)).toBe(1);
      expect(host.stderr()).toContain(`import: ${file} could not be evaluated:`);
    }
    expect(host.stderr()).not.toContain('top-level await');
  });

  it('P2.13 a 100,000-character value prints a plan line under 400 characters', async () => {
    const host = await site({ 'long.json': JSON.stringify({ 'a.b': 'x'.repeat(100_000) }) });
    expect(await host.run('import', 'long.json')).toBe(0);
    const line = host.out.find((l) => l.startsWith('  a.b  ')) as string;
    expect(line.length).toBeLessThan(400);
  });
});

/** The built bin importing a file, under a ten-second kill: a hang on the host stack shows as a null status. */
function importChild(cwd: string, file: string): { status: number | null; stdout: string; stderr: string } {
  const bin = join(packageRoot(), 'dist', 'cli', 'main.js');
  expect(existsSync(bin), 'build first: npm run build').toBe(true);
  // A child runs the BUILD: a source edited since the last build would leave it green on the old code.
  const built = statSync(join(packageRoot(), 'dist', 'cli', 'import.js')).mtimeMs;
  expect(built, 'cli/import.ts changed since the last build: npm run build').toBeGreaterThanOrEqual(statSync(join(packageRoot(), 'cli', 'import.ts')).mtimeMs);
  const child = spawnSync(process.execPath, [bin, 'import', file], { cwd, encoding: 'utf8', timeout: 10_000 });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

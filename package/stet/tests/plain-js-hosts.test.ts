// add-plain-js-hosts (0.9.0), chunks C1 and C3: the dotted key grammar, the config, the status file module; configured reads, the attribute mark, the no-mark pass.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { planRepoForms, writePlanned } from '../cli/artifacts.js';
import { defaultConfig, loadConfig, rawConfigPlan } from '../cli/config.js';
import { check } from '../cli/check.js';
import { keyUsage, namedKeys, usageCache } from '../cli/key-usage.js';
import { planProblems } from '../cli/key-plan.js';
import { baseName } from '../cli/key-names.js';
import { keyPattern, longerKeyAt } from '../cli/key-reads.js';
import { Report } from '../cli/report.js';
import { loadTypescript, mentionsToken } from '../cli/source-scan.js';
import { approveKeys, completeStatus, loadStatus, renameStatus, resetChanged, statusPlan, type StatusFile } from '../cli/status.js';
import { generateRegistry } from '../src/codegen.js';
import { deriveLabel, loadDescriptor } from '../src/descriptor.js';
import type { Descriptor } from '../src/types.js';
import { cleanupCliHosts, makeAdoptionHost, makeHtmlHost } from '../conformance/cli-host.js';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  cleanupCliHosts();
});

const KEYS = ['home.title', 'waitlist.use.ads', 'waitlist.use.other', 'waitlist.refused.rate', 'privacy.body', 'waitlist.title', 'waitlist.title.more'];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-09-'));
  made.push(dir);
  return dir;
}

function host(files: Record<string, string>, config: Record<string, unknown>): string {
  const dir = tempDir();
  const all: Record<string, string> = {
    'stet.config.json': JSON.stringify({ host: 'html', managedSurfaces: ['*.html'], ...config }),
    'content/descriptor.json': JSON.stringify({ version: 1, keys: Object.fromEntries(KEYS.map((k) => [k, { shape: 'text', target: 'web' }])) }),
    'content/defaults.json': JSON.stringify({ default: Object.fromEntries(KEYS.map((k) => [k, `Text of ${k}`])) }),
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

/** A project holding only a config, for the cases that parse it: no git, which `loadConfig` never reads. */
function configHost(config: Record<string, unknown>): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'stet.config.json'), JSON.stringify({ host: 'html', managedSurfaces: ['*.html'], ...config }));
  return dir;
}

describe('add-plain-js-hosts (0.9.0) C1', () => {
  it('P1.1 a dotted key loads, labels and emits', () => {
    const d = loadDescriptor({ version: 1, keys: { 'waitlist.use.music_videos': { shape: 'text', target: 'web' }, hero_title: { shape: 'text', target: 'web' } } });
    expect(Object.keys(d.keys)).toContain('waitlist.use.music_videos');
    expect(deriveLabel('waitlist.use.music_videos')).toBe('Music videos');
    expect(deriveLabel('hero_title')).toBe('Hero title');
    expect(deriveLabel('welcome__subject')).toBe('Subject');
    const { keysTs, dts } = generateRegistry(d);
    expect(keysTs).toContain("'waitlist.use.music_videos',");
    expect(dts).toContain("| 'waitlist.use.music_videos'");
  });

  it('P1.2 a dotted key is refused where a separator doubles or ends', () => {
    for (const bad of ['home..title', '.home', 'home.', 'home._title', 'home.title.']) {
      expect(() => loadDescriptor({ version: 1, keys: { [bad]: { shape: 'text', target: 'web' } } })).toThrow();
    }
  });

  it('P1.3 pass 1 names the longest declared sub-run, and still an underscore key off a property', async () => {
    const ts = await loadTypescript();
    const declared = new Set(['home.title', 'home_title', 'title']);
    const names = (src: string): string[] => [...namedKeys(ts, 'a.js', src, declared)].sort();
    expect(names('TS.t("home.title");')).toEqual(['home.title']);
    expect(names('x = obj.home_title;')).toEqual(['home_title']);
    expect(names('TS.t("home_title");')).toEqual(['home_title']);
    expect(names('// home.title in a comment')).toEqual([]);
    expect(names('copy.home.title')).toEqual(['home.title']);
    expect(names('title')).toEqual(['title']);
  });

  it('P1.4 the raw-key pattern keeps its dots literal and the longer declared key wins', () => {
    expect(keyPattern('home.title').test('home_title')).toBe(false);
    expect(keyPattern('home.title').test('homeXtitle')).toBe(false);
    expect(keyPattern('nav_docs').test('copy.nav_docs.length')).toBe(true);
    const src = 'copy["waitlist.title.more"]; copy["waitlist.title"];';
    const declared = new Set(['waitlist.title', 'waitlist.title.more']);
    const hits = [...src.matchAll(keyPattern('waitlist.title', 'g'))].map((m) => m.index);
    expect(hits).toHaveLength(2);
    expect(longerKeyAt(src, hits[0] as number, 'waitlist.title', declared)).toBe('waitlist.title.more');
    expect(longerKeyAt(src, hits[1] as number, 'waitlist.title', declared)).toBeNull();
    expect(mentionsToken('TS.t("waitlist.foot.more")', 'waitlist.foot', new Set(['waitlist.foot', 'waitlist.foot.more']))).toBe(false);
    expect(mentionsToken('TS.t("waitlist.foot")', 'waitlist.foot', new Set(['waitlist.foot', 'waitlist.foot.more']))).toBe(true);
  });

  it('P1.5 a register plan accepts a dotted name', () => {
    const descriptor = loadDescriptor({ version: 1, keys: {} });
    const plan = { plan: 'stet register' as const, version: 1 as const, made: {}, keys: [{ proposed: 'a', key: 'waitlist.form.button_text', label: null, help: null, section: null, adopt: true }] };
    const problems = planProblems(plan, 'p.json', descriptor, ['a'], { hashes: {} });
    expect(problems.filter((p) => /not a key name/.test(p))).toEqual([]);
    const bad = { ...plan, keys: [{ ...plan.keys[0]!, key: 'waitlist..form' }] };
    expect(planProblems(bad, 'p.json', descriptor, ['a'], { hashes: {} })).toEqual(['a: "waitlist..form" is not a key name — lowercase letters and digits, in parts joined by a dot or an underscore, starting with a letter']);
  });

  it('P1.6 the naming rule joins its parts with the joiner and keeps a part\'s words on underscores', () => {
    expect(baseName({ page: 'waitlist', section: 'form', role: 'button_text' }, '.')).toBe('waitlist.form.button_text');
    expect(baseName({ page: 'home', section: 'services', item: 'card_4', role: 'headline' }, '.')).toBe('home.services.card_4.headline');
    expect(baseName({ page: '2026_report', section: 'intro', role: 'summary' }, '.')).toBe('page.2026_report.intro.summary');
    // The underscore joiner is the rule as it was.
    expect(baseName({ page: 'home', section: 'top', role: 'headline' })).toBe('home_top_headline');
    expect(baseName({ page: '2026', section: 'footer', role: 'paragraph' }, '_')).toBe('page_2026_footer_paragraph');
  });

  it('P3.1 the config parses, defaults and refuses', () => {
    const dir = configHost({ reads: { functions: ['TS.t', { name: 'TS.tx', key: 0 }, { name: 'i18n.copy.t', key: 2 }, 't'], attribute: 'data-copy' }, placeholders: '{name}', keyStyle: 'dotted', statusPath: 'copy/status.json', copyFrom: '../owner', scan: { builders: ['h', 'el'] } });
    const config = loadConfig(dir);
    expect(config.reads).toEqual({
      functions: [{ name: 'TS.t', key: 0 }, { name: 'TS.tx', key: 0 }, { name: 'i18n.copy.t', key: 2 }, { name: 't', key: 0 }],
      attribute: 'data-copy',
    });
    expect(config.placeholders).toBe('{name}');
    expect(config.keyStyle).toBe('dotted');
    expect(config.statusPath).toBe('copy/status.json');
    expect(config.copyFrom).toBe('../owner');
    expect(config.scan.builders).toEqual(['h', 'el']);
    expect(() => loadConfig(configHost({ scan: { builders: 'h' } }))).toThrow(/stet\.config\.json: scan\.builders must be an array of strings/);
    const bare = loadConfig(configHost({}));
    expect(bare).toMatchObject({ placeholders: '{{name}}', keyStyle: 'underscore', generated: [], statusPath: 'content/status.json' });
    expect(bare.reads).toBeUndefined();
    expect(bare.copyFrom).toBeUndefined();
    expect(bare.scan.builders).toBeUndefined();
    expect(loadConfig(configHost({ reads: { functions: ['t'] } })).reads).toEqual({ functions: [{ name: 't', key: 0 }] });
    expect(loadConfig(configHost({ generated: [{ file: 'a/x.js', format: 'script', name: 'TS.copyTable' }, { file: 'x.json', format: 'json', values: 'value-status', only: ['home.'] }] })).generated).toEqual([
      { file: 'a/x.js', format: 'script', name: 'TS.copyTable', values: 'value' },
      { file: 'x.json', format: 'json', values: 'value-status', only: ['home.'] },
    ]);

    const refuse = (config: Record<string, unknown>, message: RegExp): void => {
      expect(() => loadConfig(configHost(config))).toThrow(message);
    };
    refuse({ reads: { functions: [] } }, /stet\.config\.json: reads\.functions must be a list of function names, such as "t" or "TS\.t"/);
    refuse({ reads: { functions: ['not a name'] } }, /reads\.functions must be a list of function names/);
    refuse({ reads: { functions: [{ name: 't', key: -1 }] } }, /reads\.functions must be a list of function names/);
    refuse({ reads: { functions: ['t'], attribute: 'copy' } }, /stet\.config\.json: reads\.attribute must be a data-\* attribute name/);
    refuse({ placeholders: '%name%' }, /stet\.config\.json: placeholders must be "\{\{name\}\}" or "\{name\}"/);
    refuse({ keyStyle: 'camel' }, /stet\.config\.json: keyStyle must be "underscore" or "dotted"/);
    refuse({ generated: 'x.js' }, /stet\.config\.json: generated must be a list/);
    refuse({ generated: [{ file: 'x.js', format: 'script' }] }, /stet\.config\.json: generated\[0\] needs a file, a format \(script, esm or json\) and, for script and esm, a name/);
    refuse({ generated: [{ file: 'x.json', format: 'json' }, { file: 'x.js', format: 'cjs', name: 'T' }] }, /generated\[1\] needs a file/);
    refuse({ copyFrom: ' ' }, /stet\.config\.json: copyFrom must name a folder holding stet\.config\.json/);
    // The status file is a path stet writes: non-empty and inside the checkout.
    for (const statusPath of ['', '../x/status.json', 'a/../../status.json', '/tmp/status.json']) {
      refuse({ statusPath }, /stet\.config\.json: statusPath must be a file path inside this checkout/);
    }
    // Outside the checkout: a relative climb and an absolute path.
    const inside = /stet\.config\.json: generated\[0\]\.file must be inside this checkout — a second checkout generates its own file through copyFrom/;
    refuse({ generated: [{ file: '../other/strings.mjs', format: 'esm', name: 'S' }] }, inside);
    refuse({ generated: [{ file: 'a/../../strings.mjs', format: 'esm', name: 'S' }] }, inside);
    refuse({ generated: [{ file: '/tmp/strings.mjs', format: 'esm', name: 'S' }] }, inside);
    // A segment that merely starts with two dots stays inside.
    expect(loadConfig(configHost({ generated: [{ file: '..strings.mjs', format: 'esm', name: 'S' }] })).generated).toHaveLength(1);
  });
});

describe('the status file module (D3)', () => {
  const approved = (by: string, at: string): { status: 'approved'; at: string; by: string } => ({ status: 'approved', at, by });

  it('P4.1 approves, resets, completes, renames and plans', () => {
    // approveKeys records by and at, and answers `already` for a key approved before, untouched.
    const first = approveKeys({}, ['a', 'b'], 'nj-io', '2026-11-02');
    expect(first.file).toEqual({ a: approved('nj-io', '2026-11-02'), b: approved('nj-io', '2026-11-02') });
    expect(first.already).toEqual([]);
    const again = approveKeys(first.file, ['a', 'c'], 'sam', '2026-11-03');
    expect(again.already).toEqual(['a']);
    expect(again.file['a']).toEqual(approved('nj-io', '2026-11-02'));
    expect(again.file['c']).toEqual(approved('sam', '2026-11-03'));
    expect(first.file['c']).toBeUndefined();
    expect(approveKeys({}, ['a'], 'x').file['a']).toMatchObject({ status: 'approved', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    // resetChanged: a changed default-locale value goes back to proposed, an unchanged one stays.
    const before = { default: { a: 'x', b: 'y' }, de: { a: 'x-de' } };
    const after = { default: { a: 'x2', b: 'y' }, de: { a: 'x-de2' } };
    expect(resetChanged(first.file, before, after, 'default')).toEqual({ a: { status: 'proposed' }, b: approved('nj-io', '2026-11-02') });
    // A change in another locale alone does not reset.
    expect(resetChanged(first.file, before, { default: before.default, de: after.de }, 'default')).toEqual(first.file);

    // completeStatus: every declared key present, sorted; an undeclared one dropped.
    const descriptor = loadDescriptor({ version: 1, keys: { b: { shape: 'text', target: 'web' }, a: { shape: 'text', target: 'web' }, d: { shape: 'text', target: 'web' } } });
    const full = completeStatus({ ...first.file, gone: approved('nj-io', '2026-11-02') }, descriptor);
    expect(full).toEqual({ a: approved('nj-io', '2026-11-02'), b: approved('nj-io', '2026-11-02'), d: { status: 'proposed' } });
    expect(Object.keys(full)).toEqual(['a', 'b', 'd']);

    // renameStatus: an entry moves with its key; a key with no entry moves nothing; a merge keeps the kept key's entry.
    const file: StatusFile = { a: approved('nj-io', '2026-11-02'), b: { status: 'proposed' } };
    expect(renameStatus(file, new Map([['a', 'z']]))).toEqual({ z: approved('nj-io', '2026-11-02'), b: { status: 'proposed' } });
    expect(renameStatus(file, new Map([['unknown', 'z']]))).toEqual(file);
    expect(renameStatus(file, new Map([['a', 'b']]))).toEqual({ b: { status: 'proposed' } });

    // statusPlan: null for an absent file with nothing approved; a plan once one is approved or the file exists.
    const cwd = tempDir();
    const config = { statusPath: 'content/status.json' };
    expect(statusPlan(cwd, config, {})).toBeNull();
    expect(statusPlan(cwd, config, { a: { status: 'proposed' } })).toBeNull();
    const plan = statusPlan(cwd, config, first.file);
    expect(plan).toMatchObject({ label: 'content/status.json', status: 'write' });
    expect(JSON.parse(plan?.text ?? '')).toEqual(first.file);
    mkdirSync(join(cwd, 'content'));
    writeFileSync(join(cwd, 'content/status.json'), '{}\n');
    expect(statusPlan(cwd, config, { a: { status: 'proposed' } })).not.toBeNull();

    // loadStatus: absent is empty; a malformed file is an error naming the path.
    expect(loadStatus(tempDir(), config)).toEqual({});
    expect(loadStatus(cwd, config)).toEqual({});
    writeFileSync(join(cwd, 'content/status.json'), JSON.stringify(first.file));
    expect(loadStatus(cwd, config)).toEqual(first.file);
    writeFileSync(join(cwd, 'content/status.json'), '[1]');
    expect(() => loadStatus(cwd, config)).toThrow(/content\/status\.json/);
    writeFileSync(join(cwd, 'content/status.json'), '{ nope');
    expect(() => loadStatus(cwd, config)).toThrow(/content\/status\.json/);
    // A key outside the key grammar is refused, `__proto__` included, rather than dropped or re-parenting the loaded object.
    writeFileSync(join(cwd, 'content/status.json'), '{"__proto__":{"status":"proposed"},"a":{"status":"proposed"}}');
    expect(() => loadStatus(cwd, config)).toThrow(/content\/status\.json: __proto__ is not a key name/);
  });

  const MARKED = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Site</title></head>\n<body>\n  <h1 data-stet="home_title">Hello</h1>\n  <p data-stet="home_body">World</p>\n</body>\n</html>\n';
  const KEYS_HTML = { home_title: { shape: 'text', target: 'web' }, home_body: { shape: 'text', target: 'web' } };
  const VALUES_HTML = { home_title: 'Hello', home_body: 'World' };
  const PLAN = { plan: 'stet rename', version: 1, keys: [{ old: 'home_title', key: 'home_headline', label: null, help: null }] };

  it('P1.8 rename --write on an html host with an approved key moves the entry in the batch; a project that never approved gains no file', async () => {
    const approvedHost = await makeHtmlHost({ files: { 'index.html': MARKED }, keys: KEYS_HTML, defaults: VALUES_HTML });
    mkdirSync(join(approvedHost.cwd, 'content'), { recursive: true });
    writeFileSync(
      join(approvedHost.cwd, 'content/status.json'),
      JSON.stringify({ home_title: approved('nj-io', '2026-11-02'), home_body: { status: 'proposed' } }),
    );
    writeFileSync(join(approvedHost.cwd, 'rename.json'), JSON.stringify(PLAN));
    expect(await approvedHost.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
    expect(approvedHost.stdout()).toMatch(/wrote [^\n]*content\/status\.json/);
    expect(JSON.parse(approvedHost.file('content/status.json'))).toEqual({
      home_body: { status: 'proposed' },
      home_headline: approved('nj-io', '2026-11-02'),
    });

    const quiet = await makeHtmlHost({ files: { 'index.html': MARKED }, keys: KEYS_HTML, defaults: VALUES_HTML });
    writeFileSync(join(quiet.cwd, 'rename.json'), JSON.stringify(PLAN));
    expect(await quiet.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
    expect(quiet.exists('content/status.json')).toBe(false);
    // register on a fresh page adopts it without a status file either.
    const adopted = await makeHtmlHost({ register: true });
    expect(adopted.exists('content/status.json')).toBe(false);
  });

  it('P4.2 planRepoForms writes the status file in the same batch as the snapshot, and a status file that cannot be written leaves every form unwritten', () => {
    const cwd = tempDir();
    const descriptor = loadDescriptor({ version: 1, keys: { a: { shape: 'text', target: 'web' } } });
    const status: StatusFile = { a: approved('nj-io', '2026-11-02') };
    const plans = planRepoForms(cwd, defaultConfig(), descriptor, { default: { a: 'A' } }, status, new Report());
    const forms = [
      'content/descriptor.json',
      'content/defaults.json',
      'content/keys.ts',
      'content/stet-env.d.ts',
      'content/defaults.ts',
      'content/resolved.ts',
      'content/status.json',
    ];
    expect(plans.map((p) => p.label)).toEqual(forms);
    writePlanned(plans);
    expect(JSON.parse(readFileSync(join(cwd, 'content/status.json'), 'utf8'))).toEqual(status);
    // No approval and no file: the batch has no sixth form.
    expect(planRepoForms(tempDir(), defaultConfig(), descriptor, { default: { a: 'A' } }, {}, new Report()).map((p) => p.label)).not.toContain('content/status.json');

    // A status file in a read-only folder fails at write time: the descriptor, snapshot and codegen files do not exist after.
    const locked = tempDir();
    mkdirSync(join(locked, 'content/ro'), { recursive: true });
    chmodSync(join(locked, 'content/ro'), 0o555);
    try {
      const config = { ...defaultConfig(), statusPath: 'content/ro/status.json' };
      expect(() => writePlanned(planRepoForms(locked, config, descriptor, { default: { a: 'A' } }, status, new Report()))).toThrow();
      for (const rel of forms.slice(0, -1)) expect(existsSync(join(locked, rel)), rel).toBe(false);
      expect(existsSync(join(locked, 'content/ro/status.json'))).toBe(false);
    } finally {
      chmodSync(join(locked, 'content/ro'), 0o755);
    }
  });

  it('P1.9 init and a config planned from none write none of the four 0.9.0 defaults', async () => {
    const fresh = makeAdoptionHost();
    expect(await fresh.run('init', '--yes')).toBe(0);
    const written = JSON.parse(fresh.file('stet.config.json')) as Record<string, unknown>;
    for (const field of ['placeholders', 'keyStyle', 'generated', 'statusPath']) expect(written, field).not.toHaveProperty(field);
    expect(written).toHaveProperty('descriptorPath');
    // The no-config path of `email extract` and `import` is `rawConfigPlan`.
    const planned = JSON.parse(rawConfigPlan(tempDir(), () => {}).text) as Record<string, unknown>;
    for (const field of ['placeholders', 'keyStyle', 'generated', 'statusPath']) expect(planned, field).not.toHaveProperty(field);
    expect(planned).toHaveProperty('descriptorPath');
  });
});

describe('add-plain-js-hosts (0.9.0) C3', () => {
  const descriptorOf = (keys: readonly string[] = KEYS): Descriptor =>
    loadDescriptor({ version: 1, keys: Object.fromEntries(keys.map((k) => [k, { shape: 'text', target: 'web' }])) });

  // topshine's shape (D5): a literal, a computed call, and a parameter followed through a `var` map.
  const SCREEN = [
    '(function () {',
    '  "use strict";',
    '  var TS = window.TS;',
    '  var USES = [["ads", "megaphone"], ["other", "sparkle"]];',
    '  var ERRORS = { rate: "waitlist.refused.rate" };',
    '  var msg = function (key, extra) { return h("p", extra || {}, TS.tx(key)); };',
    '  function title() { return TS.t("home.title"); }',
    '  USES.map(function (k) { return TS.tx("waitlist.use." + k[0]); });',
    '  if (u.error) msg(ERRORS[u.error], { key: "msg" });',
    '})();',
  ].join('\n');

  it('P3.2 topshine-shaped reads: a literal is read, a computed call learns its prefix, a parameter follows one hop through a var map', async () => {
    const dir = host({ 'screen.js': SCREEN }, { reads: { functions: ['TS.t', 'TS.tx'], attribute: 'data-copy' } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.keys['home.title']?.state).toBe('read');
    expect(usage.keys['waitlist.refused.rate']?.state).toBe('read');
    expect(usage.keys['waitlist.use.ads']?.state).toBe('unknown');
    expect(usage.keys['waitlist.use.ads']?.prefix).toEqual({ prefix: 'waitlist.use.', file: 'screen.js', line: 8 });
    expect(usage.causes).toEqual([]);
    expect(usage.keys['privacy.body']?.state).toBe('not_found');
  });

  it('P3.3 a configured call with no literal head and no hop is the one cause', async () => {
    const dir = host({ 'screen.js': 'var TS = window.TS;\nTS.tx(window.pick());\n' }, { reads: { functions: ['TS.tx'] } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.causes).toEqual([{ text: 'TS.tx(window.pick())', file: 'screen.js', line: 2 }]);
    expect(usage.keys['privacy.body']?.state).toBe('unknown');
  });

  it('P3.4 without the config the same screen leaves a computed call unseen (0.8.1)', async () => {
    const dir = host({ 'screen.js': SCREEN }, {});
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.keys['waitlist.use.ads']?.state).toBe('not_found');
    expect(usage.causes).toEqual([]);
  });

  it('P3.5 the copy table is not a reader: a key declared only in a copyModules file is not_found and the file is not counted', async () => {
    const table = 'window.TS = window.TS || {};\nTS.copyTable = {\n  "waitlist.title": ["Join", "new"],\n  "home.title": ["Make it", "approved"]\n};\n';
    const dir = host({ 'data/copy.js': table }, { copyModules: ['data/copy.js'], reads: { functions: ['TS.t'] } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.keys['waitlist.title']?.state).toBe('not_found');
    expect(usage.files).toBe(0);
  });

  it('P3.6 data-copy and data-copy-placeholder name their keys in the scan; data-copy-label is reported once by check', async () => {
    const page =
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Join</title></head>\n<body>\n' +
      '  <button data-copy="waitlist.title">Text of waitlist.title</button>\n' +
      '  <input data-copy-placeholder="privacy.body" placeholder="Text of privacy.body">\n' +
      '  <label data-copy-label="home.title">Email</label>\n' +
      '  <label data-copy-label="waitlist.refused.rate">Name</label>\n' +
      '</body>\n</html>\n';
    const dir = host({ 'index.html': page }, { reads: { functions: ['TS.t'], attribute: 'data-copy' } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.keys['waitlist.title']?.state).toBe('read');
    expect(usage.keys['privacy.body']?.state).toBe('read');

    const report = new Report();
    await check(loadConfig(dir), dir, report);
    expect(report.findings.map((f) => f.message).filter((l) => /names no attribute stet manages/.test(l))).toEqual([
      'index.html:7 data-copy-label="home.title" names no attribute stet manages — the mark stays the page\'s',
    ]);
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
  });

  it('P3.7 check on an html host with reads: a key a script names warns nothing; a key named nowhere keeps both lines', async () => {
    const page = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Join</title></head>\n<body>\n  <p data-stet="privacy.body">Text of privacy.body</p>\n</body>\n</html>\n';
    const keys = ['home.title', 'waitlist.title', 'privacy.body'];
    const dir = host({ 'index.html': page, 'screen.js': 'var TS = window.TS;\nTS.t("home.title");\n' }, { reads: { functions: ['TS.t'] } });
    writeFileSync(join(dir, 'content/descriptor.json'), JSON.stringify({ version: 1, keys: Object.fromEntries(keys.map((k) => [k, { shape: 'text', target: 'web' }])) }));
    writeFileSync(join(dir, 'content/defaults.json'), JSON.stringify({ default: Object.fromEntries(keys.map((k) => [k, `Text of ${k}`])) }));
    const report = new Report();
    await check(loadConfig(dir), dir, report);
    const warns = report.findings.filter((f) => f.level === 'warn' && /no mark|no document/.test(f.message)).map((f) => f.message);
    expect(warns).toEqual([
      'waitlist.title: marked in no document',
      '1 key has no mark — stet remove waitlist.title drops it, or mark it in the page',
    ]);
  });

  it('P3.10 a change to the configured functions between two scans is seen by the second (the cache stamp)', async () => {
    const dir = host({ 'screen.js': SCREEN }, {});
    const cache = usageCache();
    expect((await keyUsage(dir, loadConfig(dir), descriptorOf(), cache)).keys['waitlist.use.ads']?.state).toBe('not_found');
    writeFileSync(join(dir, 'stet.config.json'), JSON.stringify({ host: 'html', managedSurfaces: ['*.html'], reads: { functions: ['TS.t', 'TS.tx'] } }));
    expect((await keyUsage(dir, loadConfig(dir), descriptorOf(), cache)).keys['waitlist.use.ads']?.state).toBe('unknown');
  });

  it('P3.11 two files each declaring msg: each adapter is judged by its own file\'s calls', async () => {
    const waitlist = [
      '(function () {',
      '  var TS = window.TS;',
      '  var ERRORS = { rate: "waitlist.refused.rate" };',
      '  var msg = function (key) { return TS.tx(key); };',
      '  msg("home.title");',
      '  if (u.error) msg(ERRORS[u.error]);',
      '})();',
    ].join('\n');
    const statusLine = [
      '(function () {',
      '  var TS = window.TS;',
      '  function want() { return msg("ended", "waitlist.title"); }',
      '  function msg(id, key) { return { id: id, text: TS.t(key) }; }',
      '  window.want = want;',
      '})();',
    ].join('\n');
    const dir = host({ 'screens/waitlist.js': waitlist, 'ui/status-line.js': statusLine }, { reads: { functions: ['TS.t', 'TS.tx'] } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.causes).toEqual([]);
    for (const key of ['waitlist.title', 'home.title', 'waitlist.refused.rate']) expect(usage.keys[key]?.state, key).toBe('read');
  });

  it('Q30 rename on an html host with reads rewrites a configured call in a JS screen and lists a read under the key\'s prefix', async () => {
    const page = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Join</title></head>\n<body>\n  <p data-stet="c.d">Text of c.d</p>\n  <script src="screen.js"></script>\n</body>\n</html>\n';
    const screen = 'var TS = window.TS;\nTS.tx("a.b");\n["x", "y"].forEach(function (k) { TS.tx("a." + k); });\n';
    const keys = { 'a.b': { shape: 'text', target: 'web' }, 'c.d': { shape: 'text', target: 'web' } };
    const html = await makeHtmlHost({
      files: { 'index.html': page, 'screen.js': screen },
      keys,
      defaults: { 'a.b': 'Text of a.b', 'c.d': 'Text of c.d' },
      config: { reads: { functions: ['TS.tx'] } },
    });
    expect(await html.run('rename', 'a.b', 'a.c', '--write')).toBe(0);
    expect(html.file('screen.js')).toBe('var TS = window.TS;\nTS.tx("a.c");\n["x", "y"].forEach(function (k) { TS.tx("a." + k); });\n');
    expect(html.stdout()).toContain('screen.js:3 reads keys under a prefix of "a.b"');
    expect(Object.keys(JSON.parse(html.file('content/descriptor.json')).keys)).toEqual(['a.c', 'c.d']);
  });

  it('P3.12 with reads.attribute data-copy, data-copy and data-stet marks are both read; register --write writes data-stet', async () => {
    const page =
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Join the list</title></head>\n<body>\n' +
      '  <b data-copy="a.b">Bold words here</b>\n' +
      '  <i data-stet="c.d">Italic words here</i>\n' +
      '  <p>A new paragraph the register run adopts.</p>\n' +
      '</body>\n</html>\n';
    const keys = { 'a.b': { shape: 'text', target: 'web' }, 'c.d': { shape: 'text', target: 'web' } };
    const html = await makeHtmlHost({
      files: { 'index.html': page },
      keys,
      defaults: { 'a.b': 'Bold words here', 'c.d': 'Italic words here' },
      config: { reads: { functions: ['TS.t'], attribute: 'data-copy' } },
    });
    const usage = await keyUsage(html.cwd, loadConfig(html.cwd), loadDescriptor({ version: 1, keys }));
    expect(usage.keys['a.b']?.state).toBe('read');
    expect(usage.keys['c.d']?.state).toBe('read');
    expect(await html.run('check')).toBe(0);
    expect(html.stdout()).toContain('document: index.html current (2 marks)');
    expect(html.stderr()).not.toContain('marked in no document');

    expect(await html.run('register', '--from', 'scan', '--write')).toBe(0);
    const after = html.file('index.html');
    expect(after).toContain('<b data-copy="a.b">Bold words here</b>');
    expect(after).toMatch(/<p data-stet="[a-z0-9_.]+">A new paragraph the register run adopts\.<\/p>/);
    expect(after).not.toMatch(/data-copy="(?!a\.b")/);
    expect(await html.run('check')).toBe(0);
  });
});

// add-plain-js-hosts (0.9.0), chunks C1 and C3: the dotted key grammar, the config, the status file module; configured reads, the attribute mark, the no-mark pass.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';

import { planRepoForms, writePlanned } from '../cli/artifacts.js';
import { defaultConfig, loadConfig, rawConfigPlan } from '../cli/config.js';
import { check } from '../cli/check.js';
import { keyUsage, namedKeys, usageCache } from '../cli/key-usage.js';
import { planProblems } from '../cli/key-plan.js';
import { baseName } from '../cli/key-names.js';
import { keyPattern, planReadRenames } from '../cli/key-reads.js';
import { Report } from '../cli/report.js';
import { planDocumentFix } from '../cli/lighthouse-fix.js';
import { planDocuments, readDocument } from '../cli/html-host.js';
import { keysIn, loadTypescript, mentionsToken, occurrenceIsAmbiguous, occurrenceIsKey } from '../cli/source-scan.js';
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
    expect(occurrenceIsKey(src, hits[0] as number, 'waitlist.title', declared)).toBe(false);
    expect(occurrenceIsKey(src, hits[1] as number, 'waitlist.title', declared)).toBe(true);
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

  // fix round B: the spellings of a read, handlers as code, globals, the commands that move keys.
  const PAGE = (inner: string): string => `<!DOCTYPE html>\n<html lang="en">\n<head><title>Join</title></head>\n<body>\n${inner}\n</body>\n</html>\n`;

  it('V1 a configured read is seen however it is spelled; any other reference to the function is a cause', async () => {
    // A spelling of the call is followed to its prefix; a reference that is not a call is a cause, which opens every unnamed key.
    const forms: Record<string, { cause: boolean; form: (arg: string) => string }> = {
      window_prefixed: { cause: false, form: (a) => `window.TS.tx(${a});` },
      optional_chain: { cause: false, form: (a) => `TS?.tx(${a});` },
      element_access: { cause: false, form: (a) => `TS["tx"](${a});` },
      paren_callee: { cause: false, form: (a) => `(TS.tx)(${a});` },
      alias_var: { cause: true, form: (a) => `var t = TS.tx; t(${a});` },
      alias_destructure: { cause: true, form: (a) => `var { tx } = TS; tx(${a});` },
      call_method: { cause: true, form: (a) => `TS.tx.call(TS, ${a});` },
      bind_method: { cause: true, form: (a) => `TS.tx.bind(TS)(${a});` },
      as_value_map: { cause: true, form: (a) => `items.map(TS.tx); void ${a};` },
      alias_head: { cause: true, form: (a) => `var T = TS; T.tx(${a});` },
    };
    for (const [name, { cause, form }] of Object.entries(forms)) {
      const dir = host({ 'screen.js': `var TS = window.TS;\nvar k = pick();\n${form('"waitlist.use." + k')}\n${form('"home.title"')}\n` }, { reads: { functions: ['TS.t', 'TS.tx'] } });
      const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
      expect(usage.keys['waitlist.use.ads']?.state, `${name} waitlist.use.ads`).toBe('unknown');
      expect(usage.keys['privacy.body']?.state, `${name} privacy.body`).toBe(cause ? 'unknown' : 'not_found');
      expect(usage.keys['home.title']?.state, `${name} literal`).toBe('read');
    }
    // The line that binds the name to the head object is no alias of it.
    const plain = host({ 'screen.js': 'var TS = window.TS;\nTS.tx("home.title");\n' }, { reads: { functions: ['TS.tx'] } });
    expect((await keyUsage(plain, loadConfig(plain), descriptorOf())).keys['privacy.body']?.state).toBe('not_found');
  });

  it('V2 an inline handler and a javascript: URL are code: read by the scan, rewritten by rename', async () => {
    const reads = { functions: ['TS.tx'] };
    const handler = host({ 'index.html': PAGE('  <button onclick="TS.tx(\'home.title\')">Go</button>') }, { reads });
    expect((await keyUsage(handler, loadConfig(handler), descriptorOf())).keys['home.title']?.state).toBe('read');
    const href = host({ 'index.html': PAGE('  <a href="javascript:TS.tx(\'waitlist.title\')">Go</a>') }, { reads });
    expect((await keyUsage(href, loadConfig(href), descriptorOf())).keys['waitlist.title']?.state).toBe('read');
    const computed = host({ 'index.html': PAGE('  <button onclick="TS.tx(pick())">Go</button>') }, { reads });
    const usage = await keyUsage(computed, loadConfig(computed), descriptorOf());
    expect(usage.causes.map((c) => c.file)).toEqual(['index.html']);
    expect(usage.keys['privacy.body']?.state).toBe('unknown');
    // An attribute no rule names as code is not read as code, but a mention of the function in it is a cause (Q76): it may be a directive.
    const prose = host({ 'index.html': PAGE('  <p title="TS.tx(\'home.title\')" class="onclick">Go</p>') }, { reads });
    const proseUsage = await keyUsage(prose, loadConfig(prose), descriptorOf());
    expect(proseUsage.keys['home.title']?.state).toBe('unknown');
    expect(proseUsage.causes.map((c) => c.text)).toEqual(['TS.tx in text the scan cannot read']);

    const page = PAGE('  <p data-stet="c.d">Text of c.d</p>\n  <button onclick="TS.tx(\'a.b\')">Go</button>\n  <a href="javascript:TS.tx(\'a.b\')">Link</a>');
    const html = await makeHtmlHost({
      files: { 'index.html': page },
      keys: { 'a.b': { shape: 'text', target: 'web' }, 'c.d': { shape: 'text', target: 'web' } },
      defaults: { 'a.b': 'Text of a.b', 'c.d': 'Text of c.d' },
      config: { reads },
    });
    expect(await html.run('rename', 'a.b', 'a.z', '--write')).toBe(0);
    expect(html.file('index.html')).toContain('<button onclick="TS.tx(\'a.z\')">Go</button>');
    expect(html.file('index.html')).toContain('<a href="javascript:TS.tx(\'a.z\')">Link</a>');
    expect(html.stdout()).not.toContain('left as it is');
  });

  it('V3 a var that is declared twice, assigned by a pattern, or assigned from another script is not once-assigned', async () => {
    const reads = { functions: ['TS.tx'] };
    const dead = async (files: Record<string, string>): Promise<string | undefined> => {
      const dir = host(files, { reads });
      return (await keyUsage(dir, loadConfig(dir), descriptorOf())).keys['privacy.body']?.state;
    };
    // The control: once assigned, the key is placed and nothing stands.
    expect(await dead({ 's.js': 'var KEY = "waitlist.title";\nTS.tx(KEY);\n' })).toBe('not_found');
    expect(await dead({ 's.js': 'var KEY = "waitlist.title";\nvar KEY = pick();\nTS.tx(KEY);\n' })).toBe('unknown');
    expect(await dead({ 's.js': 'var KEY = "waitlist.title";\n({ KEY } = o);\nTS.tx(KEY);\n' })).toBe('unknown');
    expect(await dead({ 's.js': 'var KEY = "waitlist.title";\n[KEY] = a;\nTS.tx(KEY);\n' })).toBe('unknown');
    expect(await dead({ 's.js': 'var KEY = "waitlist.title";\nTS.tx(KEY);\n', 'other.js': 'KEY = pick();\n' })).toBe('unknown');
    expect(await dead({ 's.js': 'var KEY = "waitlist.title";\nTS.tx(KEY);\n', 'other.js': 'var KEY = pick();\n' })).toBe('unknown');
  });

  it('V4 remove on an html host with reads names a screen that still reads the key', async () => {
    const html = await makeHtmlHost({
      files: { 'screen.js': 'var TS = window.TS;\nTS.tx("a.x");\n' },
      keys: { 'a.x': { shape: 'text', target: 'web' }, 'c.d': { shape: 'text', target: 'web' } },
      defaults: { 'a.x': 'Text of a.x', 'c.d': 'Text of c.d' },
      config: { reads: { functions: ['TS.tx'] } },
    });
    expect(await html.run('remove', 'a.x')).toBe(0);
    expect(html.stdout()).toContain('screen.js mentions "a.x"');
  });

  it('V8 eject on a project with reads.attribute bakes the snapshot into data-copy elements and strips data-stet only', async () => {
    const page = PAGE('  <b data-copy="a.b">Old words</b>\n  <i data-stet="c.d">Old c</i>');
    const html = await makeHtmlHost({
      files: { 'index.html': page },
      keys: { 'a.b': { shape: 'text', target: 'web' }, 'c.d': { shape: 'text', target: 'web' } },
      defaults: { 'a.b': 'New words', 'c.d': 'New c' },
      config: { reads: { functions: ['TS.t'], attribute: 'data-copy' } },
    });
    expect(await html.run('eject', '--write')).toBe(0);
    expect(html.file('index.html')).toContain('<b data-copy="a.b">New words</b>');
    expect(html.file('index.html')).toContain('<i>New c</i>');
    expect(html.stdout()).toContain('document: index.html — every data-stet mark removed, the text stays');
  });

  it('V10 a copy module stays in the usage file list on a project that sets neither reads nor generated', async () => {
    const table = 'window.TS = window.TS || {};\nTS.copyTable = {\n  "waitlist.title": ["Join", "new"]\n};\n';
    const dir = host({ 'data/copy.js': table }, { copyModules: ['data/copy.js'] });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.keys['waitlist.title']?.state).toBe('read');
    expect(usage.files).toBe(1);
  });

  it('V11 a var that a function assigns later is a cause, not a placed key', async () => {
    const dir = host({ 's.js': 'var k = "waitlist.title";\nfunction set() { k = pick(); }\nTS.tx(k);\n' }, { reads: { functions: ['TS.tx'] } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    expect(usage.causes.map((c) => c.text)).toEqual(['TS.tx(k)']);
    expect(usage.keys['privacy.body']?.state).toBe('unknown');
  });

  it('V14 split names a read, not a mark, where the place is a configured read in a script', async () => {
    const html = await makeHtmlHost({
      files: { 'index.html': PAGE('  <p data-stet="a.b">Text of a.b</p>'), 'screen.js': 'var TS = window.TS;\nvar x = 1;\nTS.tx("a.b");\n' },
      keys: { 'a.b': { shape: 'text', target: 'web' } },
      defaults: { 'a.b': 'Text of a.b' },
      config: { reads: { functions: ['TS.tx'] } },
    });
    expect(await html.run('split', 'a.b', 'a.c', '--at', 'screen.js:3')).toBe(0);
    expect(html.stdout()).toContain('screen.js:3 the read is renamed;');
    html.out.length = 0;
    expect(await html.run('split', 'a.b', 'a.c', '--at', 'index.html:5')).toBe(0);
    expect(html.stdout()).toContain('index.html:5 the mark is renamed;');
  });

  it('C1-2 a dotted key\'s tail is not the flat key it ends in: rename and remove leave the dotted read alone', async () => {
    const keys = ['title', 'home.title'];
    const make = (files: Record<string, string>) =>
      makeHtmlHost({
        files,
        keys: Object.fromEntries(keys.map((k) => [k, { shape: 'text', target: 'web' }])),
        defaults: Object.fromEntries(keys.map((k) => [k, `Text of ${k}`])),
        config: { reads: { functions: ['TS.tx'] } },
      });
    const src = 'var TS = window.TS;\nTS.tx("title");\nTS.tx("home.title");\n';
    const both = await make({ 'screen.js': src });
    expect(await both.run('rename', 'title', 'heading', '--write')).toBe(0);
    expect(both.file('screen.js')).toBe('var TS = window.TS;\nTS.tx("heading");\nTS.tx("home.title");\n');

    const only = await make({ 'index.html': '<!DOCTYPE html>\n<html lang="en">\n<body>\n  <script>TS.tx("home.title");</script>\n</body>\n</html>\n' });
    expect(await only.run('remove', 'title')).toBe(0);
    expect(only.stdout()).not.toContain('mentions "title"');

    const declared = new Set(keys);
    expect(occurrenceIsKey(src, src.indexOf('home.title') + 5, 'title', declared)).toBe(false);
    expect(occurrenceIsKey(src, src.indexOf('"title"') + 1, 'title', declared)).toBe(true);
    expect(mentionsToken('TS.tx("home.title")', 'title', declared)).toBe(false);
  });

  // fix round C: the usage scan's backstop on a project with `reads` (Q76), the commands that follow it (Q77-Q79, Q66).
  const privacyOf = async (files: Record<string, string>, functions: string[] = ['TS.t', 'TS.tx', 't']): Promise<{ state: string | undefined; causes: number }> => {
    const dir = host(files, { reads: { functions } });
    const usage = await keyUsage(dir, loadConfig(dir), descriptorOf());
    return { state: usage.keys['privacy.body']?.state, causes: usage.causes.length };
  };

  it('V1c the head object of a configured function that leaves the file, a computed member, or an import rename is a cause; a definition, an assignment target and typeof are not', async () => {
    const pick = 'var k = pick();\n';
    const call = 'T.tx("waitlist.use." + k);';
    const causes: Record<string, { file?: string; src: string }> = {
      iife_dollar: { src: `${pick}(function ($) { $.tx("waitlist.use." + k); })(window.TS);\n` },
      arg_head: { src: `${pick}function run(ts) { ts.tx("waitlist.use." + k); }\nrun(TS);\n` },
      prop_value_head: { src: `${pick}var o = { ts: TS };\no.ts.tx("waitlist.use." + k);\n` },
      shorthand_head: { src: 'var o = { TS };\n' },
      spread_head: { src: 'var o = { ...TS };\n' },
      assign_copy: { src: 'var o = Object.assign({}, TS);\n' },
      return_head: { src: 'function get() { return TS; }\n' },
      export_default_head: { file: 's.mjs', src: 'export default TS;\n' },
      module_exports_head: { src: 'module.exports = TS;\n' },
      win_destructure_head: { src: `${pick}var { TS: T } = window;\n${call}\n` },
      win_destructure_assign: { src: `${pick}var T;\n({ TS: T } = window);\n${call}\n` },
      computed_member: { src: `${pick}TS[k]("waitlist.use." + k);\n` },
      computed_member_tpl: { src: `${pick}TS[\`t\${k}\`]("waitlist.use." + k);\n` },
      computed_member_concat: { src: `${pick}TS["t" + "x"]("waitlist.use." + k);\n` },
      esm_import_alias_bare: { file: 's.mjs', src: `${pick}import { t as tr } from "./i18n.mjs";\ntr("waitlist.use." + k);\n` },
      esm_reexport_alias_bare: { file: 's.mjs', src: 'export { t as translate } from "./i18n.mjs";\n' },
      esm_import_alias_dotted: { file: 's.mjs', src: `${pick}import { TS as T } from "./ts.mjs";\n${call}\n` },
      esm_default_import: { file: 's.mjs', src: `${pick}import T from "./ts.mjs";\n${call}\n` },
      esm_ns_import: { file: 's.mjs', src: `${pick}import * as T from "./ts.mjs";\n${call}\n` },
    };
    for (const [name, { file, src }] of Object.entries(causes)) {
      expect.soft(await privacyOf({ [file ?? 's.js']: src }), name).toEqual({ state: 'unknown', causes: expect.any(Number) });
      expect.soft((await privacyOf({ [file ?? 's.js']: src })).causes, name).toBeGreaterThan(0);
    }
    const quiet: Record<string, { file?: string; src: string }> = {
      plain_declaration: { src: 'var TS = window.TS;\nTS.tx("home.title");\n' },
      self_assign: { src: 'window.TS = window.TS || {};\nTS.tx = function (key) { return key; };\nTS.tx("home.title");\n' },
      typeof_guard: { src: 'if (typeof TS !== "undefined" && typeof window.TS === "object") { TS.tx("home.title"); }\n' },
      iife_same_name: { src: '(function (TS) { TS.tx("home.title"); })(window.TS);\n' },
      destructure_same: { src: 'var { TS } = window;\nTS.tx("home.title");\n' },
      import_same_name: { file: 's.mjs', src: 'import { t } from "./i18n.mjs";\nimport { TS } from "./ts.mjs";\nt("home.title");\nTS.tx("home.title");\n' },
      // Q65: a bare configured name that resolves to a declaration in the file is that declaration.
      param_named_t: { src: 'function f(t) { return t("waitlist.title"); }\nitems.map((t) => render(t));\n' },
      function_named_t: { src: 'function t(k) { return k; }\nt("home.title");\nlist.map(t);\n' },
      local_named_t: { src: 'function g() { var t = 1; return use(t); }\n' },
    };
    for (const [name, { file, src }] of Object.entries(quiet)) expect.soft(await privacyOf({ [file ?? 's.js']: src }), name).toEqual({ state: 'not_found', causes: 0 });
  }, 20_000);

  it('V1d a configured function named in text the parse cannot read is a cause, one per file and function; comments and prose are not', async () => {
    const page = (inner: string): string => PAGE(inner);
    const hidden: Record<string, string> = {
      eval_str: page('  <script>eval("TS.tx(\'waitlist.use.\' + k)");</script>'),
      setTimeout_str: page('  <script>setTimeout("TS.tx(k)", 0);</script>'),
      new_Function: page('  <script>new Function("TS.tx(k)")();</script>'),
      innerHTML_handler: page('  <script>el.innerHTML = \'<button onclick="TS.tx(k)">x</button>\';</script>'),
      hyper_onclick_str: page('  <script>h("button", { onclick: "TS.tx(k)" });</script>'),
      srcdoc: page('  <iframe srcdoc="&lt;script&gt;TS.tx(k)&lt;/script&gt;"></iframe>'),
      form_action: page('  <form action="javascript:TS.tx(k)"></form>'),
      formaction: page('  <button formaction="javascript:TS.tx(k)">x</button>'),
      alpine_xtext: page('  <p x-text="TS.tx(k)"></p>'),
      alpine_at: page('  <button @click="TS.tx(k)">x</button>'),
      alpine_xon: page('  <button x-on:click="TS.tx(k)">x</button>'),
      vue_bind: page('  <p :title="TS.tx(k)"></p>'),
      htmx_on: page('  <button hx-on:click="TS.tx(k)">x</button>'),
      script_babel: page('  <script type="text/babel">TS.tx(k);</script>'),
      script_jsx: page('  <script type="text/jsx">TS.tx(k);</script>'),
      bare_name_attr: page('  <p x-text="t(k)"></p>'),
      window_prefixed_str: page('  <script>eval("window.TS.tx(k)");</script>'),
    };
    for (const [name, html] of Object.entries(hidden)) expect.soft(await privacyOf({ 'index.html': html }), name).toEqual({ state: 'unknown', causes: 1 });
    // One cause per file and function, however many mentions.
    const twice = await privacyOf({ 'index.html': page('  <p x-text="TS.tx(a)"></p>\n  <p x-text="TS.tx(b)"></p>') });
    expect(twice).toEqual({ state: 'unknown', causes: 1 });
    const seen: Record<string, string> = {
      script_call: page('  <script>TS.tx("home.title");</script>'),
      js_comment: page('  <script>// TS.tx(k) is how copy is read\nvar a = 1;</script>'),
      html_comment: page('  <!-- TS.tx(k) -->'),
      handler: page('  <button onclick="TS.tx(\'home.title\')">x</button>'),
      prose_apostrophe: page('  <p>Don\'t (really) do it</p>'),
      own_definition: page('  <script>window.TS = window.TS || {};\nTS.tx = function (k) { return k; };</script>'),
    };
    for (const [name, html] of Object.entries(seen)) expect.soft(await privacyOf({ 'index.html': html }), name).toEqual({ state: 'not_found', causes: 0 });
  });

  it('V3b a global written through the global object is an assignment', async () => {
    const reads = { functions: ['TS.tx'] };
    const dead = async (files: Record<string, string>): Promise<string | undefined> => {
      const dir = host(files, { reads });
      return (await keyUsage(dir, loadConfig(dir), descriptorOf())).keys['privacy.body']?.state;
    };
    const base = 'var KEY = "waitlist.title";\nTS.tx(KEY);\n';
    expect(await dead({ 's.js': base })).toBe('not_found');
    for (const write of ['window.KEY = pick();', 'globalThis.KEY = pick();', 'window["KEY"] = pick();']) {
      expect.soft(await dead({ 's.js': base, 'other.js': `${write}\n` }), `other file ${write}`).toBe('unknown');
      expect.soft(await dead({ 's.js': `var KEY = "waitlist.title";\n${write}\nTS.tx(KEY);\n` }), `same file ${write}`).toBe('unknown');
    }
  });

  it('V4b remove and rename on a JavaScript host with reads see a read in a file outside the declared surfaces', async () => {
    const host = makeAdoptionHost();
    expect(await host.run('init', '--yes')).toBe(0);
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const config = JSON.parse(host.file('stet.config.json')) as Record<string, unknown>;
    host.write('stet.config.json', JSON.stringify({ ...config, reads: { functions: ['TS.t'] } }, null, 2));
    const key = Object.keys((JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, unknown> }).keys).find((k) => !k.startsWith('brand__')) as string;
    host.write('lib/util.js', `TS.t("${key}");\n`);
    host.out.length = 0;
    expect(await host.run('remove', key)).toBe(0);
    expect(host.stdout()).toContain(`lib/util.js mentions "${key}"`);
    host.out.length = 0;
    expect(await host.run('rename', key, 'zz_new', '--write')).toBe(0);
    expect(host.file('lib/util.js')).toBe('TS.t("zz_new");\n');
  });

  it('V10b two declared keys that overlap inside one string make the occurrence ambiguous: rename refuses it', async () => {
    const ts = await loadTypescript();
    const declared = new Set(['a.b', 'b.c']);
    expect(keysIn('a.b.c', declared)).toEqual(['a.b', 'b.c']);
    const src = 'TS.tx("a.b.c");\n';
    expect(occurrenceIsAmbiguous(src, src.indexOf('a.b.c'), 'a.b', declared)).toBe(true);
    expect(occurrenceIsAmbiguous(src, src.indexOf('b.c'), 'b.c', declared)).toBe(true);
    expect(occurrenceIsAmbiguous('TS.tx("a.b");\n', 7, 'a.b', declared)).toBe(false);
    // `copy.a.b.c` is the property read that takes a key's text and leaves the rest: the half it would rewrite is the other key's too.
    const plan = (names: ReadonlySet<string>) =>
      planReadRenames({
        ts: ts,
        file: 'app/a.ts',
        source: 'import { copy } from "../copy";\ncopy.a.b.c;\n',
        dialect: null,
        renames: new Map([['a.b', 'a.z']]),
        isStetModule: (spec) => spec === '../copy',
        copyModule: false,
        declared: names,
      });
    const both = plan(declared);
    expect(both.blocked).toHaveLength(1);
    expect(both.edits).toEqual([]);
    expect(plan(new Set(['a.b'])).edits).toHaveLength(1);
  });

  it('Q79 rename rewrites the string value of a prop named by the configured attribute', async () => {
    const make = (src: string) =>
      makeHtmlHost({
        files: { 'screen.js': src },
        keys: { 'a.b': { shape: 'text', target: 'web' } },
        defaults: { 'a.b': 'Text of a.b' },
        config: { reads: { functions: ['TS.tx'], attribute: 'data-copy' } },
      });
    for (const [before, after] of [
      ['h("p", { "data-copy": "a.b" }, "x");', 'h("p", { "data-copy": "a.z" }, "x");'],
      ["h('p', { 'data-copy': 'a.b' });", "h('p', { 'data-copy': 'a.z' });"],
      ['h("p", { "data-stet": "a.b" });', 'h("p", { "data-stet": "a.z" });'],
    ] as const) {
      const html = await make(`${before}\n`);
      expect.soft(await html.run('rename', 'a.b', 'a.z', '--write'), before).toBe(0);
      expect.soft(html.file('screen.js'), before).toBe(`${after}\n`);
    }
    const other = await make('h("p", { "data-other": "a.b" });\n');
    expect(await other.run('rename', 'a.b', 'a.z', '--write')).toBe(1);
  });

  it('Q66 eject and the regenerator never strip a mark of the configured attribute, declared or not; a data-stet mark that names no key is stripped', async () => {
    const page = PAGE(
      '  <b data-copy="a.b">Old a.b</b>\n  <i data-stet="c.d">Old c.d</i>\n  <u data-copy="ghost.one">Old ghost1</u>\n  <s data-stet="ghost.two">Old ghost2</s>',
    );
    const make = () =>
      makeHtmlHost({
        files: { 'index.html': page },
        keys: { 'a.b': { shape: 'text', target: 'web' }, 'c.d': { shape: 'text', target: 'web' } },
        defaults: { 'a.b': 'New a.b', 'c.d': 'New c.d' },
        config: { reads: { functions: ['TS.t'], attribute: 'data-copy' } },
      });
    const ejected = await make();
    expect(await ejected.run('eject', '--write')).toBe(0);
    expect(ejected.file('index.html')).toContain('<b data-copy="a.b">New a.b</b>');
    expect(ejected.file('index.html')).toContain('<u data-copy="ghost.one">Old ghost1</u>');
    expect(ejected.file('index.html')).toContain('<s>Old ghost2</s>');
    expect(ejected.stdout()).not.toContain('data-copy="ghost.one" names no key');
    expect(ejected.stdout()).toContain('data-stet="ghost.two" names no key');
    // The regenerator `pull` runs is `planDocuments`.
    const pulled = await make();
    const { writes } = planDocuments(pulled.cwd, ['index.html'], loadDescriptor(JSON.parse(pulled.file('content/descriptor.json'))), { default: { 'a.b': 'New a.b', 'c.d': 'New c.d' } }, new Report(), ['data-copy', 'data-stet']);
    expect(writes[0]?.text).toContain('<u data-copy="ghost.one">Old ghost1</u>');
    expect(writes[0]?.text).toContain('<s>Old ghost2</s>');
  });

  it('Q44 the head edits mint the page keys under the project\'s joiner', () => {
    const doc = readDocument('index.html', '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body></body>\n</html>\n');
    const fix = planDocumentFix(doc, { page: 'home', keys: new Set(), joiner: '.' });
    expect('skip' in fix ? [] : fix.mints.map((m) => m.key)).toEqual(['home.page_title', 'home.meta_description']);
    const plain = planDocumentFix(doc, { page: 'home', keys: new Set() });
    expect('skip' in plain ? [] : plain.mints.map((m) => m.key)).toEqual(['home_page_title', 'home_meta_description']);
  });
});

describe('add-plain-js-hosts (0.9.0) C5', () => {
  const approved = { status: 'approved' as const, at: '2026-11-02', by: 'nj-io' };
  const descriptor = loadDescriptor({
    version: 1,
    keys: {
      brand: { shape: 'text', target: 'web' },
      'home.title': { shape: 'text', target: 'web' },
      'waitlist.left': { shape: 'text', target: 'web' },
      'waitlist.me.share': { shape: 'text', target: 'web', vars: ['cap', 'k'] },
      'mail.subject': { shape: 'text', target: 'html-email' },
    },
  });
  const share = 'Share your link. Each friend who joins and confirms moves you up {{k}} places, up to {{cap}} friends.';
  const snapshot = {
    default: { brand: 'topshine', 'home.title': 'Make it once.', 'waitlist.left': "You've left the list.", 'waitlist.me.share': share, 'mail.subject': 'Hi' },
  };

  it('P5.1 generateOutput writes a script, an ES module and JSON from the snapshot; keysFor keeps the web keys or the only entries', async () => {
    const { generateOutput, keysFor } = await import('../cli/generated.js');
    expect(keysFor({ file: 'x.json', format: 'json', values: 'value' }, descriptor)).toEqual(['brand', 'home.title', 'waitlist.left', 'waitlist.me.share']);
    expect(keysFor({ file: 'x.json', format: 'json', values: 'value', only: ['waitlist.', 'brand'] }, descriptor)).toEqual(['brand', 'waitlist.left', 'waitlist.me.share']);
    // An entry ending in a dot or an underscore is a prefix; any other entry is one exact key.
    expect(keysFor({ file: 'x.json', format: 'json', values: 'value', only: ['waitlist.me'] }, descriptor)).toEqual([]);
    expect(keysFor({ file: 'x.json', format: 'json', values: 'value', only: ['waitlist.me.share', 'bran'] }, descriptor)).toEqual(['waitlist.me.share']);
    const flat = loadDescriptor({ version: 1, keys: { hero_title: { shape: 'text', target: 'web' }, hero_title_more: { shape: 'text', target: 'web' }, pricing_price: { shape: 'text', target: 'web' } } });
    expect(keysFor({ file: 'x.json', format: 'json', values: 'value', only: ['hero_'] }, flat)).toEqual(['hero_title', 'hero_title_more']);
    expect(keysFor({ file: 'x.json', format: 'json', values: 'value', only: ['hero_title'] }, flat)).toEqual(['hero_title']);

    const table = { file: 'design/data/copy.js', format: 'script' as const, name: 'TS.copyTable', values: 'value-status' as const };
    const script = generateOutput(table, descriptor, snapshot, { 'home.title': approved }, '{name}', 'default');
    expect(script).toMatch(/^\/\/ generated by stet — source-hash: [0-9a-f]{64}\n/);
    expect(script).toContain('\nwindow.TS = window.TS || {};\nTS.copyTable = {\n');
    expect(script).toContain('  "home.title": ["Make it once.", "approved"],\n');
    expect(script).toContain('  "waitlist.me.share": ["Share your link. Each friend who joins and confirms moves you up {k} places, up to {cap} friends.", "proposed"]\n};\n');
    expect(script).not.toContain('mail.subject');
    // The host's own reader fills the generated row as it filled the hand-kept one.
    const ctx = vm.createContext(Object.create(null)) as Record<string, any>;
    ctx['window'] = ctx;
    new vm.Script(script).runInContext(ctx);
    const vars: Record<string, number> = { k: 25, cap: 4 };
    expect((ctx['TS'].copyTable['waitlist.me.share'][0] as string).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k])))
      .toBe('Share your link. Each friend who joins and confirms moves you up 25 places, up to 4 friends.');
    // A status word is an input: approving a key moves the header's hash.
    const moved = generateOutput(table, descriptor, snapshot, { 'home.title': approved, brand: approved }, '{name}', 'default');
    expect(moved.split('\n')[0]).not.toBe(script.split('\n')[0]);
    // One guard per prefix of a deeper name; a bare name binds on window.
    expect(generateOutput({ ...table, name: 'a.b.c' }, descriptor, snapshot, null, '{name}', 'default')).toContain('\nwindow.a = window.a || {};\na.b = a.b || {};\na.b.c = {\n');
    expect(generateOutput({ ...table, name: 'COPY' }, descriptor, snapshot, null, '{name}', 'default')).toContain('\nwindow.COPY = {\n');

    const esm = generateOutput({ file: 'src/strings.mjs', format: 'esm', name: 'STRINGS', values: 'value', only: ['waitlist.', 'brand'] }, descriptor, snapshot, null, '{{name}}', 'default');
    expect(esm).toMatch(/^\/\/ generated by stet — source-hash: [0-9a-f]{64}\n/);
    expect(esm).toContain('\nexport const STRINGS = {\n  "brand": "topshine",\n');
    expect(esm).toContain('{{k}} places, up to {{cap}} friends."\n};\n');
    expect(esm).not.toContain('home.title');

    const json = generateOutput({ file: 'strings.json', format: 'json', values: 'value' }, descriptor, snapshot, null, '{name}', 'default');
    expect(json.startsWith('{\n')).toBe(true);
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json)).toEqual({
      brand: 'topshine',
      'home.title': 'Make it once.',
      'waitlist.left': "You've left the list.",
      'waitlist.me.share': 'Share your link. Each friend who joins and confirms moves you up {k} places, up to {cap} friends.',
    });
  });

  it('P5.6 a generated output that cannot be written leaves the descriptor and the snapshot unwritten', () => {
    const locked = tempDir();
    mkdirSync(join(locked, 'content/ro'), { recursive: true });
    chmodSync(join(locked, 'content/ro'), 0o555);
    try {
      const config = { ...defaultConfig(), host: 'html' as const, generated: [{ file: 'content/ro/copy.json', format: 'json' as const, values: 'value' as const }] };
      expect(() => writePlanned(planRepoForms(locked, config, descriptor, snapshot, null, new Report()))).toThrow();
      expect(existsSync(join(locked, 'content/descriptor.json'))).toBe(false);
      expect(existsSync(join(locked, 'content/defaults.json'))).toBe(false);
      expect(existsSync(join(locked, 'content/ro/copy.json'))).toBe(false);
    } finally {
      chmodSync(join(locked, 'content/ro'), 0o755);
    }
  });

  it('F2 a generated file may not name a file stet keeps or repeat another output', () => {
    const kept = (config: Record<string, unknown>, at: number, file: string): void => {
      expect(() => loadConfig(configHost(config))).toThrow(`stet.config.json: generated[${at}].file names a file stet already keeps — ${file}`);
    };
    for (const file of ['content/defaults.json', './content/descriptor.json', 'stet.config.json', 'content/status.json', 'content/keys.ts', '.stet/bundle.json', 'Content/Defaults.json']) {
      kept({ generated: [{ file, format: 'json' }] }, 0, file);
    }
    kept({ statusPath: 'copy/status.json', generated: [{ file: 'copy/status.json', format: 'json' }] }, 0, 'copy/status.json');
    kept({ generated: [{ file: 'out/t.js', format: 'script', name: 'T' }, { file: 'out/t.js', format: 'esm', name: 'T' }] }, 1, 'out/t.js');
    // A managed document of an html host.
    const dir = configHost({ generated: [{ file: 'index.html', format: 'json' }] });
    writeFileSync(join(dir, 'index.html'), '<p>Hello</p>\n');
    expect(() => loadConfig(dir)).toThrow('generated[0].file names a file stet already keeps — index.html');
    // A JavaScript host's source glob may hold an output.
    expect(loadConfig(configHost({ host: undefined, managedSurfaces: ['src/**/*.js'], generated: [{ file: 'src/strings.js', format: 'esm', name: 'S' }] })).generated).toHaveLength(1);
  });

  describe('a json output over a file that exists', () => {
    const keys = { 'home.title': { shape: 'text', target: 'web' }, 'home.gone': { shape: 'text', target: 'web' } };
    const pulled = async (existing: string, only?: string[]): Promise<{ code: number; stderr: string; file: string }> => {
      const site = await makeHtmlHost({
        files: { 'strings.json': existing },
        keys,
        defaults: { 'home.title': 'Welcome', 'home.gone': 'Gone' },
        config: { generated: [{ file: 'strings.json', format: 'json', ...(only === undefined ? {} : { only }) }] },
      });
      const code = await site.run('pull');
      return { code, stderr: site.stderr(), file: site.file('strings.json') };
    };

    it('F2b is refused when it holds a key neither the output nor the descriptor has, and the file keeps its bytes', async () => {
      const hand = '{ "home.title": "Hand kept words", "extra.key": "Only here" }\n';
      const result = await pulled(hand);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('refusing to overwrite strings.json');
      expect(result.file).toBe(hand);
      const other = await pulled('{"name": "package", "version": "1.0.0"}\n');
      expect(other.code).toBe(1);
      const list = await pulled('[1, 2]\n');
      expect(list.code).toBe(1);
    });

    it('F2c is updated when every key it holds is one the output writes', async () => {
      const result = await pulled('{ "home.title": "Hand words" }\n');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.file)).toEqual({ 'home.gone': 'Gone', 'home.title': 'Welcome' });
    });

    it('F2d is updated when it holds a declared key the output no longer keeps (a removal or an only change leaves one behind)', async () => {
      const result = await pulled('{ "home.gone": "Gone", "home.title": "Old" }\n', ['home.title']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.file)).toEqual({ 'home.title': 'Welcome' });
    });
  });

  it('Q84 a copy-module glob whose only match is a generated output is not a dead glob', async () => {
    const site = await makeHtmlHost({
      files: { 'copy.js': `// generated by stet — source-hash: ${'0'.repeat(64)}\nwindow.TS = window.TS || {};\nTS.copyTable = {};\n` },
      config: { managedSurfaces: [], copyModules: ['copy.js'], generated: [{ file: 'copy.js', format: 'script', name: 'TS.copyTable' }] },
    });
    await site.run('scan');
    expect(site.stderr()).not.toContain('matched no files');
    // A glob that matches nothing at all is still reported.
    const dead = await makeHtmlHost({ config: { managedSurfaces: [], copyModules: ['nothing.js'] } });
    await dead.run('scan');
    expect(dead.stderr()).toContain('glob matched no files: nothing.js');
  });
});

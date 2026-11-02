// add-plain-js-hosts (0.9.0), chunk C1: the dotted key grammar, the config, the status file module.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { planRepoForms, writePlanned } from '../cli/artifacts.js';
import { defaultConfig, loadConfig } from '../cli/config.js';
import { namedKeys } from '../cli/key-usage.js';
import { planProblems } from '../cli/key-plan.js';
import { baseName } from '../cli/key-names.js';
import { keyPattern, longerKeyAt } from '../cli/key-reads.js';
import { Report } from '../cli/report.js';
import { loadTypescript, mentionsToken } from '../cli/source-scan.js';
import { approveKeys, completeStatus, loadStatus, renameStatus, resetChanged, statusPlan, type StatusFile } from '../cli/status.js';
import { generateRegistry } from '../src/codegen.js';
import { deriveLabel, loadDescriptor } from '../src/descriptor.js';
import { cleanupCliHosts, makeHtmlHost } from '../conformance/cli-host.js';

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
    const dir = host({}, { reads: { functions: ['TS.t', { name: 'TS.tx', key: 0 }, { name: 'i18n.copy.t', key: 2 }, 't'], attribute: 'data-copy' }, placeholders: '{name}', keyStyle: 'dotted', statusPath: 'copy/status.json', copyFrom: '../owner', scan: { builders: ['h', 'el'] } });
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
    expect(() => loadConfig(host({}, { scan: { builders: 'h' } }))).toThrow(/stet\.config\.json: scan\.builders must be an array of strings/);
    const bare = loadConfig(host({}, {}));
    expect(bare).toMatchObject({ placeholders: '{{name}}', keyStyle: 'underscore', generated: [], statusPath: 'content/status.json' });
    expect(bare.reads).toBeUndefined();
    expect(bare.copyFrom).toBeUndefined();
    expect(bare.scan.builders).toBeUndefined();
    expect(loadConfig(host({}, { reads: { functions: ['t'] } })).reads).toEqual({ functions: [{ name: 't', key: 0 }] });
    expect(loadConfig(host({}, { generated: [{ file: 'a/x.js', format: 'script', name: 'TS.copyTable' }, { file: 'x.json', format: 'json', values: 'value-status', only: ['home.'] }] })).generated).toEqual([
      { file: 'a/x.js', format: 'script', name: 'TS.copyTable', values: 'value' },
      { file: 'x.json', format: 'json', values: 'value-status', only: ['home.'] },
    ]);

    const refuse = (config: Record<string, unknown>, message: RegExp): void => {
      expect(() => loadConfig(host({}, config))).toThrow(message);
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
    // Outside the checkout: a relative climb and an absolute path.
    const inside = /stet\.config\.json: generated\[0\]\.file must be inside this checkout — a second checkout generates its own file through copyFrom/;
    refuse({ generated: [{ file: '../other/strings.mjs', format: 'esm', name: 'S' }] }, inside);
    refuse({ generated: [{ file: 'a/../../strings.mjs', format: 'esm', name: 'S' }] }, inside);
    refuse({ generated: [{ file: '/tmp/strings.mjs', format: 'esm', name: 'S' }] }, inside);
    // A segment that merely starts with two dots stays inside.
    expect(loadConfig(host({}, { generated: [{ file: '..strings.mjs', format: 'esm', name: 'S' }] })).generated).toHaveLength(1);
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

  it('P4.2 planRepoForms writes the status file in the same batch as the snapshot, and a refused batch leaves it unwritten', () => {
    const cwd = tempDir();
    const descriptor = loadDescriptor({ version: 1, keys: { a: { shape: 'text', target: 'web' } } });
    const status: StatusFile = { a: approved('nj-io', '2026-11-02') };
    const plans = planRepoForms(cwd, defaultConfig(), descriptor, { default: { a: 'A' } }, status, new Report());
    expect(plans.map((p) => p.label)).toEqual([
      'content/descriptor.json',
      'content/defaults.json',
      'content/keys.ts',
      'content/stet-env.d.ts',
      'content/defaults.ts',
      'content/resolved.ts',
      'content/status.json',
    ]);
    writePlanned(plans);
    expect(JSON.parse(readFileSync(join(cwd, 'content/status.json'), 'utf8'))).toEqual(status);
    // No approval and no file: the batch has no sixth form.
    expect(planRepoForms(tempDir(), defaultConfig(), descriptor, { default: { a: 'A' } }, {}, new Report()).map((p) => p.label)).not.toContain('content/status.json');

    // A page that cannot be regenerated refuses the whole batch, the status file with it.
    const html = tempDir();
    const page = readFileSync(fileURLToPath(new URL('./fixtures/html-host/index.html', import.meta.url)), 'utf8');
    writeFileSync(join(html, 'index.html'), page.replace('<h1>', '<h1 data-stet="hero">'), 'utf8');
    const config = { ...defaultConfig(), host: 'html' as const, managedSurfaces: ['**/*.html'] };
    const rich = loadDescriptor({ version: 1, keys: { hero: { shape: 'text', target: 'web', tags: 1 } } });
    expect(() => planRepoForms(html, config, rich, { default: { hero: 'A heading with no placeholder at all.' } }, { hero: approved('nj-io', '2026-11-02') }, new Report())).toThrow(/could not be regenerated/);
    expect(existsSync(join(html, 'content/status.json'))).toBe(false);
  });
});

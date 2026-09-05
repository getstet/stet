/**
 * The CLI, driven in process against a temp-directory host — the scenario
 * suite. One named proof per spec requirement lives in the conformance walk;
 * these are the cases behind them: every branch of every command, every
 * failure mode, and the assertions that only a real run can make.
 *
 * The host builder, the counting store and the crash simulator are shared with
 * that walk (`conformance/cli-host.ts`), so both drive an identical project.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { PAGE_DEFAULT, isStoreError } from '../adapters/store-shared.js';
import { ok } from '../conformance/store.suite.js';
import { CONNECT_TIMEOUT_MS } from '../cli/store.js';
import {
  bareHtmlHost,
  cleanupCliHosts,
  countingStore as counting,
  fakeFetch,
  htmlFixture,
  makeCliHost as makeHost,
  makeHtmlHost,
  publishFailsOnce,
  type CliHost as Host,
} from '../conformance/cli-host.js';
import { loadDescriptor, readBundle, resolveFromBundle } from '../src/index.js';

afterAll(cleanupCliHosts);

describe('config and mode', () => {
  it('a bare repo is a valid project: no config file, every default, snapshot-only', async () => {
    const host = makeHost({ config: null });
    expect(await host.run('list')).toBe(0);
    // Every key answers, and every one from the committed snapshot.
    expect(host.stdout()).toContain('hero_headline');
    expect(host.stdout()).toContain('snapshot');
    expect(host.stderr()).toBe('');

    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain('snapshot-only');
    expect(host.stdout()).toContain('no stet.config.json');
  });

  it('a configured adapter with no connection variable names the variable', async () => {
    const host = makeHost({ config: { store: { adapter: 'pg' } }, env: {} });
    expect(await host.run('list')).toBe(1);
    expect(host.stderr()).toContain('STET_DATABASE_URL');
    expect(host.stderr()).toContain("store adapter 'pg' is configured");
    // Configured-and-broken never degrades quietly into snapshot-only.
    expect(host.stdout()).not.toContain('snapshot');
  });

  it('doctor diagnoses a broken store block instead of dying on it', async () => {
    const host = makeHost({ config: { store: { adapter: 'postgrest' } }, env: {} });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain('MISCONFIGURED');
    expect(host.stderr()).toContain('STET_POSTGREST_URL');
  });

  it('a write on a snapshot-only project explains itself', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('draft', 'hero_headline', '--value=Something new')).toBe(1);
    expect(host.stderr()).toContain('snapshot-only');
    expect(host.stderr()).toContain('publish = commit');
  });

  it('locales.default other than "default" is refused, naming why', async () => {
    const host = makeHost({ config: { locales: { default: 'en' } } });
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('locales.default');
  });
});

describe('check', () => {
  it('is offline and complete: a dead host in the environment changes nothing', async () => {
    const clean = makeHost({ config: {} });
    expect(await clean.run('check')).toBe(0);

    const store = counting(createMemoryStore({ project: 'default' }));
    const dead = makeHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: 'postgresql://127.0.0.1:1/nothing' },
      store,
    });
    expect(await dead.run('check')).toBe(0);

    // Identical output, and the store — injected and available — was never
    // called once. The command has no path that reaches an adapter.
    expect(dead.stdout()).toBe(clean.stdout());
    expect(store.calls).toEqual([]);
  });

  it('reports a value that fails its shape, which the save checks alone would pass', async () => {
    const host = makeHost({ config: {} });
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    // A list where text is declared: every rule in validateSave reads the value
    // through the declared shape, which yields no strings from a list, so only
    // the shape check catches this.
    snapshot['default']!['hero_headline'] = ['a', 'list'];
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));

    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('hero_headline');
    expect(host.stderr()).toContain('shape');
  });

  it('warns rather than fails when the generated files were never generated', async () => {
    const host = makeHost({ config: {} });
    rmSync(join(host.cwd, 'content/keys.ts'));
    expect(await host.run('check')).toBe(0);
    expect(host.stderr()).toContain('content/keys.ts: not generated — run stet upgrade');

    // The sibling names its own regenerator: `upgrade` never writes the
    // snapshot-derived defaults module, so naming it here would be a loop.
    const sibling = makeHost({ config: {} });
    rmSync(join(sibling.cwd, 'content/defaults.ts'));
    expect(await sibling.run('check')).toBe(0);
    expect(sibling.stderr()).toContain('content/defaults.ts: not generated — run stet pull');

    // The ambient types behave as their siblings do: absent is unfinished, not
    // broken.
    const ambient = makeHost({ config: {} });
    rmSync(join(ambient.cwd, 'content/stet-env.d.ts'));
    expect(await ambient.run('check')).toBe(0);
    expect(ambient.stderr()).toContain('content/stet-env.d.ts: not generated — run stet upgrade');
  });

  it('checks the ambient types too, so a stale key union cannot keep compiling', async () => {
    // The third generated file. Left unchecked, a key removed from the
    // descriptor stays typed here and `copy('removed_key')` goes on compiling
    // in the host with nothing to say so.
    const host = makeHost({ config: {} });
    writeFileSync(
      join(host.cwd, 'content/stet-env.d.ts'),
      `${host.file('content/stet-env.d.ts')}\ndeclare const MINE: string;\n`,
      'utf8',
    );

    expect(await host.run('check')).toBe(1);
    // The verdict depends on whether the hash line survived the edit, so the
    // assertion is on the file and its regenerator, never the whole message.
    expect(host.stderr()).toContain('content/stet-env.d.ts');
    expect(host.stderr()).toContain('stet upgrade');

    // The remedy closes its own loop: `upgrade` writes this file too.
    expect(await host.run('upgrade')).toBe(0);
    const before = host.err.length;
    expect(await host.run('check')).toBe(0);
    expect(host.err.slice(before).join('\n')).toBe('');
  });

  it('survives a snapshot orphan named `constructor` instead of crashing on it', async () => {
    // The value pass tests membership by own property. A bare `in` answers this
    // key from the prototype, sends `Object.prototype.constructor` into
    // `shapeSchema` as though it were a key definition, and the parse it hands
    // back `undefined` for escapes runCli's catch as a raw TypeError.
    const host = makeHost({ config: {} });
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    snapshot['default']!['constructor'] = 'a hand-placed orphan';
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));

    // The defaults module is stale after the hand edit, so the run has a
    // finding — what matters is that it REPORTS rather than throws.
    expect(await host.run('check', '--json')).toBe(1);
    expect(host.json<{ snapshot: { stale: string[] } }>().snapshot.stale).toEqual(['constructor']);
  });

  it('fails on a stale generated file', async () => {
    const host = makeHost({ config: {} });
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as {
      keys: Record<string, unknown>;
    };
    descriptor.keys['a_new_key'] = { shape: 'text', target: 'web' };
    writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));

    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('content/keys.ts: stale — its source moved; run stet upgrade');
    expect(host.stderr()).toContain('a_new_key');
  });

  it('names the regenerator that actually closes the loop, per generated file', async () => {
    // The registry is descriptor-derived: a descriptor edit that adds no key
    // leaves the snapshot complete, so `upgrade` alone turns the run green.
    const registry = makeHost({ config: {} });
    const descriptor = JSON.parse(registry.file('content/descriptor.json')) as {
      keys: Record<string, Record<string, unknown>>;
    };
    descriptor.keys['hero_headline']!['label'] = 'Hero headline';
    writeFileSync(join(registry.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
    expect(await registry.run('check')).toBe(1);
    expect(registry.stderr()).toContain('content/keys.ts: stale — its source moved; run stet upgrade');
    expect(await registry.run('upgrade')).toBe(0);
    expect(await registry.run('check')).toBe(0);

    // The defaults module is snapshot-derived, and `upgrade` does not write it.
    // Following the finding has to close it: the loop the printed remedy used
    // to send the reader around is the defect this proves gone.
    const defaults = makeHost({ config: {} });
    const snapshot = JSON.parse(defaults.file('content/defaults.json')) as Record<
      string,
      Record<string, unknown>
    >;
    snapshot['default']!['hero_headline'] = 'Never miss a post.';
    writeFileSync(join(defaults.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
    expect(await defaults.run('check')).toBe(1);
    expect(defaults.stderr()).toContain('content/defaults.ts: stale — its source moved; run stet pull');
    expect(defaults.stderr()).not.toContain('content/defaults.ts: stale — its source moved; run stet upgrade');

    // The command the finding used to name leaves it exactly as it was — read
    // from THIS run's lines, not the accumulated log, so the residue of the
    // first check cannot satisfy the assertion.
    expect(await defaults.run('upgrade')).toBe(0);
    const before = defaults.err.length;
    expect(await defaults.run('check')).toBe(1);
    expect(defaults.err.slice(before).join('\n')).toContain(
      'content/defaults.ts: stale — its source moved; run stet pull',
    );
    // …and the one it names now goes green.
    expect(await defaults.run('pull')).toBe(0);
    expect(await defaults.run('check')).toBe(0);
  });

  it('routes a registry from an OLDER stet through upgrade, and the accusation it makes is the residue', async () => {
    // The `StringKey` emission changed the registry's BODY, so a `keys.ts`
    // written by a pre-4g stet no longer matches what this stet generates. Its
    // header hash is still right — the descriptor did not move — so `check`
    // reads it as hand-edited and names `stet upgrade`, which is the correct
    // remedy by accident of a true classification and a wrong reason.
    //
    // The misleading accusation is ACCEPTED residue: telling a generator change
    // apart from a real hand edit needs a generator version in the header, and
    // that is a future row if it ever bites. What matters is that the documented
    // update step closes it, which is what this walks.
    const host = makeHost({ config: {} });
    const current = host.file('content/keys.ts');
    // The old emission, exactly: the same header and KEYS block, ending at the
    // `ContentKey` line the pre-4g generator closed on — the blank line that
    // separates the two unions belongs to the SECOND one and goes with it.
    const old = current.slice(0, current.indexOf('\nexport const STRING_KEYS = ['));
    expect(old).not.toBe(current);
    expect(old.endsWith('export type ContentKey = (typeof KEYS)[number];\n')).toBe(true);
    expect(old).not.toContain('StringKey');
    writeFileSync(join(host.cwd, 'content/keys.ts'), old, 'utf8');

    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('content/keys.ts: hand-edited — run stet upgrade instead of editing');

    expect(await host.run('upgrade')).toBe(0);
    expect(host.file('content/keys.ts')).toBe(current);

    const before = host.err.length;
    expect(await host.run('check')).toBe(0);
    expect(host.err.slice(before).join('\n')).toBe('');
  });

  it('names the regenerator on a HAND-EDITED generated file too, and following it goes green', async () => {
    // The third finding site. A body edit under an intact header hash reads as
    // hand-edited rather than stale — a different branch, and the one whose
    // message named no command at all.
    const host = makeHost({ config: {} });
    const generated = host.file('content/defaults.ts');
    writeFileSync(
      join(host.cwd, 'content/defaults.ts'),
      `${generated}\nexport const MINE = 'hand written';\n`,
      'utf8',
    );

    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('content/defaults.ts: hand-edited — run stet pull instead of editing');
    // Not the sibling's regenerator: `upgrade` never writes this file.
    expect(host.stderr()).not.toContain('content/defaults.ts: hand-edited — run stet upgrade');

    expect(await host.run('pull')).toBe(0);
    const before = host.err.length;
    expect(await host.run('check')).toBe(0);
    expect(host.err.slice(before).join('\n')).toBe('');
  });
});

describe('seo check', () => {
  /** The fixture project's descriptor, edited on disk — the command reads files. */
  function editDescriptor(host: Host, edit: (d: Record<string, any>) => void): void {
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as Record<string, any>;
    edit(descriptor);
    writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
  }

  function editSnapshot(host: Host, edit: (s: Record<string, any>) => void): void {
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, any>;
    edit(snapshot);
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
  }

  it('passes the clean fixture and says what it checked', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stdout()).toContain('seo: 2 pages checked, 0 errors, 0 warnings');
    expect(host.stderr()).toBe('');
  });

  it('exits 1 on a missing description, with the rule id and the whole finding in --json', async () => {
    const host = makeHost({ config: {} });
    editDescriptor(host, (d) => {
      delete d['pages']['pricing']['seo']['description'];
    });

    expect(await host.run('seo', 'check', '--json')).toBe(1);
    const answer = host.json<{
      ok: boolean;
      seo: Array<{ rule: string; severity: string; page?: string; locale?: string }>;
      findings: Array<{ kind: string; level: string; message: string }>;
    }>();
    expect(answer.ok).toBe(false);
    // The rule id rides the finding as its kind, so a CI consumer filters
    // without parsing a message…
    expect(answer.findings.map((f) => f.kind)).toContain('missing-description');
    // …and the structured block carries the page and locale `CliFinding` has no
    // field for.
    expect(answer.seo).toEqual([
      {
        rule: 'missing-description',
        severity: 'error',
        page: 'pricing',
        locale: 'default',
        message: expect.stringContaining('declares no SEO description'),
      },
    ]);
  });

  it('reports warn-level findings and still exits 0', async () => {
    const host = makeHost({ config: {} });
    editSnapshot(host, (s) => {
      s['default']['footer_links'] = ['Click here'];
    });

    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stdout()).toContain('0 errors, 1 warnings');
    expect(host.stderr()).toContain('warn: footer_links[0]');
    expect(host.stderr()).toContain('generic link label');
  });

  it('flips a rule through the config, and rejects an override it does not know', async () => {
    const flipped = makeHost({ config: { seoCheck: { 'anchor-text': 'error' } } });
    editSnapshot(flipped, (s) => {
      s['default']['footer_links'] = ['Click here'];
    });
    expect(await flipped.run('seo', 'check')).toBe(1);
    expect(flipped.stderr()).toContain('error: footer_links[0]');

    const unknown = makeHost({ config: { seoCheck: { 'anchor-txt': 'error' } } });
    expect(await unknown.run('seo', 'check')).toBe(1);
    expect(unknown.stderr()).toContain('seoCheck.anchor-txt');
    expect(unknown.stderr()).toContain('is not a rule');

    const third = makeHost({ config: { seoCheck: { 'anchor-text': 'off' } } });
    expect(await third.run('seo', 'check')).toBe(1);
    expect(third.stderr()).toContain('seoCheck.anchor-text');
    expect(third.stderr()).toContain('"error" or "warn"');
  });

  it('warns a store-backed project about staleness without reaching for the store', async () => {
    // The fork-PR case, whole: a pg store is declared and STET_DATABASE_URL is
    // unset. `loadProject` would throw here — this command never builds an
    // adapter, so the run completes, the warn appears, and the exit stays 0.
    const host = makeHost({ config: { store: { adapter: 'pg' } }, env: {} });
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).toContain('validates the committed snapshot, not production');
    expect(host.stderr()).toContain('stet pull');
    expect(host.stderr()).not.toContain('STET_DATABASE_URL');

    // A declared snapshot adapter is not a store, and gets no warn.
    const snapshotOnly = makeHost({ config: { store: { adapter: 'snapshot' } } });
    expect(await snapshotOnly.run('seo', 'check')).toBe(0);
    expect(snapshotOnly.stderr()).toBe('');

    // A store declared only as a named environment counts too.
    const named = makeHost({ config: { environments: { prod: { adapter: 'pg' } } }, env: {} });
    expect(await named.run('seo', 'check')).toBe(0);
    expect(named.stderr()).toContain('not production');
  });

  /**
   * A host whose descriptor is written for THIS question rather than carved out
   * of the mini-project's. Stripping the shared fixture's pages leaves its keys
   * pointing at pages that no longer exist and its templates behind — the
   * descriptor fails validation before the check ever runs, and the case would
   * prove something else entirely.
   */
  function withDescriptor(keys: Record<string, unknown>, defaults: Record<string, unknown>): Host {
    const host = makeHost({ config: {} });
    writeFileSync(
      join(host.cwd, 'content/descriptor.json'),
      JSON.stringify({ version: 1, keys }, null, 2),
    );
    writeFileSync(
      join(host.cwd, 'content/defaults.json'),
      JSON.stringify({ default: defaults }, null, 2),
    );
    return host;
  }

  it('tells an adopted host with no pages that the rules had nothing to check', async () => {
    // `0 pages checked, 0 errors` is the shape a freshly adopted host sees, and
    // read alone it says the site passed. The warn says what actually happened.
    const host = withDescriptor(
      { hero_headline: { shape: 'text', target: 'web' } },
      { hero_headline: 'Never miss a post again.' },
    );
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).toContain('no pages declared — the SEO rules have nothing to check');
    expect(host.stderr()).toContain('run stet pages scan to declare them');
    expect(host.stdout()).toContain('seo: 0 pages checked');
  });

  it('stays silent on a bare repo — the warn keys on adoption having happened', async () => {
    const host = withDescriptor({}, {});
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).not.toContain('no pages declared');
  });

  it('says nothing where pages are declared, and the rules run as before', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).not.toContain('no pages declared');
    expect(host.stdout()).toContain('seo: 2 pages checked, 0 errors, 0 warnings');
  });

  it('is not a rule: a seoCheck override naming it is still an unknown-rule error', async () => {
    // The warn sits outside the severity table — no rule id, no override, and it
    // never moves the exit. The nine-rule contract is unchanged.
    const host = makeHost({ config: { seoCheck: { 'no-pages': 'error' } } });
    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stderr()).toContain('seoCheck.no-pages');
    expect(host.stderr()).toContain('is not a rule');
  });

  it('takes no --env, and a bare `stet seo` teaches the form', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('seo', 'check', '--env', 'prod')).toBe(2);
    expect(host.stderr()).toContain('stet seo check is offline by contract');

    expect(await host.run('seo')).toBe(2);
    expect(host.stderr()).toContain('stet seo check');

    expect(await host.run('seo', 'lint')).toBe(2);
    expect(host.stderr()).toContain('one subcommand');
  });

  it('passes the descriptor structure warnings through, rather than swallowing them', async () => {
    const host = makeHost({ config: {} });
    editDescriptor(host, (d) => {
      d['templates']['welcome']['slots'].push('cta_label');
    });
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).toContain('welcome__cta_label');
  });

  it('fails as a config error when the descriptor itself will not load', async () => {
    const host = makeHost({ config: {} });
    writeFileSync(join(host.cwd, 'content/descriptor.json'), '{ not json');
    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stderr()).toContain('content/descriptor.json');
  });
});

describe('list, get, diff', () => {
  it('list reports source, active version and a pending draft', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    await host.run('draft', 'hero_headline', '--value=Stored and live', '--editor', 'neil');
    await host.run('publish', 'hero_headline', '--editor', 'neil');
    await host.run('draft', 'hero_body', '--value=A pending idea', '--editor', 'neil');

    expect(await host.run('list', '--json')).toBe(0);
    const rows = (JSON.parse(host.out[host.out.length - 1]!) as { rows: { key: string; source: string; version: number | null; draft: boolean }[] }).rows;
    expect(rows.find((r) => r.key === 'hero_headline')).toMatchObject({ source: 'active', version: 1, draft: false });
    expect(rows.find((r) => r.key === 'hero_body')).toMatchObject({ source: 'snapshot', draft: true });
  });

  it('store down, list still answers — every key from the snapshot, exit 0', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.failNext = 'read';
    const host = makeHost({ store });

    expect(await host.run('list', '--json')).toBe(0);
    const answer = JSON.parse(host.out[host.out.length - 1]!) as {
      ok: boolean;
      rows: { source: string }[];
      findings: { level: string; message: string }[];
    };
    expect(answer.ok).toBe(true);
    expect(new Set(answer.rows.map((r) => r.source))).toEqual(new Set(['snapshot', 'derived']));
    expect(answer.findings).toHaveLength(1);
    expect(answer.findings[0]?.level).toBe('warn');
    expect(answer.findings[0]?.message).toContain('unreachable');
  });

  it('get prints a string as itself and a structured value as JSON', async () => {
    const host = makeHost();
    expect(await host.run('get', 'hero_headline')).toBe(0);
    expect(host.out.at(-1)).toBe('Never miss a post again.');

    const second = makeHost();
    expect(await second.run('get', 'footer_links')).toBe(0);
    expect(second.out.at(-1)).toBe('["Privacy","Terms","Status"]');

    const third = makeHost();
    expect(await third.run('get', 'no_such_key')).toBe(1);
    expect(third.stderr()).toContain('no_such_key');
  });

  it('diff labels active against draft, and says so when there is none', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('diff', 'hero_headline')).toBe(0);
    expect(host.stdout()).toContain('draft: none');

    await host.run('draft', 'hero_headline', '--value=Still in progress', '--editor', 'neil');
    const second = makeHost({ store });
    expect(await second.run('diff', 'hero_headline')).toBe(0);
    expect(second.stdout()).toContain('active [snapshot]: Never miss a post again.');
    expect(second.stdout()).toContain('draft: Still in progress');
  });

  it('a mirror never runs against absence: diff fails loudly where list degrades', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.failNext = 'read';
    const host = makeHost({ store });
    expect(await host.run('diff', 'hero_headline')).toBe(1);
    expect(host.stderr()).toContain('did not answer');
  });
});

describe('draft', () => {
  it('a bad value never reaches the store', async () => {
    const store = counting(createMemoryStore({ project: 'default' }));
    const host = makeHost({ store });
    // farewell_notice's limit is hard at 4096.
    expect(await host.run('draft', 'farewell_notice', `--value=${'x'.repeat(5000)}`)).toBe(1);
    expect(host.stderr()).toContain('exceeds the 4096-character limit');
    expect(store.calls).toEqual([]);
  });

  it('parses the value by declared shape, never JSON-first', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    // The case JSON-first would break: 16 on a text key becomes the number 16,
    // passes every save check, and quarantines at read time behind a success.
    expect(await host.run('draft', 'pricing_price', '--value=16', '--editor', 'neil')).toBe(0);
    const row = store.dump().find((r) => r.key === 'pricing_price');
    expect(row?.value).toBe('16');
    expect(typeof row?.value).toBe('string');

    // A structured shape is the other half of the same rule: it requires JSON.
    const bad = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await bad.run('draft', 'footer_links', '--value=Privacy')).toBe(2);
    expect(bad.stderr()).toContain('shape: list');

    const good = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await good.run('draft', 'footer_links', '--value=["Privacy","Terms"]')).toBe(0);
  });

  it('a refusal names the incumbent and overwrites nothing', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('draft', 'hero_body', '--value=human wording', '--editor', 'neil')).toBe(0);

    const agent = makeHost({ store });
    expect(await agent.run('draft', 'hero_body', '--value=agent wording', '--editor', 'agent:claude')).toBe(1);
    expect(agent.stderr()).toContain('neil');
    expect(agent.stderr()).toContain('--force');
    expect(store.dump().find((r) => r.key === 'hero_body')?.value).toBe('human wording');

    const forced = makeHost({ store });
    expect(
      await forced.run('draft', 'hero_body', '--value=agent wording', '--editor', 'agent:claude', '--force'),
    ).toBe(0);
    expect(store.dump().find((r) => r.key === 'hero_body')?.value).toBe('agent wording');
  });

  it('attribution is never optional: an empty editor is a usage error', async () => {
    const host = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await host.run('draft', 'hero_headline', '--value=x', '--editor', '  ')).toBe(2);
    expect(host.stderr()).toContain('every write records who made it');
  });

  it('defaults the editor to cli:<os user> when none is given', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('draft', 'hero_headline', '--value=Mine')).toBe(0);
    expect(store.dump().find((r) => r.key === 'hero_headline')?.editor).toMatch(/^cli:/);
  });

  it('takes a long or dash-leading value from a file', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    writeFileSync(join(host.cwd, 'value.txt'), '-not an option');
    expect(await host.run('draft', 'hero_headline', '--value-file', 'value.txt', '--editor', 'neil')).toBe(0);
    expect(store.dump().find((r) => r.key === 'hero_headline')?.value).toBe('-not an option');
  });
});

describe('the schedule stamp', () => {
  it('stores the resolved instant, never the caller’s spelling', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    // `Date.parse` accepts far more than ISO. `"1"` is the year 2001 — a typo
    // that would schedule a publish in the PAST, and the clock would fire it on
    // its next run. Storing the resolved instant is what makes the stamp mean
    // one moment to every reader, including Postgres under another DateStyle.
    expect(
      await host.run('draft', 'hero_headline', '--value=x', '--editor', 'neil', '--publish-at', '1'),
    ).toBe(0);
    const stored = store.dump().find((r) => r.key === 'hero_headline')?.publish_at;
    expect(stored).toBe(new Date(Date.parse('1')).toISOString());
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // An already-ISO stamp is unchanged, and an unparseable one is a usage error.
    await host.run('draft', 'hero_body', '--value=y', '--editor', 'neil', '--publish-at', '2030-06-01T09:00:00.000Z');
    expect(store.dump().find((r) => r.key === 'hero_body')?.publish_at).toBe('2030-06-01T09:00:00.000Z');
    expect(
      await host.run('draft', 'footer_links', '--value=z', '--editor', 'neil', '--publish-at', 'whenever'),
    ).toBe(2);
  });
});

describe('publish --due', () => {
  it('publishes what is due, leaves what is not, and reports zero as zero', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);
    expect(host.stdout()).toContain('0 due');

    await host.run('draft', 'hero_headline', '--value=Due already', '--editor', 'neil', '--publish-at', '2020-01-01T00:00:00.000Z');
    await host.run('draft', 'hero_body', '--value=Not yet', '--editor', 'neil', '--publish-at', '2099-01-01T00:00:00.000Z');

    const clock = makeHost({ store });
    expect(await clock.run('publish', '--due', '--editor', 'clock')).toBe(0);
    expect(clock.stdout()).toContain('1 published from 1 due draft(s)');

    const rows = store.dump();
    // The due draft went live through the same RPC a click would call, and is
    // attributed exactly as a manual publish would be.
    const live = rows.find((r) => r.key === 'hero_headline' && r.is_active);
    expect(live?.value).toBe('Due already');
    expect(live?.editor).toBe('neil');
    expect(live?.published_by).toBe('clock');
    // The not-yet-due draft was untouched.
    expect(rows.find((r) => r.key === 'hero_body')?.state).toBe('draft');
  });

  it('refuses to run against an unreachable store', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.failNext = 'read';
    const host = makeHost({ store });
    expect(await host.run('publish', '--due')).toBe(1);
    expect(host.stderr()).toContain('did not answer');
  });

  /** A scheduled change holding `keys`, stamped in the past so the clock sees it. */
  async function dueChange(
    store: ReturnType<typeof createMemoryStore>,
    keys: string[],
    name = 'spring refresh',
  ): Promise<number> {
    const { changeId } = ok(await store.changesets.open({ name }));
    for (const key of keys) {
      ok(await store.saveDraft({ key, value: `${key} grouped`, target: 'web', editor: 'neil', change: changeId }));
    }
    ok(await store.changesets.schedule({ changeId, publishAt: '2020-01-01T00:00:00.000Z' }));
    return changeId;
  }

  it('a due change publishes atomically while an unrelated due draft publishes beside it', async () => {
    const store = createMemoryStore({ project: 'default' });
    const changeId = await dueChange(store, ['hero_headline', 'hero_body']);
    // An ungrouped due draft, which must publish on its own path unaffected.
    ok(
      await store.saveDraft({
        key: 'footer_links',
        value: ['a'],
        target: 'web',
        editor: 'neil',
        publishAt: '2020-01-01T00:00:00.000Z',
      }),
    );

    const host = makeHost({ store });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);
    const out = host.stdout();
    // Each member is reported by name, with the change that carried it.
    expect(out).toContain('change "spring refresh"');
    expect(out).toContain('published hero_headline (default)');
    expect(out).toContain('published hero_body (default)');
    expect(out).toContain('published footer_links (default)');
    expect(out).toContain('3 published from 3 due draft(s)');

    // The members flipped together and KEPT their change; the ungrouped draft
    // is live and ungrouped.
    const live = store.dump().filter((r) => r.is_active);
    expect(live).toHaveLength(3);
    expect(live.filter((r) => r.changeset_id === changeId).map((r) => r.key).sort()).toEqual([
      'hero_body',
      'hero_headline',
    ]);
    expect(live.find((r) => r.key === 'footer_links')?.changeset_id).toBeNull();
    expect(ok(await store.changesets.get({ changeId })).change.status).toBe('published');
  });

  it('a member conflict leaves the whole change scheduled and the run reports it', async () => {
    const store = createMemoryStore({ project: 'default' });
    const changeId = await dueChange(store, ['hero_headline', 'hero_body']);
    // Staged to conflict: the group flip refuses, so NOTHING of the change
    // publishes and it stays scheduled to retry whole next run.
    const staged = {
      ...store,
      changesets: {
        ...store.changesets,
        publishChange: async () => ({
          storeError: true as const,
          code: 'conflict' as const,
          message: 'publish_conflict:hero_body',
        }),
      },
    };
    const host = makeHost({ store: staged });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(1);
    expect(host.stderr()).toContain('change "spring refresh" held');
    // The RPC's raise already names the failing key.
    expect(host.stderr()).toContain('publish_conflict:hero_body');
    expect(host.stderr()).toContain('retries next run');
    expect(host.stdout()).toContain('0 published from 2 due draft(s)');

    expect(store.dump().filter((r) => r.is_active)).toHaveLength(0);
    expect(ok(await store.changesets.get({ changeId })).change.status).toBe('scheduled');
  });

  it('a due member in an unscheduled change is reported as residue, never solo-published', async () => {
    const store = createMemoryStore({ project: 'default' });
    const changeId = await dueChange(store, ['hero_headline']);
    // The TORN-CANCEL state, reproduced at exactly the seam the clock reads:
    // the change row says open while its member drafts still carry the stamp.
    // (Cancel writes the change row first, so this is the observable a crash
    // between the two statements leaves behind.)
    const torn = {
      ...store,
      changesets: {
        ...store.changesets,
        get: async (p: { changeId: number }) => {
          const answer = ok(await store.changesets.get(p));
          return { ...answer, change: { ...answer.change, status: 'open' as const } };
        },
      },
    };
    const host = makeHost({ store: torn });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);
    expect(host.stdout()).toContain('is grouped in open change "spring refresh"');
    expect(host.stdout()).toContain('schedule or publish the change');
    // Publishing it alone would take a member live outside its group.
    expect(store.dump().filter((r) => r.is_active)).toHaveLength(0);
    expect(host.stdout()).toContain('0 published from 1 due draft(s)');
  });

  it('a due change with nothing left to publish is demoted and reported', async () => {
    const store = createMemoryStore({ project: 'default' });
    const changeId = await dueChange(store, ['hero_headline']);
    // The members were discarded after the change was scheduled — the change is
    // due, with no due member left.
    ok(await store.changesets.discardDraft({ key: 'hero_headline' }));

    const host = makeHost({ store });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);
    expect(host.stdout()).toContain('demoted "spring refresh" to open — nothing left to publish');
    // Reported, never a silent skip — and never a phantom retry every run.
    expect(host.stdout()).toContain('1 scheduled change(s) demoted');

    const after = ok(await store.changesets.get({ changeId })).change;
    expect(after.status).toBe('open');
    expect(after.publishAt).toBeNull();

    // A second run has nothing to demote.
    const again = makeHost({ store });
    expect(await again.run('publish', '--due', '--editor', 'clock')).toBe(0);
    expect(again.stdout()).toContain('0 due');
    expect(again.stdout()).not.toContain('demoted');
  });

  it('demotes a backlog longer than one page, walking the cursor to the end', async () => {
    const store = createMemoryStore({ project: 'default' });
    // One page's worth and then some: a one-shot `list` would demote the first
    // PAGE_DEFAULT and leave the rest retrying forever, with nothing to say so.
    const total = PAGE_DEFAULT + 3;
    for (let i = 0; i < total; i += 1) {
      await dueChange(store, ['hero_headline'], `backlog ${i}`);
      ok(await store.changesets.discardDraft({ key: 'hero_headline' }));
    }

    let listCalls = 0;
    const counted = {
      ...store,
      changesets: {
        ...store.changesets,
        list: async (q: Parameters<typeof store.changesets.list>[0]) => {
          listCalls += 1;
          return store.changesets.list(q);
        },
      },
    };
    const host = makeHost({ store: counted });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);

    // Every one of them, in ONE run — and the cursor was actually walked.
    expect(host.stdout()).toContain(`${total} scheduled change(s) demoted`);
    expect(listCalls).toBeGreaterThan(1);
    const scheduled = ok(await store.changesets.list({ status: 'scheduled' }));
    expect(scheduled.changes).toEqual([]);
  });

  it('counts what published even when a torn schedule flips more than was due', async () => {
    const store = createMemoryStore({ project: 'default' });
    const changeId = await dueChange(store, ['hero_headline', 'hero_body']);
    // A torn schedule: the change row carries the stamp but one member draft
    // never got stamped, so the clock sees ONE due draft while the group flip
    // takes both members live.
    const torn = {
      ...store,
      read: async (q?: { keys?: string[]; locale?: string; preview?: boolean }) => {
        const answer = await store.read(q);
        if (isStoreError(answer)) return answer;
        return answer.map((row) =>
          row.key === 'hero_body' && row.status === 'draft' ? { ...row, publishAt: null } : row,
        );
      },
    };
    const host = makeHost({ store: torn });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);

    // "2 of 1 due drafts published" would read as a broken counter rather than
    // the state it is reporting.
    expect(host.stdout()).toContain('2 published from 1 due draft(s)');
    expect(host.stdout()).not.toContain('of 1 due');
    expect(store.dump().filter((r) => r.is_active)).toHaveLength(2);
    expect(ok(await store.changesets.get({ changeId })).change.status).toBe('published');
  });

  it('every grouped line goes through Report, not around it', async () => {
    const store = createMemoryStore({ project: 'default' });
    await dueChange(store, ['hero_headline', 'hero_body']);
    const demoted = await dueChange(store, ['footer_links'], 'empty one');
    ok(await store.changesets.discardDraft({ key: 'footer_links' }));

    const host = makeHost({ store });
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(0);
    // The environments regression posture: the grouped leg adds no channel of
    // its own. Every line — members, demotion, summary — lands on the report's
    // stdout, and a clean run writes nothing to stderr.
    const lines = host.stdout().split('\n').filter((l) => l !== '');
    expect(lines.some((l) => l.includes('change "spring refresh"'))).toBe(true);
    expect(lines.some((l) => l.includes('demoted "empty one"'))).toBe(true);
    expect(lines.some((l) => l.includes('2 published from 2 due draft(s)'))).toBe(true);
    expect(host.stderr()).toBe('');
    expect(ok(await store.changesets.get({ changeId: demoted })).change.status).toBe('open');
  });

  it('skips a due draft whose key has left the descriptor, and publishes the rest', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    // `footer_links` is the key that reproduces this: deleting `hero_headline`
    // dangles its deriver and makes the descriptor unloadable, which would mask
    // the bypass behind a load failure instead of exposing it.
    await host.run('draft', 'footer_links', '--value=["Privacy"]', '--editor', 'neil', '--publish-at', '2020-01-01T00:00:00.000Z');
    await host.run('draft', 'blog_intro', '--value=Notes from the build.', '--editor', 'neil', '--publish-at', '2020-01-01T00:00:00.000Z');

    const descriptor = JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, unknown> };
    delete descriptor.keys['footer_links'];
    writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));

    // Each run is a fresh loadProject, so the same host now reads the edited
    // descriptor.
    expect(await host.run('publish', '--due', '--editor', 'clock')).toBe(1);
    expect(host.stderr()).toContain(
      'footer_links (default): due draft skipped — the key is no longer in the descriptor; ' +
        'restore the key or discard the draft',
    );
    // Nonzero for the cron, and the loop stranded nothing.
    expect(host.stdout()).toContain('published blog_intro (default)');
    expect(host.stdout()).toContain('1 published from 2 due draft(s)');
    const rows = store.dump();
    expect(rows.find((r) => r.key === 'footer_links')?.state).toBe('draft');
    expect(rows.find((r) => r.key === 'blog_intro' && r.is_active)?.state).toBe('published');

    // The interactive leg refuses the same state — the clock leg now gates
    // exactly as it does.
    expect(await host.run('publish', 'footer_links', '--editor', 'neil')).toBe(1);
    expect(host.stderr()).toContain('"footer_links" is not a key in content/descriptor.json');
  });
});

describe('seed', () => {
  it('writes every non-derived key as version 1 and skips the derived one', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('seed')).toBe(0);

    const rows = store.dump();
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    const nonDerived = Object.entries(descriptor.keys).filter(([, d]) => d.derivesFrom === undefined);
    const derived = Object.entries(descriptor.keys).filter(([, d]) => d.derivesFrom !== undefined);

    expect(rows).toHaveLength(nonDerived.length);
    for (const [key] of nonDerived) {
      const row = rows.find((r) => r.key === key);
      expect(row?.state).toBe('published');
      expect(row?.is_active).toBe(true);
      expect(row?.editor).toBe('stet:seed');
    }
    for (const [key] of derived) expect(rows.find((r) => r.key === key)).toBeUndefined();
    expect(host.stdout()).toContain(`${derived.length} derived`);
  });

  it('re-running is the repair: a crashed run finishes, seeded keys are skipped', async () => {
    const inner = createMemoryStore({ project: 'default' });
    const crashed = makeHost({ store: publishFailsOnce(inner) });
    expect(await crashed.run('seed')).toBe(1);
    // The crash left a stet:seed draft behind on exactly one key.
    const stranded = inner.dump().filter((r) => r.state === 'draft');
    expect(stranded).toHaveLength(1);

    const repair = makeHost({ store: inner });
    expect(await repair.run('seed')).toBe(0);
    expect(repair.stdout()).toContain('recovered 1');
    expect(repair.stdout()).toContain('already has history');

    // Exactly one active version 1 per key, and no draft left anywhere.
    const rows = inner.dump();
    expect(rows.filter((r) => r.state === 'draft')).toHaveLength(0);
    for (const key of new Set(rows.map((r) => r.key))) {
      expect(rows.filter((r) => r.key === key && r.is_active)).toHaveLength(1);
    }
  });

  it('the refusal is the ownership signal: another editor’s draft is skipped, never forced', async () => {
    const store = createMemoryStore({ project: 'default' });
    const held = makeHost({ store });
    await held.run('draft', 'hero_body', '--value=my unpublished wording', '--editor', 'neil');

    const host = makeHost({ store });
    expect(await host.run('seed')).toBe(0);
    expect(host.stdout()).toContain('a draft by neil is open');
    expect(host.stdout()).toContain('1 held by another editor');

    // Untouched, and unpublished: seed never forces and never publishes it.
    const row = store.dump().find((r) => r.key === 'hero_body');
    expect(row?.value).toBe('my unpublished wording');
    expect(row?.state).toBe('draft');
  });

  it('reports honestly that an adapter with no stet_meta was not stamped', async () => {
    const host = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await host.run('seed')).toBe(0);
    expect(host.stdout()).toContain('not stamped (adapter has no stet_meta)');
  });
});

describe('audit', () => {
  it('reports its three findings, writes nothing, and leaves the orphan standing', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.seed([
      { key: 'hero_headline', value: 'live', target: 'web' },
      // An orphan: a key the descriptor no longer declares.
      { key: 'retired_banner', value: 'gone from the descriptor', target: 'web' },
      // Target drift: the descriptor declares hero_body as web.
      { key: 'hero_body', value: 'drifted', target: 'html-email' },
    ]);
    const watched = counting(store);
    const host = makeHost({ store: watched });

    expect(await host.run('audit', '--json')).toBe(0);
    const answer = JSON.parse(host.out.at(-1)!) as {
      unseeded: string[];
      orphans: string[];
      drift: { key: string; stored: string; declared: string }[];
    };
    expect(answer.orphans).toEqual(['retired_banner']);
    expect(answer.drift).toEqual([{ key: 'hero_body', stored: 'html-email', declared: 'web' }]);
    expect(answer.unseeded).toContain('footer_links');
    expect(answer.unseeded).not.toContain('hero_headline');

    // No write of any kind was issued — and the orphan is still there. The
    // interface has no delete method, so "no delete was called" would be true
    // of any implementation and prove nothing.
    expect(watched.calls).toEqual(['read']);
    expect(store.dump().some((r) => r.key === 'retired_banner')).toBe(true);
  });

  it('--strict promotes the same findings to failures', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('audit')).toBe(0);

    const strict = makeHost({ store });
    expect(await strict.run('audit', '--strict')).toBe(1);
    expect(strict.stderr()).toContain('run `stet seed`');
  });

  it('refuses to audit against an unreachable store', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.failNext = 'read';
    const host = makeHost({ store });
    expect(await host.run('audit')).toBe(1);
  });
});

describe('pull', () => {
  it('mirrors the store into the repo forms and preserves what it does not own', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    await host.run('draft', 'hero_headline', '--value=Published from the store', '--editor', 'neil');
    await host.run('publish', 'hero_headline', '--editor', 'neil');

    // An orphan key inside the enabled locale, and a locale nobody enabled.
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    snapshot['default']!['retired_banner'] = 'an orphan the descriptor forgot';
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));

    const pull = makeHost({ store });
    cpSync(join(host.cwd, 'content/defaults.json'), join(pull.cwd, 'content/defaults.json'));
    expect(await pull.run('pull')).toBe(0);

    const written = JSON.parse(pull.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    // The store's published value landed…
    expect(written['default']?.['hero_headline']).toBe('Published from the store');
    // …the un-enabled locale is untouched…
    expect(written['de']).toEqual({ hero_headline: 'Verpasse nie wieder einen Post.' });
    // …the orphan survived (audit reports it; pull never deletes)…
    expect(written['default']?.['retired_banner']).toBe('an orphan the descriptor forgot');
    // …and the derived key is absent from the snapshot by design.
    expect(written['default']?.['seo_home_title']).toBeUndefined();

    const bundle = readBundle(JSON.parse(pull.file('.stet/bundle.json')));
    expect(bundle.values['default']?.['hero_headline']).toBe('Published from the store');
    // The bundle materializes every key, derived included — that is what a
    // non-JS consumer reads.
    expect(bundle.values['default']?.['seo_home_title']).toBe('Published from the store — Mirra');
    expect(bundle.meta?.['default']?.['hero_headline']).toEqual({ version: 1 });
    // Only an active row mints version metadata; a snapshot-served key has none.
    expect(bundle.meta?.['default']?.['hero_body']).toBeUndefined();

    // The shipped readers round-trip the emitted bytes.
    const descriptor = loadDescriptor(JSON.parse(pull.file('content/descriptor.json')));
    expect(resolveFromBundle(descriptor, bundle, { key: 'hero_headline' }).value).toBe(
      'Published from the store',
    );

    expect(pull.file('content/defaults.ts')).toContain('Published from the store');
  });

  it('pull twice, diff empty', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('pull')).toBe(0);
    const first = [
      readFileSync(join(host.cwd, 'content/defaults.json')),
      readFileSync(join(host.cwd, 'content/defaults.ts')),
      readFileSync(join(host.cwd, '.stet/bundle.json')),
    ];

    const again = makeHost({ store });
    cpSync(join(host.cwd, 'content/defaults.json'), join(again.cwd, 'content/defaults.json'));
    expect(await again.run('pull')).toBe(0);
    const second = [
      readFileSync(join(again.cwd, 'content/defaults.json')),
      readFileSync(join(again.cwd, 'content/defaults.ts')),
      readFileSync(join(again.cwd, '.stet/bundle.json')),
    ];
    for (const [i, bytes] of first.entries()) expect(bytes.equals(second[i]!)).toBe(true);
  });

  it('a snapshot-only project gets no bundle — its committed snapshot is one', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('pull')).toBe(0);
    expect(host.exists('.stet/bundle.json')).toBe(false);
    expect(host.stdout()).toContain('IS the bundle');
  });

  it('refuses to mirror against an unreachable store, writing nothing', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.failNext = 'read';
    const host = makeHost({ store });
    const before = host.file('content/defaults.json');
    expect(await host.run('pull')).toBe(1);
    expect(host.file('content/defaults.json')).toBe(before);
    expect(host.exists('.stet/bundle.json')).toBe(false);
  });
});

describe('doctor', () => {
  it('reports every section, and snapshot-only is a clean bill', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('doctor')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('config:');
    expect(output).toContain('descriptor: content/descriptor.json');
    expect(output).toContain('snapshot:');
    expect(output).toContain('generated: content/keys.ts current');
    expect(output).toContain('store: snapshot-only');
    expect(output).toContain('no upward search');
  });

  it('reports a configured store as reachable, with its meta', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain('reachable');
  });

  it('an unreachable store is a warning, never a failure', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.failNext = 'read';
    const host = makeHost({ store });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain('UNREACHABLE');
  });

  it('--report emits a pasteable block carrying the package version', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('doctor', '--report')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('```');
    expect(output).toMatch(/stet \d+\.\d+\.\d+ · node v/);
  });

  it('sanitizes finding text in the pasteable block, both to the terminal and to --json', async () => {
    // doctor absorbs check's findings, and --report formats them into the
    // block an operator pastes into an issue. A store-controlled record FIELD
    // NAME reaches that block through the entry path, so the block is a
    // second finding-text channel and gets the same one formatter.
    const ESC = String.fromCharCode(0x1b);
    const C1_CSI = String.fromCharCode(0x9b);
    const RLO = String.fromCharCode(0x202e);
    const field = `na${ESC}[31m${C1_CSI}31m${RLO}me`;
    const poisoned = (host: Host) => {
      const snapshot = JSON.parse(host.file('content/defaults.json'));
      snapshot.default.contact_form_labels = { [field]: 'Ask {{nope}}' };
      writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
    };

    const human = makeHost({ config: {} });
    poisoned(human);
    expect(await human.run('doctor', '--report')).toBe(0);
    const block = human.stdout();
    expect(block).toContain('contact_form_labels.na');
    expect(block).toContain('\uFFFD');
    expect(block).not.toContain('\u001b');
    expect(block).not.toContain('\u009b');
    expect(block).not.toContain('\u202e');

    // The data channel stays byte-faithful: the findings array carries what
    // was stored. The BLOCK does not — it is a rendered human artifact, and
    // the one thing an operator is told to paste elsewhere, so it is
    // sanitized on the wire too.
    const wire = makeHost({ config: {} });
    poisoned(wire);
    expect(await wire.run('doctor', '--json', '--report')).toBe(0);
    const answer = wire.json<{ report: string; findings: Array<{ message: string }> }>();
    expect(answer.findings.some((f) => f.message.includes(field))).toBe(true);
    expect(answer.report).toContain('\uFFFD');
    expect(answer.report).not.toContain('\u001b');
  });
  it('the live guard passes on a raw page and on a partially escaped one', async () => {
    const host = makeHost({
      config: {},
      fetchImpl: fakeFetch('<h1>Never miss a post again.</h1>'),
    });
    expect(await host.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(0);
    expect(host.stdout()).toContain('is serving hero_headline');

    // The case an enumerated-encodings check gets wrong. A serializer escapes
    // per character, so one sentence arrives with an `&amp;` beside a literal
    // apostrophe — matching neither the wholly-raw form nor a wholly-escaped
    // one. Decoding the page first handles the mixture by construction.
    const mixed = makeHost({ config: {} });
    const snapshot = JSON.parse(mixed.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    snapshot['default']!['hero_headline'] = "Ship it & don't wait.";
    writeFileSync(join(mixed.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));

    const served = makeHost({
      config: {},
      fetchImpl: fakeFetch("<h1>Ship it &amp; don't wait.</h1>"),
    });
    cpSync(join(mixed.cwd, 'content/defaults.json'), join(served.cwd, 'content/defaults.json'));
    expect(await served.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(0);
    expect(served.stdout()).toContain('is serving hero_headline');

    // Decoding must not manufacture a hit: an escaped ampersand is resolved
    // last, so `&amp;amp;` stays `&amp;` rather than becoming `&`.
    const literal = makeHost({
      config: {},
      fetchImpl: fakeFetch("<h1>Ship it &amp;amp; don't wait.</h1>"),
    });
    cpSync(join(mixed.cwd, 'content/defaults.json'), join(literal.cwd, 'content/defaults.json'));
    expect(await literal.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(1);
  });

  it('the live guard catches a stale deploy, naming the key and the value', async () => {
    const host = makeHost({ config: {}, fetchImpl: fakeFetch('<h1>Something else entirely</h1>') });
    expect(await host.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(1);
    expect(host.stderr()).toContain('hero_headline');
    expect(host.stderr()).toContain('Never miss a post again.');
  });

  it('refuses a non-text key with the right article, before any fetch', async () => {
    let called = 0;
    const host = makeHost({
      config: {},
      fetchImpl: async () => {
        called += 1;
        return new Response('');
      },
    });
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    snapshot['default']!['hero_headline'] = { subject: 'Hi', body: 'There' };
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));

    expect(await host.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(2);
    expect(host.stderr()).toContain('resolves to an object; the live check reads text');
    expect(called).toBe(0);
  });

  it('makes no fetch call at all without --url', async () => {
    let called = 0;
    const host = makeHost({
      config: {},
      fetchImpl: (async () => {
        called += 1;
        return new Response('');
      }) as typeof globalThis.fetch,
    });
    expect(await host.run('doctor')).toBe(0);
    expect(called).toBe(0);
  });
});

describe('upgrade', () => {
  /** A PostgREST that has never seen migration 1: stet_meta is not there. */
  const noMeta = fakeFetch(JSON.stringify({ code: 'PGRST205', message: 'not found' }), 404);

  function postgrestHost(): Host {
    return makeHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 'test' },
      // canApplyDDL is false on this adapter, which is the branch under test.
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: noMeta,
    });
  }

  it('an unversioned database reports every migration pending, never up to date', async () => {
    const host = postgrestHost();
    expect(await host.run('upgrade', '--dry-run')).toBe(0);
    const output = host.stdout();
    // The readdir walks the shipped files, so a new migration joins the pending
    // list with no count to maintain — and it applies in number order.
    expect(output).toContain('installed 0, pending 1, 2');
    expect(output).toContain('would apply 001_content_cms.sql');
    expect(output).toContain('would apply 002_changesets.sql');
    expect(output.indexOf('001_content_cms.sql')).toBeLessThan(output.indexOf('002_changesets.sql'));
    expect(output).not.toContain('up to date');
    // A dry run writes nothing, the registry included.
    expect(output).toContain('content/keys.ts: unchanged');
  });

  it('the print path carries the apply paths and the post-apply access check', async () => {
    const host = postgrestHost();
    expect(await host.run('upgrade')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('cannot apply DDL');
    expect(output).toContain('create table content_versions');
    expect(output).toContain("notify pgrst, 'reload schema';");
    expect(output).toContain(
      "select has_table_privilege('<your anon role>', 'content_versions', 'SELECT');  -- expected: f",
    );
    expect(output).toContain('stet upgrade --verify');
  });

  it('--verify fails while stet_meta has not moved', async () => {
    const host = postgrestHost();
    expect(await host.run('upgrade', '--verify')).toBe(1);
    expect(host.stderr()).toContain('has not been applied');
  });

  it('--verify passes and stamps once the schema is there', async () => {
    // The NEWEST shipped migration. A database still reporting 1 has 002
    // pending, which is the --verify refusal below, not this case.
    const applied = fakeFetch(JSON.stringify([{ schema_version: 2, descriptor_version: '' }]));
    let patched: string | null = null;
    const host = makeHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 'test' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patched = String(init.body);
          return new Response(JSON.stringify([{ id: 1 }]));
        }
        return applied(input as never, init as never);
      }) as typeof globalThis.fetch,
    });

    expect(await host.run('upgrade', '--verify')).toBe(0);
    expect(host.stdout()).toContain('verified: stet_meta reports schema_version 2');
    expect(host.stdout()).toContain('descriptor_version: stamped (1)');
    expect(patched).toContain('"descriptor_version":"1"');
  });

  it('--verify refuses a database that has only walked as far as 001', async () => {
    // The upgrade path every existing install walks: 001 is in, 002 is not, and
    // "verified" would be a lie the seed step would then build on.
    const host = makeHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 'test' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: fakeFetch(JSON.stringify([{ schema_version: 1, descriptor_version: '' }])),
    });
    expect(await host.run('upgrade', '--verify')).toBe(1);
    expect(host.stderr()).toContain(
      'stet_meta still reports schema_version 1: migration 2 has not been applied',
    );
  });

  it('--store writes the migration into the repo and prints the config block', async () => {
    const host = makeHost({
      config: {},
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 'test' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: noMeta,
    });
    expect(await host.run('upgrade', '--store', 'postgrest')).toBe(0);
    expect(host.file('stet/migrations/001_content_cms.sql')).toContain('create table content_versions');
    expect(host.file('stet/migrations/002_changesets.sql')).toContain('create table changesets');
    expect(host.stdout()).toContain('"adapter": "postgrest"');
    expect(host.stdout()).toContain('"urlEnv": "STET_POSTGREST_URL"');
    // It never edits the config itself.
    expect(host.file('stet.config.json')).not.toContain('postgrest');
  });

  it('regenerates the registry and reports it unchanged on a second run', async () => {
    const host = makeHost({ config: {} });
    rmSync(join(host.cwd, 'content/keys.ts'));
    expect(await host.run('upgrade')).toBe(0);
    expect(host.stdout()).toContain('content/keys.ts: regenerated');

    const again = makeHost({ config: {} });
    expect(await again.run('upgrade')).toBe(0);
    expect(again.stdout()).toContain('content/keys.ts: unchanged');
  });
});

describe('dispatch', () => {
  it('answers 2 for a usage mistake and 2 for no command at all', async () => {
    const host = makeHost();
    expect(await host.run()).toBe(2);
    expect(await host.run('nonsense')).toBe(2);
    expect(host.stderr()).toContain('unknown command: nonsense');
    expect(await host.run('list', '--nope')).toBe(2);
    expect(await host.run('get')).toBe(2);
  });

  it('takes a positional argument — strict parsing alone would reject it', async () => {
    const host = makeHost();
    expect(await host.run('get', 'hero_headline')).toBe(0);
  });

  it('help names the dash-leading-value ambiguity', async () => {
    const host = makeHost();
    expect(await host.run('help')).toBe(0);
    expect(host.stdout()).toContain('--value=-5');
  });

  it('hook is two-token: a bare or wrong subcommand is a usage error', async () => {
    const host = makeHost();
    expect(await host.run('hook')).toBe(2);
    expect(host.stderr()).toContain('stet hook install');
    expect(await host.run('hook', 'uninstall')).toBe(2);
    expect(host.stderr()).toContain('got "uninstall"');
  });

  it('import is a named, declined fast-follow — not "unknown command"', async () => {
    const host = makeHost();
    expect(await host.run('import')).toBe(2);
    expect(host.stderr()).toContain('fast-follow');
    expect(host.stderr()).not.toContain('unknown command');
  });

  it('help lists the Setup command group', async () => {
    const host = makeHost();
    expect(await host.run('help')).toBe(0);
    expect(host.stdout()).toContain('Setup');
    for (const c of ['init', 'scan', 'register', 'eject', 'hook install']) {
      expect(host.stdout()).toContain(c);
    }
  });
});

/**
 * The stage-5 fix round. Each case here is a defect the review reproduced from
 * outside the workspace, pinned so it cannot come back — plus the repairs for
 * three assertions that passed against a mutant.
 */
describe('the packed install and the host repo', () => {
  it('constructs no pg adapter until a pg store is actually configured', async () => {
    // The lazy import is what keeps `check` — and every other command — alive
    // on the default install, where the optional `pg` peer is absent. Proven
    // here structurally; the packed-tarball proof is scripts/scratch-install.
    const source = readFileSync(new URL('../cli/store.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import .*store-pg/m);
    expect(source).toContain("await import('../adapters/store-pg.js')");
    const meta = readFileSync(new URL('../cli/meta.ts', import.meta.url), 'utf8');
    expect(meta).not.toMatch(/^import .*store-pg/m);

    // A snapshot-only project never reaches the loader at all.
    const host = makeHost({ config: {} });
    expect(await host.run('check')).toBe(0);
  });

  it('bounds a connection attempt rather than waiting out the TCP stack', async () => {
    const { poolConfig } = await import('../adapters/store-pg.js');
    const config = poolConfig({ connectionString: 'postgresql://unused/none', connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    expect(config.connectionTimeoutMillis).toBe(5_000);
    expect(config.allowExitOnIdle).toBe(true);
    // `cli/store.ts` is the caller that must pass it: a black-holed host would
    // otherwise wait out ~75 seconds before a degrade or a refusal arrives.
    // (End to end against a real black-holed address: tests/cli.live.test.ts.)
    expect(readFileSync(new URL('../cli/store.ts', import.meta.url), 'utf8')).toContain(
      'connectionTimeoutMillis: CONNECT_TIMEOUT_MS',
    );
  });

  it('refuses to overwrite a host-edited migration, and writes nothing when it does', async () => {
    const env = { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' };
    const noMeta = fakeFetch(JSON.stringify({ code: 'PGRST205' }), 404);

    // absent → write
    const fresh = makeHost({ config: {}, env, store: createMemoryStore({ project: 'default' }), fetchImpl: noMeta });
    expect(await fresh.run('upgrade', '--store', 'postgrest')).toBe(0);
    expect(fresh.stdout()).toContain('wrote stet/migrations/001_content_cms.sql');
    expect(fresh.stdout()).toContain('wrote stet/migrations/002_changesets.sql');
    const shipped = fresh.file('stet/migrations/001_content_cms.sql');
    const shipped2 = fresh.file('stet/migrations/002_changesets.sql');

    // identical → skip
    const again = makeHost({ config: {}, env, store: createMemoryStore({ project: 'default' }), fetchImpl: noMeta });
    writeFileSync(join(again.cwd, 'stet.config.json'), '{}');
    mkdirSync(join(again.cwd, 'stet/migrations'), { recursive: true });
    writeFileSync(join(again.cwd, 'stet/migrations/001_content_cms.sql'), shipped);
    writeFileSync(join(again.cwd, 'stet/migrations/002_changesets.sql'), shipped2);
    expect(await again.run('upgrade', '--store', 'postgrest')).toBe(0);
    expect(again.stdout()).toContain('already present, identical');
    expect(again.stdout()).not.toContain('wrote stet/migrations/');

    // differs → refuse by name, and nothing at all is written
    const edited = makeHost({ config: {}, env, store: createMemoryStore({ project: 'default' }), fetchImpl: noMeta });
    mkdirSync(join(edited.cwd, 'stet/migrations'), { recursive: true });
    writeFileSync(
      join(edited.cwd, 'stet/migrations/001_content_cms.sql'),
      `${shipped}\n-- a grant this host needs\n`,
    );
    expect(await edited.run('upgrade', '--store', 'postgrest')).toBe(1);
    expect(edited.stderr()).toContain('refusing to overwrite stet/migrations/001_content_cms.sql');
    expect(edited.file('stet/migrations/001_content_cms.sql')).toContain('a grant this host needs');
    // All-or-nothing across the whole file set: the untouched second migration
    // is not written either, so a refusal never leaves a half-emitted install.
    expect(existsSync(join(edited.cwd, 'stet/migrations/002_changesets.sql'))).toBe(false);
  });

  it('names the repo copy and the configured variable, never a node_modules path', async () => {
    const host = makeHost({
      config: { store: { adapter: 'postgrest', urlEnv: 'MY_PGRST_URL' } },
      env: { MY_PGRST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: fakeFetch(JSON.stringify({ code: 'PGRST205' }), 404),
    });
    expect(await host.run('upgrade')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('psql "$MY_PGRST_URL" -f stet/migrations/');
    expect(output).not.toContain('node_modules');
    // The follow-ups end in order: verify, then seed.
    expect(output.indexOf('stet upgrade --verify')).toBeLessThan(output.indexOf('stet seed'));
  });

  it('prints tokenEnv in the block a PostgREST install pastes', async () => {
    const host = makeHost({
      config: {},
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: fakeFetch(JSON.stringify({ code: 'PGRST205' }), 404),
    });
    expect(await host.run('upgrade', '--store', 'postgrest')).toBe(0);
    expect(host.stdout()).toContain('"tokenEnv": "STET_POSTGREST_TOKEN"');
  });

  it('reports a database written by a newer stet instead of calling it up to date', async () => {
    const host = makeHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: fakeFetch(JSON.stringify([{ schema_version: 9, descriptor_version: '1' }])),
    });
    expect(await host.run('upgrade')).toBe(0);
    expect(host.stderr()).toContain('older than the database');
    expect(host.stdout()).not.toContain('up to date');
  });

  it('keeps the report when a later step fails after DDL already ran', async () => {
    // The stamp throws after a successful read: everything up to it is still
    // reported, and the failure joins the report rather than a stack trace.
    let call = 0;
    const host = makeHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH') throw new TypeError('fetch failed: connection reset mid-stamp');
        call += 1;
        return new Response(JSON.stringify([{ schema_version: 2, descriptor_version: '' }]));
      }) as typeof globalThis.fetch,
    });
    expect(await host.run('upgrade', '--verify')).toBe(1);
    expect(call).toBeGreaterThan(0);
    expect(host.stdout()).toContain('verified: stet_meta reports schema_version 2');
    expect(host.stderr()).toContain('connection reset mid-stamp');
    expect(host.stderr()).not.toContain('    at ');
  });

  it('ends a pool it opened and never one it was handed', async () => {
    const inner = createMemoryStore({ project: 'default' });
    let ended = 0;
    const injected = { ...inner, end: async () => { ended += 1; } };
    const host = makeHost({ store: injected });
    expect(await host.run('list')).toBe(0);
    expect(await host.run('get', 'hero_headline')).toBe(0);
    // An injected store belongs to its caller — `stet mcp` and the tests hand
    // the same one to many calls and would lose it after the first.
    expect(ended).toBe(0);
  });
});

describe('pull, per the amended locale contract', () => {
  function withDe(host: Host): void {
    writeFileSync(
      join(host.cwd, 'stet.config.json'),
      JSON.stringify({ store: { adapter: 'memory' }, locales: { default: 'default', enabled: ['default', 'de'] } }),
    );
  }

  it('an enabled locale is never inflated by fallback', async () => {
    const store = createMemoryStore({ project: 'default' });
    const seeded = makeHost({ store });
    await seeded.run('draft', 'hero_headline', '--value=Verpasse nichts.', '--editor', 'neil', '--locale', 'de');
    await seeded.run('publish', 'hero_headline', '--editor', 'neil', '--locale', 'de');
    await seeded.run('draft', 'hero_body', '--value=Only at default', '--editor', 'neil');
    await seeded.run('publish', 'hero_body', '--editor', 'neil');

    const host = makeHost({ store });
    withDe(host);
    expect(await host.run('pull')).toBe(0);

    const written = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    // The de block holds its one real translation plus what it already carried
    // — and NOT the twenty other keys the fallback chain would have answered.
    expect(written['de']).toEqual({ hero_headline: 'Verpasse nichts.' });
    expect(written['de']?.['hero_body']).toBeUndefined();
    // The default block is written in full, as the floor everything falls to.
    expect(written['default']?.['hero_body']).toBe('Only at default');

    const bundle = readBundle(JSON.parse(host.file('.stet/bundle.json')));
    expect(Object.keys(bundle.values['de'] ?? {})).toEqual(['hero_headline']);
    expect(bundle.meta?.['de']?.['hero_headline']).toEqual({ version: 1 });
    // A consumer still reads a de page whole: the chain answers what the block
    // does not, which is exactly what inflating it would have destroyed.
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(resolveFromBundle(descriptor, bundle, { key: 'hero_body', locale: 'de' }).value).toBe('Only at default');
  });

  it('does not stamp a version for a value the store did not serve', async () => {
    const store = createMemoryStore({ project: 'default' });
    // An active row whose value fails its declared shape: resolution
    // quarantines it and serves the snapshot, so the row must not stamp meta
    // for a value that did not come from it.
    store.seed([{ key: 'brand__primary', value: 'rebeccapurple', target: 'web' }]);
    const host = makeHost({ store });
    expect(await host.run('pull')).toBe(0);

    const bundle = readBundle(JSON.parse(host.file('.stet/bundle.json')));
    expect(bundle.values['default']?.['brand__primary']).toBe('#1d4ed8');
    expect(bundle.meta?.['default']?.['brand__primary']).toBeUndefined();
  });

  it('warns about a shape-invalid committed value it passes through', async () => {
    const host = makeHost({ store: createMemoryStore({ project: 'default' }) });
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    snapshot['default']!['brand__primary'] = 'rebeccapurple';
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));

    expect(await host.run('pull')).toBe(0);
    // Preserved, not dropped — pull mirrors, check enforces — and said aloud.
    expect(JSON.parse(host.file('content/defaults.json'))['default']['brand__primary']).toBe('rebeccapurple');
    expect(host.stderr()).toContain('brand__primary');
    expect(host.stderr()).toContain('quarantine at read time');
  });

  it('canonicalizes: key order in the source file cannot change the output', async () => {
    const store = createMemoryStore({ project: 'default' });
    const ordered = makeHost({ store });
    expect(await ordered.run('pull')).toBe(0);
    const canonical = ordered.file('content/defaults.json');

    const reversed = makeHost({ store });
    const snapshot = JSON.parse(reversed.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    const flipped: Record<string, Record<string, unknown>> = {};
    for (const locale of Object.keys(snapshot).reverse()) {
      const block: Record<string, unknown> = {};
      for (const key of Object.keys(snapshot[locale] ?? {}).reverse()) block[key] = snapshot[locale]?.[key];
      flipped[locale] = block;
    }
    writeFileSync(join(reversed.cwd, 'content/defaults.json'), JSON.stringify(flipped, null, 2));

    expect(await reversed.run('pull')).toBe(0);
    // Deep sorting is what makes this true; a top-level-only sort would leave
    // the reversed key order inside each locale block intact.
    expect(reversed.file('content/defaults.json')).toBe(canonical);
  });
});

describe('seed and audit, judged at the default locale', () => {
  it('seeds a key that holds rows only in another locale', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.seed([{ key: 'hero_headline', value: 'Verpasse nichts.', locale: 'de', target: 'web' }]);

    const host = makeHost({ store });
    expect(await host.run('seed')).toBe(0);
    // The model is key×locale: a `de` row leaves the key unwritable at default,
    // and a key-scoped skip would have called that done.
    const atDefault = store.dump().filter((r) => r.key === 'hero_headline' && r.locale === 'default');
    expect(atDefault).toHaveLength(1);
    expect(atDefault[0]?.value).toBe('Never miss a post again.');
    expect(atDefault[0]?.editor).toBe('stet:seed');
  });

  it('audit reports a key with no row at the default locale', async () => {
    const store = createMemoryStore({ project: 'default' });
    store.seed([{ key: 'hero_headline', value: 'Verpasse nichts.', locale: 'de', target: 'web' }]);
    const host = makeHost({ store });

    expect(await host.run('audit', '--json')).toBe(0);
    expect(host.json<{ unseeded: string[] }>().unseeded).toContain('hero_headline');
  });
});

describe('argument handling', () => {
  it('a repeated --editor is a usage error, never a silent last-wins', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    expect(
      await host.run('draft', 'hero_headline', '--value=x', '--editor', 'neil', '--editor', 'agent:claude'),
    ).toBe(2);
    expect(host.stderr()).toContain('--editor was given 2 times');
    expect(store.dump()).toHaveLength(0);
  });

  it('reads --value-file from an absolute path', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeHost({ store });
    const absolute = join(host.cwd, 'copy.txt');
    writeFileSync(absolute, 'From an absolute path');
    expect(await host.run('draft', 'hero_headline', '--value-file', absolute, '--editor', 'neil')).toBe(0);
    expect(store.dump().find((r) => r.key === 'hero_headline')?.value).toBe('From an absolute path');
  });

  it('substitutes control bytes on the line channel and leaves the wire byte-faithful', async () => {
    // The demonstrated attack: a store-controlled record FIELD NAME reaches a
    // finding message through the entry path, so an escape sequence inside it
    // would repaint the operator's terminal on the way out.
    // Built rather than typed: a literal control byte in source is invisible
    // to a reader and to a patch. ESC opens a CSI sequence; U+009B is the C1
    // CSI that opens the same sequence in one character; U+202E is the bidi
    // override that makes a terminal display a different name than the one
    // the finding actually carries.
    const ESC = String.fromCharCode(0x1b);
    const C1_CSI = String.fromCharCode(0x9b);
    const RLO = String.fromCharCode(0x202e);
    const field = `na${ESC}[2K${ESC}[1G${C1_CSI}31m${RLO}me`;
    const poisoned = (host: Host) => {
      const snapshot = JSON.parse(host.file('content/defaults.json'));
      snapshot.default.contact_form_labels = { [field]: 'Ask {{nope}}' };
      writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2));
    };

    const human = makeHost({ config: {} });
    poisoned(human);
    expect(await human.run('check')).toBe(1);
    expect(human.stderr()).toContain('contact_form_labels.na');
    expect(human.stderr()).toContain('\uFFFD');
    expect(human.stderr()).not.toContain('\u001b');
    expect(human.stderr()).not.toContain('\u009b');
    expect(human.stderr()).not.toContain('\u202e');

    // `--json` is the data channel, and it carries what was stored: the bytes
    // survive the wire because `JSON.stringify` escapes them, and a consumer
    // that re-prints decoded content raw crosses the boundary in its own
    // terminal.
    const wire = makeHost({ config: {} });
    poisoned(wire);
    expect(await wire.run('check', '--json')).toBe(1);
    const answer = wire.json<{ findings: Array<{ message: string }> }>();
    const undeclared = answer.findings.find((f) => f.message.includes('undeclared variable'));
    expect(undeclared?.message).toContain(field);
  });

  it('check --json carries the counts its human output states', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('check', '--json')).toBe(0);
    const answer = host.json<{
      snapshot: { declared: number; missing: string[]; stale: string[] };
      values: { checked: number };
      generated: Record<string, string>;
    }>();
    expect(answer.snapshot.declared).toBe(25);
    expect(answer.snapshot.missing).toEqual([]);
    // Fewer than declared: the two derived keys carry no committed value, and
    // `de` contributes one of its own.
    expect(answer.values.checked).toBe(24);
    expect(answer.generated['content/keys.ts']).toBe('current');
  });

  it('doctor --json --report carries the pasteable block', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('doctor', '--json', '--report')).toBe(0);
    const answer = host.json<{ report: string }>();
    expect(answer.report).toContain('```');
    expect(answer.report).toMatch(/stet \d+\.\d+\.\d+ · node v/);
  });
});

describe('environments', () => {
  /** A project with one declared environment beside the bare store block. */
  const TWO = {
    store: { adapter: 'memory' },
    environments: { staging: { adapter: 'memory' } },
  };

  it('rejects a "default" key by name — the bare store block already is it', async () => {
    const host = makeHost({ config: { environments: { default: { adapter: 'memory' } } } });
    expect(await host.run('list')).toBe(1);
    expect(host.stderr()).toContain('must not declare "default"');
    expect(host.stderr()).toContain('the bare store block IS the default environment');
  });

  it('rejects an unusable environment name — the map keys are an input too', async () => {
    const blank = makeHost({ config: { environments: { '  ': { adapter: 'memory' } } } });
    expect(await blank.run('list')).toBe(1);
    expect(blank.stderr()).toContain('is not a usable environment name');

    // A dash-leading name could never be typed: `--env -staging` parses as an
    // option, not as this environment.
    const dashed = makeHost({ config: { environments: { '-staging': { adapter: 'memory' } } } });
    expect(await dashed.run('list')).toBe(1);
    expect(dashed.stderr()).toContain('leading dash');
  });

  it('names the block an environments entry got wrong, not just "store"', async () => {
    const host = makeHost({ config: { environments: { staging: { adapter: 'postgres' } } } });
    expect(await host.run('list')).toBe(1);
    expect(host.stderr()).toContain('environments.staging.adapter must be one of:');
  });

  it('a typo exits 2 listing the declared names, before any store is consulted', async () => {
    // The store is INJECTED and available: selection still validates first, so
    // a typo cannot ride an injected adapter past the check and land on a real
    // database.
    const store = counting(createMemoryStore({ project: 'default' }));
    const host = makeHost({ config: TWO, store });
    expect(await host.run('publish', 'hero_headline', '--env', 'prdo', '--editor', 'neil')).toBe(2);
    expect(host.stderr()).toContain('prdo');
    expect(host.stderr()).toContain('staging');
    expect(store.calls).toEqual([]);

    // The none-declared variant says so rather than listing an empty set.
    const bare = makeHost({ store: counting(createMemoryStore({ project: 'default' })) });
    expect(await bare.run('audit', '--env', 'prod')).toBe(2);
    expect(bare.stderr()).toContain('no environments are declared');
  });

  it('two environments are two databases: the same key, two independent rows', async () => {
    const dflt = createMemoryStore({ project: 'default' });
    const staging = createMemoryStore({ project: 'default' });
    const stores = { default: dflt, staging };

    const seeded = makeHost({ config: TWO, stores });
    expect(await seeded.run('seed')).toBe(0);

    // The default environment has history; staging was never touched by it.
    expect(dflt.dump().length).toBeGreaterThan(0);
    expect(staging.dump()).toEqual([]);

    const here = makeHost({ config: TWO, stores });
    expect(await here.run('list', '--json')).toBe(0);
    expect(here.json<{ rows: { key: string; source: string }[] }>().rows.find((r) => r.key === 'hero_headline')?.source).toBe('active');

    const there = makeHost({ config: TWO, stores });
    expect(await there.run('list', '--env', 'staging', '--json')).toBe(0);
    // Same command, same descriptor, same snapshot — a different connection, so
    // every key falls back to the committed copy.
    expect(there.json<{ rows: { key: string; source: string }[] }>().rows.find((r) => r.key === 'hero_headline')?.source).toBe('snapshot');

    // And a write lands in the selected one alone.
    const write = makeHost({ config: TWO, stores });
    expect(await write.run('draft', 'hero_headline', '--value=Only on staging', '--editor', 'neil', '--env', 'staging')).toBe(0);
    expect(staging.dump().find((r) => r.key === 'hero_headline')?.value).toBe('Only on staging');
    expect(dflt.dump().find((r) => r.key === 'hero_headline')?.value).not.toBe('Only on staging');
  });

  it('names the environment exactly when it is not the default one', async () => {
    const stores = {
      default: createMemoryStore({ project: 'default' }),
      staging: createMemoryStore({ project: 'default' }),
    };

    const selected = makeHost({ config: TWO, stores });
    expect(await selected.run('list', '--env', 'staging')).toBe(0);
    expect(selected.stdout()).toContain('environment: staging');

    // A default run reads exactly as it always did.
    const plain = makeHost({ config: TWO, stores });
    expect(await plain.run('list')).toBe(0);
    expect(plain.stdout()).not.toContain('environment:');

    // Explicitly selecting the default one is still a default run.
    const explicit = makeHost({ config: TWO, stores });
    expect(await explicit.run('list', '--env', 'default')).toBe(0);
    expect(explicit.stdout()).not.toContain('environment:');

    // The line rides the report, so `--json` is still ONE parseable object —
    // a raw stdout line beside it would make the whole output unparseable.
    const json = makeHost({ config: TWO, stores });
    expect(await json.run('list', '--env', 'staging', '--json')).toBe(0);
    const parsed = JSON.parse(json.stdout()) as { environment?: string; rows: unknown[] };
    expect(parsed.environment).toBe('staging');
    expect(parsed.rows.length).toBeGreaterThan(0);

    const plainJson = makeHost({ config: TWO, stores });
    expect(await plainJson.run('list', '--json')).toBe(0);
    expect('environment' in (JSON.parse(plainJson.stdout()) as object)).toBe(false);

    // `get` stays scriptable: the value is still the last line of stdout.
    const scripted = makeHost({ config: TWO, stores });
    expect(await scripted.run('get', 'hero_headline', '--env', 'staging')).toBe(0);
    expect(scripted.out.at(-1)).toBe('Never miss a post again.');
  });

  it('check refuses --env in both spellings, teaching the offline contract', async () => {
    const spaced = makeHost({ config: TWO });
    expect(await spaced.run('check', '--env', 'staging')).toBe(2);
    expect(spaced.stderr()).toContain('offline by contract');

    // The joined form is one token: `includes('--env')` never sees it, which is
    // why the pre-check tests both.
    const joined = makeHost({ config: TWO });
    expect(await joined.run('check', '--env=staging')).toBe(2);
    expect(joined.stderr()).toContain('offline by contract');
    // Not the parser's own message, which would teach the wrong fix — that the
    // flag is misplaced rather than that the command has no store at all.
    expect(joined.stderr()).not.toContain('Unknown option');
  });

  it('doctor lists the declared environments and marks the selected one', async () => {
    const stores = {
      default: createMemoryStore({ project: 'default' }),
      staging: createMemoryStore({ project: 'default' }),
    };
    const host = makeHost({ config: TWO, stores });
    expect(await host.run('doctor', '--env', 'staging')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('environments:');
    expect(output).toContain('default (memory)');
    expect(output).toContain('staging (memory) ← selected');

    const none = makeHost({ config: {} });
    expect(await none.run('doctor')).toBe(0);
    expect(none.stdout()).toContain('environments: none declared');

    // The pasteable block carries the selection too: `store: memory` under a
    // `--env` the block does not mention sends a triager at the wrong database.
    const pasted = makeHost({
      config: { store: { adapter: 'memory' }, environments: { b: { adapter: 'snapshot' } } },
      stores,
    });
    expect(await pasted.run('doctor', '--json', '--report', '--env', 'b')).toBe(0);
    const answer = pasted.json<{ report: string; environment: string }>();
    expect(answer.environment).toBe('b');
    expect(answer.report).toContain('environment: b');
    expect(answer.report).toContain('store: snapshot');
  });

  it('doctor diagnoses a selected environment whose variable is unset, never dies on it', async () => {
    // The posture it holds for the default block, held for a selected one: the
    // command whose job is to report a broken connection must not die on one.
    const host = makeHost({
      config: { store: { adapter: 'memory' }, environments: { b: { adapter: 'pg', urlEnv: 'STET_B_URL' } } },
      env: {},
    });
    expect(await host.run('doctor', '--env', 'b')).toBe(0);
    expect(host.stdout()).toContain('environment: b');
    // The SELECTED block is what it reports — pg, not the default block's memory.
    expect(host.stdout()).toContain('store: configured (pg), MISCONFIGURED');
    expect(host.stderr()).toContain('STET_B_URL');
    // Diagnosis continued past the store section rather than stopping there.
    expect(host.stdout()).toContain('generated: content/keys.ts current');
  });

  it('pull from a non-default environment warns, naming the source, and still writes', async () => {
    const staging = createMemoryStore({ project: 'default' });
    const seed = makeHost({ config: TWO, stores: { staging } });
    await seed.run('draft', 'hero_headline', '--value=Staging wording', '--editor', 'neil', '--env', 'staging');
    await seed.run('publish', 'hero_headline', '--editor', 'neil', '--env', 'staging');

    const host = makeHost({ config: TWO, stores: { staging } });
    // Deliberate and warned, never refused: refusing would break the symmetry
    // with the `pull --env prod` release step.
    expect(await host.run('pull', '--env', 'staging')).toBe(0);
    expect(host.stderr()).toContain('staging environment');
    expect(host.stderr()).toContain('read the git diff before committing');
    expect(host.file('content/defaults.json')).toContain('Staging wording');

    // A default pull says nothing of the kind.
    const plain = makeHost({ config: TWO, stores: { default: createMemoryStore({ project: 'default' }) } });
    expect(await plain.run('pull')).toBe(0);
    expect(plain.stderr()).toBe('');
  });

  it('upgrade --store must agree with the selected environment, and names its variable', async () => {
    const config = {
      store: { adapter: 'memory' },
      environments: { b: { adapter: 'postgrest', urlEnv: 'B_PGRST_URL', tokenEnv: 'B_PGRST_TOKEN' } },
    };
    const env = { B_PGRST_URL: 'http://b.postgrest.test', B_PGRST_TOKEN: 't' };
    const noMeta = fakeFetch(JSON.stringify({ code: 'PGRST205' }), 404);

    // Selection wins: an adapter that contradicts it is a usage error naming both.
    const clash = makeHost({ config, env, store: createMemoryStore({ project: 'default' }), fetchImpl: noMeta });
    expect(await clash.run('upgrade', '--store', 'pg', '--env', 'b')).toBe(2);
    expect(clash.stderr()).toContain('--store pg');
    expect(clash.stderr()).toContain('--env b');
    expect(clash.stderr()).toContain('postgrest');

    // Agreeing runs against the SELECTED block: the pasteable config names the
    // environment, and the apply instructions name that database's variable.
    const host = makeHost({ config, env, store: createMemoryStore({ project: 'default' }), fetchImpl: noMeta });
    expect(await host.run('upgrade', '--store', 'postgrest', '--env', 'b')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('environment: b');
    expect(output).toContain('"environments"');
    expect(output).toContain('"B_PGRST_URL"');
    expect(output).toContain('psql "$B_PGRST_URL" -f stet/migrations/');
    expect(output).not.toContain('STET_POSTGREST_URL');
    // The migration files are the package's, not a connection's.
    expect(host.file('stet/migrations/001_content_cms.sql')).toContain('create table content_versions');
    expect(host.file('stet/migrations/002_changesets.sql')).toContain('create table changesets');
  });
});

/**
 * `constructor` is the ONE prototype name the descriptor's key grammar admits
 * (`^[a-z0-9]+(?:_{1,2}[a-z0-9]+)*$`), so every membership test over a
 * JSON-parsed key map has to be an own-property test. A bare `in` or a bare
 * index answers it from `Object.prototype`, and each of these four commands
 * then behaved as though an undeclared key were declared — differently, and
 * none of them safely.
 */
describe('key membership is an own-property test', () => {
  it('get and diff refuse it rather than printing a phantom', async () => {
    // `get` exited 0 printing a BLANK line — resolution read
    // `Object.prototype.constructor` and the printer stringified undefined.
    const get = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await get.run('get', 'constructor')).toBe(1);
    expect(get.stderr()).toContain('"constructor" is not a key in content/descriptor.json');
    expect(get.stdout()).toBe('');

    // `diff` exited 0 printing a whole phantom entry. One swap serves both:
    // `known` is the gate each of them calls.
    const diff = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await diff.run('diff', 'constructor')).toBe(1);
    expect(diff.stderr()).toContain('"constructor" is not a key in content/descriptor.json');
    expect(diff.stdout()).toBe('');
  });

  it('draft refuses it instead of crashing on a shape it cannot read', async () => {
    // This form, not `--value=x`: a text-shaped parse exits 2 on a usage message
    // before the gate is reached. With JSON, the bare index handed `shapeSchema`
    // a definition with no `shape`, which fell past every switch arm and escaped
    // runCli's catch as a raw TypeError.
    const host = makeHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await host.run('draft', 'constructor', '--value={"a":1}', '--editor', 'neil')).toBe(1);
    expect(host.stderr()).toContain('"constructor" is not a key in content/descriptor.json');
  });

  it('publish refuses it before any RPC reaches the store', async () => {
    // The exit code alone proved nothing here: the run already exited 1, on the
    // store's `no_draft` answer to a REAL publish call for an undeclared key.
    const store = counting(createMemoryStore({ project: 'default' }));
    const host = makeHost({ store });
    expect(await host.run('publish', 'constructor', '--editor', 'neil')).toBe(1);
    expect(host.stderr()).toContain('"constructor" is not a key in content/descriptor.json');
    expect(store.calls).toEqual([]);
  });

  it('audit counts a `constructor`-keyed row as the orphan it is', async () => {
    // The row was invisible: the orphan filter asked whether the descriptor
    // declared it, and the prototype said yes.
    const store = createMemoryStore({ project: 'default' });
    store.seed([{ key: 'constructor', value: 'an orphan row', target: 'web' }]);
    const host = makeHost({ store });
    expect(await host.run('audit', '--json')).toBe(0);
    expect(host.json<{ orphans: string[] }>().orphans).toEqual(['constructor']);
    // `--json` carries the findings inside the object rather than on stderr, so
    // the human channel is read from a plain run.
    const before = host.err.length;
    expect(await host.run('audit')).toBe(0);
    expect(host.err.slice(before).join('\n')).toContain(
      'constructor: in the store, not in the descriptor — an orphan, reported never deleted',
    );
  });
});

describe('the static-HTML host — check', () => {
  /** The key whose default is exactly `value`, read off the adopted host. */
  function keyFor(host: Host, value: string): string {
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    const found = Object.entries(snapshot.default).find(([, v]) => v === value);
    if (found === undefined) throw new Error(`no key holds ${JSON.stringify(value)}`);
    return found[0];
  }

  function editSnapshot(host: Host, key: string, value: string): void {
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    snapshot.default[key] = value;
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  it('walks every mark and reports the document current', async () => {
    const host = await makeHtmlHost({ register: true });
    expect(await host.run('check')).toBe(0);
    expect(host.stdout()).toContain('document: index.html current (28 marks)');
    // No codegen trio is checked, planned or named on this host.
    expect(host.stdout()).not.toContain('generated:');
    expect(host.exists('content/keys.ts')).toBe(false);
  });

  it('names both fixes when a page and its snapshot disagree, whichever side moved', async () => {
    const edited = await makeHtmlHost({ register: true });
    const key = keyFor(edited, 'Software, product and engineering histories');
    writeFileSync(
      join(edited.cwd, 'index.html'),
      edited.file('index.html').replace('Software, product and engineering histories', 'Something else entirely'),
    );
    expect(await edited.run('check')).toBe(1);
    const finding = `index.html:34 ${key} differs from the snapshot — run stet pull to apply the snapshot, or edit the snapshot to keep the page's text`;
    expect(edited.stderr()).toContain(finding);

    // The snapshot moving instead is the SAME observation, so it is the same line.
    const moved = await makeHtmlHost({ register: true });
    editSnapshot(moved, keyFor(moved, 'Software, product and engineering histories'), 'Something else entirely');
    expect(await moved.run('check')).toBe(1);
    expect(moved.stderr()).toContain(finding);
  });

  it('stays green over an unmarked run that shares its element with a comment', async () => {
    // `text-beside-code` is adoption scope: scan names it, the hook does not
    // fail on it, and nothing about it reaches the regenerator.
    const host = await makeHtmlHost({
      files: {
        'index.html':
          '<html><body><p>A paragraph stet adopts.</p>' +
          '<p>Hello <!-- note --> world</p></body></html>\n',
      },
    });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(host.stderr()).not.toContain('text-beside-code');
    expect(host.stdout()).toContain('document: index.html current (1 marks)');
  });

  it('reads a reindent as no change at all', async () => {
    const host = await makeHtmlHost({ register: true });
    writeFileSync(
      join(host.cwd, 'index.html'),
      host.file('index.html').replace(
        /(<h3 data-stet="[^"]*">)(Software, product and engineering histories)(<\/h3>)/,
        '$1\n        $2\n      $3',
      ),
    );
    expect(await host.run('check')).toBe(0);
    expect(host.stdout()).toContain('current (28 marks)');
  });

  it('names a mark that points at no declared key', async () => {
    const host = await makeHtmlHost({ register: true });
    writeFileSync(
      join(host.cwd, 'index.html'),
      host.file('index.html').replace('<h2 data-stet="', '<h2 data-stet="nope" x-data-stet="'),
    );
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain(
      'data-stet="nope" names no descriptor key — run stet register, or remove the mark',
    );
  });

  it('warns a declared key that no document marks, and stays green', async () => {
    const host = await makeHtmlHost({ register: true });
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as {
      version: number;
      keys: Record<string, unknown>;
    };
    descriptor.keys['orphan_key'] = { shape: 'text', target: 'web' };
    writeFileSync(join(host.cwd, 'content/descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
    editSnapshot(host, 'orphan_key', 'A value nothing renders');
    expect(await host.run('check')).toBe(0);
    expect(host.stderr()).toContain('orphan_key: marked in no document');
  });

  it('carries the per-document record in --json', async () => {
    const host = await makeHtmlHost({ register: true });
    expect(await host.run('check', '--json')).toBe(0);
    expect(host.json<{ documents: Record<string, { marks: number; status: string }> }>().documents).toEqual({
      'index.html': { marks: 28, status: 'current' },
    });
  });

  it('never fails on markup no mark touches, and always on markup one does', async () => {
    // An unknown entity and a bare run in a `<ul>`, both away from every mark:
    // markup stet does not manage is not stet's red, and the hook must not fail
    // a commit over it.
    const quiet = [
      '<html>',
      '<body>',
      '  <p data-stet="edge_intro">An ordinary marked paragraph.</p>',
      '  <p>An unknown &nosuch; entity sits here.</p>',
      '  <ul>',
      '    A bare run sits directly inside this list.',
      '    <li>An item that is a key element of its own.</li>',
      '  </ul>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
    const host = await makeHtmlHost({
      files: { 'index.html': quiet },
      keys: { edge_intro: { shape: 'text', target: 'web' } },
      defaults: { edge_intro: 'An ordinary marked paragraph.' },
    });
    expect(await host.run('check')).toBe(0);
    expect(host.stdout()).toContain('document: index.html current (1 marks)');

    const marked = await makeHtmlHost({
      files: {
        'index.html': quiet.replace('<p>An unknown &nosuch;', '<p data-stet="edge_broken">An unknown &nosuch;'),
      },
      keys: {
        edge_intro: { shape: 'text', target: 'web' },
        edge_broken: { shape: 'text', target: 'web' },
      },
      defaults: { edge_intro: 'An ordinary marked paragraph.', edge_broken: 'x' },
    });
    expect(await marked.run('check')).toBe(1);
    expect(marked.stderr()).toContain('skipped (unknown-entity)');
  });
});

describe('the static-HTML host — pull and upgrade', () => {
  function editSnapshot(host: Host, key: string, value: string): void {
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    snapshot.default[key] = value;
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  function keyFor(host: Host, value: string): string {
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    const found = Object.entries(snapshot.default).find(([, v]) => v === value);
    if (found === undefined) throw new Error(`no key holds ${JSON.stringify(value)}`);
    return found[0];
  }

  it('regenerates the documents from the snapshot, and says so', async () => {
    const host = await makeHtmlHost({ register: true });
    editSnapshot(host, keyFor(host, 'Software, product and engineering histories'), 'Engineering histories');
    expect(await host.run('pull')).toBe(0);
    expect(host.stdout()).toContain('wrote index.html');
    expect(host.file('index.html')).toContain('>Engineering histories<');
    // No defaults module is written on this host — there is none to write.
    expect(host.exists('content/defaults.ts')).toBe(false);
    expect(await host.run('check')).toBe(0);
  });

  it('says the documents are current and writes nothing on a second run', async () => {
    const host = await makeHtmlHost({ register: true });
    editSnapshot(host, keyFor(host, 'Imaging archives'), 'Imaging collections');
    expect(await host.run('pull')).toBe(0);
    const after = Buffer.from(host.file('index.html'), 'utf8');
    host.out.length = 0;
    expect(await host.run('pull')).toBe(0);
    expect(host.stdout()).toContain('pull: documents current');
    expect(Buffer.from(host.file('index.html'), 'utf8')).toEqual(after);
  });

  it('writes nothing at all when one document cannot be regenerated', async () => {
    const host = await makeHtmlHost({ register: true });
    const key = keyFor(host, 'You may already have the data<1> our AI lab partners need.</1>');
    editSnapshot(host, key, 'You may already have the data our AI lab partners need.');
    const snapshotBefore = Buffer.from(host.file('content/defaults.json'), 'utf8');
    const pageBefore = Buffer.from(host.file('index.html'), 'utf8');
    expect(await host.run('pull')).toBe(1);
    expect(host.stderr()).toContain(
      '1 document(s) could not be regenerated — index.html:25 tag-count-mismatch; nothing was written',
    );
    // Nothing half-written: the snapshot the run was about to canonicalise is
    // exactly as the operator left it, and so is the page.
    expect(Buffer.from(host.file('content/defaults.json'), 'utf8')).toEqual(snapshotBefore);
    expect(Buffer.from(host.file('index.html'), 'utf8')).toEqual(pageBefore);
  });

  it('has no registry to regenerate', async () => {
    const host = await makeHtmlHost({ register: true });
    expect(await host.run('upgrade', '--dry-run')).toBe(0);
    expect(host.stdout()).toContain(
      'codegen: none on an html host — the documents are regenerated by stet pull',
    );
    expect(host.exists('content/keys.ts')).toBe(false);
    expect(host.exists('content/stet-env.d.ts')).toBe(false);
  });
});

describe('the static-HTML host — entities as the source spells them', () => {
  it('adopts prose that spells `&amp;nosuch;` and writes it back byte-identically', async () => {
    const page =
      '<html><body><p>Use &amp;nosuch; literally in this sentence.</p></body></html>\n';
    const host = await makeHtmlHost({ files: { 'index.html': page } });
    // The entity test runs on the RAW text, so this is the literal text
    // `&nosuch;` and not an entity the table failed to decode.
    expect(await host.run('scan')).toBe(0);
    expect(host.stderr()).not.toContain('unknown-entity');
    host.out.length = 0;
    host.err.length = 0;

    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const snapshot = JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    expect(Object.values(snapshot.default)).toContain('Use &nosuch; literally in this sentence.');

    // Nothing normalises: the mark is the only byte the document gained.
    const marked = host.file('index.html');
    expect(marked).toContain('Use &amp;nosuch; literally in this sentence.');
    host.out.length = 0;
    expect(await host.run('pull')).toBe(0);
    expect(Buffer.from(host.file('index.html'), 'utf8').equals(Buffer.from(marked, 'utf8'))).toBe(true);
    expect(host.stdout()).toContain('pull: documents current');
  });

  it('still refuses a source that really spells an entity it cannot decode', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><p>An unknown &nosuch; entity.</p></body></html>\n' },
    });
    expect(await host.run('scan')).toBe(0);
    expect(host.stderr()).toContain('skipped (unknown-entity) — &nosuch; is not an entity stet can decode');
  });
});

describe('the static-HTML host — the stage-5 fold', () => {
  /** Every command that writes, run in turn over one adopted host. */
  async function everyWriteCommand(host: Awaited<ReturnType<typeof makeHtmlHost>>, key: string) {
    const codes: Record<string, number> = {};
    for (const argv of [
      ['check'],
      ['pull'],
      ['pages', 'scan', '--apply'],
      ['remove', key, '--write'],
      ['eject', '--write'],
    ] as const) {
      host.out.length = 0;
      host.err.length = 0;
      codes[argv.join(' ')] = await host.run(...argv);
    }
    return codes;
  }

  for (const value of ['', '19', '€19']) {
    it(`keeps every write command green when a value becomes ${JSON.stringify(value)}`, async () => {
      const host = await makeHtmlHost({
        files: { 'index.html': '<html><body><h3>Software product engineering</h3></body></html>\n' },
      });
      expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
      const snapshot = JSON.parse(host.file('content/defaults.json')) as { default: Record<string, string> };
      const key = Object.keys(snapshot.default)[0] as string;
      snapshot.default[key] = value;
      writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

      host.out.length = 0;
      host.err.length = 0;
      expect(await host.run('pull')).toBe(0);
      expect(host.file('index.html')).toContain(`<h3 data-stet="${key}">${value}</h3>`);
      // The mark is the declaration: an ordinary edit to a value cannot
      // un-declare it, so nothing downstream refuses the document.
      expect(await everyWriteCommand(host, key)).toEqual({
        check: 0,
        pull: 0,
        'pages scan --apply': 0,
        [`remove ${key} --write`]: 0,
        'eject --write': 0,
      });
    });
  }

  it('adopts prose carrying a literal placeholder and agrees with itself about it', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><p>See footnote <1> for the details.</p></body></html>\n' },
    });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const snapshot = JSON.parse(host.file('content/defaults.json')) as { default: Record<string, string> };
    expect(Object.values(snapshot.default)).toContain('See footnote <1> for the details.');

    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(await host.run('pull')).toBe(0);
    // The key declares no tags, so the `<1>` is prose and is escaped as prose.
    expect(host.file('index.html')).toContain('See footnote &lt;1&gt; for the details.');
    const after = host.file('index.html');
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toBe(after);
    expect(await host.run('check')).toBe(0);
    expect(await host.run('eject', '--write')).toBe(0);
  });

  it('names the same refusal in check that pull would raise', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><p data-stet="k">Hello <b>big</b> world</p></body></html>\n' },
      keys: { k: { shape: 'text', target: 'web' } },
      defaults: { k: 'Hello big world' },
    });
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain(
      'skipped (tag-count-mismatch) — the key declares no tags, the element has 1 descendant element(s); ' +
        'declare tags: 1 on the key and give the value its placeholders, or mark the elements inside it instead',
    );
    host.err.length = 0;
    expect(await host.run('pull')).toBe(1);
    expect(host.stderr()).toContain('tag-count-mismatch');
  });

  it('survives an entity reference that names no character, from init onward', async () => {
    const bare = bareHtmlHost({
      'index.html':
        '<html><body><p>Overflow test &#1114112; here</p><p>Surrogate &#xD800; test here</p></body></html>\n',
    });
    expect(await bare.run('init', '--yes')).toBe(0);
    expect(bare.exists('content/descriptor.json')).toBe(true);
    bare.out.length = 0;
    bare.err.length = 0;
    expect(await bare.run('scan')).toBe(0);
    expect(bare.stderr()).toContain('skipped (unknown-entity) — &#1114112; is not an entity stet can decode');
    expect(bare.stderr()).toContain('&#xD800; is not an entity stet can decode');
    bare.err.length = 0;
    // Adoption scope: the hook does not fail on unmarked prose.
    expect(await bare.run('check')).toBe(0);
  });

  it('refuses a document it cannot read, and writes nothing', async () => {
    const host = await makeHtmlHost({ register: true, files: { 'about.html': '<html><body><p>Beta paragraph text here</p></body></html>\n' } });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const before = host.file('index.html');
    chmodSync(join(host.cwd, 'about.html'), 0o000);
    try {
      host.out.length = 0;
      host.err.length = 0;
      expect(await host.run('check')).toBe(1);
      expect(host.stderr()).toContain('about.html: could not be read (EACCES) — fix its permissions, or remove it from the managed surfaces');
      host.err.length = 0;
      expect(await host.run('pull')).toBe(1);
      expect(host.file('index.html')).toBe(before);
    } finally {
      chmodSync(join(host.cwd, 'about.html'), 0o644);
    }
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
  });

  it('never adopts a run beside a CDATA section or a processing instruction', async () => {
    const host = await makeHtmlHost({
      files: {
        'index.html':
          '<html><body><div><![CDATA[ raw text here ]]>Hello there friend</div>' +
          '<div><?php echo $x; ?>Second run of text</div></body></html>\n',
      },
    });
    expect(await host.run('scan')).toBe(0);
    const found = host.stderr();
    expect(found).toContain(
      'skipped (text-beside-code) — text in <div> sits beside a script, style, comment or declaration stet cannot regenerate whole',
    );
    expect(found).not.toContain('propose key');
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    // Nothing was adopted, so the page keeps every byte it had.
    expect(host.file('index.html')).toContain('<![CDATA[ raw text here ]]>');
    expect(host.file('index.html')).toContain('<?php echo $x; ?>');
    expect(host.file('index.html')).not.toContain('data-stet');
  });

  it('keeps a literal non-breaking space through register, pull and check', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><p>1\u00a0000 members of the team</p></body></html>\n' },
    });
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const snapshot = JSON.parse(host.file('content/defaults.json')) as { default: Record<string, string> };
    expect(Object.values(snapshot.default)[0]).toBe('1\u00a0000 members of the team');
    const marked = host.file('index.html');
    host.out.length = 0;
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toBe(marked);
    expect(host.file('index.html')).toContain('1\u00a0000 members');
    expect(await host.run('check')).toBe(0);
  });

  it('closes its own loop over a padded value: pull once, then green and stable', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><p data-stet="k">Old text</p></body></html>\n' },
      keys: { k: { shape: 'text', target: 'web' } },
      // Not a fixed point of the read-back: the old splice targeted the trimmed
      // content span, so the trailing run landed outside it and was re-appended
      // on every pull — 199, 201, 203, 205, 207 bytes over five runs.
      defaults: { k: 'Padded  text   here  ' },
    });
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toContain('<p data-stet="k">Padded text here</p>');

    // check compares BOTH sides through the read-back form, so the value the
    // page renders is not a difference the operator is asked to act on.
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(host.stdout()).toContain('document: index.html current (1 marks)');

    const sizes = new Set<number>();
    for (let i = 0; i < 5; i++) {
      expect(await host.run('pull')).toBe(0);
      sizes.add(Buffer.byteLength(host.file('index.html'), 'utf8'));
    }
    expect(sizes.size).toBe(1);
    expect(await host.run('check')).toBe(0);
    // The snapshot keeps the operator's own spelling.
    const snapshot = JSON.parse(host.file('content/defaults.json')) as { default: Record<string, string> };
    expect(snapshot.default['k']).toBe('Padded  text   here  ');
  });

  it('refuses a mark on a void element through every command, and never grows the page', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><img src="a.png" data-stet="k"></body></html>\n' },
      keys: { k: { shape: 'text', target: 'web' } },
      defaults: { k: 'A lab bench' },
    });
    const before = host.file('index.html');
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain(
      'skipped (mark-on-non-key-element) — data-stet="k" sits on <img>, which has no content to hold text; ' +
        'mark a copy attribute with data-stet-<attr> instead',
    );
    host.err.length = 0;
    for (let i = 0; i < 3; i++) expect(await host.run('pull')).toBe(1);
    expect(host.file('index.html')).toBe(before);
  });

  it('leaves a marked <pre> alone and names why', async () => {
    const page = '<html><body><pre data-stet="k">line one\nline two\nline three</pre></body></html>\n';
    const host = await makeHtmlHost({
      files: { 'index.html': page },
      keys: { k: { shape: 'text', target: 'web' } },
      defaults: { k: 'line one line two line three' },
    });
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain(
      'data-stet="k" sits on <pre>, whose whitespace stet does not manage; mark the elements around it instead',
    );
    host.err.length = 0;
    expect(await host.run('pull')).toBe(1);
    // The three lines are still three lines.
    expect(host.file('index.html')).toBe(page);
  });

  it('round-trips a value padded with non-breaking spaces', async () => {
    const value = ' Lead and trail ';
    const host = await makeHtmlHost({
      files: { 'index.html': `<html><body><p data-stet="k">${value}</p></body></html>\n` },
      keys: { k: { shape: 'text', target: 'web' } },
      defaults: { k: value },
    });
    const before = host.file('index.html');
    expect(await host.run('check')).toBe(0);
    host.out.length = 0;
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toBe(before);
    expect(await host.run('check')).toBe(0);
  });

  it('names the key declaration, not the value, when the key declares no tags', async () => {
    const host = await makeHtmlHost({
      files: { 'index.html': '<html><body><div data-stet="k"><p>First para here.</p><p>Second para here.</p></div></body></html>\n' },
      keys: { k: { shape: 'text', target: 'web' } },
      defaults: { k: 'First para here. Second para here.' },
    });
    const wanted =
      'skipped (tag-count-mismatch) — the key declares no tags, the element has 2 descendant element(s); ' +
      'declare tags: 2 on the key and give the value its placeholders, or mark the elements inside it instead';
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain(wanted);
    host.err.length = 0;
    expect(await host.run('pull')).toBe(1);
    expect(host.stderr()).toContain('tag-count-mismatch');
  });

  it('strips a prototype-named mark and reports it, on both channels', async () => {
    const host = await makeHtmlHost({
      files: {
        'index.html':
          '<html><body><p data-stet="constructor">First run of text.</p>' +
          '<p data-stet="toString">Second run of text.</p></body></html>\n',
      },
    });
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('data-stet="constructor" names no descriptor key');
    expect(host.stderr()).toContain('data-stet="toString" names no descriptor key');
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('pull')).toBe(0);
    const page = host.file('index.html');
    expect(page).not.toContain('data-stet=');
    expect(page).toContain('First run of text.');
    expect(page).toContain('Second run of text.');
  });
});

describe('the static-HTML host — doctor and the usage', () => {
  it('names the host and the publish route, and tells a checkout outside git', async () => {
    const host = await makeHtmlHost({ register: true });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain(
      'host: html — the marked documents are the rendered form; publish = commit',
    );
    expect(host.stderr()).toContain('git: not a repository — publish cannot be a commit; run git init');
  });

  it('drops the git warn once the checkout is a repository', async () => {
    const host = await makeHtmlHost({ register: true, git: true });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stdout()).toContain('host: html —');
    expect(host.stderr()).not.toContain('git: not a repository');
  });

  it('warns a JavaScript snapshot-only host too, and names no host line', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stderr()).toContain('git: not a repository — publish cannot be a commit; run git init');
    expect(host.stdout()).not.toContain('host: html');
  });

  it('never warns a store-backed host — its publish is a store write', async () => {
    const host = makeHost({
      config: { store: { adapter: 'memory' } },
      store: createMemoryStore({ project: 'default' }),
    });
    expect(await host.run('doctor')).toBe(0);
    expect(host.stderr()).not.toContain('git: not a repository');
  });

  it('carries the host in the pasteable --report block', async () => {
    const host = await makeHtmlHost({ register: true, git: true });
    expect(await host.run('doctor', '--report')).toBe(0);
    expect(host.stdout()).toContain('host: html');
  });

  it('names --host html in the usage', async () => {
    const host = await makeHtmlHost();
    expect(await host.run('help')).toBe(0);
    expect(host.stdout()).toContain('init [--app DIR] [--host html] [--yes]');
  });
});

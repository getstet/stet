/**
 * `stet rename` (cli/rename.ts): a key moves to a new name in every repo form,
 * every read of it stet can prove, and every declared store — the store half
 * first, per key per environment, resumable from the pending record; then the
 * code half as one batch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryStore, type MemoryStore } from '../adapters/store-memory.js';
import { writeJsonDeterministic } from '../cli/artifacts.js';
import { runCli, type CliIo } from '../cli/main.js';
import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import type { StoreAdapter } from '../src/store.js';
import type { Descriptor } from '../src/types.js';
import type { Snapshot } from '../src/snapshot.js';
import { cleanupCliHosts, makeCliHost, makeHtmlHost, type CliHost } from '../conformance/cli-host.js';

/** A switch the backstop case turns on, and every batch `writePlanned` was handed. */
const control = vi.hoisted(() => ({ noProblems: false, planned: [] as string[][], stopAfter: null as number | null }));
vi.mock('../cli/key-plan.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cli/key-plan.js')>();
  return {
    ...real,
    planProblems: (...args: Parameters<typeof real.planProblems>) => (control.noProblems ? [] : real.planProblems(...args)),
  };
});
vi.mock('../cli/artifacts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cli/artifacts.js')>();
  return {
    ...real,
    writePlanned: (...args: Parameters<typeof real.writePlanned>) => {
      control.planned.push(args[0].map((p) => p.label));
      // A process killed inside the batch: the first `stopAfter` files land, one
      // at a time, and nothing puts them back.
      if (control.stopAfter !== null) {
        for (const plan of args[0].slice(0, control.stopAfter)) real.writePlanned([plan]);
        throw new Error('killed');
      }
      return real.writePlanned(...args);
    },
  };
});

afterAll(cleanupCliHosts);
beforeEach(() => {
  control.noProblems = false;
  control.planned.length = 0;
  control.stopAfter = null;
});

const bytesOf = (host: { cwd: string }, rels: string[]): Buffer[] => rels.map((rel) => readFileSync(join(host.cwd, rel)));
const sameBytes = (host: { cwd: string }, rels: string[], before: Buffer[]): void => {
  rels.forEach((rel, i) => expect(readFileSync(join(host.cwd, rel)).equals(before[i] as Buffer), rel).toBe(true));
};
const clear = (host: CliHost): void => {
  host.out.length = 0;
  host.err.length = 0;
};

// --- The static-HTML host ------------------------------------------------------

/** A page as 0.3.2 adopted psyon.ai: text-slug names, two of them opening with a digit. */
const MARKED = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <title data-stet="psyon_data_acquisition">Psyon data acquisition</title>',
  '  <meta property="og:description" content="You may already have the data. No raw data is needed to start." data-stet-content="you_may_already_have_the_data">',
  '</head>',
  '<body>',
  '  <h1 data-stet="you_may_already_have_the_data_2">You may already have the data.</h1>',
  '  <h3 data-stet="01_assess">01 Assess</h3>',
  '  <p data-stet="agreed_case_by_case_where_none_of_the">Agreed case by case where none of the above fits.</p>',
  '  <footer><p data-stet="2026_psyon_all_rights_reserved">© 2026 Psyon. All rights reserved.</p></footer>',
  '</body>',
  '</html>',
  '',
].join('\n');
const MARKED_KEYS = {
  psyon_data_acquisition: { shape: 'text', target: 'web' },
  you_may_already_have_the_data: {
    shape: 'text',
    target: 'web',
    derivesFrom: 'you_may_already_have_the_data_2',
    tmpl: '{v} No raw data is needed to start.',
  },
  you_may_already_have_the_data_2: { shape: 'text', target: 'web' },
  '01_assess': { shape: 'text', target: 'web' },
  agreed_case_by_case_where_none_of_the: { shape: 'text', target: 'web' },
  '2026_psyon_all_rights_reserved': { shape: 'text', target: 'web' },
};
const MARKED_VALUES = {
  psyon_data_acquisition: 'Psyon data acquisition',
  you_may_already_have_the_data_2: 'You may already have the data.',
  '01_assess': '01 Assess',
  agreed_case_by_case_where_none_of_the: 'Agreed case by case where none of the above fits.',
  '2026_psyon_all_rights_reserved': '© 2026 Psyon. All rights reserved.',
};
const FORMS = ['content/descriptor.json', 'content/defaults.json', 'index.html'];
const THREE = {
  plan: 'stet rename',
  version: 1,
  keys: [
    { old: '01_assess', key: 'home_process_step_1', label: 'Process step 1', help: "The first step's title in How it works." },
    { old: 'agreed_case_by_case_where_none_of_the', key: 'home_another_structure_body', label: null, help: null },
    {
      old: '2026_psyon_all_rights_reserved',
      key: 'home_footer_copyright',
      label: 'Copyright line',
      help: 'The last line of the footer. Update the year each January.',
    },
  ],
};

/** The host with its forms in stet's own spelling, as an adopted site keeps them, so a rename rewrites only what it changes. */
async function marked(page = MARKED, keys: Record<string, unknown> = MARKED_KEYS, defaults: Record<string, unknown> = MARKED_VALUES) {
  const host = await makeHtmlHost({ files: { 'index.html': page }, keys, defaults });
  for (const rel of ['content/descriptor.json', 'content/defaults.json']) {
    writeJsonDeterministic(join(host.cwd, rel), JSON.parse(host.file(rel)));
  }
  return host;
}

describe('rename — the static-HTML host', () => {
  it('plans three keys, writes nothing, then renames the marks and every form in one batch', async () => {
    const host = await marked();
    writeFileSync(join(host.cwd, 'rename.json'), JSON.stringify(THREE, null, 2));
    const before = bytesOf(host, FORMS);
    expect(await host.run('rename', '--plan', 'rename.json')).toBe(0);
    expect(host.out).toEqual([
      'rename 01_assess → home_process_step_1',
      '  index.html:9 the mark is renamed',
      'rename agreed_case_by_case_where_none_of_the → home_another_structure_body',
      '  index.html:10 the mark is renamed',
      'rename 2026_psyon_all_rights_reserved → home_footer_copyright',
      '  index.html:11 the mark is renamed',
      'rename: run with --write to rename 3 keys across content/descriptor.json, content/defaults.json, index.html',
    ]);
    sameBytes(host, FORMS, before);

    clear(host);
    expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
    expect(host.out.slice(-2)).toEqual([
      'wrote content/descriptor.json, content/defaults.json, index.html: 3 keys renamed',
      'commit them together: git commit -m "stet: rename 3 keys" -- content/descriptor.json content/defaults.json index.html',
    ]);
    // One batch of exactly the three forms.
    expect(control.planned).toEqual([['content/descriptor.json', 'content/defaults.json', 'index.html']]);
    // Three attribute values changed, and every other byte is equal.
    const page = readFileSync(join(host.cwd, 'index.html'), 'utf8')
      .replace('"home_process_step_1"', '"01_assess"')
      .replace('"home_another_structure_body"', '"agreed_case_by_case_where_none_of_the"')
      .replace('"home_footer_copyright"', '"2026_psyon_all_rights_reserved"');
    expect(Buffer.from(page, 'utf8').equals(Buffer.from(MARKED, 'utf8'))).toBe(true);
    const keys = JSON.parse(host.file('content/descriptor.json')).keys as Record<string, Record<string, unknown>>;
    expect(keys['home_process_step_1']).toEqual({
      shape: 'text',
      target: 'web',
      label: 'Process step 1',
      help: "The first step's title in How it works.",
    });
    expect(keys['home_another_structure_body']).toEqual({ shape: 'text', target: 'web' });
    expect(keys['01_assess']).toBeUndefined();
    expect(JSON.parse(host.file('content/defaults.json')).default['home_footer_copyright']).toBe('© 2026 Psyon. All rights reserved.');
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it("carries a page's SEO field and a derived key's source to the new name", async () => {
    const host = await marked();
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    clear(host);
    expect(await host.run('rename', 'psyon_data_acquisition', 'home_page_title')).toBe(0);
    expect(host.out.slice(0, 3)).toEqual([
      'rename psyon_data_acquisition → home_page_title',
      '  pages/home/seo/title follows',
      '  index.html:4 the mark is renamed',
    ]);
    clear(host);
    expect(await host.run('rename', 'you_may_already_have_the_data_2', 'home_hero_headline', '--write')).toBe(0);
    expect(host.out.slice(0, 2)).toEqual([
      'rename you_may_already_have_the_data_2 → home_hero_headline',
      '  you_may_already_have_the_data derives from it and follows',
    ]);
    expect(JSON.parse(host.file('content/descriptor.json')).keys.you_may_already_have_the_data.derivesFrom).toBe('home_hero_headline');
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it('refuses a pair whole, one line for its entry, and changes nothing', async () => {
    const host = await marked(
      MARKED,
      {
        ...MARKED_KEYS,
        welcome__headline: { shape: 'text', target: 'html-email' },
      },
      { ...MARKED_VALUES, welcome__headline: 'Welcome aboard' },
    );
    const descriptor = JSON.parse(host.file('content/descriptor.json'));
    descriptor.templates = { welcome: { class: 'transactional', trigger: 'app-event', sender: 'support', slots: ['headline'] } };
    writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
    const before = bytesOf(host, FORMS);
    const cases: Array<[string[], string]> = [
      [['01_assess', 'home__x'], '01_assess: "home__x" uses "__", which names a template slot or the brand group'],
      [['01_assess', 'agreed_case_by_case_where_none_of_the'], '01_assess: "agreed_case_by_case_where_none_of_the" is already a key in the descriptor'],
      [['nope', 'fine_name'], 'nope: not a key in the descriptor'],
      [['brand__name', 'site_name'], 'cannot rename brand__name: brand__ keys belong to the brand group'],
      [
        ['welcome__headline', 'welcome_title'],
        'cannot rename welcome__headline: welcome__headline is the headline slot of the welcome template — a slot key follows its template',
      ],
      [['01_assess', '01_assess'], '01_assess: the new name is the old name — nothing to rename'],
    ];
    for (const [pair, line] of cases) {
      clear(host);
      expect(await host.run('rename', ...pair, '--write'), pair.join(' ')).toBe(1);
      expect(host.err).toEqual(['error: stet rename is refused — nothing written', `error: ${line}`]);
    }
    sameBytes(host, FORMS, before);
  });

  it('refuses a plan entry that carries adopt', async () => {
    const host = await marked();
    writeFileSync(
      join(host.cwd, 'rename.json'),
      JSON.stringify({ plan: 'stet rename', version: 1, keys: [{ old: '01_assess', key: 'home_step', label: null, help: null, adopt: true }] }),
    );
    expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(1);
    expect(host.err).toEqual([
      'error: stet rename: rename.json is refused — nothing written',
      'error: 01_assess: a rename plan takes no "adopt"',
    ]);
  });

  it('stops at the backstop where the renamed descriptor is invalid', async () => {
    const host = await marked();
    const before = bytesOf(host, FORMS);
    control.noProblems = true;
    expect(await host.run('rename', '01_assess', 'Bad-Key', '--write')).toBe(1);
    expect(host.err).toHaveLength(1);
    expect(host.err[0]).toMatch(/^error: cannot rename: keys — descriptor invalid at keys: .*; nothing written$/);
    sameBytes(host, FORMS, before);
  });

  it('refuses the write while a mark the walk does not claim still names the key', async () => {
    const host = await marked(
      MARKED.replace('  <footer>', '  <ul data-stet="list_key"><li>One item</li></ul>\n  <footer>'),
      { ...MARKED_KEYS, list_key: { shape: 'text', target: 'web' } },
      { ...MARKED_VALUES, list_key: 'One item' },
    );
    const before = bytesOf(host, FORMS);
    expect(await host.run('rename', 'list_key', 'home_list', '--write')).toBe(1);
    expect(host.stdout()).toContain(
      '  index.html:11 reads "list_key" in a form stet cannot rewrite — edit it to the new name by hand, then re-run',
    );
    expect(host.stderr()).toBe('error: cannot rename: 1 read stet cannot rewrite — nothing written');
    sameBytes(host, FORMS, before);
  });

  it('renames a derived key, whose snapshot holds no value, in the descriptor and the page alone', async () => {
    const host = await marked();
    expect(await host.run('rename', 'you_may_already_have_the_data', 'home_share_description', '--write')).toBe(0);
    expect(host.out.slice(-2)).toEqual([
      'wrote content/descriptor.json, index.html: 1 key renamed',
      'commit them together: git commit -m "stet: rename 1 key" -- content/descriptor.json index.html',
    ]);
    clear(host);
    expect(await host.run('check')).toBe(0);
  });
});

// --- A JavaScript host ---------------------------------------------------------

/** The mini project plus the keys a case names, its codegen trio regenerated so check starts green. */
function withKeys(host: CliHost, keys: Record<string, string>): CliHost {
  const descriptor = JSON.parse(host.file('content/descriptor.json')) as Descriptor;
  const snapshot = JSON.parse(host.file('content/defaults.json')) as Snapshot;
  for (const [key, value] of Object.entries(keys)) {
    descriptor.keys[key] = { shape: 'text', target: 'web' };
    (snapshot['default'] as Record<string, unknown>)[key] = value;
  }
  writeFileSync(join(host.cwd, 'content/descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  const registry = generateRegistry(descriptor);
  writeFileSync(join(host.cwd, 'content/keys.ts'), registry.keysTs);
  writeFileSync(join(host.cwd, 'content/stet-env.d.ts'), registry.dts);
  writeFileSync(join(host.cwd, 'content/defaults.ts'), generateDefaultsModule(snapshot));
  return host;
}
const put = (host: { cwd: string }, rel: string, text: string): void => {
  mkdirSync(dirname(join(host.cwd, rel)), { recursive: true });
  writeFileSync(join(host.cwd, rel), text, 'utf8');
};

describe('rename — a JavaScript host', () => {
  const TRIO = ['content/keys.ts', 'content/stet-env.d.ts', 'content/defaults.ts'];
  function site(): CliHost {
    const host = withKeys(
      makeCliHost({ config: { project: 't', managedSurfaces: ['src/**/*.astro', 'content/**/*.ts'], copyModules: ['src/copy.ts'] } }),
      { nav_docs: 'Docs' },
    );
    // The website's shape: a copy module re-exporting the read path, and reads through it.
    put(host, 'src/copy.ts', "import { accessor, copyMap } from '../lib/content';\nexport const copy = copyMap;\nexport const get = accessor.get;\n");
    put(host, 'src/layouts/Base.astro', '---\nimport { copy } from "../copy";\n---\n<html><body><a href="/docs">{copy.nav_docs}</a><slot /></body></html>\n');
    put(
      host,
      'src/components/ui/SiteNav.astro',
      '---\nimport { copy } from "../../copy";\n---\n<nav><a href="/docs">{copy.nav_docs}</a></nav>\n<footer><a href="/docs">{copy.nav_docs}</a></footer>\n',
    );
    put(
      host,
      'src/pages/docs.astro',
      '---\nimport Base from "../layouts/Base.astro";\n---\n<Base>\n' +
        '<p class="nav_docs hero_headline">\n' +
        'The nav_docs and hero_headline keys are named here in prose.\n' +
        '</p>\n' +
        "<pre is:raw>{copy.nav_docs} {copy('hero_headline')}</pre>\n" +
        '<script>console.log(copy.nav_docs, copy.hero_headline);</script>\n' +
        '</Base>\n',
    );
    return host;
  }

  it('rewrites the reads through the copy module with the descriptor, the snapshot and the trio, in one batch', async () => {
    const host = site();
    expect(await host.run('rename', 'nav_docs', 'nav_documentation', '--write')).toBe(0);
    const out = host.stdout();
    expect(out).toContain('  src/layouts/Base.astro:4 <html><body><a href="/docs">{copy.nav_docs}</a><slot /></body></html>');
    expect(out).toContain('  src/components/ui/SiteNav.astro:4 <nav><a href="/docs">{copy.nav_docs}</a></nav>');
    expect(out).toContain('  src/components/ui/SiteNav.astro:5 <footer><a href="/docs">{copy.nav_docs}</a></footer>');
    expect(out).toContain('stet cannot see reads outside the declared surfaces: other repositories, a Python reader of the bundle, or an agent calling the API by the old name');
    expect(control.planned).toHaveLength(1);
    expect([...(control.planned[0] ?? [])].sort()).toEqual(
      ['content/descriptor.json', 'content/defaults.json', ...TRIO, 'src/components/ui/SiteNav.astro', 'src/layouts/Base.astro'].sort(),
    );
    expect(host.file('src/layouts/Base.astro')).toContain('{copy.nav_documentation}');
    expect(host.file('src/components/ui/SiteNav.astro').match(/copy\.nav_documentation/g)).toHaveLength(2);
    // The docs page names the key only in text, and keeps it.
    expect(host.file('src/pages/docs.astro')).toContain('{copy.nav_docs}');
    expect(host.file('content/keys.ts')).toContain('nav_documentation');
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it('rewrites nothing for a key held only in text, and lists each mention once per line', async () => {
    const host = site();
    expect(await host.run('rename', 'hero_headline', 'hero_title')).toBe(0);
    const mentions = host.out.filter((line) => line.includes('mentions "hero_headline"'));
    expect(mentions).toEqual([
      '  src/pages/docs.astro:5 mentions "hero_headline" in text — left as it is',
      '  src/pages/docs.astro:6 mentions "hero_headline" in text — left as it is',
      '  src/pages/docs.astro:8 mentions "hero_headline" in text — left as it is',
      '  src/pages/docs.astro:9 mentions "hero_headline" in text — left as it is',
    ]);
    // The plan offers the repo forms alone.
    expect(host.out.at(-1)).toMatch(/^rename: run with --write to rename 1 key across content\//);
    expect(host.out.at(-1)).not.toContain('src/');
  });

  it('refuses the write while a read it cannot rewrite remains, and writes once it is edited by hand', async () => {
    const host = site();
    put(host, 'src/pages/probe.astro', '---\nimport { copy } from "../copy";\nconst name = "nav_docs";\n---\n<p>{copy["nav_docs"]}</p>\n');
    const rels = ['content/descriptor.json', 'content/defaults.json', ...TRIO, 'src/layouts/Base.astro', 'src/pages/probe.astro'];
    const before = bytesOf(host, rels);
    expect(await host.run('rename', 'nav_docs', 'nav_documentation', '--write')).toBe(1);
    expect(host.stdout()).toContain('  src/pages/probe.astro:5 <p>{copy["nav_docs"]}</p>');
    expect(host.stdout()).toContain(
      '  src/pages/probe.astro:3 reads "nav_docs" in a form stet cannot rewrite — edit it to the new name by hand, then re-run',
    );
    expect(host.stderr()).toBe('error: cannot rename: 1 read stet cannot rewrite — nothing written');
    sameBytes(host, rels, before);

    put(host, 'src/pages/probe.astro', '---\nimport { copy } from "../copy";\nconst name = "nav_documentation";\n---\n<p>{copy["nav_docs"]}</p>\n');
    clear(host);
    expect(await host.run('rename', 'nav_docs', 'nav_documentation', '--write')).toBe(0);
    expect(host.file('src/pages/probe.astro')).toContain('copy["nav_documentation"]');
  });
});

// --- The store half --------------------------------------------------------------

const TWO = { project: 'default', store: { adapter: 'memory' }, environments: { staging: { adapter: 'memory' } } };
const ONE = { project: 'default', store: { adapter: 'memory' } };
const RECORD = '.stet/rename-pending.json';

interface Stores {
  default: MemoryStore;
  staging: MemoryStore;
  calls: Array<{ env: string; oldKey: string }>;
}
/** Two memory stores, each `rename` counted; `failOnce` makes staging's first call for that key fail. */
function stores(failOnce?: string): Stores {
  const out: Stores = {
    default: createMemoryStore({ project: 'default' }),
    staging: createMemoryStore({ project: 'default' }),
    calls: [],
  };
  for (const env of ['default', 'staging'] as const) {
    const store = out[env];
    const real = store.rename.bind(store);
    let failed = false;
    store.rename = async (p) => {
      out.calls.push({ env, oldKey: p.oldKey });
      if (env === 'staging' && p.oldKey === failOnce && !failed) {
        failed = true;
        return { storeError: true, code: 'unreachable', message: 'connection reset' };
      }
      return real(p);
    };
  }
  return out;
}
async function published(store: StoreAdapter, key: string, value: string): Promise<void> {
  await store.saveDraft({ key, value, target: 'web', editor: 't' });
  await store.publish({ key, editor: 't' });
}
function storeHost(s: Stores, config: Record<string, unknown> = TWO): CliHost {
  return withKeys(makeCliHost({ config, stores: { default: s.default, staging: s.staging } }), { a_key: 'A value', b_key: 'B value' });
}
const plan = (host: { cwd: string }, pairs: Array<[string, string]>): void => {
  writeFileSync(
    join(host.cwd, 'rename.json'),
    JSON.stringify({ plan: 'stet rename', version: 1, keys: pairs.map(([old, key]) => ({ old, key, label: null, help: null })) }),
  );
};
const record = (host: { cwd: string }) => JSON.parse(readFileSync(join(host.cwd, RECORD), 'utf8'));
const hasRowsUnder = async (store: StoreAdapter, key: string): Promise<boolean> => {
  const rows = await store.read({ keys: [key], preview: true });
  return Array.isArray(rows) && rows.length > 0;
};
const REPO = ['content/descriptor.json', 'content/defaults.json', 'content/keys.ts', 'content/stet-env.d.ts', 'content/defaults.ts'];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

describe('rename — the store half', () => {
  it('warns where a published value differs from the snapshot, and dials no rename on the plain run', async () => {
    const s = stores();
    await published(s.default, 'a_key', 'A live value');
    const host = storeHost(s);
    expect(await host.run('rename', 'a_key', 'a_new')).toBe(0);
    expect(host.stdout()).toContain(
      "store (default): a_key's published value differs from the snapshot — run stet pull first, so the site serves the published value until the renamed code deploys",
    );
    expect(s.calls).toEqual([]);
    expect(host.exists(RECORD)).toBe(false);
  });

  it('stops part-way with the code untouched, and the same command finishes from the record', async () => {
    const s = stores('b_key');
    for (const store of [s.default, s.staging]) {
      await published(store, 'a_key', 'A value');
      await published(store, 'b_key', 'B value');
    }
    const host = storeHost(s);
    plan(host, [
      ['a_key', 'a_new'],
      ['b_key', 'b_new'],
    ]);
    const before = bytesOf(host, REPO);
    expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(1);
    expect(host.stdout()).toContain('store (default): 2 keys re-keyed; their history stays linked under the new names');
    expect(host.stderr()).toBe(
      'error: store (staging): 1 of 2 keys re-keyed before connection reset — this run wrote no code; run the same command again to finish',
    );
    sameBytes(host, REPO, before);
    const pending = record(host);
    expect(pending.pairs).toEqual([
      ['a_key', 'a_new'],
      ['b_key', 'b_new'],
    ]);
    expect(pending.done).toEqual({ default: ['a_key', 'b_key'], staging: ['a_key'] });
    expect(pending.code).toBe(false);

    clear(host);
    expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
    expect(host.stdout()).toContain('store (default): 0 keys re-keyed, 2 already renamed; their history stays linked under the new names');
    expect(host.stdout()).toContain('store (staging): 1 key re-keyed, 1 already renamed; their history stays linked under the new names');
    expect(host.out.at(-1)).toBe(`commit them together: git commit -m "stet: rename 2 keys" -- ${REPO.join(' ')}`);
    expect(host.exists('.stet')).toBe(false);
    expect(JSON.parse(host.file('content/descriptor.json')).keys.a_new).toBeDefined();
    expect(await hasRowsUnder(s.staging, 'b_new')).toBe(true);
    const history = await s.default.history({ key: 'a_new' });
    expect('rows' in history && history.rows.length).toBe(1);

    // Run again once it has landed: one line per cause.
    clear(host);
    expect(await host.run('rename', '--plan', 'rename.json', '--write')).toBe(1);
    expect(host.err).toEqual([
      'error: stet rename: rename.json is refused — nothing written',
      'error: a_key, b_key: not keys in the descriptor',
      'error: a_new, b_new: already keys in the descriptor — the rename has landed',
    ]);
  });

  it('narrows to one environment, commits the record, and a clone finishes the rest from it', async () => {
    const s = stores();
    for (const store of [s.default, s.staging]) await published(store, 'a_key', 'A value');
    const host = storeHost(s);
    git(host.cwd, 'init', '-q');
    git(host.cwd, 'add', '-A');
    git(host.cwd, 'commit', '-qm', 'base');

    expect(await host.run('rename', 'a_key', 'a_new', '--env', 'staging', '--write')).toBe(0);
    expect(host.stdout()).toContain('store (default): not renamed in this run — run the same command with --env default to finish');
    const named = [...REPO, RECORD];
    expect(host.out.slice(-2)).toEqual([
      `wrote ${named.join(', ')}: 1 key renamed`,
      `commit them together: git commit -m "stet: rename 1 key" -- ${named.join(' ')}`,
    ]);
    expect(await hasRowsUnder(s.default, 'a_key')).toBe(true);
    expect(await hasRowsUnder(s.staging, 'a_new')).toBe(true);

    // The same narrowed run again: staging is done, default still left.
    clear(host);
    expect(await host.run('rename', 'a_key', 'a_new', '--env', 'staging', '--write')).toBe(0);
    expect(host.stdout()).toContain('store (default): not renamed in this run');
    expect(host.stdout()).not.toContain('nothing to do');

    git(host.cwd, 'add', '--', ...named);
    git(host.cwd, 'commit', '-qm', 'stet: rename 1 key');
    const clone = mkdtempSync(join(tmpdir(), 'stet-rename-clone-'));
    git(tmpdir(), 'clone', '-q', host.cwd, clone);
    const out: string[] = [];
    const io: CliIo = {
      cwd: clone,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(`E ${line}`),
      stores: { default: s.default, staging: s.staging },
    };
    expect(await runCli(['rename', 'a_key', 'a_new', '--env', 'default', '--write'], io)).toBe(0);
    expect(out.join('\n')).not.toContain('not renamed in this run');
    expect(out).toContain('commit the rename record: git commit -m "stet: rename 1 key" -- .stet/rename-pending.json');
    expect(existsSync(join(clone, RECORD))).toBe(false);
    expect(await hasRowsUnder(s.default, 'a_new')).toBe(true);
  });

  it('refuses rows under the new name in an environment the record logs no call in', async () => {
    const s = stores();
    await published(s.staging, 'a_key', 'A value');
    await s.default.saveDraft({ key: 'a_new', value: 'Someone else', target: 'web', editor: 'x' });
    const host = storeHost(s);
    const orphan =
      'error: cannot rename a_key: "a_new" already has rows in store (default) that no pending rename of a_key explains — ' +
      'a removed key leaves its rows in the store (stet audit lists them); choose another name';
    // A first narrowed run pre-flights the store it does not write.
    expect(await host.run('rename', 'a_key', 'a_new', '--env', 'staging', '--write')).toBe(1);
    expect(host.stderr()).toBe(orphan);

    // After a staging run the record logs no call for default: the draft is still no rename's.
    const later = stores();
    await published(later.staging, 'a_key', 'A value');
    const narrowed = storeHost(later);
    expect(await narrowed.run('rename', 'a_key', 'a_new', '--env', 'staging', '--write')).toBe(0);
    await later.default.saveDraft({ key: 'a_new', value: 'Someone else', target: 'web', editor: 'x' });
    clear(narrowed);
    expect(await narrowed.run('rename', 'a_key', 'a_new', '--env', 'default', '--write')).toBe(1);
    expect(narrowed.stderr()).toBe(orphan);
  });

  it('calls rename for a key with no rows in either name', async () => {
    const s = stores();
    const host = storeHost(s, ONE);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(0);
    expect(s.calls).toEqual([{ env: 'default', oldKey: 'a_key' }]);
  });

  it('refuses a new name holding a published row, a draft or a scheduled draft, before anything changes', async () => {
    for (const occupy of [
      (store: StoreAdapter) => published(store, 'a_new', 'Taken'),
      (store: StoreAdapter) => store.saveDraft({ key: 'a_new', value: 'Taken', target: 'web', editor: 'x' }),
      (store: StoreAdapter) =>
        store.saveDraft({ key: 'a_new', value: 'Taken', target: 'web', editor: 'x', publishAt: '2099-01-01T00:00:00Z' }),
    ]) {
      const s = stores();
      await published(s.default, 'a_key', 'A value');
      await occupy(s.default);
      const host = storeHost(s, ONE);
      const before = bytesOf(host, REPO);
      expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
      expect(host.stderr()).toBe('error: cannot rename a_key: "a_new" already has rows in store (default)');
      expect(s.calls).toEqual([]);
      expect(host.exists(RECORD)).toBe(false);
      sameBytes(host, REPO, before);
    }
  });

  it('refuses a new name holding a draft while the old has none, with no record', async () => {
    const s = stores();
    await s.default.saveDraft({ key: 'a_new', value: 'Taken', target: 'web', editor: 'x' });
    const host = storeHost(s, ONE);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
    expect(host.stderr()).toContain('that no pending rename of a_key explains');
    expect(s.calls).toEqual([]);
  });

  it('counts a call whose answer was lost as done, from the record, and finishes', async () => {
    const s = stores();
    await published(s.default, 'a_key', 'A value');
    const real = s.default.rename;
    let lost = false;
    s.default.rename = async (p) => {
      const answer = await real(p);
      if (!lost) {
        lost = true;
        return { storeError: true, code: 'unreachable', message: 'the answer was lost' };
      }
      return answer;
    };
    const host = storeHost(s, ONE);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
    expect(record(host).attempted).toEqual({ default: ['a_key'] });
    expect(record(host).done).toEqual({});
    clear(host);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(0);
    expect(host.stdout()).toContain('store (default): 0 keys re-keyed, 1 already renamed');
    expect(host.exists(RECORD)).toBe(false);
    expect(JSON.parse(host.file('content/descriptor.json')).keys.a_new).toBeDefined();
  });

  it('refuses a chain where a store exists, and applies it on a snapshot-only project', async () => {
    const pairs: Array<[string, string]> = [
      ['a_key', 'b_key'],
      ['b_key', 'c_key'],
    ];
    const backed = storeHost(stores(), ONE);
    plan(backed, pairs);
    expect(await backed.run('rename', '--plan', 'rename.json', '--write')).toBe(1);
    expect(backed.err).toEqual([
      'error: stet rename: rename.json is refused — nothing written',
      'error: a_key: "b_key" is another entry\'s old name — a store renames one key at a time, so rename through a temporary name in two plans',
    ]);
    const bare = storeHost(stores(), { project: 'default' });
    plan(bare, pairs);
    expect(await bare.run('rename', '--plan', 'rename.json', '--write')).toBe(0);
    const values = JSON.parse(bare.file('content/defaults.json')).default;
    expect([values.b_key, values.c_key, values.a_key]).toEqual(['A value', 'B value', undefined]);
  });

  it('refuses an old name the descriptor no longer declares, with no record', async () => {
    const host = storeHost(stores(), ONE);
    const descriptor = JSON.parse(host.file('content/descriptor.json'));
    descriptor.keys.a_new = descriptor.keys.a_key;
    delete descriptor.keys.a_key;
    writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
    expect(host.err).toContain('error: a_key: not keys in the descriptor');
  });

  it('refuses a different plan while a record is pending, and a record it cannot read', async () => {
    const s = stores('a_key');
    await published(s.staging, 'a_key', 'A value');
    const host = storeHost(s);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
    clear(host);
    expect(await host.run('rename', 'b_key', 'b_new', '--write')).toBe(1);
    expect(host.stderr()).toBe(
      'error: a rename is pending in .stet/rename-pending.json (a_key → a_new) — run that plan again to finish it before another',
    );
    writeFileSync(join(host.cwd, RECORD), 'not json');
    clear(host);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(2);
    expect(host.stderr()).toBe(
      'usage: .stet/rename-pending.json is not a rename record stet wrote — remove it once every store is checked',
    );
  });

  it('stops at target_occupied when a writer takes the new name after the pre-flight', async () => {
    const s = stores();
    await published(s.default, 'a_key', 'A value');
    const real = s.default.rename;
    s.default.rename = async (p) => {
      await s.default.saveDraft({ key: p.newKey, value: 'Raced', target: 'web', editor: 'x' });
      return real(p);
    };
    const host = storeHost(s, ONE);
    const before = bytesOf(host, REPO);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
    expect(host.stderr()).toMatch(/^error: store \(default\): 0 of 1 key re-keyed before .*a_new.* — this run wrote no code; run the same command again to finish$/);
    sameBytes(host, REPO, before);
    expect(record(host).pairs).toEqual([['a_key', 'a_new']]);
  });

  it('dials no store and writes no record on a snapshot-only project', async () => {
    const s = stores();
    const host = storeHost(s, { project: 'default' });
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(0);
    expect(s.calls).toEqual([]);
    expect(host.exists('.stet')).toBe(false);
    expect(host.out.at(-1)).toBe(`commit them together: git commit -m "stet: rename 1 key" -- ${REPO.join(' ')}`);
  });
});

// --- Stage-5 review -----------------------------------------------------------------

describe('rename — the stage-5 review', () => {
  it('finishes the code half on the re-run wherever a stop inside its batch left it (F3)', async () => {
    for (let stopAfter = 0; stopAfter <= REPO.length; stopAfter++) {
      const s = stores();
      for (const store of [s.default, s.staging]) await published(store, 'a_key', 'A value');
      const host = storeHost(s);
      plan(host, [
        ['a_key', 'a_new'],
        ['b_key', 'b_new'],
      ]);
      control.stopAfter = stopAfter;
      expect(await host.run('rename', '--plan', 'rename.json', '--write'), `stop after ${stopAfter}`).toBe(1);
      expect(record(host).code).toBe(false);
      control.stopAfter = null;
      clear(host);
      expect(await host.run('rename', '--plan', 'rename.json', '--write'), `re-run after ${stopAfter}: ${host.stderr()}`).toBe(0);
      expect(host.stdout()).not.toContain('nothing to do');
      const keys = Object.keys(JSON.parse(host.file('content/descriptor.json')).keys);
      expect(keys).toEqual(expect.arrayContaining(['a_new', 'b_new']));
      expect(keys).not.toContain('a_key');
      expect(Object.keys(JSON.parse(host.file('content/defaults.json')).default)).toEqual(expect.arrayContaining(['a_new', 'b_new']));
      expect(host.file('content/keys.ts')).toContain('a_new');
      expect(host.exists(RECORD), `record after ${stopAfter}`).toBe(false);
      // A batch whose every file had landed writes nothing, and names nothing to commit.
      if (stopAfter === REPO.length) expect(host.stdout()).not.toContain('wrote ');
      clear(host);
      expect(await host.run('check'), `check after ${stopAfter}`).toBe(0);
    }
  });

  it('finishes the marks on a static-HTML host after a stop that left the descriptor renamed (F3)', async () => {
    const s = stores();
    const host = await marked(MARKED, MARKED_KEYS, MARKED_VALUES);
    const config = JSON.parse(host.file('stet.config.json'));
    writeFileSync(join(host.cwd, 'stet.config.json'), JSON.stringify({ ...config, store: { adapter: 'memory' } }, null, 2));
    host.io.stores = { default: s.default };
    control.stopAfter = 1;
    expect(await host.run('rename', '01_assess', 'home_process_step_1', '--write')).toBe(1);
    control.stopAfter = null;
    clear(host);
    expect(await host.run('rename', '01_assess', 'home_process_step_1', '--write')).toBe(0);
    expect(host.file('index.html')).toContain('data-stet="home_process_step_1"');
    expect(JSON.parse(host.file('content/defaults.json')).default['home_process_step_1']).toBe('01 Assess');
    clear(host);
    expect(await host.run('check')).toBe(0);
  });

  it('takes a plan through an absolute path (F2)', async () => {
    const host = await marked();
    writeFileSync(join(host.cwd, 'rename.json'), JSON.stringify(THREE, null, 2));
    expect(await host.run('rename', '--plan', join(host.cwd, 'rename.json'))).toBe(0);
    expect(host.stdout()).toContain('rename 01_assess → home_process_step_1');
  });

  it('prints a rewritten line with its control characters replaced (F5)', async () => {
    const host = withKeys(
      makeCliHost({ config: { project: 't', managedSurfaces: ['src/**/*.astro'], copyModules: ['src/copy.ts'] } }),
      { nav_docs: 'Docs' },
    );
    put(host, 'src/copy.ts', "import { accessor, copyMap } from '../lib/content';\nexport const copy = copyMap;\nexport const get = accessor.get;\n");
    put(host, 'src/pages/p.astro', '---\nimport { copy } from "../copy";\n---\n<p>{copy.nav_docs} <!-- \u001b[2J\u001b]0;PWNED\u0007 --></p>\n');
    expect(await host.run('rename', 'nav_docs', 'nav_documentation')).toBe(0);
    const line = host.out.find((l) => l.startsWith('  src/pages/p.astro:4'));
    expect(line).toBe('  src/pages/p.astro:4 <p>{copy.nav_docs} <!-- �[2J�]0;PWNED� --></p>');
  });

  it("keeps the renamed key's value over a stale entry already under the new name (F7)", async () => {
    const host = await marked(MARKED, MARKED_KEYS, { ...MARKED_VALUES, zzz_new: 'STALE ORPHAN VALUE' });
    expect(await host.run('rename', '01_assess', 'zzz_new', '--write')).toBe(0);
    expect(JSON.parse(host.file('content/defaults.json')).default['zzz_new']).toBe('01 Assess');
  });

  it('drops a stale entry under the new name in a locale that lacks the old one, while another locale holds it (N4)', async () => {
    const host = await marked();
    const values = JSON.parse(host.file('content/defaults.json'));
    values.de = { zzz_new: 'STALE DE VALUE', '2026_psyon_all_rights_reserved': 'Alle Rechte vorbehalten' };
    writeJsonDeterministic(join(host.cwd, 'content/defaults.json'), values);
    expect(await host.run('rename', '01_assess', 'zzz_new', '--write')).toBe(0);
    const after = JSON.parse(host.file('content/defaults.json'));
    expect(after.default['zzz_new']).toBe('01 Assess');
    expect(after.de).toEqual({ '2026_psyon_all_rights_reserved': 'Alle Rechte vorbehalten' });
  });

  it('finds a mark whose value is unquoted: renamed where claimed, refused where not (F10)', async () => {
    const host = await marked(
      MARKED.replace('<h3 data-stet="01_assess">', '<h3 data-stet=01_assess>').replace(
        '  <footer>',
        '  <ul data-stet=list_key><li>One item</li></ul>\n  <footer>',
      ),
      { ...MARKED_KEYS, list_key: { shape: 'text', target: 'web' } },
      { ...MARKED_VALUES, list_key: 'One item' },
    );
    expect(await host.run('rename', 'list_key', 'home_list', '--write')).toBe(1);
    expect(host.stdout()).toContain(
      '  index.html:11 reads "list_key" in a form stet cannot rewrite — edit it to the new name by hand, then re-run',
    );
    clear(host);
    expect(await host.run('rename', '01_assess', 'home_process_step_1', '--write')).toBe(0);
    expect(host.file('index.html')).toContain('<h3 data-stet=home_process_step_1>');
  });

  it("counts a pair the store's own rename log holds as done, where a clone finished it (F11)", async () => {
    const s = stores();
    for (const store of [s.default, s.staging]) await published(store, 'a_key', 'A value');
    const host = storeHost(s);
    git(host.cwd, 'init', '-q');
    git(host.cwd, 'add', '-A');
    git(host.cwd, 'commit', '-qm', 'base');
    expect(await host.run('rename', 'a_key', 'a_new', '--env', 'staging', '--write')).toBe(0);
    git(host.cwd, 'add', '-A');
    git(host.cwd, 'commit', '-qm', 'stet: rename 1 key');
    // A clone finishes default and commits the record's removal there.
    const clone = mkdtempSync(join(tmpdir(), 'stet-rename-clone-'));
    git(tmpdir(), 'clone', '-q', host.cwd, clone);
    const io: CliIo = { cwd: clone, env: {}, stdout: () => {}, stderr: () => {}, stores: { default: s.default, staging: s.staging } };
    expect(await runCli(['rename', 'a_key', 'a_new', '--env', 'default', '--write'], io)).toBe(0);
    // The first checkout, not yet pulled, runs the command again.
    clear(host);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(0);
    expect(host.stderr()).toBe('');
    expect(host.stdout()).toContain('rename: every key already carries its new name in the code and in every store — nothing to do');
    expect(host.exists(RECORD)).toBe(false);
  });

  it("says a store's refusal to rename in the part-way line (review extra)", async () => {
    const s = stores();
    await published(s.default, 'a_key', 'A value');
    s.default.rename = async () => ({ notSupported: true, method: 'rename' }) as const;
    const host = storeHost(s, ONE);
    expect(await host.run('rename', 'a_key', 'a_new', '--write')).toBe(1);
    expect(host.stderr()).toBe(
      'error: store (default): 0 of 1 key re-keyed before the store answered that it cannot rename keys — this run wrote no code; run the same command again to finish',
    );
  });

  it('refuses an expression stet cannot parse, naming its line, and writes nothing (F1 guard)', async () => {
    const host = withKeys(
      makeCliHost({ config: { project: 't', managedSurfaces: ['src/**/*.astro'], copyModules: ['src/copy.ts'] } }),
      { nav_docs: 'Docs' },
    );
    put(host, 'src/copy.ts', "import { accessor, copyMap } from '../lib/content';\nexport const copy = copyMap;\nexport const get = accessor.get;\n");
    put(host, 'src/pages/g.astro', '---\nimport { copy } from "../copy";\n---\n<p>{copy.nav_docs +}</p>\n');
    const before = bytesOf(host, [...REPO, 'src/pages/g.astro']);
    expect(await host.run('rename', 'nav_docs', 'nav_documentation', '--write')).toBe(1);
    expect(host.stdout()).toContain(
      '  src/pages/g.astro:4 an expression stet cannot parse — edit "nav_docs" in this file to the new name by hand, then re-run',
    );
    expect(host.stderr()).toBe('error: cannot rename: 1 expression stet cannot parse — nothing written');
    sameBytes(host, [...REPO, 'src/pages/g.astro'], before);
  });
});

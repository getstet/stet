/**
 * The unread-key scan (cli/key-usage.ts, D6): which declared keys a host's
 * source names, which it reads in ways stet cannot follow, and which no file
 * stet searched names at all.
 *
 * The 25 fixtures under `fixtures/key-usage/` are the badge review's, each with
 * its `truth.json` naming the keys the host really renders. Each runs from a
 * temp copy made a git repository, since the file set is git's. A wrong
 * `not_found` is the failure that matters — an editor deletes live copy on it —
 * so every fixture's live keys are checked against the scan, and the three
 * places where a static scan cannot see a live read (17, 19, 21) are named.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../cli/config.js';
import { packageRoot } from '../cli/installed.js';
import { keyUsage, usageCache, type KeyUsage } from '../cli/key-usage.js';
import type { Descriptor } from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'key-usage');
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
}

/** A temp copy of one fixture, `edit` applied, then made a git repository with every file added. */
function repo(name: string, edit: (dir: string) => void = () => {}, opts: { git?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-usage-'));
  made.push(dir);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  rmSync(join(dir, 'truth.json'));
  edit(dir);
  if (opts.git !== false) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
  }
  return dir;
}

async function usageOf(dir: string): Promise<KeyUsage> {
  const config = loadConfig(dir);
  const descriptor = JSON.parse(readFileSync(join(dir, config.descriptorPath), 'utf8')) as Descriptor;
  return keyUsage(dir, config, descriptor);
}

/** Each judged key's state, with its prefix where it has one: `tier_solo_name: unknown tier_`. */
function states(usage: KeyUsage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(usage.keys).map(([key, entry]) => [key, entry.prefix === undefined ? entry.state : `${entry.state} ${entry.prefix.prefix}`]),
  );
}

const causesOf = (usage: KeyUsage): string[] => usage.causes.map((c) => `${c.text} @ ${c.file}:${c.line}`);
const prefixesOf = (usage: KeyUsage): string[] => usage.prefixes.map((p) => `${p.prefix} @ ${p.file}:${p.line}`);

/**
 * The scan's answer for every fixture, as D6 states it. `causes` counts the
 * reads the site line would name.
 */
const EXPECTED: Record<string, { keys: Record<string, string>; causes: number }> = {
  '01-copy-call': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
  '02-copy-prop': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'read' }, causes: 0 },
  '03-useCopy-renamed': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
  '04-slice-prefix': {
    keys: {
      home_live_kicker: 'read',
      home_live_headline: 'read',
      home_live_lead: 'unknown home_live_',
      home_faq_1_question: 'not_found',
      footer_note: 'not_found',
    },
    causes: 0,
  },
  '05-i18n-flat-t': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
  '06-i18n-namespace': {
    keys: { home_title: 'unknown', home_lead: 'unknown', pricing_title: 'unknown', footer_note: 'unknown' },
    causes: 1,
  },
  '07-template-literal': {
    keys: {
      tier_solo_name: 'unknown tier_',
      tier_team_name: 'unknown tier_',
      tier_solo_price: 'unknown tier_',
      footer_note: 'not_found',
    },
    causes: 0,
  },
  '08-concat': {
    keys: {
      home_faq_1_question: 'unknown home_faq_',
      home_faq_2_question: 'unknown home_faq_',
      home_faq_1_answer: 'unknown home_faq_',
      footer_note: 'not_found',
    },
    causes: 0,
  },
  '09-array-of-names': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'read' }, causes: 0 },
  '10-keyof-map': {
    keys: { status_open: 'read', status_closed: 'read', status_paused: 'not_found', footer_note: 'not_found' },
    causes: 0,
  },
  '11-object-entries': { keys: { faq_1: 'unknown', faq_2: 'unknown', footer_note: 'unknown' }, causes: 1 },
  '12-props-slice': { keys: { hero_title: 'read', hero_sub: 'unknown', footer_note: 'unknown' }, causes: 1 },
  '13-barrel': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
  '14-json-import': { keys: { hero_title: 'read', hero_sub: 'unknown', footer_note: 'unknown' }, causes: 1 },
  '15-cms-table': { keys: { hero_title: 'unknown', hero_sub: 'unknown', footer_note: 'unknown' }, causes: 1 },
  '16-cms-table-sliced': { keys: { hero_title: 'unknown', hero_sub: 'unknown', footer_note: 'unknown' }, causes: 1 },
  '17-tests-only': { keys: { hero_title: 'read', hero_sub: 'read', footer_note: 'not_found' }, causes: 0 },
  '18-server-email-script': {
    keys: { hero_title: 'read', api_error: 'read', welcome_subject: 'read', og_title: 'read', footer_note: 'not_found' },
    causes: 0,
  },
  '19-monorepo-sibling': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
  '20-astro-vue-svelte': {
    keys: { hero_title: 'read', hero_sub: 'read', nav_label: 'read', cta_label: 'read', footer_note: 'read' },
    causes: 0,
  },
  '21-plain-html-alpine': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'read' }, causes: 0 },
  '22-comment-mention': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
  '23-mixed-file': {
    keys: { home_title: 'unknown home_', home_lead: 'unknown home_', pricing_title: 'unknown', footer_note: 'unknown' },
    causes: 1,
  },
  '24-slice-then-index': {
    keys: {
      home_live_kicker: 'unknown home_live_',
      home_live_lead: 'unknown home_live_',
      pricing_title: 'unknown pricing_',
      footer_note: 'unknown footer_',
    },
    causes: 0,
  },
  '25-unrelated-copy-fn': { keys: { hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' }, causes: 0 },
};

/**
 * Live keys a static scan cannot see, and why the fixture's truth is not met:
 * the badge's wording (the scan's scope, never "leftover" without the census)
 * carries these, and the safe direction holds everywhere else.
 */
//
// Past the 25 fixtures, one shape is unseeable by design: a computed `import(spec)`,
// whose module is chosen at run time, so a key it reads is named nowhere the scan can
// follow. The scan answers `unknown` only where the same file shows another cause.
const UNSEEABLE: Record<string, string[]> = {
  // Read by a sibling package outside the checkout.
  '19-monorepo-sibling': ['footer_note'],
  // An Alpine attribute: a quoted attribute value in an .html file is not code.
  '21-plain-html-alpine': ['hero_sub'],
};

describe('the 25 fixtures against their truth (D6)', () => {
  it('holds one fixture per entry', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const name of Object.keys(EXPECTED)) {
    it(`${name}: states as D6 gives them, no live key not_found but the unseeable`, async () => {
      const usage = await usageOf(repo(name));
      expect(states(usage)).toEqual(EXPECTED[name]?.keys);
      expect(usage.causes.length, causesOf(usage).join('\n')).toBe(EXPECTED[name]?.causes);
      const truth = JSON.parse(readFileSync(join(FIXTURES, name, 'truth.json'), 'utf8')) as { live: string[] };
      const wrong = truth.live.filter((key) => usage.keys[key]?.state === 'not_found');
      expect(wrong).toEqual(UNSEEABLE[name] ?? []);
    });
  }
});

describe('step 1: the files (5.1)', () => {
  it('F4: a file whose first line is "// generated by stet" contributes no name', async () => {
    const dir = repo('01-copy-call', (d) => {
      // The descriptor and snapshot move out of content/, so the directory
      // rule does not hide what the header rule decides.
      mkdirSync(join(d, 'stet'));
      renameSync(join(d, 'content/descriptor.json'), join(d, 'stet/descriptor.json'));
      renameSync(join(d, 'content/defaults.json'), join(d, 'stet/defaults.json'));
      const config = JSON.parse(readFileSync(join(d, 'stet.config.json'), 'utf8'));
      write(d, 'stet.config.json', JSON.stringify({ ...config, descriptorPath: 'stet/descriptor.json', snapshotPath: 'stet/defaults.json' }));
      write(d, 'content/resolved.ts', "// generated by stet — source-hash: x\nexport const RESOLVED = { hero_sub: 'x', footer_note: 'y' };\n");
    });
    const usage = await usageOf(dir);
    expect(states(usage)).toEqual({ hero_title: 'read', hero_sub: 'not_found', footer_note: 'not_found' });
  });

  it('M1: a module headed "// generated by stet" that the config does not name contributes no name', async () => {
    const usage = await usageOf(host({ 'lib/gen.ts': "// generated by stet — source-hash: x\nexport const G = { hero_sub: 1 };\n" }));
    expect(stateOf(usage, 'hero_sub')).toBe('not_found');
    expect(usage.files).toBe(0);
  });

  it('never reads a .md file naming a key', async () => {
    const dir = repo('01-copy-call', (d) => write(d, 'docs/notes.md', 'We still show `copy("hero_sub")` on the band.\n'));
    expect((await usageOf(dir)).keys['hero_sub']?.state).toBe('not_found');
  });

  it('never scans an untracked file git ignores', async () => {
    const dir = repo('01-copy-call', (d) => {
      write(d, '.gitignore', 'scratch/\n');
      write(d, 'scratch/old.tsx', "import { copy } from '@/lib/content';\nexport const Old = () => copy('hero_sub');\n");
    });
    expect((await usageOf(dir)).keys['hero_sub']?.state).toBe('not_found');
  });

  it('scans an untracked file git does not ignore', async () => {
    const dir = repo('01-copy-call');
    write(dir, 'app/new.tsx', "import { copy } from '@/lib/content';\nexport const New = () => copy('hero_sub');\n");
    expect((await usageOf(dir)).keys['hero_sub']?.state).toBe('read');
  });

  it('skips a tracked file deleted from the working tree, with no error', async () => {
    const dir = repo('01-copy-call', (d) => write(d, 'app/gone.tsx', "export const Gone = () => 'footer_note';\n"));
    rmSync(join(dir, 'app/gone.tsx'));
    const usage = await usageOf(dir);
    expect(usage.keys['footer_note']?.state).toBe('not_found');
    expect(usage.files).toBe(1);
  });

  it('never follows a symlink out of the checkout; follows one inside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'stet-usage-out-'));
    made.push(outside);
    write(outside, 'outside.tsx', "export const Out = () => 'footer_note';\n");
    const dir = repo('01-copy-call', (d) => {
      write(d, '.gitignore', 'vendor/\n');
      write(d, 'vendor/real.tsx', "export const Real = () => 'hero_sub';\n");
      symlinkSync(join(outside, 'outside.tsx'), join(d, 'app/out.tsx'));
      symlinkSync(join(d, 'vendor/real.tsx'), join(d, 'app/in.tsx'));
    });
    const usage = await usageOf(dir);
    expect(usage.keys['footer_note']?.state).toBe('not_found');
    expect(usage.keys['hero_sub']?.state).toBe('read');
  });

  it('falls back to the walk where git cannot be spawned, and still judges the keys', async () => {
    const dir = repo('07-template-literal');
    const empty = mkdtempSync(join(tmpdir(), 'stet-usage-nogit-'));
    made.push(empty);
    vi.stubEnv('PATH', empty);
    const usage = await usageOf(dir);
    expect(states(usage)).toEqual(EXPECTED['07-template-literal']?.keys);
    expect(usage.root).toMatch(/^stet-usage-[^/]+\/$/);
  });

  it('reads the root as the checkout folder relative to the repository top', async () => {
    const top = mkdtempSync(join(tmpdir(), 'stet-usage-top-'));
    made.push(top);
    cpSync(join(FIXTURES, '01-copy-call'), join(top, 'apps/site'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: top });
    execFileSync('git', ['add', '-A'], { cwd: top });
    const usage = await usageOf(join(top, 'apps/site'));
    expect(usage.root).toBe('apps/site/');
    expect(usage.files).toBe(1);
  });
});

describe('step 3: bindings, by declaration (5.1)', () => {
  it('fixture 13: a barrel re-export carries the binding to its importer', async () => {
    const dir = repo('13-barrel', (d) => write(d, 'app/list.tsx', "import { copy } from '@/lib';\nexport const L = ({ k }: { k: string }) => copy(k);\n"));
    const usage = await usageOf(dir);
    expect(causesOf(usage)).toEqual(['copy(k) @ app/list.tsx:2']);
  });

  it('fixture 25: a clipboard helper named copy is no binding', async () => {
    const usage = await usageOf(repo('25-unrelated-copy-fn'));
    expect(usage.causes).toEqual([]);
    expect(usage.keys['hero_sub']?.state).toBe('not_found');
  });
});

describe('pass 1 and the state (5.2)', () => {
  it('a key named only in a comment is not_found (the comment scenario)', async () => {
    const dir = repo('01-copy-call', (d) => {
      write(d, 'app/note.ts', '// copy.hero_sub\nexport const n = 1;\n');
      write(d, 'docs/x.md', 'copy.hero_sub\n');
    });
    expect((await usageOf(dir)).keys['hero_sub']?.state).toBe('not_found');
  });

  it('gives brand__ keys, derived keys, page SEO keys and template slots no state', async () => {
    const dir = repo('01-copy-call', (d) => {
      const descriptor = JSON.parse(readFileSync(join(d, 'content/descriptor.json'), 'utf8'));
      descriptor.keys.brand__name = { shape: 'text' };
      descriptor.keys.hero_share = { shape: 'text', derivesFrom: 'hero_title', tmpl: '{{value}}' };
      descriptor.keys.home_seo_title = { shape: 'text' };
      descriptor.keys.welcome__body = { shape: 'text' };
      descriptor.pages = { home: { route: '/', seo: { title: 'home_seo_title' } } };
      descriptor.templates = { welcome: { class: 'transactional', trigger: 'manual', slots: ['body'] } };
      write(d, 'content/descriptor.json', JSON.stringify(descriptor));
    });
    expect(Object.keys((await usageOf(dir)).keys).sort()).toEqual(['footer_note', 'hero_sub', 'hero_title']);
  });

  it('reads a data-stet mark in an .html file', async () => {
    const dir = repo('21-plain-html-alpine', (d) => write(d, 'about.html', '<p data-stet-aria-label="hero_sub">x</p>\n'));
    expect((await usageOf(dir)).keys['hero_sub']?.state).toBe('read');
  });
});

describe('pass 2: B1 and B2 (5.3)', () => {
  it('fixture 07: a template literal is unknown under its head, never not_found', async () => {
    const usage = await usageOf(repo('07-template-literal'));
    expect(usage.keys['tier_solo_name']).toEqual({ state: 'unknown', prefix: { prefix: 'tier_', file: 'lib/pricing.ts', line: 2 } });
    expect(usage.keys['tier_team_name']?.state).toBe('unknown');
    expect(prefixesOf(usage)).toEqual(['tier_ @ lib/pricing.ts:2']);
  });

  it('fixtures 05, 09, 10: reads followed to key names raise no cause', async () => {
    for (const name of ['05-i18n-flat-t', '09-array-of-names', '10-keyof-map']) {
      const usage = await usageOf(repo(name));
      expect(usage.causes, name).toEqual([]);
    }
  });

  it('fixture 05 with one call of the adapter passing a variable: the adapter read is a cause', async () => {
    const dir = repo('05-i18n-flat-t', (d) =>
      write(d, 'app/other.tsx', "import { t } from '@/lib/i18n';\nexport const O = ({ k }: { k: string }) => <p>{t(k)}</p>;\n"),
    );
    expect(causesOf(await usageOf(dir))).toEqual(['copy(k) @ lib/i18n.ts:2']);
  });

  it('a forEach and a for…of over an array of key names, and a const holding a key name, are placed', async () => {
    const dir = repo('01-copy-call', (d) =>
      write(
        d,
        'app/more.tsx',
        [
          "import { copy } from '@/lib/content';",
          "const NAMES = ['hero_sub'] as const;",
          "const ONE = 'footer_note';",
          'export function f(out: string[]) {',
          '  NAMES.forEach((k) => out.push(copy(k)));',
          '  for (const k of NAMES) out.push(copy(k));',
          '  out.push(copy(ONE));',
          '}',
          '',
        ].join('\n'),
      ),
    );
    const usage = await usageOf(dir);
    expect(usage.causes).toEqual([]);
    expect(states(usage)).toEqual({ hero_title: 'read', hero_sub: 'read', footer_note: 'read' });
  });

  it('fixture 23: visibility is per read — the prefix is learnt and copy(k) is a cause', async () => {
    const usage = await usageOf(repo('23-mixed-file'));
    expect(causesOf(usage)).toEqual(['copy(k) @ app/page.tsx:3']);
    expect(prefixesOf(usage)).toEqual(['home_ @ app/page.tsx:3']);
    expect(usage.keys['pricing_title']).toEqual({ state: 'unknown' });
  });

  it('fixture 04: only the dead key under the learnt prefix is unknown', async () => {
    const usage = await usageOf(repo('04-slice-prefix'));
    expect(Object.entries(usage.keys).filter(([, v]) => v.state === 'unknown').map(([k]) => k)).toEqual(['home_live_lead']);
    expect(prefixesOf(usage)).toEqual(['home_live_ @ lib/copy/landing.ts:3']);
  });

  it('fixture 11: a word that ends at no _ is learnt as no prefix', async () => {
    const usage = await usageOf(repo('11-object-entries'));
    expect(usage.prefixes).toEqual([]);
    expect(causesOf(usage)).toEqual(['Object.entries(copyMap) @ app/faq.tsx:2']);
  });

  it('a word that ends at no _ in sight of a read is no prefix: copy(\'faq\' + n) stays a cause', async () => {
    // Fixture 11's keys, with its whole-map read swapped for one concatenation.
    const dir = repo('11-object-entries', (d) => {
      rmSync(join(d, 'app/faq.tsx'));
      write(d, 'app/one.tsx', "import { copy } from '@/lib/content';\nexport const One = ({ n }: { n: number }) => copy('faq' + n);\n");
    });
    const usage = await usageOf(dir);
    expect(usage.prefixes).toEqual([]);
    expect(causesOf(usage)).toEqual(["copy('faq' + n) @ app/one.tsx:2"]);
    expect(usage.keys['footer_note']?.state).toBe('unknown');
  });

  it('reads in template markup are causes too: an Astro brace, a Vue directive, a Svelte block', async () => {
    const dir = repo('20-astro-vue-svelte', (d) => {
      write(d, 'src/pages/list.astro', "---\nimport { copy } from '@/lib/content';\nconst k = Astro.props.k;\n---\n<p>{copy(k)}</p>\n");
      write(d, 'src/Row.vue', '<template>\n  <p :title="copy[k]">x</p>\n</template>\n<script setup lang="ts">\nimport { copy } from \'@/lib/content\';\n</script>\n');
      write(d, 'src/All.svelte', "<script>\n  import { copyMap } from '@/lib/content';\n</script>\n{#each Object.keys(copyMap) as k}<p>{k}</p>{/each}\n");
    });
    expect(causesOf(await usageOf(dir))).toEqual([
      '{#each Object.keys(copyMap) as k} @ src/All.svelte:4',
      '<p :title="copy[k]"> @ src/Row.vue:2',
      'copy(k) @ src/pages/list.astro:5',
    ]);
  });

  it('the map handed on in any other way — returned, held in an object — is a cause', async () => {
    const dir = repo('01-copy-call', (d) =>
      write(d, 'lib/words.ts', "import { copyMap } from '@/lib/content';\nexport function words() { return copyMap; }\nexport const all = { words: copyMap };\n"),
    );
    expect(causesOf(await usageOf(dir))).toEqual(['return copyMap; @ lib/words.ts:2', 'words: copyMap @ lib/words.ts:3']);
  });

  it('cuts a cause at 40 characters, whitespace collapsed', async () => {
    const dir = repo('01-copy-call', (d) =>
      write(d, 'app/long.tsx', "import { copy } from '@/lib/content';\nexport const L = (a: string) => copy(\n  a  +   'something'.repeat(3) + a + a + a,\n);\n"),
    );
    const [cause] = (await usageOf(dir)).causes;
    expect(cause).toEqual({ text: "copy( a + 'something'.repeat(3) + a + a ", file: 'app/long.tsx', line: 2 });
  });
});

describe('exemptions and server-only (5.4)', () => {
  it('a file importing @getstet/stet that reads the whole map raises no cause', async () => {
    const dir = repo('01-copy-call', (d) =>
      write(
        d,
        'lib/stet/site-copy.ts',
        [
          "import { loadSnapshot, type Descriptor } from '@getstet/stet';",
          "import { DEFAULTS } from '@/content/defaults';",
          'export const read = (descriptor: Descriptor) => { loadSnapshot(DEFAULTS); return Object.keys(descriptor.keys); };',
          '',
        ].join('\n'),
      ),
    );
    expect((await usageOf(dir)).causes).toEqual([]);
  });

  it('a file importing a @getstet/stet subpath is exempt too', async () => {
    const dir = repo('01-copy-call', (d) =>
      write(
        d,
        'app/client.tsx',
        "import { useCopy } from '@getstet/stet/react';\nimport { DEFAULTS } from '@/content/defaults';\nexport const C = () => Object.keys(DEFAULTS.default);\n",
      ),
    );
    expect((await usageOf(dir)).causes).toEqual([]);
  });

  it('a test file reading through copy(k) raises no cause, and the key it names is read', async () => {
    const dir = repo('01-copy-call', (d) =>
      write(d, 'lib/__tests__/x.test.ts', "import { copy } from '@/lib/content';\nfor (const k of ['a']) copy(k);\nexpect(copy('footer_note')).toBe('x');\n"),
    );
    const usage = await usageOf(dir);
    expect(usage.causes).toEqual([]);
    expect(usage.keys['footer_note']?.state).toBe('read');
  });

  it('fixture 18: a key only a route handler names is server-only', async () => {
    const usage = await usageOf(repo('18-server-email-script'));
    expect(usage.serverOnly).toEqual(['api_error']);
  });
});

/** Keys of the hand-built hosts below; none is named by the code a case writes unless it says so. */
const HOST_KEYS = ['hero_title', 'hero_sub', 'hero_cta', 'nav_label', 'footer_note'];

/**
 * A small Next host built in a temp directory and made a git repository: the
 * read path `lib/content.ts`, a generated defaults module, the descriptor and
 * snapshot under `content/`, and `extra` on top (a `null` removes a file).
 */
function host(extra: Record<string, string | null>, opts: { config?: Record<string, unknown>; keys?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-usage-host-'));
  made.push(dir);
  const keys = opts.keys ?? HOST_KEYS;
  const defaults = { default: Object.fromEntries(keys.map((k) => [k, `Text of ${k}`])) };
  const files: Record<string, string | null> = {
    'stet.config.json': JSON.stringify({
      copyModules: [],
      descriptorPath: 'content/descriptor.json',
      snapshotPath: 'content/defaults.json',
      codegen: { defaults: 'content/defaults.ts', registry: 'content/keys.ts' },
      readPath: { file: 'lib/content.ts', import: '@/lib/content' },
      managedSurfaces: ['app/**/*.tsx'],
      ...opts.config,
    }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
    'content/descriptor.json': JSON.stringify({ version: 1, keys: Object.fromEntries(keys.map((k) => [k, { shape: 'text', target: 'web' }])) }),
    'content/defaults.json': JSON.stringify(defaults),
    'content/defaults.ts': `// generated by stet — source-hash: x\nexport const DEFAULTS = ${JSON.stringify(defaults)} as const;\n`,
    'lib/content.ts':
      "import { createServerCopy } from '@getstet/stet/react/server';\nimport { DEFAULTS } from '../content/defaults';\nexport const copy = createServerCopy(descriptor, resolved);\nexport const copyMap = resolved as Record<string, string>;\n",
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) if (text !== null) write(dir, rel, text);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

const stateOf = (usage: KeyUsage, key: string): string | undefined => usage.keys[key]?.state;

describe('useCopy is a binding by its import, under any name (R-useCopy, F10)', () => {
  const page = (body: string, head = "import { useCopy } from '@getstet/stet/react';"): Record<string, string> => ({
    'app/page.tsx': `${head}\nexport default function P({ n }: { n: string }) { ${body} }\n`,
  });

  it.each([
    ['an inline useCopy()(n)', page('return <p>{useCopy()(n)}</p>;'), 'useCopy()(n)'],
    ['an alias of the import', page('const t = useC(); return <p>{t(n)}</p>;', "import { useCopy as useC } from '@getstet/stet/react';"), 't(n)'],
    ['a namespace member', page('const t = R.useCopy(); return <p>{t(n)}</p>;', "import * as R from '@getstet/stet/react';"), 't(n)'],
    ['a client component importing it', page('const t = useCopy(); return <h1>{t(n)}</h1>;', "'use client';\nimport { useCopy } from '@getstet/stet/react';"), 't(n)'],
    ['a copy of the hook handed on to a const', page('const t = hook(); return <p>{t(n)}</p>;', "import { useCopy } from '@getstet/stet/react';\nconst hook = useCopy;"), 't(n)'],
  ])('%s: a read with no literal key is a cause, the key unknown', async (_name, files, cause) => {
    const usage = await usageOf(host(files));
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
    expect(usage.causes.map((c) => c.text)).toEqual([cause]);
  });

  it.each([
    ['const t = useCopy(); return <p>{t("hero_sub")}</p>;', "import { useCopy } from '@getstet/stet/react';"],
    ['return <p>{useCopy()("hero_sub")}</p>;', "import { useCopy } from '@getstet/stet/react';"],
    ['const t = useC(); return <p>{t("hero_sub")}</p>;', "import { useCopy as useC } from '@getstet/stet/react';"],
    ['const t = R.useCopy(); return <p>{t("hero_sub")}</p>;', "import * as R from '@getstet/stet/react';"],
  ])('its literal calls read the key: %s', async (body, head) => {
    const usage = await usageOf(host(page(body, head)));
    expect(stateOf(usage, 'hero_sub')).toBe('read');
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_cta')).toBe('not_found');
  });

  it('H8: a namespace of the read path calling useCopy is the hook, its call no cause of its own', async () => {
    const usage = await usageOf(
      host({
        'lib/content.ts': "import { createServerCopy } from '@getstet/stet/react/server';\nexport { useCopy } from '@getstet/stet/react';\nexport const copy = createServerCopy(descriptor, resolved);\n",
        ...page('const t = C.useCopy(); return <p>{t(n)}</p>;', "import * as C from '@/lib/content';"),
      }),
    );
    expect(causesOf(usage)).toEqual(['t(n) @ app/page.tsx:2']);
  });

  it('a local function named useCopy is no binding', async () => {
    const usage = await usageOf(
      host({
        'lib/mine.ts': 'export const useCopy = () => (k: string) => k;\n',
        ...page('const t = useCopy(); return <p>{t(n)}</p>;', "import { useCopy } from '@/lib/mine';"),
      }),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_sub')).toBe('not_found');
  });

  it('useCopy re-exported through the read path or a file of the host is the hook', async () => {
    const viaReadPath = await usageOf(
      host({
        'lib/content.ts':
          "import { createServerCopy } from '@getstet/stet/react/server';\nexport { useCopy } from '@getstet/stet/react';\nexport const copy = createServerCopy(descriptor, resolved);\n",
        ...page('const t = useCopy(); return <p>{t(n)}</p>;', "import { useCopy } from '@/lib/content';"),
      }),
    );
    expect(causesOf(viaReadPath)).toEqual(['t(n) @ app/page.tsx:2']);
    const viaBarrel = await usageOf(
      host({
        'lib/hooks.ts': "export { useCopy as useText } from '@getstet/stet/react';\n",
        ...page('const t = useText(); return <p>{t(n)}</p>;', "import { useText } from '@/lib/hooks';"),
      }),
    );
    expect(causesOf(viaBarrel)).toEqual(['t(n) @ app/page.tsx:2']);
  });

  /** The wrapper under test lives in `lib/useT.ts`; `lib/useU.ts` wraps that one in turn. */
  const wrappers: Array<[string, Record<string, string>, string]> = [
    ['an arrow returning the hook', { 'lib/useT.ts': "import { useCopy } from '@getstet/stet/react';\nexport const useT = () => useCopy();\n" }, 'const t = useT();'],
    [
      'a function returning an object holding it',
      { 'lib/useT.ts': "import { useCopy } from '@getstet/stet/react';\nexport function useT() { const copy = useCopy(); return { copy }; }\n" },
      'const { copy: t } = useT();',
    ],
    [
      'a function returning it by name',
      { 'lib/useT.ts': "import { useCopy } from '@getstet/stet/react';\nexport function useT() { const c = useCopy(); return c; }\n" },
      'const t = useT();',
    ],
    [
      'a wrapper of a wrapper',
      {
        'lib/useT.ts': "import { useCopy } from '@getstet/stet/react';\nexport const useT = () => useCopy();\n",
        'lib/useU.ts': "import { useT } from './useT';\nexport const useU = () => useT();\n",
      },
      'const t = useU();',
    ],
  ];

  it.each(wrappers)('a wrapper hook (%s) is followed to its consumers, whose calls are the reads', async (_name, files, bind) => {
    const hook = /use[TU]/.exec(bind)?.[0] ?? 'useT';
    const consumer = (call: string): Record<string, string> => ({
      ...files,
      'app/page.tsx': `import { ${hook} } from '@/lib/${hook}';\nexport default function P({ n }: { n: string }) { ${bind} return <p>{${call}}</p>; }\n`,
    });
    const usage = await usageOf(host(consumer('t(n)')));
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
    expect(usage.causes.map((c) => c.text)).toEqual(['t(n)']);
    const literal = await usageOf(host(consumer('t("hero_sub")')));
    expect(stateOf(literal, 'hero_sub')).toBe('read');
    expect(literal.causes).toEqual([]);
  });

  it('only useCopy and its wrappers are hooks: another call of the same module is no binding', async () => {
    const usage = await usageOf(
      host(page('const x = CopyProvider(); return <p>{x(n)}</p>;', "import { CopyProvider } from '@getstet/stet/react';")),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_sub')).toBe('not_found');
  });

  it('a wrapper that is not exported cannot be followed: the hook call it returns is a cause', async () => {
    const usage = await usageOf(
      host(page('const t = useLocal(); return <p>{t(n)}</p>;', "import { useCopy } from '@getstet/stet/react';\nfunction useLocal() { return useCopy(); }")),
    );
    expect(causesOf(usage)).toEqual(['return useCopy(); @ app/page.tsx:2']);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('a hook result handed on in a way that cannot be followed is a cause at the hook call', async () => {
    const usage = await usageOf(
      host(page('return <p>{show(useCopy())}</p>;', "import { useCopy } from '@getstet/stet/react';\nimport { show } from '@/lib/show';"), {}),
    );
    expect(usage.causes.map((c) => c.text)).toEqual(['show(useCopy())']);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });
});

describe('the @getstet/stet exemption covers reads of the generated data alone (R-B3, F1)', () => {
  const importer = (read: string): Record<string, string> => ({
    'lib/x.ts': `import type { Descriptor } from '@getstet/stet';\n${read}\n`,
  });

  it('a file importing @getstet/stet is judged on a read rooted at the read path', async () => {
    const usage = await usageOf(host(importer("import { copy } from '@/lib/content';\nexport const get = (k: string) => copy(k);")));
    expect(causesOf(usage)).toEqual(['copy(k) @ lib/x.ts:3']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('a file importing @getstet/stet is judged on a read rooted at a copy module', async () => {
    const usage = await usageOf(
      host(
        {
          'lib/copy/hero.ts': "export const HERO = { hero_title: 'a', hero_sub: 'b' };\n",
          ...importer("import { HERO } from '@/lib/copy/hero';\nexport const all = Object.values(HERO);"),
        },
        { config: { copyModules: ['lib/copy/*.ts'] } },
      ),
    );
    expect(causesOf(usage)).toEqual(['Object.values(HERO) @ lib/x.ts:3']);
  });

  it('a file importing @getstet/stet is exempt for a read rooted at the generated defaults, the resolved module or the snapshot', async () => {
    for (const read of [
      "import { RESOLVED } from '@/content/resolved';\nexport const all = Object.keys(RESOLVED);",
      "import { DEFAULTS } from '@/content/defaults';\nexport const all = Object.keys(DEFAULTS.default);",
      "import snapshot from '@/content/defaults.json';\nexport const all = Object.keys(snapshot.default);",
    ]) {
      const usage = await usageOf(host(importer(read)));
      expect(usage.causes, read).toEqual([]);
    }
  });
});

describe('require and import() declare bindings like an import (R-require, F11)', () => {
  const dynamic = (rel: string, text: string): Record<string, string> => ({ [rel]: text });

  it.each([
    ['p10: a destructured require', 'app/page.js', "const { copy } = require('../lib/content');\nmodule.exports = function P(k) { return copy(k); };\n", 'copy(k)'],
    ['p10b: a require member', 'app/page.js', "const copy = require('../lib/content').copy;\nmodule.exports = function P(k) { return copy(k); };\n", 'copy(k)'],
    ['p10c: a required snapshot', 'app/page.js', "const d = require('../content/defaults.json');\nmodule.exports = function P(k) { return d.default[k]; };\n", 'd.default[k]'],
    ['r05: an import-equals require', 'app/page.ts', "import c = require('../lib/content');\nexport const f = (k: string) => c.copy(k);\n", 'c.copy(k)'],
    [
      'p05: an awaited import of the snapshot',
      'app/page.tsx',
      "export async function f(k: string) { const d = await import('@/content/defaults.json'); return d.default.default[k]; }\n",
      'd.default.default[k]',
    ],
    [
      'p05b: an awaited import of the read path',
      'app/page.tsx',
      "export async function f(k: string) { const m = await import('@/lib/content'); return m.copy(k); }\n",
      'm.copy(k)',
    ],
    ['p05c: an import then-destructured', 'app/page.tsx', "export const f = (k: string) => import('@/lib/content').then(({ copy }) => copy(k));\n", 'copy(k)'],
  ])('%s: the read is a cause and the key unknown', async (_name, rel, text, cause) => {
    const usage = await usageOf(host(dynamic(rel, text)));
    expect(usage.causes.map((c) => c.text)).toEqual([cause]);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('a literal key read through a required binding reads the key and raises no cause', async () => {
    const usage = await usageOf(host(dynamic('app/page.js', "const { copy } = require('../lib/content');\nmodule.exports = () => copy('hero_sub');\n")));
    expect(stateOf(usage, 'hero_sub')).toBe('read');
    expect(usage.causes).toEqual([]);
  });

  it('a module object passed around is a cause; a require of another file is not', async () => {
    const usage = await usageOf(
      host({
        'app/page.js': "const register = require('./register');\nregister(require('../lib/content'));\nregister(require('./other'));\n",
        'app/register.js': 'module.exports = () => {};\n',
        'app/other.js': 'module.exports = { go() {} };\n',
      }),
    );
    expect(usage.causes.map((c) => `${c.text} @ ${c.file}:${c.line}`)).toEqual(["require('../lib/content') @ app/page.js:2"]);
    expect(usage.files).toBe(3);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });
});

describe('a spread of the map in markup the compiler cannot read is a use (R-spread, F6)', () => {
  it.each([
    ['q11c: an Astro spread', 'src/pages/index.astro', "---\nimport { copy } from '@/lib/content';\nimport Hero from '../Hero.astro';\n---\n<Hero {...copy} />\n"],
    ['r01: a Svelte spread', 'src/S.svelte', "<script>\n import { copy } from '@/lib/content';\n import Hero from './Hero.svelte';\n</script>\n<Hero {...copy} />\n"],
    ['r03: an MDX spread', 'docs/p.mdx', "import { copy } from '@/lib/content'\nimport Hero from './Hero'\n\n<Hero {...copy} />\n"],
  ])('%s makes the whole map a cause', async (_name, rel, text) => {
    const usage = await usageOf(host({ [rel]: text }));
    expect(usage.causes.length).toBe(1);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });
});

describe('one name declared twice with different roots', () => {
  it('ends, and judges the reads of each root', async () => {
    const usage = await usageOf(
      host({
        'app/page.ts': [
          "import { copy, copyMap } from '@/lib/content';",
          'export const a = (k: string) => { const t = copy; return t(k); };',
          'export const b = () => { const t = copyMap; return Object.keys(t); };',
          '',
        ].join('\n'),
      }),
    );
    expect(causesOf(usage)).toEqual(['t(k) @ app/page.ts:2', 'Object.keys(t) @ app/page.ts:3']);
  });
});

describe('the map as a value (T2)', () => {
  it('N16: a JSX attribute carrying the map is a cause worded as the attribute', async () => {
    const usage = await usageOf(
      host({ 'app/page.tsx': "import { copyMap } from '@/lib/content';\nimport { Hero } from '@/lib/hero';\nexport default function P() { return <Hero words={copyMap} />; }\n" }),
    );
    expect(causesOf(usage)).toEqual(['words={copyMap} @ app/page.tsx:3']);
  });
});

describe('destructuring the map (R-destructure, F7)', () => {
  it.each([
    ['p06c: a computed member', "import { copyMap } from '@/lib/content';\nexport default function P({ n }: { n: string }) { const { [n]: v } = copyMap; return <h1>{v}</h1>; }\n", '[n]: v'],
    [
      'r08: a computed member under a nested pattern',
      "import { DEFAULTS } from '../content/defaults';\nexport const f = (n: string) => { const { default: { [n]: v } } = DEFAULTS; return v; };\n",
      '[n]: v',
    ],
    ['r09: a computed member of the map', "import { copyMap } from '@/lib/content';\nexport const f = (n: string) => { const {[n]: v} = copyMap; return v; };\n", '[n]: v'],
    [
      'q04: a rest under a nested pattern',
      "import { DEFAULTS } from '../content/defaults';\nconst { default: { ...rest } } = DEFAULTS;\nexport default function P({ n }: { n: string }) { return <h1>{rest[n]}</h1>; }\n",
      'rest[n]',
    ],
  ])('%s is a cause', async (_name, text, cause) => {
    const usage = await usageOf(host({ 'app/page.tsx': text }));
    expect(usage.causes.map((c) => c.text)).toEqual([cause]);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('a nested pattern naming keys reads them and raises no cause', async () => {
    const usage = await usageOf(
      host({
        'app/page.tsx':
          "import { DEFAULTS } from '../content/defaults';\nconst { default: { hero_title, nav_label: label } } = DEFAULTS;\nexport default function P() { return <h1>{hero_title}{label}</h1>; }\n",
      }),
    );
    expect(usage.causes).toEqual([]);
    expect(states(usage)).toEqual({ hero_title: 'read', hero_sub: 'not_found', hero_cta: 'not_found', nav_label: 'read', footer_note: 'not_found' });
  });

  it('a computed member that is a string literal names a key', async () => {
    const usage = await usageOf(
      host({ 'app/page.tsx': "import { copyMap } from '@/lib/content';\nconst { ['hero_sub']: v } = copyMap;\nexport default function P() { return <h1>{v}</h1>; }\n" }),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_sub')).toBe('read');
  });
});

describe('an adapter exported under another name is followed (R-adapters, F8)', () => {
  const adapter = "import { copy } from './content';\nexport default function t(k: string) { return copy(k); }\nexport const a = t('hero_title');\n";

  it('s01: a default export imported under another name disqualifies the adapter', async () => {
    const usage = await usageOf(host({ 'lib/b.ts': adapter, 'app/page.ts': "import tr from '@/lib/b';\nexport const f = (n: string) => tr(n);\n" }));
    expect(causesOf(usage)).toEqual(['copy(k) @ lib/b.ts:2']);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('s01d: a renamed destructure of the module disqualifies it', async () => {
    const usage = await usageOf(
      host({
        'lib/b.ts': "import { copy } from './content';\nexport function t(k: string) { return copy(k); }\nexport const a = t('hero_title');\n",
        'app/page.ts': "import * as B from '@/lib/b';\nconst { t: tr } = B;\nexport const f = (n: string) => tr(n);\n",
      }),
    );
    expect(causesOf(usage)).toEqual(['copy(k) @ lib/b.ts:2']);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('the alias called with a literal reads that key', async () => {
    const usage = await usageOf(host({ 'lib/b.ts': adapter, 'app/page.ts': "import tr from '@/lib/b';\nexport const f = () => tr('hero_sub');\n" }));
    expect(stateOf(usage, 'hero_sub')).toBe('read');
  });

  it('an adapter every call of which passes a key literal stays placed', async () => {
    const usage = await usageOf(
      host({
        'lib/b.ts': "import { copy } from './content';\nexport function t(k: string) { return copy(k); }\nexport const a = t('hero_title');\n",
        'app/page.ts': "import { t } from '@/lib/b';\nexport const f = () => t('hero_sub');\n",
      }),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_cta')).toBe('not_found');
  });
});

describe('step 1: the folder of the descriptor holds source too (R-content-folder, F12)', () => {
  it('q02: a page under the descriptor’s folder is scanned', async () => {
    const usage = await usageOf(
      host({ 'content/blog/post.tsx': "import { copy } from '@/lib/content';\nexport default function P() { return <h1>{copy.hero_title}</h1>; }\n" }),
    );
    expect(stateOf(usage, 'hero_title')).toBe('read');
  });

  it('skips the descriptor, the snapshot and every file codegen names, whatever header they carry', async () => {
    const usage = await usageOf(
      host({
        'content/keys.ts': "export const KEYS = ['hero_sub'] as const;\n",
        'content/keys.d.ts': "export type K = 'hero_cta';\n",
        'content/resolved.ts': "export const RESOLVED = { footer_note: 'x' };\n",
        'content/defaults.ts': "export const DEFAULTS = { nav_label: 'x' };\n",
      }, { config: { codegen: { registry: 'content/keys.ts', defaults: 'content/defaults.ts', dts: 'content/keys.d.ts', resolved: 'content/resolved.ts' } } }),
    );
    expect(Object.values(states(usage)).every((s) => s === 'not_found')).toBe(true);
    expect(usage.files).toBe(0);
  });

  it('a descriptor at the checkout’s top does not skip every file', async () => {
    const dir = host(
      { 'app/page.tsx': "import { copy } from '@/lib/content';\nexport default function P() { return <h1>{copy.hero_title}</h1>; }\n", 'descriptor.json': null },
      { config: { descriptorPath: 'descriptor.json', snapshotPath: 'defaults.json' } },
    );
    write(dir, 'descriptor.json', readFileSync(join(dir, 'content/descriptor.json'), 'utf8'));
    write(dir, 'defaults.json', readFileSync(join(dir, 'content/defaults.json'), 'utf8'));
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const usage = await usageOf(dir);
    expect(stateOf(usage, 'hero_title')).toBe('read');
    expect(usage.files).toBeGreaterThan(0);
  });
});

describe('B2: a prefix is learnt from a template head or the leftmost operand of a + chain only (R-prefix, F9)', () => {
  it.each([
    ['q06: inside an index', "import LOOKUP from '@/lib/lookup.json';\nexport const f = (id: string) => copy(LOOKUP['nav_' + id]);", { 'lib/lookup.json': '{"nav_a":"hero_title"}' }],
    ['q06b: in a conditional branch', "export const f = (id: string, other: string) => copy(id ? 'nav_' + id : other);", {}],
    ['q06c: as a ?? operand', "export const f = (other: string) => copy(other ?? 'nav_');", {}],
    ['q06d: in a call argument', "import { pick } from '@/lib/pick';\nexport const f = (id: string) => copy(pick(id, 'nav_'));", { 'lib/pick.ts': 'export const pick = (a: string, b: string) => a + b;\n' }],
    ['q06e: as an element of a const array', "const PARTS = ['nav_', 'x'];\nexport const f = (id: number) => copy(PARTS[id]);", {}],
    ['a || operand', "export const f = (id: string) => copy('nav_' || id);", {}],
    ['a trailing operand of a + chain', "export const f = (id: string) => copy(id + 'nav_');", {}],
  ])('%s teaches nothing and the read is a cause', async (_name, body, more) => {
    const usage = await usageOf(host({ 'app/page.tsx': `import { copy } from '@/lib/content';\n${body}\n`, ...more }));
    expect(usage.prefixes).toEqual([]);
    expect(usage.causes.length).toBe(1);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('the head of a template, the leftmost operand of a chain and a const that is that operand are learnt', async () => {
    const usage = await usageOf(
      host({
        'app/page.tsx': [
          "import { copy } from '@/lib/content';",
          "const SECTION = 'nav_';",
          'export const a = (id: string) => copy(`nav_${id}`);',
          "export const b = (id: string) => copy('nav_' + id + '!');",
          "export const c = (id: string) => copy(SECTION + id);",
          '',
        ].join('\n'),
      }),
    );
    expect(usage.causes).toEqual([]);
    expect(usage.prefixes.map((p) => p.prefix)).toEqual(['nav_', 'nav_', 'nav_']);
    expect(states(usage)).toEqual({
      hero_title: 'not_found',
      hero_sub: 'not_found',
      hero_cta: 'not_found',
      nav_label: 'unknown nav_',
      footer_note: 'not_found',
    });
  });
});

describe('pass 2 skips tests and stories, not any fixtures folder (R-fixtures, F13)', () => {
  const reads = "import { copy } from '@/lib/content';\nexport const x = (k: string) => copy(k);\n";

  it('app/fixtures/page.tsx is judged', async () => {
    const usage = await usageOf(host({ 'app/fixtures/page.tsx': reads }));
    expect(causesOf(usage)).toEqual(['copy(k) @ app/fixtures/page.tsx:2']);
  });

  it.each(['__fixtures__/x.tsx', 'tests/fixtures/x.tsx', 'test/fixtures/x.tsx', '__tests__/x.tsx', 'lib/a.stories.tsx', 'lib/a.spec.ts', 'lib/a.test.ts'])('%s is exempt', async (rel) => {
    const usage = await usageOf(host({ [rel]: reads }));
    expect(usage.causes).toEqual([]);
  });
});

describe('a file too deeply nested to read (F2)', () => {
  it('answers one cause, names every key by tokens and leaves the unnamed keys unknown', async () => {
    const nested = `export const c = x${'.m()'.repeat(1000)};\nexport const named = 'hero_title';\n`;
    const usage = await usageOf(host({ 'app/deep.ts': nested }));
    expect(usage.causes).toEqual([{ text: 'too deeply nested to read', file: 'app/deep.ts', line: 1 }]);
    expect(states(usage)).toEqual({ hero_title: 'read', hero_sub: 'unknown', hero_cta: 'unknown', nav_label: 'unknown', footer_note: 'unknown' });
  });
});

describe('B1 does not place a constant the code mutates (F15)', () => {
  it.each([
    ['s03: a pushed array', "const KEYS = ['hero_title'];\nexport const add = (k: string) => KEYS.push(k);\nexport const all = () => KEYS.map((k) => copy(k));", 'copy(k)'],
    ['an array spliced into', "const KEYS = ['hero_title'];\nexport const add = (k: string) => KEYS.splice(0, 0, k);\nexport const all = () => KEYS.map((k) => copy(k));", 'copy(k)'],
    ['an array unshifted onto', "const KEYS = ['hero_title'];\nexport const add = (k: string) => KEYS.unshift(k);\nexport const all = () => { for (const k of KEYS) copy(k); };", 'copy(k)'],
    ['an array filled', "const KEYS = ['hero_title'];\nexport const add = (k: string) => KEYS.fill(k);\nexport const all = () => KEYS.map((k) => copy(k));", 'copy(k)'],
    ['a map extended by Object.assign', "const LABEL: Record<string, string> = { a: 'hero_title' };\nexport const set = (o: Record<string, string>) => Object.assign(LABEL, o);\nexport const get = (s: string) => copy(LABEL[s]);", 'copy(LABEL[s])'],
    ['a property assigned onto a map', "const LABEL: Record<string, string> = { a: 'hero_title' };\nexport const set = (k: string) => { LABEL.b = k; };\nexport const get = (s: string) => copy(LABEL[s]);", 'copy(LABEL[s])'],
    ['s03b: a map assigned into', "const LABEL: Record<string, string> = { a: 'hero_title' };\nexport const set = (s: string, k: string) => { LABEL[s] = k; };\nexport const get = (s: string) => copy(LABEL[s]);", 'copy(LABEL[s])'],
  ])('%s: the read is a cause', async (_name, body, cause) => {
    const usage = await usageOf(host({ 'app/page.ts': `import { copy } from '@/lib/content';\n${body}\n` }));
    expect(usage.causes.map((c) => c.text)).toEqual([cause]);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('a constant nothing mutates is still placed', async () => {
    const usage = await usageOf(
      host({ 'app/page.ts': "import { copy } from '@/lib/content';\nconst KEYS = ['hero_title'];\nexport const all = () => KEYS.map((k) => copy(k));\n" }),
    );
    expect(usage.causes).toEqual([]);
  });
});

describe('the per-site cache (N1, N13)', () => {
  const read = (dir: string, cache: ReturnType<typeof usageCache>, keys?: string[]): Promise<KeyUsage> => {
    const config = loadConfig(dir);
    const descriptor = JSON.parse(readFileSync(join(dir, config.descriptorPath), 'utf8')) as Descriptor;
    if (keys !== undefined) descriptor.keys = Object.fromEntries(keys.map((k) => [k, { shape: 'text', target: 'web' }])) as Descriptor['keys'];
    return keyUsage(dir, config, descriptor, cache);
  };

  it('N1: a changed key set clears the facts, so a key added later is judged against the files', async () => {
    const dir = host({ 'app/page.tsx': "export const a = 'hero_sub';\nexport const b = 'hero_cta';\n" });
    const cache = usageCache();
    const first = await read(dir, cache, ['hero_title', 'hero_sub']);
    expect(states(first)).toEqual({ hero_title: 'not_found', hero_sub: 'read' });
    const second = await read(dir, cache, ['hero_title', 'hero_sub', 'hero_cta']);
    expect(states(second)).toEqual({ hero_title: 'not_found', hero_sub: 'read', hero_cta: 'read' });
  });

  it('N13: a file that vanished from the working tree leaves the cache', async () => {
    const dir = host({ 'app/gone.tsx': "export const a = 'hero_sub';\n" });
    const cache = usageCache();
    await read(dir, cache);
    expect(cache.files.has('app/gone.tsx')).toBe(true);
    rmSync(join(dir, 'app/gone.tsx'));
    await read(dir, cache);
    expect(cache.files.has('app/gone.tsx')).toBe(false);
  });

  it('a file whose size and mtime stand is not read again', async () => {
    const dir = host({ 'app/page.tsx': "export const a = 'hero_sub';\n" });
    const cache = usageCache();
    await read(dir, cache);
    const held = cache.files.get('app/page.tsx');
    await read(dir, cache);
    expect(cache.files.get('app/page.tsx')).toBe(held);
  });
});

describe('exemptions, skips and the server-only rule (N2b, N5, N6, N9)', () => {
  it('N2b: a re-export from @getstet/stet marks the file as an importer', async () => {
    const usage = await usageOf(
      host({
        'lib/y.ts': "export { loadSnapshot } from '@getstet/stet';\nimport { DEFAULTS } from '@/content/defaults';\nexport const all = Object.keys(DEFAULTS.default);\n",
      }),
    );
    expect(usage.causes).toEqual([]);
    const plain = await usageOf(host({ 'lib/y.ts': "import { DEFAULTS } from '@/content/defaults';\nexport const all = Object.keys(DEFAULTS.default);\n" }));
    expect(plain.causes.map((c) => c.text)).toEqual(['Object.keys(DEFAULTS.default)']);
  });

  it('N5: a key a route handler and a component both name is not server-only', async () => {
    const usage = await usageOf(
      host({
        'app/api/x/route.ts': "export const GET = () => 'hero_sub' + 'hero_cta';\n",
        'app/page.tsx': "export default function P() { return <p>{'hero_sub'}</p>; }\n",
      }),
    );
    expect(usage.serverOnly).toEqual(['hero_cta']);
  });

  it('N6: a module opening with the use server directive is server code', async () => {
    const usage = await usageOf(host({ 'app/actions.ts': "'use server';\nexport async function act() { return 'hero_sub'; }\n" }));
    expect(usage.serverOnly).toEqual(['hero_sub']);
  });

  it('N9: a file under .stet/ names no key', async () => {
    const usage = await usageOf(host({ '.stet/cache/x.ts': "export const a = 'hero_sub';\n" }));
    expect(stateOf(usage, 'hero_sub')).toBe('not_found');
    expect(usage.files).toBe(0);
  });
});

describe('prefixes and aliases (N12, RF5, RF8)', () => {
  it('N12: where two learnt prefixes fit a key, the longer one is named', async () => {
    const usage = await usageOf(
      host(
        {
          'app/page.ts': [
            "import { copy } from '@/lib/content';",
            'export const a = (id: string) => copy(`tier_${id}`);',
            'export const b = (id: string) => copy(`tier_solo_${id}`);',
            '',
          ].join('\n'),
        },
        { keys: ['tier_solo_name', 'tier_team_name', 'footer_note'] },
      ),
    );
    expect(states(usage)).toEqual({ tier_solo_name: 'unknown tier_solo_', tier_team_name: 'unknown tier_', footer_note: 'not_found' });
  });

  it('RF5: a member that is not a key is followed to the map it holds', async () => {
    const usage = await usageOf(
      host({ 'app/page.ts': "import { DEFAULTS } from '@/content/defaults';\nconst m = DEFAULTS.default;\nexport const f = (k: string) => m[k as keyof typeof m];\n" }),
    );
    expect(causesOf(usage)).toEqual(['m[k as keyof typeof m] @ app/page.ts:3']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('RF8: an alias of a destructured name is followed in turn', async () => {
    const usage = await usageOf(
      host({ 'app/page.ts': "import { DEFAULTS } from '@/content/defaults';\nconst { default: d } = DEFAULTS;\nconst m = d;\nexport const f = (k: string) => m[k as keyof typeof m];\n" }),
    );
    expect(causesOf(usage)).toEqual(['m[k as keyof typeof m] @ app/page.ts:4']);
  });

  it('RF8: a destructure of a member that is not a key holds the map', async () => {
    const usage = await usageOf(
      host({ 'app/page.ts': "import { DEFAULTS } from '@/content/defaults';\nconst { default: d } = DEFAULTS;\nexport const f = (k: string) => d[k as keyof typeof d];\n" }),
    );
    expect(causesOf(usage)).toEqual(['d[k as keyof typeof d] @ app/page.ts:3']);
  });
});

/** The text of each cause, in order. */
const causeTexts = (usage: KeyUsage): string[] => usage.causes.map((c) => c.text);

describe('F1: a specifier spelt as the read path, or aliased by an extended config, reaches the binding', () => {
  const use = (spec: string): string => `import { copy } from '${spec}';\nexport const r = (id: string) => copy(id);\n`;
  const readPathAs = (spec: string, file = 'lib/content.ts'): { readPath: { file: string; import: string } } => ({ readPath: { file, import: spec } });

  it.each([
    ['p31a: a bundler alias no tsconfig declares', '~/lib/content', { 'tsconfig.json': null }],
    ['p31c: a package imports specifier', '#lib/content', {}],
    ['p31d: the default alias with no tsconfig anywhere', '@/lib/content', { 'tsconfig.json': null }],
    ['p31e: a SvelteKit $lib', '$lib/content', { 'tsconfig.json': null }],
    ['p31f: a Nuxt alias, the tsconfig extending a file that is not there', '~/lib/content', { 'tsconfig.json': JSON.stringify({ extends: './.nuxt/tsconfig.json' }) }],
    ['p31g: a workspace package name', '@acme/content', {}],
  ])('%s: the read through it is a cause, the key unknown', async (_name, spec, extra) => {
    const usage = await usageOf(host({ ...extra, 'app/a.ts': use(spec) }, { config: readPathAs(spec) }));
    expect(causesOf(usage)).toEqual(['copy(id) @ app/a.ts:2']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  const base = (options: Record<string, unknown>): string => JSON.stringify({ compilerOptions: options });
  it.each([
    [
      'p31b: a relative extends',
      { 'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }), 'tsconfig.base.json': base({ baseUrl: '.', paths: { '@content': ['./lib/content'] } }) },
    ],
    [
      'an extended config in a folder: its baseUrl is read from there',
      { 'tsconfig.json': JSON.stringify({ extends: './config/base.json' }), 'config/base.json': base({ baseUrl: '..', paths: { '@content': ['lib/content'] } }) },
    ],
    [
      'an extended config with paths and no baseUrl: the paths are read from its folder',
      { 'tsconfig.json': JSON.stringify({ extends: './config/base' }), 'config/base.json': base({ paths: { '@content': ['../lib/content'] } }) },
    ],
    [
      "a child's baseUrl roots the paths it inherits",
      { 'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: { baseUrl: 'lib' } }), 'base.json': base({ paths: { '@content': ['./content'] } }) },
    ],
    [
      "a package's tsconfig",
      {
        'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig/base.json' }),
        'node_modules/@acme/tsconfig/base.json': base({ baseUrl: '../../..', paths: { '@content': ['lib/content'] } }),
      },
    ],
    [
      'a chain of two',
      {
        'tsconfig.json': JSON.stringify({ extends: './mid.json' }),
        'mid.json': JSON.stringify({ extends: './config/base.json' }),
        'config/base.json': base({ baseUrl: '..', paths: { '@content': ['lib/content'] } }),
      },
    ],
  ])('%s: the specifier lands on the read path', async (_name, extra) => {
    const usage = await usageOf(host({ ...extra, 'app/a.ts': use('@content') }));
    expect(causesOf(usage)).toEqual(['copy(id) @ app/a.ts:2']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('an extends that loops, or names nothing, ends and leaves the host unaliased', async () => {
    const usage = await usageOf(
      host({
        'tsconfig.json': JSON.stringify({ extends: './b.json' }),
        'b.json': JSON.stringify({ extends: './tsconfig.json' }),
        'app/a.ts': use('@content'),
      }),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_title')).toBe('not_found');
  });

  it('an alias nothing declares lands on a copy module or a generated module by the path past its prefix', async () => {
    const usage = await usageOf(
      host(
        {
          'tsconfig.json': null,
          'lib/copy/hero.ts': "export const HERO = { hero_title: 'a' };\n",
          'app/a.ts': [
            "import { HERO } from '~/lib/copy/hero';",
            "import { DEFAULTS } from '~/content/defaults';",
            'export const all = Object.values(HERO);',
            'export const names = Object.keys(DEFAULTS.default);',
            '',
          ].join('\n'),
        },
        { config: { copyModules: ['lib/copy/*.ts'] } },
      ),
    );
    expect(causesOf(usage)).toEqual(['Object.values(HERO) @ app/a.ts:3', 'Object.keys(DEFAULTS.default) @ app/a.ts:4']);
  });

  it('a path that no target ends is no landing, and an alias the tsconfig declares keeps its own answer', async () => {
    const usage = await usageOf(
      host({
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
        'app/a.ts': use('@/content'),
        'app/b.ts': use('~/other'),
      }),
    );
    expect(usage.causes).toEqual([]);
  });

  it.each([
    ['p30l: a .mts read path imported as .js', '../lib/content.js'],
    ['a .mts read path imported as .mjs', '../lib/content.mjs'],
  ])('%s', async (_name, spec) => {
    const usage = await usageOf(
      host(
        { 'lib/content.ts': null, 'lib/content.mts': 'export const copy = (k: string) => k;\n', 'app/a.mts': use(spec) },
        { config: readPathAs('@/lib/content.js', 'lib/content.mts') },
      ),
    );
    expect(causesOf(usage)).toEqual(['copy(id) @ app/a.mts:2']);
  });
});

describe('a bare alias no config declares reaches the binding (c4c-x1)', () => {
  const bare = (spec: string, call: string): Record<string, string | null> => ({
    'tsconfig.json': null,
    'package.json': JSON.stringify({ dependencies: { lodash: '4.17.21' } }),
    'app/a.ts': `import { copy } from '${spec}';\nexport const r = (k: string) => ${call};\n`,
  });

  it('a resolver-root alias read with a variable is a cause, the key unknown', async () => {
    const usage = await usageOf(host(bare('lib/content', 'copy(k)'), { config: { readPath: { file: 'lib/content.ts', import: '@/lib/content' } } }));
    expect(causesOf(usage)).toEqual(['copy(k) @ app/a.ts:2']);
    expect(stateOf(usage, 'nav_label')).toBe('unknown');
  });

  it('the same alias read with a literal places the key', async () => {
    const usage = await usageOf(host(bare('lib/content', "copy('hero_title')"), { config: { readPath: { file: 'lib/content.ts', import: '@/lib/content' } } }));
    expect(stateOf(usage, 'hero_title')).toBe('read');
    expect(causesOf(usage)).toEqual([]);
  });

  it('a package of the project is not the read path', async () => {
    const source = "import { createServerCopy } from '@getstet/stet/react/server';\nexport const get = createServerCopy(descriptor, resolved);\n";
    const extra = { ...bare('lodash/get', 'get(k)'), 'lodash/get.ts': source, 'app/a.ts': "import { get } from 'lodash/get';\nexport const r = (k: string) => get(k);\n" };
    const usage = await usageOf(host(extra, { config: { readPath: { file: 'lodash/get.ts', import: '@/lodash/get' } } }));
    expect(causesOf(usage)).toEqual([]);
  });
});

describe('F2: a hook called with arguments is still the hook', () => {
  it.each([
    ['p01c: a wrapper taking a section name', 'export function useSection(section: string) { return useCopy(); }', "useSection('nav')"],
    ['p33: a wrapper taking two arguments', 'export function useSection(section: string, o?: object) { return useCopy(); }', "useSection('nav', {})"],
    ['the hook itself called with an option', 'export const useSection = (o: object) => useCopy(o);', 'useSection({})'],
  ])('%s', async (_name, wrapper, call) => {
    const usage = await usageOf(
      host({
        'lib/hooks.ts': `import { useCopy } from '@getstet/stet/react';\n${wrapper}\n`,
        'app/page.tsx': `import { useSection } from '@/lib/hooks';\nexport default function P({ id }: { id: string }) { const t = ${call}; return <b>{t(id)}</b>; }\n`,
      }),
    );
    expect(causesOf(usage)).toEqual(['t(id) @ app/page.tsx:2']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });
});

describe('F3: a hook exported under another name is the hook', () => {
  const page = (imp: string): Record<string, string> => ({
    'app/page.tsx': `${imp}\nexport default function P({ id }: { id: string }) { const t = useText(); return <b>{t(id)}</b>; }\n`,
  });
  it.each([
    ['p20: an alias exported at once', "import { useCopy } from '@getstet/stet/react';\nexport const useText = useCopy;\n"],
    ['p20b: an alias exported after', "import { useCopy } from '@getstet/stet/react';\nconst useText = useCopy;\nexport { useText };\n"],
    ['an export clause renaming it', "import { useCopy } from '@getstet/stet/react';\nexport { useCopy as useText };\n"],
  ])('%s', async (_name, module) => {
    const usage = await usageOf(host({ 'lib/hooks.ts': module, ...page("import { useText } from '@/lib/hooks';") }));
    expect(causesOf(usage)).toEqual(['t(id) @ app/page.tsx:2']);
  });

  it('a default export of the hook, imported under any name', async () => {
    const usage = await usageOf(
      host({
        'lib/hooks.ts': "import { useCopy } from '@getstet/stet/react';\nexport default useCopy;\n",
        ...page("import useText from '@/lib/hooks';"),
      }),
    );
    expect(causesOf(usage)).toEqual(['t(id) @ app/page.tsx:2']);
  });

  it('an alias of something that is not the hook is no hook', async () => {
    const usage = await usageOf(
      host({
        'lib/hooks.ts': "import { useMemo } from 'react';\nexport const useText = useMemo;\n",
        ...page("import { useText } from '@/lib/hooks';"),
      }),
    );
    expect(usage.causes).toEqual([]);
  });
});

describe('F4: other ways of reaching the hook are a cause', () => {
  const comp = (imp: string, body: string): Record<string, string> => ({
    'app/a.tsx': `'use client';\n${imp}\nexport default function P({ id }: { id: string }) { ${body} }\n`,
  });
  it.each([
    ['p48a: a member of the namespace held in a const', comp("import * as R from '@getstet/stet/react';\nconst h = R.useCopy;", 'const t = h(); return <b>{t(id)}</b>;')],
    ['p48b: the hook destructured off the namespace', comp("import * as R from '@getstet/stet/react';\nconst { useCopy } = R;", 'const t = useCopy(); return <b>{t(id)}</b>;')],
    ['p48c: a member by its string name', comp("import * as R from '@getstet/stet/react';", "const t = R['useCopy'](); return <b>{t(id)}</b>;")],
  ])('%s: the read through it is a cause', async (_name, files) => {
    const usage = await usageOf(host(files));
    expect(causeTexts(usage)).toEqual(['t(id)']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it.each([
    ['p48d: the hook held in an object', comp("import { useCopy } from '@getstet/stet/react';\nconst hooks = { t: useCopy };", 'const t = hooks.t(); return <b>{t(id)}</b>;'), 't: useCopy'],
    ['the hook passed to a function', comp("import { useCopy } from '@getstet/stet/react';\nimport { wrap } from '@/lib/wrap';", 'const t = wrap(useCopy)(); return <b>{t(id)}</b>;'), 'wrap(useCopy)'],
    ['a member of the namespace passed on', comp("import * as R from '@getstet/stet/react';\nimport { wrap } from '@/lib/wrap';", 'const t = wrap(R.useCopy)(); return <b>{t(id)}</b>;'), 'wrap(R.useCopy)'],
  ])('%s: the mention is the cause', async (_name, files, cause) => {
    const usage = await usageOf(host(files));
    expect(causeTexts(usage)).toEqual([cause]);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('another member of the namespace is no mention of the hook', async () => {
    const usage = await usageOf(
      host(comp("import * as R from '@getstet/stet/react';", 'return <R.CopyProvider value={R.Fallback}><b>{id}</b></R.CopyProvider>;')),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_title')).toBe('not_found');
  });
});

describe('F5: a binding held in a default-exported object is a cause', () => {
  it('p20x: export default { copy }', async () => {
    const usage = await usageOf(
      host({
        'lib/c.ts': "import { copy } from './content';\nexport default { copy };\n",
        'app/a.ts': "import c from '@/lib/c';\nexport const r = (id: string) => c.copy(id);\n",
      }),
    );
    expect(causeTexts(usage)).toEqual(['copy']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });
});

describe('F6: a file importing stet is exempt for the generated data handed to stet alone', () => {
  it.each([
    [
      'p05: a dynamic read of the defaults beside a hook import',
      "'use client';\nimport { useCopy } from '@getstet/stet/react';\nimport { DEFAULTS } from '@/content/defaults';\nexport function fb(k: string) { return DEFAULTS.default[k as keyof typeof DEFAULTS.default]; }\nexport default function P() { const t = useCopy(); return <b>{t('hero_sub')}</b>; }\n",
    ],
    [
      'p05b: a dynamic read of the snapshot beside a core import',
      "import { resolveAll } from '@getstet/stet';\nimport snap from '@/content/defaults.json';\nexport const all = (k: string) => (snap as any).default[k];\nvoid resolveAll;\n",
    ],
    [
      'p05c: the defaults handed to a bridge in an object',
      "import { getRequestConfig } from 'next-intl/server';\nimport { resolveAll } from '@getstet/stet';\nimport { DEFAULTS } from '@/content/defaults';\nvoid resolveAll;\nexport default getRequestConfig(async () => ({ locale: 'en', messages: DEFAULTS.default }));\n",
    ],
  ])('%s: a cause', async (_name, text) => {
    const usage = await usageOf(host({ 'app/x.tsx': text }));
    expect(usage.causes).toHaveLength(1);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('the data handed to a function imported from stet, or listed by Object.keys, is exempt', async () => {
    const usage = await usageOf(
      host({
        'lib/x.ts': [
          "import { resolveAll } from '@getstet/stet';",
          "import * as stet from '@getstet/stet';",
          "import { DEFAULTS } from '@/content/defaults';",
          'export const a = resolveAll(DEFAULTS.default as never, {} as never);',
          'export const b = stet.resolveAll(DEFAULTS.default, {});',
          'export const c = Object.keys(DEFAULTS.default);',
          '',
        ].join('\n'),
      }),
    );
    expect(usage.causes).toEqual([]);
  });

  it('the data handed to a function of the host in a file importing stet is a cause', async () => {
    const usage = await usageOf(
      host({
        'lib/x.ts': "import type { Descriptor } from '@getstet/stet';\nimport { DEFAULTS } from '@/content/defaults';\nimport { show } from '@/lib/show';\nexport const a = show(DEFAULTS.default);\n",
      }),
    );
    expect(causeTexts(usage)).toEqual(['show(DEFAULTS.default)']);
  });
});

describe('F7: an accessor the host builds from stet is a root', () => {
  it.each([
    [
      'p05e: createServerCopy',
      "import { createServerCopy } from '@getstet/stet/react/server';\nimport { DEFAULTS } from '@/content/defaults';\nimport desc from '@/content/descriptor.json';\nconst own = createServerCopy(desc as any, DEFAULTS.default as any);\nexport function label(k: string) { return own(k); }\n",
    ],
    [
      'p05f: createAccessor',
      "import { createAccessor } from '@getstet/stet';\nimport { DEFAULTS } from '@/content/defaults';\nconst own = createAccessor(DEFAULTS.default as any);\nexport function label(k: string) { return own(k); }\n",
    ],
  ])('%s: a read through it is a cause', async (_name, text) => {
    const usage = await usageOf(host({ 'lib/own.ts': text }));
    expect(causeTexts(usage)).toEqual(['own(k)']);
    expect(stateOf(usage, 'hero_title')).toBe('unknown');
  });

  it('a literal key read through it names the key', async () => {
    const usage = await usageOf(
      host({ 'lib/own.ts': "import { createAccessor } from '@getstet/stet';\nconst own = createAccessor({} as any);\nexport const a = own('hero_sub');\n" }),
    );
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_sub')).toBe('read');
  });

  it('a function of the host called createAccessor is no accessor of stet', async () => {
    const usage = await usageOf(
      host({
        'lib/own.ts': "import { createAccessor } from '@/lib/mine';\nconst own = createAccessor();\nexport function label(k: string) { return own(k); }\n",
      }),
    );
    expect(usage.causes).toEqual([]);
  });
});

describe('F9: B1 places a constant only if nothing but plain reads reach it', () => {
  it.each([
    [
      'p07b: an alias that is pushed to',
      "const NAMES = ['hero_title'];\nconst alias = NAMES;\nalias.push(String(Math.random()));\nexport const a = () => NAMES.map((k) => copy(k));",
    ],
    [
      'p07c: handed to a function that pushes',
      "const NAMES = ['hero_title'];\nfunction addIt(a: string[], x: string) { a.push(x); }\naddIt(NAMES, 'n' + 'av_home');\nexport const a = () => NAMES.map((k) => copy(k));",
    ],
    ['a map handed to a function', "const LABEL: Record<string, string> = { a: 'hero_title' };\nfreeze(LABEL);\nexport const get = (s: string) => copy(LABEL[s]);"],
    ['an array exported by name', "const NAMES = ['hero_title'];\nexport { NAMES };\nexport const a = () => NAMES.map((k) => copy(k));"],
    ['an array exported as default', "const NAMES = ['hero_title'];\nexport default NAMES;\nexport const a = () => NAMES.map((k) => copy(k));"],
    ['an array returned', "const NAMES = ['hero_title'];\nexport const names = () => NAMES;\nexport const a = () => NAMES.map((k) => copy(k));"],
  ])('%s: the read is a cause', async (_name, body) => {
    const usage = await usageOf(host({ 'app/page.ts': `import { copy } from '@/lib/content';\n${body}\n` }));
    expect(usage.causes).toHaveLength(1);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('p07f: an array exported, and pushed to in another file', async () => {
    const usage = await usageOf(
      host({
        'lib/names.ts': "import { copy } from '@/lib/content';\nexport const NAMES = ['hero_title'];\nexport const all = () => NAMES.map((k) => copy(k));\n",
        'lib/mut.ts': "import { NAMES } from './names';\nNAMES.push('hero_' + 'sub');\n",
      }),
    );
    expect(causeTexts(usage)).toEqual(['copy(k)']);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('a constant read by a callback, an index, a property, a loop or a spread stays placed', async () => {
    const usage = await usageOf(
      host({
        'app/page.ts': [
          "import { copy } from '@/lib/content';",
          "const NAMES = ['hero_title'];",
          "const LABEL = { open: 'hero_sub' };",
          'export const a = () => NAMES.map((k) => copy(k));',
          'export const b = () => { for (const k of NAMES) copy(k); };',
          'export const c = NAMES.length + NAMES[0].length + [...NAMES].length;',
          'export const d = (s: string) => copy(LABEL[s]) + copy(LABEL.open);',
          '',
        ].join('\n'),
      }),
    );
    expect(usage.causes).toEqual([]);
  });
});

describe('F10: a key named like a member of the API is a read of the object where it is called or indexed', () => {
  const KEYS = ['default', 'get', 'bind', 'hero_title', 'hero_sub'];
  it.each([
    ['p43a: DEFAULTS.default[id]', "import { DEFAULTS } from '@/content/defaults';\nexport const r = (id: string) => (DEFAULTS.default as any)[id];\n", 'DEFAULTS.default as any'],
    ['p43c: copy.bind(null)', "import { copy } from '@/lib/content';\nconst t = copy.bind(null);\nexport const r = (id: string) => t(id);\n", 'copy.bind(null)'],
    ['a key named get, called with a variable', "import { copy } from '@/lib/content';\nexport const r = (id: string) => copy.get(id);\n", 'copy.get(id)'],
  ])('%s: a cause', async (_name, text, cause) => {
    const usage = await usageOf(host({ 'app/a.ts': text }, { keys: KEYS }));
    expect(causeTexts(usage)).toEqual([cause]);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('a key named like a member, read by its name, is read', async () => {
    const usage = await usageOf(
      host({ 'app/a.ts': "import { copy } from '@/lib/content';\nexport const a = copy.default;\nexport const b = copy.get('bind');\n" }, { keys: KEYS }),
    );
    expect(usage.causes).toEqual([]);
    expect(states(usage)).toEqual({ default: 'read', get: 'read', bind: 'read', hero_title: 'not_found', hero_sub: 'not_found' });
  });
});

describe('F11: a string that names the snapshot or the defaults by path is a cause', () => {
  it.each([
    ['p45a: readFileSync of the snapshot', 'scripts/feed.mjs', "import { readFileSync } from 'node:fs';\nconst snap = JSON.parse(readFileSync('content/defaults.json', 'utf8'));\nfor (const [k, v] of Object.entries(snap.default)) console.log(k, v);\n"],
    [
      'p45b: the snapshot joined from parts',
      'app/sitemap.ts',
      "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst snap = JSON.parse(readFileSync(join(process.cwd(), 'content', 'defaults.json'), 'utf8'));\nexport default () => Object.keys(snap.default);\n",
    ],
    ['p45c: fetch of the snapshot', 'app/a.ts', "export const load = async (k: string) => (await (await fetch('/content/defaults.json')).json()).default[k];\n"],
    ['p45d: a glob over the content folder', 'app/a.ts', "const mods = import.meta.glob('../content/*.json', { eager: true });\nexport const all = Object.values(mods);\n"],
    ['a template naming the defaults module', 'app/b.ts', 'export const at = (dir: string) => `${dir}/defaults.ts`;\n'],
  ])('%s', async (_name, rel, text) => {
    const usage = await usageOf(host({ [rel]: text }));
    expect(usage.causes).toHaveLength(1);
    expect(usage.causes[0]?.file).toBe(rel);
    expect(usage.causes[0]?.line).toBeGreaterThan(0);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('an import or a require of the file, a sentence naming it and a test file raise no cause', async () => {
    const usage = await usageOf(
      host({
        'lib/a.ts': "import snap from '@/content/defaults.json';\nexport const n = snap.default.hero_sub;\n",
        'lib/b.js': "const d = require('../content/defaults.json');\nexports.n = d.default.hero_title;\n",
        'lib/c.ts': "export type D = typeof import('../content/defaults.json');\n",
        'lib/d.test.ts': "export const p = 'content/defaults.json';\n",
        'lib/e.ts': "export const note = 'The committed defaults.json is read at build time.';\n",
      }),
    );
    expect(usage.causes).toEqual([]);
  });
});

describe('the survivors of the mutation pass: cases the code already answers', () => {
  const page = (body: string): Record<string, string> => ({ 'app/page.ts': `import { copy } from '@/lib/content';\n${body}\n` });

  it('K18: a const that holds a call is no key', async () => {
    const usage = await usageOf(host(page('const k = String(Math.random());\nexport const a = () => copy(k);')));
    expect(causeTexts(usage)).toEqual(['copy(k)']);
  });

  it('K09: a let that is reassigned is no key', async () => {
    const usage = await usageOf(host(page("let k = 'hero_title';\nk = String(Math.random());\nexport const a = () => copy(k);")));
    expect(causeTexts(usage)).toEqual(['copy(k)']);
  });

  it('K22: an adapter called with a variable and then a literal is not placed', async () => {
    const usage = await usageOf(
      host(page("function t(k: string) { return copy(k); }\nexport const a = (id: string) => t(id);\nexport const b = () => t('hero_title');")),
    );
    expect(causeTexts(usage)).toEqual(['copy(k)']);
    expect(stateOf(usage, 'hero_sub')).toBe('unknown');
  });

  it('K06: a module object handed on, in a file that imports stet, is a cause', async () => {
    const usage = await usageOf(
      host({
        'app/page.ts': "import type { Descriptor } from '@getstet/stet';\nconst register = (m: unknown) => m;\nregister(require('../lib/content'));\n",
      }),
    );
    expect(causeTexts(usage)).toEqual(["require('../lib/content')"]);
  });

  it('K45: a call with no argument is a cause', async () => {
    const usage = await usageOf(host(page('export const a = () => copy();')));
    expect(causeTexts(usage)).toEqual(['copy()']);
  });

  it('K48: a tagged template learns its head as a prefix', async () => {
    const usage = await usageOf(host(page('export const a = (id: string) => copy`hero_${id}`;')));
    expect(usage.causes).toEqual([]);
    expect(prefixesOf(usage)).toEqual(['hero_ @ app/page.ts:2']);
    expect(states(usage)['hero_sub']).toBe('unknown hero_');
  });

  it('K50: a for-in variable is no key', async () => {
    const usage = await usageOf(host(page("const NAMES = ['hero_title'];\nexport const a = () => { for (const k in NAMES) copy(k); };")));
    expect(causeTexts(usage)).toEqual(['copy(k)']);
  });

  it('K36: the header counts only at the very start of the file', async () => {
    const usage = await usageOf(host({ 'lib/gen.ts': "export const a = 1;\n// generated by stet\nexport const G = 'hero_sub';\n" }));
    expect(stateOf(usage, 'hero_sub')).toBe('read');
    expect(usage.files).toBe(1);
  });

  it('K44: a prefix held in a sibling constant is learnt', async () => {
    const usage = await usageOf(
      host({
        'app/page.ts': "import { DEFAULTS } from '@/content/defaults';\nimport { pick } from '@/lib/pick';\nconst HEADS = ['hero_'];\nexport const a = () => pick(DEFAULTS.default, HEADS);\n",
      }),
    );
    expect(usage.causes).toEqual([]);
    expect(prefixesOf(usage)).toEqual(['hero_ @ app/page.ts:4']);
  });

  it('K41: a scan with several roots for one name returns at once', () => {
    const dir = host({
      'app/page.ts': [
        "import { copy, copyMap } from '@/lib/content';",
        'export const a = (k: string) => { const t = copy; return t(k); };',
        'export const b = () => { const t = copyMap; return Object.keys(t); };',
        '',
      ].join('\n'),
    });
    const script = [
      `const { keyUsage } = await import(${JSON.stringify(pathToFileURL(join(packageRoot(), 'dist/cli/key-usage.js')).href)});`,
      `const { loadConfig } = await import(${JSON.stringify(pathToFileURL(join(packageRoot(), 'dist/cli/config.js')).href)});`,
      "import { readFileSync } from 'node:fs';",
      `const config = loadConfig(${JSON.stringify(dir)});`,
      `const usage = await keyUsage(${JSON.stringify(dir)}, config, JSON.parse(readFileSync(${JSON.stringify(join(dir, 'content/descriptor.json'))}, 'utf8')));`,
      'console.log(usage.causes.length);',
    ].join('\n');
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
    expect(ran.error, 'the scan did not return within 2 s').toBeUndefined();
    expect(ran.stdout.trim()).toBe('2');
  });
});

describe('D65: a source file over 5 MB is skipped on its stat, and is a cause', () => {
  const MIB = 1024 * 1024;
  const SKIPPED = 'over 5 MB, so the scan skipped it';
  /** Dense code: what a minified bundle costs the compiler. */
  const dense = (bytes: number): string => {
    const line = 'var a=function(){return {x:1,y:[1,2,3],z:"abc"}};\n';
    return line.repeat(Math.ceil(bytes / line.length));
  };

  it('a 6 MB tracked file ends in under 2 s without large heap growth; every unnamed key is unknown, with the file as the cause', async () => {
    const dir = host({ 'vendor.js': dense(6 * MIB) });
    const heap = process.memoryUsage().heapUsed;
    const started = Date.now();
    const usage = await usageOf(dir);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(200 * MIB);
    expect(usage.causes).toEqual([{ text: SKIPPED, file: 'vendor.js', line: 1 }]);
    expect(states(usage)).toEqual({ hero_title: 'unknown', hero_sub: 'unknown', hero_cta: 'unknown', nav_label: 'unknown', footer_note: 'unknown' });
    expect(usage.files).toBe(0);
  });

  it('a 4.9 MB file is still scanned', async () => {
    const usage = await usageOf(host({ 'app/big.ts': `/*${' '.repeat(Math.floor(4.9 * MIB))}*/\nexport const n = 'hero_sub';\n` }));
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_sub')).toBe('read');
    expect(stateOf(usage, 'hero_cta')).toBe('not_found');
  });

  it('an untracked file git does not ignore is skipped too', async () => {
    const dir = host({});
    write(dir, 'public/vendor.js', dense(6 * MIB));
    const usage = await usageOf(dir);
    expect(usage.causes).toEqual([{ text: SKIPPED, file: 'public/vendor.js', line: 1 }]);
    expect(stateOf(usage, 'hero_cta')).toBe('unknown');
  });

  it('a file git ignores is not a cause', async () => {
    const dir = host({ '.gitignore': 'dist/\n' });
    write(dir, 'dist/vendor.js', dense(6 * MIB));
    const usage = await usageOf(dir);
    expect(usage.causes).toEqual([]);
    expect(stateOf(usage, 'hero_cta')).toBe('not_found');
  });

  it('a file that grew past the ceiling between the stat and the read is skipped like one the stat caught', async () => {
    const dir = host({ 'app/grew.ts': "export const n = 'hero_sub';\n" });
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs')>();
      return { ...real, readFileSync: ((path: unknown, ...rest: unknown[]) => (String(path).endsWith('app/grew.ts') ? (typeof rest[0] === 'string' ? 'x'.repeat(5 * MIB + 1) : Buffer.alloc(5 * MIB + 1, 120)) : (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest))) as typeof real.readFileSync };
    });
    try {
      const fresh = await import('../cli/key-usage.js');
      const config = loadConfig(dir);
      const descriptor = JSON.parse(readFileSync(join(dir, config.descriptorPath), 'utf8')) as Descriptor;
      const usage = await fresh.keyUsage(dir, config, descriptor);
      expect(usage.causes).toEqual([{ text: SKIPPED, file: 'app/grew.ts', line: 1 }]);
      expect(stateOf(usage, 'hero_sub')).toBe('unknown');
      expect(usage.files).toBe(0);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

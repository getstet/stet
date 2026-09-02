/**
 * `stet pages scan` — the route detector, the skip taxonomy and the apply.
 *
 * Every case drives `runCli`, so the two-token dispatch, the argument split and
 * the exit codes are part of what is proven. The hosts are temp directories
 * built file by file: the detector reads directory entries and file names, so a
 * fixture IS its file list, and bodies are read only for a markdown page's
 * frontmatter under seeding.
 *
 * The site mirror is the load-bearing one — the 23-file shape of the real Astro
 * host, whose 19 proposals and 4 named skips are what "the taxonomy is
 * exhaustive by construction" means in practice.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { loadDescriptor } from '../src/descriptor.js';
import { loadSnapshot } from '../src/snapshot.js';
import { runCli, type CliIo } from '../cli/main.js';

interface Host extends CliIo {
  cwd: string;
  out: string[];
  err: string[];
  run(...argv: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  json<T>(): T;
  file(rel: string): string;
  bytes(rel: string): Buffer;
  put(rel: string, text: string): void;
}

/**
 * A host with a descriptor and NO `pages` member — the shape an adopted project
 * has before this command runs. `makeCliHost`'s mini-project is deliberately
 * NOT used: its descriptor declares `home` and `pricing`, so the site mirror
 * would yield 17 proposals there and the arithmetic would half-pass.
 */
function project(
  keys: Record<string, unknown> = {},
  defaults: Record<string, string> = {},
  pages?: Record<string, unknown>,
): Host {
  const cwd = mkdtempSync(join(tmpdir(), 'stet-pages-'));
  const out: string[] = [];
  const err: string[] = [];
  const put = (rel: string, text: string): void => {
    const path = join(cwd, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };
  put('stet.config.json', JSON.stringify({ project: 't' }, null, 2));
  // The `pages` member is ABSENT unless a case declares one — the shape the
  // command is written for, and what the apply arithmetic depends on.
  put(
    'content/descriptor.json',
    JSON.stringify(pages === undefined ? { version: 1, keys } : { version: 1, keys, pages }, null, 2),
  );
  put('content/defaults.json', JSON.stringify({ default: defaults }, null, 2));

  const io: CliIo = { cwd, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  return {
    ...io,
    cwd,
    out,
    err,
    run: (...argv: string[]) => runCli(argv, io),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    json: <T,>() => JSON.parse(out[out.length - 1] ?? 'null') as T,
    file: (rel: string) => readFileSync(join(cwd, rel), 'utf8'),
    bytes: (rel: string) => readFileSync(join(cwd, rel)),
    put,
  };
}

/** The files a fixture IS. `tree()` writes one line of markup; bodies are read only for a markdown page's frontmatter under seeding. */
function tree(host: Host, root: string, files: string[]): void {
  for (const file of files) host.put(`${root}/${file}`, '<h1>x</h1>\n');
}

const PAGE = 'export default function Page() { return null; }\n';

interface Payload {
  pages: Array<{
    name: string;
    route: string;
    file: string;
    parent?: string;
    seed?: { title?: string; description?: string };
  }>;
  skips: Array<{ file: string; reason: string; detail: string; remedy: string; name?: string }>;
}

/** The descriptor's declared page records, as the apply left them. */
function readPages(host: Host): Record<string, { route: string; parent?: string }> {
  return (JSON.parse(host.file('content/descriptor.json')) as {
    pages?: Record<string, { route: string; parent?: string }>;
  }).pages ?? {};
}

/** The proposal set as the machine sees it — the payload `--json` carries. */
async function proposed(host: Host): Promise<Payload> {
  expect(await host.run('pages', 'scan', '--json')).toBe(0);
  return host.json<Payload>();
}

/** The 23 files of the real Astro host, which is what makes the count assertions mean something. */
const SITE_MIRROR = [
  'changelog/[slug].astro',
  'changelog/index.astro',
  'custody.astro',
  'docs/adopt.astro',
  'docs/check.astro',
  'docs/edit.astro',
  'docs/index.astro',
  'docs/leave.astro',
  'docs/quickstart.astro',
  'features.astro',
  'features.md.ts',
  'gallery.astro',
  'identities/index.astro',
  'identities/option-a-platform.astro',
  'identities/option-b-cinema.astro',
  'identities/option-c-console.astro',
  'identities/option-d-zine.astro',
  'identities/styleguide.astro',
  'index.astro',
  'pricing.astro',
  'pricing.md.ts',
  'rss.xml.ts',
  'waitlist.astro',
];

const MIRROR_NAMES = [
  'changelog',
  'custody',
  'docs',
  'docs_adopt',
  'docs_check',
  'docs_edit',
  'docs_leave',
  'docs_quickstart',
  'features',
  'gallery',
  'home',
  'identities',
  'identities_option_a_platform',
  'identities_option_b_cinema',
  'identities_option_c_console',
  'identities_option_d_zine',
  'identities_styleguide',
  'pricing',
  'waitlist',
];

describe('pages scan — the detector', () => {
  it('reads a src/pages tree carrying .astro as Astro, never as Next Pages', async () => {
    // The discriminating fixture: `src/pages` satisfies init's directory-only
    // probe for BOTH conventions, and only the `.astro` file below it decides.
    // Read as Next Pages, every one of these would be `unsupported-page-type`.
    const host = project();
    tree(host, 'src/pages', ['index.astro', 'about.astro']);
    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => p.name).sort()).toEqual(['about', 'home']);
    expect(skips).toEqual([]);
  });

  it('walks both Next arms where a host runs them concurrently', async () => {
    const host = project();
    host.put('app/page.tsx', PAGE);
    host.put('pages/about.tsx', PAGE);
    const { pages } = await proposed(host);
    expect(pages.map((p) => `${p.name} ${p.route}`).sort()).toEqual(['about /about', 'home /']);
  });

  it('probes the src-rooted spellings of both Next roots', async () => {
    const host = project();
    host.put('src/app/page.tsx', PAGE);
    host.put('src/pages/about.tsx', PAGE);
    const { pages } = await proposed(host);
    expect(pages.map((p) => p.name).sort()).toEqual(['about', 'home']);
  });

  it('says what it probed where the host has no routing convention, and exits 0', async () => {
    const host = project();
    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stdout()).toContain(
      'pages scan: no routing convention detected — expected src/pages, app/ or pages/',
    );
  });

  it('never descends into a vendored tree under a routing root', async () => {
    const host = project();
    host.put('app/page.tsx', PAGE);
    host.put('app/node_modules/pkg/page.tsx', PAGE);
    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => p.route)).toEqual(['/']);
    expect(JSON.stringify(skips)).not.toContain('node_modules');
  });
});

describe('pages scan — the route walk', () => {
  it('proposes 19 pages and names 4 skips over the site mirror', async () => {
    const host = project();
    tree(host, 'src/pages', SITE_MIRROR);
    const { pages, skips } = await proposed(host);

    expect(pages.map((p) => p.name).sort()).toEqual(MIRROR_NAMES);
    expect(pages).toHaveLength(19);
    // The index collapse, both at the root and one level down.
    expect(pages.find((p) => p.name === 'home')?.route).toBe('/');
    expect(pages.find((p) => p.name === 'changelog')?.route).toBe('/changelog');
    expect(pages.find((p) => p.name === 'changelog')?.file).toBe('src/pages/changelog/index.astro');
    // The parent is the nearest ancestor route that is itself a page — and
    // `docs/adopt.astro` sorts AHEAD of `docs/index.astro`, so it is only
    // answerable once the whole set is known.
    expect(pages.find((p) => p.name === 'docs_adopt')?.parent).toBe('docs');
    expect(pages.find((p) => p.name === 'docs')?.parent).toBe('home');
    expect(pages.find((p) => p.name === 'home')?.parent).toBeUndefined();

    expect(skips.map((s) => `${s.file} ${s.reason}`)).toEqual([
      'src/pages/changelog/[slug].astro dynamic-route',
      'src/pages/features.md.ts endpoint',
      'src/pages/pricing.md.ts endpoint',
      'src/pages/rss.xml.ts endpoint',
    ]);
    // An endpoint keeps every earlier dot: the route it serves is `/features.md`.
    expect(skips.find((s) => s.file === 'src/pages/features.md.ts')?.detail).toContain('/features.md');
  });

  it('splits the Astro page types by extension, and refuses an unnameable route', async () => {
    const host = project();
    tree(host, 'src/pages', ['legacy.html', 'notes.md', 'data.json', 'widget.tsx', 'café.astro']);
    const { pages, skips } = await proposed(host);
    // `.html` and `.md` are real Astro page types; a markdown page with no
    // frontmatter block proposes with no seed, like any other route.
    expect(pages.map((p) => `${p.name} ${p.route}`)).toEqual(['legacy /legacy', 'notes /notes']);
    expect(pages.find((p) => p.name === 'notes')?.seed).toBeUndefined();
    expect(skips.map((s) => `${s.file} ${s.reason}`).sort()).toEqual([
      'src/pages/café.astro unnameable',
      'src/pages/data.json unsupported-page-type',
      'src/pages/widget.tsx unsupported-page-type',
    ]);
    // Naming never happened, so the skip carries no name to select by — a
    // transliterated `caf` would be a silent rename.
    expect(skips.find((s) => s.reason === 'unnameable')?.name).toBeUndefined();
  });

  it('reads Next App by its page enumeration, its groups and its route forms', async () => {
    const host = project();
    host.put('app/page.tsx', PAGE);
    host.put('app/(marketing)/about/page.tsx', PAGE);
    host.put('app/docs/[slug]/page.tsx', PAGE);
    host.put('app/@modal/x/page.tsx', PAGE);
    host.put('app/(...)photo/page.tsx', PAGE);
    host.put('app/api/hello/route.ts', 'export function GET() { return null; }\n');
    host.put('app/dashboard/layout.tsx', PAGE);
    host.put('app/dashboard/loading.tsx', PAGE);
    host.put('app/dashboard/page.module.css', '.x { color: red }\n');
    host.put('app/_lib/util.tsx', 'export const util = 1;\n');

    const { pages, skips } = await proposed(host);
    // The group leaves no phantom segment in the route OR the name.
    expect(pages.map((p) => `${p.name} ${p.route}`).sort()).toEqual(['about /about', 'home /']);
    expect(skips.map((s) => `${s.file} ${s.reason}`).sort()).toEqual([
      'app/(...)photo/page.tsx unsupported-route-form',
      'app/@modal/x/page.tsx unsupported-route-form',
      'app/api/hello/route.ts endpoint',
      'app/docs/[slug]/page.tsx dynamic-route',
    ]);
    // Colocation is the framework's own contract, so it is EXCLUDED rather than
    // skipped — and `page.module.css` is why the enumeration is not a `page.*`
    // glob: it would collide with the page beside it on every CSS-Modules host.
    const reported = JSON.stringify(skips);
    for (const quiet of ['layout.tsx', 'loading.tsx', 'page.module.css', '_lib']) {
      expect(reported).not.toContain(quiet);
    }
  });

  it('reads Next Pages by path, with Astro’s own index collapse', async () => {
    const host = project();
    host.put('pages/index.tsx', PAGE);
    host.put('pages/about.tsx', PAGE);
    host.put('pages/docs/index.tsx', PAGE);
    host.put('pages/blog/[id].tsx', PAGE);
    host.put('pages/util.ts', 'export const util = 1;\n');
    host.put('pages/_app.tsx', PAGE);
    host.put('pages/_document.tsx', PAGE);
    host.put('pages/_error.tsx', PAGE);
    host.put('pages/404.tsx', PAGE);
    host.put('pages/api/hello.ts', 'export default function handler() {}\n');

    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => `${p.name} ${p.route}`).sort()).toEqual([
      'about /about',
      'docs /docs',
      'home /',
    ]);
    expect(skips.map((s) => `${s.file} ${s.reason}`).sort()).toEqual([
      'pages/blog/[id].tsx dynamic-route',
      'pages/util.ts unsupported-page-type',
    ]);
    const reported = JSON.stringify(skips);
    for (const quiet of ['_app', '_document', '_error', '404', 'api/hello']) {
      expect(reported).not.toContain(quiet);
    }
  });

  it('proposes a route whose name is a prototype member', async () => {
    // The own-property witness: `'constructor' in {}` answers TRUE from the
    // prototype, and a bare membership test would call this route already
    // declared on a host that declares no pages at all.
    const host = project();
    tree(host, 'src/pages', ['constructor.astro']);
    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => `${p.name} ${p.route}`)).toEqual(['constructor /constructor']);
    expect(skips).toEqual([]);
  });

  it('routes a reserved Next Pages name that sits below the tree root', async () => {
    // `pages/404.tsx` is the custom 404; `pages/docs/404.tsx` is the ordinary
    // route `/docs/404`, and only the tree ROOT reserves the five names.
    const host = project();
    host.put('pages/docs/404.tsx', PAGE);
    const { pages } = await proposed(host);
    expect(pages.map((p) => `${p.name} ${p.route}`)).toEqual(['docs_404 /docs/404']);
  });

  it('excludes a page inside a private folder from both channels', async () => {
    // A `_private` folder is not a route segment, so `app/_lib/page.tsx` is
    // neither proposed nor skipped — and it has to be a `page.tsx` to prove it:
    // the page-name enumeration silences `_lib/util.tsx` on its own.
    const host = project();
    host.put('app/page.tsx', PAGE);
    host.put('app/_lib/page.tsx', PAGE);
    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => p.route)).toEqual(['/']);
    expect(JSON.stringify(skips)).not.toContain('_lib');
  });

  it('reports a route two arms both serve as a collision naming both files', async () => {
    const host = project();
    host.put('app/page.tsx', PAGE);
    host.put('pages/index.tsx', PAGE);
    const { pages, skips } = await proposed(host);
    // The union is sorted by file path, so `app/page.tsx` is the earlier one.
    expect(pages.map((p) => p.file)).toEqual(['app/page.tsx']);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.file).toBe('pages/index.tsx');
    expect(skips[0]?.reason).toBe('name-collision');
    expect(skips[0]?.detail).toContain('app/page.tsx');
    expect(skips[0]?.name).toBe('home');
  });
});

describe('pages scan — a key the host already declares', () => {
  /** A host-authored key: its own limits, its own label, and real committed copy. */
  const AUTHORED = {
    shape: 'text',
    target: 'web',
    label: 'Pricing page title',
    limits: { max: 60, severity: 'hard' },
  };
  const COPY = 'Pricing — every plan, side by side';

  it('refuses to scaffold over it, and the definition and copy survive the apply', async () => {
    const host = project({ seo_pricing_title: AUTHORED }, { seo_pricing_title: COPY });
    tree(host, 'src/pages', ['index.astro', 'pricing.astro']);

    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => p.name)).toEqual(['home']);
    const skip = skips.find((s) => s.reason === 'key-collision');
    expect(skip?.file).toBe('src/pages/pricing.astro');
    expect(skip?.detail).toContain('"seo_pricing_title"');
    expect(skip?.name).toBe('pricing');

    // The bare apply declares `home` and writes NOTHING for `pricing`: no
    // record, and the host's own key definition and its committed copy are
    // exactly what they were. Overwriting either would be a silent data loss at
    // exit 0, under a line reading "scaffolded empty".
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(Object.keys(descriptor.pages ?? {})).toEqual(['home']);
    expect(descriptor.keys['seo_pricing_title']).toEqual(AUTHORED);
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    const stored = snapshot['default']?.['seo_pricing_title'];
    expect(typeof stored).toBe('string');
    expect(Buffer.from(String(stored), 'utf8').equals(Buffer.from(COPY, 'utf8'))).toBe(true);

    // By name, the same refusal — and it says which one it was.
    expect(await host.run('pages', 'scan', '--apply', 'pricing')).toBe(2);
    expect(host.stderr()).toContain('was skipped (key-collision)');
  });

  it('refuses to blank a snapshot value that has no descriptor entry at all', async () => {
    // The write is TWO writes, so the guard covers both. A snapshot value with
    // no key is a warn-level orphan `stet check` stays green over — which is
    // exactly the shape a human's unfinished draft takes, and scaffolding over
    // it would replace real copy with `""` at exit 0.
    const DRAFT = 'Team — Mirra';
    const host = project({}, { seo_team_title: DRAFT });
    tree(host, 'src/pages', ['index.astro', 'team.astro']);

    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => p.name)).toEqual(['home']);
    const skip = skips.find((s) => s.reason === 'key-collision');
    expect(skip?.file).toBe('src/pages/team.astro');
    expect(skip?.detail).toContain('the snapshot already carries copy under the key "seo_team_title"');

    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(Object.keys(descriptor.pages ?? {})).toEqual(['home']);
    expect(descriptor.keys['seo_team_title']).toBeUndefined();
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    const stored = snapshot['default']?.['seo_team_title'];
    expect(typeof stored).toBe('string');
    expect(Buffer.from(String(stored), 'utf8').equals(Buffer.from(DRAFT, 'utf8'))).toBe(true);
  });

  it('names the declared page that reads the key', async () => {
    const host = project(
      {
        seo_pricing_title: { shape: 'text', target: 'web' },
        seo_pricing_desc: { shape: 'text', target: 'web' },
      },
      { seo_pricing_title: 'Plans', seo_pricing_desc: 'Every plan, side by side' },
      { plans: { route: '/plans', seo: { title: 'seo_pricing_title', description: 'seo_pricing_desc' } } },
    );
    tree(host, 'src/pages', ['pricing.astro']);

    const { pages, skips } = await proposed(host);
    expect(pages).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.reason).toBe('key-collision');
    // Not a name clash — somebody else's declaration, and saying whose is what
    // turns the remedy into a decision the reader can actually make.
    expect(skips[0]?.detail).toContain('page "plans"');
    expect(skips[0]?.remedy).toContain('declare this page by hand referencing the existing keys');
  });
});

describe('pages scan — the command', () => {
  it('is two-token: a bare or wrong subcommand is a usage error', async () => {
    const host = project();
    expect(await host.run('pages')).toBe(2);
    expect(host.stderr()).toContain('stet pages scan');
    expect(await host.run('pages', 'list')).toBe(2);
    expect(host.stderr()).toContain('stet pages has one subcommand, scan — got "list"');
  });

  it('is offline by contract — --env is refused before anything is read', async () => {
    const host = project();
    expect(await host.run('pages', 'scan', '--env', 'prod')).toBe(2);
    expect(host.stderr()).toContain('offline by contract');
  });

  it('refuses a selection name on the wrong side of --apply', async () => {
    const host = project();
    tree(host, 'src/pages', ['index.astro']);
    expect(await host.run('pages', 'scan', 'pricing')).toBe(2);
    expect(host.stderr()).toContain('stet pages scan: selection names go after --apply — got "pricing"');
  });

  it('prints the proposals and writes nothing without --apply', async () => {
    const host = project({ hero: { shape: 'text', target: 'web' } }, { hero: 'Hi' });
    tree(host, 'src/pages', ['index.astro', 'docs/index.astro', 'docs/adopt.astro']);
    const before = { d: host.bytes('content/descriptor.json'), s: host.bytes('content/defaults.json') };

    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stdout()).toContain('home (/)');
    expect(host.stdout()).toContain('  seo: seo_home_title, seo_home_desc — scaffolded empty');
    expect(host.stdout()).toContain('docs_adopt (/docs/adopt)');
    expect(host.stdout()).toContain('pages scan: run with --apply to declare these pages');

    expect(host.bytes('content/descriptor.json').equals(before.d)).toBe(true);
    expect(host.bytes('content/defaults.json').equals(before.s)).toBe(true);
  });

  it('prints a skip on the finding channel with its reason, detail and remedy', async () => {
    const host = project();
    tree(host, 'src/pages', ['index.astro', 'changelog/[slug].astro']);
    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stderr()).toContain(
      'src/pages/changelog/[slug].astro: skipped (dynamic-route) — /changelog/[slug] is a route template',
    );
    expect(host.stderr()).toContain('declare the route pattern by hand');
  });
});

describe('pages scan --apply', () => {
  /**
   * The bespoke apply host: the site mirror over a descriptor with keys and no
   * pages — and a CURRENT codegen trio, because that is what an adopted host
   * carries and it is what makes `stet check`'s currency gate answerable.
   */
  function applyHost(): Host {
    const host = project({ hero_headline: { shape: 'text', target: 'web' } }, { hero_headline: 'Never miss a post.' });
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    const { keysTs, dts } = generateRegistry(descriptor);
    host.put('content/keys.ts', keysTs);
    host.put('content/stet-env.d.ts', dts);
    host.put('content/defaults.ts', generateDefaultsModule(snapshot));
    tree(host, 'src/pages', SITE_MIRROR);
    return host;
  }

  it('starts from a host whose generated files are already current', async () => {
    expect(await applyHost().run('check')).toBe(0);
  });

  it('lands the records, the keys and the codegen in one batch the descriptor survives', async () => {
    const host = applyHost();
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    expect(host.stdout()).toContain('declared 19 page(s), scaffolded 38 key(s); next: stet seo check');

    // The atomicity witness, and it is BIDIRECTIONAL: a record whose keys did
    // not land and a key naming a record that did not each throw here.
    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(Object.keys(descriptor.pages ?? {}).sort()).toEqual(MIRROR_NAMES);
    expect(descriptor.pages?.['docs_adopt']).toEqual({
      route: '/docs/adopt',
      parent: 'docs',
      seo: { title: 'seo_docs_adopt_title', description: 'seo_docs_adopt_desc' },
    });
    // The page span the changeset preview reads: without it the key belongs to
    // no page and the span is silently empty.
    expect(descriptor.keys['seo_docs_adopt_title']).toEqual({
      shape: 'text',
      target: 'web',
      pages: ['docs_adopt'],
    });
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    expect(snapshot['default']?.['seo_home_desc']).toBe('');
    expect(snapshot['default']?.['hero_headline']).toBe('Never miss a post.');

    // The codegen trio rides the batch: the keys must typecheck without an
    // intervening `stet upgrade`, and `generateRegistry` stamps the WHOLE
    // descriptor's source hash, so the records alone would stale it.
    const { keysTs, dts } = generateRegistry(descriptor);
    expect(host.bytes('content/keys.ts').equals(Buffer.from(keysTs, 'utf8'))).toBe(true);
    expect(host.bytes('content/stet-env.d.ts').equals(Buffer.from(dts, 'utf8'))).toBe(true);
    expect(
      host.bytes('content/defaults.ts').equals(Buffer.from(generateDefaultsModule(snapshot), 'utf8')),
    ).toBe(true);

    // Empty passes every offline gate — there is no minimum length anywhere.
    expect(await host.run('check')).toBe(0);
    expect(await host.run('scan')).toBe(0);
  });

  it('arms the SEO check with exactly the red it announced', async () => {
    const host = applyHost();
    // The vacuous pass FIRST, so "the warn is gone" below is a fact about this
    // host rather than about a warn that never had a reason to fire.
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).toContain('no pages declared — the SEO rules have nothing to check');
    expect(host.stdout()).toContain('seo: 0 pages checked');
    const vacuous = host.err.length;

    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    expect(host.stdout()).toContain(
      'seo check will now report 19 more missing titles and 19 more missing descriptions — ' +
        'write the empty values and re-run stet seo check',
    );

    expect(await host.run('seo', 'check', '--json')).toBe(1);
    const payload = host.json<{ seo: Array<{ rule: string }> }>();
    // Counted through the rule ids: the human channel prints no rule id at all,
    // so a stderr grep for `missing-description` counts zero.
    expect(payload.seo.filter((f) => f.rule === 'missing-description')).toHaveLength(19);
    expect(payload.seo.filter((f) => f.rule === 'missing-title')).toHaveLength(19);
    expect(
      payload.seo.filter((f) => f.rule !== 'missing-description' && f.rule !== 'missing-title'),
    ).toEqual([]);

    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stdout()).toContain('seo: 19 pages checked');
    // Sliced past the vacuous run above: the warn is gone from the runs that
    // followed the apply, which is what the 4g remedy promised.
    expect(host.err.slice(vacuous).join('\n')).not.toContain('no pages declared');
  });

  it('is idempotent: a second run declares nothing and keeps every skip its own reason', async () => {
    const host = applyHost();
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);

    const { pages, skips } = await proposed(host);
    expect(pages).toEqual([]);
    expect(skips.filter((s) => s.reason === 'already-declared')).toHaveLength(19);
    // A skip-class route never becomes `already-declared` — it was never
    // declared, and its reason is still the reason it was refused.
    expect(skips.filter((s) => s.reason !== 'already-declared').map((s) => s.reason).sort()).toEqual([
      'dynamic-route',
      'endpoint',
      'endpoint',
      'endpoint',
    ]);
    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stdout()).toContain('pages scan: nothing to propose');
  });

  it('backfills the parent of an already-declared page whose ancestor lands later', async () => {
    const host = applyHost();
    // The child first: its ancestor is not declared, so it records no parent.
    expect(await host.run('pages', 'scan', '--apply', 'docs_adopt')).toBe(0);
    expect(readPages(host)['docs_adopt']?.parent).toBeUndefined();

    // The ancestor lands, and the fill happens in the same batch, on its own
    // line — without it a page declared before its ancestor stays parentless
    // forever.
    const since = host.out.length;
    expect(await host.run('pages', 'scan', '--apply', 'docs')).toBe(0);
    expect(readPages(host)['docs_adopt']?.parent).toBe('docs');
    expect(host.out.slice(since).join('\n')).toContain('backfilled parent on 1 page(s)');
    expect(await host.run('check')).toBe(0);
  });

  it('never rewrites a parent that is already set', async () => {
    const host = applyHost();
    // `home` and the child together: the child's nearest DECLARED ancestor is
    // `home`, so the backfill fills that.
    expect(await host.run('pages', 'scan', '--apply', 'home', 'docs_adopt')).toBe(0);
    expect(readPages(host)['docs_adopt']?.parent).toBe('home');

    // `docs` is nearer, and the fill still leaves the recorded parent alone: a
    // present `parent` is the developer's word.
    expect(await host.run('pages', 'scan', '--apply', 'docs')).toBe(0);
    expect(readPages(host)['docs_adopt']?.parent).toBe('home');
  });

  it('writes for a fillable parent alone, with nothing left to propose', async () => {
    const host = applyHost();
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    // The parent taken back out by hand — the shape a host that declared its
    // pages before this fill existed carries.
    const descriptor = JSON.parse(host.file('content/descriptor.json')) as {
      pages: Record<string, { parent?: string }>;
    };
    delete descriptor.pages['docs_adopt']!.parent;
    host.put('content/descriptor.json', `${JSON.stringify(descriptor, null, 2)}\n`);

    const since = host.out.length;
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    const printed = host.out.slice(since).join('\n');
    expect(readPages(host)['docs_adopt']?.parent).toBe('docs');
    expect(printed).toContain('wrote content/descriptor.json');
    expect(printed).toContain('backfilled parent on 1 page(s)');
    // Nothing was declared, so neither the count line nor the red the close
    // line announces belongs to this run.
    expect(printed).not.toContain('declared ');
    expect(printed).not.toContain('seo check will');
    expect(await host.run('check')).toBe(0);
  });

  it('prints both lines on a run that lands and fills', async () => {
    const host = applyHost();
    expect(await host.run('pages', 'scan', '--apply', 'docs_adopt')).toBe(0);
    const since = host.out.length;
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    const printed = host.out.slice(since).join('\n');
    expect(printed).toContain('declared 18 page(s), scaffolded 36 key(s); next: stet seo check');
    expect(printed).toContain('backfilled parent on 1 page(s)');
    expect(readPages(host)['docs_adopt']?.parent).toBe('docs');
  });

  it('declares one named page and leaves every other entry alone', async () => {
    const host = applyHost();
    const before = { d: host.file('content/descriptor.json'), s: host.file('content/defaults.json') };
    expect(await host.run('pages', 'scan', '--apply', 'pricing')).toBe(0);
    expect(host.stdout()).toContain('declared 1 page(s), scaffolded 2 key(s); next: stet seo check');

    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(Object.keys(descriptor.pages ?? {})).toEqual(['pricing']);
    expect(Object.keys(descriptor.keys).sort()).toEqual([
      'hero_headline',
      'seo_pricing_desc',
      'seo_pricing_title',
    ]);
    // `pricing`'s ancestor is `home`, which this run did not declare — so no
    // parent is recorded. The field is re-filtered at WRITE time to
    // (landed ∪ declared): nothing validates `parent`, so a pointer at a page
    // nobody declared would sit there as silent residue.
    expect(descriptor.pages?.['pricing']?.parent).toBeUndefined();
    expect(before.d).not.toBe(host.file('content/descriptor.json'));
    expect(before.s).not.toBe(host.file('content/defaults.json'));
    // The trio changes on EVERY apply, because the source hash covers the whole
    // descriptor — so `stet check`'s currency gate stays green.
    expect(await host.run('check')).toBe(0);
  });

  it('counts the announced red as ADDITIONS on a host that already carries one', async () => {
    // The one host where the distinction is live: every other apply fixture
    // starts from zero declared pages, where "how many I added" and "how many
    // there are" coincide and a flat count would pass unnoticed. Here `home` is
    // already declared with its own empty description, so the check will report
    // TWO — and only ONE of them is this run's doing.
    const host = project(
      {
        seo_home_title: { shape: 'text', target: 'web' },
        seo_home_desc: { shape: 'text', target: 'web' },
      },
      { seo_home_title: 'Home', seo_home_desc: '' },
      { home: { route: '/', seo: { title: 'seo_home_title', description: 'seo_home_desc' } } },
    );
    tree(host, 'src/pages', ['index.astro', 'pricing.astro']);

    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    expect(host.stdout()).toContain('declared 1 page(s), scaffolded 2 key(s); next: stet seo check');
    expect(host.stdout()).toContain('seo check will now report 1 more missing titles and 1 more missing descriptions');

    expect(await host.run('seo', 'check', '--json')).toBe(1);
    const payload = host.json<{ seo: Array<{ rule: string; page?: string }> }>();
    expect(payload.seo.filter((f) => f.rule === 'missing-description').map((f) => f.page).sort()).toEqual([
      'home',
      'pricing',
    ]);
  });

  it('refuses a name nothing proposed, naming what did happen to it', async () => {
    const host = applyHost();
    expect(await host.run('pages', 'scan', '--apply', 'nosuch')).toBe(2);
    expect(host.stderr()).toContain('--apply nosuch: nothing was proposed under that name');
    expect(host.stderr()).toContain('proposed: ');

    // A name that SKIPPED is a different mistake with a different fix, and the
    // refusal says which one it was.
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    expect(await host.run('pages', 'scan', '--apply', 'home')).toBe(2);
    expect(host.stderr()).toContain('was skipped (already-declared)');
  });
});

/**
 * The one content read this command makes. The Astro arm is confirmed by an
 * `.astro` file (pages.ts's own decisive probe), so every markdown fixture here
 * sits beside `src/pages/index.astro` — a markdown-only tree detects no
 * convention at all, which is a fact about the detector rather than about
 * seeding.
 */
describe('pages scan — a markdown page seeds from its frontmatter', () => {
  const GUIDE = '---\ntitle: "The guide"\ndescription: Read this first\n---\n# Guide\n';

  it('proposes the route, shows the seed in the plan, and writes it at --apply', async () => {
    const host = project();
    host.put('src/pages/index.astro', '<h1>x</h1>\n');
    host.put('src/pages/guide.md', GUIDE);

    const { pages } = await proposed(host);
    // `--json` carries the seed as read, so a CI consumer sees the same two
    // values the plan printed.
    expect(pages.find((p) => p.name === 'guide')).toMatchObject({
      name: 'guide',
      route: '/guide',
      file: 'src/pages/guide.md',
      seed: { title: 'The guide', description: 'Read this first' },
    });

    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stdout()).toContain('  seo: seo_guide_title, seo_guide_desc — seeded from frontmatter');
    expect(host.stdout()).toContain('  title: "The guide"');
    expect(host.stdout()).toContain('  description: "Read this first"');

    expect(await host.run('pages', 'scan', '--apply', 'guide')).toBe(0);
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    expect(snapshot['default']?.['seo_guide_title']).toBe('The guide');
    expect(snapshot['default']?.['seo_guide_desc']).toBe('Read this first');
  });

  it('proposes a markdown page with no frontmatter exactly as any other route', async () => {
    const host = project();
    host.put('src/pages/index.astro', '<h1>x</h1>\n');
    host.put('src/pages/notes.mdx', '# Notes\n\nNo frontmatter here.\n');

    const { pages } = await proposed(host);
    expect(pages.find((p) => p.name === 'notes')?.seed).toBeUndefined();
    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stdout()).toContain('  seo: seo_notes_title, seo_notes_desc — scaffolded empty');

    expect(await host.run('pages', 'scan', '--apply', 'notes')).toBe(0);
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    expect(snapshot['default']?.['seo_notes_title']).toBe('');
    expect(snapshot['default']?.['seo_notes_desc']).toBe('');
  });

  it('skips a dynamic markdown route like any other route template', async () => {
    const host = project();
    host.put('src/pages/index.astro', '<h1>x</h1>\n');
    host.put('src/pages/[slug].md', GUIDE);

    const { pages, skips } = await proposed(host);
    expect(pages.map((p) => p.name)).toEqual(['home']);
    expect(skips.map((s) => `${s.file} ${s.reason}`)).toEqual(['src/pages/[slug].md dynamic-route']);
  });

  it('reads two one-line scalars and nothing else, a BOM before the block included', async () => {
    const host = project();
    host.put('src/pages/index.astro', '<h1>x</h1>\n');
    // A folded scalar is not a one-line scalar, and a quoted value whose
    // closing quote is not the last character carries a comment this reader
    // will not parse — each yields no seed for its field while the block's
    // other field still reads.
    host.put('src/pages/folded.md', '---\ntitle: >\n  folded\ndescription: Plain\n---\n');
    host.put('src/pages/commented.md', '---\ntitle: "X" # note\ndescription: Plain # trailing\n---\n');
    host.put('src/pages/bom.md', '\ufeff---\ntitle: Byte order mark\n---\n');

    const { pages } = await proposed(host);
    const seedOf = (name: string) => pages.find((p) => p.name === name)?.seed;
    expect(seedOf('folded')).toEqual({ description: 'Plain' });
    // The unquoted value IS cut at its first ` #`, which is why the quoted one
    // has to refuse rather than cut: the quote is the author saying where the
    // value ends.
    expect(seedOf('commented')).toEqual({ description: 'Plain' });
    expect(seedOf('bom')).toEqual({ title: 'Byte order mark' });
  });

  it('names the difference when a declared page and its frontmatter have drifted', async () => {
    const host = project(
      { seo_guide_title: { shape: 'text', target: 'web' } },
      { seo_guide_title: 'Old' },
      { guide: { route: '/guide', seo: { title: 'seo_guide_title' } } },
    );
    host.put('src/pages/index.astro', '<h1>x</h1>\n');
    host.put('src/pages/guide.md', '---\ntitle: New\n---\n');

    const { skips } = await proposed(host);
    const skip = skips.find((s) => s.file === 'src/pages/guide.md');
    expect(skip?.reason).toBe('already-declared');
    expect(skip?.detail).toContain("frontmatter title differs from seo_guide_title's default");
    // Nothing is written: the divergence is named, never resolved.
    expect(JSON.parse(host.file('content/defaults.json')).default.seo_guide_title).toBe('Old');
  });

  it('closes on what it actually wrote: nothing new where every value was seeded', async () => {
    const host = project();
    host.put('src/pages/index.astro', '<h1>x</h1>\n');
    host.put('src/pages/guide.md', GUIDE);
    host.put('src/pages/notes.mdx', '# Notes\n');

    expect(await host.run('pages', 'scan', '--apply', 'guide')).toBe(0);
    expect(host.stdout()).toContain(
      'seo check will report nothing new — the scaffolded values were seeded from frontmatter',
    );

    const sinceGuide = host.out.length;
    expect(await host.run('pages', 'scan', '--apply', 'notes')).toBe(0);
    expect(host.out.slice(sinceGuide).join('\n')).toContain(
      'seo check will now report 1 more missing titles and 1 more missing descriptions — ' +
        'write the empty values and re-run stet seo check',
    );
  });
});

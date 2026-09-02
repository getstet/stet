/**
 * `stet remove` — the key delete over the five repo forms, driven in process
 * against a temp-directory host.
 *
 * The command is offline by construction, so every case here is a real run:
 * argument parsing, the check loaders, the descriptor validator as the
 * reference gate, the plan, and the all-or-nothing write batch.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import {
  cleanupCliHosts,
  countingStore as counting,
  makeCliHost as makeHost,
  type CliHost as Host,
} from '../conformance/cli-host.js';
import { generateDefaultsModule, generateRegistry } from '../src/codegen.js';
import { loadDescriptor, loadSnapshot } from '../src/index.js';
import type { Descriptor, KeyDef } from '../src/types.js';
import type { Snapshot } from '../src/snapshot.js';

afterAll(cleanupCliHosts);

/**
 * A host over a hand-built descriptor and snapshot.
 *
 * The mini project cannot state these cases: every one of its derivers is
 * page-referenced, so its derivation pairs refuse on the page path rather than
 * on the pair, and no fixture project would declare a key named `constructor`.
 */
function bespokeHost(descriptor: Descriptor, snapshot: Snapshot, config: Record<string, unknown> = {}): Host {
  const host = makeHost({ config });
  const put = (rel: string, text: string): void => writeFileSync(join(host.cwd, rel), text, 'utf8');
  put('content/descriptor.json', `${JSON.stringify(descriptor, null, 2)}\n`);
  put('content/defaults.json', `${JSON.stringify(snapshot, null, 2)}\n`);
  const registry = generateRegistry(descriptor);
  put('content/keys.ts', registry.keysTs);
  put('content/stet-env.d.ts', registry.dts);
  put('content/defaults.ts', generateDefaultsModule(snapshot));
  return host;
}

/** The bytes of a repo form, for the claims that are about bytes. */
function bytes(host: Host, rel: string): Buffer {
  return readFileSync(join(host.cwd, rel));
}

/** A key and its deriver, in a descriptor with no `pages` block to reference either. */
const PAIR: Descriptor = {
  version: 1,
  keys: {
    hero_headline: { shape: 'text', target: 'web' },
    seo_home_title: { shape: 'text', target: 'web', derivesFrom: 'hero_headline', tmpl: '{v} — Mirra' },
    blog_intro: { shape: 'text', target: 'web' },
  },
};
const PAIR_VALUES: Snapshot = { default: { hero_headline: 'Never miss a post.', blog_intro: 'Notes.' } };

/** One key valued in TWO locale blocks — the mini project's second locale carries a blocked key. */
const TWO_LOCALE: Descriptor = {
  version: 1,
  keys: {
    footer_note: { shape: 'text', target: 'web' },
    blog_intro: { shape: 'text', target: 'web' },
  },
};
const TWO_LOCALE_VALUES: Snapshot = {
  default: { footer_note: 'Made in Dublin', blog_intro: 'Notes.' },
  es: { footer_note: 'Hecho en Dublín' },
  // A third block that does NOT carry the key — what the plan's per-locale
  // guard is for, and what indexing every locale for every key would read.
  de: { blog_intro: 'Notizen.' },
};

describe('remove — arguments and loading', () => {
  it('takes at least one key, and teaches the variadic form when it gets none', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove')).toBe(2);
    expect(host.stderr()).toContain('usage: stet remove <key> [<key>...]');
  });

  it('is offline by contract: --env is refused before anything loads', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'hero_headline', '--env', 'prod')).toBe(2);
    expect(host.stderr()).toContain('offline by contract');
  });

  it('reports check’s own config error when there is no descriptor to read', async () => {
    // A bare directory: no config (loadConfig tolerates it and the defaults
    // carry the paths) and no content. The loaders answer null and push the
    // finding, so the command reports rather than crashing.
    const host = makeHost({ config: null });
    rmSync(join(host.cwd, 'content'), { recursive: true, force: true });

    expect(await host.run('remove', 'somekey')).toBe(1);
    expect(host.stderr()).toContain('content/descriptor.json: ENOENT');
  });
});

describe('remove — membership and the reference gate', () => {
  it('refuses an unknown key with the known-shape message, printing nothing as removable', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'no_such_key')).toBe(1);
    expect(host.stderr()).toContain('"no_such_key" is not a key in content/descriptor.json');
    expect(host.stdout()).toBe('');
  });

  it('refuses the WHOLE run when one key of several is unknown, and writes nothing', async () => {
    const host = makeHost({ config: {} });
    const before = bytes(host, 'content/descriptor.json');
    expect(await host.run('remove', 'footer_links', 'no_such_key', '--write')).toBe(1);
    expect(host.stderr()).toContain('"no_such_key" is not a key in content/descriptor.json');
    expect(host.stdout()).toBe('');
    expect(bytes(host, 'content/descriptor.json').equals(before)).toBe(true);
  });

  it('answers `constructor` from the descriptor’s OWN keys, never the prototype', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'constructor')).toBe(1);
    expect(host.stderr()).toContain('"constructor" is not a key in content/descriptor.json');
  });

  it('refuses a key another key derives from, naming the derivesFrom path', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'hero_headline')).toBe(1);
    expect(host.stderr()).toContain('cannot remove: keys/seo_home_title/derivesFrom');
    expect(host.stderr()).toContain('edit the reference, then re-run');
    expect(host.stdout()).toBe('');
  });

  it('refuses in --write mode too, leaving every repo form byte-unchanged', async () => {
    const host = makeHost({ config: {} });
    const forms = ['content/descriptor.json', 'content/defaults.json', 'content/keys.ts', 'content/stet-env.d.ts', 'content/defaults.ts'];
    const before = forms.map((rel) => bytes(host, rel));
    expect(await host.run('remove', 'hero_headline', '--write')).toBe(1);
    expect(host.stderr()).toContain('cannot remove: keys/seo_home_title/derivesFrom');
    forms.forEach((rel, i) => expect(`${rel}: ${bytes(host, rel).equals(before[i]!)}`).toBe(`${rel}: true`));
  });

  it('refuses a key a page references through its SEO fields', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'seo_home_title')).toBe(1);
    expect(host.stderr()).toContain('cannot remove: pages/home/seo/title');
  });

  it('refuses a key a page binds into its JSON-LD', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'hero_body')).toBe(1);
    expect(host.stderr()).toContain('cannot remove: pages/home/jsonLd/bindings/description');
  });

  it('takes a derivation pair as ONE set: removed together, the pair validates clean', async () => {
    const host = bespokeHost(PAIR, PAIR_VALUES);
    // Alone, the source refuses on its deriver…
    expect(await host.run('remove', 'hero_headline')).toBe(1);
    expect(host.stderr()).toContain('cannot remove: keys/seo_home_title/derivesFrom');

    // …and together they are one validation over the whole set.
    const pair = bespokeHost(PAIR, PAIR_VALUES);
    expect(await pair.run('remove', 'hero_headline', 'seo_home_title')).toBe(0);
    expect(pair.stderr()).toBe('');
  });
});

describe('remove — the prototype backstop', () => {
  /** A declared `constructor` — the one prototype name the key grammar admits — plus a reference to it. */
  function declaring(reference: (d: Descriptor) => void): Descriptor {
    // Assigned rather than written into the literal: `constructor` in an object
    // literal takes `Object.prototype`'s type, not the index signature's.
    const keys: Record<string, KeyDef> = { blog_intro: { shape: 'text', target: 'web' } };
    keys['constructor'] = { shape: 'text', target: 'web' };
    const descriptor: Descriptor = { version: 1, keys };
    reference(descriptor);
    return descriptor;
  }
  const VALUES: Snapshot = { default: { constructor: 'A declared value', blog_intro: 'Notes.' } };

  it('refuses a declared `constructor` whose references the validator cannot see', async () => {
    // All three classes at once: without the backstop the gate proceeds, the
    // three references dangle, and the broken descriptor reloads clean —
    // `'constructor' in keys` is still true after the own property is gone.
    const host = bespokeHost(
      declaring((d) => {
        d.keys['derived_title'] = { shape: 'text', target: 'web', derivesFrom: 'constructor', tmpl: '{v} — Mirra' };
        d.pages = {
          home: {
            route: '/',
            seo: { title: 'constructor' },
            jsonLd: { type: 'WebSite', bindings: { name: 'constructor' } },
          },
        };
      }),
      VALUES,
    );
    expect(await host.run('remove', 'constructor')).toBe(1);
    expect(host.stderr()).toContain('cannot remove: keys/derived_title/derivesFrom');
    expect(host.stdout()).toBe('');
  });

  it('reaches the page-SEO and JSON-LD reference classes on their own', async () => {
    const seo = bespokeHost(
      declaring((d) => {
        d.pages = { home: { route: '/', seo: { title: 'constructor' } } };
      }),
      VALUES,
    );
    expect(await seo.run('remove', 'constructor')).toBe(1);
    expect(seo.stderr()).toContain('cannot remove: pages/home/seo/title');

    const bound = bespokeHost(
      declaring((d) => {
        d.pages = { home: { route: '/', jsonLd: { type: 'WebSite', bindings: { name: 'constructor' } } } };
      }),
      VALUES,
    );
    expect(await bound.run('remove', 'constructor')).toBe(1);
    expect(bound.stderr()).toContain('cannot remove: pages/home/jsonLd/bindings/name');
  });

  it('removes a declared `constructor` that nothing references', async () => {
    const host = bespokeHost(declaring(() => {}), VALUES);
    expect(await host.run('remove', 'constructor', '--write')).toBe(0);
    expect(host.stderr()).toBe('');
    // Gone as an OWN property, and the project still checks clean.
    const written = JSON.parse(host.file('content/descriptor.json')) as { keys: Record<string, unknown> };
    expect(Object.hasOwn(written.keys, 'constructor')).toBe(false);
    expect(Object.hasOwn(JSON.parse(host.file('content/defaults.json'))['default'], 'constructor')).toBe(false);
    expect(await host.run('check')).toBe(0);
  });
});

describe('remove — the plan', () => {
  it('renders a record and a number value as JSON text, clipped', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'contact_form_labels', 'brand__radius')).toBe(0);
    const out = host.stdout();
    expect(out).toContain('remove contact_form_labels (record, web)');
    expect(out).toContain('  default: {"heading":"Get in touch","submit":"Send it"}');
    expect(out).toContain('remove brand__radius (number, web)');
    expect(out).toContain('  default: 8');
    // Long values are clipped at the excerpt width.
    const long = makeHost({ config: {} });
    expect(await long.run('remove', 'newsletter__body')).toBe(0);
    expect(long.stdout()).toContain('  default: Here is what shipped this month. Unsubscribe any time: {{...');
  });

  it('reports a mention in any of the three glob lists — a comment counts', async () => {
    const host = makeHost({
      // The config defaults are all empty, and an empty-glob host is silent by
      // construction: the surfaces have to be declared for the probe to run.
      config: { managedSurfaces: ['app/**/*.tsx'], copyModules: ['content/copy.ts'] },
    });
    mkdirSync(join(host.cwd, 'app'), { recursive: true });
    writeFileSync(
      join(host.cwd, 'app/page.tsx'),
      'export default function Page() {\n  // TODO: brand__radius is still hard-coded\n  return <h1>hi</h1>;\n}\n',
    );
    writeFileSync(join(host.cwd, 'content/copy.ts'), "export const copy = { contact_form_labels: 'x' };\n");

    expect(await host.run('remove', 'brand__radius', 'contact_form_labels')).toBe(0);
    // A comment is a mention: the probe is compiler-less and over-counts in the
    // reporting direction, which is the safe direction for a caution.
    expect(host.stdout()).toContain(
      'app/page.tsx mentions "brand__radius" — un-wire the read first, or the regenerated types surface it at the host\'s typecheck',
    );
    expect(host.stdout()).toContain('content/copy.ts mentions "contact_form_labels"');
  });

  it('carries the store posture line only where a declared block is store-backed', async () => {
    const snapshotOnly = makeHost({ config: { store: { adapter: 'snapshot' } } });
    expect(await snapshotOnly.run('remove', 'footer_links')).toBe(0);
    expect(snapshotOnly.stdout()).not.toContain('store rows for removed keys are kept');

    const bare = makeHost({ config: {} });
    expect(await bare.run('remove', 'footer_links')).toBe(0);
    expect(bare.stdout()).not.toContain('store rows for removed keys are kept');

    // Store-backed, pointed at a dead host: the line prints and the command
    // never dials. The store is injected and available, and took no call.
    const store = counting(createMemoryStore({ project: 'default' }));
    const backed = makeHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: 'postgresql://127.0.0.1:1/nothing' },
      store,
    });
    expect(await backed.run('remove', 'footer_links')).toBe(0);
    expect(backed.stdout()).toContain(
      'store rows for removed keys are kept — audit names them as orphans; ' +
        'an open draft for a removed key still publishes with its change — discard it first',
    );
    expect(store.calls).toEqual([]);
  });

  it('carries a store posture line for a store-backed ENVIRONMENT beside a snapshot default', async () => {
    const host = makeHost({
      config: { store: { adapter: 'snapshot' }, environments: { prod: { adapter: 'pg' } } },
    });
    expect(await host.run('remove', 'footer_links')).toBe(0);
    expect(host.stdout()).toContain('store rows for removed keys are kept');
  });

  it('warns on a slot losing its key, with the slot-scoped remedy inside the warn', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'welcome__preheader')).toBe(0);
    expect(host.stderr()).toContain(
      'template "welcome" declares slot "preheader" with no "welcome__preheader" key — ' +
        'the slot has nowhere to store a value; drop "preheader" from templates.welcome.slots to retire the slot',
    );
    // The green counter-arm: `welcome` declares unsubscribe_url in
    // wrapperProvides, so losing a slot costs it nothing at the class gate.
    expect(host.stdout()).not.toContain('after this removal, stet check will report');
  });

  it('leaves a STANDING slot warn as the bare line the fold already prints', async () => {
    // `preheader` has no key before anything is removed, so its warn is the
    // descriptor's own — carried into this output by descriptorOf's fold. A
    // remedy this removal did not earn would misattribute it.
    const host = bespokeHost(
      {
        version: 1,
        keys: {
          welcome__subject: { shape: 'text', target: 'html-email' },
          blog_intro: { shape: 'text', target: 'web' },
        },
        templates: { welcome: { class: 'transactional', trigger: 'form', slots: ['subject', 'preheader'] } },
      },
      { default: { welcome__subject: 'Welcome aboard', blog_intro: 'Notes.' } },
    );
    expect(await host.run('remove', 'blog_intro')).toBe(0);
    expect(host.stderr()).toContain('template "welcome" declares slot "preheader" with no "welcome__preheader" key');
    expect(host.stderr()).not.toContain('drop "preheader" from templates.welcome.slots');
  });

  it('says nothing about a red the removal did not cause', async () => {
    // The class gate is ALREADY failing — the newsletter body no longer carries
    // the token — so an unrelated removal must not announce that finding as its
    // consequence.
    const host = makeHost({ config: {} });
    const snapshot = JSON.parse(host.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    snapshot['default']!['newsletter__body'] = 'Here is what shipped this month.';
    writeFileSync(join(host.cwd, 'content/defaults.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    await host.run('pull');
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain('a marketing template needs {{unsubscribe_url}} in scope');

    const before = host.out.length;
    expect(await host.run('remove', 'footer_links')).toBe(0);
    expect(host.out.slice(before).join('\n')).not.toContain('after this removal, stet check will report');
  });

  it('prints the class gate’s own text where the removal turns check red, and only then', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'newsletter__body')).toBe(0);
    // The gate's message, quoted rather than restated — it already names both
    // heals, and following the carry-it arm surfaces the vars declaration next.
    expect(host.stdout()).toContain(
      'after this removal, stet check will report: newsletter: a marketing template needs ' +
        "{{unsubscribe_url}} in scope — carry it in a slot, or declare it in wrapperProvides if the host's " +
        'frame already sends it (default)',
    );

    // Red was announced before the write, and it is the same finding.
    const applied = makeHost({ config: {} });
    expect(await applied.run('remove', 'newsletter__body', '--write')).toBe(0);
    expect(await applied.run('check')).toBe(1);
    expect(applied.stderr()).toContain('a marketing template needs {{unsubscribe_url}} in scope');
  });

  it('is a plan and not an action: a plain run writes nothing and exits 0', async () => {
    const host = makeHost({ config: {} });
    const forms = ['content/descriptor.json', 'content/defaults.json', 'content/keys.ts', 'content/stet-env.d.ts', 'content/defaults.ts'];
    const before = forms.map((rel) => bytes(host, rel));
    expect(await host.run('remove', 'footer_links', 'blog_intro')).toBe(0);
    expect(host.stdout()).toContain('plan only — run with --write to apply');
    forms.forEach((rel, i) => expect(`${rel}: ${bytes(host, rel).equals(before[i]!)}`).toBe(`${rel}: true`));
  });
});

describe('remove --write — the batch over the five repo forms', () => {
  it('cleans EVERY locale block, so no stale snapshot entry survives', async () => {
    const host = bespokeHost(TWO_LOCALE, TWO_LOCALE_VALUES);
    expect(await host.run('remove', 'footer_note', '--write')).toBe(0);
    expect(host.stdout()).toContain('removed 1 key(s); run stet check');

    // The plan names every block that CARRIES the key and no other: `de` holds
    // only `blog_intro`, and a line for it would be a value the run invented.
    expect(host.stdout()).toContain('  default: Made in Dublin');
    expect(host.stdout()).toContain('  es: Hecho en Dublín');
    expect(host.stdout()).not.toContain('  de:');

    // The `es` block is not enabled and is cleaned anyway: the currency check
    // reads orphans over every locale, so a block left behind is a permanent
    // stale warn. The exit code alone is a decoy — the finding is a WARN and a
    // half-cleaned snapshot also exits 0.
    expect(await host.run('check', '--json')).toBe(0);
    expect(host.json<{ snapshot: { stale: string[] } }>().snapshot.stale).toEqual([]);
    const after = host.err.length;
    expect(await host.run('check')).toBe(0);
    expect(host.err.slice(after).join('\n')).not.toContain('in the snapshot, not in the descriptor — stale');
    // The emptied block keeps its `{}`.
    expect(JSON.parse(host.file('content/defaults.json'))['es']).toEqual({});
  });

  it('regenerates all three codegen files from the cleaned forms, byte for byte', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'footer_links', '--write')).toBe(0);

    const descriptor = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    const snapshot = loadSnapshot(JSON.parse(host.file('content/defaults.json')));
    expect(Object.hasOwn(descriptor.keys, 'footer_links')).toBe(false);
    expect(Object.hasOwn(snapshot['default'] ?? {}, 'footer_links')).toBe(false);

    const registry = generateRegistry(descriptor);
    expect(bytes(host, 'content/keys.ts').equals(Buffer.from(registry.keysTs, 'utf8'))).toBe(true);
    expect(bytes(host, 'content/stet-env.d.ts').equals(Buffer.from(registry.dts, 'utf8'))).toBe(true);
    expect(
      bytes(host, 'content/defaults.ts').equals(Buffer.from(generateDefaultsModule(snapshot), 'utf8')),
    ).toBe(true);
    // The ambient union no longer types the removed key, so a host read of it
    // stops compiling instead of compiling against a file nothing checks.
    expect(host.file('content/stet-env.d.ts')).not.toContain('footer_links');
    expect(await host.run('check')).toBe(0);
  });

  it('completes on a DERIVED key, whose removal leaves the defaults module unchanged', async () => {
    // No derived key in the stock host is removable — both of its derivers are
    // page-referenced — so the pair family's page-free descriptor is the host.
    const host = bespokeHost(PAIR, PAIR_VALUES);
    const before = bytes(host, 'content/defaults.ts');
    expect(await host.run('remove', 'seo_home_title', '--write')).toBe(0);
    // A derived key has no snapshot value by design, so the snapshot-derived
    // module takes writePlanned's `unchanged` path.
    expect(bytes(host, 'content/defaults.ts').equals(before)).toBe(true);
    expect(host.file('content/keys.ts')).not.toContain('seo_home_title');
    expect(await host.run('check')).toBe(0);
  });

  it('is idempotent by refusal: the second run has no such key to remove', async () => {
    const host = makeHost({ config: {} });
    expect(await host.run('remove', 'footer_links', '--write')).toBe(0);
    expect(await host.run('remove', 'footer_links', '--write')).toBe(1);
    expect(host.stderr()).toContain('"footer_links" is not a key in content/descriptor.json');
  });

  it('reports an unreadable target as a batch failure while the plan is still being built', async () => {
    // A directory where the registry file belongs. `planWrite` reads what is on
    // disk to decide the plan's status, so this throws during PLAN
    // CONSTRUCTION — before `writePlanned` runs and before any file is touched.
    // Nothing was written, so there is nothing to restore and nothing to assert
    // about restoration.
    const host = makeHost({ config: {} });
    rmSync(join(host.cwd, 'content/keys.ts'));
    mkdirSync(join(host.cwd, 'content/keys.ts'));

    expect(await host.run('remove', 'footer_links', '--write')).toBe(1);
    expect(host.stderr()).toContain('stet remove --write: the write batch failed');
    expect(host.file('content/descriptor.json')).toContain('footer_links');
  });

  it('puts back every landed write when the batch fails PART WAY through', async () => {
    // The fifth and last target made unwritable: the four before it land, this
    // one throws, and the batch's whole promise is that the failure left
    // nothing behind.
    const host = makeHost({ config: {} });
    const landed = ['content/descriptor.json', 'content/defaults.json', 'content/keys.ts', 'content/stet-env.d.ts'];
    const before = landed.map((rel) => bytes(host, rel));
    const stamps = landed.map((rel) => statSync(join(host.cwd, rel)).mtimeMs);
    chmodSync(join(host.cwd, 'content/defaults.ts'), 0o444);

    expect(await host.run('remove', 'footer_links', '--write')).toBe(1);
    expect(host.stderr()).toContain('stet remove --write: the write batch failed');
    expect(host.stderr()).toContain('Every file this run had already written was put back.');

    landed.forEach((rel, i) => {
      expect(`${rel}: ${bytes(host, rel).equals(before[i]!)}`).toBe(`${rel}: true`);
      // The mtime moved, so the bytes are RESTORED rather than never written —
      // an identity check alone cannot tell those two apart.
      expect(`${rel} rewritten: ${statSync(join(host.cwd, rel)).mtimeMs > stamps[i]!}`).toBe(`${rel} rewritten: true`);
    });
    chmodSync(join(host.cwd, 'content/defaults.ts'), 0o644);
  });
});

/**
 * The redo's R3, through the real CLI: the demo keys `init` scaffolds own the
 * names a host's own copy module wants, and clearing them was a hand edit of
 * two JSON files because no command existed. The starter descriptor is clean
 * for this — five keys, no pages, no templates, no derivation — so removing all
 * five is legal and leaves a project that checks green at zero keys.
 *
 * The two arms fork from ONE scaffold: arm 1 is the state without the removal,
 * arm 2 the same scaffold with it. Skipping the removal leaves arm 2
 * unreachable and arm 1's divergence standing, which is what makes the arm-1
 * refusal the discriminator rather than decoration.
 */
describe('remove — the scaffolded host adopts its own copy (R3)', () => {
  const STARTER_KEYS = ['brand__ink', 'brand__name', 'brand__primary', 'brand__radius', 'hero_headline'];

  function starterHost(): Host {
    const template = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8'));
    const host = bespokeHost(
      template('starter-descriptor.json') as Descriptor,
      template('starter-defaults.json') as Snapshot,
      { copyModules: ['src/copy.ts'] },
    );
    mkdirSync(join(host.cwd, 'src'), { recursive: true });
    writeFileSync(
      join(host.cwd, 'src/copy.ts'),
      'export const copy = {\n  hero_headline: "Never miss a post again.",\n  cta_label: "Start free",\n};\n',
      'utf8',
    );
    return host;
  }

  it('arm 1 — without the removal, the demo default owns the name and the real literal is refused', async () => {
    const host = starterHost();
    expect(await host.run('scan')).toBe(0);
    expect(host.stderr()).toContain('hero_headline diverged from the snapshot default');

    const before = host.err.length;
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.err.slice(before).join('\n')).toContain(
      'hero_headline diverged from the snapshot default — register only adds keys; resolve the difference by hand',
    );
    // The demo value still holds the name, and no suffixed variant was minted:
    // the module loop is own-name-only, so there is no `hero_headline_2` to
    // fall back on — which is exactly why the removal has to be a command.
    const values = JSON.parse(host.file('content/defaults.json'))['default'] as Record<string, unknown>;
    expect(values['hero_headline']).toBe('Your headline goes here');
    expect(Object.hasOwn(JSON.parse(host.file('content/descriptor.json')).keys, 'hero_headline_2')).toBe(false);
  });

  it('arm 2 — the demo keys leave, and the real headline adopts under its own name', async () => {
    const host = starterHost();
    expect(await host.run('remove', ...STARTER_KEYS, '--write')).toBe(0);
    // The starter's number key runs the JSON-text clip path on the way through.
    expect(host.stdout()).toContain('remove brand__radius (number, web)');
    expect(host.stdout()).toContain('  default: 8');
    expect(host.stdout()).toContain('removed 5 key(s); run stet check');

    const scanned = host.err.length;
    expect(await host.run('scan')).toBe(0);
    expect(host.err.slice(scanned).join('\n')).toContain('propose key hero_headline');

    const adopted = host.out.length;
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.out.slice(adopted).join('\n')).toContain('2 keys added');
    const values = JSON.parse(host.file('content/defaults.json'))['default'] as Record<string, unknown>;
    expect(values['hero_headline']).toBe('Never miss a post again.');
    expect(values['cta_label']).toBe('Start free');

    expect(await host.run('check')).toBe(0);
  });
});

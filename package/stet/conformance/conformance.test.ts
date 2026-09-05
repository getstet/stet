/**
 * The conformance walk: every requirement of the four `add-content-core` spec
 * files, one named test each, against the mini-project fixture.
 * `add-store-and-publish`'s adapters extend this suite rather than starting a
 * second one — a run here is the evidence that an install works.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { revertChange } from '../adapters/changesets.js';
import { createMemoryDb, createMemoryStore } from '../adapters/store-memory.js';
import {
  applySql,
  createPgStore,
  readStetMeta as readPgMeta,
  writeDescriptorVersion as writePgDescriptorVersion,
} from '../adapters/store-pg.js';
import {
  createPostgrestStore,
  readStetMeta as readPostgrestMeta,
  writeDescriptorVersion as writePostgrestDescriptorVersion,
} from '../adapters/store-postgrest.js';
import { createSnapshotStore } from '../adapters/store-snapshot.js';
import { loadConfig } from '../cli/config.js';
import { createStetHandler, type PublishEvent } from '../server/mount.js';
import { mintPreviewToken, verifyPreviewToken } from '../server/index.js';
import { runCli, type CliIo } from '../cli/main.js';
import { refuseDanglingReferences } from '../cli/remove.js';
import { isNodeBuiltin, runtimeImportClosure, sourceFiles } from '../tests/helpers/source-roster.js';
import { TS7_REFUSAL } from '../cli/source-scan.js';
import { cleanupEmailHosts, makeEmailHost } from '../tests/helpers/email-host.js';
import { installRegistryDts, typecheckHost } from '../tests/helpers/ts-host.js';
import { generateDefaultsModule, generateRegistry, generatedBody } from '../src/codegen.js';
import * as root from '../src/index.js';
import {
  DESCRIPTOR_SCHEMA,
  SEO_SEVERITY,
  activeRow,
  DescriptorError,
  checkBudget,
  checkClassRules,
  checkCurrency,
  checkLimits,
  plainOf,
  checkVars,
  deriveLabel,
  htmlEmailTarget,
  loadDescriptor,
  pageSpan,
  readBundle,
  resolve,
  resolveFromBundle,
  resolvePreview,
  seoCheck,
  snapshotSmells,
  targetAdapter,
  targetAdapterIfShipped,
  validateSave,
  webTarget,
} from '../src/index.js';
import type { Bundle, Descriptor, SeoFinding, SeoRule, Snapshot, StoreAdapter, StoreRow } from '../src/index.js';
import {
  bareHtmlHost,
  cleanupCliHosts,
  countingStore,
  fakeFetch,
  htmlFixture,
  makeAdoptionHost,
  makeCliHost,
  makeHtmlHost,
  publishFailsOnce,
  type CliHost,
} from './cli-host.js';
import {
  miniBundle,
  miniDescriptor,
  miniRows,
  miniSnapshot,
  mutable,
  readFixture,
} from './fixture.js';
import { isStoreError, ok } from './store.suite.js';

const descriptor = miniDescriptor();
const snapshot = miniSnapshot();
const rows = miniRows();
const bundle = miniBundle();
const keys = Object.keys(descriptor.keys);

// The migrations are inert text here; the live leg is what runs them.
const MIGRATION_NAME = '001_content_cms.sql';
const MIGRATION = readFileSync(new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url), 'utf8');
const MIGRATION_2_NAME = '002_changesets.sql';
const MIGRATION_2 = readFileSync(new URL(`../migrations/${MIGRATION_2_NAME}`, import.meta.url), 'utf8');

afterAll(cleanupCliHosts);
afterAll(cleanupEmailHosts);

/** The class rules' scope as a caller assembles it: the slots, and the brand's postal line. */
function siblingsOf(template: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const slot of descriptor.templates?.[template]?.slots ?? []) {
    const key = `${template}__${slot}`;
    out[key] = resolve(descriptor, snapshot, [], { key }).value;
  }
  out['brand__footer_address'] = resolve(descriptor, snapshot, [], {
    key: 'brand__footer_address',
  }).value;
  return out;
}

describe('descriptor', () => {
  it('Requirement: Keys name content, not position', () => {
    // Moving where a key renders changes neither its identity nor its value.
    const rehomed = mutable(descriptor);
    rehomed.keys['hero_headline']!.pages = ['pricing'];
    expect(resolve(rehomed, snapshot, rows, { key: 'hero_headline' })).toEqual(
      resolve(descriptor, snapshot, rows, { key: 'hero_headline' }),
    );

    // Identity is (project, key, locale). The descriptor declares no project —
    // it is a call argument — and no locale: values live per locale in the
    // snapshot, so a project declaring no locales operates under `default`.
    expect(Object.keys(descriptor).sort()).toEqual(['keys', 'pages', 'templates', 'version']);
    expect(Object.keys(descriptor)).not.toContain('project');
    expect(resolve(descriptor, snapshot, rows, { key: 'hero_headline' }).value).toBe(
      resolve(descriptor, snapshot, rows, { key: 'hero_headline', locale: 'default' }).value,
    );

    // Two projects sharing one store: each adapter hands over its own project's
    // rows, so identically named keys never collide inside the core.
    const otherProject: StoreRow[] = [
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'The other project’s headline.',
        version: 1,
      },
    ];
    expect(resolve(descriptor, snapshot, otherProject, { key: 'hero_headline' }).value).toBe(
      'The other project’s headline.',
    );
    expect(resolve(descriptor, snapshot, rows, { key: 'hero_headline' }).value).toBe(
      'Mirror your X posts to Telegram.',
    );
  });

  it('Requirement: The descriptor is language-neutral and schema-validated', () => {
    expect(DESCRIPTOR_SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');

    const broken = mutable(readFixture('descriptor.json') as Record<string, any>);
    broken['keys']['hero_headline']['limits']['severity'] = 'harsh';
    let error: DescriptorError | undefined;
    try {
      loadDescriptor(broken);
    } catch (thrown) {
      error = thrown as DescriptorError;
    }
    expect(error?.path).toBe('keys/hero_headline/limits/severity');

    // Nothing downstream runs on a rejected descriptor: the caller never gets
    // an object to hand to codegen or the checks.
    expect(() => loadDescriptor(broken)).toThrowError(DescriptorError);

    // Both artifacts parse as plain JSON with no JS evaluation. (The Python
    // proof — tests/python/check_snapshot.py — is the same claim, from outside.)
    expect(typeof readFixture('descriptor.json')).toBe('object');
    expect(typeof readFixture('defaults.json')).toBe('object');
  });

  it('Requirement: The three axes — shape, target, limits', () => {
    const farewell = descriptor.keys['farewell_notice'];
    expect(farewell).toMatchObject({
      shape: 'text',
      target: 'telegram-md2',
      limits: { max: 4096, severity: 'hard' },
    });

    const shapes = new Set(keys.map((k) => descriptor.keys[k]?.shape));
    expect([...shapes].sort()).toEqual([
      'color',
      'enum',
      'list',
      'media',
      'number',
      'record',
      'richtext',
      'text',
    ]);

    // Limits are per key, not a universal obligation.
    expect(descriptor.keys['blog_intro']?.limits).toBeUndefined();

    // There is no commit axis.
    const withCommit = mutable(readFixture('descriptor.json') as Record<string, any>);
    withCommit['keys']['hero_headline']['commit'] = 'row-update';
    expect(() => loadDescriptor(withCommit)).toThrowError(DescriptorError);
  });

  it('Requirement: A key may carry a fit budget, advisory in phase 1', () => {
    expect(descriptor.keys['hero_headline']?.budget).toEqual({ desktop: 2, mobile: 3 });

    const over = validateSave(descriptor, { key: 'hero_headline', value: 'x'.repeat(100) });
    const budgetFindings = over.findings.filter((f) => f.rule === 'budget');
    expect(budgetFindings).toHaveLength(1);
    expect(budgetFindings[0]?.severity).toBe('warning');
    expect(over.findings.some((f) => f.rule === 'budget' && f.severity === 'error')).toBe(false);

    // A key without a budget gets no verdict.
    expect(checkBudget(descriptor, 'hero_body', 'x'.repeat(5000))).toBeNull();
  });

  it('Requirement: The pages section declares structure, not content', async () => {
    expect(descriptor.pages?.['pricing']).toMatchObject({ route: '/pricing', parent: 'home' });
    expect(descriptor.pages?.['home']?.jsonLd).toEqual({
      type: 'WebSite',
      bindings: { name: 'brand__name', description: 'hero_body' },
    });

    // A publish writes key values; the pages section is byte-identical after.
    const before = JSON.stringify(descriptor.pages);
    validateSave(descriptor, { key: 'brand__name', value: 'Mirra, renamed' });
    resolve(descriptor, snapshot, rows, { key: 'brand__name' });
    expect(JSON.stringify(descriptor.pages)).toBe(before);

    // A shared key names its pages, plural; an undeclared page fails validation.
    expect(descriptor.keys['footer_links']?.pages).toEqual(['home', 'pricing']);
    const stray = mutable(readFixture('descriptor.json') as Record<string, any>);
    stray['keys']['footer_links']['pages'] = ['home', 'pricing', 'about'];
    expect(() => loadDescriptor(stray)).toThrowError(/about/);

    // The editable SEO fields are ordinary content keys the page references —
    // explicit, never inferred from a name — and a reference to a key the
    // descriptor does not declare fails validation, naming the field's path.
    expect(descriptor.pages?.['home']?.seo).toEqual({
      title: 'seo_home_title',
      description: 'seo_home_desc',
    });
    expect(descriptor.keys['seo_home_desc']).toBeDefined();
    const dangling = mutable(readFixture('descriptor.json') as Record<string, any>);
    dangling['pages']['home']['seo']['description'] = 'seo_home_dsc';
    let seoError: DescriptorError | undefined;
    try {
      loadDescriptor(dangling);
    } catch (thrown) {
      seoError = thrown as DescriptorError;
    }
    expect(seoError?.path).toBe('pages/home/seo/description');
    expect(seoError?.message).toContain('seo_home_dsc');

    // A publish cannot restructure a page through them either: the references
    // are structure, the values they name are content.
    const structure = JSON.stringify(descriptor.pages);
    validateSave(descriptor, { key: 'seo_home_desc', value: 'A different description.' });
    expect(JSON.stringify(descriptor.pages)).toBe(structure);

    // Two DEVELOPER commands edit page records on the developer's behalf, each
    // shown in its plan before the write. `stet remove` drops the `seo` field
    // that references a key it removes — the reference is structure, and a
    // reference to a key that left would not load.
    const host = makeCliHost({ config: {} });
    expect(await host.run('remove', 'seo_home_desc', '--write')).toBe(0);
    expect(host.stdout()).toContain('pages/home/seo/description — reference dropped');
    const edited = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(edited.pages?.['home']?.seo).toEqual({ title: 'seo_home_title' });
    expect(edited.pages?.['home']?.route).toBe('/');
  });

  it('Requirement: Keys carry their editor- and agent-facing settings', () => {
    expect(descriptor.keys['theme_mode']?.values).toEqual(['light', 'dark', 'system']);
    const noValues = mutable(readFixture('descriptor.json') as Record<string, any>);
    delete noValues['keys']['theme_mode']['values'];
    expect(() => loadDescriptor(noValues)).toThrowError(/theme_mode/);

    expect(descriptor.keys['hero_headline']?.previewUrl).toBe('/');
    expect(descriptor.keys['hero_headline']?.section).toBe('Hero');

    // The agent pin is a descriptor fact, distinct from the project-level mode.
    const pinned = keys.filter((k) => descriptor.keys[k]?.agentPublish === false);
    expect(pinned).toEqual([
      'brand__name',
      'brand__primary',
      'brand__radius',
      'brand__logo',
      'brand__footer_address',
    ]);
    expect(descriptor.keys['hero_headline']?.agentPublish).toBeUndefined();
  });

  it('Requirement: A text key may declare placeholder tags', async () => {
    // The field is written by `register` on the static-HTML host, for an element
    // that mixes text with child elements, and read by the save gate and the
    // length rule. The identity of a tag — the element's name and attributes —
    // lives in the document, never in the value.
    const host = await makeHtmlHost({ register: true });
    const written = JSON.parse(host.file('content/descriptor.json')) as {
      keys: Record<string, { shape: string; target: string; tags?: number }>;
    };
    const values = (JSON.parse(host.file('content/defaults.json')) as { default: Record<string, string> })
      .default;
    expect(written.keys['you_may_already_have_the_data_our_ai']).toEqual({
      shape: 'text',
      target: 'web',
      tags: 1,
    });
    expect(values['you_may_already_have_the_data_our_ai']).toBe(
      'You may already have the data<1> our AI lab partners need.</1>',
    );
    // A nested pair declares two; an element with no descendants declares none.
    const nested = Object.entries(values).find(([, v]) => v === 'Hello <1>big <2>world</2></1>!')![0];
    expect(written.keys[nested]?.tags).toBe(2);
    const plain = Object.entries(values).find(([, v]) => v === 'Imaging archives')![0];
    expect(written.keys[plain]).toEqual({ shape: 'text', target: 'web' });

    // The schema rejects a count below one, naming the path.
    const document = mutable(readFixture('descriptor.json') as Record<string, never>);
    (document as Record<string, any>)['keys']['hero_headline']['tags'] = 0;
    let rejected: DescriptorError | null = null;
    try {
      loadDescriptor(document);
    } catch (error) {
      rejected = error as DescriptorError;
    }
    expect(rejected?.path).toBe('keys/hero_headline/tags');
  });

  it('Requirement: Variables are a declared whitelist', () => {
    expect(descriptor.keys['welcome__body']?.vars).toEqual(['handle']);
    expect(checkVars(descriptor, 'welcome__body', 'Hi {{handle}}').ok).toBe(true);
    expect(checkVars(descriptor, 'welcome__body', 'Hi {{first_name}}').ok).toBe(false);
  });

  it('Requirement: Derivation is declared, not computed ad hoc', async () => {
    expect(descriptor.keys['seo_home_title']).toMatchObject({
      derivesFrom: 'hero_headline',
      tmpl: '{v} — Mirra',
    });

    const dangling = mutable(readFixture('descriptor.json') as Record<string, any>);
    dangling['keys']['seo_home_title']['derivesFrom'] = 'hero_headlin';
    let error: DescriptorError | undefined;
    try {
      loadDescriptor(dangling);
    } catch (thrown) {
      error = thrown as DescriptorError;
    }
    expect(error?.message).toContain('seo_home_title');
    expect(error?.message).toContain('hero_headlin');

    // Removing the source through `stet remove` BAKES the derivation rather
    // than dangling it: the dependent keeps the resolved value as its own and
    // drops `derivesFrom` and `tmpl` together, so the descriptor validates with
    // no derivation left pointing at the removed key.
    const host = makeCliHost({ config: {} });
    expect(await host.run('remove', 'hero_headline', '--write')).toBe(0);
    const baked = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(baked.keys['seo_home_title']).toMatchObject({ shape: 'text', target: 'web' });
    expect(baked.keys['seo_home_title']?.derivesFrom).toBeUndefined();
    expect(baked.keys['seo_home_title']?.tmpl).toBeUndefined();
    expect(JSON.parse(host.file('content/defaults.json')).default.seo_home_title).toBe(
      'Never miss a post again. — Mirra',
    );
    expect(await host.run('check')).toBe(0);
  });

  it('Requirement: Email templates are declared in the templates section', () => {
    expect(descriptor.templates?.['welcome']).toEqual({
      class: 'marketing',
      trigger: 'form',
      clock: 'on join',
      sender: 'news',
      slots: ['subject', 'preheader', 'body'],
      wrapperProvides: ['unsubscribe_url'],
    });

    // preheader exists from day one, and slot keys flatten as template__slot.
    for (const slot of descriptor.templates?.['welcome']?.slots ?? []) {
      expect(descriptor.keys[`welcome__${slot}`]).toBeDefined();
    }

    // Per-slot limits are independent.
    expect(descriptor.keys['welcome__subject']?.limits?.max).toBe(60);
    expect(descriptor.keys['welcome__body']?.limits?.max).toBe(400);

    // Class is not content: a value edit cannot reach it, and no descriptor
    // construct holds markup.
    const before = JSON.stringify(descriptor.templates);
    validateSave(descriptor, { key: 'welcome__body', value: 'New wording, {{handle}}.' }, siblingsOf('welcome'));
    expect(JSON.stringify(descriptor.templates)).toBe(before);
    expect(JSON.stringify(descriptor.templates)).not.toContain('<');

    // An entry MAY carry a render pointer — the file, export and sample props
    // `stet email verify` renders through, and the root of the chain `stet
    // doctor` searches for a declared wrapper token. It is optional: this
    // fixture entry has none, and is a complete entry without one.
    expect(descriptor.templates?.['welcome']?.render).toBeUndefined();
    const pointered = {
      ...descriptor,
      templates: {
        welcome: {
          ...(descriptor.templates?.['welcome'] as object),
          render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: { handle: 'ada' } },
        },
      },
    };
    expect(() => loadDescriptor(pointered)).not.toThrow();
    // And the shape is checked: a pointer is three declared fields, not a bag.
    expect(() =>
      loadDescriptor({
        ...pointered,
        templates: {
          welcome: { ...pointered.templates.welcome, render: { file: '', export: 'welcome', sampleProps: {} } },
        },
      }),
    ).toThrow();
  });

  it('Requirement: Keys carry human labels for non-technical editing', () => {
    expect(descriptor.keys['hero_headline']?.label).toBe('Headline');
    expect(descriptor.keys['welcome__preheader']?.label).toBeUndefined();
    expect(deriveLabel('welcome__preheader')).toBe('Preheader');
    expect(deriveLabel('welcome__preheader')).toBe(deriveLabel('welcome__preheader'));
  });

  it('Requirement: Pack provenance is a tag on the key', () => {
    const packs = new Set(keys.map((k) => descriptor.keys[k]?.pack));
    expect(packs).toEqual(new Set(['core', 'saas', 'content']));

    // Provenance neither namespaces the key nor alters its identity.
    expect(keys.some((k) => k.startsWith('saas'))).toBe(false);
    const untagged = mutable(descriptor);
    delete untagged.keys['pricing_price']!.pack;
    expect(resolve(untagged, snapshot, rows, { key: 'pricing_price' })).toEqual(
      resolve(descriptor, snapshot, rows, { key: 'pricing_price' }),
    );

    // Provenance lives in the descriptor only — no store column is spent on it.
    expect(Object.keys(rows[0] ?? {})).not.toContain('pack');
  });

  it('Requirement: The generated registry makes unknown keys a compile error', () => {
    const { keysTs, dts } = generateRegistry(descriptor);
    expect(generateRegistry(mutable(descriptor)).keysTs).toBe(keysTs);
    expect(generatedBody(dts)).toContain('interface StetRegistry');

    // The second union, beside `ContentKey`: the keys whose SHAPE resolves to a
    // string, so a map typed over string values refuses a structured key at
    // compile time instead of lying about it at runtime. Membership is by shape
    // — the fixture declares all eight — and the emission is as sorted and as
    // reproducible as `KEYS`.
    const stringUnion = /^export const STRING_KEYS = \[\n([\s\S]*?)^\] as const;$/m.exec(keysTs);
    const stringKeys = [...(stringUnion?.[1] ?? '').matchAll(/^ {2}'([a-z0-9_]+)',$/gm)].map((m) => m[1] as string);
    const ofShape = (...shapes: string[]): string[] =>
      Object.entries(descriptor.keys)
        .filter(([, def]) => shapes.includes(def.shape))
        .map(([key]) => key)
        .sort();
    expect(stringKeys).toEqual(ofShape('text', 'richtext', 'media', 'enum', 'color'));
    for (const structured of ofShape('list', 'record', 'number')) {
      expect(stringKeys).not.toContain(structured);
    }
    expect(ofShape('list', 'record', 'number').length).toBeGreaterThan(0);
    expect(keysTs).toContain('export type StringKey = (typeof STRING_KEYS)[number];\n');

    installRegistryDts(dts);
    expect(typecheckHost('tsconfig.ok.json').ok).toBe(true);
    const typo = typecheckHost('tsconfig.bad.json');
    expect(typo.ok).toBe(false);
    expect(typo.output).toContain('hero_headlin');
  }, 60_000);
});

describe('snapshot', () => {
  it('Requirement: defaults.json is canonical; the typed module is generated', () => {
    // A non-JS consumer reads the JSON and needs no generated module.
    const committed = readFixture('defaults.json') as Record<string, Record<string, unknown>>;
    expect(committed['default']?.['hero_headline']).toBe('Never miss a post again.');

    const module = generateDefaultsModule(snapshot);
    expect(generateDefaultsModule(mutable(snapshot))).toBe(module);

    // A hand edit is detectable even though the source did not move.
    const edited = module.replace('Never miss a post again.', 'Edited in the generated file.');
    expect(edited).not.toBe(module);
    expect(generatedBody(edited)).not.toBe(generatedBody(module));
  });

  it('Requirement: The snapshot is complete with respect to the descriptor', () => {
    expect(checkCurrency(descriptor, snapshot).missing).toEqual([]);
    const added = mutable(descriptor);
    added.keys['hero_kicker'] = { shape: 'text', target: 'web' };
    expect(checkCurrency(added, snapshot).missing).toEqual(['hero_kicker']);

    // An OWN property of the default block: a key whose name is also a
    // prototype member needs its own row like any other, and a bare `in` read
    // it as already there.
    const prototypeNamed: Descriptor['keys'] = {};
    prototypeNamed['constructor'] = { shape: 'text', target: 'web' };
    expect(checkCurrency({ version: 1, keys: prototypeNamed }, { default: {} }).missing).toEqual([
      'constructor',
    ]);
  });

  it('Requirement: Snapshot output is deterministic and diff-friendly', () => {
    const edited = mutable(snapshot);
    edited['default']!['pricing_price'] = '$18';
    const before = generatedBody(generateDefaultsModule(snapshot)).split('\n');
    const after = generatedBody(generateDefaultsModule(edited)).split('\n');
    const changed = before.filter((line, i) => line !== after[i]);
    expect(changed).toHaveLength(1);
  });

  it('Requirement: People never enter the snapshot', () => {
    expect(snapshotSmells(snapshot)).toEqual([]);
    expect(checkCurrency(descriptor, snapshot).orphans).toEqual([]);

    // Excluded by construction: the artifact is generated from the snapshot
    // alone, and the snapshot from descriptor-declared keys alone. A contact
    // record has no way in that the currency check does not surface.
    const contaminated = mutable(snapshot);
    contaminated['default']!['signups'] = { email: 'a@example.com', consent: 'granted' };
    expect(checkCurrency(descriptor, contaminated).orphans).toEqual(['signups']);
    expect(snapshotSmells(contaminated)[0]?.code).toBe('contact_record_smell');
  });
});

describe('content-read', () => {
  it('Requirement: One resolution order everywhere', () => {
    expect(resolve(descriptor, snapshot, rows, { key: 'seo_home_title' })).toMatchObject({
      value: 'Mirror your X posts to Telegram. — Mirra',
      source: 'derived',
    });

    // Build-time equals request-time for every key, over the same inputs.
    const build = { d: mutable(descriptor), s: mutable(snapshot), r: mutable(rows) };
    for (const key of keys) {
      expect(resolve(build.d, build.s, build.r, { key })).toEqual(
        resolve(descriptor, snapshot, rows, { key }),
      );
    }
  });

  it('Requirement: The snapshot fallback is unconditional', () => {
    // Store unreachable: the adapter has no rows to hand over, and the page
    // renders complete rather than erroring or blanking.
    for (const key of keys) {
      const down = resolve(descriptor, snapshot, null, { key });
      expect(down.value).toBeDefined();
      expect(down.value).not.toBe('');
    }

    // Snapshot-only is the same path, not a branch.
    for (const key of keys) {
      expect(resolve(descriptor, snapshot, [], { key })).toEqual(
        resolve(descriptor, snapshot, null, { key }),
      );
    }
  });

  it('Requirement: Malformed stored values are quarantined, observably', () => {
    const broken: StoreRow[] = [
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 42,
        version: 7,
      },
    ];
    const r = resolve(descriptor, snapshot, broken, { key: 'hero_headline' });
    expect(r.value).toBe('Never miss a post again.');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      code: 'malformed_value',
      key: 'hero_headline',
      locale: 'default',
    });
    expect(r.warnings[0]?.reason).toBeTruthy();
  });

  it('Requirement: Locale resolution falls back through default', () => {
    expect(resolve(descriptor, snapshot, null, { key: 'farewell_notice', locale: 'de' })).toMatchObject(
      { value: 'This channel is closing. Thanks for reading.', source: 'snapshot' },
    );

    const storedDefault: StoreRow[] = [
      {
        key: 'farewell_notice',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'Stored under default.',
        version: 1,
      },
    ];
    expect(
      resolve(descriptor, snapshot, storedDefault, { key: 'farewell_notice', locale: 'de' }).value,
    ).toBe('Stored under default.');
  });

  // The `content-read` MODIFIED requirement's walk lives in
  // `react/content-read.test.tsx` — its useCopy/typed-key scenarios use JSX,
  // which is TS17004 in this non-jsx program. One walk test per requirement.

  it('Requirement: The committed bundle is the build-time contract', () => {
    // Resolution from a bundle equals direct resolution over the same inputs.
    const bare = readBundle(readFixture('defaults.json'));
    for (const key of keys) {
      expect(resolveFromBundle(descriptor, bare, { key })).toEqual(
        resolve(descriptor, snapshot, null, { key }),
      );
    }

    // The full form carries version metadata where a store produced it.
    expect(bundle.meta?.['default']?.['hero_headline']).toEqual({ version: 3 });
    for (const key of keys) {
      expect(resolveFromBundle(descriptor, bundle, { key }).value).toEqual(
        resolveFromBundle(descriptor, bare, { key }).value,
      );
    }

    // Snapshot-only needs no producer: defaults.json is the bundle, and it
    // carries no version metadata because no version exists.
    const snapshotOnly: Bundle = readBundle(readFixture('defaults.json'));
    expect(snapshotOnly.meta).toBeUndefined();
    expect(snapshotOnly.values).toEqual(snapshot);
  });

  it('Requirement: Preview states resolve by per-key override, named by a signed token', () => {
    // A published change: hero_headline had a previous version, hero_body is
    // published here for the FIRST time, and hero_body's post-change row is
    // live on the site.
    const live: StoreRow[] = [
      ...rows.filter((r) => r.key !== 'hero_headline'),
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'The headline the change shipped.',
        version: 4,
      },
      {
        key: 'hero_body',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'The body the change shipped.',
        version: 1,
      },
    ];
    // The override rows are the members' before-values, from the capability's
    // one member read; the key set is every member, first-publish included.
    const before: StoreRow[] = [
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'Mirror your X posts to Telegram.',
        version: 3,
      },
    ];
    const overrides = {
      rows: before,
      keys: [
        { key: 'hero_headline', locale: 'default' },
        { key: 'hero_body', locale: 'default' },
      ],
    };

    // Each member reads at its pre-change value; a first-publish member has no
    // before-version, so masking it sends the read to the snapshot rather than
    // leaking the value the change introduced.
    expect(resolvePreview(descriptor, snapshot, live, overrides, { key: 'hero_headline' })).toMatchObject(
      { value: 'Mirror your X posts to Telegram.', source: 'active' },
    );
    expect(resolvePreview(descriptor, snapshot, live, overrides, { key: 'hero_body' })).toMatchObject({
      value: 'Follow {{handle}} without leaving Telegram.',
      source: 'snapshot',
    });

    // The ONE resolve path, never a parallel resolution: the answer is what
    // `resolve` gives over rows where those versions are still the live ones,
    // for every key the fixture declares.
    const asIfLive = [...live.filter((r) => !['hero_headline', 'hero_body'].includes(r.key)), ...before];
    for (const key of keys) {
      expect(resolvePreview(descriptor, snapshot, live, overrides, { key })).toEqual(
        resolve(descriptor, snapshot, asIfLive, { key }),
      );
    }

    // Masking is per (key, locale): the change touched `default`, so an
    // untouched `de` row keeps resolving live and byte-identically. Masking
    // key-wide would serve the German page an English before-value.
    const german: StoreRow[] = [
      ...live,
      {
        key: 'hero_headline',
        locale: 'de',
        status: 'published',
        is_active: true,
        value: 'Die Schlagzeile, die live ist.',
        version: 6,
      },
    ];
    expect(
      resolvePreview(descriptor, snapshot, german, overrides, { key: 'hero_headline', locale: 'de' }),
    ).toEqual(resolve(descriptor, snapshot, german, { key: 'hero_headline', locale: 'de' }));

    // The masked set is a UNION, never a replacement: an override row left out
    // of the pair set still masks the identity it overrides, so it cannot lose
    // to a higher-versioned live row.
    const outranked: StoreRow[] = [
      ...live,
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'A newer live headline.',
        version: 99,
      },
    ];
    expect(
      resolvePreview(
        descriptor,
        snapshot,
        outranked,
        { rows: before, keys: [{ key: 'hero_body', locale: 'default' }] },
        { key: 'hero_headline' },
      ).value,
    ).toBe('Mirror your X posts to Telegram.');

    // A malformed override quarantines exactly as a malformed stored value
    // does — the preview never renders blank and never renders the bad value.
    const bad = resolvePreview(
      descriptor,
      snapshot,
      live,
      { rows: [{ ...(before[0] as StoreRow), value: { not: 'text' } }] },
      { key: 'hero_headline' },
    );
    expect(bad).toMatchObject({ value: 'Never miss a post again.', source: 'snapshot' });
    expect(bad.warnings.map((w) => w.code)).toEqual(['malformed_value']);

    // The state is named by a SIGNED token, not an unsigned version parameter:
    // expiry, tampering and the wrong secret each verify to nothing, while a
    // valid token names exactly one state. Both functions take the clock.
    const state = { kind: 'change-before', changeId: 12 } as const;
    const token = mintPreviewToken(state, 'signing-secret', 1_000);
    expect(verifyPreviewToken(token, 'signing-secret', 1_000)).toEqual(state);
    expect(verifyPreviewToken(token, 'signing-secret', 1_000 + 24 * 60 * 60 * 1000)).toBeNull();
    expect(verifyPreviewToken(token, 'another-secret', 1_000)).toBeNull();
    expect(verifyPreviewToken(`${token}tampered`, 'signing-secret', 1_000)).toBeNull();
    for (const kind of ['draft', 'version'] as const) {
      const named =
        kind === 'draft'
          ? ({ kind, key: 'hero_headline' } as const)
          : ({ kind, key: 'hero_headline', versionId: 3 } as const);
      expect(verifyPreviewToken(mintPreviewToken(named, 's', 0), 's', 0)).toEqual(named);
    }

    // An open change's drafts-layered preview is the same mechanism with the
    // member drafts as override rows — no fourth token state.
    const draft = rows.find((r) => r.status === 'draft') as StoreRow;
    expect(
      resolvePreview(descriptor, snapshot, live, { rows: [draft] }, { key: 'hero_headline' }),
    ).toMatchObject({ value: 'A headline still in progress.', source: 'active' });

    // The pair ships on `@getstet/stet/server` — the layer that holds the
    // signing secret — and nowhere else: both calls above resolve from that
    // barrel, and the root entry answers for neither. That is what keeps the
    // signature's builtin off the entry a browser bundle walks.
    expect({ root: ['mintPreviewToken', 'verifyPreviewToken'].filter((k) => k in root) }).toEqual({
      root: [],
    });
  });

  it('Requirement: The read surface ships free of Node builtins', () => {
    // The two entries a host's bundler resolves. Whatever they reach at
    // runtime, webpack has to load: one `node:` specifier in the closure is
    // where a pages-router build stops, naming Node's module and never stet.
    const generatorHalf = /(^|\/)(codegen|preview-token)\.ts$/;
    for (const entry of ['../src/index.ts', '../react/index.ts']) {
      const closure = runtimeImportClosure(new URL(entry, import.meta.url));
      // The react closure legitimately names `react`; only builtins are the
      // property under test.
      expect({ entry, builtins: closure.bare.filter(isNodeBuiltin) }).toEqual({ entry, builtins: [] });
      expect({ entry, generator: closure.modules.filter((m) => generatorHalf.test(m)) }).toEqual({
        entry,
        generator: [],
      });
    }

    // The walker is proven to SEE a builtin before it vouches for none: the two
    // modules that carry the crypto import are outside both closures above, and
    // walking from either one finds it.
    for (const owner of ['../src/codegen.ts', '../src/preview-token.ts']) {
      const closure = runtimeImportClosure(new URL(owner, import.meta.url));
      expect({ owner, bare: closure.bare }).toEqual({ owner, bare: expect.arrayContaining(['node:crypto']) });
    }

    // The predicate closes both spellings — a bundler refuses the `node:`
    // scheme whether or not the module behind it exists, and the unprefixed
    // form is closed by the builtin list.
    expect(isNodeBuiltin('crypto')).toBe(true);
    expect(isNodeBuiltin('node:crypto')).toBe(true);
    expect(isNodeBuiltin('react')).toBe(false);
    expect(isNodeBuiltin('ajv/dist/2020.js')).toBe(false);
  });
});

describe('validation', () => {
  it('Requirement: Validation runs offline', () => {
    // The offline guard is installed for every test file; the whole suite runs
    // under it, so reaching the network here would fail rather than pass.
    expect(() => globalThis.fetch('https://example.com')).toThrowError(/offline guard/);

    const verdict = validateSave(
      descriptor,
      { key: 'welcome__body', value: 'Thanks for joining, {{handle}}.' },
      siblingsOf('welcome'),
    );
    expect(verdict.ok).toBe(true);
    expect(checkCurrency(descriptor, snapshot)).toEqual({ missing: [], orphans: [], warnings: [] });
  });

  it('Requirement: Limits enforce by declared severity', () => {
    const hard = checkLimits(descriptor, 'farewell_notice', 'x'.repeat(4200));
    expect(hard.ok).toBe(false);
    expect(hard.findings[0]?.message).toContain('farewell_notice');
    expect(hard.findings[0]?.message).toContain('4200');
    expect(hard.findings[0]?.message).toContain('4096');

    const advisory = checkLimits(descriptor, 'hero_headline', 'x'.repeat(80));
    expect(advisory.ok).toBe(true);
    expect(advisory.findings[0]?.severity).toBe('warning');

    // The limit reaches every string the value contains, and the finding names
    // the entry an operator has to fix rather than the key holding it. The
    // fixture is unchanged: a copy carries the limits this scenario needs.
    const structured = mutable(descriptor);
    structured.keys['footer_links']!.limits = { max: 40, severity: 'hard' };
    structured.keys['contact_form_labels']!.limits = { max: 5, severity: 'advisory' };
    const entry = checkLimits(structured, 'footer_links', ['Pricing', 'x'.repeat(90)]);
    expect(entry.ok).toBe(false);
    expect(entry.findings[0]).toMatchObject({ key: 'footer_links[1]', length: 90, max: 40 });
    const field = checkLimits(structured, 'contact_form_labels', { name: 'Name', email: 'Email address' });
    expect(field.findings[0]).toMatchObject({ key: 'contact_form_labels.email', severity: 'warning' });

    // Shapes with no length semantics are exempt — stated, not silently skipped.
    structured.keys['theme_mode']!.limits = { max: 1, severity: 'hard' };
    structured.keys['brand__radius']!.limits = { max: 0, severity: 'hard' };
    structured.keys['brand__primary']!.limits = { max: 3, severity: 'hard' };
    expect(checkLimits(structured, 'theme_mode', 'system').findings).toEqual([]);
    expect(checkLimits(structured, 'brand__radius', 8).findings).toEqual([]);
    expect(checkLimits(structured, 'brand__primary', '#1d4ed8').findings).toEqual([]);

    // A key declaring `tags` is measured over its PLAIN text, and reports that
    // length, so the counter and a reader agree on what the value says.
    const tagged = mutable(descriptor);
    tagged.keys['hero_headline']!.limits = { max: 20, severity: 'hard' };
    tagged.keys['hero_headline']!.tags = 1;
    const value = '<1>Nineteen chars here</1>';
    expect(value.length).toBe(26);
    expect(plainOf(value).length).toBe(19);
    expect(checkLimits(tagged, 'hero_headline', value).findings).toEqual([]);
    const untagged = mutable(tagged);
    delete untagged.keys['hero_headline']!.tags;
    expect(checkLimits(untagged, 'hero_headline', value).findings[0]).toMatchObject({
      length: 26,
      max: 20,
    });
  });

  it('Requirement: Placeholder tags are kept whole at save', () => {
    const tagged = mutable(descriptor);
    tagged.keys['hero_headline']!.tags = 1;
    const save = (value: string) => validateSave(tagged, { key: 'hero_headline', value });
    const fault = (value: string) => save(value).findings.find((f) => f.rule === 'tags')?.message ?? '';

    // Exactly 1..n, each once, properly nested.
    expect(save('You may<1> need.</1>').ok).toBe(true);
    expect(fault('You may need.')).toContain('tag 1 missing');
    expect(fault('<1>a</1><1>b</1>')).toContain('tag 1 twice');
    expect(fault('</1>a<1>')).toContain('</1> before <1>');
    expect(fault('<1>a')).toContain('<1> never closed');
    expect(fault('<1>a</1><2/>')).toContain('tag 2 beyond 1..1');

    // Reordering is allowed — a translation may move the emphasised part.
    expect(save('<1> our partners</1> may already have your data').ok).toBe(true);
    // Only placeholder-shaped tokens are tags: any other `<` is prose.
    expect(save('a <b>c</b><1/>').ok).toBe(true);
    // A key without `tags` is not checked at all.
    expect(validateSave(descriptor, { key: 'hero_headline', value: 'the <1> shape' }).ok).toBe(true);
  });

  it('Requirement: Undeclared variables are rejected at save', () => {
    const trial = mutable(descriptor);
    trial.keys['welcome__body']!.vars = ['trial_end'];
    const verdict = validateSave(
      trial,
      { key: 'welcome__body', value: 'Your trial ends {{trialEnd}}.' },
      siblingsOf('welcome'),
    );
    expect(verdict.ok).toBe(false);
    const finding = verdict.findings.find((f) => f.rule === 'vars');
    expect(finding?.vars).toEqual(['trialEnd']);
    expect(finding?.message).toContain('trialEnd');

    // A list entry cannot hide one either. The check walks the contained
    // strings exactly as the limit walk does, names the entry path, and blocks
    // the save — an error-severity gate with a hole for structured shapes was
    // the same gap limits had, on a rule that rejects rather than warns.
    const inList = validateSave(descriptor, {
      key: 'footer_links',
      value: ['Pricing', 'Ask {{nope}}'],
    });
    expect(inList.ok).toBe(false);
    const entry = inList.findings.find((f) => f.rule === 'vars');
    expect(entry).toMatchObject({ severity: 'error', key: 'footer_links[1]', vars: ['nope'] });
  });

  it('Requirement: Class rules bind at save time', () => {
    // Marketing with no unsubscribe anywhere in scope: rejected.
    const bare = checkClassRules(descriptor, 'newsletter', {
      newsletter__subject: 'August',
      newsletter__body: 'Nothing to click.',
    });
    expect(bare.ok).toBe(false);
    expect(bare.findings[0]?.message).toContain('unsubscribe_url');

    // The wrapper carries it: passes, the majority case.
    expect(checkClassRules(descriptor, 'welcome', siblingsOf('welcome')).ok).toBe(true);

    // A sibling slot with no stored value resolves from the snapshot, and the
    // in-scope test passes on what the caller resolved.
    const siblings = siblingsOf('newsletter');
    expect(resolve(descriptor, snapshot, [], { key: 'newsletter__body' }).source).toBe('snapshot');
    expect(checkClassRules(descriptor, 'newsletter', siblings).ok).toBe(true);

    // Transactional: a promotional subject warns and still ships.
    const receipt = checkClassRules(descriptor, 'receipt', {
      ...siblingsOf('receipt'),
      receipt__subject: 'Your receipt, plus 20% off',
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.findings[0]).toMatchObject({ severity: 'warning', slot: 'subject' });

    // The postal line warns and never blocks, in both directions. With neither
    // carrier the save still succeeds and the finding names both; with either
    // one there is nothing to report — stet verifies an address exists, it
    // cannot conjure one.
    const noPostal = checkClassRules(descriptor, 'newsletter', {
      ...siblings,
      brand__footer_address: undefined,
    });
    expect(noPostal.ok).toBe(true);
    expect(noPostal.findings.map((f) => `${f.rule}/${f.severity}`)).toEqual(['class/warning']);
    expect(noPostal.findings[0]?.message).toContain('postal_address');
    expect(noPostal.findings[0]?.message).toContain('brand__footer_address');
    expect(checkClassRules(descriptor, 'newsletter', siblings).findings).toEqual([]);

    // The other carrier, so "either" is proved here rather than only in the
    // unit suite: the host's frame declares the address and no brand value is
    // in scope at all.
    const wrapped = mutable(descriptor);
    wrapped.templates!['newsletter']!.wrapperProvides = ['postal_address'];
    expect(
      checkClassRules(wrapped, 'newsletter', { ...siblings, brand__footer_address: undefined })
        .findings,
    ).toEqual([]);
  });

  it('Requirement: Descriptor and snapshot currency is checked as sets', () => {
    const shrunk = mutable(descriptor);
    delete shrunk.keys['blog_intro'];
    const before = JSON.stringify(snapshot);
    const report = checkCurrency(shrunk, snapshot);
    expect(report.orphans).toEqual(['blog_intro']);
    expect(report.missing).toEqual([]);
    expect(JSON.stringify(snapshot)).toBe(before);

    // Both maps are read as OWN properties, so a key named like a prototype
    // member produces the same two findings any other name would. Assigned
    // rather than written into the literal: `constructor` in an object literal
    // takes `Object.prototype`'s type, not the index signature's.
    const declared: Descriptor['keys'] = {};
    declared['constructor'] = { shape: 'text', target: 'web' };
    expect(checkCurrency({ version: 1, keys: declared }, { default: {} }).missing).toEqual([
      'constructor',
    ]);
    const orphaned: Snapshot = { default: {} };
    orphaned['default']!['constructor'] = 'x';
    expect(checkCurrency({ version: 1, keys: {} }, orphaned).orphans).toEqual(['constructor']);
  });

  it('Requirement: Fit budgets check as advisories, never gates', () => {
    const verdict = validateSave(descriptor, { key: 'hero_headline', value: 'x'.repeat(100) });
    const advisory = verdict.findings.find((f) => f.rule === 'budget');
    expect(advisory).toMatchObject({ severity: 'warning', key: 'hero_headline' });
    expect(advisory?.message).toContain('estimate');

    // Which metrics produced the estimate is a structured field on every
    // advisory, not prose a consumer has to parse out of the message.
    expect(checkBudget(descriptor, 'hero_headline', 'x'.repeat(100))?.metricsFrom).toBe(
      webTarget.name,
    );
    expect(verdict.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(checkBudget(descriptor, 'blog_intro', 'x'.repeat(9000))).toBeNull();

    // The estimate is per explicit line: three short lines are three lines, not
    // the one line their combined width would suggest.
    expect(checkBudget(descriptor, 'hero_headline', 'a\nb\nc')).toMatchObject({
      device: 'desktop',
      estimate: 3,
      budget: 2,
    });

    // Structured values get no estimate in phase 1 — a list's layout is the host's.
    const listBudget = mutable(descriptor);
    listBudget.keys['footer_links']!.budget = { desktop: 1 };
    expect(checkBudget(listBudget, 'footer_links', ['x'.repeat(100), 'x'.repeat(100)])).toBeNull();
  });
});

describe('targets', () => {
  it('Requirement: One adapter per target, one registry', async () => {
    // One adapter is one module, and its whole surface is enumerable here: the
    // §13.6 B recipe minus preview, which joins when its consumer exists.
    expect(Object.keys(webTarget).sort()).toEqual([
      'charsPerLine',
      'escape',
      'illegalConstructs',
      'name',
    ]);

    // Consumers look up by the key's declared target, and the registry hands
    // over the adapter itself — one row, not a copy per consumer. Adding the
    // next target is that file plus that row, with no consumer edit.
    expect(targetAdapter('web')).toBe(webTarget);
    expect(targetAdapterIfShipped('web')).toBe(webTarget);

    expect(targetAdapter('html-email')).toBe(htmlEmailTarget);
    expect(targetAdapterIfShipped('html-email')).toBe(htmlEmailTarget);

    // Two lookup forms, because an unshipped target means different things to
    // different consumers. The requiring form throws and names the target.
    expect(() => targetAdapter('telegram-md2')).toThrowError(/telegram-md2/);
    expect(targetAdapterIfShipped('telegram-md2')).toBeUndefined();

    // Every shipped row declares usable metrics, asserted over the registry
    // itself rather than a parallel list: an adapter shipping `0` would
    // otherwise estimate "Infinity lines" for every value. Structural, not a
    // runtime clamp — a clamp repairs the broken row silently.
    for (const name of ['web', 'html-email', 'telegram-md2'] as const) {
      const shipped = targetAdapterIfShipped(name);
      if (shipped === undefined) continue;
      for (const device of ['desktop', 'mobile'] as const) {
        const metric = shipped.charsPerLine[device];
        expect(`${name}.${device}: ${Number.isInteger(metric) && metric >= 1}`).toBe(
          `${name}.${device}: true`,
        );
      }
    }

    // The crash case is live rather than hypothetical: 1 of the fixture's 25
    // declared keys names a target whose adapter ships in a later change, and a
    // check over that project completes.
    const unshipped = keys.filter(
      (key) => targetAdapterIfShipped(descriptor.keys[key]!.target) === undefined,
    );
    expect(unshipped).toHaveLength(1);
    expect(keys).toHaveLength(25);
    const host = makeCliHost({ config: {} });
    expect(await host.run('check')).toBe(0);

    // Such a key's budget still estimates — under web's metrics, with the
    // fallback named and carried structurally — while its construct check is
    // skipped. A copy carries the budget: no unshipped-target fixture key has
    // one.
    const budgeted = mutable(descriptor);
    budgeted.keys['farewell_notice']!.budget = { desktop: 1 };
    const estimate = checkBudget(budgeted, 'farewell_notice', 'x'.repeat(100));
    expect(estimate).toMatchObject({ device: 'desktop', estimate: 3, budget: 1, metricsFrom: 'web' });
    expect(estimate?.message).toContain('web metrics — telegram-md2 adapter not shipped');
    const verdict = validateSave(budgeted, { key: 'farewell_notice', value: 'x'.repeat(100) });
    expect(verdict.findings.some((f) => f.rule === 'construct')).toBe(false);

    // No consumer branches on a target name inline. The sanctioned homes are
    // the type file, the generated schema and the registry's own directory —
    // which is the requirement's point, so they are named rather than swept in.
    // (`adapters/` is out of scope: `store-memory` defaults a row's target
    // column, which is storage, not behavior.)
    const literal = /['"`](web|html-email|telegram-md2)['"`]/;
    // Path PREFIXES, over the same recursive collection every other structural
    // scan uses: `targets/` excludes the registry's whole directory however
    // deep it grows, rather than relying on a non-recursive read to miss it.
    const sanctioned = ['types.ts', 'descriptor-schema.generated.ts', 'targets/'];
    for (const dir of ['../src/', '../cli/', '../server/']) {
      for (const name of sourceFiles(new URL(dir, import.meta.url))) {
        if (sanctioned.some((prefix) => name.startsWith(prefix))) continue;
        const source = readFileSync(new URL(`${dir}${name}`, import.meta.url), 'utf8');
        expect(`${dir}${name}: ${literal.test(source)}`).toBe(`${dir}${name}: false`);
      }
    }
  });

  it("Requirement: The web target's rules", () => {
    // Escaped text is inert in HTML text and quoted attribute values — the two
    // contexts this escape serves, and the only two it claims. Exactly five
    // characters, ampersand FIRST: `<script>` discriminates the order, since
    // escaping it last re-encodes the entities the other replacements just
    // wrote and the page reads `&amp;lt;script&amp;gt;`.
    expect(webTarget.escape('&')).toBe('&amp;');
    expect(webTarget.escape('<')).toBe('&lt;');
    expect(webTarget.escape('>')).toBe('&gt;');
    expect(webTarget.escape('"')).toBe('&quot;');
    expect(webTarget.escape("'")).toBe('&#39;');
    expect(webTarget.escape('<script>')).toBe('&lt;script&gt;');

    // Outside those two contexts it is the wrong tool, and the contract says
    // so: an unquoted attribute value ends at the first space, and a URL keeps
    // its scheme. Asserted, so the restriction is a fact of the suite rather
    // than only of the prose.
    expect(webTarget.escape('x onmouseover=alert(1)')).toBe('x onmouseover=alert(1)');
    expect(webTarget.escape('javascript:alert(1)')).toBe('javascript:alert(1)');

    // Byte-faithful to stored text: a value that contains an entity contains
    // text, and escaping says so.
    expect(webTarget.escape('&lt;')).toBe('&amp;lt;');

    // The metrics live here — the package's one home for them — and they are
    // what the budget estimate reads.
    expect(webTarget.charsPerLine).toEqual({ desktop: 40, mobile: 20 });
    expect(checkBudget(descriptor, 'hero_headline', 'x'.repeat(100))).toMatchObject({
      device: 'mobile',
      estimate: 5,
    });

    // No illegal constructs, stated: an empty check is a decision here, not an
    // omission. HTML imposes none at the value level.
    expect(webTarget.illegalConstructs('<script>alert(1)</script>', 'hero_headline')).toEqual([]);
  });

  it("Requirement: The html-email target's rules", () => {
    // The same five characters, ampersand first — an email client renders HTML
    // — and the same two-context restriction. Byte-identical to web's output
    // today, and deliberately not shared code: telegram-md2's table is a
    // different one entirely.
    expect(htmlEmailTarget.escape('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    expect(htmlEmailTarget.escape('<script>')).toBe('&lt;script&gt;');
    expect(htmlEmailTarget.escape('x onmouseover=alert(1)')).toBe('x onmouseover=alert(1)');

    // A tag in a slot cannot save, and the finding names the entry path an
    // operator has to fix rather than the key holding it — markup belongs to
    // the host's render shell, which is what the message says.
    const emailList = mutable(descriptor);
    emailList.keys['footer_links']!.target = htmlEmailTarget.name;
    const tagged = validateSave(emailList, {
      key: 'footer_links',
      value: ['Privacy', 'Read the <b>terms</b>'],
    });
    expect(tagged.ok).toBe(false);
    const construct = tagged.findings.find((f) => f.rule === 'construct');
    expect(construct).toMatchObject({ severity: 'error', key: 'footer_links[1]' });
    expect(construct?.message).toContain('render shell');

    // An unterminated open still blocks: the string shell supplies the closing
    // bracket itself, so demanding it inside the value would miss the attack.
    expect(
      validateSave(
        descriptor,
        { key: 'welcome__body', value: 'Hi {{handle}} <script src="//evil.example' },
        siblingsOf('welcome'),
      ).ok,
    ).toBe(false);

    // Prose comparisons, an RFC-5322 address and a placeholder are not tags.
    for (const value of [
      'You paid {{amount}}. 5 < 6 and 7 > 3.',
      'Reply to <support@example.com>',
      'Sign off as <Your Name>.',
    ]) {
      expect(`${value}: ${htmlEmailTarget.illegalConstructs(value, 'receipt__body').length}`).toBe(
        `${value}: 0`,
      );
    }

    // The documented false positive, asserted where it will be looked for: an
    // element-named placeholder blocks, because the rule cannot tell it from
    // markup. That is the accepted cost of blocking with no override path.
    expect(htmlEmailTarget.illegalConstructs('Sent on <Time>.', 'receipt__body')).toHaveLength(1);

    // Email budgets estimate under email metrics, disclose nothing, and say so
    // structurally: the adapter is shipped.
    expect(htmlEmailTarget.charsPerLine).toEqual({ desktop: 37, mobile: 20 });
    const budgeted = mutable(descriptor);
    budgeted.keys['welcome__subject']!.budget = { desktop: 1 };
    const estimate = checkBudget(budgeted, 'welcome__subject', 'x'.repeat(100));
    expect(estimate).toMatchObject({
      device: 'desktop',
      estimate: 3,
      budget: 1,
      metricsFrom: htmlEmailTarget.name,
    });
    expect(estimate?.message).not.toContain('not shipped');
  });

  it("Requirement: Values are stored raw; escaping is the emitter's", async () => {
    const store = createMemoryStore({ project: 'walk' });
    const raw = 'Tom & Jerry <3';

    // Nothing on the save path escapes: the value validates and stores as the
    // operator typed it, byte for byte.
    expect(validateSave(descriptor, { key: 'hero_body', value: raw }).ok).toBe(true);
    ok(await store.saveDraft({ key: 'hero_body', value: raw, target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_body', editor: 'neil' }));
    expect(ok(await store.read()).find((r) => r.key === 'hero_body')?.value).toBe(raw);

    // Entity encoding appears only in the adapter's own output, for a surface
    // stet emits. A store holding this form would double-escape in the host's
    // renderer, which does its own.
    expect(webTarget.escape(raw)).toBe('Tom &amp; Jerry &lt;3');
  });
});

describe('seo', () => {
  /** The fixture, copied so a case can break it. The committed one is seo-clean. */
  const broken = () => ({ d: mutable(descriptor), s: mutable(snapshot) });
  const of = (findings: SeoFinding[], rule: SeoRule) => findings.filter((f) => f.rule === rule);

  it('Requirement: seo check runs offline from descriptor and snapshot', async () => {
    // Two committed files in, findings out — no rows, no adapter, no network.
    // The guard in tests/setup.offline.ts throws on any of the three, so a rule
    // that reached for one would fail here rather than pass quietly.
    expect(seoCheck(descriptor, snapshot)).toEqual([]);

    // Values resolve through the package's one path, with no store rows: the
    // derived title the check measures is the title production serves.
    const title = descriptor.pages?.['home']?.seo?.title ?? '';
    expect(seoCheck(descriptor, snapshot)).toEqual([]);
    expect(resolve(descriptor, snapshot, [], { key: title })).toMatchObject({
      value: 'Never miss a post again. — Mirra',
      source: 'derived',
    });

    // The command completes with a store declared and its connection variable
    // unset — the fork-PR case, where a command that built an adapter would
    // die — and says, once, that it reads committed copy rather than production.
    const forkPr = makeCliHost({ config: { store: { adapter: 'pg' } }, env: {} });
    expect(await forkPr.run('seo', 'check')).toBe(0);
    expect(forkPr.stdout()).toContain('seo: 2 pages checked');
    expect(forkPr.stderr()).toContain('validates the committed snapshot, not production');
    expect(forkPr.stderr()).toContain('stet pull');
    expect(forkPr.stderr()).not.toContain('STET_DATABASE_URL');

    // The warn is about a store, so a snapshot-only project is not told about
    // one — and it never moves the exit code either way.
    const snapshotOnly = makeCliHost({ config: {} });
    expect(await snapshotOnly.run('seo', 'check')).toBe(0);
    expect(snapshotOnly.stderr()).toBe('');

    // An ADOPTED host with no pages ran every rule over nothing: `0 pages
    // checked, 0 errors` is not a pass, and saying so is the difference between
    // a vacuous green and a report. Outside the severity table like the warn
    // above — no rule id, no override, the exit unmoved.
    const noPages = makeCliHost({ config: {} });
    writeFileSync(
      join(noPages.cwd, 'content/descriptor.json'),
      JSON.stringify({ version: 1, keys: { hero_headline: { shape: 'text', target: 'web' } } }, null, 2),
    );
    writeFileSync(
      join(noPages.cwd, 'content/defaults.json'),
      JSON.stringify({ default: { hero_headline: 'Never miss a post again.' } }, null, 2),
    );
    expect(await noPages.run('seo', 'check')).toBe(0);
    expect(noPages.stderr()).toContain('no pages declared — the SEO rules have nothing to check');
    // The remedy is the command, named: the requirement says the warn tells the
    // host what to run, and the prefix above would pass whatever followed it.
    expect(noPages.stderr()).toContain('run stet pages scan');
    expect(noPages.stdout()).toContain('seo: 0 pages checked');

    // A BARE repo has adopted nothing, so there is nothing to be vacuous about.
    const bare = makeCliHost({ config: {} });
    writeFileSync(join(bare.cwd, 'content/descriptor.json'), JSON.stringify({ version: 1, keys: {} }, null, 2));
    writeFileSync(join(bare.cwd, 'content/defaults.json'), JSON.stringify({ default: {} }, null, 2));
    expect(await bare.run('seo', 'check')).toBe(0);
    expect(bare.stderr()).not.toContain('no pages declared');
  });

  it('Requirement: One severity table governs the rules', async () => {
    expect(SEO_SEVERITY).toEqual({
      'missing-title': 'error',
      'missing-description': 'error',
      'duplicate-title': 'error',
      'over-length': 'error',
      'canonical-noindex': 'error',
      'visible-content': 'error',
      'missing-alt': 'error',
      'anchor-text': 'warning',
      'machine-field': 'warning',
    });

    // Warns are reported and do not gate.
    const warned = makeCliHost({ config: {} });
    writeFileSync(
      join(warned.cwd, 'content/defaults.json'),
      JSON.stringify({ ...snapshot, default: { ...snapshot['default'], footer_links: ['Click here'] } }, null, 2),
    );
    expect(await warned.run('seo', 'check', '--json')).toBe(0);
    const warnAnswer = warned.json<{
      ok: boolean;
      seo: Array<{ rule: string; severity: string; key?: string; locale?: string }>;
      findings: Array<{ kind: string; level: string }>;
    }>();
    expect(warnAnswer.ok).toBe(true);
    expect(warnAnswer.seo).toHaveLength(1);
    // The rule id is the finding's kind, and the structured block carries the
    // page/key/locale `CliFinding` has no field for.
    expect(warnAnswer.findings[0]?.kind).toBe('anchor-text');
    expect(warnAnswer.seo[0]).toMatchObject({
      rule: 'anchor-text',
      severity: 'warning',
      key: 'footer_links[0]',
      locale: 'default',
    });

    // The same project, one config line different, exits 1.
    const flipped = makeCliHost({ config: { seoCheck: { 'anchor-text': 'error' } } });
    writeFileSync(join(flipped.cwd, 'content/defaults.json'), warned.file('content/defaults.json'));
    expect(await flipped.run('seo', 'check')).toBe(1);

    // An unknown id is a config error naming the block and the id; so is a
    // severity outside the two — there is no third state.
    const unknown = makeCliHost({ config: { seoCheck: { 'anchor-txt': 'error' } } });
    expect(await unknown.run('seo', 'check')).toBe(1);
    expect(unknown.stderr()).toContain('seoCheck.anchor-txt');
    const third = makeCliHost({ config: { seoCheck: { 'anchor-text': 'off' } } });
    expect(await third.run('seo', 'check')).toBe(1);
    expect(third.stderr()).toContain('"error" or "warn"');
  });

  it('Requirement: The completeness rules', async () => {
    // The title rule is the description rule with the field word swapped, and
    // it fails either way it can happen. An unreferenced field carries no key
    // in its payload; the reference the operator must edit is the descriptor's.
    const noTitle = broken();
    delete noTitle.d.pages?.['pricing']?.seo?.title;
    const unnamed = of(seoCheck(noTitle.d, noTitle.s), 'missing-title');
    expect(unnamed).toMatchObject([{ severity: 'error', page: 'pricing', locale: 'default' }]);
    expect(unnamed[0]?.key).toBeUndefined();

    // The scaffolded empty title `pages scan --apply` announces is exactly this
    // finding, and it names the key that resolves to nothing.
    const blankTitle = broken();
    delete blankTitle.d.keys['seo_pricing_title']!.derivesFrom;
    delete blankTitle.d.keys['seo_pricing_title']!.tmpl;
    blankTitle.s['default']!['seo_pricing_title'] = '';
    expect(of(seoCheck(blankTitle.d, blankTitle.s), 'missing-title')).toMatchObject([
      { severity: 'error', page: 'pricing', key: 'seo_pricing_title', locale: 'default' },
    ]);

    // And it gates: the same descriptor through the command exits 1.
    const titleless = makeCliHost({ config: {} });
    writeFileSync(join(titleless.cwd, 'content/descriptor.json'), JSON.stringify(noTitle.d, null, 2));
    expect(await titleless.run('seo', 'check')).toBe(1);
    expect(titleless.stderr()).toContain('page "pricing" declares no SEO title');

    // A page with no resolvable description fails, either way it can happen.
    const unreferenced = broken();
    delete unreferenced.d.pages?.['pricing']?.seo?.description;
    expect(of(seoCheck(unreferenced.d, unreferenced.s), 'missing-description')).toMatchObject([
      { severity: 'error', page: 'pricing' },
    ]);

    const empty = broken();
    empty.s['default']!['seo_pricing_desc'] = '   ';
    expect(of(seoCheck(empty.d, empty.s), 'missing-description')).toHaveLength(1);

    // The bound is on the RESOLVED value: a headline inside its own 60-character
    // limit, pushed over by its derivation template. No crawler could attribute
    // that, because no crawler sees the template.
    const long = broken();
    long.s['default']!['hero_headline'] = 'x'.repeat(55);
    expect(checkLimits(long.d, 'hero_headline', long.s['default']!['hero_headline']).ok).toBe(true);
    const overLength = of(seoCheck(long.d, long.s), 'over-length');
    expect(overLength).toMatchObject([{ page: 'home', key: 'seo_home_title' }]);
    expect(overLength[0]?.message).toContain('63 characters');

    // Descriptions carry the same rule at 160.
    const wordy = broken();
    wordy.s['default']!['seo_home_desc'] = 'y'.repeat(161);
    expect(of(seoCheck(wordy.d, wordy.s), 'over-length')[0]?.message).toContain('161 characters');

    // An OG image without alt text is an error: alt text is copy.
    const noAlt = broken();
    noAlt.d.pages!['home']!.seo!.ogImage = 'brand__logo';
    expect(of(seoCheck(noAlt.d, noAlt.s), 'missing-alt')).toMatchObject([
      { severity: 'error', page: 'home' },
    ]);
  });

  it('Requirement: The consistency rules', () => {
    // Forty pages through one template is ONE finding naming the template, not
    // forty naming pages. Two pages here; the property is the same.
    const templated = broken();
    templated.d.keys['seo_pricing_title']!.derivesFrom = 'hero_headline';
    templated.d.keys['seo_pricing_title']!.tmpl = '{v} — Mirra';
    const grouped = of(seoCheck(templated.d, templated.s), 'duplicate-title');
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.message).toContain('{v} — Mirra');
    expect(grouped[0]?.message).toContain('2 pages');
    expect(grouped[0]?.message).not.toContain('"pricing"');

    // Locale-aware: one page saying the same thing in two locales is a
    // translation that has not happened, never two pages competing.
    const bilingual = broken();
    bilingual.d.pages!['home']!.locales = ['default', 'de'];
    bilingual.s['de']!['hero_headline'] = 'Never miss a post again.';
    expect(of(seoCheck(bilingual.d, bilingual.s), 'duplicate-title')).toEqual([]);

    // A canonical resolving to a declared page's route where that page is
    // noindex — in either robots shape, since a directive set is a list.
    for (const robots of ['noindex, nofollow', ['noindex', 'max-snippet:-1']]) {
      const pointed = broken();
      pointed.d.keys['seo_home_canonical'] = { shape: 'text', target: 'web', pages: ['home'] };
      pointed.d.keys['seo_pricing_robots'] = {
        shape: Array.isArray(robots) ? 'list' : 'text',
        target: 'web',
        pages: ['pricing'],
      };
      pointed.d.pages!['home']!.seo!.canonical = 'seo_home_canonical';
      pointed.d.pages!['pricing']!.seo!.robots = 'seo_pricing_robots';
      pointed.s['default']!['seo_home_canonical'] = '/pricing';
      pointed.s['default']!['seo_pricing_robots'] = robots;
      const canonical = of(seoCheck(pointed.d, pointed.s), 'canonical-noindex');
      expect(canonical).toMatchObject([{ severity: 'error', page: 'home' }]);
      expect(canonical[0]?.message).toContain('"pricing"');

      // A canonical naming no declared page is outside the check: the
      // framework computes canonicals, stet audits only the override.
      pointed.s['default']!['seo_home_canonical'] = 'https://mirra.to/blog/one';
      expect(of(seoCheck(pointed.d, pointed.s), 'canonical-noindex')).toEqual([]);
    }

    // Markup must represent visible content, and the registry is what makes it
    // provable: the bound key does not declare the bound page.
    const invisible = broken();
    invisible.d.pages!['home']!.jsonLd!.bindings['name'] = 'pricing_price';
    expect(of(seoCheck(invisible.d, invisible.s), 'visible-content')).toMatchObject([
      { severity: 'error', page: 'home', key: 'pricing_price' },
    ]);
    expect(of(seoCheck(invisible.d, invisible.s), 'visible-content')[0]?.message).toContain('"name"');
  });

  it('Requirement: The lint rules ship their word lists', () => {
    // No config, no network, no pack: the lists are inside the package, and
    // that is what a warn firing here proves.
    const labelled = broken();
    labelled.s['default']!['footer_links'] = ['Privacy', 'Click here', 'Read more about the terms'];
    const anchors = of(seoCheck(labelled.d, labelled.s), 'anchor-text');
    // Whole values only: entry 1 IS a label, entry 2 merely contains the phrase.
    expect(anchors).toMatchObject([{ severity: 'warning', key: 'footer_links[1]' }]);

    // §13.1c's rule is anchors on pages, so a non-web target is outside it.
    const emailed = broken();
    emailed.s['default']!['welcome__subject'] = 'Click here';
    expect(of(seoCheck(emailed.d, emailed.s), 'anchor-text')).toEqual([]);

    // Incentive copy in a JSON-LD-bound value warns, naming page, field and key.
    const sold = broken();
    sold.s['default']!['pricing_tier_name'] = 'Premium — buy now';
    const machine = of(seoCheck(sold.d, sold.s), 'machine-field');
    expect(machine).toMatchObject([
      { severity: 'warning', page: 'pricing', key: 'pricing_tier_name' },
    ]);
    expect(machine[0]?.message).toContain('"name"');
    expect(machine[0]?.message).toContain('buy now');

    // The per-phrase matcher: "#1" is a phrase, "#16" is a number.
    const ranked = broken();
    ranked.s['default']!['pricing_tier_name'] = 'The #1 plan';
    expect(of(seoCheck(ranked.d, ranked.s), 'machine-field')).toHaveLength(1);
    ranked.s['default']!['pricing_tier_name'] = 'Plan #16';
    expect(of(seoCheck(ranked.d, ranked.s), 'machine-field')).toEqual([]);
  });

  it('Requirement: pages scan declares routes by confirmation, never inference', async () => {
    // An adopted host with keys, no pages, and a real Next App route tree —
    // the shape the redo closed on, where `seo: 0 pages checked` was a pass
    // that only meant there had been no input.
    const host = makeAdoptionHost();
    host.write(
      'content/descriptor.json',
      JSON.stringify(
        {
          version: 1,
          keys: {
            hero_headline: { shape: 'text', target: 'web' },
            // A key a human wrote, under a name the scaffolder would take.
            seo_docs_title: { shape: 'text', target: 'web', label: 'Docs title' },
          },
        },
        null,
        2,
      ),
    );
    host.write(
      'content/defaults.json',
      JSON.stringify({ default: { hero_headline: 'Never miss a post again.', seo_docs_title: 'Docs — Mirra' } }, null, 2),
    );
    // `app/page.tsx` and `app/layout.tsx` come with the host: one route and one
    // file the framework's own contract says is not a route.
    host.write('app/team/page.tsx', 'export default function Team() { return null; }\n');
    host.write('app/docs/page.tsx', 'export default function Docs() { return null; }\n');
    host.write('app/blog/[slug]/page.tsx', 'export default function Post() { return null; }\n');
    host.write('app/api/health/route.ts', 'export function GET() { return null; }\n');

    // Before anything is declared, the rules have nothing to check and say so.
    expect(await host.run('seo', 'check')).toBe(0);
    expect(host.stderr()).toContain('no pages declared — the SEO rules have nothing to check');

    const before = {
      descriptor: host.file('content/descriptor.json'),
      snapshot: host.file('content/defaults.json'),
    };
    expect(await host.run('pages', 'scan')).toBe(0);
    expect(host.stdout()).toContain('home (/)');
    expect(host.stdout()).toContain('team (/team)');
    expect(host.stdout()).toContain('  seo: seo_team_title, seo_team_desc — scaffolded empty');
    // Every route the reading cannot make deterministic is a NAMED skip: a
    // route template, a handler serving a document that is not a page, and a
    // scaffold name a human's key already holds.
    expect(host.stderr()).toContain('app/blog/[slug]/page.tsx: skipped (dynamic-route)');
    // The scenario names the remedy as well as the file and the reason: the
    // route pattern is declared by hand, and the host expands it.
    expect(host.stderr()).toContain('declare the route pattern by hand — the host expands it');
    expect(host.stderr()).toContain('app/api/health/route.ts: skipped (endpoint)');
    expect(host.stderr()).toContain('app/docs/page.tsx: skipped (key-collision)');
    expect(host.stderr()).toContain('seo_docs_title');
    // Nothing is written without confirmation.
    expect(Buffer.from(host.file('content/descriptor.json'), 'utf8').equals(Buffer.from(before.descriptor, 'utf8'))).toBe(true);
    expect(Buffer.from(host.file('content/defaults.json'), 'utf8').equals(Buffer.from(before.snapshot, 'utf8'))).toBe(true);

    // The confirmation. Records and keys land together — a record whose keys
    // did not land makes the descriptor unloadable — and the close announces
    // the red it just created, as ADDITIONS.
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    expect(host.stdout()).toContain('declared 2 page(s), scaffolded 4 key(s); next: stet seo check');
    expect(host.stdout()).toContain('seo check will now report 2 more missing titles and 2 more missing descriptions');

    const declared = loadDescriptor(JSON.parse(host.file('content/descriptor.json')));
    expect(Object.keys(declared.pages ?? {}).sort()).toEqual(['home', 'team']);
    expect(declared.pages?.['team']).toEqual({
      route: '/team',
      parent: 'home',
      seo: { title: 'seo_team_title', description: 'seo_team_desc' },
    });

    // AN ANCESTOR LANDING LATER FILLS THE PARENT. The child is declared first,
    // with no ancestor to point at; the run that declares the ancestor fills it
    // in the same batch and reports the fill on its own line — and a `parent`
    // set by hand is left exactly as written.
    const late = makeAdoptionHost();
    late.write('content/descriptor.json', JSON.stringify({ version: 1, keys: {} }, null, 2));
    late.write('content/defaults.json', JSON.stringify({ default: {} }, null, 2));
    late.write('app/docs/page.tsx', 'export default function Docs() { return null; }\n');
    late.write('app/docs/adopt/page.tsx', 'export default function Adopt() { return null; }\n');
    expect(await late.run('pages', 'scan', '--apply', 'docs_adopt')).toBe(0);
    const child = () => (JSON.parse(late.file('content/descriptor.json')) as {
      pages: Record<string, { parent?: string }>;
    }).pages['docs_adopt'];
    expect(child()?.parent).toBeUndefined();
    const filled = late.out.length;
    expect(await late.run('pages', 'scan', '--apply', 'docs')).toBe(0);
    expect(child()?.parent).toBe('docs');
    expect(late.out.slice(filled).join('\n')).toContain('backfilled parent on 1 page(s)');
    // `home` is nearer to nothing here, and a later run leaves the recorded
    // parent alone — the developer's word is never rewritten.
    expect(await late.run('pages', 'scan', '--apply')).toBe(0);
    expect(child()?.parent).toBe('docs');
    // The human's key is untouched, and the page it would have carried is not
    // declared: refusing to overwrite it is the whole point of the skip.
    expect(declared.keys['seo_docs_title']).toEqual({ shape: 'text', target: 'web', label: 'Docs title' });
    expect(declared.pages?.['docs']).toBeUndefined();
    expect(JSON.parse(host.file('content/defaults.json')).default.seo_team_desc).toBe('');

    // Scaffolded values invent nothing and pass every offline gate; the check
    // that was vacuous is now armed, with exactly the announced findings.
    expect(await host.run('check')).toBe(0);
    expect(await host.run('seo', 'check', '--json')).toBe(1);
    const findings = (JSON.parse(host.out[host.out.length - 1] ?? 'null') as { seo: SeoFinding[] }).seo;
    expect(findings.filter((f) => f.rule === 'missing-description').map((f) => f.page).sort()).toEqual([
      'home',
      'team',
    ]);
    expect(findings.filter((f) => f.rule === 'missing-title').map((f) => f.page).sort()).toEqual([
      'home',
      'team',
    ]);
    expect(
      findings.filter((f) => f.rule !== 'missing-description' && f.rule !== 'missing-title'),
    ).toEqual([]);
    // Sliced from this run alone: the streams accumulate across the commands
    // above, where the vacuous-pass warn was correctly present.
    const said = host.err.length;
    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stdout()).toContain('seo: 2 pages checked');
    expect(host.err.slice(said).join('\n')).not.toContain('no pages declared');

    // The ONE seeded exception. A markdown page under the Astro pages root is a
    // static route like any other, and its proposal additionally reads the
    // frontmatter block — two one-line scalars, quotes stripped — so the
    // scaffolded values are the host's own copy rather than empty. The arm is
    // confirmed by an `.astro` file, so the fixture carries one.
    const md = makeAdoptionHost();
    md.write(
      'content/descriptor.json',
      JSON.stringify(
        {
          version: 1,
          keys: { seo_guide_title: { shape: 'text', target: 'web' } },
          pages: { guide: { route: '/guide', seo: { title: 'seo_guide_title' } } },
        },
        null,
        2,
      ),
    );
    md.write('content/defaults.json', JSON.stringify({ default: { seo_guide_title: 'Old' } }, null, 2));
    md.write('src/pages/handbook.astro', '<h1>Handbook</h1>\n');
    md.write('src/pages/tour.md', '---\ntitle: "The tour"\ndescription: Read this first\n---\n# Tour\n');
    md.write('src/pages/guide.md', '---\ntitle: New\n---\n# Guide\n');

    expect(await md.run('pages', 'scan')).toBe(0);
    expect(md.stdout()).toContain('  seo: seo_tour_title, seo_tour_desc — seeded from frontmatter');
    expect(md.stdout()).toContain('  title: "The tour"');
    expect(md.stdout()).toContain('  description: "Read this first"');
    // An already-declared markdown page whose frontmatter has drifted from the
    // key's default names the difference — the file and the key diverge
    // visibly, never silently — and nothing is written for it.
    expect(md.stderr()).toContain("frontmatter title differs from seo_guide_title's default");

    expect(await md.run('pages', 'scan', '--apply', 'tour')).toBe(0);
    const seeded = JSON.parse(md.file('content/defaults.json')).default;
    expect(seeded.seo_tour_title).toBe('The tour');
    expect(seeded.seo_tour_desc).toBe('Read this first');
    expect(seeded.seo_guide_title).toBe('Old');

    // On the static-HTML host the convention is the `html` arm — the ONE arm the
    // config selects rather than a directory probe. Its one content read is the
    // document's marks, and it mints nothing.
    const html = await makeHtmlHost({
      register: true,
      files: {
        'about.html': '<html><head><meta charset="utf-8"></head><body><p>About the team.</p></body></html>\n',
        'review/shot.png': 'not a page',
      },
    });
    expect(await html.run('pages', 'scan')).toBe(0);
    expect(html.stdout()).toContain('  title: bound to psyon_data_partnerships_for_ai_labs');
    expect(html.stdout()).toContain('  description: bound to psyon_connects_hospitals_labs_and');
    expect(html.stdout()).toContain('  title: no marked <title> — run stet register first, or declare it by hand');
    expect(html.stdout()).not.toContain('shot');

    html.out.length = 0;
    expect(await html.run('pages', 'scan', '--apply')).toBe(0);
    const bound = JSON.parse(html.file('content/descriptor.json')) as {
      pages: Record<string, { seo?: Record<string, string> }>;
      keys: Record<string, { pages?: string[] }>;
    };
    expect(bound.pages['home']?.seo).toEqual({
      title: 'psyon_data_partnerships_for_ai_labs',
      description: 'psyon_connects_hospitals_labs_and',
    });
    // No `seo_home_*` was minted, and the page with no marks scaffolds nothing.
    expect(bound.keys['seo_home_title']).toBeUndefined();
    expect(bound.keys['seo_about_title']).toBeUndefined();
    expect(bound.pages['about']?.seo).toBeUndefined();
    // The bound key carries the page in its reverse index.
    expect(bound.keys['psyon_data_partnerships_for_ai_labs']?.pages).toEqual(['home']);
    // The gap is `seo check`'s to report, honestly.
    html.out.length = 0;
    html.err.length = 0;
    expect(await html.run('seo', 'check')).toBe(1);
    expect(html.stderr()).toContain('page "about" declares no SEO title');
  });
});

describe('store', () => {
  it('Requirement: One normative store interface', async () => {
    const store = createMemoryStore({ project: 'walk' });
    expect(Object.keys(store).filter((k) => typeof (store as never)[k] === 'function').sort()).toEqual([
      'dump',
      'history',
      'publish',
      'read',
      'recent',
      'rename',
      'revert',
      'saveDraft',
      'seed',
    ]);
    expect(store.project).toBe('walk');
    expect(typeof store.canApplyDDL).toBe('boolean');

    // A method an adapter cannot honestly implement answers NotSupported —
    // never a fake success, never a silent no-op, and never an exception the
    // caller has to catch to find out.
    const snapshot = createSnapshotStore({ project: 'walk' });
    const answer = await snapshot.saveDraft({ key: 'hero_headline', value: 'x', target: 'web', editor: 'neil' });
    expect(answer).toEqual({ notSupported: true, method: 'saveDraft' });
    // Nothing was pretended: the store still reads as empty, and a surface can
    // render the project read-only — publish is a commit here.
    expect(ok(await snapshot.read({ preview: true }))).toEqual([]);

    // The changesets capability sits BESIDE the seven as a non-function block,
    // which is why the function list above is unchanged: no adapter gained an
    // eighth method. A block of eight top-level methods would have shown up in
    // that list and broken this requirement.
    expect(typeof store.changesets).toBe('object');
    expect(Object.keys(store.changesets).sort()).toEqual([
      'abandon',
      'discardDraft',
      'get',
      'list',
      'markReverted',
      'open',
      'publishChange',
      'schedule',
    ]);

    // The capability is honestly missing on a snapshot project — an answer
    // naming the method, so a surface disables the affordance rather than
    // guessing.
    expect(await snapshot.changesets.open({ name: 'nope' })).toEqual({
      notSupported: true,
      method: 'changesets.open',
    });

    // The change ref is the save's optional membership argument, and its three
    // intents are distinct: absent leaves membership, null detaches, an id
    // attaches.
    const { changeId } = ok(await store.changesets.open({ name: 'a change' }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'x', target: 'web', editor: 'neil', change: changeId }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'y', target: 'web', editor: 'neil' }));
    const kept = ok(await store.read({ preview: true })).find((r) => r.key === 'hero_headline');
    expect(kept?.changesetId).toBe(changeId);
    ok(await store.saveDraft({ key: 'hero_headline', value: 'z', target: 'web', editor: 'neil', change: null }));
    expect(ok(await store.read({ preview: true })).find((r) => r.key === 'hero_headline')?.changesetId).toBeNull();
  });

  it('Requirement: read returns stored rows, never resolved values', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'Stored.', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
    ok(await store.saveDraft({ key: 'hero_body', value: 'A draft.', target: 'web', editor: 'neil' }));

    // Active rows always; drafts only under an explicit preview. Raw values,
    // no resolution, no fallback: the row is what the store holds — and it
    // carries `target`, `publishAt` and `changesetId`, so the scheduler
    // enumerates due drafts AND splits them grouped from ungrouped, and the
    // audit compares stored targets, all through this same read.
    expect(ok(await store.read())).toEqual([
      {
        key: 'hero_headline',
        locale: 'default',
        status: 'published',
        is_active: true,
        value: 'Stored.',
        version: 1,
        target: 'web',
        publishAt: null,
        changesetId: null,
      },
    ]);
    expect(ok(await store.read({ preview: true })).map((r) => r.status).sort()).toEqual(['draft', 'published']);

    // A grouped draft names its change on the row itself, so the `--due` split
    // and a queue's grouped card need no second query.
    const grouped = ok(await store.changesets.open({ name: 'spring refresh' }));
    ok(
      await store.saveDraft({
        key: 'hero_body',
        value: 'A grouped draft.',
        target: 'web',
        editor: 'neil',
        change: grouped.changeId,
      }),
    );
    const member = ok(await store.read({ preview: true })).find((r) => r.key === 'hero_body');
    expect(member?.changesetId).toBe(grouped.changeId);

    // The schedule stamp is visible on the draft row it belongs to — the one
    // query the scheduler needs, with no separate surface to keep in step.
    ok(
      await store.saveDraft({
        key: 'farewell_notice',
        value: 'auf Wiedersehen',
        target: 'telegram-md2',
        editor: 'neil',
        publishAt: '2026-09-01T09:00:00.000Z',
      }),
    );
    const due = ok(await store.read({ preview: true })).find((r) => r.key === 'farewell_notice');
    expect(due?.publishAt).toBe('2026-09-01T09:00:00.000Z');
    expect(due?.target).toBe('telegram-md2');

    // A locale filter hands over the whole fallback chain: exact-match would
    // starve resolution of the `default` rows it falls back to.
    ok(
      await store.saveDraft({
        key: 'hero_headline',
        value: 'Gespeichert.',
        target: 'web',
        editor: 'neil',
        locale: 'de',
      }),
    );
    ok(await store.publish({ key: 'hero_headline', editor: 'neil', locale: 'de' }));
    expect(ok(await store.read({ locale: 'de' })).map((r) => r.locale).sort()).toEqual(['de', 'default']);

    // The snapshot adapter reads as zero rows, so a snapshot-only project runs
    // the identical fallback path and reports the snapshot as its source.
    const snapshotOnly = createSnapshotStore({ project: 'walk' });
    const none = ok(await snapshotOnly.read());
    expect(none).toEqual([]);
    for (const key of keys) {
      expect(resolve(descriptor, snapshot, none, { key }).source).not.toBe('active');
    }
    expect(resolve(descriptor, snapshot, none, { key: 'hero_headline' })).toMatchObject({
      value: 'Never miss a post again.',
      source: 'snapshot',
    });
  });

  it('Requirement: A read failure is an absence, never a page failure', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'Stored.', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));

    store.failNext = 'read';
    const down = await store.read();
    // A typed error carrying no partial rows — a caller cannot mistake half a
    // read for the truth.
    expect(down).toMatchObject({ storeError: true, code: 'unreachable' });
    expect(Array.isArray(down)).toBe(false);
    expect((down as { message: string }).message).toBeTruthy();

    // Treated as absence by a RENDER caller, every key still renders, and none
    // renders empty.
    for (const key of keys) {
      const resolution = resolve(descriptor, snapshot, null, { key });
      expect(resolution.value).toBeDefined();
      expect(resolution.value).not.toBe('');
    }
    // The stated exception: a caller reading to COMPARE or MIRROR fails loudly
    // instead of proceeding against absence. The per-command proofs are the
    // cli capability's — `diff`, `audit`, `pull` and `publish --due` each exit
    // 1 having written and published nothing (tests/cli.test.ts) — and what
    // they all rest on is this: the answer is a typed error, so a caller can
    // tell absence from emptiness and choose.
    expect(isStoreError(down)).toBe(true);

    // The failure was momentary, not a state: the next read is a real read.
    expect(ok(await store.read())).toHaveLength(1);
  });

  it('Requirement: An adapter is scoped to one project', async () => {
    const db = createMemoryDb();
    const web = createMemoryStore({ project: 'web', db });
    const dash = createMemoryStore({ project: 'dash', db });

    ok(await web.saveDraft({ key: 'hero_headline', value: 'the site H1', target: 'web', editor: 'neil' }));
    const webVersion = ok(await web.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    ok(await dash.saveDraft({ key: 'hero_headline', value: 'the dash H1', target: 'web', editor: 'neil' }));
    ok(await dash.publish({ key: 'hero_headline', editor: 'neil' }));

    // One store, two apps, the same key name — and no collision: dash's publish
    // never becomes web's live H1.
    expect(ok(await web.read())[0]?.value).toBe('the site H1');
    expect(ok(await dash.read())[0]?.value).toBe('the dash H1');
    expect(ok(await web.recent()).rows).toHaveLength(1);

    // No caller can address another project's rows through a configured
    // adapter — including by a version id, which is global.
    expect(await dash.revert({ versionId: webVersion, editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    expect(ok(await web.read())[0]?.value).toBe('the site H1');
  });

  it('Requirement: Published rows are immutable through the interface', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
    const v1 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;

    // No method takes a version id plus a replacement value: the interface has
    // no update path to offer one.
    const methods = Object.keys(store).filter((k) => typeof (store as never)[k] === 'function');
    expect(methods.filter((m) => /update|patch|set|edit/i.test(m))).toEqual([]);

    // Everything downstream mints new rows; the published row keeps its value
    // and its id through all of it.
    ok(await store.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
    ok(await store.revert({ versionId: v1, editor: 'neil' }));
    ok(await store.rename({ oldKey: 'hero_headline', newKey: 'hero_title', editor: 'neil' }));

    const original = ok(await store.history({ key: 'hero_title' })).rows.find((r) => r.id === v1);
    expect(original?.value).toBe('first');
    expect(original?.id).toBe(v1);
    // Revert and rename are the only operations that touch history, and both
    // went through their RPCs.
    expect(ok(await store.history({ key: 'hero_title' })).rows).toHaveLength(3);
  });

  it('Requirement: Four adapters, one conformance suite', async () => {
    const adapters = [
      createMemoryStore({ project: 'walk' }),
      createSnapshotStore({ project: 'walk' }),
      createPgStore({ connectionString: 'postgresql://unused/none', project: 'walk' }),
      createPostgrestStore({ url: 'http://unused.test', token: '', project: 'walk' }),
    ];
    const surface = ['canApplyDDL', 'history', 'project', 'publish', 'read', 'recent', 'rename', 'revert', 'saveDraft'];
    for (const adapter of adapters) {
      for (const member of surface) expect(adapter).toHaveProperty(member);
    }
    // The suite itself runs against memory and snapshot on every commit
    // (conformance/store.test.ts) and against store-pg behind
    // STET_TEST_DATABASE_URL (tests/store-pg.live.test.ts) — where the SQL
    // adapter passes every assertion the reference does, refusals included.
    expect(readFileSync(new URL('./store.test.ts', import.meta.url), 'utf8')).toContain(
      'runStoreConformance',
    );

    // For the snapshot adapter, NotSupported on the write half is the passing
    // behavior, not a skipped case.
    const snapshotStore = adapters[1]!;
    expect(await snapshotStore.publish({ key: 'hero_headline', editor: 'neil' })).toMatchObject({
      notSupported: true,
    });
    await (adapters[2] as ReturnType<typeof createPgStore>).end();
  });

  it('Requirement: Writes are never retried through the store transport', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'landed', target: 'web', editor: 'neil' }));

    store.failNext = 'write';
    const lost = await store.saveDraft({ key: 'hero_headline', value: 'again', target: 'web', editor: 'neil' });
    expect(lost).toMatchObject({ storeError: true });

    // The caller sees the error and nothing fires again on its behalf: exactly
    // one draft row, which is what a retry of a landed write would have doubled.
    expect(store.dump().filter((r) => r.state === 'draft')).toHaveLength(1);

    // Structural, not disciplinary: no adapter carries a retry loop or a
    // backoff timer. (The producing proof — a dropped response after the write
    // landed, with the call counter at exactly 1 — is tests/store-postgrest.test.ts.)
    for (const name of [
      'store-pg.ts',
      'store-postgrest.ts',
      'store-memory.ts',
      'store-shared.ts',
      'changesets.ts',
    ]) {
      const source = readFileSync(new URL(`../adapters/${name}`, import.meta.url), 'utf8');
      expect(`${name}: ${source.includes('while (')}`).toBe(`${name}: false`);
      expect(`${name}: ${source.includes('setTimeout')}`).toBe(`${name}: false`);
    }
  });

  it('Requirement: History is ordered and paged by id', async () => {
    const store = createMemoryStore({ project: 'walk' });
    const ids: number[] = [];
    for (let i = 1; i <= 5; i += 1) {
      ok(await store.saveDraft({ key: 'hero_headline', value: `v${i}`, target: 'web', editor: 'neil' }));
      ids.push(ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId);
    }
    const newestFirst = [...ids].reverse();

    // Ordered by id, never timestamp: five publishes inside one millisecond
    // would tie on `published_at` and still order exactly.
    const all = ok(await store.recent());
    expect(all.rows.map((r) => r.id)).toEqual(newestFirst);
    expect(new Set(all.rows.map((r) => r.publishedAt)).size).toBeLessThanOrEqual(all.rows.length);

    // Keyset, never offset: a row landing between two page reads neither
    // duplicates nor hides one at the boundary.
    const first = ok(await store.recent({ limit: 2 }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'v6', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
    const second = ok(await store.recent({ beforeId: first.nextBeforeId ?? undefined, limit: 2 }));

    expect(first.rows.map((r) => r.id)).toEqual(newestFirst.slice(0, 2));
    expect(second.rows.map((r) => r.id)).toEqual(newestFirst.slice(2, 4));
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(4);
    expect(ok(await store.history({ key: 'hero_headline', beforeId: newestFirst[4] })).nextBeforeId).toBeNull();
  });

  it('Requirement: DDL capability is declared, not assumed', async () => {
    // Every flag answers before any migration decision, without touching a
    // database — these adapters point nowhere and never connect.
    expect(createPgStore({ connectionString: 'postgresql://unused/none', project: 'walk' }).canApplyDDL).toBe(true);
    expect(createPostgrestStore({ url: 'http://unused.test', token: '', project: 'walk' }).canApplyDDL).toBe(false);
    expect(createSnapshotStore({ project: 'walk' }).canApplyDDL).toBe(false);
    expect(createMemoryStore({ project: 'walk' }).canApplyDDL).toBe(false);

    // store-postgrest states its post-DDL contract on the adapter itself: after
    // out-of-band DDL, the schema cache must be told.
    const source = readFileSync(new URL('../adapters/store-postgrest.ts', import.meta.url), 'utf8');
    expect(source).toContain("notify pgrst, 'reload schema'");

    // The install-time reads and writes the flag implies are adapter-MODULE
    // exports beside the factories, never interface methods: the interface
    // stays the seven methods plus the flag, and the conformance suite's
    // method list is unchanged by them.
    expect(typeof readPgMeta).toBe('function');
    expect(typeof applySql).toBe('function');
    expect(typeof writePgDescriptorVersion).toBe('function');
    expect(typeof readPostgrestMeta).toBe('function');
    expect(typeof writePostgrestDescriptorVersion).toBe('function');
    const store = createMemoryStore({ project: 'walk' });
    expect(Object.keys(store).filter((k) => typeof (store as never)[k] === 'function').sort()).toEqual([
      'dump',
      'history',
      'publish',
      'read',
      'recent',
      'rename',
      'revert',
      'saveDraft',
      'seed',
    ]);
    // The declared capability block sits BESIDE that list, not in it — an
    // object property, so it can never be mistaken for an eighth method.
    expect(typeof store.changesets).toBe('object');
    expect(typeof (store as never)['changesets']).not.toBe('function');

    // And the `canApplyDDL: false` apply path prints a post-apply ACCESS check
    // beside the SQL — the path that promises verification verifies access,
    // not only application. (`stet upgrade`'s print branch, tests/cli.test.ts.)
    const upgrade = readFileSync(new URL('../cli/upgrade.ts', import.meta.url), 'utf8');
    expect(upgrade).toContain('has_table_privilege');
  });

  it('Requirement: The changesets capability rides the write adapters', async () => {
    // Every adapter carries the block; the snapshot adapter answers
    // NotSupported from all of it, naming the method it refused.
    for (const store of [
      createMemoryStore({ project: 'walk' }),
      createPgStore({ connectionString: 'postgresql://unused/none', project: 'walk' }),
      createPostgrestStore({ url: 'http://unused.test', token: '', project: 'walk' }),
      createSnapshotStore({ project: 'walk' }),
    ]) {
      expect(Object.keys(store.changesets).sort()).toEqual([
        'abandon',
        'discardDraft',
        'get',
        'list',
        'markReverted',
        'open',
        'publishChange',
        'schedule',
      ]);
    }
    const snapshot = createSnapshotStore({ project: 'walk' });
    expect(await snapshot.changesets.publishChange({ changeId: 1, editor: 'neil' })).toEqual({
      notSupported: true,
      method: 'changesets.publishChange',
    });
    expect(await snapshot.changesets.discardDraft({ key: 'hero_headline' })).toEqual({
      notSupported: true,
      method: 'changesets.discardDraft',
    });

    // Identical observable behavior across the adapters is proven by cases in
    // the ONE store suite — no parallel suite exists — and the Postgres-backed
    // half of that claim runs in tests/store-pg.live.test.ts.
    const suite = readFileSync(new URL('./store.suite.ts', import.meta.url), 'utf8');
    expect(suite).toContain('changesetsSupported');

    // Refusals arrive as the conflict vocabulary's markers, through the same
    // one error-code table as every other raise.
    const store = createMemoryStore({ project: 'walk_capability' });
    const markers = [
      ['no_change:', await store.changesets.get({ changeId: 999 })],
      ['no_members:', await store.changesets.publishChange({ changeId: ok(await store.changesets.open({ name: 'empty' })).changeId, editor: 'neil' })],
      ['no_draft:', await store.changesets.discardDraft({ key: 'never_saved' })],
    ] as const;
    for (const [marker, answer] of markers) {
      expect(answer).toMatchObject({ storeError: true, code: 'conflict' });
      expect((answer as { message: string }).message).toContain(marker);
    }

    // `get` serves both consumers from one read: the revert enumeration takes
    // the minted and before ids, the change-before preview takes the value.
    ok(await store.saveDraft({ key: 'hero_headline', value: 'v1', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
    const { changeId } = ok(await store.changesets.open({ name: 'grouped' }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'v2', target: 'web', editor: 'neil', change: changeId }));
    ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
    const member = ok(await store.changesets.get({ changeId })).members[0];
    expect(member?.beforeValue).toBe('v1');
    expect(member?.versionId).toBeGreaterThan(member?.beforeVersionId ?? 0);
  });
});

describe('publish', () => {
  it('Requirement: Migration 1 ships the complete schema, numbered', () => {
    // Numbered, so stet_meta.schema_version can be parsed against the file set.
    expect(MIGRATION_NAME).toBe('001_content_cms.sql');

    for (const column of [
      'id', 'project', 'key', 'locale', 'target', 'value', 'state', 'is_active',
      'publish_at', 'label', 'note', 'editor', 'origin_env', 'origin_id',
      'published_by', 'reverted_from', 'created_at', 'published_at',
    ]) {
      expect(`${column}: ${MIGRATION.includes(column)}`).toBe(`${column}: true`);
    }

    // The two partial unique indexes are the whole integrity story: a second
    // active row and a second draft are unrepresentable, whatever the
    // application does. (Proven against a live database — the direct-insert
    // rejection — in tests/store-pg.live.test.ts.)
    expect(MIGRATION).toContain('on content_versions (project, key, locale) where is_active');
    expect(MIGRATION).toContain("on content_versions (project, key, locale) where state = 'draft'");
    expect(MIGRATION).toContain('on content_versions (project, key, locale, id desc)');
    expect(MIGRATION).toContain("on content_versions (project, id desc) where state = 'published'");
    expect(MIGRATION).toContain("on content_versions (publish_at) where state = 'draft' and publish_at is not null");
    expect(MIGRATION).toContain('create table stet_renames');
    expect(MIGRATION).toContain('create table stet_meta');

    // target is plain text: a CHECK would turn every new target into a
    // migration, and telegram-md2 ships in migration 1 regardless.
    expect(MIGRATION).toContain('target       text not null');
    expect(MIGRATION).not.toContain('check (target');
    expect(MIGRATION).toContain('telegram-md2');

    // A copied migration knows its own version, and '' means not yet stamped.
    expect(MIGRATION).toContain("values (1, 1, '')");
    expect(MIGRATION).toContain('on conflict (id) do nothing');

    // Written grants: the Supabase roles guarded (a vanilla Postgres has
    // neither, and REVOKE from a missing role is a hard error), public
    // unguarded, and the function revokes AFTER the functions exist.
    expect(MIGRATION).toContain("select 1 from pg_roles where rolname = 'anon'");
    expect(MIGRATION).toContain("select 1 from pg_roles where rolname = 'authenticated'");
    // Argument lists, not bare names: an overload lands the day save's
    // signature grows again, and a bare name would revoke the wrong function
    // or none.
    expect(MIGRATION).toContain('publish_content_version(text, text, text, text)');
    expect(MIGRATION).toContain(
      'save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean)',
    );
    expect(MIGRATION).toContain('revert_content_version(bigint, text, text)');
    expect(MIGRATION).toContain('rename_content_key(text, text, text, text)');
    expect(MIGRATION.indexOf('revoke execute on function')).toBeGreaterThan(
      MIGRATION.lastIndexOf('create or replace function'),
    );
    // Re-applying the file over a partial apply is a repair, not a pile of
    // "already exists".
    expect(MIGRATION.match(/create or replace function/g)).toHaveLength(4);

    // Deny by default whatever the anonymous role is called: the revokes above
    // only know Supabase's names, and a self-hosted stack picks its own.
    for (const table of ['content_versions', 'stet_renames', 'stet_meta']) {
      expect(MIGRATION).toContain(`alter table ${table} enable row level security`);
    }

    // One transaction, with the stamp as its last statement. Position alone is
    // not enough: `psql -f` runs a file statement by statement with errors
    // non-fatal, skips the failure and reaches a trailing stamp anyway — inside
    // a transaction that first error voids every statement after it, and the
    // close rolls back. (Probed live both ways; recorded with 7.2.)
    const statements = MIGRATION.replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    expect(statements[0]).toBe('begin');
    expect(statements.at(-1)).toBe('commit');
    expect(statements.at(-2)).toContain('insert into stet_meta');
    expect(MIGRATION.trimEnd().endsWith('commit;')).toBe(true);
    // Security invoker by design, never definer.
    expect(MIGRATION.match(/security invoker/g)).toHaveLength(4);
    expect(MIGRATION).not.toContain('security definer');
  });

  it('Requirement: Save is a single-transaction upsert with draft attribution and refusal', async () => {
    const store = createMemoryStore({ project: 'walk' });
    for (let i = 1; i <= 10; i += 1) {
      ok(await store.saveDraft({ key: 'hero_headline', value: `draft ${i}`, target: 'web', editor: 'neil' }));
    }
    // Ten saves, one draft: the version table records publishes, not keystrokes.
    const drafts = store.dump().filter((r) => r.state === 'draft');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.value).toBe('draft 10');
    // Every save carries its editor, so attribution exists from the first
    // write, not only at publish.
    expect(drafts[0]?.editor).toBe('neil');

    // An agent cannot silently replace a human's wording. The agent path never
    // sets force, so the proposal is reported — never queued, never lost.
    const refusal = await store.saveDraft({
      key: 'hero_headline',
      value: 'an agent proposal',
      target: 'web',
      editor: 'agent:claude',
    });
    expect(refusal).toMatchObject({ refused: true, incumbentEditor: 'neil' });
    expect((refusal as { heldSince: string }).heldSince).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(store.dump().find((r) => r.state === 'draft')?.value).toBe('draft 10');

    // p_publish_at rides the draft row — draft rows are the schedule stamp's
    // only carrier — and p_target comes from the descriptor, which stays
    // authoritative.
    ok(
      await store.saveDraft({
        key: 'farewell_notice',
        value: 'scheduled wording',
        target: descriptor.keys['farewell_notice']!.target,
        editor: 'neil',
        publishAt: '2026-09-01T09:00:00.000Z',
      }),
    );
    const scheduled = store.dump().find((r) => r.key === 'farewell_notice');
    expect(scheduled?.publish_at).toBe('2026-09-01T09:00:00.000Z');
    expect(scheduled?.target).toBe('telegram-md2');

    // The upsert is one statement in SQL because a partial unique index cannot
    // ride PostgREST's on_conflict.
    expect(MIGRATION).toContain('create or replace function save_content_draft');
    expect(MIGRATION).toContain("raise exception 'concurrent_save:%', p_key");

    // p_change carries three intents through one sentinel, because SQL cannot
    // tell an omitted argument from an explicit null. The gate is "not the
    // sentinel", never a positivity test, so 0 and negatives load-and-fail
    // rather than reaching the row unvalidated.
    expect(MIGRATION_2).toContain('p_change bigint default -1');
    expect(MIGRATION_2).toContain('if p_change is not null and p_change <> -1 then');
    const grouped = createMemoryStore({ project: 'walk_change' });
    const { changeId } = ok(await grouped.changesets.open({ name: 'grouped save' }));
    ok(await grouped.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));
    ok(await grouped.saveDraft({ key: 'hero_headline', value: 'b', target: 'web', editor: 'neil' }));
    expect(grouped.dump().find((r) => r.state === 'draft')?.changeset_id).toBe(changeId);
    ok(await grouped.saveDraft({ key: 'hero_headline', value: 'c', target: 'web', editor: 'neil', change: null }));
    expect(grouped.dump().find((r) => r.state === 'draft')?.changeset_id).toBeNull();
    for (const bad of [0, -5]) {
      expect(
        await grouped.saveDraft({ key: 'hero_body', value: 'x', target: 'web', editor: 'neil', change: bad }),
      ).toMatchObject({ storeError: true, code: 'conflict' });
    }

    // A grouped draft's schedule is the change's alone: it inherits the
    // change's stamp, and a caller-passed one is refused rather than silently
    // losing to it.
    ok(await grouped.saveDraft({ key: 'hero_headline', value: 'd', target: 'web', editor: 'neil', change: changeId }));
    ok(await grouped.changesets.schedule({ changeId, publishAt: '2030-01-01T00:00:00.000Z' }));
    ok(await grouped.saveDraft({ key: 'hero_body', value: 'e', target: 'web', editor: 'neil', change: changeId }));
    expect(grouped.dump().find((r) => r.key === 'hero_body')?.publish_at).toBe('2030-01-01T00:00:00.000Z');
    expect(
      await grouped.saveDraft({
        key: 'hero_body',
        value: 'f',
        target: 'web',
        editor: 'neil',
        publishAt: '2031-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({ storeError: true, code: 'conflict' });

    // A membership pointing at a change that no longer exists detaches rather
    // than raising: a stale pointer is not a caller error, and raising would
    // brick every later autosave of that key.
    ok(await grouped.changesets.schedule({ changeId, publishAt: null }));
    ok(await grouped.changesets.abandon({ changeId }));
    ok(await grouped.saveDraft({ key: 'hero_headline', value: 'g', target: 'web', editor: 'neil' }));
    expect(grouped.dump().find((r) => r.key === 'hero_headline')?.changeset_id).toBeNull();
  });

  it('Requirement: Publish clears and flips in one transaction', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
    const v1 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    const createdAt = store.dump().find((r) => r.id === v1)?.created_at;

    ok(await store.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
    const v2 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;

    // Cleared and flipped: exactly one active row, and it is the new one.
    const rows = store.dump();
    expect(rows.filter((r) => r.is_active).map((r) => r.id)).toEqual([v2]);
    expect(rows.find((r) => r.id === v2)?.published_at).toBeTruthy();
    // created_at is never overwritten — it stays the row's creation time.
    expect(store.dump().find((r) => r.id === v1)?.created_at).toBe(createdAt);

    // Authorship is two facts. A different editor publishing does not rewrite
    // who wrote the wording.
    const attribution = createMemoryStore({ project: 'walk_attribution' });
    ok(await attribution.saveDraft({ key: 'hero_body', value: 'a human’s wording', target: 'web', editor: 'neil' }));
    const byAgent = ok(await attribution.publish({ key: 'hero_body', editor: 'agent:claude' })).versionId;
    const attributed = attribution.dump().find((r) => r.id === byAgent);
    expect(attributed?.editor).toBe('neil');
    expect(attributed?.published_by).toBe('agent:claude');
    expect(MIGRATION).toContain('published_by = p_editor');

    // With no draft it raises rather than inventing one.
    expect(await store.publish({ key: 'hero_headline', editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });

    // One publish path whether the trigger is a click, an agent or the clock: a
    // scheduled draft publishes through this same function, and publish nulls
    // the stamp on the way through.
    ok(
      await store.saveDraft({
        key: 'hero_headline',
        value: 'scheduled',
        target: 'web',
        editor: 'neil',
        publishAt: '2026-09-01T09:00:00.000Z',
      }),
    );
    const scheduled = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    expect(store.dump().find((r) => r.id === scheduled)?.publish_at).toBeNull();

    // No caller ever observes a key with zero active versions. The clear and
    // the flip are one transaction in SQL, and the mid-publish failure is
    // injected against a real database in tests/store-pg.live.test.ts.
    expect(MIGRATION).toContain('create or replace function publish_content_version');
    expect(store.dump().filter((r) => r.is_active)).toHaveLength(1);

    // D1: publishing a member individually drops it structurally from its
    // group. A published row tagged to a change that never published would
    // corrupt the before-state derivation and the group revert.
    const solo = createMemoryStore({ project: 'walk_solo' });
    const { changeId } = ok(await solo.changesets.open({ name: 'one member' }));
    ok(await solo.saveDraft({ key: 'hero_headline', value: 'grouped', target: 'web', editor: 'neil', change: changeId }));
    const dropped = ok(await solo.publish({ key: 'hero_headline', editor: 'sam' })).versionId;
    expect(solo.dump().find((r) => r.id === dropped)?.changeset_id).toBeNull();
    expect(ok(await solo.changesets.get({ changeId })).members).toEqual([]);

    // The clear+flip core is ONE shared helper the two publish paths call with
    // opposite changeset_id handling. The asymmetry is deliberate: the group
    // flip's kept tag is the group revert's read, and unifying them would
    // silently break it.
    expect(MIGRATION_2).toContain('create or replace function stet_publish_flip');
    expect(MIGRATION_2).toContain('changeset_id = case when p_keep_change then changeset_id else null end');
    expect(MIGRATION_2).toContain('return stet_publish_flip(p_project, p_key, p_locale, p_editor, false)');
    expect(MIGRATION_2).toContain('stet_publish_flip(p_project, m.key, m.locale, p_editor, true)');
  });

  it('Requirement: Revert mints a new row and never touches the draft', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
    const v1 = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    ok(await store.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_headline', editor: 'neil' }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'unpublished wording', target: 'web', editor: 'neil' }));

    const reverted = ok(await store.revert({ versionId: v1, editor: 'neil' })).versionId;

    // The older value is live as a NEW row — the earlier design, copying it
    // into the draft and publishing that, destroyed work in progress.
    expect(ok(await store.read())).toEqual([
      expect.objectContaining({ value: 'first', version: reverted, is_active: true }),
    ]);
    expect(reverted).not.toBe(v1);

    // The draft still holds the unpublished wording, untouched.
    const draft = store.dump().find((r) => r.state === 'draft');
    expect(draft?.value).toBe('unpublished wording');

    // Version ids are global, so revert is the one write that could reach
    // across projects: it refuses instead.
    const other = createMemoryStore({ project: 'other' });
    expect(await other.revert({ versionId: v1, editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    expect(MIGRATION).toContain("raise exception 'wrong_project:%");

    // The minted row records which version it put back — without it, a revert
    // is indistinguishable from a coincidental re-entry of an old value.
    expect(store.dump().find((r) => r.id === reverted)?.reverted_from).toBe(v1);
    expect(MIGRATION).toContain('reverted_from');

    // A revert row belongs to no group: the source row's membership, stamp,
    // label and note are not copied forward.
    expect(store.dump().find((r) => r.id === reverted)?.changeset_id).toBeNull();

    // p_expect_active is the group revert's fail-safe guard, enforced INSIDE
    // the write: it is the deactivating update's OWN predicate, because a
    // separate check-then-update still races under READ COMMITTED.
    expect(MIGRATION_2).toContain('and (p_expect_active is null or id = p_expect_active)');
    expect(MIGRATION_2).toContain('get diagnostics v_cleared = row_count');
    expect(MIGRATION_2).toContain("raise exception 'stale_active:%");

    const guarded = createMemoryStore({ project: 'walk_guard' });
    ok(await guarded.saveDraft({ key: 'hero_headline', value: 'first', target: 'web', editor: 'neil' }));
    const g1 = ok(await guarded.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    ok(await guarded.saveDraft({ key: 'hero_headline', value: 'second', target: 'web', editor: 'neil' }));
    const g2 = ok(await guarded.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    // The correct expected id succeeds; the identical call again refuses,
    // because the active row has moved to the row the first one minted.
    ok(await guarded.revert({ versionId: g1, editor: 'sam', expectActive: g2 }));
    expect(await guarded.revert({ versionId: g1, editor: 'sam', expectActive: g2 })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    // Nothing was cleared and nothing was minted by the refusal.
    expect(guarded.dump().filter((r) => r.is_active)).toHaveLength(1);
    // Unguarded is 001's behavior exactly.
    ok(await guarded.revert({ versionId: g1, editor: 'sam' }));
  });

  it('Requirement: Rename re-keys atomically and refuses an occupied target', async () => {
    const store = createMemoryStore({ project: 'walk' });
    ok(await store.saveDraft({ key: 'old_name', value: 'first', target: 'web', editor: 'neil' }));
    const v1 = ok(await store.publish({ key: 'old_name', editor: 'neil' })).versionId;
    ok(await store.saveDraft({ key: 'old_name', value: 'second', target: 'web', editor: 'neil' }));
    const v2 = ok(await store.publish({ key: 'old_name', editor: 'neil' })).versionId;
    ok(await store.saveDraft({ key: 'occupied', value: 'someone else', target: 'web', editor: 'neil' }));

    // Merging histories is not a thing rename does, and the target's rows would
    // violate both partial unique indexes mid-flight.
    expect(await store.rename({ oldKey: 'old_name', newKey: 'occupied', editor: 'neil' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    // Nothing changed.
    expect(ok(await store.history({ key: 'old_name' })).rows.map((r) => r.id)).toEqual([v2, v1]);

    ok(await store.rename({ oldKey: 'old_name', newKey: 'new_name', editor: 'neil' }));

    // The whole history reads under the new name with the same ids, and values
    // never moved.
    const moved = ok(await store.history({ key: 'new_name' }));
    expect(moved.rows.map((r) => r.id)).toEqual([v2, v1]);
    expect(moved.rows.map((r) => r.value)).toEqual(['second', 'first']);

    // No runtime aliasing: after the transaction, nothing resolves the old key.
    expect(ok(await store.history({ key: 'old_name' })).rows).toEqual([]);
    expect(ok(await store.read({ preview: true })).map((r) => r.key).sort()).toEqual([
      'new_name',
      'occupied',
    ]);
    expect(MIGRATION).toContain('create table stet_renames');
    expect(MIGRATION).toContain('insert into stet_renames (project, old_key, new_key, editor)');
    // The refusal holds under concurrency: renames serialize per project×target
    // on an advisory lock, because a row lock cannot serialize a target that
    // has no rows yet. (Two live sessions race it in tests/store-pg.live.test.ts.)
    expect(MIGRATION).toContain('pg_advisory_xact_lock(hashtext(p_project), hashtext(p_new_key))');
  });
});

describe('migration 2', () => {
  it('Requirement: Migration 2 ships the changeset schema, additively', () => {
    // Additive: frozen 001 is never edited, and 002 only creates or re-ships.
    expect(MIGRATION_2_NAME).toBe('002_changesets.sql');
    expect(MIGRATION).not.toContain('changeset');

    for (const column of [
      'project', 'name', 'note', 'status', 'author_kind', 'publish_at', 'created_at', 'reverted_at',
    ]) {
      expect(`${column}: ${MIGRATION_2.includes(column)}`).toBe(`${column}: true`);
    }
    // The column every content row is pinned to: an empty change cannot derive
    // its project from members it does not have.
    expect(MIGRATION_2).toContain("project     text not null default 'default'");
    // Nullable and un-FK'd, following 001's posture.
    expect(MIGRATION_2).toContain('alter table content_versions add column changeset_id bigint');
    expect(MIGRATION_2).not.toContain('references changesets');
    // status and author_kind are documented in comments, never CHECKed: a CHECK
    // would turn every new policy state into a migration, and publish_change's
    // own guard is what enforces the transitions.
    expect(MIGRATION_2).toContain("-- 'open' | 'scheduled' | 'published'; no CHECK");
    expect(MIGRATION_2).toContain("-- 'human' | 'agent'; no CHECK");
    expect(MIGRATION_2).not.toContain('check (status');
    expect(MIGRATION_2).not.toContain('check (author_kind');
    // Member enumeration, and the change list's own paging index.
    expect(MIGRATION_2).toContain('on content_versions (changeset_id) where changeset_id is not null');
    expect(MIGRATION_2).toContain('create index changesets_project on changesets (project, id desc)');

    // One transaction with the stamp as its LAST statement: a failed apply
    // leaves schema_version 1 and no 002 schema. (Proven against a real
    // database, in psql's errors-non-fatal mode, in store-pg.live.test.ts.)
    // Comment lines come off first — the file opens with a preamble and closes
    // with the NOTIFY note, and the note carries a semicolon of its own.
    const statements = MIGRATION_2.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements[0]).toBe('begin');
    expect(statements.at(-1)).toBe('commit');
    expect(statements.at(-2)).toContain('update stet_meta set schema_version = 2');

    // The two signature changes DROP the exact old signature before creating:
    // `create or replace` with a new trailing parameter mints an OVERLOAD, and
    // every legacy call would then match both ("function is not unique").
    expect(MIGRATION_2).toContain(
      'drop function if exists save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean)',
    );
    expect(MIGRATION_2).toContain('drop function if exists revert_content_version(bigint, text, text)');
    // publish_content_version keeps its signature, so it is a true replace and
    // its 001 ACL survives — which is why it is in no revoke list here.
    expect(MIGRATION_2).toContain('create or replace function publish_content_version');
    expect(MIGRATION_2).not.toContain('drop function if exists publish_content_version');
    // Everything dropped or newly created has its EXECUTE revoked again, by
    // full argument list, because DROP+CREATE resets ACLs.
    for (const name of [
      'stet_publish_flip(text, text, text, text, boolean)',
      'publish_change(bigint, text, text)',
      'save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint)',
      'revert_content_version(bigint, text, text, bigint)',
      'discard_content_draft(text, text, text)',
    ]) {
      expect(`${name}: ${MIGRATION_2.includes(name)}`).toBe(`${name}: true`);
    }
    // The Supabase role guards and RLS, exactly as 001's grants block writes them.
    expect(MIGRATION_2).toContain("if exists (select 1 from pg_roles where rolname = 'anon') then");
    expect(MIGRATION_2).toContain("if exists (select 1 from pg_roles where rolname = 'authenticated') then");
    expect(MIGRATION_2).toContain('alter table changesets enable row level security');
    // Security invoker by design, never definer. Matched at the DEFINITION
    // (`security invoker as $$`) rather than on the bare phrase, which prose
    // about invoker semantics also contains — the count must track functions,
    // not comments.
    expect(MIGRATION_2.match(/security invoker as \$\$/g)).toHaveLength(6);
    expect(MIGRATION_2).not.toContain('security definer');

    // Third-party grants survive the signature swap: captured BEFORE any drop
    // (a DROP resets the ACL, and a frozen file gets no second chance), and
    // replayed AFTER the revoke block, which would otherwise undo the replay.
    const capture = MIGRATION_2.indexOf('create temp table stet_002_grants');
    const firstDrop = MIGRATION_2.indexOf('drop function if exists');
    const revokes = MIGRATION_2.indexOf('revoke execute on function');
    const replay = MIGRATION_2.indexOf('select grantee from stet_002_grants');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(firstDrop);
    expect(replay).toBeGreaterThan(revokes);
    // Replayed onto the NEW signatures, and onto the helper as well:
    // publish_content_version keeps its own ACL but its body now calls
    // stet_publish_flip, and a security-invoker caller needs the callee too.
    for (const target of [
      'grant execute on function save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint)',
      'grant execute on function revert_content_version(bigint, text, text, bigint)',
      'grant execute on function stet_publish_flip(text, text, text, text, boolean)',
    ]) {
      expect(`${target}: ${MIGRATION_2.includes(target)}`).toBe(`${target}: true`);
    }

    // The lock posture: the ADD COLUMN takes ACCESS EXCLUSIVE on a table
    // carrying live traffic, and every later reader queues behind that request.
    // A blocked apply fails fast into the documented failed-apply state rather
    // than stalling the site's reads.
    expect(statements[1]).toBe("set local lock_timeout = '3s'");
  });

  it('Requirement: publish_change flips every member in one transaction, or none', async () => {
    // The change row is locked first, and each refusal has its own marker.
    expect(MIGRATION_2).toContain('select * into v_change from changesets where id = p_change for update');
    expect(MIGRATION_2).toContain("raise exception 'no_change:%', p_change");
    expect(MIGRATION_2).toContain("raise exception 'change_closed:%', p_change");
    expect(MIGRATION_2).toContain("raise exception 'no_members:%', p_change");
    // Deterministic id order, under a row lock, so a concurrently solo-published
    // member re-evaluates OUT of the set rather than double-publishing.
    expect(MIGRATION_2).toContain('order by id\n     for update');
    // A member's unique_violation aborts the WHOLE transaction naming the key:
    // a half-published group is as unobservable as the zero-active state.
    expect(MIGRATION_2).toContain("raise exception 'publish_conflict:%', m.key");
    // And no_members is raised AGAIN after the walk when it flipped nothing —
    // the change must never read published having published none of its members.
    expect(MIGRATION_2).toContain('if v_flipped = 0 then');

    const store = createMemoryStore({ project: 'walk_group_publish' });
    const { changeId } = ok(await store.changesets.open({ name: 'three members' }));
    for (const key of ['hero_headline', 'hero_body', 'farewell_notice']) {
      ok(await store.saveDraft({ key, value: `${key} grouped`, target: 'web', editor: 'neil', change: changeId }));
    }
    const flipped = ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
    // It returns the minted (key, locale, version_id) per member, so a surface
    // fires its per-member events without a second read.
    expect(flipped.published.map((m) => m.key).sort()).toEqual([
      'farewell_notice',
      'hero_body',
      'hero_headline',
    ]);
    expect(flipped.published.every((m) => m.locale === 'default' && m.versionId > 0)).toBe(true);
    // Each minted row KEEPS its changeset_id — the group's marker — and records
    // who made it live.
    const minted = store.dump().filter((r) => r.is_active);
    expect(minted).toHaveLength(3);
    expect(minted.every((r) => r.changeset_id === changeId)).toBe(true);
    expect(minted.every((r) => r.published_by === 'sam' && r.publish_at === null)).toBe(true);
    expect(ok(await store.changesets.get({ changeId })).change.status).toBe('published');
    expect(ok(await store.changesets.get({ changeId })).change.publishAt).toBeNull();

    // An empty change cannot publish, and a published one cannot publish again.
    const empty = ok(await store.changesets.open({ name: 'empty' }));
    expect(await store.changesets.publishChange({ changeId: empty.changeId, editor: 'sam' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    expect(await store.changesets.publishChange({ changeId, editor: 'sam' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });

    // The flip's unit is the change's MEMBERSHIP AT FLIP TIME, never a caller's
    // earlier enumeration: a draft that attached after someone looked publishes
    // with its group, because making the enumeration authoritative would break
    // the all-or-nothing unit the rest of this requirement rests on.
    const drifting = createMemoryStore({ project: 'walk_flip_membership' });
    const later = ok(await drifting.changesets.open({ name: 'drifting' }));
    ok(await drifting.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: later.changeId }));
    const enumerated = ok(await drifting.changesets.get({ changeId: later.changeId })).members.map(
      (m) => m.key,
    );
    expect(enumerated).toEqual(['hero_headline']);
    // …and then a second draft joins, after that read.
    ok(await drifting.saveDraft({ key: 'hero_body', value: 'b', target: 'web', editor: 'neil', change: later.changeId }));
    const both = ok(await drifting.changesets.publishChange({ changeId: later.changeId, editor: 'sam' }));
    expect(both.published.map((m) => m.key).sort()).toEqual(['hero_body', 'hero_headline']);
  });

  it('Requirement: discard_content_draft is the explicit draft drop', async () => {
    // One statement, returning the deleted draft's id, raising when there is none.
    expect(MIGRATION_2).toContain('create or replace function discard_content_draft');
    expect(MIGRATION_2).toContain("raise exception 'no_draft:% (%)', p_key, p_locale");
    // No p_editor: a DELETE leaves no row to attribute, and a parameter nothing
    // can ever read back is a write-only value.
    expect(MIGRATION_2).toContain(
      'create or replace function discard_content_draft(p_key text,\n    p_locale text default \'default\', p_project text default \'default\')',
    );

    const store = createMemoryStore({ project: 'walk_discard' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'live', target: 'web', editor: 'neil' }));
    const liveId = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;
    // The Reject path discards another author's proposal by design — no
    // incumbent refusal, because discarding is an explicit act by contract.
    const proposal = ok(
      await store.saveDraft({ key: 'hero_headline', value: 'a proposal', target: 'web', editor: 'agent:claude' }),
    );
    const dropped = ok(await store.changesets.discardDraft({ key: 'hero_headline' }));
    // It returns the DELETED DRAFT'S ID — what the RPC hands back. A count
    // would be the constant 1 and prove nothing about which row went.
    expect(dropped.discarded).toBe(proposal.draftId);

    // The key's published rows and active version are untouched: no version
    // history is lost, because drafts are not versions.
    expect(store.dump().filter((r) => r.state === 'draft')).toEqual([]);
    expect(store.dump().filter((r) => r.is_active).map((r) => r.id)).toEqual([liveId]);
    expect(await store.changesets.discardDraft({ key: 'hero_headline' })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });

    // Deleting the row drops its group membership with it — no separate leave.
    const { changeId } = ok(await store.changesets.open({ name: 'loses a member' }));
    ok(await store.saveDraft({ key: 'hero_body', value: 'a', target: 'web', editor: 'neil', change: changeId }));
    ok(await store.changesets.discardDraft({ key: 'hero_body' }));
    expect(ok(await store.changesets.get({ changeId })).members).toEqual([]);
  });
});

describe('changesets', () => {
  it('Requirement: A changeset is an opt-in group, orthogonal to the per-key path', async () => {
    const store = createMemoryStore({ project: 'walk_group' });
    // Membership IS the draft row's changeset_id — no member table, no join
    // rows, so there is nothing to keep in step with the version table.
    expect(MIGRATION_2).toContain('alter table content_versions add column changeset_id bigint');
    expect(MIGRATION_2).not.toContain('create table changeset_members');

    const { changeId } = ok(await store.changesets.open({ name: 'spring refresh' }));
    // An open change MAY hold zero members: it exists to be filled.
    expect(ok(await store.changesets.get({ changeId })).members).toEqual([]);
    expect(ok(await store.changesets.get({ changeId })).change.authorKind).toBe('human');

    ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));
    expect(store.dump().find((r) => r.state === 'draft')?.changeset_id).toBe(changeId);

    // The per-key door stays open on a member: publishing it individually
    // drops it from the group, and the group's later publish and revert never
    // touch it again.
    const dropped = ok(await store.publish({ key: 'hero_headline', editor: 'sam' })).versionId;
    expect(store.dump().find((r) => r.id === dropped)?.changeset_id).toBeNull();
    expect(ok(await store.changesets.get({ changeId })).members).toEqual([]);

    // Author identity rides the member drafts and the flip, never a change
    // column: the schema carries author_kind alone.
    expect(MIGRATION_2).toContain('author_kind text not null');
    expect(Object.keys(ok(await store.changesets.get({ changeId })).change)).not.toContain('editor');
  });

  it("Requirement: The lifecycle is open, scheduled, published — with the clock's demotion", async () => {
    const store = createMemoryStore({ project: 'walk_lifecycle' });
    const { changeId } = ok(await store.changesets.open({ name: 'scheduled' }));
    ok(await store.saveDraft({ key: 'hero_headline', value: 'a', target: 'web', editor: 'neil', change: changeId }));

    const when = '2030-06-01T09:00:00.000Z';
    expect(ok(await store.changesets.schedule({ changeId, publishAt: when })).status).toBe('scheduled');
    // Stamped on the change AND on each member draft, so migration 1's
    // scheduler index still enumerates the due members — while the change's
    // own column stays authoritative for inheritance, cancel and reschedule.
    expect(ok(await store.changesets.get({ changeId })).change.publishAt).toBe(when);
    expect(store.dump().find((r) => r.key === 'hero_headline')?.publish_at).toBe(when);
    ok(await store.saveDraft({ key: 'hero_body', value: 'b', target: 'web', editor: 'neil', change: changeId }));
    expect(store.dump().find((r) => r.key === 'hero_body')?.publish_at).toBe(when);

    // Cancel returns it to open and clears the member stamps.
    expect(ok(await store.changesets.schedule({ changeId, publishAt: null })).status).toBe('open');
    expect(store.dump().filter((r) => r.publish_at !== null)).toEqual([]);

    // A stamp with nothing to publish is the demotion sweep's food; the CANCEL
    // arm carries no member requirement, because that sweep demotes empty
    // changes through this exact path — one mechanism, two callers.
    const empty = ok(await store.changesets.open({ name: 'empty' }));
    expect(await store.changesets.schedule({ changeId: empty.changeId, publishAt: when })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    expect(ok(await store.changesets.schedule({ changeId: empty.changeId, publishAt: null })).status).toBe('open');

    // A published change takes no schedule write at all.
    ok(await store.saveDraft({ key: 'hero_headline', value: 'c', target: 'web', editor: 'neil', change: changeId }));
    ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
    expect(await store.changesets.schedule({ changeId, publishAt: null })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });

    // The write ORDER is pinned so every torn state converges on a handled one:
    // the change row first in both arms. Member-stamps-first cancel is
    // rejected — a member attaching between the two statements would inherit
    // the still-standing stamp and the clock would publish a cancelled change.
    const pg = readFileSync(new URL('../adapters/store-pg.ts', import.meta.url), 'utf8');
    expect(pg).toContain('The CHANGE ROW FIRST, then the member stamps');
  });

  it('Requirement: Abandoning an unpublished change hard-deletes it', async () => {
    const store = createMemoryStore({ project: 'walk_abandon' });
    ok(await store.saveDraft({ key: 'hero_headline', value: 'live', target: 'web', editor: 'neil' }));
    const liveId = ok(await store.publish({ key: 'hero_headline', editor: 'neil' })).versionId;

    const { changeId } = ok(await store.changesets.open({ name: 'abandoned' }));
    for (const key of ['hero_headline', 'hero_body']) {
      ok(await store.saveDraft({ key, value: 'draft', target: 'web', editor: 'neil', change: changeId }));
    }
    expect(ok(await store.changesets.abandon({ changeId }))).toEqual({
      abandoned: true,
      droppedDrafts: 2,
    });
    // No version history is lost, because drafts are not versions.
    expect(store.dump().filter((r) => r.state === 'draft')).toEqual([]);
    expect(store.dump().filter((r) => r.is_active).map((r) => r.id)).toEqual([liveId]);
    expect(await store.changesets.get({ changeId })).toMatchObject({ storeError: true });

    // The draft deletes come FIRST, so a torn abandon leaves an empty open
    // change — harmless and re-abandonable — never orphaned drafts pointing at
    // a deleted row.
    const memory = readFileSync(new URL('../adapters/store-memory.ts', import.meta.url), 'utf8');
    expect(memory).toContain('The drafts go FIRST');

    // A published change is never deleted: its row is the group revert's and
    // the before-preview's read.
    const done = ok(await store.changesets.open({ name: 'published' }));
    ok(await store.saveDraft({ key: 'hero_body', value: 'b', target: 'web', editor: 'neil', change: done.changeId }));
    ok(await store.changesets.publishChange({ changeId: done.changeId, editor: 'sam' }));
    expect(await store.changesets.abandon({ changeId: done.changeId })).toMatchObject({
      storeError: true,
      code: 'conflict',
    });
    const still = ok(await store.changesets.get({ changeId: done.changeId }));
    expect(still.change.status).toBe('published');
    expect(still.members.map((m) => m.key)).toEqual(['hero_body']);
  });

  it('Requirement: Group revert is an enumerated, fail-safe, per-member restore', async () => {
    const store = createMemoryStore({ project: 'walk_revert' });
    for (const key of ['hero_headline', 'hero_body']) {
      ok(await store.saveDraft({ key, value: `${key} v1`, target: 'web', editor: 'neil' }));
      ok(await store.publish({ key, editor: 'neil' }));
    }
    const { changeId } = ok(await store.changesets.open({ name: 'grouped' }));
    // farewell_notice's group publish is its key's FIRST — nothing to restore to.
    for (const key of ['hero_headline', 'hero_body', 'farewell_notice']) {
      ok(await store.saveDraft({ key, value: `${key} v2`, target: 'web', editor: 'neil', change: changeId }));
    }
    ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));

    // Someone publishes over one member after the group went live.
    ok(await store.saveDraft({ key: 'hero_body', value: 'newer still', target: 'web', editor: 'neil' }));
    ok(await store.publish({ key: 'hero_body', editor: 'neil' }));

    const result = ok(await revertChange(store, { changeId, editor: 'sam' }));
    // Per-member fail-safe, never atomic: the stale member is refused inside
    // the revert write and REPORTED, while the others restore.
    expect(result.reverted.map((m) => m.key)).toEqual(['hero_headline']);
    expect(result.skipped.map((s) => `${s.key}:${s.reason}`).sort()).toEqual([
      'farewell_notice:no_prior_version',
      'hero_body:stale_active',
    ]);
    const live = ok(await store.read());
    expect(live.find((r) => r.key === 'hero_headline')?.value).toBe('hero_headline v1');
    // The newer value stayed live, and no write attempted a zero-active state.
    expect(live.find((r) => r.key === 'hero_body')?.value).toBe('newer still');
    expect(live.find((r) => r.key === 'farewell_notice')?.value).toBe('farewell_notice v2');
    // Each restored member records which version it put back.
    expect(store.dump().find((r) => r.id === result.reverted[0]?.versionId)?.reverted_from).toBeGreaterThan(0);
    // The group event is stamped — a record, not a claim over current rows.
    expect(ok(await store.changesets.get({ changeId })).change.revertedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Re-running a torn revert is safe: every restored member's active id has
    // moved, so the guard skips it and the stamp still lands.
    expect(ok(await revertChange(store, { changeId, editor: 'sam' })).reverted).toEqual([]);

    // Before-state is DERIVED at read time from the minted rows — §6.1's
    // selection — never recorded at join. There is no stored before map.
    expect(MIGRATION_2).not.toContain('before_value');

    // Exactly ONE implementation of the enumeration, over the public interface,
    // consumed by every surface: the mount's route now, the editor's later.
    const enumeration = readFileSync(new URL('../adapters/changesets.ts', import.meta.url), 'utf8');
    expect(enumeration).toContain('export async function revertChange');
    for (const adapter of ['store-memory.ts', 'store-pg.ts', 'store-postgrest.ts', 'store-snapshot.ts']) {
      const source = readFileSync(new URL(`../adapters/${adapter}`, import.meta.url), 'utf8');
      expect(`${adapter}: ${source.includes('revertChange')}`).toBe(`${adapter}: false`);
    }

    // Per-key history stays per-key: restoring one member from its own history
    // never cascades — the changeset_id a published row carries is provenance,
    // not a leash.
    const solo = createMemoryStore({ project: 'walk_revert_solo' });
    for (const key of ['hero_headline', 'hero_body']) {
      ok(await solo.saveDraft({ key, value: `${key} v1`, target: 'web', editor: 'neil' }));
      ok(await solo.publish({ key, editor: 'neil' }));
    }
    const group = ok(await solo.changesets.open({ name: 'pair' }));
    for (const key of ['hero_headline', 'hero_body']) {
      ok(await solo.saveDraft({ key, value: `${key} v2`, target: 'web', editor: 'neil', change: group.changeId }));
    }
    ok(await solo.changesets.publishChange({ changeId: group.changeId, editor: 'sam' }));
    const one = ok(await solo.changesets.get({ changeId: group.changeId })).members.find(
      (m) => m.key === 'hero_headline',
    );
    ok(await solo.revert({ versionId: one?.beforeVersionId as number, editor: 'sam' }));
    const after = ok(await solo.read());
    expect(after.find((r) => r.key === 'hero_headline')?.value).toBe('hero_headline v1');
    expect(after.find((r) => r.key === 'hero_body')?.value).toBe('hero_body v2');
    expect(ok(await solo.changesets.get({ changeId: group.changeId })).change.revertedAt).toBeNull();
  });

  it('Requirement: A change knows the pages it touches', async () => {
    const store = createMemoryStore({ project: 'walk_span' });
    const { changeId } = ok(await store.changesets.open({ name: 'two pages' }));
    // footer_links renders on home and pricing; hero_headline on home alone.
    for (const key of ['footer_links', 'hero_headline']) {
      ok(await store.saveDraft({ key, value: `${key} v1`, target: 'web', editor: 'neil', change: changeId }));
    }

    // Derived over the descriptor and the member keys, at read time — the
    // members of an open change are its drafts, and the store keeps no span.
    const open = ok(await store.changesets.get({ changeId }));
    expect(pageSpan(descriptor, open.members.map((m) => m.key))).toEqual(['home', 'pricing']);
    expect(MIGRATION_2).not.toContain('page');

    // Dropping a member shrinks it, with no stored state to reconcile.
    ok(await store.changesets.discardDraft({ key: 'footer_links' }));
    const smaller = ok(await store.changesets.get({ changeId }));
    expect(pageSpan(descriptor, smaller.members.map((m) => m.key))).toEqual(['home']);

    // A published change's members are its minted rows — the same derivation.
    ok(await store.changesets.publishChange({ changeId, editor: 'sam' }));
    const published = ok(await store.changesets.get({ changeId }));
    expect(published.members.map((m) => m.key)).toEqual(['hero_headline']);
    expect(pageSpan(descriptor, published.members.map((m) => m.key))).toEqual(['home']);

    // A member whose key declares no page contributes nothing, so an all-email
    // change spans nothing at all: the surface renders "none" and previews per
    // field, and nothing invents a page.
    expect(pageSpan(descriptor, ['welcome__subject', 'welcome__body'])).toEqual([]);
    expect(pageSpan(descriptor, [])).toEqual([]);
    // Nor does a member whose key has since left the descriptor.
    expect(pageSpan(descriptor, ['a_key_that_left', 'hero_headline'])).toEqual(['home']);

    // The derivation is `src/`-level: no surface ships with it.
    const preview = readFileSync(new URL('../src/preview.ts', import.meta.url), 'utf8');
    expect(preview).toContain('export function pageSpan');
  });
});

describe('environments', () => {
  /** A project declaring one environment beside the bare store block. */
  const TWO = { store: { adapter: 'memory' }, environments: { staging: { adapter: 'memory' } } };

  it('Requirement: An environment is a named store connection, declared in config', async () => {
    // Adding one is a line of config: no migration, no column, no new rows —
    // and `--env staging` works on a store-touching command immediately.
    const stores = {
      default: createMemoryStore({ project: 'default' }),
      staging: createMemoryStore({ project: 'default' }),
    };
    const host = makeCliHost({ config: TWO, stores });
    expect(await host.run('audit', '--env', 'staging', '--json')).toBe(0);
    expect(host.json<{ environment: string }>().environment).toBe('staging');

    // Rows carry no environment: the same key in two environments is two rows
    // in two databases, never two rows in one. Migration 1 spends no column on
    // it, and neither does the row the interface hands back.
    const seeded = makeCliHost({ config: TWO, stores });
    expect(await seeded.run('seed', '--env', 'staging')).toBe(0);
    expect(MIGRATION).not.toContain('environment');
    for (const row of stores.staging.dump()) {
      expect(Object.keys(row)).not.toContain('environment');
    }
    // Two connections, two row sets — one of them still empty.
    expect(stores.staging.dump().length).toBeGreaterThan(0);
    expect(stores.default.dump()).toEqual([]);

    // The bare store block IS the default environment, so declaring `default`
    // inside the map is a config error that names the collision.
    const collided = makeCliHost({ config: { environments: { default: { adapter: 'memory' } } } });
    expect(await collided.run('list')).toBe(1);
    expect(collided.stderr()).toContain('the bare store block IS the default environment');
  });

  it('Requirement: Selection changes the connection and nothing else', async () => {
    const stores = {
      default: createMemoryStore({ project: 'default' }),
      staging: createMemoryStore({ project: 'default' }),
    };
    const seeded = makeCliHost({ config: TWO, stores });
    expect(await seeded.run('seed')).toBe(0);

    // The same command, two environments, one behavior: same finding
    // vocabulary, same exit rules — the runs differ only in whose rows were
    // compared.
    const here = makeCliHost({ config: TWO, stores });
    expect(await here.run('audit', '--json')).toBe(0);
    const there = makeCliHost({ config: TWO, stores });
    expect(await there.run('audit', '--env', 'staging', '--json')).toBe(0);
    const seededAudit = here.json<{ unseeded: string[]; orphans: string[]; drift: unknown[] }>();
    const freshAudit = there.json<{ unseeded: string[]; orphans: string[]; drift: unknown[] }>();
    expect(seededAudit.unseeded).toEqual([]);
    expect(freshAudit.unseeded.length).toBeGreaterThan(0);
    expect(freshAudit.orphans).toEqual([]);
    expect(freshAudit.drift).toEqual([]);

    // The safety net is identical in every environment: a fresh store renders
    // the shipped copy rather than nothing.
    const render = makeCliHost({ config: TWO, stores });
    expect(await render.run('get', 'hero_headline', '--env', 'staging')).toBe(0);
    expect(render.out.at(-1)).toBe('Never miss a post again.');

    // And unreachability splits the same way under selection: render-reads
    // degrade with a warning, compare/mirror-reads fail loudly.
    stores.staging.failNext = 'read';
    const degraded = makeCliHost({ config: TWO, stores });
    expect(await degraded.run('list', '--env', 'staging')).toBe(0);
    expect(degraded.stderr()).toContain('unreachable');
    stores.staging.failNext = 'read';
    const refused = makeCliHost({ config: TWO, stores });
    const before = refused.file('content/defaults.json');
    expect(await refused.run('pull', '--env', 'staging')).toBe(1);
    expect(refused.file('content/defaults.json')).toBe(before);

    // There is exactly ONE resolution point: no command module selects for
    // itself — each reads the selection off the loaded project, which is what
    // keeps a `--env` from reaching the adapter while the meta bridge, the
    // store-backed test and doctor's prints stay on the default database.
    for (const name of ['read.ts', 'write.ts', 'pull.ts', 'audit.ts', 'doctor.ts', 'upgrade.ts', 'check.ts']) {
      const source = readFileSync(new URL(`../cli/${name}`, import.meta.url), 'utf8');
      expect(`${name}: ${source.includes('selectStoreBlock')}`).toBe(`${name}: false`);
    }
  });

  it('Requirement: Selection errors teach the declared list', async () => {
    // A typo cannot land on the wrong database: it exits 2 naming the unknown
    // environment and listing what IS declared, and no store was touched —
    // proven with a store INJECTED and available, so selection is shown to
    // validate before injection is even consulted.
    const store = countingStore(createMemoryStore({ project: 'default' }));
    const typo = makeCliHost({ config: TWO, store });
    expect(await typo.run('publish', 'hero_headline', '--env', 'prdo', '--editor', 'neil')).toBe(2);
    expect(typo.stderr()).toContain('prdo');
    expect(typo.stderr()).toContain('staging');
    expect(store.calls).toEqual([]);

    // With no environments declared at all it says so, rather than listing an
    // empty set or falling through to the default connection.
    const none = makeCliHost({ store: countingStore(createMemoryStore({ project: 'default' })) });
    expect(await none.run('list', '--env', 'prod')).toBe(2);
    expect(none.stderr()).toContain('no environments are declared');
  });
});

describe('cli', () => {
  it('Requirement: One config file homes the project', async () => {
    // No config file is a valid project: every setting defaults, and the paths
    // the descriptor and snapshot actually sit at are those defaults.
    const bare = makeCliHost({ config: null });
    expect(await bare.run('check')).toBe(0);
    expect(await bare.run('get', 'hero_headline')).toBe(0);
    expect(bare.out.at(-1)).toBe('Never miss a post again.');

    // Every setting is homed here, and a later change's field is ignored
    // rather than rejected — §13.1's table lists fields this change does not
    // read, and rejecting them would make an upgrade a breaking change.
    const configured = makeCliHost({
      config: {
        project: 'dash',
        store: { adapter: 'memory' },
        environments: { staging: { adapter: 'memory' } },
        descriptorPath: 'copy/descriptor.json',
        snapshotPath: 'copy/defaults.json',
        bundlePath: 'build/bundle.json',
        codegen: { registry: 'copy/keys.ts', defaults: 'copy/defaults.ts', dts: 'copy/stet-env.d.ts' },
        locales: { default: 'default', enabled: ['default'] },
        seoCheck: { 'anchor-text': 'error' },
        scan: { severity: 'warn' },
        // The adoption fields home here too — router chooses the accessor,
        // readPath is where init scaffolds it, rootLayout is the mount, and
        // apiTokenEnv names the mount's Bearer variable.
        router: 'pages',
        readPath: { file: 'copy/content.ts', import: '@/copy/content' },
        rootLayout: 'src/app/layout.tsx',
        apiTokenEnv: 'DASH_API_TOKEN',
        // The surface lists: `managedSurfaces` is what scan reads and register
        // may rewrite, `emailSurfaces` is the email SUBSET that gives a stray
        // literal the email target. `init` writes both, and `stet email
        // extract --apply` is the second writer — a glob it walked is appended
        // to each, because a surface in one alone is either never scanned or
        // never email-typed.
        managedSurfaces: ['app/**/*.tsx', 'lib/email/**/*.ts'],
        emailSurfaces: ['lib/email/**/*.ts'],
        // The declared COPY MODULES — the files whose string literals scan
        // walks as copy rather than as code. A separate list from the surfaces
        // because the walk is a different one, and empty by default.
        copyModules: ['src/copy.ts'],
        agentPublish: 'draft-only',
      },
      store: createMemoryStore({ project: 'dash' }),
    });
    cpSync(join(configured.cwd, 'content'), join(configured.cwd, 'copy'), { recursive: true });
    expect(await configured.run('pull')).toBe(0);
    expect(configured.exists('build/bundle.json')).toBe(true);
    expect(configured.exists('copy/defaults.ts')).toBe(true);
    // The adoption fields round-trip through loadConfig, not just the runtime ones.
    const loaded = loadConfig(configured.cwd);
    expect(loaded.router).toBe('pages');
    expect(loaded.readPath).toEqual({ file: 'copy/content.ts', import: '@/copy/content' });
    expect(loaded.rootLayout).toBe('src/app/layout.tsx');
    expect(loaded.apiTokenEnv).toBe('DASH_API_TOKEN');
    // The Astro shape: `router` takes a third value and `rootLayout` reads back
    // ABSENT — no `app/layout.tsx` default is filled in for a host that has no
    // root React layout — while a `router` outside the three names all three.
    const astro = makeCliHost({ config: { router: 'astro' } });
    expect(loadConfig(astro.cwd).router).toBe('astro');
    expect(loadConfig(astro.cwd).rootLayout).toBeUndefined();
    const nuxt = makeCliHost({ config: { router: 'nuxt' } });
    expect(() => loadConfig(nuxt.cwd)).toThrow(/router must be "app", "pages" or "astro"/);
    expect(loaded.managedSurfaces).toEqual(['app/**/*.tsx', 'lib/email/**/*.ts']);
    expect(loaded.emailSurfaces).toEqual(['lib/email/**/*.ts']);
    // A declared copy-module list survives the round trip untouched…
    expect(loaded.copyModules).toEqual(['src/copy.ts']);
    // …and a config that declares none reads as empty rather than failing, so
    // an older config stays a valid project.
    expect(loadConfig(bare.cwd).copyModules).toEqual([]);
    // The environments map is homed here too, and its semantics belong to the
    // environments capability.
    expect(await configured.run('doctor', '--json')).toBe(0);
    expect(configured.json<{ environments: { declared: string[] } }>().environments.declared).toEqual([
      'staging',
    ]);
    // The second writer. `stet email extract --apply` appends a walked glob to
    // BOTH lists, so the surface it recorded is scanned AND email-typed, and a
    // re-run of the same glob adds nothing.
    const surfaced = makeCliHost({ config: {} });
    expect(await surfaced.run('email', 'extract', 'lib/email/**/*.ts', '--apply')).toBe(0);
    expect(loadConfig(surfaced.cwd).managedSurfaces).toEqual(['lib/email/**/*.ts']);
    expect(loadConfig(surfaced.cwd).emailSurfaces).toEqual(['lib/email/**/*.ts']);
    expect(await surfaced.run('email', 'extract', 'lib/email/**/*.ts', '--apply')).toBe(0);
    expect(loadConfig(surfaced.cwd).managedSurfaces).toEqual(['lib/email/**/*.ts']);
    expect(loadConfig(surfaced.cwd).emailSurfaces).toEqual(['lib/email/**/*.ts']);

    // The seoCheck map is homed here too, and its semantics belong to the seo
    // capability — the config file's job is to validate it and hand it over.
    const rejected = makeCliHost({ config: { seoCheck: { 'anchor-txt': 'error' } } });
    expect(await rejected.run('seo', 'check')).toBe(1);
    expect(rejected.stderr()).toContain('seoCheck.anchor-txt');

    // The static-HTML host's config carries the host and nothing it does not use.
    const html = await makeHtmlHost();
    const written = JSON.parse(html.file('stet.config.json')) as Record<string, unknown>;
    expect(written['host']).toBe('html');
    expect(written['managedSurfaces']).toEqual(['**/*.html']);
    for (const absent of ['readPath', 'codegen', 'router', 'rootLayout']) {
      expect(Object.hasOwn(written, absent)).toBe(false);
    }
    // …and the loader fills them in memory, where nothing on this host reads them.
    const htmlConfig = loadConfig(html.cwd);
    expect(htmlConfig.host).toBe('html');
    expect(htmlConfig.router).toBe('app');
    expect(htmlConfig.readPath.file).toBe('lib/content.ts');
    // Any other value is a config error naming the two states.
    writeFileSync(join(html.cwd, 'stet.config.json'), JSON.stringify({ host: 'static' }));
    expect(() => loadConfig(html.cwd)).toThrow(/host must be "html", or absent for a JavaScript host/);
  });

  it('Requirement: Every store-touching command accepts --env', async () => {
    const stores = {
      default: createMemoryStore({ project: 'default' }),
      staging: createMemoryStore({ project: 'default' }),
    };
    const config = { store: { adapter: 'memory' }, environments: { staging: { adapter: 'memory' } } };

    // Every one of the ten store-touching commands takes the flag AND names the
    // environment in its output — `stet publish --env prod` must never read
    // like a default-environment run.
    const invocations: string[][] = [
      ['list'],
      ['get', 'hero_headline'],
      ['diff', 'hero_headline'],
      ['draft', 'hero_headline', '--value=Selected', '--editor', 'neil'],
      ['publish', 'hero_headline', '--editor', 'neil'],
      ['publish', '--due', '--editor', 'clock'],
      ['seed'],
      ['audit'],
      ['pull'],
      ['doctor'],
      ['upgrade'],
    ];
    for (const argv of invocations) {
      const host = makeCliHost({ config, stores });
      const code = await host.run(...argv, '--env', 'staging');
      // Never a usage error: the flag is declared on every one of them.
      expect(`${argv[0]}: ${code === 2}`).toBe(`${argv[0]}: false`);
      expect(`${argv[0]}: ${host.stdout().includes('environment: staging')}`).toBe(`${argv[0]}: true`);
    }

    // A default run is unchanged — the naming is for the case that needs it.
    const plain = makeCliHost({ config, stores });
    expect(await plain.run('list')).toBe(0);
    expect(plain.stdout()).not.toContain('environment:');

    // doctor reports the declared environments and which one the run selected…
    const reported = makeCliHost({ config, stores });
    expect(await reported.run('doctor', '--env', 'staging')).toBe(0);
    expect(reported.stdout()).toContain('staging (memory) ← selected');

    // …and diagnoses a selected environment whose connection variable is unset
    // as a warning in the store section, never dying on it — the same posture
    // it holds for the default block.
    const unset = makeCliHost({
      config: { store: { adapter: 'memory' }, environments: { b: { adapter: 'pg', urlEnv: 'STET_B_URL' } } },
      env: {},
    });
    expect(await unset.run('doctor', '--env', 'b')).toBe(0);
    expect(unset.stdout()).toContain('store: configured (pg), MISCONFIGURED');
    expect(unset.stderr()).toContain('STET_B_URL');

    // `check` and `seo check` take no --env: both are offline by contract and
    // neither constructs an adapter, so there is nothing to select. One guard
    // serves both, parameterized by the command it names.
    const offline = makeCliHost({ config });
    expect(await offline.run('check', '--env', 'staging')).toBe(2);
    expect(offline.stderr()).toContain('stet check is offline by contract');
    expect(await offline.run('seo', 'check', '--env', 'staging')).toBe(2);
    expect(offline.stderr()).toContain('stet seo check is offline by contract');
    // The joined spelling is one token and never matches the bare name.
    expect(await offline.run('seo', 'check', '--env=staging')).toBe(2);

    // `pull --env <name>` rewrites the committed snapshot from that
    // environment, warning and naming the source — deliberate, since it IS
    // §13.1c's release step. Its proof is the per-case suite's, not this walk's
    // (tests/cli.test.ts, "pull from a non-default environment warns").
  });

  it('Requirement: Mode is detected, never asked', async () => {
    // No store block: snapshot-only, silently. Nothing asks, and nothing warns
    // ABOUT THE MODE — the temp host is not a git checkout, so the publish-route
    // warn the doctor requirement adds is present and is a different subject.
    const silent = makeCliHost({ config: {} });
    expect(await silent.run('doctor')).toBe(0);
    expect(silent.stdout()).toContain('store: snapshot-only');
    expect(silent.stderr()).toBe('warn: git: not a repository — publish cannot be a commit; run git init');

    // Configured and broken is the opposite of silent: the variable is named.
    const broken = makeCliHost({ config: { store: { adapter: 'pg' } }, env: {} });
    expect(await broken.run('list')).toBe(1);
    expect(broken.stderr()).toContain('STET_DATABASE_URL');

    // Reads work identically in every mode; a write answers honestly.
    const write = makeCliHost({ config: {} });
    expect(await write.run('draft', 'hero_headline', '--value=x')).toBe(1);
    expect(write.stderr()).toContain('publish = commit');
    expect(write.stderr()).not.toContain('undefined');
  });

  it('Requirement: Reads go through the one resolution path', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeCliHost({ store });
    await host.run('draft', 'hero_headline', '--value=Live from the store', '--editor', 'neil');
    await host.run('publish', 'hero_headline', '--editor', 'neil');

    const listed = makeCliHost({ store });
    expect(await listed.run('list', '--json')).toBe(0);
    const rows = listed.json<{ rows: { key: string; source: string; version: number | null }[] }>().rows;

    // Every reported source and version equals what `resolve` and the exported
    // `activeRow` answer over the same rows — no parallel lookup, including
    // for active-row selection.
    const stored = ok(await store.read({ preview: true }));
    for (const row of rows) {
      const direct = resolve(descriptor, snapshot, stored, { key: row.key });
      expect(`${row.key}: ${row.source}`).toBe(`${row.key}: ${direct.source}`);
      const live = activeRow(stored.filter((r) => r.key === row.key), 'default');
      expect(`${row.key}: ${row.version}`).toBe(`${row.key}: ${live?.version ?? null}`);
    }

    // Reads split by purpose when the store fails: render degrades…
    store.failNext = 'read';
    const degraded = makeCliHost({ store });
    expect(await degraded.run('list', '--json')).toBe(0);
    expect(degraded.json<{ rows: { source: string }[] }>().rows.every((r) => r.source !== 'active')).toBe(true);

    // …and compare or mirror fails loudly, having written nothing.
    for (const command of [['diff', 'hero_headline'], ['audit'], ['pull'], ['publish', '--due']]) {
      store.failNext = 'read';
      const strict = makeCliHost({ store });
      const before = strict.file('content/defaults.json');
      expect(`${command[0]}: ${await strict.run(...command)}`).toBe(`${command[0]}: 1`);
      expect(strict.file('content/defaults.json')).toBe(before);
      expect(strict.exists('.stet/bundle.json')).toBe(false);
    }
  });

  it('Requirement: Writes delegate to the store RPCs with mandatory attribution', async () => {
    const inner = createMemoryStore({ project: 'default' });
    const store = countingStore(inner);
    const host = makeCliHost({ store });

    // A value that fails its key's shape never reaches saveDraft.
    expect(await host.run('draft', 'footer_links', '--value=["a", 2]', '--editor', 'neil')).toBe(1);
    expect(store.calls.filter((c) => c !== 'read')).toEqual([]);

    // A write goes through the interface, carrying its editor.
    expect(await host.run('draft', 'hero_headline', '--value=Attributed', '--editor', 'neil')).toBe(0);
    expect(store.calls).toContain('saveDraft');
    expect(inner.dump().find((r) => r.key === 'hero_headline')?.editor).toBe('neil');

    // An empty editor is a usage error — attribution is never optional.
    const anon = makeCliHost({ store: inner });
    expect(await anon.run('draft', 'hero_headline', '--value=x', '--editor', '')).toBe(2);

    // A refusal names the incumbent and held-since, and overwrites nothing.
    const agent = makeCliHost({ store: inner });
    expect(await agent.run('draft', 'hero_headline', '--value=agent wording', '--editor', 'agent:claude')).toBe(1);
    expect(agent.stderr()).toContain('neil');
    expect(agent.stderr()).toMatch(/held since \d{4}-\d{2}-\d{2}T/);
    expect(inner.dump().find((r) => r.key === 'hero_headline')?.value).toBe('Attributed');

    // Shape-directed parsing: 16 on a text key stays the string "16".
    const text = makeCliHost({ store: createMemoryStore({ project: 'default' }) });
    expect(await text.run('draft', 'pricing_price', '--value=16', '--editor', 'neil')).toBe(0);
  });

  it('Requirement: check is offline and complete', async () => {
    const clean = makeCliHost({ config: {} });
    expect(await clean.run('check')).toBe(0);
    // Structure, completeness, generated-file currency and value validation
    // all reported.
    expect(clean.stdout()).toContain('snapshot: 25 keys declared');
    expect(clean.stdout()).toContain('generated: content/keys.ts current');
    expect(clean.stdout()).toContain('values: 24 checked');

    const store = countingStore(createMemoryStore({ project: 'default' }));
    const dead = makeCliHost({
      config: { store: { adapter: 'pg' } },
      env: { STET_DATABASE_URL: 'postgresql://127.0.0.1:1/nothing' },
      store,
    });
    expect(await dead.run('check')).toBe(0);
    // Identical, and the command never dialed: the store was injected and
    // available, and took no call at all.
    expect(dead.stdout()).toBe(clean.stdout());
    expect(store.calls).toEqual([]);

    // Each generated-file finding names the file's OWN regenerator, and
    // following it closes the finding. The registry is descriptor-derived, so
    // `upgrade` regenerates it…
    const registry = makeCliHost({ config: {} });
    const descriptor = JSON.parse(registry.file('content/descriptor.json')) as {
      keys: Record<string, Record<string, unknown>>;
    };
    descriptor.keys['hero_headline']!['label'] = 'Hero headline';
    writeFileSync(join(registry.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
    expect(await registry.run('check')).toBe(1);
    expect(registry.stderr()).toContain('content/keys.ts: stale — its source moved; run stet upgrade');
    expect(await registry.run('upgrade')).toBe(0);
    expect(await registry.run('check')).toBe(0);

    // The ambient types are the THIRD generated file, and the one that types a
    // key: unchecked, a deleted key keeps compiling in the host because the
    // file that names it went unread. It is descriptor-derived, so `upgrade`
    // regenerates it and following the remedy turns the finding green.
    const ambient = makeCliHost({ config: {} });
    writeFileSync(
      join(ambient.cwd, 'content/stet-env.d.ts'),
      `${ambient.file('content/stet-env.d.ts')}\ndeclare const MINE: string;\n`,
      'utf8',
    );
    expect(await ambient.run('check')).toBe(1);
    expect(ambient.stderr()).toContain('content/stet-env.d.ts');
    expect(ambient.stderr()).toContain('stet upgrade');
    expect(await ambient.run('upgrade')).toBe(0);
    expect(await ambient.run('check')).toBe(0);

    // …while the defaults module is snapshot-derived, which `upgrade` never
    // writes: naming it there sent the reader around a loop it could not close.
    const defaults = makeCliHost({ config: {} });
    const snap = JSON.parse(defaults.file('content/defaults.json')) as Record<
      string,
      Record<string, unknown>
    >;
    snap['default']!['hero_headline'] = 'Never miss a post.';
    writeFileSync(join(defaults.cwd, 'content/defaults.json'), JSON.stringify(snap, null, 2));
    expect(await defaults.run('check')).toBe(1);
    expect(defaults.stderr()).toContain('content/defaults.ts: stale — its source moved; run stet pull');
    expect(await defaults.run('pull')).toBe(0);
    expect(await defaults.run('check')).toBe(0);

    // On the static-HTML host the generated files ARE the marked documents.
    const html = await makeHtmlHost({ register: true });
    expect(await html.run('check')).toBe(0);
    expect(html.stdout()).toContain('document: index.html current (28 marks)');
    expect(html.stdout()).not.toContain('generated:');
    // A mark naming no declared key is an error naming both remedies.
    writeFileSync(
      join(html.cwd, 'index.html'),
      html.file('index.html').replace('<h2 data-stet="', '<h2 data-stet="nope" x-data-stet="'),
    );
    html.out.length = 0;
    html.err.length = 0;
    expect(await html.run('check')).toBe(1);
    expect(html.stderr()).toContain('names no descriptor key — run stet register, or remove the mark');
  });

  it('Requirement: pull materializes the truth into the repo forms', async () => {
    const store = createMemoryStore({ project: 'default' });
    const seeded = makeCliHost({ store });
    await seeded.run('draft', 'hero_headline', '--value=Mirrored', '--editor', 'neil');
    await seeded.run('publish', 'hero_headline', '--editor', 'neil');

    const host = makeCliHost({ store });
    expect(await host.run('pull')).toBe(0);
    const emitted = readBundle(JSON.parse(host.file('.stet/bundle.json')));
    // The bundle's value and its version metadata move together, and the
    // shipped readers resolve the new value out of the emitted bytes.
    expect(emitted.values['default']?.['hero_headline']).toBe('Mirrored');
    expect(emitted.meta?.['default']?.['hero_headline']).toEqual({ version: 1 });
    expect(resolveFromBundle(descriptor, emitted, { key: 'hero_headline' }).value).toBe('Mirrored');
    // The snapshot pair travels with it (C3: pull emits both).
    expect(host.file('content/defaults.json')).toContain('Mirrored');
    expect(host.file('content/defaults.ts')).toContain('Mirrored');

    // Pull twice, diff empty.
    const again = makeCliHost({ store });
    cpSync(join(host.cwd, 'content/defaults.json'), join(again.cwd, 'content/defaults.json'));
    expect(await again.run('pull')).toBe(0);
    expect(readFileSync(join(again.cwd, 'content/defaults.json')).equals(
      readFileSync(join(host.cwd, 'content/defaults.json')),
    )).toBe(true);

    // Nothing it does not own is dropped: the non-enabled `de` block survives.
    expect(JSON.parse(again.file('content/defaults.json'))['de']).toEqual({
      hero_headline: 'Verpasse nie wieder einen Post.',
    });

    // A snapshot-only project gets no bundle — its committed snapshot is one.
    const snapshotOnly = makeCliHost({ config: {} });
    expect(await snapshotOnly.run('pull')).toBe(0);
    expect(snapshotOnly.exists('.stet/bundle.json')).toBe(false);

    // On the static-HTML host the repo forms are the snapshot and the documents.
    const html = await makeHtmlHost({ register: true });
    const values = JSON.parse(html.file('content/defaults.json')) as { default: Record<string, string> };
    const key = Object.entries(values.default).find(([, v]) => v === 'Imaging archives')![0];
    values.default[key] = 'Imaging collections';
    writeFileSync(join(html.cwd, 'content/defaults.json'), `${JSON.stringify(values, null, 2)}\n`);
    expect(await html.run('pull')).toBe(0);
    expect(html.file('index.html')).toContain('<li data-stet="' + key + '">Imaging collections</li>');
    expect(html.exists('content/defaults.ts')).toBe(false);
    // A second pull writes nothing and says so.
    html.out.length = 0;
    expect(await html.run('pull')).toBe(0);
    expect(html.stdout()).toContain('pull: documents current');
  });

  it('Requirement: seed writes version 1, idempotently', async () => {
    const inner = createMemoryStore({ project: 'default' });
    const crashed = makeCliHost({ store: publishFailsOnce(inner) });
    expect(await crashed.run('seed')).toBe(1);
    expect(inner.dump().filter((r) => r.state === 'draft')).toHaveLength(1);

    // Re-run is the repair: the stet:seed draft publishes, already-seeded keys
    // are skipped, and the store ends with exactly one active version 1 per key.
    const repair = makeCliHost({ store: inner });
    expect(await repair.run('seed')).toBe(0);
    const rows = inner.dump();
    expect(rows.filter((r) => r.state === 'draft')).toHaveLength(0);
    const nonDerived = Object.entries(descriptor.keys).filter(([, d]) => d.derivesFrom === undefined);
    expect(rows).toHaveLength(nonDerived.length);
    for (const [key] of nonDerived) {
      const live = rows.filter((r) => r.key === key && r.is_active);
      expect(`${key}: ${live.length}`).toBe(`${key}: 1`);
      expect(`${key}: ${live[0]?.editor}`).toBe(`${key}: stet:seed`);
    }
    // A derived key has no snapshot value by design and is skipped, as the
    // completeness check skips it.
    expect(rows.some((r) => r.key === 'seo_home_title')).toBe(false);
    expect(repair.stdout()).toContain('not stamped (adapter has no stet_meta)');
  });

  it('Requirement: audit reports and never deletes', async () => {
    const inner = createMemoryStore({ project: 'default' });
    inner.seed([
      { key: 'hero_headline', value: 'live', target: 'web' },
      { key: 'retired_banner', value: 'the descriptor forgot me', target: 'web' },
      { key: 'hero_body', value: 'drifted', target: 'html-email' },
    ]);
    const store = countingStore(inner);
    const host = makeCliHost({ store });

    expect(await host.run('audit', '--json')).toBe(0);
    const answer = host.json<{
      unseeded: string[];
      orphans: string[];
      drift: { key: string; stored: string; declared: string }[];
    }>();
    expect(answer.orphans).toEqual(['retired_banner']);
    expect(answer.drift).toEqual([{ key: 'hero_body', stored: 'html-email', declared: 'web' }]);
    expect(answer.unseeded).toContain('footer_links');

    // No write method was invoked, and the orphan survives the run. "No delete
    // was called" would be true of any implementation — the interface has none
    // — so the proof is the row still being there.
    expect(store.calls).toEqual(['read']);
    expect(inner.dump().some((r) => r.key === 'retired_banner')).toBe(true);

    const strict = makeCliHost({ store: inner });
    expect(await strict.run('audit', '--strict')).toBe(1);
  });

  it('Requirement: remove deletes keys from the repo forms, never the store', async () => {
    // THE DEMO KEYS LEAVE AND THE REAL KEY LANDS UNDER ITS OWN NAME — over a
    // host `init` really scaffolded, so the descriptor this walks is the one
    // stet writes rather than one a fixture hand-typed.
    const scaffolded = makeAdoptionHost({ page: 'export default function Page() {\n  return <div />;\n}\n' });
    expect(await scaffolded.run('init', '--yes')).toBe(0);
    const config = JSON.parse(scaffolded.file('stet.config.json')) as Record<string, unknown>;
    config['copyModules'] = ['src/copy.ts'];
    scaffolded.write('stet.config.json', JSON.stringify(config, null, 2));
    scaffolded.write('src/copy.ts', 'export const copy = {\n  hero_headline: "Never miss a post again.",\n};\n');
    // A second locale block on the same host, so EVERY LOCALE IS CLEANED is
    // walked against a real scaffold too.
    const values = JSON.parse(scaffolded.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    values['es'] = { hero_headline: 'No te pierdas ninguna publicación.' };
    scaffolded.write('content/defaults.json', JSON.stringify(values, null, 2));

    // The precondition: the demo default owns the name, so the module's real
    // literal diverges and `register` — which only ever adds — refuses it.
    expect(await scaffolded.run('register', '--from', 'scan')).toBe(0);
    expect(scaffolded.stderr()).toContain('register only adds keys; resolve the difference by hand');
    expect(JSON.parse(scaffolded.file('content/defaults.json'))['default']['hero_headline']).toBe(
      'Your headline goes here',
    );

    const demo = ['brand__ink', 'brand__name', 'brand__primary', 'brand__radius', 'hero_headline'];
    expect(await scaffolded.run('remove', ...demo, '--write')).toBe(0);
    expect(await scaffolded.run('scan')).toBe(0);
    expect(await scaffolded.run('register', '--from', 'scan')).toBe(0);
    const adopted = JSON.parse(scaffolded.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    // Its OWN name, no suffixed variant, and the project closes green — the
    // round trip proves the forms were fully cleaned.
    expect(adopted['default']!['hero_headline']).toBe('Never miss a post again.');
    expect(Object.hasOwn(JSON.parse(scaffolded.file('content/descriptor.json')).keys, 'hero_headline_2')).toBe(false);
    expect(await scaffolded.run('check')).toBe(0);
    // EVERY LOCALE IS CLEANED: the `es` value went with the key, so nothing is
    // stale in any block.
    expect(adopted['es']).toEqual({});
    expect(await scaffolded.run('check', '--json')).toBe(0);
    const checked = JSON.parse(scaffolded.out[scaffolded.out.length - 1] ?? 'null') as {
      snapshot: { stale: string[] };
    };
    expect(checked.snapshot.stale).toEqual([]);

    const forms = [
      'content/descriptor.json',
      'content/defaults.json',
      'content/keys.ts',
      'content/stet-env.d.ts',
      'content/defaults.ts',
    ];

    // A DERIVATION SOURCE BAKES ITS DEPENDENTS. `seo_home_title` derives from
    // `hero_headline` through `{v} — Mirra`; the source leaves and the
    // dependent keeps the value it resolved to, in the default locale and in
    // every locale where the source had its own row.
    const derived = makeCliHost({ config: {} });
    const heldForms = forms.map((rel) => readFileSync(join(derived.cwd, rel)));
    expect(await derived.run('remove', 'hero_headline')).toBe(0);
    expect(derived.stdout()).toContain(
      'seo_home_title derives from it — baked: de: Verpasse nie wieder einen Post. — Mirra, ' +
        'default: Never miss a post again. — Mirra; derivation dropped',
    );
    // A plain run is still a plan: the bake prints and nothing is written.
    forms.forEach((rel, i) => {
      expect(`${rel}: ${readFileSync(join(derived.cwd, rel)).equals(heldForms[i]!)}`).toBe(`${rel}: true`);
    });
    expect(await derived.run('remove', 'hero_headline', '--write')).toBe(0);
    const bakedDescriptor = loadDescriptor(JSON.parse(derived.file('content/descriptor.json')));
    expect(bakedDescriptor.keys['seo_home_title']?.derivesFrom).toBeUndefined();
    expect(bakedDescriptor.keys['seo_home_title']?.tmpl).toBeUndefined();
    const bakedValues = JSON.parse(derived.file('content/defaults.json')) as Record<string, Record<string, unknown>>;
    expect(bakedValues['default']!['seo_home_title']).toBe('Never miss a post again. — Mirra');
    expect(bakedValues['de']!['seo_home_title']).toBe('Verpasse nie wieder einen Post. — Mirra');
    expect(await derived.run('check')).toBe(0);

    // …and naming source and dependent in ONE run bakes nothing and removes
    // both: the named keys validate and write as one set.
    const together = makeCliHost({ config: {} });
    expect(await together.run('remove', 'hero_headline', 'seo_home_title', '--write')).toBe(0);
    expect(together.stdout()).not.toContain('baked');
    expect(Object.hasOwn(JSON.parse(together.file('content/descriptor.json')).keys, 'seo_home_title')).toBe(false);

    // A PAGE REFERENCE DROPS WITH THE KEY, and a dropped title or description
    // names the seo rule that will then report the page.
    const referenced = makeCliHost({ config: {} });
    expect(await referenced.run('remove', 'seo_home_desc', '--write')).toBe(0);
    expect(referenced.stdout()).toContain(
      'pages/home/seo/description — reference dropped; seo check will report missing-description',
    );
    const dropped = loadDescriptor(JSON.parse(referenced.file('content/descriptor.json')));
    expect(dropped.pages?.['home']?.seo).toEqual({ title: 'seo_home_title' });
    expect(await referenced.run('check')).toBe(0);
    expect(await referenced.run('seo', 'check')).toBe(1);

    // A JSON-LD binding drops the same way, and an emptied block goes with it —
    // an empty `bindings` would validate and emit nothing.
    const bound = makeCliHost({ config: {} });
    expect(await bound.run('remove', 'pricing_tier_name', 'pricing_price', '--write')).toBe(0);
    expect(bound.stdout()).toContain('pages/pricing/jsonLd/bindings/name — binding dropped');
    expect(bound.stdout()).toContain('pages/pricing/jsonLd/bindings/price — binding dropped; the emptied block removed');
    expect(loadDescriptor(JSON.parse(bound.file('content/descriptor.json'))).pages?.['pricing']?.jsonLd).toBeUndefined();
    expect(await bound.run('check')).toBe(0);

    // A REFERENCED KEY REFUSES, NOTHING WRITTEN. Bake and drop consume every
    // reference class today's schema carries, so the gate is exercised
    // DIRECTLY — a cleaned descriptor carrying a dangling `derivesFrom` is the
    // shape a later schema's unhandled class would leave behind.
    const dangling: Descriptor = {
      version: 1,
      keys: { seo_home_title: { shape: 'text', target: 'web', derivesFrom: 'hero_headline', tmpl: '{v} — Mirra' } },
    };
    expect(() => refuseDanglingReferences(dangling)).toThrow(
      /cannot remove: keys\/seo_home_title\/derivesFrom.*edit the reference, then re-run/,
    );
    // And the command calls the gate BEFORE its first plan line, which is what
    // makes a refused run print no plan and write nothing in either mode.
    const removeSource = readFileSync(new URL('../cli/remove.ts', import.meta.url), 'utf8');
    const gateAt = removeSource.indexOf('refuseDanglingReferences(cleaned)');
    const planAt = removeSource.indexOf('report.line(`remove ${key}');
    expect(gateAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(planAt);

    // A PLAIN RUN IS A PLAN, NOT AN ACTION.
    const plan = makeCliHost({ config: {} });
    const held = forms.map((rel) => readFileSync(join(plan.cwd, rel)));
    expect(await plan.run('remove', 'contact_form_labels')).toBe(0);
    expect(plan.stdout()).toContain('remove contact_form_labels (record, web)');
    expect(plan.stdout()).toContain('  default: {"heading":"Get in touch","submit":"Send it"}');
    expect(plan.stdout()).toContain('plan only — run with --write to apply');
    forms.forEach((rel, i) => {
      expect(`${rel}: ${readFileSync(join(plan.cwd, rel)).equals(held[i]!)}`).toBe(`${rel}: true`);
    });

    // STORE ROWS BECOME AUDIT'S ORPHANS, UNTOUCHED. The store is injected and
    // available; the removal issues no operation of any kind, and the rows it
    // leaves behind are exactly what audit already names.
    const inner = createMemoryStore({ project: 'default' });
    inner.seed([{ key: 'footer_links', value: ['Privacy'], target: 'web' }]);
    const store = countingStore(inner);
    const backed = makeCliHost({ config: { store: { adapter: 'memory' } }, store });
    expect(await backed.run('remove', 'footer_links', '--write')).toBe(0);
    expect(backed.stdout()).toContain('store rows for removed keys are kept — audit names them as orphans');
    expect(store.calls).toEqual([]);
    expect(await backed.run('audit', '--json')).toBe(0);
    expect(backed.json<{ orphans: string[] }>().orphans).toEqual(['footer_links']);
    // Reported, never deleted: the row survived the removal AND the audit.
    expect(inner.dump().some((r) => r.key === 'footer_links')).toBe(true);
    expect(store.calls).toEqual(['read']);

    // A MARKETING TEMPLATE'S CARRIER SLOT LEAVES RED-WITH-WARNING, NEVER
    // SILENTLY: the validator's slot warning and the class gate's own finding
    // text, then the same finding as the next check's red.
    const carrier = makeCliHost({ config: {} });
    expect(await carrier.run('remove', 'newsletter__body', '--write')).toBe(0);
    expect(carrier.stderr()).toContain(
      'drop "body" from templates.newsletter.slots to retire the slot',
    );
    expect(carrier.stdout()).toContain(
      'after this removal, stet check will report: newsletter: a marketing template needs ' +
        '{{unsubscribe_url}} in scope',
    );
    expect(await carrier.run('check')).toBe(1);
    expect(carrier.stderr()).toContain('a marketing template needs {{unsubscribe_url}} in scope');

    // …and a template whose `wrapperProvides` already covers the token removes
    // green, with no caution printed at all.
    const covered = makeCliHost({ config: {} });
    expect(await covered.run('remove', 'welcome__preheader', '--write')).toBe(0);
    expect(covered.stdout()).not.toContain('after this removal, stet check will report');
    expect(await covered.run('check')).toBe(0);

    // An unknown key refuses the whole run before any plan prints.
    const unknown = makeCliHost({ config: {} });
    const untouched = forms.map((rel) => readFileSync(join(unknown.cwd, rel)));
    expect(await unknown.run('remove', 'footer_links', 'no_such_key', '--write')).toBe(1);
    expect(unknown.stderr()).toContain('"no_such_key" is not a key in content/descriptor.json');
    expect(unknown.stdout()).toBe('');
    forms.forEach((rel, i) => {
      expect(`${rel}: ${readFileSync(join(unknown.cwd, rel)).equals(untouched[i]!)}`).toBe(`${rel}: true`);
    });

    // On the static-HTML host the forms include the MARKS: the plan names each
    // one, and the batch strips it with the text kept.
    const html = await makeHtmlHost({ register: true });
    expect(await html.run('remove', 'how_it_works')).toBe(0);
    expect(html.stdout()).toContain('the mark is removed and the text stays');
    expect(html.stdout()).toContain('every other mark is regenerated in the same write');
    html.out.length = 0;
    expect(await html.run('remove', 'how_it_works', '--write')).toBe(0);
    expect(html.file('index.html')).not.toContain('data-stet="how_it_works"');
    expect(html.file('index.html')).toContain('<a href="#how">How it works</a>');
    expect(await html.run('check')).toBe(0);
  });

  it('Requirement: publish is one path — click, agent and clock', async () => {
    const store = createMemoryStore({ project: 'default' });
    const host = makeCliHost({ store });
    await host.run('draft', 'hero_headline', '--value=Due', '--editor', 'neil', '--publish-at', '2020-01-01T00:00:00.000Z');
    await host.run('draft', 'pricing_price', '--value=$20', '--editor', 'neil', '--publish-at', '2020-06-01T00:00:00.000Z');
    await host.run('draft', 'hero_body', '--value=Later', '--editor', 'neil', '--publish-at', '2099-01-01T00:00:00.000Z');

    const clock = makeCliHost({ store });
    expect(await clock.run('publish', '--due', '--editor', 'cron')).toBe(0);
    expect(clock.stdout()).toContain('2 published from 2 due draft(s)');

    const rows = store.dump();
    // Both went live stamped and attributed exactly as a manual publish would
    // be — the same RPC, so there is no second code path to diverge.
    for (const key of ['hero_headline', 'pricing_price']) {
      const live = rows.find((r) => r.key === key && r.is_active);
      expect(`${key}: ${live?.state}`).toBe(`${key}: published`);
      expect(`${key}: ${live?.editor}`).toBe(`${key}: neil`);
      expect(`${key}: ${live?.published_by}`).toBe(`${key}: cron`);
      expect(`${key}: ${live?.publish_at}`).toBe(`${key}: null`);
    }
    // The not-yet-due draft is untouched.
    expect(rows.find((r) => r.key === 'hero_body')?.state).toBe('draft');

    // A DEPARTED KEY'S DUE DRAFT IS SKIPPED, NOT SMUGGLED — the clock leg is
    // gated by the descriptor exactly as the interactive leg is. The state is
    // reached the way it really arises: `stet remove` takes the key out while a
    // due draft for it is still open. `footer_links` is the key that reproduces
    // it — a key nothing derives from and no page references, so the removal is
    // a plain delete and the bypass is not masked by a bake.
    const departed = createMemoryStore({ project: 'default' });
    const gated = makeCliHost({ store: departed });
    await gated.run('draft', 'footer_links', '--value=["Privacy"]', '--editor', 'neil', '--publish-at', '2020-01-01T00:00:00.000Z');
    await gated.run('draft', 'blog_intro', '--value=Notes.', '--editor', 'neil', '--publish-at', '2020-01-01T00:00:00.000Z');
    expect(await gated.run('remove', 'footer_links', '--write')).toBe(0);

    expect(await gated.run('publish', '--due', '--editor', 'cron')).toBe(1);
    expect(gated.stderr()).toContain(
      'footer_links (default): due draft skipped — the key is no longer in the descriptor; ' +
        'restore the key or discard the draft',
    );
    // Nonzero so a cron sees the anomaly, the row left a draft, and every other
    // due draft published: one skip strands nothing.
    expect(gated.stdout()).toContain('published blog_intro (default)');
    expect(departed.dump().find((r) => r.key === 'footer_links')?.state).toBe('draft');
    expect(departed.dump().find((r) => r.key === 'blog_intro' && r.is_active)?.state).toBe('published');

    // The GROUPED leg: due member drafts publish through `publish_change` with
    // their scheduled change — once per distinct change, atomically — never one
    // key at a time, while unrelated due drafts publish beside them.
    const grouped = createMemoryStore({ project: 'default' });
    const { changeId } = ok(await grouped.changesets.open({ name: 'launch copy' }));
    for (const key of ['hero_headline', 'hero_body']) {
      ok(await grouped.saveDraft({ key, value: `${key} grouped`, target: 'web', editor: 'neil', change: changeId }));
    }
    ok(await grouped.changesets.schedule({ changeId, publishAt: '2020-01-01T00:00:00.000Z' }));
    ok(
      await grouped.saveDraft({
        key: 'pricing_price',
        value: '$30',
        target: 'web',
        editor: 'neil',
        publishAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    const groupedRun = makeCliHost({ store: grouped });
    expect(await groupedRun.run('publish', '--due', '--editor', 'cron')).toBe(0);
    expect(groupedRun.stdout()).toContain('change "launch copy"');
    expect(groupedRun.stdout()).toContain('3 published from 3 due draft(s)');
    // The members flipped together and KEPT the change; the ungrouped draft
    // published on its own path, unaffected.
    const live = grouped.dump().filter((r) => r.is_active);
    expect(live.filter((r) => r.changeset_id === changeId).map((r) => r.key).sort()).toEqual([
      'hero_body',
      'hero_headline',
    ]);
    expect(live.find((r) => r.key === 'pricing_price')?.changeset_id).toBeNull();

    // The TOCTOU seam's MEMBERSHIP axis: the run's due set is a snapshot for
    // reporting, and the flip's unit is the change's membership at flip time.
    // Staged by handing the enumeration a read that predates a member — the
    // same thing a torn schedule leaves behind, and the same thing an attach
    // landing mid-run produces.
    const late = createMemoryStore({ project: 'default' });
    const drifting = ok(await late.changesets.open({ name: 'drifting' }));
    for (const key of ['hero_headline', 'hero_body']) {
      ok(await late.saveDraft({ key, value: `${key} v1`, target: 'web', editor: 'neil', change: drifting.changeId }));
    }
    ok(await late.changesets.schedule({ changeId: drifting.changeId, publishAt: '2020-01-01T00:00:00.000Z' }));
    const lateRun = makeCliHost({
      store: {
        ...late,
        // hero_body is a member and IS due, but this enumeration cannot see it.
        read: async (q?: { keys?: string[]; locale?: string; preview?: boolean }) => {
          const answer = await late.read(q);
          return isStoreError(answer) ? answer : answer.filter((r) => r.key !== 'hero_body');
        },
      },
    });
    expect(await lateRun.run('publish', '--due', '--editor', 'cron')).toBe(0);
    // Both members went live: the group is the unit, not the enumeration.
    expect(late.dump().filter((r) => r.is_active).map((r) => r.key).sort()).toEqual([
      'hero_body',
      'hero_headline',
    ]);
    // And the count says what happened rather than reading as a broken counter.
    expect(lateRun.stdout()).toContain('2 published from 1 due draft(s)');

    // A member CONFLICT reports the change and the named failing key, publishes
    // none of its members, and leaves the change scheduled to retry whole.
    const held = createMemoryStore({ project: 'default' });
    const conflicted = ok(await held.changesets.open({ name: 'held change' }));
    ok(
      await held.saveDraft({
        key: 'hero_headline',
        value: 'x',
        target: 'web',
        editor: 'neil',
        change: conflicted.changeId,
      }),
    );
    ok(await held.changesets.schedule({ changeId: conflicted.changeId, publishAt: '2020-01-01T00:00:00.000Z' }));
    const heldRun = makeCliHost({
      store: {
        ...held,
        changesets: {
          ...held.changesets,
          publishChange: async () => ({
            storeError: true as const,
            code: 'conflict' as const,
            message: 'publish_conflict:hero_headline',
          }),
        },
      },
    });
    expect(await heldRun.run('publish', '--due', '--editor', 'cron')).toBe(1);
    expect(heldRun.stderr()).toContain('publish_conflict:hero_headline');
    expect(heldRun.stderr()).toContain('retries next run');
    expect(held.dump().filter((r) => r.is_active)).toHaveLength(0);
    expect(ok(await held.changesets.get({ changeId: conflicted.changeId })).change.status).toBe('scheduled');

    // The DEMOTION sweep, a second enumeration over scheduled changesets: a
    // change whose stamp has passed with no due member left is demoted to open
    // through the CANCEL path and REPORTED — never a silent skip, never a
    // phantom retry loop.
    const empty = createMemoryStore({ project: 'default' });
    const stranded = ok(await empty.changesets.open({ name: 'nothing left' }));
    ok(
      await empty.saveDraft({
        key: 'hero_headline',
        value: 'y',
        target: 'web',
        editor: 'neil',
        change: stranded.changeId,
      }),
    );
    ok(await empty.changesets.schedule({ changeId: stranded.changeId, publishAt: '2020-01-01T00:00:00.000Z' }));
    ok(await empty.changesets.discardDraft({ key: 'hero_headline' }));
    const sweep = makeCliHost({ store: empty });
    expect(await sweep.run('publish', '--due', '--editor', 'cron')).toBe(0);
    expect(sweep.stdout()).toContain('demoted "nothing left" to open');
    const after = ok(await empty.changesets.get({ changeId: stranded.changeId })).change;
    expect(after.status).toBe('open');
    expect(after.publishAt).toBeNull();
  });

  it('Requirement: diff shows draft against active', async () => {
    const store = createMemoryStore({ project: 'default' });
    const none = makeCliHost({ store });
    expect(await none.run('diff', 'hero_headline')).toBe(0);
    expect(none.stdout()).toContain('draft: none');

    await none.run('draft', 'hero_headline', '--value=A pending rewrite', '--editor', 'neil');
    const host = makeCliHost({ store });
    expect(await host.run('diff', 'hero_headline')).toBe(0);
    expect(host.stdout()).toContain('active [snapshot]: Never miss a post again.');
    expect(host.stdout()).toContain('draft: A pending rewrite');
  });

  it('Requirement: doctor reports mode and never treats no-DB as failure', async () => {
    const host = makeCliHost({ config: {} });
    expect(await host.run('doctor')).toBe(0);
    const output = host.stdout();
    expect(output).toContain('config:');
    expect(output).toContain('descriptor: content/descriptor.json');
    expect(output).toContain('generated: content/keys.ts current');
    expect(output).toContain('store: snapshot-only');

    // --report is the pasteable block the issue template requires.
    const reported = makeCliHost({ config: {} });
    expect(await reported.run('doctor', '--report')).toBe(0);
    expect(reported.stdout()).toContain('```');
    expect(reported.stdout()).toMatch(/stet \d+\.\d+\.\d+ · node v/);

    // The live guard: the active value must be in the served HTML, raw or
    // entity-encoded. A miss names the key and the value it looked for.
    const stale = makeCliHost({ config: {}, fetchImpl: fakeFetch('<h1>Yesterday&#39;s copy</h1>') });
    expect(await stale.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(1);
    expect(stale.stderr()).toContain('hero_headline');
    expect(stale.stderr()).toContain('Never miss a post again.');

    const served = makeCliHost({ config: {}, fetchImpl: fakeFetch('<h1>Never miss a post again.</h1>') });
    expect(await served.run('doctor', '--url', 'https://example.test', '--key', 'hero_headline')).toBe(0);

    // The descriptor is JSON-parsed and the name comes off the command line, so
    // the not-a-key guard is an own-property test: `constructor` is not a key,
    // and saying anything else sends the reader after a key they never wrote.
    for (const name of ['constructor', '__proto__', 'toString']) {
      const proto = makeCliHost({ config: {}, fetchImpl: fakeFetch('<h1>x</h1>') });
      expect(await proto.run('doctor', '--url', 'https://example.test', '--key', name)).toBe(2);
      expect(proto.stderr()).toContain(`"${name}" is not a key`);
    }

    // The wrapper-chain check. The fixture's `welcome` is marketing and claims
    // `unsubscribe_url` in wrapperProvides — a claim the save gate takes on its
    // word — so a render pointer is what lets doctor go and look.
    const pointAt = (host: CliHost, file: string): void => {
      const descriptor = JSON.parse(host.file('content/descriptor.json'));
      descriptor.templates.welcome.render = { file, export: 'welcome', sampleProps: {} };
      writeFileSync(join(host.cwd, 'content/descriptor.json'), JSON.stringify(descriptor, null, 2));
      // The pointer changes the descriptor, so the generated files are rewritten
      // with it — otherwise every assertion below reads past a currency warning
      // this case is not about.
      const registry = generateRegistry(loadDescriptor(descriptor));
      writeFileSync(join(host.cwd, 'content/keys.ts'), registry.keysTs);
      writeFileSync(join(host.cwd, 'content/stet-env.d.ts'), registry.dts);
    };
    const ENTRY =
      "import { frame } from './frame';\n" +
      'export const welcome = (props: { welcome__body: string }): string => frame(props.welcome__body);\n';

    // A frame that carries both tokens: the chain is walked by relative import,
    // and nothing is warned.
    const honest = makeCliHost({ config: {} });
    writeFileSync(
      join(honest.cwd, 'frame.ts'),
      'const unsubscribe_url = "https://example.test/u";\n' +
        'const postal_address = "1 Test Way";\n' +
        'export const frame = (inner: string): string =>\n' +
        '  `${inner}<a href="${unsubscribe_url}">unsubscribe</a><p>${postal_address}</p>`;\n',
    );
    writeFileSync(join(honest.cwd, 'welcome-email.ts'), ENTRY);
    pointAt(honest, 'welcome-email.ts');
    expect(await honest.run('doctor')).toBe(0);
    expect(honest.stdout()).toContain('wrapper chain (welcome): 2 file(s), 1 declared token(s)');
    expect(honest.stderr()).not.toContain('appears nowhere in the render chain');

    // The same claim over a frame that emits neither token: the false claim and
    // the missing postal address are both warned, and the exit code is unmoved.
    const claimed = makeCliHost({ config: {} });
    writeFileSync(
      join(claimed.cwd, 'frame.ts'),
      'export const frame = (inner: string): string => `<html><body>${inner}</body></html>`;\n',
    );
    writeFileSync(join(claimed.cwd, 'welcome-email.ts'), ENTRY);
    pointAt(claimed, 'welcome-email.ts');
    // Both halves of the postal rule have to be absent before it says anything:
    // the fixture's own footer address is what keeps the honest host quiet.
    const emptied = JSON.parse(claimed.file('content/defaults.json'));
    emptied.default.brand__footer_address = '';
    writeFileSync(join(claimed.cwd, 'content/defaults.json'), JSON.stringify(emptied, null, 2));
    expect(await claimed.run('doctor')).toBe(0);
    expect(claimed.stdout()).toContain('1 unfound');
    expect(claimed.stderr()).toContain('wrapperProvides declares "unsubscribe_url"');
    expect(claimed.stderr()).toContain('welcome-email.ts, frame.ts');
    expect(claimed.stderr()).toContain('brand__footer_address is empty');

    // The token searched for in CODE: a frame that only NAMES it in a comment
    // has not emitted it, so the claim is still unfound — while the same token
    // inside the href's template literal satisfies it.
    const commented = makeCliHost({ config: {} });
    writeFileSync(
      join(commented.cwd, 'frame.ts'),
      '// TODO: emit unsubscribe_url here once the frame owns it\n' +
        'export const frame = (inner: string): string => `<html><body>${inner}</body></html>`;\n',
    );
    writeFileSync(join(commented.cwd, 'welcome-email.ts'), ENTRY);
    pointAt(commented, 'welcome-email.ts');
    expect(await commented.run('doctor')).toBe(0);
    expect(commented.stderr()).toContain('wrapperProvides declares "unsubscribe_url"');

    const emitted = makeCliHost({ config: {} });
    writeFileSync(
      join(emitted.cwd, 'frame.ts'),
      'export const frame = (inner: string): string =>\n' +
        '  `${inner}<a href="{{unsubscribe_url}}">unsubscribe</a>`;\n',
    );
    writeFileSync(join(emitted.cwd, 'welcome-email.ts'), ENTRY);
    pointAt(emitted, 'welcome-email.ts');
    expect(await emitted.run('doctor')).toBe(0);
    expect(emitted.stderr()).not.toContain('wrapperProvides declares "unsubscribe_url"');

    // The static-HTML host is named, and a snapshot-only checkout outside git
    // is told that publish cannot be a commit.
    const html = await makeHtmlHost({ register: true });
    expect(await html.run('doctor')).toBe(0);
    expect(html.stdout()).toContain('host: html — the marked documents are the rendered form; publish = commit');
    expect(html.stderr()).toContain('git: not a repository — publish cannot be a commit; run git init');
    const inGit = await makeHtmlHost({ register: true, git: true });
    expect(await inGit.run('doctor')).toBe(0);
    expect(inGit.stderr()).not.toContain('git: not a repository');
  });

  it('Requirement: upgrade knows what it upgrades from', async () => {
    // stet_meta absent: an unversioned database, reported as migration 1
    // pending — never "up to date".
    const absent = makeCliHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: fakeFetch(JSON.stringify({ code: 'PGRST205', message: 'not found' }), 404),
    });
    expect(await absent.run('upgrade')).toBe(0);
    // Every shipped migration is pending on an unversioned database, in number
    // order — the readdir picks each new file up with no count to maintain.
    expect(absent.stdout()).toContain('installed 0, pending 1, 2');
    expect(absent.stdout()).not.toContain('up to date');

    // canApplyDDL false: print the SQL, the apply paths and the post-apply
    // access check, apply nothing.
    expect(absent.stdout()).toContain('cannot apply DDL');
    expect(absent.stdout()).toContain("notify pgrst, 'reload schema';");
    expect(absent.stdout()).toContain("select has_table_privilege(");

    // --verify reads stet_meta through the adapter module and reports the move.
    let patched = '';
    const verified = makeCliHost({
      config: { store: { adapter: 'postgrest' } },
      env: { STET_POSTGREST_URL: 'http://postgrest.test', STET_POSTGREST_TOKEN: 't' },
      store: createMemoryStore({ project: 'default' }),
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patched = String(init.body);
          return new Response(JSON.stringify([{ id: 1 }]));
        }
        // The newest shipped migration: a database still reporting 1 has 002
        // pending and --verify would refuse it.
        return new Response(JSON.stringify([{ schema_version: 2, descriptor_version: '' }]));
      }) as typeof globalThis.fetch,
    });
    expect(await verified.run('upgrade', '--verify')).toBe(0);
    expect(verified.stdout()).toContain('schema_version 2');
    // Migration 1 ships descriptor_version '' — "not yet stamped" — and
    // upgrade is one of its two named stampers.
    expect(patched).toContain('"descriptor_version":"1"');

    // The registry regenerates from the descriptor, always.
    expect(verified.stdout()).toContain('content/keys.ts: unchanged');

    // There is no registry to regenerate on the static-HTML host.
    const html = await makeHtmlHost({ register: true });
    expect(await html.run('upgrade', '--dry-run')).toBe(0);
    expect(html.stdout()).toContain('codegen: none on an html host — the documents are regenerated by stet pull');
    expect(html.exists('content/keys.ts')).toBe(false);
  });

  it('Requirement: The Python helper reads the bundle contract', () => {
    const helper = readFileSync(new URL('../python/stet_read.py', import.meta.url), 'utf8');
    // No JS runtime, no store client, standard library only.
    const imports = [...helper.matchAll(/^import (\w+)|^from (\w+)/gm)].map((m) => m[1] ?? m[2]);
    expect(imports.sort()).toEqual(['copy', 'json', 'urllib']);
    // Read (path or URL), cache, look up with the locale chain, and versions.
    expect(helper).toContain('def load(');
    expect(helper).toContain('def lookup(');
    expect(helper).toContain('def version(');
    expect(helper).toContain('http://');
    // A URL read is bounded and a cached bundle is never handed out by
    // reference — both proven behaviourally in tests/python/check_snapshot.py.
    expect(helper).toContain('timeout=timeout');
    expect(helper).toContain('copy.deepcopy');
    // Both bundle forms, detected on the wrapper key exactly as readBundle
    // detects them.
    expect(helper).toContain('if "values" in raw');

    // The repo's Python check consumes it and holds zero derivation logic of
    // its own — the executable proof is `npm run test:python`, part of the
    // default `npm test`.
    const check = readFileSync(new URL('../tests/python/check_snapshot.py', import.meta.url), 'utf8');
    expect(check).toContain('from stet_read import load, lookup, version');
    expect(check).not.toContain('{v}');
    expect(check).not.toContain('tmpl');
    expect(check).not.toContain('def resolve');

    // It ships: a consumer installing the package gets the helper.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      files: string[];
    };
    expect(manifest.files).toContain('python');
  });

  it('Requirement: The CLI states its own version', async () => {
    // Any directory: nothing on this path reads a config, a project or a
    // store, and the version comes from the installation's own manifest — so
    // the first diagnostic anyone asks for is answerable from a bare tmpdir.
    const out: string[] = [];
    const err: string[] = [];
    const io = (o: string[], e: string[]): CliIo => ({
      cwd: tmpdir(),
      env: {},
      stdout: (line) => o.push(line),
      stderr: (line) => e.push(line),
    });
    expect(await runCli(['--version'], io(out, err))).toBe(0);
    expect(out).toHaveLength(1);
    // Anchored at BOTH ends: a line that merely starts with a version is not
    // one semver-shaped line, and the requirement is the whole line.
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(err).toEqual([]);

    // One spelling. `-v` is deliberately not aliased, so it stays an unknown
    // command with the usage — which documents the flag that does answer.
    const shortOut: string[] = [];
    const shortErr: string[] = [];
    expect(await runCli(['-v'], io(shortOut, shortErr))).toBe(2);
    expect(shortOut).toEqual([]);
    expect(shortErr.join('\n')).toContain('unknown command: -v');
    expect(shortErr.join('\n')).toContain('--version                the installed stet version');
    expect(shortErr.join('\n')).toContain('--help, -h               this usage');
  });

  it('Requirement: The CLI is an I/O layer outside src', () => {
    // The CLI lives beside adapters/, and src/ stays zero-I/O. The collection
    // is `source-roster.ts`'s — recursive, every compiled extension — so a new
    // layer under src/ cannot sit outside the boundary this proves, which is
    // the same collection tests/offline.test.ts pins its purity roster from.
    const srcRoot = new URL('../src/', import.meta.url);
    const roster = sourceFiles(srcRoot);
    for (const name of roster) {
      const source = readFileSync(new URL(name, srcRoot), 'utf8');
      for (const forbidden of ['node:fs', 'node:net', 'node:http']) {
        expect(`${name}: ${source.includes(forbidden)}`).toBe(`${name}: false`);
      }
    }

    // Nothing IMPORTS from cli/ except its own modules, its tests and the bin.
    // One mechanism owns that, at every depth: the token list this used to
    // carry matched `from '../cli/` literally, which a file one directory down
    // reaches as `from '../../cli/` and never matched — while the regex covers
    // both, the side-effect and re-export forms, and dynamic `import(...)`,
    // and unlike a substring test it does not fire on prose (`store-pg` names
    // which caller reports its throws).
    const importsCli = /(?:from|import)\s*[(\s]\s*['"][^'"]*\/cli\//;
    const layers: Array<[string, string[]]> = [
      ['../src/', roster],
      ['../adapters/', sourceFiles(new URL('../adapters/', import.meta.url))],
      ['../server/', sourceFiles(new URL('../server/', import.meta.url))],
    ];
    for (const [dir, names] of layers) {
      for (const name of names) {
        const source = readFileSync(new URL(`${dir}${name}`, import.meta.url), 'utf8');
        expect(`${dir}${name}: ${importsCli.test(source)}`).toBe(`${dir}${name}: false`);
      }
    }

    // The bin entry resolves to the compiled dispatch, and the command core is
    // callable in process — which every case above is the proof of.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ stet: 'dist/cli/main.js' });
    expect(readFileSync(new URL('../cli/main.ts', import.meta.url), 'utf8').split('\n')[0]).toBe(
      '#!/usr/bin/env node',
    );
    expect(typeof runCli).toBe('function');
  });
});

describe('adoption', () => {
  it("Requirement: A static-HTML host's documents are generated forms of the snapshot", async () => {
    // ONE walk over a real static-HTML host: adopt it, prove the page is a
    // generated form of the snapshot in both directions, bind its SEO, drop a
    // key, and eject back to plain markup.
    const host = bareHtmlHost({
      'about.html': '<html><head><meta charset="utf-8"></head><body><p>About the team.</p></body></html>\n',
    });
    const original = host.file('index.html');

    // init — the host is named, the shape is written, and nothing JavaScript is.
    expect(await host.run('init', '--yes')).toBe(0);
    // The evidence names the first `.html` at the root in sorted order.
    expect(host.stdout()).toContain('host: html (about.html at the root, no framework in package.json)');
    expect(host.exists('content/descriptor.json')).toBe(true);
    expect(host.exists('lib/content.ts')).toBe(false);
    expect(host.exists('content/keys.ts')).toBe(false);
    expect(host.exists('stet/migrations')).toBe(false);
    expect(JSON.parse(host.file('content/descriptor.json'))).toEqual({ version: 1, keys: {} });

    // scan — the elements are located and keyed.
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('scan')).toBe(0);
    expect(host.stdout()).toContain('scan: 2 files, 29 unkeyed literals');
    expect(host.stderr()).toContain('propose key software_product_and_engineering');

    // register — the plain run writes nothing, `--write` lands one batch.
    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan')).toBe(0);
    expect(host.file('index.html')).toBe(original);
    expect(JSON.parse(host.file('content/descriptor.json')).keys).toEqual({});

    host.out.length = 0;
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    const descriptor = () => JSON.parse(host.file('content/descriptor.json')) as {
      keys: Record<string, { tags?: number; pages?: string[] }>;
      pages?: Record<string, { route: string; seo?: Record<string, string> }>;
    };
    const snapshot = () => JSON.parse(host.file('content/defaults.json')) as {
      default: Record<string, string>;
    };
    // The mark is the ONLY edit: the document is byte-identical without it.
    expect(host.file('index.html').replace(/ data-stet[^ >]*="[^"]*"/g, '')).toBe(original);
    // A mixed element declares its placeholder count; identical text shares one key.
    expect(descriptor().keys['you_may_already_have_the_data_our_ai']?.tags).toBe(1);
    expect(host.file('index.html').match(/data-stet="how_it_works"/g)).toHaveLength(2);

    // check — every mark walked, the documents current.
    host.out.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(host.stdout()).toContain('document: index.html current (28 marks)');

    // A hand edit to the page is caught, and `pull` puts the snapshot back.
    const key = Object.entries(snapshot().default).find(
      ([, v]) => v === 'Software, product and engineering histories',
    )![0];
    writeFileSync(
      join(host.cwd, 'index.html'),
      host.file('index.html').replace('Software, product and engineering histories', 'Edited by hand'),
    );
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(1);
    expect(host.stderr()).toContain(`${key} differs from the snapshot — run stet pull`);
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toContain('>Software, product and engineering histories<');
    expect(await host.run('check')).toBe(0);

    // And a snapshot edit reaches the page the same way.
    const edited = snapshot();
    edited.default[key] = 'Engineering histories';
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(edited, null, 2)}\n`);
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('pull')).toBe(0);
    expect(host.file('index.html')).toContain('>Engineering histories<');
    // Every byte outside the mark's content is unchanged: strip the marks the
    // adoption inserted, put the old text back, and the original page returns.
    expect(
      host
        .file('index.html')
        .replace(/ data-stet[^ >]*="[^"]*"/g, '')
        .replace('Engineering histories', 'Software, product and engineering histories'),
    ).toBe(original);

    // A value that lost its placeholder is refused, and nothing is written.
    const broken = snapshot();
    const mixed = 'you_may_already_have_the_data_our_ai';
    broken.default[mixed] = 'You may already have the data our AI lab partners need.';
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(broken, null, 2)}\n`);
    const beforeRefusal = host.file('index.html');
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('pull')).toBe(1);
    expect(host.stderr()).toContain('could not be regenerated');
    expect(host.stderr()).toContain('tag-count-mismatch');
    expect(host.file('index.html')).toBe(beforeRefusal);
    // Put it back so the walk continues from a green host.
    broken.default[mixed] = 'You may already have the data<1> our AI lab partners need.</1>';
    writeFileSync(join(host.cwd, 'content/defaults.json'), `${JSON.stringify(broken, null, 2)}\n`);
    expect(await host.run('check')).toBe(0);

    // pages scan — the marks are the binding, and nothing is minted.
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('pages', 'scan', '--apply')).toBe(0);
    expect(descriptor().pages?.['home']?.seo).toEqual({
      title: 'psyon_data_partnerships_for_ai_labs',
      description: 'psyon_connects_hospitals_labs_and',
    });
    expect(descriptor().pages?.['about']?.seo).toBeUndefined();
    expect(descriptor().keys['seo_about_title']).toBeUndefined();
    // No unmarked key was scaffolded, so check stays free of that warn.
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);
    expect(host.stderr()).not.toContain('marked in no document');
    // The honest red is seo check's own.
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('seo', 'check')).toBe(1);
    expect(host.stderr()).toContain('over the 160-character bound');
    expect(host.stderr()).toContain('page "about" declares no SEO title');

    // remove — the mark is stripped and its text stays.
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('remove', 'how_it_works', '--write')).toBe(0);
    expect(host.file('index.html')).not.toContain('data-stet="how_it_works"');
    expect(host.file('index.html')).toContain('<a href="#how">How it works</a>');
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('check')).toBe(0);

    // eject — every mark gone, the text standing as the snapshot says.
    expect(await host.run('hook', 'install')).toBe(0);
    host.out.length = 0;
    host.err.length = 0;
    expect(await host.run('eject', '--write')).toBe(0);
    expect(/data-stet/.test(host.file('index.html'))).toBe(false);
    expect(host.file('index.html')).toContain('>Engineering histories<');
    expect(host.stdout()).toContain('stays (no stet imports): stet.config.json');
    expect(host.exists('.git/hooks/pre-commit')).toBe(false);
    expect(host.file('package.json')).not.toContain('@getstet/stet');
  });

  it('Requirement: init scaffolds a project with a single, shown edit to existing code', async () => {
    const host = makeAdoptionHost();
    expect(await host.run('init', '--yes')).toBe(0);
    // new files, written all at once
    expect(host.exists('content/descriptor.json')).toBe(true);
    expect(host.exists('stet.config.json')).toBe(true);
    expect(host.exists('lib/content.ts')).toBe(true);
    expect(host.exists('content/keys.ts')).toBe(true);
    // the ONE edit to existing code: the root layout mounts the CopyProvider
    expect(host.file('app/layout.tsx')).toContain('CopyProvider');
    // snapshot-only: no store detected, so no mount route is written
    expect(host.exists('app/api/stet/[...stet]/route.ts')).toBe(false);
    // completion prints the next step
    expect(host.stdout()).toContain('stet scan');
    // idempotent: a second init changes nothing
    const layout = host.file('app/layout.tsx');
    expect(await host.run('init', '--yes')).toBe(0);
    expect(host.file('app/layout.tsx')).toBe(layout);

    // The scaffold matches the host's own dependencies. A host declaring react
    // gets the `@getstet/stet/react` server accessor…
    expect(host.file('lib/content.ts')).toContain("import { createServerCopy } from '@getstet/stet/react';");

    // …and a host that declares none gets the framework-free accessor from the
    // package root, plus the resolved map: the accessor is callable-only, so a
    // template reading `{copy.key}` by property renders nothing without it.
    const reactless = makeAdoptionHost({ react: false });
    const reactlessLayout = reactless.file('app/layout.tsx');
    expect(await reactless.run('init', '--yes')).toBe(0);
    const readPath = reactless.file('lib/content.ts');
    expect(readPath).not.toContain('@getstet/stet/react');
    expect(readPath).toContain("import { createAccessor, readBundle, resolveAll, type Descriptor } from '@getstet/stet';");
    expect(readPath).toContain('export const copy = createAccessor(descriptor, resolved);');
    // The map is typed over the STRING-valued keys alone, so property access on
    // a number-, list- or record-shaped key is a compile error pointing at the
    // accessor's `.get()` rather than a value of the wrong type at render. The
    // host-side typecheck of exactly this cast lives in
    // tests/init-route-compile.test.ts, the one harness that compiles a
    // scaffold; here it is the emitted contract.
    expect(readPath).toContain('export const copyMap = resolved as Record<StringKey, string>;');
    expect(readPath).toContain("import type { StringKey } from '../content/keys.js';");
    expect(readPath).toContain(
      "// compile errors on this map — read them through the accessor's .get().",
    );
    // The starter ships `brand__radius` as a `number`, so every fresh scaffold
    // carries a key this map refuses — and the registry it points at says so.
    expect(JSON.parse(reactless.file('content/descriptor.json')).keys.brand__radius.shape).toBe('number');
    const registry = reactless.file('content/keys.ts');
    expect(registry).toContain("  'brand__radius',\n"); // in KEYS…
    const stringBlock = /^export const STRING_KEYS = \[\n([\s\S]*?)^\] as const;$/m.exec(registry)?.[1] ?? '';
    expect(stringBlock).not.toContain('brand__radius'); // …and out of STRING_KEYS
    expect(stringBlock).toContain("  'hero_headline',\n");
    // Nothing under the whole scaffold reaches react, imports included.
    expect(reactless.allText()).not.toContain('@getstet/stet/react');
    // And there is no provider to mount on such a host. The layout is present,
    // so the mount path was REACHED and declined — byte-unchanged under
    // `--yes`, which is the run that would otherwise have edited it — with the
    // read route named, and no output of any kind naming a module that cannot
    // load here (the file walk alone could never catch a printed snippet).
    expect(reactless.file('app/layout.tsx')).toBe(reactlessLayout);
    expect(reactless.stdout()).toContain(
      "no CopyProvider mount: this host declares no react — read copy from '@/lib/content', " +
        "either copy('key') for text or copyMap.key by property",
    );
    expect(`${reactless.stdout()}\n${reactless.stderr()}`).not.toContain('@getstet/stet/react');
    // The skip line itself says `no CopyProvider mount`, so a mount is
    // recognised by the two forms that mean one happened.
    expect(`${reactless.stdout()}\n${reactless.stderr()}`).not.toContain('import { CopyProvider }');
    expect(`${reactless.stdout()}\n${reactless.stderr()}`).not.toContain('<CopyProvider');

    // And the react-free server accessor is reachable BY NAME too, for a host
    // wiring its own read path: `@getstet/stet/react`'s index re-exports the provider,
    // so the subpath is the only door that does not drag react in. Resolved in
    // a plain-node child — the runner's transform has no `import.meta.resolve`.
    const subpath = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "process.stdout.write(import.meta.resolve('@getstet/stet/react/server'))"],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' },
    );
    expect(subpath.endsWith('/dist/react/server.js')).toBe(true);

    // The email surfaces a TypeScript host is scaffolded with cover `.tsx` as
    // well as `.ts`: a react-email template IS a `.tsx` component, and a
    // `.ts`-only glob made the no-argument walk skip a whole template directory.
    const mailer = makeAdoptionHost();
    mailer.write(
      'lib/email/welcome.tsx',
      'export function Welcome(props: { name: string }) {\n' +
        '  return <div><h1>Good to see you</h1><p>Hello {props.name}.</p></div>;\n' +
        '}\n',
    );
    expect(await mailer.run('init', '--yes')).toBe(0);
    expect(JSON.parse(mailer.file('stet.config.json')).emailSurfaces).toEqual([
      'lib/email/**/*.ts',
      'lib/email/**/*.tsx',
    ]);
    // Visible to the walk that takes no arguments, which is the one an adopter
    // runs first.
    expect(await mailer.run('email', 'extract')).toBe(0);
    expect(mailer.stdout()).toContain('welcome (lib/email/welcome.tsx)');

    // The agent-routing guidance, one case per targeting branch. A host with
    // NEITHER name gets both, identical — the pair is what reaches every tool.
    expect(host.exists('AGENTS.md')).toBe(true);
    expect(host.exists('CLAUDE.md')).toBe(true);
    expect(host.file('AGENTS.md')).toBe(host.file('CLAUDE.md'));
    expect(host.file('AGENTS.md')).toContain('<!-- stet:agent-guidance:begin -->');
    expect(host.file('AGENTS.md')).toContain('content/descriptor.json');
    // A re-run reports both present and changes neither byte.
    const pair = host.file('AGENTS.md');
    expect(await host.run('init', '--yes')).toBe(0);
    expect(host.file('AGENTS.md')).toBe(pair);
    expect(host.stdout()).toContain('agent guidance already present, identical');

    // A host carrying only CLAUDE.md gets the block APPENDED with its own text
    // byte-identical above it, and NO sibling AGENTS.md invented.
    const claude = makeAdoptionHost();
    const house = '# House rules\n\nBe kind to the reader.\n';
    claude.write('CLAUDE.md', house);
    expect(await claude.run('init', '--yes')).toBe(0);
    expect(claude.file('CLAUDE.md').startsWith(house)).toBe(true);
    expect(claude.file('CLAUDE.md')).toContain('<!-- stet:agent-guidance:begin -->');
    expect(claude.exists('AGENTS.md')).toBe(false);

    // The mirror, and the both-files case: every file the host carries gets it.
    const agents = makeAdoptionHost();
    agents.write('AGENTS.md', house);
    expect(await agents.run('init', '--yes')).toBe(0);
    expect(agents.file('AGENTS.md')).toContain('<!-- stet:agent-guidance:begin -->');
    expect(agents.exists('CLAUDE.md')).toBe(false);

    const both = makeAdoptionHost();
    both.write('AGENTS.md', house);
    both.write('CLAUDE.md', house);
    expect(await both.run('init', '--yes')).toBe(0);
    expect(both.file('AGENTS.md')).toContain('<!-- stet:agent-guidance:begin -->');
    expect(both.file('CLAUDE.md')).toContain('<!-- stet:agent-guidance:begin -->');

    // A hand-edited block is reported and skipped — init still succeeds after a
    // good scaffold, and the host's edit is byte-identical afterwards.
    const edited = makeAdoptionHost();
    expect(await edited.run('init', '--yes')).toBe(0);
    const mine = '<!-- stet:agent-guidance:begin -->\nour own wording\n<!-- stet:agent-guidance:end -->\n';
    edited.write('CLAUDE.md', mine);
    expect(await edited.run('init', '--yes')).toBe(0);
    expect(edited.file('CLAUDE.md')).toBe(mine);
    expect(edited.stdout()).toContain('differs from what stet would write');
    expect(edited.stdout()).toContain('delete the block and re-run, or keep your edit');

    // A dangling symlink is refused by name, and nothing is written THROUGH it
    // — `existsSync` calls such a path absent and a create would write its
    // missing target instead.
    const linked = makeAdoptionHost();
    symlinkSync(join(linked.cwd, 'nowhere.md'), join(linked.cwd, 'AGENTS.md'));
    expect(await linked.run('init', '--yes')).toBe(0);
    expect(linked.exists('nowhere.md')).toBe(false);
    expect(linked.stdout()).toContain('symlink to a missing target');

    // A host file stet cannot decode is reported and skipped, byte-identical
    // afterwards: the block's own bytes are utf8, and appending them would
    // leave a file no tool reads correctly.
    const latin1 = makeAdoptionHost();
    const cp1252 = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // `# Café\n`
    writeFileSync(join(latin1.cwd, 'CLAUDE.md'), cp1252);
    expect(await latin1.run('init', '--yes')).toBe(0);
    expect(latin1.stdout()).toContain('CLAUDE.md: it is not utf8 text');
    expect(readFileSync(join(latin1.cwd, 'CLAUDE.md')).equals(cp1252)).toBe(true);
    expect(latin1.exists('AGENTS.md')).toBe(false); // and no sibling invented in its place

    // A DIRECTORY sitting at one of the names is reported by name, and the
    // OTHER name is still created — a host with a `CLAUDE.md/` directory must
    // not end up with no guidance anywhere and no line saying why.
    const dirHost = makeAdoptionHost();
    mkdirSync(join(dirHost.cwd, 'CLAUDE.md'));
    expect(await dirHost.run('init', '--yes')).toBe(0);
    expect(dirHost.file('AGENTS.md')).toContain('<!-- stet:agent-guidance:begin -->');
    expect(dirHost.stdout()).toContain('CLAUDE.md: it is a directory, not a file');

    // A host file ending inside an UNCLOSED fence is refused, and refused on
    // every re-run: appending there would land the block inside the fence,
    // invisible to the next scan, and stack another copy each time.
    const unclosed = makeAdoptionHost();
    const openFence = '# Docs\n\n```\nnot closed\n';
    unclosed.write('CLAUDE.md', openFence);
    expect(await unclosed.run('init', '--yes')).toBe(0);
    expect(unclosed.stdout()).toContain('CLAUDE.md: it ends inside an unclosed code fence');
    expect(unclosed.file('CLAUDE.md')).toBe(openFence);
    // agents install refuses the same host outright, and three runs later the
    // file is still byte-identical — no copy of the block is reachable at all.
    expect(await unclosed.run('agents', 'install')).toBe(1);
    expect(await unclosed.run('agents', 'install')).toBe(1);
    expect(unclosed.file('CLAUDE.md')).toBe(openFence);
    expect(unclosed.exists('AGENTS.md')).toBe(false); // and no sibling invented past the refusal

    // A guidance write that fails is REPORTED, and init still succeeds: the
    // scaffold is already on disk and the spec forbids failing after it.
    const locked = makeAdoptionHost();
    locked.write('CLAUDE.md', house);
    chmodSync(join(locked.cwd, 'CLAUDE.md'), 0o444);
    try {
      expect(await locked.run('init', '--yes')).toBe(0);
      expect(locked.exists('stet.config.json')).toBe(true); // the scaffold stands
      expect(locked.stdout()).toContain('CLAUDE.md: could not be written (EACCES)');
      expect(locked.stdout()).toContain('add the stet agent-guidance block by hand');
      expect(locked.file('CLAUDE.md')).toBe(house);
    } finally {
      chmodSync(join(locked.cwd, 'CLAUDE.md'), 0o644);
    }

    // A block git will not carry to another clone is said out loud: reaching an
    // agent session in someone else's checkout is the block's whole job.
    const ignored = makeAdoptionHost();
    execFileSync('git', ['init', '-q'], { cwd: ignored.cwd });
    ignored.write('.gitignore', 'CLAUDE.md\n');
    expect(await ignored.run('init', '--yes')).toBe(0);
    expect(ignored.stdout()).toContain('CLAUDE.md is gitignored — the block will not reach other clones');
    expect(ignored.stdout()).not.toContain('AGENTS.md is gitignored');

    // Approval-gated: a non-interactive run WITHOUT --yes scaffolds fully and
    // writes no guidance, naming the command that writes it later.
    const unconfirmed = makeAdoptionHost();
    expect(await unconfirmed.run('init')).toBe(0);
    expect(unconfirmed.exists('stet.config.json')).toBe(true);
    expect(unconfirmed.exists('AGENTS.md')).toBe(false);
    expect(unconfirmed.exists('CLAUDE.md')).toBe(false);
    expect(unconfirmed.stdout()).toContain('agent guidance not written — stet agents install writes it later');

    // The router is detected by the route FILES the host carries, and an Astro
    // host is recorded as one — react declared or not. The fixture declares
    // react and carries `app/layout.tsx`, which is exactly what makes the
    // absence of a mount an assertion rather than an accident.
    const astro = makeAdoptionHost();
    astro.write('src/pages/index.astro', '---\nconst t = "Home";\n---\n<h1>{t}</h1>\n');
    const astroLayout = astro.file('app/layout.tsx');
    expect(await astro.run('init', '--yes')).toBe(0);
    const astroConfig = JSON.parse(astro.file('stet.config.json')) as Record<string, unknown>;
    expect(astroConfig['router']).toBe('astro');
    expect(Object.hasOwn(astroConfig, 'rootLayout')).toBe(false);
    expect(astroConfig['managedSurfaces']).toEqual(['src/**/*.astro']);
    expect(astro.file('src/lib/content.ts')).toContain('createAccessor');
    expect(astro.file('src/lib/content.ts')).toContain('copyMap');
    expect(astro.file('app/layout.tsx')).toBe(astroLayout);
    expect(astro.stdout()).toContain('router: astro (src/pages carries .astro files)');
    expect([astro.stdout(), astro.stderr()].join('\n')).not.toContain('stet/react');

    // A root `astro.config.*` with no `.astro` page at all is the same arm, and
    // a store-backed Astro run writes no Next-shaped mount route.
    const collections = makeAdoptionHost({ env: { STET_DATABASE_URL: 'postgres://localhost/x' } });
    collections.write('astro.config.mjs', 'export default {};\n');
    expect(await collections.run('init', '--yes')).toBe(0);
    const collectionsConfig = JSON.parse(collections.file('stet.config.json')) as Record<string, unknown>;
    expect(collectionsConfig['router']).toBe('astro');
    expect(collectionsConfig['mountRoute']).toBeUndefined();
    expect(collections.exists('src/app/api/stet/[...stet]/route.ts')).toBe(false);
    expect(collections.stdout()).toContain(
      'mount route: not scaffolded on an Astro host — mount createStetHandler in an Astro endpoint by hand',
    );

    // …while a host carrying `app/page.tsx` is recorded `app` with its root
    // layout exactly as before.
    const next = makeAdoptionHost();
    expect(await next.run('init', '--yes')).toBe(0);
    const nextConfig = JSON.parse(next.file('stet.config.json')) as Record<string, unknown>;
    expect(nextConfig['router']).toBe('app');
    expect(nextConfig['rootLayout']).toBe('app/layout.tsx');

    // A plain HTML site is detected and scaffolded as its own host kind. Its
    // config carries the paths and settings alone, the descriptor is EMPTY, and
    // no read path, codegen, migration or hook is written.
    const plain = bareHtmlHost();
    expect(await plain.run('init', '--yes')).toBe(0);
    expect(plain.stdout()).toContain('host: html (index.html at the root, no framework in package.json)');
    expect(plain.stdout()).not.toContain('router:');
    expect(plain.stdout()).not.toContain('note:');
    expect(plain.exists('lib/content.ts')).toBe(false);
    expect(plain.exists('content/keys.ts')).toBe(false);
    expect(plain.exists('.git/hooks/pre-commit')).toBe(false);
    expect(JSON.parse(plain.file('content/descriptor.json'))).toEqual({ version: 1, keys: {} });
    expect(plain.file('AGENTS.md')).toContain('data-stet');
    expect(plain.file('AGENTS.md')).toContain('stet pull');
    expect(plain.stdout()).toContain('1 page, 22 text elements, 6 attributes — next: stet scan, then stet hook install');
    // A re-run changes nothing.
    const before = plain.file('index.html');
    expect(await plain.run('init', '--yes')).toBe(0);
    expect(plain.file('index.html')).toBe(before);

    // A Vite host carrying a root index.html stays a JavaScript host — the
    // manifest is the tell, not the markup — while `--host html` forces it.
    const vite = bareHtmlHost();
    writeFileSync(
      join(vite.cwd, 'package.json'),
      JSON.stringify({ name: 'spa', private: true, devDependencies: { vite: '^5' } }, null, 2),
    );
    expect(await vite.run('init', '--yes')).toBe(0);
    expect(vite.stdout()).toContain('router: app (default — no route files found)');
    const forced = bareHtmlHost();
    writeFileSync(
      join(forced.cwd, 'package.json'),
      JSON.stringify({ name: 'spa', private: true, devDependencies: { vite: '^5' } }, null, 2),
    );
    expect(await forced.run('init', '--host', 'html', '--yes')).toBe(0);
    expect(forced.stdout()).toContain('host: html (--host html)');
  });

  it('Requirement: agents install writes the routing guidance into an already-adopted host', async () => {
    // The upgrade path for a host adopted before the guidance existed: init's
    // all-or-nothing scaffold refuses once a written file has evolved, so
    // re-running init is not it.
    const host = makeAdoptionHost();
    expect(await host.run('init', '--yes')).toBe(0);
    rmSync(join(host.cwd, 'AGENTS.md'));
    rmSync(join(host.cwd, 'CLAUDE.md'));
    expect(await host.run('agents', 'install')).toBe(0);
    expect(host.file('AGENTS.md')).toBe(host.file('CLAUDE.md'));
    expect(host.file('AGENTS.md')).toContain('<!-- stet:agent-guidance:begin -->');
    // A second run reports both present and writes nothing.
    const pair = host.file('AGENTS.md');
    expect(await host.run('agents', 'install')).toBe(0);
    expect(host.file('AGENTS.md')).toBe(pair);
    expect(host.stdout()).toContain('agent guidance already present, identical');

    // The modal case — the population this command exists for mostly already
    // carries a hand-written CLAUDE.md.
    const authored = makeAdoptionHost();
    const house = '# House rules\n\nBe kind to the reader.\n';
    expect(await authored.run('init')).toBe(0); // no --yes: init writes no guidance
    authored.write('CLAUDE.md', house);
    expect(await authored.run('agents', 'install')).toBe(0);
    expect(authored.file('CLAUDE.md').startsWith(house)).toBe(true);
    expect(authored.file('CLAUDE.md')).toContain('<!-- stet:agent-guidance:begin -->');
    expect(authored.exists('AGENTS.md')).toBe(false);

    // No stet.config.json is a refusal naming the prerequisite — loadConfig
    // returns defaults for a missing file, which would otherwise scaffold
    // guidance for a project that does not exist.
    const bare = makeAdoptionHost();
    expect(await bare.run('agents', 'install')).toBe(1);
    expect(bare.stderr()).toContain('agents install needs a stet project');
    expect(bare.stderr()).toContain('stet init');
    expect(bare.exists('AGENTS.md')).toBe(false);

    // A write that fails AFTER a clean plan exits nonzero WITH the whole report:
    // the operator has to be able to see which file took the block and which
    // did not. A throw here would take that record with it.
    const partly = makeAdoptionHost();
    expect(await partly.run('init')).toBe(0); // no --yes: no guidance yet
    partly.write('AGENTS.md', house);
    partly.write('CLAUDE.md', house);
    chmodSync(join(partly.cwd, 'CLAUDE.md'), 0o444);
    try {
      expect(await partly.run('agents', 'install')).toBe(1);
      expect(partly.stdout()).toContain('AGENTS.md: agent guidance appended'); // the one that worked
      expect(partly.stderr()).toContain('CLAUDE.md: could not be written (EACCES)');
      expect(partly.file('AGENTS.md')).toContain('<!-- stet:agent-guidance:begin -->');
      expect(partly.file('CLAUDE.md')).toBe(house);
    } finally {
      chmodSync(join(partly.cwd, 'CLAUDE.md'), 0o644);
    }

    // PLAN-ALL-THEN-APPLY: an edited block in one file refuses the whole run,
    // and the CLEAN file beside it is not written — proven by content compare.
    const partial = makeAdoptionHost();
    expect(await partial.run('init')).toBe(0);
    partial.write('CLAUDE.md', '<!-- stet:agent-guidance:begin -->\nours\n<!-- stet:agent-guidance:end -->\n');
    partial.write('AGENTS.md', house);
    expect(await partial.run('agents', 'install')).toBe(1);
    expect(partial.file('AGENTS.md')).toBe(house);
    expect(partial.stderr()).toContain('Nothing was written');
  });

  it('Requirement: scan reports copy literals as warnings, never failing by default', async () => {
    const host = makeAdoptionHost();
    expect(await host.run('init', '--yes')).toBe(0);
    // the page's unkeyed literal is warned (findings go to stderr), and the
    // exit stays 0 under the default warn severity
    expect(await host.run('scan')).toBe(0);
    expect(host.stderr()).toContain('Your week, sorted');
    expect(host.stderr()).toContain('propose key your_week_sorted');
    // It says how many files it read, so a green light always states its scope
    // (the layout and the page both match the scaffolded glob).
    expect(host.stdout()).toContain('scan: 2 files, 1 unkeyed literal');

    // A run that scanned nothing can never read as a clean bill. Each DEAD
    // glob is named — the site's shape is one dead `.tsx` glob beside a live
    // one — and a run where every declared glob is dead says so outright.
    const dead = makeAdoptionHost();
    expect(await dead.run('init', '--yes')).toBe(0);
    const config = JSON.parse(dead.file('stet.config.json'));
    dead.write(
      'stet.config.json',
      JSON.stringify({ ...config, managedSurfaces: ['src/pages/**/*.tsx', 'app/**/*.tsx'] }, null, 2),
    );
    expect(await dead.run('scan')).toBe(0);
    expect(dead.stderr()).toContain('glob matched no files: src/pages/**/*.tsx');
    expect(dead.stderr()).not.toContain('glob matched no files: app/**/*.tsx');
    expect(dead.stderr()).toContain('your_week_sorted'); // the live glob's findings stand
    expect(dead.stderr()).not.toContain('nothing was scanned');

    // Every glob dead: the extra warn, and under a `fail` posture the run
    // fails — `scan: 0 unkeyed literals` over zero files used to exit 0.
    const empty = makeAdoptionHost();
    expect(await empty.run('init', '--yes')).toBe(0);
    const emptyConfig = JSON.parse(empty.file('stet.config.json'));
    empty.write(
      'stet.config.json',
      JSON.stringify({ ...emptyConfig, managedSurfaces: ['src/pages/**/*.tsx'] }, null, 2),
    );
    expect(await empty.run('scan')).toBe(0);
    expect(empty.stderr()).toContain('the declared globs matched no files — nothing was scanned');
    empty.write(
      'stet.config.json',
      JSON.stringify(
        { ...emptyConfig, managedSurfaces: ['src/pages/**/*.tsx'], scan: { severity: 'fail' } },
        null,
        2,
      ),
    );
    expect(await empty.run('scan')).toBe(1);

    // Matched is not scanned. A glob that DOES match, over files the parser
    // refuses every one of, scanned nothing just as surely — a shape that
    // exited 0 even under a `fail` posture.
    const refused = makeAdoptionHost();
    expect(await refused.run('init', '--yes')).toBe(0);
    const refusedConfig = JSON.parse(refused.file('stet.config.json'));
    refused.write('src/pages/index.tsx', 'export default function Page( {  return <h1>Broken</h1>;\n');
    refused.write(
      'stet.config.json',
      JSON.stringify({ ...refusedConfig, managedSurfaces: ['src/**/*.tsx'] }, null, 2),
    );
    expect(await refused.run('scan')).toBe(0);
    expect(refused.stderr()).toContain('all 1 matched file(s) were refused by the parser — nothing was scanned');
    expect(refused.stderr()).not.toContain('glob matched no files');
    refused.write(
      'stet.config.json',
      JSON.stringify(
        { ...refusedConfig, managedSurfaces: ['src/**/*.tsx'], scan: { severity: 'fail' } },
        null,
        2,
      ),
    );
    expect(await refused.run('scan')).toBe(1);

    // A declared COPY MODULE is walked for the literals its host means as copy
    // — the shape the JSX locator has nothing to say about. An object-literal
    // property proposes its OWN name as the key; once adopted with a byte-equal
    // default it is silent; edited away from that default it warns naming both
    // values, and `--baseline` cannot switch that gate off.
    const modules = makeAdoptionHost();
    expect(await modules.run('init', '--yes')).toBe(0);
    const modulesConfig = JSON.parse(modules.file('stet.config.json'));
    modules.write('src/copy.ts', 'export const copy = {\n  site_tag: "one copy layer for every surface",\n};\n');
    modules.write(
      'stet.config.json',
      JSON.stringify({ ...modulesConfig, copyModules: ['src/copy.ts'] }, null, 2),
    );
    expect(await modules.run('scan')).toBe(0);
    expect(modules.stderr()).toContain('propose key site_tag');

    // Adopted through register, the same property is byte-equal to the snapshot
    // default and the scan says nothing about it. The host's stderr ACCUMULATES
    // across runs, so each verdict below is read from the lines that run added.
    expect(await modules.run('register', '--from', 'scan')).toBe(0);
    const afterAdopt = modules.err.length;
    expect(await modules.run('scan')).toBe(0);
    expect(modules.err.slice(afterAdopt).join('\n')).not.toContain('site_tag');

    // Edit the module's value away from the adopted default: the drift gate
    // names the key and both values, recommends neither, and stays loud through
    // a `--baseline` run — a divergence is never a baseline entry.
    modules.write('src/copy.ts', 'export const copy = {\n  site_tag: "one copy layer, drifted",\n};\n');
    const afterEdit = modules.err.length;
    expect(await modules.run('scan')).toBe(0);
    const drift = modules.err.slice(afterEdit).join('\n');
    expect(drift).toContain('site_tag diverged from the snapshot default');
    expect(drift).toContain('module "one copy layer, drifted"');
    expect(drift).toContain('snapshot "one copy layer for every surface"');
    expect(await modules.run('scan', '--baseline')).toBe(0);
    const afterBaseline = modules.err.length;
    expect(await modules.run('scan')).toBe(0);
    expect(modules.err.slice(afterBaseline).join('\n')).toContain('site_tag diverged from the snapshot default');

    // A template literal carrying substitutions is named as possible copy and
    // never proposed — a default has to be a literal value.
    const templated = makeAdoptionHost();
    expect(await templated.run('init', '--yes')).toBe(0);
    const templatedConfig = JSON.parse(templated.file('stet.config.json'));
    templated.write('src/mail.ts', 'export const greeting = `Welcome, ${name} — your week starts here`;\n');
    templated.write(
      'stet.config.json',
      JSON.stringify({ ...templatedConfig, copyModules: ['src/mail.ts'] }, null, 2),
    );
    const beforeTemplateScan = templated.err.length;
    expect(await templated.run('scan')).toBe(0);
    const templateWarns = templated.err.slice(beforeTemplateScan).join('\n');
    expect(templateWarns).toContain('possible copy "Welcome, — your week starts here"');
    expect(templateWarns).not.toContain('propose key greeting');

    // A template dialect is TEXT-scanned rather than parser-refused: the site's
    // own `.astro` shape, where the compiler is not involved at all. The label
    // between the tags comes back as possible copy with no proposed key, the
    // frontmatter and the braced expression contribute nothing, and the file
    // counts as scanned — the all-refused warn does not fire on its account.
    const dialect = makeAdoptionHost();
    expect(await dialect.run('init', '--yes')).toBe(0);
    const dialectConfig = JSON.parse(dialect.file('stet.config.json'));
    dialect.write(
      'src/pages/index.astro',
      '---\nconst title = "Home";\n---\n<h1>{title}</h1>\n<p>Your week, sorted</p>\n',
    );
    dialect.write(
      'stet.config.json',
      JSON.stringify({ ...dialectConfig, managedSurfaces: ['src/**/*.astro'] }, null, 2),
    );
    expect(await dialect.run('scan')).toBe(0);
    expect(dialect.stderr()).toContain('src/pages/index.astro:5 possible copy "Your week, sorted"');
    expect(dialect.stderr()).not.toContain('propose key');
    expect(dialect.stderr()).not.toContain('refused by the parser');
    expect(dialect.stdout()).not.toContain('could not be parsed cleanly');

    // CODE SPILLOVER is dropped — the one place this detector inverts its
    // report-when-unsure default. A multi-line conditional the one-level braced
    // strip cannot balance leaves a `{`-opening fragment and a `}`-opening one,
    // and prose takes neither shape; a brace-opening run carrying a QUOTED
    // string is a braced expression holding copy and keeps warning. A sentence
    // split at an inline tag stays split — the stated limit, not a filtered
    // shape.
    const spill = makeAdoptionHost();
    expect(await spill.run('init', '--yes')).toBe(0);
    const spillConfig = JSON.parse(spill.file('stet.config.json'));
    spill.write(
      'src/pages/pager.astro',
      '---\nconst { prev, next } = Astro.props;\n---\n' +
        '  {prev ? <a href={prev.href}><span>Previous</span></a> : <span class="hold" />}\n' +
        '  {next ? <a href={next.href}><span>Next</span></a> : <span class="hold" />}\n' +
        '<title>{`stet changelog — ${entry.data.title}`}</title>\n' +
        '<p>Managed <em>sending</em></p>\n',
    );
    spill.write(
      'stet.config.json',
      JSON.stringify({ ...spillConfig, managedSurfaces: ['src/**/*.astro'] }, null, 2),
    );
    expect(await spill.run('scan')).toBe(0);
    const spilled = spill.stderr();
    expect(spilled).not.toContain('prev ?');
    expect(spilled).not.toContain('next ?');
    // The quoted brace-opener survives, and it is real page-title copy.
    expect(spilled).toContain('possible copy "{`stet changelog — $"');
    // The inline-tag split, both halves, stated rather than silently repaired.
    expect(spilled).toContain('possible copy "Managed"');
    expect(spilled).toContain('possible copy "sending"');

    // ONE ignore comment silencing a WHOLE copy module is named — file, comment
    // line and count — on the LINE channel, with the exit unmoved even under a
    // `fail` posture: the opt-out this requirement itself sanctions must never
    // be what fails a run. A comment covering a single finding stays silent.
    const silenced = makeAdoptionHost();
    expect(await silenced.run('init', '--yes')).toBe(0);
    const silencedConfig = JSON.parse(silenced.file('stet.config.json'));
    silenced.write(
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        "  footer_note: 'stet is a working name.',\n" +
        '};\n',
    );
    silenced.write(
      'stet.config.json',
      JSON.stringify(
        { ...silencedConfig, managedSurfaces: [], copyModules: ['src/copy.ts'], scan: { severity: 'fail' } },
        null,
        2,
      ),
    );
    expect(await silenced.run('scan')).toBe(0);
    expect(silenced.stdout()).toContain('src/copy.ts:1: one stet-ignore comment silenced 3 literals');
    // A summary is not a finding: nothing is warned and the counter is unmoved.
    expect(silenced.stdout()).toContain('0 unkeyed literals');

    // A repo with NO declared surfaces still reports nothing: an empty declared
    // set is the bare-repo contract, not a dead glob.
    const bare = makeAdoptionHost();
    expect(await bare.run('init', '--yes')).toBe(0);
    const bareConfig = JSON.parse(bare.file('stet.config.json'));
    bare.write('stet.config.json', JSON.stringify({ ...bareConfig, managedSurfaces: [] }, null, 2));
    expect(await bare.run('scan')).toBe(0);
    expect(bare.stderr()).toBe('');

    // The scanner is the TypeScript 5 compiler API, and it says so. TS7's npm
    // package exposes version constants at its root and no compiler at all, so
    // a 7.x resolution is refused by name rather than crashing somewhere
    // further in — and the peer range (`>=5 <7`) states the same fact.
    expect(TS7_REFUSAL).toContain('typescript 7 is not yet supported');
    expect(TS7_REFUSAL).toContain('install typescript@5');
    const peers = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    expect(peers.peerDependencies['typescript']).toBe('>=5 <7');

    // The declared-slot check rides the same walk. A slot whose flattened key
    // has left the file that renders it is copy the dashboard still offers an
    // editor and the send no longer reads — and scan is what the pre-commit
    // hook runs, so the commit that disconnects it is the one that reports it.
    const emailer = makeAdoptionHost();
    emailer.write(
      'lib/email/welcome.ts',
      'export const welcome = (props: { welcome__headline: string }): string =>\n' +
        '  `<h1>${props.welcome__headline}</h1>`;\n',
    );
    expect(await emailer.run('init', '--yes')).toBe(0);
    const declared = JSON.parse(emailer.file('content/descriptor.json'));
    declared.keys.welcome__headline = { shape: 'text', target: 'html-email' };
    declared.templates = {
      ...(declared.templates ?? {}),
      welcome: {
        class: 'transactional',
        trigger: 'manual',
        slots: ['headline'],
        render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: {} },
      },
    };
    emailer.write('content/descriptor.json', JSON.stringify(declared, null, 2));

    // While the file renders the slot, nothing is said about it.
    expect(await emailer.run('scan')).toBe(0);
    expect(emailer.stderr()).not.toContain('never reads the value');

    // The rendering line deleted: warned, naming the template, the slot and the
    // file, and the exit code stays 0 under the default severity.
    emailer.write('lib/email/welcome.ts', 'export const welcome = (): string => `<h1>Good to see you</h1>`;\n');
    expect(await emailer.run('scan')).toBe(0);
    expect(emailer.stderr()).toContain('welcome__headline is declared as a slot of welcome');
    // The wording positively, not only as the negative above: without this the
    // warn could be reworded and the "nothing is said while it renders" check
    // would keep passing over a sentence that no longer exists.
    expect(emailer.stderr()).toContain('never reads the value');
    expect(emailer.stderr()).toContain('lib/email/welcome.ts:');

    // The uncovered static route, the second descriptor-vs-host check on this
    // requirement. A host that has begun declaring pages gains a route file,
    // and the warn lands at the scan the hook runs.
    const routed = makeAdoptionHost();
    routed.write(
      'content/descriptor.json',
      JSON.stringify({ version: 1, keys: {}, pages: { home: { route: '/' } } }, null, 2),
    );
    routed.write('src/pages/index.astro', '<h1>Home</h1>\n');
    routed.write('src/pages/team.astro', '<h1>Team</h1>\n');
    routed.write('src/pages/changelog/[slug].astro', '<h1>Entry</h1>\n');
    // A markdown route is a static route like any other, and scan warns it the
    // same way — through the detector called with no seed option, so the
    // file's contents are never opened on scan's behalf.
    routed.write('src/pages/handbook.md', '---\ntitle: The handbook\n---\n# Handbook\n');
    expect(await routed.run('scan')).toBe(0);
    expect(routed.stderr()).toContain('route /team (src/pages/team.astro) has no page record — run stet pages scan');
    expect(routed.stderr()).toContain('route /handbook (src/pages/handbook.md) has no page record');
    expect(routed.stderr()).not.toContain('The handbook');
    // A dynamic route is the skip taxonomy's subject, not drift: scan does not
    // re-report what `pages scan` already refuses to propose.
    expect(routed.stderr()).not.toContain('[slug]');

    // A host that never declared a page is unopted rather than drifting — that
    // case belongs to the seo capability's zero-pages warn.
    const unopted = makeAdoptionHost();
    unopted.write('content/descriptor.json', JSON.stringify({ version: 1, keys: {} }, null, 2));
    unopted.write('src/pages/team.astro', '<h1>Team</h1>\n');
    expect(await unopted.run('scan')).toBe(0);
    expect(unopted.stderr()).not.toContain('has no page record');

    // The fifth dialect: an `.html` on a JavaScript host is text-warned with no
    // proposed key, like every other dialect.
    const htmlDialect = makeCliHost({ config: { router: 'astro', managedSurfaces: ['src/**/*.html'] } });
    mkdirSync(join(htmlDialect.cwd, 'src'), { recursive: true });
    writeFileSync(join(htmlDialect.cwd, 'src/legacy.html'), '<html><body><h1>A legacy label</h1></body></html>');
    expect(await htmlDialect.run('scan')).toBe(0);
    expect(htmlDialect.stderr()).toContain('possible copy "A legacy label"');
    expect(htmlDialect.stderr()).not.toContain('propose key');

    // On the static-HTML host scan goes further: the element behind each run is
    // located, and the finding carries a key.
    const html = await makeHtmlHost();
    expect(await html.run('scan', '--json')).toBe(0);
    const located = html.json<{
      html: { proposals: Array<{ tag: string; section?: string; tags: number; value: string }>; skips: unknown[] };
    }>().html;
    expect(located.skips).toEqual([]);
    const heading = located.proposals.find((p) => p.tag === 'h3');
    expect(heading).toMatchObject({ section: 'qualify' });
    // A mixed element is ONE proposal carrying numbered placeholder tags.
    expect(located.proposals.find((p) => p.tag === 'h1')).toMatchObject({
      tags: 1,
      value: 'You may already have the data<1> our AI lab partners need.</1>',
    });
    expect(located.proposals.find((p) => p.value === 'Hello <1>big <2>world</2></1>!')?.tags).toBe(2);

    // A claimed mark is silent; a refused one is a named skip.
    const marked = await makeHtmlHost({ register: true });
    marked.out.length = 0;
    marked.err.length = 0;
    expect(await marked.run('scan')).toBe(0);
    expect(marked.stderr()).not.toContain('Software, product and engineering histories');
    const edges = await makeHtmlHost({ files: { 'index.html': htmlFixture('edges.html') } });
    expect(await edges.run('scan')).toBe(0);
    expect(edges.stderr()).toContain('skipped (mark-on-non-key-element)');
    expect(edges.stderr()).toContain('skipped (mark-in-refused-context)');
    expect(edges.stderr()).toContain('skipped (unknown-entity)');
  });

  it('Requirement: register adds a key and rewrites the consuming leaf', async () => {
    // no --write: the descriptor gains the key, the leaf's source is untouched
    const planned = makeAdoptionHost();
    expect(await planned.run('init', '--yes')).toBe(0);
    const pageBefore = planned.file('app/page.tsx');
    expect(await planned.run('register', '--from', 'scan')).toBe(0);
    expect(planned.file('app/page.tsx')).toBe(pageBefore);
    expect(JSON.parse(planned.file('content/descriptor.json')).keys.your_week_sorted).toBeDefined();

    // --write: the leaf becomes an accessor call and the read-path import lands
    const applied = makeAdoptionHost();
    expect(await applied.run('init', '--yes')).toBe(0);
    expect(await applied.run('register', '--from', 'scan', '--write')).toBe(0);
    const page = applied.file('app/page.tsx');
    expect(page).toContain("copy('your_week_sorted')");
    expect(page).toContain('@/lib/content');
    expect(page).not.toContain('Your week, sorted');

    // An import that resolves nowhere refuses BEFORE any rewrite: applying one
    // breaks every file it touched, silently, at the host's next build.
    const unresolvable = makeAdoptionHost();
    expect(await unresolvable.run('init', '--yes')).toBe(0);
    rmSync(join(unresolvable.cwd, 'tsconfig.json'));
    const before = unresolvable.file('app/page.tsx');
    const descriptorBefore = unresolvable.file('content/descriptor.json');
    expect(await unresolvable.run('register', '--from', 'scan', '--write')).toBe(1);
    expect(unresolvable.stderr()).toContain('no tsconfig/jsconfig path mapping in this project resolves it to');
    expect(unresolvable.stderr()).toContain('Declare the alias in the project file, or edit readPath.import');
    // Not one file touched — the descriptor write runs in both modes, so it is
    // the one that proves the guard precedes everything.
    expect(unresolvable.file('app/page.tsx')).toBe(before);
    expect(unresolvable.file('content/descriptor.json')).toBe(descriptorBefore);

    // The diff-only run on that same host still prints: a printed diff
    // misleads nobody, and an applied one breaks the build.
    expect(await unresolvable.run('register', '--from', 'scan')).toBe(0);
    expect(unresolvable.stdout()).toContain('+++ b/app/page.tsx');

    // --- A declared COPY MODULE is adopted as record, its source untouched ---
    //
    // The specimen mirrors `site/src/copy.ts` at HEAD: a flat object literal
    // under `as const`, non-ASCII values (the middle dot U+00B7, the em dash
    // U+2014), and a value written on the line below its property name. Its
    // `hero_headline` deliberately COLLIDES with the placeholder `init` just
    // scaffolded — the first pass hit exactly that collision — so the no-suffix
    // rule is proven rather than dodged.
    //
    // This proves the MECHANISM on representative shapes. The full 77-key
    // equivalence against the frozen hand-derived registry is the site redo's
    // SJ1 acceptance, run on the real host, not here.
    const oracle = makeAdoptionHost({
      // No unkeyed JSX literal: the module half is what this case is about, and
      // the site's own pages are `.astro` rather than JSX anyway. It also makes
      // "a second register adds nothing" an exact claim rather than one scoped
      // around the JSX loop's own suffixing.
      page: 'export default function Page() {\n  return null;\n}\n',
    });
    expect(await oracle.run('init', '--yes')).toBe(0);
    oracle.write(
      'src/copy.ts',
      'export const copy = {\n' +
        '  hero_headline: "Change the content across your sites in seconds.",\n' +
        '  hero_eyebrow: "Open source · Apache-2.0",\n' +
        '  site_tag:\n' +
        '    "one copy layer for all your sites and apps — typed, versioned",\n' +
        '  footer_note: "stet is a working name.",\n' +
        '} as const;\n',
    );
    const oracleConfig = JSON.parse(oracle.file('stet.config.json'));
    oracle.write('stet.config.json', JSON.stringify({ ...oracleConfig, copyModules: ['src/copy.ts'] }, null, 2));

    const moduleBefore = readFileSync(join(oracle.cwd, 'src/copy.ts'));
    // The PLAIN run completes module adoption whole: the descriptor and
    // snapshot writes were never `--write`-gated, and there is no source edit
    // for `--write` to hold back.
    expect(await oracle.run('register', '--from', 'scan')).toBe(0);
    const adoptedOut = oracle.stdout();
    expect(adoptedOut).toContain('adopted hero_eyebrow = Open source · Apache-2.0');
    expect(adoptedOut).toContain('adopted footer_note = stet is a working name.');
    expect(adoptedOut).toContain('register: adopted as record — there are no source edits to apply');
    // One line per key, never a diff: there is no source edit to show.
    expect(adoptedOut).not.toContain('+++ b/src/copy.ts');

    // The descriptor gained the module's own names, beside the starter's five.
    const oracleKeys = Object.keys(JSON.parse(oracle.file('content/descriptor.json')).keys).sort();
    expect(oracleKeys).toEqual(
      ['brand__ink', 'brand__name', 'brand__primary', 'brand__radius', 'footer_note', 'hero_eyebrow', 'hero_headline', 'site_tag'].sort(),
    );
    // The COLLISION: reported, never adopted over, and never suffixed. The
    // starter's value stands, and a `hero_headline_2` exists nowhere at all.
    expect(JSON.parse(oracle.file('content/defaults.json')).default.hero_headline).toBe('Your headline goes here');
    expect(oracle.stderr()).toContain('hero_headline diverged from the snapshot default');
    expect(oracle.allText()).not.toContain('hero_headline_2');
    // The adopted values are BYTE-identical in the file as written — the
    // non-ASCII glyphs are the hazard, so the claim is made against bytes.
    const rawDefaults = readFileSync(join(oracle.cwd, 'content/defaults.json'));
    expect(rawDefaults.includes(Buffer.from('Open source · Apache-2.0', 'utf8'))).toBe(true);
    expect(rawDefaults.includes(Buffer.from('one copy layer for all your sites and apps — typed, versioned', 'utf8'))).toBe(true);
    // The codegen was regenerated with them, and the offline check is green.
    expect(oracle.file('content/keys.ts')).toContain('hero_eyebrow');
    expect(await oracle.run('check')).toBe(0);
    // The module itself is untouched, byte for byte.
    expect(readFileSync(join(oracle.cwd, 'src/copy.ts')).equals(moduleBefore)).toBe(true);

    // `--write` is the SOURCE-EDIT gate, and for a module shape there is no
    // source edit: it changes nothing further, the module least of all.
    const descriptorAfterPlain = oracle.file('content/descriptor.json');
    expect(await oracle.run('register', '--from', 'scan', '--write')).toBe(0);
    expect(readFileSync(join(oracle.cwd, 'src/copy.ts')).equals(moduleBefore)).toBe(true);
    expect(oracle.file('content/descriptor.json')).toBe(descriptorAfterPlain);

    // The same adoption where `--write` is the FIRST register run, on a host
    // seeded identically. It is a separate host on purpose: above, every
    // property was already adopted before `--write` ran, so each one hit the
    // adopted-skip and no finding could reach a rewrite at all — a `--write`-
    // GATED rewrite wrongly copied into the module loop (the likeliest
    // accident, since the JSX loop's own write sits behind `if (write)`) would
    // pass that case for the wrong reason. Here the properties are unadopted
    // AND `--write` is on, which is the only combination that would fire one.
    const oracleWrite = makeAdoptionHost({ page: 'export default function Page() {\n  return null;\n}\n' });
    expect(await oracleWrite.run('init', '--yes')).toBe(0);
    oracleWrite.write('src/copy.ts', oracle.file('src/copy.ts'));
    const writeConfig = JSON.parse(oracleWrite.file('stet.config.json'));
    oracleWrite.write('stet.config.json', JSON.stringify({ ...writeConfig, copyModules: ['src/copy.ts'] }, null, 2));
    const writeModuleBefore = readFileSync(join(oracleWrite.cwd, 'src/copy.ts'));

    expect(await oracleWrite.run('register', '--from', 'scan', '--write')).toBe(0);
    // Not one byte of the module moved, and the adoption still completed.
    expect(readFileSync(join(oracleWrite.cwd, 'src/copy.ts')).equals(writeModuleBefore)).toBe(true);
    const writeKeys = JSON.parse(oracleWrite.file('content/descriptor.json')).keys;
    for (const key of ['hero_eyebrow', 'site_tag', 'footer_note']) expect(writeKeys[key]).toBeDefined();
    expect(JSON.parse(oracleWrite.file('content/defaults.json')).default.hero_headline).toBe('Your headline goes here');
    expect(oracleWrite.stderr()).toContain('hero_headline diverged from the snapshot default');
    // A `--write` run that applied no leaf edit does not claim it applied one.
    expect(oracleWrite.stdout()).toContain('register: adopted as record — there are no source edits to apply');
    expect(oracleWrite.stdout()).not.toContain('register: applied');

    // Idempotence, mechanized rather than asserted: run two classifies every
    // adopted property `adopted` through the same classifier scan uses, so it
    // adds nothing…
    // Read from the lines THIS run added: the host's stdout accumulates, and
    // the first run's own output would satisfy the assertion by itself.
    const beforeSecondRegister = oracle.out.length;
    expect(await oracle.run('register', '--from', 'scan')).toBe(0);
    expect(oracle.out.slice(beforeSecondRegister).join('\n')).toContain('register: nothing to adopt');
    expect(oracle.file('content/descriptor.json')).toBe(descriptorAfterPlain);
    // …and the scan that follows is silent on them, while the drift gate still
    // names the one value that diverges.
    expect(await oracle.run('scan')).toBe(0);
    expect(oracle.stderr()).not.toContain('propose key hero_eyebrow');
    expect(oracle.stderr()).not.toContain('propose key footer_note');
    expect(oracle.stderr()).toContain('hero_headline diverged from the snapshot default');

    // A wall of parse refusals collapses to one count, BELOW the adopted lines,
    // and `--verbose` restores the list. Three or fewer print as they always
    // did — two refusals are information, a screenful buries the plan.
    const refusing = makeAdoptionHost();
    expect(await refusing.run('init', '--yes')).toBe(0);
    const refusingConfig = JSON.parse(refusing.file('stet.config.json'));
    for (let i = 0; i < 4; i++) {
      refusing.write(`src/pages/p${i}.astro`, '---\nconst t = 1;\n---\n<h1>Chapter</h1>\n');
    }
    refusing.write('src/copy.ts', 'export const copy = {\n  footer_note: "A working name",\n};\n');
    refusing.write(
      'stet.config.json',
      JSON.stringify(
        { ...refusingConfig, managedSurfaces: ['src/pages/**/*.astro'], copyModules: ['src/copy.ts'] },
        null,
        2,
      ),
    );
    const beforeCollapse = refusing.out.length;
    expect(await refusing.run('register', '--from', 'scan')).toBe(0);
    const collapsed = refusing.out.slice(beforeCollapse);
    expect(collapsed.join('\n')).toContain(
      '4 file(s) could not be parsed cleanly — reported, not adopted; run with --verbose to list them',
    );
    expect(collapsed.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toEqual([]);
    // What the run achieved reads first; what it could not read follows.
    const adoptedAt = collapsed.findIndex((l) => l.startsWith('adopted footer_note'));
    expect(adoptedAt).toBeGreaterThanOrEqual(0);
    expect(collapsed.findIndex((l) => l.includes('4 file(s) could not be parsed'))).toBeGreaterThan(adoptedAt);

    const beforeVerbose = refusing.out.length;
    expect(await refusing.run('register', '--from', 'scan', '--verbose')).toBe(0);
    const listed = refusing.out.slice(beforeVerbose);
    expect(listed.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toHaveLength(4);
    expect(listed.join('\n')).not.toContain('run with --verbose to list them');

    // On the static-HTML host the ONE edit is the mark, and the plain run writes
    // nothing at all — a departure from the JavaScript branch above, kept
    // because a descriptor entry without its mark is half a batch.
    const html = await makeHtmlHost();
    const original = html.file('index.html');
    const emptyDescriptor = html.file('content/descriptor.json');
    expect(await html.run('register', '--from', 'scan')).toBe(0);
    expect(html.file('index.html')).toBe(original);
    expect(html.file('content/descriptor.json')).toBe(emptyDescriptor);

    html.out.length = 0;
    expect(await html.run('register', '--from', 'scan', '--write')).toBe(0);
    // Byte-identical outside the inserted attributes; no typescript, no alias.
    expect(html.file('index.html').replace(/ data-stet[^ >]*="[^"]*"/g, '')).toBe(original);
    expect(html.exists('content/keys.ts')).toBe(false);
    const keys = (JSON.parse(html.file('content/descriptor.json')) as {
      keys: Record<string, { tags?: number }>;
    }).keys;
    const values = (JSON.parse(html.file('content/defaults.json')) as {
      default: Record<string, string>;
    }).default;
    expect(keys['you_may_already_have_the_data_our_ai']?.tags).toBe(1);
    // `&amp;` read back as the character it denotes.
    expect(values['research_development_notes']).toBe('Research & development notes.');
    // Identical text shares ONE key; the near-misses take the suffixes in order.
    expect(Object.keys(keys).filter((k) => k.startsWith('how_it_works')).sort()).toEqual([
      'how_it_works',
      'how_it_works_2',
      'how_it_works_3',
    ]);
    expect(html.file('index.html').match(/data-stet="how_it_works"/g)).toHaveLength(2);
    // A link carrying both a copy title and text takes both marks on one tag.
    expect(html.file('index.html')).toContain(
      '<a href="/book" title="Book now" data-stet="book_now" data-stet-title="book_now">',
    );
    // A second run adopts nothing.
    html.out.length = 0;
    expect(await html.run('register', '--from', 'scan')).toBe(0);
    expect(html.stdout()).toContain('register: nothing to adopt');
  });

  it('Requirement: eject un-rewrites the host, writes content back, and removes the dependency', async () => {
    const host = makeAdoptionHost();
    expect(await host.run('init', '--yes')).toBe(0);
    expect(await host.run('register', '--from', 'scan', '--write')).toBe(0);
    // without --write eject touches nothing
    const adopted = host.file('app/page.tsx');
    expect(await host.run('eject')).toBe(0);
    expect(host.file('app/page.tsx')).toBe(adopted);
    // --write reverses everything: the leaf, the provider mount, the dep
    expect(await host.run('eject', '--write')).toBe(0);
    expect(host.file('app/page.tsx')).toContain('Your week, sorted');
    expect(host.file('app/page.tsx')).not.toContain("copy('your_week_sorted')");
    expect(host.file('app/layout.tsx')).not.toContain('CopyProvider');
    // the headline: no stet specifier survives anywhere, and the dep is gone
    expect(host.allText()).not.toMatch(/from ['"]stet/);
    expect(JSON.parse(host.file('package.json')).dependencies['@getstet/stet']).toBeUndefined();
    // AGENTS.md and CLAUDE.md held nothing but the block, so both are gone —
    // no zero-byte leftovers still naming a dependency that is not there.
    expect(host.exists('AGENTS.md')).toBe(false);
    expect(host.exists('CLAUDE.md')).toBe(false);

    // A host file that hand-wired itself onto the scaffold refuses the eject
    // rather than being cut loose. Plan-only prints the FULL manifest — the
    // kept line with its importer and remedy, what stays, and the guidance,
    // hook and dependency lines — then exits nonzero.
    const wired = makeAdoptionHost();
    expect(await wired.run('init', '--yes')).toBe(0);
    expect(await wired.run('register', '--from', 'scan', '--write')).toBe(0);
    wired.write('lib/copy.ts', "import { copy } from './content';\n\nexport const hero = (): string => copy('your_week_sorted');\n");
    expect(await wired.run('eject')).toBe(1);
    expect(wired.stdout()).toContain(
      'lib/content.ts: kept — imported by lib/copy.ts; un-wire that import first, then re-run eject',
    );
    // The WHOLE line, not its opening: on a host init scaffolded, the
    // generated registry and the migration copies both exist by construction,
    // and an emitter that dropped either would read as complete here.
    expect(wired.stdout()).toContain(
      'stays (no stet imports): stet.config.json, content/descriptor.json, content/defaults.json, ' +
        'content/keys.ts, stet/migrations/',
    );
    expect(wired.stdout()).toContain('drop the stet dependency from package.json');
    expect(wired.stdout()).toContain('still imports stet: lib/content.ts');
    expect(wired.stderr()).toContain('still importing stet');

    // `--write` refuses with nothing written…
    const before = wired.file('app/page.tsx');
    expect(await wired.run('eject', '--write')).toBe(1);
    expect(wired.file('app/page.tsx')).toBe(before);
    expect(wired.exists('lib/content.ts')).toBe(true);
    expect(JSON.parse(wired.file('package.json')).dependencies['@getstet/stet']).toBe('^1.0.0');

    // …and once the host un-wires the import, the same host ejects.
    wired.write('lib/copy.ts', "export const hero = (): string => 'Your week, sorted';\n");
    expect(await wired.run('eject', '--write')).toBe(0);
    expect(wired.exists('lib/content.ts')).toBe(false);
    expect(wired.allText()).not.toMatch(/from ['"]stet/);

    // The plan-only run names each removal and its SIZE, and touches nothing —
    // on a host init created the pair for, both lines are deletions.
    const planned = makeAdoptionHost();
    expect(await planned.run('init', '--yes')).toBe(0);
    const created = planned.file('AGENTS.md');
    expect(await planned.run('eject')).toBe(0);
    expect(planned.stdout()).toContain('delete AGENTS.md (it holds only the stet agent-guidance block)');
    expect(planned.stdout()).toContain('delete CLAUDE.md (it holds only the stet agent-guidance block)');
    expect(planned.file('AGENTS.md')).toBe(created);
    // The guidance step runs BEFORE the dependency drop. The order is what a
    // part-way failure leaves behind: guidance-gone-dependency-present heals on
    // a re-run, dependency-gone-guidance-still-routing does not.
    const guidanceAt = planned.out.findIndex((line) => line.startsWith('delete AGENTS.md'));
    const dependencyAt = planned.out.findIndex((line) => line === 'drop the stet dependency from package.json');
    expect(guidanceAt).toBeGreaterThanOrEqual(0);
    expect(dependencyAt).toBeGreaterThan(guidanceAt);

    // The append's inverse: a host-authored CLAUDE.md comes back byte-identical
    // to its PRE-INIT state. Its removal is the one with a line count, because
    // the file survives it.
    const authored = makeAdoptionHost();
    const house = '# House rules\n\nBe kind to the reader.\n';
    authored.write('CLAUDE.md', house);
    expect(await authored.run('init', '--yes')).toBe(0);
    const appended = authored.file('CLAUDE.md');
    expect(appended).not.toBe(house);
    expect(authored.exists('AGENTS.md')).toBe(false); // targeting: no sibling invented

    expect(await authored.run('eject')).toBe(0);
    expect(authored.stdout()).toContain('remove the stet agent-guidance block from CLAUDE.md (3 lines)');
    expect(authored.file('CLAUDE.md')).toBe(appended); // plan only: untouched

    expect(await authored.run('eject', '--write')).toBe(0);
    expect(authored.file('CLAUDE.md')).toBe(house);

    // An EDITED span still leaves, but the plan says so before it does — the
    // host sees both the size and the provenance of what is going.
    const tampered = makeAdoptionHost();
    tampered.write('CLAUDE.md', house);
    expect(await tampered.run('init', '--yes')).toBe(0);
    tampered.write(
      'CLAUDE.md',
      `${house}\n<!-- stet:agent-guidance:begin -->\nour own wording\n<!-- stet:agent-guidance:end -->\n`,
    );
    expect(await tampered.run('eject', '--write')).toBe(0);
    expect(tampered.stdout()).toContain('remove the stet agent-guidance block from CLAUDE.md (3 lines) (edited)');
    expect(tampered.file('CLAUDE.md')).toBe(house);

    // A block the host MOVED is named by the backstop, never chased: eject
    // edits only the two names at its root.
    const moved = makeAdoptionHost();
    expect(await moved.run('init', '--yes')).toBe(0);
    const block = moved.file('AGENTS.md');
    moved.write('docs/agent-notes.md', `# Notes\n\n${block}`);
    expect(await moved.run('eject', '--write')).toBe(0);
    expect(moved.stdout()).toContain('docs/agent-notes.md: carries the stet agent-guidance markers');
    expect(moved.file('docs/agent-notes.md')).toContain('<!-- stet:agent-guidance:begin -->');

    // A host whose CLAUDE.md is a SYMLINK is never deleted through: removing
    // the link would leave the block alive in its target while the plan claimed
    // the file held nothing else. It is named with its target and left alone.
    const shared = makeAdoptionHost();
    expect(await shared.run('init', '--yes')).toBe(0);
    const guidance = shared.file('AGENTS.md');
    rmSync(join(shared.cwd, 'CLAUDE.md'));
    shared.write('docs/shared-agents.md', guidance);
    symlinkSync(join(shared.cwd, 'docs/shared-agents.md'), join(shared.cwd, 'CLAUDE.md'));
    expect(await shared.run('eject', '--write')).toBe(0);
    expect(shared.stdout()).toContain('CLAUDE.md → docs/shared-agents.md');
    expect(shared.stdout()).toContain('remove it by hand');
    // the link and its target both survive, block intact
    expect(readFileSync(join(shared.cwd, 'docs/shared-agents.md'), 'utf8')).toBe(guidance);

    // The two names on ONE file: deleting the real one would leave the other a
    // broken link, so neither goes and the plan names both. Which spelling the
    // host keeps is their layout decision.
    const oneFile = makeAdoptionHost();
    expect(await oneFile.run('init', '--yes')).toBe(0);
    rmSync(join(oneFile.cwd, 'CLAUDE.md'));
    symlinkSync(join(oneFile.cwd, 'AGENTS.md'), join(oneFile.cwd, 'CLAUDE.md'));
    expect(await oneFile.run('eject', '--write')).toBe(0);
    expect(oneFile.stdout()).toContain('AGENTS.md and CLAUDE.md are one file holding only the stet agent-guidance block');
    expect(oneFile.exists('AGENTS.md')).toBe(true); // neither deleted, so neither link dangles
    expect(oneFile.exists('CLAUDE.md')).toBe(true);

    // And when that one file carries host text too, the plan names it ONCE:
    // both names reach the same removal, and printing it twice would read as
    // two files' worth of change against a host that has one.
    const twice = makeAdoptionHost();
    twice.write('AGENTS.md', house);
    expect(await twice.run('init', '--yes')).toBe(0);
    symlinkSync(join(twice.cwd, 'AGENTS.md'), join(twice.cwd, 'CLAUDE.md'));
    expect(await twice.run('eject')).toBe(0);
    const removals = twice.out.filter((line) => line.includes('remove the stet agent-guidance block'));
    expect(removals).toHaveLength(1);

    // The same, through a HARDLINK rather than a symlink — two directory
    // entries with different resolved paths and one inode. Comparing resolved
    // paths does not fold this, so the plan promised two removals while the
    // write did one: the second pass found the block already gone.
    const hard = makeAdoptionHost();
    hard.write('AGENTS.md', house);
    expect(await hard.run('init', '--yes')).toBe(0);
    linkSync(join(hard.cwd, 'AGENTS.md'), join(hard.cwd, 'CLAUDE.md'));
    expect(await hard.run('eject')).toBe(0);
    expect(hard.out.filter((line) => line.includes('remove the stet agent-guidance block'))).toHaveLength(1);

    // A SECOND NAME for a file eject already cleans is not a moved block. The
    // backstop excludes its own two files by identity, not by name string — a
    // name compare reports this alias (and, on a case-insensitive filesystem,
    // a `Claude.md` spelling) as a block eject left behind, which is a false
    // alarm about the file it just removed.
    const alias = makeAdoptionHost();
    expect(await alias.run('init', '--yes')).toBe(0);
    alias.write('docs/keep.md', '# Docs\n');
    symlinkSync(join(alias.cwd, 'CLAUDE.md'), join(alias.cwd, 'docs/alias.md'));
    expect(await alias.run('eject')).toBe(0);
    expect(alias.stdout()).not.toContain('docs/alias.md');

    // A block the host later HID behind an unclosed fence is named, not
    // silently left: the span walk cannot reach it, and an `absent` here would
    // leave the file instructing agents toward a dependency that is gone.
    const hidden = makeAdoptionHost();
    hidden.write('CLAUDE.md', house);
    expect(await hidden.run('init', '--yes')).toBe(0);
    hidden.write('CLAUDE.md', `# Docs\n\n\`\`\`\n${hidden.file('CLAUDE.md')}`);
    expect(await hidden.run('eject', '--write')).toBe(1);
    expect(hidden.stderr()).toContain('CLAUDE.md: it ends inside an unclosed code fence');

    // A removal that CANNOT happen is reported as one, never claimed. The
    // guidance step runs before the dependency drop, so a failure here leaves
    // the worst state a re-run can heal.
    const readOnly = makeAdoptionHost();
    readOnly.write('CLAUDE.md', house);
    expect(await readOnly.run('init', '--yes')).toBe(0);
    const held = readOnly.file('CLAUDE.md');
    chmodSync(join(readOnly.cwd, 'CLAUDE.md'), 0o444);
    try {
      // NONZERO: exiting 0 while a file still instructs agents toward the
      // dependency eject just removed is the false-success class.
      expect(await readOnly.run('eject', '--write')).toBe(1);
      expect(readOnly.stderr()).toContain('CLAUDE.md: could not remove the stet agent-guidance block');
      // and NO line claiming the removal happened
      expect(readOnly.stdout()).not.toContain('remove the stet agent-guidance block from CLAUDE.md (3 lines)');
      expect(readOnly.file('CLAUDE.md')).toBe(held);
      // the rest of eject still completed
      expect(JSON.parse(readOnly.file('package.json')).dependencies?.['@getstet/stet']).toBeUndefined();
    } finally {
      chmodSync(join(readOnly.cwd, 'CLAUDE.md'), 0o644);
    }

    // A stale doc symlink is walked past, not thrown on — the marker probe is a
    // report channel and must never abort the run.
    const stale = makeAdoptionHost();
    expect(await stale.run('init', '--yes')).toBe(0);
    symlinkSync(join(stale.cwd, 'docs/gone.md'), join(stale.cwd, 'notes.md'));
    expect(await stale.run('eject')).toBe(0);

    // An edited span still leaves — its size and its provenance are printed
    // first, and the run is --write-gated — but a file whose bytes are not utf8
    // is REPORTED instead, because removing means writing it back and a utf8
    // round trip would replace every undecodable byte with U+FFFD.
    const odd = makeAdoptionHost();
    expect(await odd.run('init', '--yes')).toBe(0);
    const latin1 = Buffer.concat([
      Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a, 0x0a]), // `# Café\n\n` in windows-1252
      Buffer.from(odd.file('AGENTS.md'), 'utf8'),
    ]);
    writeFileSync(join(odd.cwd, 'CLAUDE.md'), latin1);
    // Nonzero: the block is still in that file after eject, which is the state
    // the exit code has to be honest about.
    expect(await odd.run('eject', '--write')).toBe(1);
    expect(odd.stderr()).toContain('CLAUDE.md: it is not utf8 text');
    expect(readFileSync(join(odd.cwd, 'CLAUDE.md')).equals(latin1)).toBe(true);

    // A dialect host's parse refusals collapse to one count line rather than
    // burying the plan they print beside, and `--verbose` restores the list.
    // The host keeps a stet-importing surface on purpose: with no importer the
    // compiler-less probe skips the un-rewrite loop whole and no refusal would
    // print at all.
    const wall = makeAdoptionHost();
    expect(await wall.run('init', '--yes')).toBe(0);
    expect(await wall.run('register', '--from', 'scan', '--write')).toBe(0);
    const wallConfig = JSON.parse(wall.file('stet.config.json'));
    for (let i = 0; i < 5; i++) {
      wall.write(`src/pages/p${i}.astro`, '---\nconst t = 1;\n---\n<h1>Chapter</h1>\n');
    }
    wall.write(
      'stet.config.json',
      JSON.stringify(
        { ...wallConfig, managedSurfaces: [...wallConfig.managedSurfaces, 'src/pages/**/*.astro'] },
        null,
        2,
      ),
    );
    const beforeWall = wall.out.length;
    expect(await wall.run('eject')).toBe(0);
    const walled = wall.out.slice(beforeWall);
    expect(walled.join('\n')).toContain(
      '5 file(s) could not be parsed cleanly — not un-rewritten ' +
        '(the backstop refuses the dep drop if they still import stet); run with --verbose to list them',
    );
    expect(walled.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toEqual([]);
    // The rest of the plan is untouched — the collapse replaces the wall, not
    // the manifest around it.
    expect(walled.join('\n')).toContain('stays (no stet imports):');
    expect(walled.join('\n')).toContain('drop the stet dependency from package.json');

    const beforeWallVerbose = wall.out.length;
    expect(await wall.run('eject', '--verbose')).toBe(0);
    const wallListed = wall.out.slice(beforeWallVerbose);
    expect(wallListed.filter((l) => /^src\/pages\/p\d\.astro: could not be parsed/.test(l))).toHaveLength(5);
    expect(wallListed.join('\n')).not.toContain('run with --verbose to list them');

    // On the static-HTML host there is nothing to un-rewrite, unwrap or delete:
    // the marks are the whole install.
    const html = await makeHtmlHost({ register: true, git: true });
    expect(await html.run('agents', 'install')).toBe(0);
    expect(await html.run('hook', 'install')).toBe(0);
    html.out.length = 0;
    html.err.length = 0;
    // Plan-only touches nothing.
    const beforePlan = html.file('index.html');
    expect(await html.run('eject')).toBe(0);
    expect(html.stdout()).toContain('document: index.html — every mark removed, the text stays');
    expect(html.stdout()).not.toContain('un-rewrite');
    expect(html.file('index.html')).toBe(beforePlan);

    html.out.length = 0;
    expect(await html.run('eject', '--write')).toBe(0);
    expect(/data-stet/.test(html.file('index.html'))).toBe(false);
    expect(html.file('index.html')).toBe(htmlFixture('index.html'));
    expect(html.exists('AGENTS.md')).toBe(false);
    expect(html.exists('.git/hooks/pre-commit')).toBe(false);
    expect(html.file('package.json')).not.toContain('@getstet/stet');
    expect(html.stdout()).toContain(
      'stays (no stet imports): stet.config.json, content/descriptor.json, content/defaults.json',
    );
  });

  it('Requirement: hook install adds the pre-commit gate, opt-in and executable', async () => {
    const host = makeAdoptionHost();
    execFileSync('git', ['init', '-q'], { cwd: host.cwd });
    expect(await host.run('hook', 'install')).toBe(0);
    const hookPath = join(host.cwd, '.git/hooks/pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(statSync(hookPath).mode & 0o111).not.toBe(0); // executable
    expect(host.file('.git/hooks/pre-commit')).toContain('stet check');
    // a differing existing hook is refused, not clobbered
    host.write('.git/hooks/pre-commit', '#!/bin/sh\necho custom\n');
    expect(await host.run('hook', 'install')).toBe(1);
    expect(host.file('.git/hooks/pre-commit')).toContain('echo custom');
  });
});

describe('mount', () => {
  it('Requirement: One authenticated catch-all handler mounts the API', async () => {
    const TOKEN_ENV = 'STET_CONF_MOUNT_TOKEN';
    process.env[TOKEN_ENV] = 'sekret';
    try {
      const published: PublishEvent[] = [];
      const calls: string[] = [];
      const store: StoreAdapter = {
        project: 'test',
        canApplyDDL: false,
        read: async () => [],
        saveDraft: async () => ({ draftId: 1 }),
        publish: async () => {
          calls.push('publish');
          return { versionId: 7 };
        },
        revert: async () => ({ versionId: 8 }),
        rename: async () => ({ renamed: true }),
        history: async () => ({ rows: [], nextBeforeId: null }),
        recent: async () => ({ rows: [], nextBeforeId: null }),
        // This fake groups nothing, so it answers the capability the way any
        // adapter that cannot honors it — and the routes 501 rather than lie.
        changesets: createSnapshotStore({ project: 'test' }).changesets,
      };
      const handler = createStetHandler({
        store,
        descriptor,
        auth: TOKEN_ENV,
        renderEmail: async () => '<p>proxied</p>',
        onPublish: (event) => {
          published.push(event);
        },
      });
      const authed = { authorization: 'Bearer sekret', 'content-type': 'application/json' };

      // a wrong Bearer is 401 before any store call
      const denied = await handler.GET(
        new Request('https://h/api/stet/keys', { headers: { authorization: 'Bearer wrong' } }),
      );
      expect(denied.status).toBe(401);
      expect(calls).toHaveLength(0);

      // a valid publish delegates to the store RPC and fires onPublish with the key's target
      const key = Object.keys(descriptor.keys)[0]!;
      const publishResponse = await handler.POST(
        new Request('https://h/api/stet/publish', {
          method: 'POST',
          headers: authed,
          body: JSON.stringify({ key, editor: 'ed' }),
        }),
      );
      expect(publishResponse.status).toBe(200);
      expect(calls).toContain('publish');
      expect(published).toHaveLength(1);
      expect(published[0]?.target).toBe(descriptor.keys[key]?.target);

      // the GET render path proxies the host renderEmail rather than rendering itself.
      // The fixture MUST carry a template — a guard that silently skipped this
      // scenario would let a future fixture change drop it unnoticed.
      const template = Object.keys(descriptor.templates ?? {})[0];
      if (template === undefined) {
        throw new Error('the mount render-proxy scenario needs a template in the fixture descriptor');
      }
      const rendered = await handler.GET(
        new Request(`https://h/api/stet/render?template=${template}&version=1`, {
          headers: { authorization: 'Bearer sekret' },
        }),
      );
      expect(rendered.status).toBe(200);
      expect(await rendered.text()).toContain('proxied');

      // The changeset routes delegate to the capability by the same pattern.
      // This store's capability answers NotSupported, so each route returns 501
      // NAMING the method — the capability's absence is a 501, never a lie, and
      // never a pretended success.
      for (const [path, sent] of [
        ['changes', { name: 'a change', editor: 'ed' }],
        ['schedule-change', { change: 1, editor: 'ed', publishAt: null }],
        ['publish-change', { change: 1, editor: 'ed' }],
        ['revert-change', { change: 1, editor: 'ed' }],
        ['discard', { key, editor: 'ed' }],
        ['abandon-change', { change: 1, editor: 'ed' }],
      ] as [string, unknown][]) {
        const res = await handler.POST(
          new Request(`https://h/api/stet/${path}`, {
            method: 'POST',
            headers: authed,
            body: JSON.stringify(sent),
          }),
        );
        expect({ path, status: res.status }).toEqual({ path, status: 501 });
        expect({ path, named: ((await res.json()) as { error: string }).error.includes('changesets.') }).toEqual({
          path,
          named: true,
        });
      }
      const listed = await handler.GET(
        new Request('https://h/api/stet/changes', { headers: { authorization: 'Bearer sekret' } }),
      );
      expect(listed.status).toBe(501);

      // A write with no editor is rejected BEFORE the store — the changeset
      // routes included, even where the store records no author column.
      const noEditor = await handler.POST(
        new Request('https://h/api/stet/publish-change', {
          method: 'POST',
          headers: authed,
          body: JSON.stringify({ change: 1 }),
        }),
      );
      expect(noEditor.status).toBe(400);

      // schedule-change: absence is a 400, never read as cancel.
      const absentStamp = await handler.POST(
        new Request('https://h/api/stet/schedule-change', {
          method: 'POST',
          headers: authed,
          body: JSON.stringify({ change: 1, editor: 'ed' }),
        }),
      );
      expect(absentStamp.status).toBe(400);
    } finally {
      delete process.env[TOKEN_ENV];
    }
  });
});

/**
 * email-custody: the bulk-adoption pair. Every case drives `runCli`, so the
 * two-token dispatch, the argument split and the exit codes are part of what is
 * being proven — and the verify cases run against a real git repository,
 * because the before comes from HEAD or it does not come at all.
 */
describe('email-custody', () => {
  const WALK = 'lib/email/templates/*.ts';

  const BASE = "export const baseTemplate = (inner: string): string => `<html><body>${inner}</body></html>`;\n";
  const WELCOME =
    "import { baseTemplate } from '../base';\n" +
    'export interface WelcomeProps {\n  name: string;\n}\n' +
    'export function welcome(props: WelcomeProps): { subject: string; html: string } {\n' +
    '  return {\n' +
    '    subject: `Welcome, ${props.name}`,\n' +
    '    html: baseTemplate(`<h1>Good to see you, ${props.name}</h1>`),\n' +
    '  };\n' +
    '}\n';

  interface EmailProject {
    cwd: string;
    run(...argv: string[]): Promise<number>;
    stdout(): string;
    stderr(): string;
    file(rel: string): string;
    put(rel: string, text: string): void;
  }

  /** A stet project that is also a git repo with a working `node_modules`. */
  function emailProject(
    templates: Record<string, string>,
    descriptor: unknown = { version: 1, keys: {}, templates: {} },
  ): EmailProject {
    const host = makeEmailHost();
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { cwd: host.dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
    host.put('stet.config.json', `${JSON.stringify({ project: 't', managedSurfaces: [], emailSurfaces: [] }, null, 2)}\n`);
    host.put('content/descriptor.json', `${JSON.stringify(descriptor, null, 2)}\n`);
    host.put('content/defaults.json', '{"default":{}}\n');
    host.put('.gitignore', 'node_modules\n');
    host.put('lib/email/base.ts', BASE);
    for (const [rel, text] of Object.entries(templates)) host.put(rel, text);
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: host.dir, stdio: 'pipe' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'stet test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');
    return {
      cwd: host.dir,
      run: (...argv: string[]) => runCli(argv, io),
      stdout: () => out.join('\n'),
      stderr: () => err.join('\n'),
      file: (rel: string) => readFileSync(join(host.dir, rel), 'utf8'),
      put: host.put,
    };
  }

  it("Requirement: extract proposes a template's whole declaration, mechanically", async () => {
    const host = emailProject({ 'lib/email/templates/welcome.ts': WELCOME });
    expect(await host.run('email', 'extract', WALK)).toBe(0);

    const printed = host.stdout();
    // The whole declaration: the entry with its review markers, one slot per
    // text run with the lifted variable, the key definitions and the pointer.
    expect(printed).toContain('class: transactional — review');
    expect(printed).toContain('welcome__subject: "Welcome, {{name}}"');
    expect(printed).toContain('vars name');
    expect(printed).toContain('sampleProps {"name":"sample-name"}');
    // …and the shell rewrite, as a diff.
    expect(printed).toContain('+++ b/lib/email/templates/welcome.ts');
    // Nothing was written without --apply.
    expect(host.file('lib/email/templates/welcome.ts')).toBe(WELCOME);
    expect(JSON.parse(host.file('content/descriptor.json')).templates).toEqual({});
  });

  it('Requirement: A file extract cannot handle is skipped and reported, and hand-written entries are first-class', async () => {
    const host = emailProject({
      'lib/email/templates/welcome.ts': WELCOME,
      'lib/email/templates/rich.ts':
        'export function rich(): string {\n  return `<p>Hello <strong>Ada</strong>, welcome</p>`;\n}\n',
    });
    // Proposals-with-skips is exit 0: a skip is a report, not a failure.
    expect(await host.run('email', 'extract', WALK)).toBe(0);
    expect(host.stderr()).toContain('skipped (interleaved-markup)');
    expect(host.stderr()).toContain('declare this template by hand');
    expect(host.stdout()).toContain('welcome (lib/email/templates/welcome.ts)');
  });

  it('Requirement: --apply writes the proposals through plan-then-apply, atomically per run', async () => {
    const host = emailProject({ 'lib/email/templates/welcome.ts': WELCOME });
    expect(await host.run('email', 'extract', WALK, '--apply')).toBe(0);

    const descriptor = JSON.parse(host.file('content/descriptor.json'));
    expect(descriptor.templates.welcome.render.export).toBe('welcome');
    expect(descriptor.keys.welcome__subject.vars).toEqual(['name']);
    expect(JSON.parse(host.file('content/defaults.json')).default.welcome__subject).toBe('Welcome, {{name}}');
    expect(host.file('content/keys.ts')).toContain('welcome__subject');
    expect(host.file('lib/email/templates/welcome.ts')).toContain('props.welcome__subject');
    // Both surface lists carry the walked glob, and the next step is printed.
    const surfaces = JSON.parse(host.file('stet.config.json'));
    expect(surfaces.emailSurfaces).toEqual([WALK]);
    expect(surfaces.managedSurfaces).toEqual([WALK]);
    expect(host.stdout()).toContain('next: stet email verify');
  });

  it('Requirement: verify proves custody by rendered-output byte equality', async () => {
    const host = emailProject({ 'lib/email/templates/welcome.ts': WELCOME });
    expect(await host.run('email', 'extract', WALK, '--apply')).toBe(0);
    // The committed original against the shell extract just wrote.
    expect(await host.run('email', 'verify')).toBe(0);
    expect(host.stdout()).toContain('welcome: PASS');

    // A hand edit to the markup around the slot changes the render, and verify
    // fails naming it — the exit moves, because custody is a gate.
    host.put(
      'lib/email/templates/welcome.ts',
      host.file('lib/email/templates/welcome.ts').replace('<h1>', '<h2>').replace('</h1>', '</h2>'),
    );
    expect(await host.run('email', 'verify')).toBe(1);
    expect(host.stderr()).toContain('welcome: FAIL');
  });

  it('Requirement: --capture supplies the before where git cannot', async () => {
    const host = emailProject(
      {},
      {
        version: 1,
        keys: { welcome__headline: { shape: 'text', target: 'html-email' } },
        templates: {
          welcome: {
            class: 'transactional',
            trigger: 'manual',
            slots: ['headline'],
            render: { file: 'lib/email/templates/welcome.ts', export: 'welcome', sampleProps: {} },
          },
        },
      },
    );
    host.put('content/defaults.json', `${JSON.stringify({ default: { welcome__headline: 'Good to see you' } })}\n`);
    // Written after the commit: new in the working tree, absent from HEAD.
    host.put(
      'lib/email/templates/welcome.ts',
      'export function welcome(): string {\n  return `<h1>Good to see you</h1>`;\n}\n',
    );

    // Absence of a baseline is a FAILURE, never a pass.
    expect(await host.run('email', 'verify')).toBe(1);
    expect(host.stderr()).toContain('--capture');

    expect(await host.run('email', 'verify', '--capture')).toBe(0);
    expect(JSON.parse(host.file('.stet/email-fixtures/welcome.json')).result).toContain('Good to see you');

    // The custody rewrite, then the proof against the captured baseline.
    host.put(
      'lib/email/templates/welcome.ts',
      'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return `<h1>${props.welcome__headline}</h1>`;\n' +
        '}\n',
    );
    expect(await host.run('email', 'verify')).toBe(0);
    expect(host.stdout()).toContain('welcome: PASS');
  });
});

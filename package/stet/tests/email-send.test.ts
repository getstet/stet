/**
 * `stet email render` and `stet email test`, driven through `runCli` against a
 * temp host with a real declared template.
 *
 * Both commands render through the one runner (`renderTemplate`) with the
 * pointer's request, so what is proved here is what only the commands own: which
 * values reach the props (the draft, the locale), what is written where, and the
 * refusals that must happen before any host code runs. The host's send function
 * is a fixture that records its argument in a file — no provider is ever called.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { loadConfig } from '../cli/config.js';
import { runCli, type CliIo } from '../cli/main.js';
import type { StoreAdapter } from '../src/index.js';
import { cleanupEmailHosts, makeEmailHost, type EmailHost } from './helpers/email-host.js';

afterAll(cleanupEmailHosts);

interface Run {
  code: number;
  out: string[];
  err: string;
}

interface Built {
  host: EmailHost;
  /** Written by the template each time it renders. */
  renderMark: string;
  /** Written by the send fixture with the message it was handed. */
  sentMark: string;
  run(...argv: string[]): Promise<Run>;
}

interface BuildOptions {
  store?: StoreAdapter;
  /** `false` leaves the template without a render pointer. */
  pointer?: boolean;
  /** The config's `emailSend`, or `null` to declare none. */
  emailSend?: { file: string; export: string } | null;
  /** The send fixture's source, given the file it records into. */
  sendSource?: (sentMark: string) => string;
  /** The template's source, given the file it marks each render in. */
  templateSource?: (renderMark: string) => string;
  snapshot?: Record<string, Record<string, string>>;
  /** The render pointer's `sampleProps`, which fill a slot's `{{variable}}`. */
  sampleProps?: Record<string, unknown>;
  /** Extra `stet.config.json` members, and the stores injected under their environment names. */
  config?: Record<string, unknown>;
  stores?: Record<string, StoreAdapter>;
}

const KEY = { shape: 'text', target: 'html-email' } as const;

function build(opts: BuildOptions = {}): Built {
  const host = makeEmailHost();
  const renderMark = host.path('rendered');
  const sentMark = host.path('sent.json');
  const pointer = { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: opts.sampleProps ?? {} };
  host.put(
    'content/descriptor.json',
    `${JSON.stringify({
      version: 1,
      keys: { welcome__headline: KEY, welcome__subject: KEY },
      templates: {
        welcome: {
          class: 'transactional',
          trigger: 'manual',
          slots: ['headline', 'subject'],
          ...(opts.pointer === false ? {} : { render: pointer }),
        },
      },
    })}\n`,
  );
  host.put(
    'content/defaults.json',
    `${JSON.stringify(opts.snapshot ?? { default: { welcome__headline: 'Welcome', welcome__subject: 'Welcome aboard' } })}\n`,
  );
  host.put(
    'lib/email/welcome.ts',
    (opts.templateSource ?? defaultTemplate)(renderMark),
  );
  host.put('lib/email/stet-send.ts', (opts.sendSource ?? recordSend)(sentMark));
  const emailSend = opts.emailSend === undefined ? { file: 'lib/email/stet-send.ts', export: 'sendTest' } : opts.emailSend;
  host.put(
    'stet.config.json',
    `${JSON.stringify({
      project: 'default',
      managedSurfaces: [],
      emailSurfaces: [],
      ...(opts.store === undefined ? {} : { store: { adapter: 'memory' } }),
      ...opts.config,
      ...(emailSend === null ? {} : { emailSend }),
    })}\n`,
  );

  return {
    host,
    renderMark,
    sentMark,
    run: async (...argv: string[]): Promise<Run> => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        cwd: host.dir,
        env: {},
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
        ...(opts.store === undefined ? {} : { store: opts.store }),
        ...(opts.stores === undefined ? {} : { stores: opts.stores }),
      };
      const code = await runCli(argv, io);
      return { code, out, err: err.join('\n') };
    },
  };
}

function defaultTemplate(renderMark: string): string {
  return (
    'export function welcome(props: { welcome__headline: string }): string {\n' +
    `  require('node:fs').writeFileSync(${JSON.stringify(renderMark)}, 'x');\n` +
    "  return '<h1>' + props.welcome__headline + '</h1>';\n" +
    '}\n'
  );
}

function recordSend(sentMark: string): string {
  return (
    'export function sendTest(message: unknown): void {\n' +
    `  require('node:fs').writeFileSync(${JSON.stringify(sentMark)}, JSON.stringify(message));\n` +
    '}\n'
  );
}

/** A draft of the headline in the build's memory store, written through the real command. */
async function draftHeadline(built: Built, value: string): Promise<void> {
  const drafted = await built.run('draft', 'welcome__headline', `--value=${value}`, '--editor', 'neil');
  expect(drafted.code).toBe(0);
}

describe('email render — the email as it would be sent (D5)', () => {
  it('writes the draft into --out and names the subject on stderr (journey E24)', async () => {
    const built = build({ store: createMemoryStore({ project: 'default' }) });
    await draftHeadline(built, 'Draft words');
    const outFile = join(built.host.dir, 'welcome.html');

    const result = await built.run('email', 'render', 'welcome', '--draft', '--out', outFile);

    expect(result.code).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toBe('<h1>Draft words</h1>');
    expect(result.err).toBe('subject: Welcome aboard');
    expect(result.out).toEqual([]);
  });

  it('applies the draft only with --draft, on a store-backed site', async () => {
    const built = build({ store: createMemoryStore({ project: 'default' }) });
    await draftHeadline(built, 'Draft words');

    const withDraft = await built.run('email', 'render', 'welcome', '--draft');
    const without = await built.run('email', 'render', 'welcome');

    expect(withDraft.out).toEqual(['<h1>Draft words</h1>']);
    expect(without.out).toEqual(['<h1>Welcome</h1>']);
  });

  it('writes the html alone to stdout without --out', async () => {
    const built = build();

    const result = await built.run('email', 'render', 'welcome');

    expect(result.code).toBe(0);
    expect(result.out).toEqual(['<h1>Welcome</h1>']);
    expect(result.err).toBe('');
  });

  it('exits 1 for a template without a render pointer', async () => {
    const built = build({ pointer: false });

    const result = await built.run('email', 'render', 'welcome');

    expect(result.code).toBe(1);
    expect(result.err).toContain('welcome has no render pointer — declare one, or render it through the host');
    expect(result.out).toEqual([]);
  });

  it('renders the locale asked for, the default where it has no value of its own', async () => {
    const built = build({
      snapshot: {
        default: { welcome__headline: 'Welcome', welcome__subject: 'Welcome aboard' },
        fr: { welcome__headline: 'Bienvenue' },
      },
      config: { locales: { default: 'default', enabled: ['default', 'fr'] } },
    });
    const outFile = join(built.host.dir, 'welcome.html');

    const result = await built.run('email', 'render', 'welcome', '--locale', 'fr', '--out', outFile);

    expect(result.code).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toBe('<h1>Bienvenue</h1>');
    expect(result.err).toBe('subject: Welcome aboard');
  });

  it('keeps stdout to the html alone under --env', async () => {
    const staging = createMemoryStore({ project: 'default' });
    const built = build({
      store: createMemoryStore({ project: 'default' }),
      stores: { staging },
      config: { environments: { staging: { adapter: 'memory' } } },
    });

    const result = await built.run('email', 'render', 'welcome', '--env', 'staging');

    expect(result.code).toBe(0);
    expect(result.out).toEqual(['<h1>Welcome</h1>']);
  });

  it('prefers a string map’s subject member to the subject slot', async () => {
    const built = build({
      templateSource: () =>
        "export function welcome(props: { welcome__headline: string }): { subject: string; html: string } {\n" +
        "  return { subject: 'From the map', html: '<h1>' + props.welcome__headline + '</h1>' };\n" +
        '}\n',
    });
    const outFile = join(built.host.dir, 'welcome.html');

    const result = await built.run('email', 'render', 'welcome', '--out', outFile);

    expect(result.code).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toBe('<h1>Welcome</h1>');
    expect(result.err).toBe('subject: From the map');
  });

  it('refuses a draft read when the store does not answer, and renders nothing', async () => {
    const store = createMemoryStore({ project: 'default' });
    const built = build({ store });
    store.failNext = 'read';

    const result = await built.run('email', 'render', 'welcome', '--draft');

    expect(result.code).toBe(1);
    expect(result.err).toContain('email render needs the configured store and it did not answer');
    expect(result.out).toEqual([]);
    expect(existsSync(built.renderMark)).toBe(false);
  });

  it('fills a variable in the subject slot before naming it (F2)', async () => {
    const built = build({
      snapshot: { default: { welcome__headline: 'Welcome', welcome__subject: 'Welcome {{name}}' } },
      sampleProps: { name: 'Neil' },
    });
    const outFile = join(built.host.dir, 'welcome.html');

    const result = await built.run('email', 'render', 'welcome', '--out', outFile);

    expect(result.code).toBe(0);
    expect(result.err).toBe('subject: Welcome Neil');
  });

  it('gives the locale’s own subject where its snapshot carries one (F3b)', async () => {
    const built = build({
      snapshot: {
        default: { welcome__headline: 'Welcome', welcome__subject: 'Welcome aboard' },
        fr: { welcome__headline: 'Bienvenue', welcome__subject: 'Bienvenue à bord' },
      },
      config: { locales: { default: 'default', enabled: ['default', 'fr'] } },
    });
    const outFile = join(built.host.dir, 'welcome.html');

    const result = await built.run('email', 'render', 'welcome', '--locale', 'fr', '--out', outFile);

    expect(result.code).toBe(0);
    expect(result.err).toBe('subject: Bienvenue à bord');
  });

  it('refuses a template name that is an Object.prototype member (F4)', async () => {
    for (const name of ['constructor', '__proto__']) {
      const built = build();

      const result = await built.run('email', 'render', name);

      expect(result.code).toBe(1);
      expect(result.err).toContain(`${name} is not a template in the descriptor`);
      expect(existsSync(built.renderMark)).toBe(false);
    }
  });

  it('exits 1 for a template the descriptor does not declare', async () => {
    const built = build();

    const result = await built.run('email', 'render', 'nothing-like-it');

    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing-like-it');
    expect(existsSync(built.renderMark)).toBe(false);
  });
});

describe('email test — send through the host’s function (D5)', () => {
  it('hands the rendered email to the host function on a snapshot-only site (journey E24)', async () => {
    const built = build();

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(0);
    expect(result.out).toEqual(['sent welcome to neil@example.com']);
    expect(JSON.parse(readFileSync(built.sentMark, 'utf8'))).toEqual({
      to: 'neil@example.com',
      subject: 'Welcome aboard',
      html: '<h1>Welcome</h1>',
      template: 'welcome',
    });
  });

  it('sends the draft with --draft', async () => {
    const built = build({ store: createMemoryStore({ project: 'default' }) });
    await draftHeadline(built, 'Draft words');

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com', '--draft');

    expect(result.code).toBe(0);
    expect((JSON.parse(readFileSync(built.sentMark, 'utf8')) as { html: string }).html).toBe('<h1>Draft words</h1>');
  });

  it('sends the active words without --draft while a draft exists (F3a)', async () => {
    const built = build({ store: createMemoryStore({ project: 'default' }) });
    await draftHeadline(built, 'Draft words');

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(0);
    expect((JSON.parse(readFileSync(built.sentMark, 'utf8')) as { html: string }).html).toBe('<h1>Welcome</h1>');
  });

  it('hands the host the subject with its variables filled (F2)', async () => {
    const built = build({
      snapshot: { default: { welcome__headline: 'Welcome', welcome__subject: 'Welcome {{name}}' } },
      sampleProps: { name: 'Neil' },
    });

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(0);
    expect((JSON.parse(readFileSync(built.sentMark, 'utf8')) as { subject: string }).subject).toBe('Welcome Neil');
  });

  it('sends nothing for a template that renders a map with no html member (D29)', async () => {
    const built = build({
      templateSource: () => "export function welcome(): { subject: string; body: string } {\n  return { subject: 'S', body: '<p/>' };\n}\n",
    });

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(1);
    expect(result.err).toContain('no html member');
    expect(existsSync(built.sentMark)).toBe(false);
    expect(result.out.some((line) => line.startsWith('sent'))).toBe(false);
  });

  it('refuses an emailSend export that is an Object.prototype member, and sends nothing (F3c)', async () => {
    for (const name of ['constructor', '__proto__']) {
      const built = build({ emailSend: { file: 'lib/email/stet-send.ts', export: name } });

      const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

      expect(result.code).toBe(1);
      expect(result.err).toContain('is not a function');
      expect(existsSync(built.sentMark)).toBe(false);
    }
  });

  it('exits 1 naming emailSend where the config declares none, and renders nothing', async () => {
    const built = build({ emailSend: null });

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(1);
    expect(result.err).toContain('stet email test needs emailSend in stet.config.json — the host function that sends one email');
    expect(existsSync(built.renderMark)).toBe(false);
    expect(existsSync(built.sentMark)).toBe(false);
  });

  it('refuses a CR or LF in --to before any render', async () => {
    for (const to of ['a@example.com\r\nBcc: b@example.com', 'a@example.com\nBcc: b@example.com']) {
      const built = build();

      const result = await built.run('email', 'test', 'welcome', '--to', to);

      expect(result.code).toBe(1);
      expect(result.err).toContain('recipient must not contain a newline');
      expect(existsSync(built.renderMark)).toBe(false);
      expect(existsSync(built.sentMark)).toBe(false);
    }
  });

  it('exits 1 with the host’s error when the send function throws (send-failed)', async () => {
    const built = build({
      sendSource: () => "export function sendTest(): void {\n  throw new Error('smtp is down');\n}\n",
    });

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(1);
    expect(result.err).toContain('smtp is down');
    expect(result.out).toEqual([]);
  });

  it('exits 1 with the host’s error when the send function rejects', async () => {
    const built = build({
      sendSource: () => "export async function sendTest(): Promise<void> {\n  await 0;\n  throw new Error('quota exceeded');\n}\n",
    });

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(1);
    expect(result.err).toContain('quota exceeded');
    expect(result.out).toEqual([]);
  });

  it('is a usage error without --to', async () => {
    const built = build();

    const result = await built.run('email', 'test', 'welcome');

    expect(result.code).toBe(2);
    expect(result.err).toContain('--to');
    expect(existsSync(built.renderMark)).toBe(false);
  });

  it('runs nothing of a send file outside the project (F3)', async () => {
    const outside = makeEmailHost({ deps: [] });
    const mark = outside.path('loaded');
    outside.put('send.ts', `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x');\nexport function sendTest(): void {}\n`);
    const rel = `../${outside.dir.split('/').pop()}/send.ts`;
    const built = build({ emailSend: { file: rel, export: 'sendTest' } });

    const result = await built.run('email', 'test', 'welcome', '--to', 'neil@example.com');

    expect(result.code).toBe(1);
    expect(result.err).toContain(`${rel} is outside the project — a render pointer names a file inside it`);
    expect(existsSync(mark)).toBe(false);
    expect(existsSync(built.renderMark)).toBe(false);
  });
});

describe('emailSend in stet.config.json', () => {
  function configWith(emailSend: unknown): string {
    const host = makeEmailHost();
    writeFileSync(join(host.dir, 'stet.config.json'), JSON.stringify({ project: 't', emailSend }));
    return host.dir;
  }

  it('reads a file and an export', () => {
    expect(loadConfig(configWith({ file: 'lib/send.ts', export: 'sendTest' })).emailSend).toEqual({
      file: 'lib/send.ts',
      export: 'sendTest',
    });
  });

  it('refuses an entry that lacks either, and one that is not an object', () => {
    expect(() => loadConfig(configWith({ file: 'lib/send.ts' }))).toThrow(/emailSend/);
    expect(() => loadConfig(configWith({ export: 'sendTest' }))).toThrow(/emailSend/);
    expect(() => loadConfig(configWith('lib/send.ts'))).toThrow(/emailSend/);
  });
});

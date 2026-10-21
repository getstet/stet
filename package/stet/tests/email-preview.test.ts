/**
 * The dashboard's email preview: `markSlots` over markup, and
 * `POST /api/site/email-preview` over a host with a declared template.
 *
 * The route renders through the one render path the CLI uses, so what is
 * proved here is what the preview adds: the values (drafts over the snapshot or
 * the store's drafts), the sentinels each slot value is wrapped in, where
 * `markSlots` keeps them as `data-stet` spans and where it removes them, and the
 * refusals that must happen before the runner is spawned. The stage-5 cases
 * (S1–S3) are named in their titles.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../adapters/store-memory.js';
import { markSlots, stripSlotMarks } from '../cli/email-preview.js';
import { cleanupEmailHosts } from './helpers/email-host.js';
import { cleanupOutsideFiles, linkOut, outsideFile, previewHost, type PreviewHost } from './helpers/email-preview-host.js';
import { handlerOver, req } from './helpers/dashboard-page.js';

afterAll(cleanupEmailHosts);
afterAll(cleanupOutsideFiles);

/** The sentinel run a slot value is wrapped in before rendering (design D12). */
const run = (index: number, value: string): string => `\uE000${index}\uE001${value}\uE002`;
const SENTINELS = /[\uE000-\uE002]/;

describe('markSlots', () => {
  const keys = ['t__headline', 't__subject'];

  it('turns a run in an element’s text into a span carrying its slot', () => {
    expect(markSlots(`<html><body><h1>${run(0, 'Hello')}</h1></body></html>`, keys)).toBe(
      '<html><body><h1><span data-stet="t__headline">Hello</span></h1></body></html>',
    );
  });

  it('leaves markup with no run byte for byte', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body><p>Hi &amp; bye</p><br></body></html>';
    expect(markSlots(html, keys)).toBe(html);
  });

  it('keeps the value and drops the marker inside an attribute (a slot in an href and an alt)', () => {
    const out = markSlots(`<html><body><a href="https://x.test/${run(0, 'abc')}">go</a><img alt="${run(1, 'logo')}"></body></html>`, keys);
    expect(out).toBe('<html><body><a href="https://x.test/abc">go</a><img alt="logo"></body></html>');
  });

  it('keeps the value and drops the marker inside <title>, and inside <textarea>', () => {
    const out = markSlots(`<html><head><title>${run(1, 'Subject')}</title></head><body><textarea>${run(0, 'draft')}</textarea></body></html>`, keys);
    expect(out).toBe('<html><head><title>Subject</title></head><body><textarea>draft</textarea></body></html>');
  });

  it('keeps the value and drops the marker inside <style>, <script> and a comment', () => {
    const out = markSlots(
      `<html><head><style>.a:after{content:"${run(0, 'X')}"}</style></head><body>` +
        `<script>var s = "${run(1, 'Y')}";</script><!-- ${run(0, 'Z')} --><p>ok</p></body></html>`,
      keys,
    );
    expect(out).toBe(
      '<html><head><style>.a:after{content:"X"}</style></head><body><script>var s = "Y";</script><!-- Z --><p>ok</p></body></html>',
    );
  });

  it('marks a run beside a comment and a style in the same element', () => {
    const out = markSlots(`<div><!-- note --><style>b{}</style>${run(0, 'A')}</div>`, keys);
    expect(out).toBe('<div><!-- note --><style>b{}</style><span data-stet="t__headline">A</span></div>');
  });

  it('keeps the value and marks nothing inside markup the tokenizer reports as a fault', () => {
    // The <p> is never closed: the </div> pops past it, so its text is inside a fault.
    const out = markSlots(`<div><p>${run(0, 'unclosed')}</div><b>${run(1, 'after')}</b>`, keys);
    expect(out).toBe('<div><p>unclosed</div><b><span data-stet="t__subject">after</span></b>');
  });

  it('keeps the value and marks nothing inside a tag the tokenizer could not read', () => {
    // No space between attributes: the tokenizer reads the tag as text. A `>` inside a quoted value, then a `<`
    // inside one, each defeat a check that looks one way only.
    expect(markSlots(`<p><a href="x"class="${run(0, 'v')}">t</a></p>`, keys)).toBe('<p><a href="x"class="v">t</a></p>');
    expect(markSlots(`<p><a title="x > y"class="${run(0, 'v')}">t</a></p>`, keys)).toBe('<p><a title="x > y"class="v">t</a></p>');
    expect(markSlots(`<p><a href="x"title="${run(0, 'v')} <b>">t</a></p>`, keys)).toBe('<p><a href="x"title="v <b>">t</a></p>');
  });

  it('keeps the value and marks nothing inside an svg', () => {
    const out = markSlots(`<div><svg><text>${run(0, 'chart')}</text></svg></div>`, keys);
    expect(out).toBe('<div><svg><text>chart</text></svg></div>');
  });

  it('keeps the value and marks nothing where a value’s own markup spans elements', () => {
    const out = markSlots(`<div>${run(0, 'a <b>bold</b> word')}</div>`, keys);
    expect(out).toBe('<div>a <b>bold</b> word</div>');
  });

  it('removes a run whose index names no slot, and the pieces of a run a template cut short', () => {
    expect(markSlots(`<p>${run(9, 'orphan')}</p>`, keys)).toBe('<p>orphan</p>');
    const cut = markSlots(`<p>\uE00012\uE001begun</p><p>\uE0003</p><p>tail\uE002</p>`, keys);
    expect(SENTINELS.test(cut)).toBe(false);
    expect(cut).toBe('<p>begun</p><p></p><p>tail</p>');
  });

  it('marks a whole run that follows a run a template cut short', () => {
    expect(markSlots(`<p>\uE0001\uE001cut</p><p>${run(0, 'whole')}</p>`, keys)).toBe(
      '<p>cut</p><p><span data-stet="t__headline">whole</span></p>',
    );
  });

  it('writes the slot name into the attribute escaped', () => {
    expect(markSlots(`<p>${run(0, 'v')}</p>`, ['a"><i x="'])).toBe('<p><span data-stet="a&quot;&gt;&lt;i x=&quot;">v</span></p>');
  });

  it('marks every occurrence of a slot, and each slot in its own span', () => {
    const out = markSlots(`<p>${run(0, 'A')}</p><p>${run(1, 'B')} ${run(0, 'A')}</p>`, keys);
    expect(out).toBe(
      '<p><span data-stet="t__headline">A</span></p><p><span data-stet="t__subject">B</span> <span data-stet="t__headline">A</span></p>',
    );
  });

  it('F2: reads a marker a template percent-encoded or wrote as a character reference as the marker', () => {
    const encoded = '%EE%80%80' + '0' + '%EE%80%81' + 'Hello%20there' + '%EE%80%82';
    expect(markSlots(`<a href="https://x.test/?q=${encoded}">go</a>`, keys)).toBe('<a href="https://x.test/?q=Hello%20there">go</a>');
    expect(markSlots(`<h1>&#xE000;0&#xe001;Hi&#xE002;</h1><h2>&#57344;1&#57345;Yo&#57346;</h2>`, keys)).toBe(
      '<h1><span data-stet="t__headline">Hi</span></h1><h2><span data-stet="t__subject">Yo</span></h2>',
    );
    expect(markSlots('<p>%EE%80%83 and &#xE003; and &#5734; stay</p>', keys)).toBe('<p>%EE%80%83 and &#xE003; and &#5734; stay</p>');
  });

  it('writes the sentinels as escapes in its source', () => {
    expect(readFileSync(new URL('../cli/email-preview.ts', import.meta.url), 'utf8')).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it('stripSlotMarks keeps every value and removes every sentinel', () => {
    expect(stripSlotMarks(`Re: ${run(0, 'Hello')} / ${run(1, 'x')}`)).toBe('Re: Hello / x');
    expect(stripSlotMarks('\uE0005\uE001cut')).toBe('cut');
  });
});

// --- the route ----------------------------------------------------------------

interface Reply {
  status: number;
  type: string | null;
  body: any;
}

/** One request to the email-preview route of a host the handler's workspace holds. */
async function preview(
  host: PreviewHost,
  body: unknown,
  over: Parameters<typeof handlerOver>[1] = {},
): Promise<Reply> {
  const { handler } = handlerOver([host.dir], over);
  const res = await handler(
    req(`/api/site/email-preview?site=${encodeURIComponent(realpathSync(host.dir))}`, { method: 'POST', body }),
  );
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
}

const DRAFT = { welcome__headline: 'Hello from a draft' };

describe('POST /api/site/email-preview', () => {
  it('renders the declared template with the snapshot’s words, each slot value marked', async () => {
    const host = previewHost();
    const { status, body } = await preview(host, { template: 'welcome' });
    expect(status).toBe(200);
    expect(body.failure).toBeUndefined();
    expect(body.html).toContain('<h1><span data-stet="welcome__headline">Welcome to mirra</span></h1>');
    // The sample props fill {{name}} before the value is wrapped.
    expect(body.html).toContain('<span data-stet="welcome__greeting">Hi Ada</span>');
    expect(SENTINELS.test(body.html)).toBe(false);
  });

  it('lays the request’s drafts over the snapshot, key by key', async () => {
    const { body } = await preview(previewHost(), { template: 'welcome', drafts: DRAFT });
    expect(body.html).toContain('<span data-stet="welcome__headline">Hello from a draft</span>');
    expect(body.html).toContain('Hi Ada');
  });

  it('answers the subject from the subject slot and the preheader from the preheader slot, sentinel free', async () => {
    const { body } = await preview(previewHost(), { template: 'welcome', drafts: { welcome__subject: 'A drafted subject' } });
    expect(body.subject).toBe('A drafted subject');
    expect(body.preheader).toBe('Your first week starts here');
  });

  it('answers the subject of a string map from its subject member, sentinels removed', async () => {
    const host = previewHost({
      template:
        'export function welcome(p: Record<string, string>) {\n' +
        "  return { subject: 'Re: ' + p.welcome__headline, html: '<h1>' + p.welcome__headline + '</h1>' };\n" +
        '}\n',
    });
    const { body } = await preview(host, { template: 'welcome', drafts: DRAFT });
    expect(body.subject).toBe('Re: Hello from a draft');
    expect(body.html).toBe('<h1><span data-stet="welcome__headline">Hello from a draft</span></h1>');
  });

  it('a slot in an href and in <title> carries no marker and no span there (marker scenario)', async () => {
    const host = previewHost({
      template:
        'export function welcome(p: Record<string, string>): string {\n' +
        "  return '<html><head><title>' + p.welcome__subject + '</title></head><body>' +\n" +
        "    '<a href=\"https://x.test/?q=' + p.welcome__headline + '\">go</a>' +\n" +
        "    '<h1>' + p.welcome__headline + '</h1></body></html>';\n" +
        '}\n',
    });
    const { body } = await preview(host, { template: 'welcome', drafts: DRAFT });
    expect(body.html).toContain('<title>Welcome aboard</title>');
    expect(body.html).toContain('<a href="https://x.test/?q=Hello from a draft">go</a>');
    expect(body.html).toContain('<h1><span data-stet="welcome__headline">Hello from a draft</span></h1>');
    expect(body.html.match(/data-stet=/g)).toHaveLength(1);
    expect(SENTINELS.test(body.html)).toBe(false);
  });

  it('a slot inside <style> and inside a comment carries no marker and no span', async () => {
    const host = previewHost({
      template:
        'export function welcome(p: Record<string, string>): string {\n' +
        "  return '<html><head><style>.h:after{content:\"' + p.welcome__headline + '\"}</style></head><body>' +\n" +
        "    '<!-- ' + p.welcome__headline + ' --><p>' + p.welcome__subject + '</p></body></html>';\n" +
        '}\n',
    });
    const { body } = await preview(host, { template: 'welcome', drafts: DRAFT });
    expect(body.html).toContain('content:"Hello from a draft"');
    expect(body.html).toContain('<!-- Hello from a draft -->');
    expect(body.html.match(/data-stet=/g)).toHaveLength(1);
    expect(SENTINELS.test(body.html)).toBe(false);
  });

  it('answers a render that threw as a failure with its reason and detail', async () => {
    const host = previewHost({ template: "export function welcome(): string { throw new Error('boom from the template'); }\n" });
    const { status, body } = await preview(host, { template: 'welcome' });
    expect(status).toBe(200);
    expect(body.html).toBeUndefined();
    expect(body.failure.reason).toBe('render-threw');
    expect(body.failure.detail).toContain('boom from the template');
  });

  it('answers a slot with no value as not-renderable, naming the slot', async () => {
    const host = previewHost({ snapshot: { welcome__headline: 'x' } });
    const { body } = await preview(host, { template: 'welcome' });
    expect(body.failure.reason).toBe('not-renderable');
    expect(body.failure.detail).toContain('welcome__subject');
  });

  it('answers a map with no html member as not-renderable', async () => {
    const host = previewHost({ template: "export function welcome() { return { subject: 'only' }; }\n" });
    const { body } = await preview(host, { template: 'welcome' });
    expect(body.failure.reason).toBe('not-renderable');
    expect(body.failure.detail).toContain('no html member');
  });

  it('refuses an undeclared template, a template with no pointer, and a request that is not one', async () => {
    const host = previewHost();
    expect((await preview(host, { template: 'nope' })).status).toBe(400);
    expect((await preview(host, { template: 'constructor' })).status).toBe(400);
    expect((await preview(host, {})).status).toBe(400);
    expect((await preview(host, { template: 'welcome', drafts: 'x' })).status).toBe(400);
    const bare = previewHost();
    const descriptorPath = join(bare.dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    delete descriptor.templates.welcome.render;
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const { status, body } = await preview(bare, { template: 'welcome' });
    expect(status).toBe(200);
    expect(body.failure).toEqual({
      reason: 'not-renderable',
      detail: 'welcome has no render pointer — declare one, or render it through the host',
    });
  });

  it('renders in the locale asked for, and refuses one the project has not enabled', async () => {
    const host = previewHost({
      config: { locales: { default: 'default', enabled: ['default', 'fr'] } },
      locales: { fr: { welcome__headline: 'Bienvenue chez mirra' } },
    });
    const french = await preview(host, { template: 'welcome', locale: 'fr' });
    expect(french.body.html).toContain('<span data-stet="welcome__headline">Bienvenue chez mirra</span>');
    expect(french.body.html).toContain('Hi Ada');
    expect((await preview(host, { template: 'welcome', locale: 'de' })).status).toBe(400);
  });

  // An addition beyond the plan: it guards the shared auth of every /api/site route, not the preview's own behaviour.
  it('is behind the run token', async () => {
    const host = previewHost();
    const { handler } = handlerOver([host.dir]);
    const res = await handler(
      req(`/api/site/email-preview?site=${encodeURIComponent(realpathSync(host.dir))}`, { method: 'POST', token: null, body: { template: 'welcome' } }),
    );
    expect(res.status).toBe(401);
  });

  it('reads a store-backed site’s drafts through the store, with the request’s drafts over them', async () => {
    const store = createMemoryStore({ project: 'default' });
    await store.saveDraft({ key: 'welcome__headline', value: 'From the store draft', target: 'html-email', editor: 't' });
    await store.saveDraft({ key: 'welcome__subject', value: 'Store subject', target: 'html-email', editor: 't' });
    const host = previewHost({ config: { store: { adapter: 'memory' } } });
    const stored = await preview(host, { template: 'welcome' }, { storeFor: () => store });
    expect(stored.body.html).toContain('<span data-stet="welcome__headline">From the store draft</span>');
    expect(stored.body.subject).toBe('Store subject');
    const typed = await preview(host, { template: 'welcome', drafts: DRAFT }, { storeFor: () => store });
    expect(typed.body.html).toContain('<span data-stet="welcome__headline">Hello from a draft</span>');
    expect(typed.body.subject).toBe('Store subject');
    // A slot with no draft row falls to the snapshot.
    expect(typed.body.preheader).toBe('Your first week starts here');
  });

  it('answers 400 for an environment the config does not declare, and says so when the store does not answer', async () => {
    const host = previewHost({ config: { store: { adapter: 'memory' } } });
    const store = createMemoryStore({ project: 'default' });
    expect((await preview(host, { template: 'welcome', env: 'nowhere' }, { storeFor: () => store })).status).toBe(400);
    const down = { ...store, read: async () => ({ storeError: true as const, message: 'connection refused' }) };
    const { body } = await preview(host, { template: 'welcome' }, { storeFor: () => down as typeof store });
    expect(body.failure.reason).toBe('not-renderable');
    expect(body.failure.detail).toContain('connection refused');
  });

  // --- stage 5 ------------------------------------------------------------------

  it('S1: hostile markup comes back as JSON data, byte for byte, never as a document', async () => {
    const hostile =
      '<html><body><script>window.__pwn=1</script><img src=x onerror="window.__pwn=2">' +
      '<a href="javascript:window.__pwn=3">x</a><meta http-equiv="refresh" content="0;url=/"></body></html>';
    const host = previewHost({ template: `export function welcome(): string { return ${JSON.stringify(hostile)}; }\n` });
    const { type, body } = await preview(host, { template: 'welcome' });
    expect(type).toContain('application/json');
    expect(body.html).toBe(hostile);
  });

  it('S2: the host template runs without the dashboard’s run token or this process’s environment', async () => {
    const host = previewHost({
      template:
        'export function welcome(): string {\n' +
        "  return '<p>' + (process.env.STET_DEV_TOKEN ?? 'no-token') + '/' + (process.env.PREVIEW_PROBE ?? 'no-probe') + '</p>';\n" +
        '}\n',
    });
    const held = { token: process.env['STET_DEV_TOKEN'], probe: process.env['PREVIEW_PROBE'] };
    process.env['STET_DEV_TOKEN'] = 'secret-run-token';
    process.env['PREVIEW_PROBE'] = 'inherited';
    try {
      const { body } = await preview(host, { template: 'welcome' });
      expect(body.html).toBe('<p>no-token/no-probe</p>');
    } finally {
      for (const [name, value] of [['STET_DEV_TOKEN', held.token], ['PREVIEW_PROBE', held.probe]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('S3: a pointer file outside the project answers the containment line and spawns nothing', async () => {
    const host = previewHost();
    const mark = join(host.dir, 'spawned');
    const out = outsideFile(
      host,
      `export function welcome(): string { require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); return '<p>outside</p>'; }\n`,
    );
    const descriptorPath = join(host.dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    descriptor.templates.welcome.render.file = out.rel;
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const { status, body } = await preview(host, { template: 'welcome' });
    expect(status).toBe(200);
    expect(body.failure).toEqual({
      reason: 'not-renderable',
      detail: `${out.rel} is outside the project — a render pointer names a file inside it`,
    });
    expect(existsSync(mark)).toBe(false);
  });

  it('F6d: a pointer outside the project never reaches the store', async () => {
    const host = previewHost({ config: { store: { adapter: 'memory' } } });
    const out = outsideFile(host, "export function welcome(): string { return '<p>outside</p>'; }\n");
    const descriptorPath = join(host.dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    descriptor.templates.welcome.render.file = out.rel;
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const base = createMemoryStore({ project: 'default' });
    let reads = 0;
    const counting = {
      ...base,
      read: async (...args: Parameters<typeof base.read>) => {
        reads += 1;
        return base.read(...args);
      },
    };
    const { body } = await preview(host, { template: 'welcome' }, { storeFor: () => counting as typeof base });
    expect(body.failure.detail).toContain('is outside the project');
    expect(reads).toBe(0);
  });

  it('S3: a frame file outside the project, and a symlink out of it, are refused the same way', async () => {
    const host = previewHost();
    const mark = join(host.dir, 'spawned');
    const source = `export function welcome(h: string): string { require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); return h; }\n`;
    const out = outsideFile(host, source);
    const descriptorPath = join(host.dir, 'content/descriptor.json');
    const edit = (change: (render: Record<string, unknown>) => void): void => {
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      change(descriptor.templates.welcome.render);
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
    };
    edit((render) => (render['frame'] = { file: out.rel, export: 'welcome' }));
    const framed = await preview(host, { template: 'welcome' });
    expect(framed.body.failure).toEqual({
      reason: 'not-renderable',
      detail: `${out.rel} is outside the project — a render pointer names a file inside it`,
    });
    edit((render) => {
      delete render['frame'];
      render['file'] = 'lib/email/linked.ts';
    });
    linkOut(host, 'lib/email/linked.ts', out.abs);
    const linked = await preview(host, { template: 'welcome' });
    expect(linked.body.failure.reason).toBe('not-renderable');
    expect(linked.body.failure.detail).toBe('lib/email/linked.ts is outside the project — a render pointer names a file inside it');
    expect(existsSync(mark)).toBe(false);
  });
});

describe('F4 (R5-5): a pointer with no extension is judged on the file Node loads', () => {
  const LINE = (file: string): string => `${file} is outside the project — a render pointer names a file inside it`;
  const edit = (host: PreviewHost, change: (render: Record<string, unknown>) => void): void => {
    const descriptorPath = join(host.dir, 'content/descriptor.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    change(descriptor.templates.welcome.render);
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
  };

  it('a pointer file whose .ts sibling is a symlink out of the project answers the containment line, and the outside file never runs', async () => {
    const host = previewHost();
    const mark = join(host.dir, 'spawned');
    const out = outsideFile(host, `export function welcome(): string { require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); return '<p>outside ran</p>'; }\n`);
    linkOut(host, 'lib/email/linked.ts', out.abs);
    edit(host, (render) => (render['file'] = 'lib/email/linked'));
    const { status, body } = await preview(host, { template: 'welcome' });
    expect(status).toBe(200);
    expect(body.failure).toEqual({ reason: 'not-renderable', detail: LINE('lib/email/linked') });
    expect(existsSync(mark)).toBe(false);
  });

  it('a frame file with no extension, linked out of the project, is refused the same way', async () => {
    const host = previewHost();
    const mark = join(host.dir, 'spawned');
    const out = outsideFile(host, `export function frame(h: string): string { require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x'); return h; }\n`);
    linkOut(host, 'lib/email/shell.ts', out.abs);
    edit(host, (render) => (render['frame'] = { file: 'lib/email/shell', export: 'frame' }));
    const { body } = await preview(host, { template: 'welcome' });
    expect(body.failure).toEqual({ reason: 'not-renderable', detail: LINE('lib/email/shell') });
    expect(existsSync(mark)).toBe(false);
  });

  it('an extension-less pointer that stays inside the project still renders', async () => {
    const host = previewHost();
    edit(host, (render) => (render['file'] = 'lib/email/welcome'));
    const { body } = await preview(host, { template: 'welcome' });
    expect(body.html).toContain('<h1>');
  });
});

describe('D66: an email subject is one line', () => {
  const LINE = 'An email subject fits on one line. Remove the line break.';

  it('a snapshot save of a subject holding a CR and LF is refused with the message, and nothing is written', async () => {
    const host = previewHost();
    const { handler } = handlerOver([host.dir]);
    const before = readFileSync(join(host.dir, 'content/defaults.json'), 'utf8');
    const res = await handler(
      req(`/api/site/save?site=${encodeURIComponent(realpathSync(host.dir))}`, {
        method: 'POST',
        body: { values: [{ key: 'welcome__subject', value: 'Hi\r\nBcc: x@evil.test' }] },
      }),
    );
    const body = (await res.json()) as { error: string; findings: Array<{ message: string }> };
    expect(res.status).toBe(409);
    expect(body.error).toBe('refused by the save gate');
    expect(body.findings.map((f) => f.message)).toContain(`${LINE} (default)`);
    expect(readFileSync(join(host.dir, 'content/defaults.json'), 'utf8')).toBe(before);
  });
});

describe('a template that never returns', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('F1 (R5-1): holds only its own request: a route of the same site answers while it hangs', async () => {
    const host = previewHost({
      template:
        'export function welcome(): Promise<string> {\n' +
        '  setInterval(() => {}, 1000);\n' +
        '  return new Promise(() => {});\n' +
        '}\n',
    });
    const { handler } = handlerOver([host.dir], { renderDeadlineMs: 3000 });
    const site = encodeURIComponent(realpathSync(host.dir));
    const started = Date.now();
    const hung = handler(req(`/api/site/email-preview?site=${site}`, { method: 'POST', body: { template: 'welcome' } }));
    await sleep(500);
    // The same site: its routes share the site's queue, which a render must not hold.
    const asked = Date.now();
    const other = await handler(req(`/api/site?site=${site}`));
    expect(other.status).toBe(200);
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(Date.now() - started).toBeLessThan(2000);
    const answer = (await (await hung).json()) as { failure: { reason: string; detail: string } };
    expect(answer.failure.reason).toBe('render-threw');
    expect(answer.failure.detail).toContain('did not finish within 3s');
  }, 15_000);
});

describe('what a template does with the markers', () => {
  const hostWith = (body: string): PreviewHost =>
    previewHost({
      template: `export function welcome(p: Record<string, string>): string {\n  return ${body};\n}\n`,
    });

  it('F2: a slot a template percent-encodes into an href carries no marker bytes, and the text slot still gets its span', async () => {
    const host = hostWith(
      "'<html><body><a href=\"https://x.test/?q=' + encodeURIComponent(p.welcome__headline) + '\">go</a><h1>' + p.welcome__headline + '</h1></body></html>'",
    );
    const { body } = await preview(host, { template: 'welcome', drafts: DRAFT });
    expect(body.html).not.toContain('%EE%80');
    expect(body.html).not.toContain('&#5734');
    expect(body.html).toContain('<a href="https://x.test/?q=Hello%20from%20a%20draft">go</a>');
    expect(body.html).toContain('<h1><span data-stet="welcome__headline">Hello from a draft</span></h1>');
  });

  it('F2: a template that writes non-ASCII as character references still gets its span, and no reference to a marker survives', async () => {
    const host = hostWith(
      "'<html><body><h1>' + p.welcome__headline.replace(/[^\\x00-\\x7f]/g, (c) => '&#' + c.charCodeAt(0) + ';') + '</h1></body></html>'",
    );
    const { body } = await preview(host, { template: 'welcome', drafts: DRAFT });
    expect(body.html).not.toContain('&#5734');
    expect(body.html).toBe('<html><body><h1><span data-stet="welcome__headline">Hello from a draft</span></h1></body></html>');
  });

  it('D61: the template sees the site’s .env and the base environment, and no connection variable of any environment', async () => {
    const host = previewHost({
      config: {
        store: { adapter: 'postgrest', urlEnv: 'DEV_URL', tokenEnv: 'DEV_TOKEN' },
        environments: { prod: { adapter: 'postgrest', urlEnv: 'PROD_URL', tokenEnv: 'PROD_TOKEN' } },
      },
      files: { '.env': 'PROD_TOKEN=from-dotenv-prod\nDEV_TOKEN=from-dotenv-dev\nHOST_NOTE=kept-from-dotenv\n' },
      template:
        'export function welcome(): string {\n' +
        "  const e = process.env;\n  return '<p>' + JSON.stringify({ prod: e.PROD_TOKEN ?? null, dev: e.DEV_TOKEN ?? null, note: e.HOST_NOTE ?? null, path: typeof e.PATH }) + '</p>';\n" +
        '}\n',
    });
    const held = process.env['PROD_TOKEN'];
    process.env['PROD_TOKEN'] = 'from-process-prod';
    try {
      const { handler } = handlerOver([host.dir], { launched: realpathSync(host.dir), storeFor: () => createMemoryStore({ project: 'default' }) });
      const res = await handler(
        req(`/api/site/email-preview?site=${encodeURIComponent(realpathSync(host.dir))}`, { method: 'POST', body: { template: 'welcome' } }),
      );
      const { html } = (await res.json()) as { html: string };
      expect(html).toBe('<p>{"prod":null,"dev":null,"note":"kept-from-dotenv","path":"string"}</p>');
    } finally {
      if (held === undefined) delete process.env['PROD_TOKEN'];
      else process.env['PROD_TOKEN'] = held;
    }
  });
});

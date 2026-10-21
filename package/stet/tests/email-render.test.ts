/**
 * The render seam and the runner asset behind it. Every arm is PRODUCED by a
 * fixture host — no reason is claimed by inspection — because the taxonomy is
 * what `stet email verify` reports to an adopter whose template will not render,
 * and a mis-mapped exit sends them after the wrong thing.
 *
 * The hosts are real directories with real `node_modules`: the runner resolves
 * `typescript` and `react-dom/server` from the HOST, which is the whole point of
 * the design, so a fixture that faked either would prove nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { containedPointer, renderTemplate, renderTemplateAsync, templateProps, type RenderRequest } from '../cli/email-render.js';
import { packageRoot } from '../cli/installed.js';
import type { CliIo } from '../cli/main.js';
import { TS7_REFUSAL } from '../cli/source-scan.js';
import type { TemplateDef } from '../src/types.js';
import { cleanupEmailHosts, makeEmailHost, type EmailHost } from './helpers/email-host.js';

afterAll(cleanupEmailHosts);

const io = (cwd: string): CliIo => ({ cwd, env: process.env, stdout: () => {}, stderr: () => {} });

/** The Mirra shape: an exported function returning `{ subject, html }`. */
const STRING_TEMPLATE =
  "export interface WelcomeProps { name: string; loginUrl: string }\n" +
  'export function welcome(props: WelcomeProps): { subject: string; html: string } {\n' +
  '  return {\n' +
  '    subject: `Welcome, ${props.name}`,\n' +
  '    html: `<h1>Good to see you, ${props.name}</h1><a href="${props.loginUrl}">Open</a>`,\n' +
  '  };\n' +
  '}\n';

/** The react-email shape: an exported component returning JSX. */
const JSX_TEMPLATE =
  "import * as React from 'react';\n" +
  'export interface DigestProps { count: number }\n' +
  'export function Digest(props: DigestProps): React.ReactElement {\n' +
  '  return <html><body><h1>Your weekly digest</h1><p>{props.count} updates.</p></body></html>;\n' +
  '}\n';

function render(
  host: EmailHost,
  rel: string,
  exportName: string,
  props: Record<string, unknown> = {},
  shape: Pick<RenderRequest, 'frame' | 'fill' | 'send'> = {},
) {
  return renderTemplate(io(host.dir), { hostDir: host.dir, file: host.path(rel), exportName, props, ...shape });
}

/** The rendered value, parsed; throws on a failed render so a case names what it got. */
function rendered(result: ReturnType<typeof render>): unknown {
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return JSON.parse(result.result);
}

describe('renderTemplate — the two canonical shapes', () => {
  it('renders a string-object template through the host toolchain', () => {
    const host = makeEmailHost();
    host.put('lib/email/welcome.ts', STRING_TEMPLATE);
    const result = render(host, 'lib/email/welcome.ts', 'welcome', {
      name: 'Ada',
      loginUrl: 'https://example.com/login',
    });
    expect(result).toEqual({
      ok: true,
      result: JSON.stringify({
        subject: 'Welcome, Ada',
        html: '<h1>Good to see you, Ada</h1><a href="https://example.com/login">Open</a>',
      }),
    });
  });

  it('renders a JSX component through the host react-dom/server', () => {
    const host = makeEmailHost();
    host.put('lib/email/digest.tsx', JSX_TEMPLATE);
    const result = render(host, 'lib/email/digest.tsx', 'Digest', { count: 3 });
    expect(result.ok).toBe(true);
    expect(result.ok && JSON.parse(result.result)).toBe(
      '<html><head></head><body><h1>Your weekly digest</h1><p>3 updates.</p></body></html>',
    );
  });

  it('keeps the host template’s own stdout out of the result', () => {
    const host = makeEmailHost();
    host.put(
      'lib/email/chatty.ts',
      "console.log('loading the mailer');\n" +
        'export function chatty(): string {\n' +
        "  console.log('rendering');\n" +
        "  return '<p>quiet</p>';\n" +
        '}\n',
    );
    const result = render(host, 'lib/email/chatty.ts', 'chatty');
    expect(result).toEqual({ ok: true, result: JSON.stringify('<p>quiet</p>') });
  });
});

describe('renderTemplate — the default export', () => {
  const DEFAULTED =
    "import * as React from 'react';\n" +
    'export default function Digest(props: { count: number }): React.ReactElement {\n' +
    '  return <p>{props.count} updates.</p>;\n' +
    '}\n';

  it('answers to `default`, which is the only name the transpile emits', () => {
    const host = makeEmailHost();
    host.put('lib/email/digest.tsx', DEFAULTED);
    const result = render(host, 'lib/email/digest.tsx', 'default', { count: 3 });
    expect(result.ok && JSON.parse(result.result)).toBe('<p>3 updates.</p>');
  });

  it('falls back to it where a hand-written pointer names the SOURCE name, and says so', () => {
    // `export default function Digest` puts the function on `exports.default`
    // and nowhere else, so a pointer written by hand as `Digest` would find
    // nothing — and the default is unambiguously what it meant.
    const host = makeEmailHost();
    host.put('lib/email/digest.tsx', DEFAULTED);
    const result = render(host, 'lib/email/digest.tsx', 'Digest', { count: 3 });
    expect(result.ok && JSON.parse(result.result)).toBe('<p>3 updates.</p>');
    // The other reason a pointer names an export the module does not have is a
    // typo, so the fallback names itself rather than forgiving it silently.
    expect(result.ok && result.note).toBe(
      'export "Digest" is not on the module; rendered its default export',
    );
  });

  it('says nothing where the pointer names the export the module really has', () => {
    const host = makeEmailHost();
    host.put('lib/email/digest.tsx', DEFAULTED);
    expect(render(host, 'lib/email/digest.tsx', 'default', { count: 3 })).toEqual({
      ok: true,
      result: JSON.stringify('<p>3 updates.</p>'),
    });
  });

  it('never redirects a named export that is really there', () => {
    // The fallback is reached only when the named export is ABSENT: a module
    // carrying both must render the one the pointer names.
    const host = makeEmailHost();
    host.put(
      'lib/email/two.ts',
      'export function alt(): string {\n  return `<p>the named one</p>`;\n}\n' +
        'export default function main(): string {\n  return `<p>the default one</p>`;\n}\n',
    );
    const result = render(host, 'lib/email/two.ts', 'alt');
    expect(result.ok && JSON.parse(result.result)).toBe('<p>the named one</p>');
  });
});

describe('renderTemplate — the ceilings, produced', () => {
  it('names the OUTPUT ceiling rather than reporting a thrown render', () => {
    const host = makeEmailHost();
    host.put('lib/email/huge.ts', 'export function huge(): string {\n  return "x".repeat(40 * 1024 * 1024);\n}\n');
    const result = render(host, 'lib/email/huge.ts', 'huge');
    expect(!result.ok && result.reason).toBe('render-threw');
    // The number, so the reader knows what they hit.
    expect(!result.ok && result.detail).toContain('32MB');
    expect(!result.ok && result.detail).not.toContain('threw');
  });

  it('names the ARGUMENT ceiling when the resolved props will not fit', () => {
    // Every sample prop and every resolved slot value travels as one argv
    // entry, and the OS caps that list around a megabyte — a real limit for a
    // template seeded with a long body.
    const host = makeEmailHost();
    host.put('lib/email/small.ts', 'export function small(): string {\n  return `<p>ok</p>`;\n}\n');
    const result = render(host, 'lib/email/small.ts', 'small', { blob: 'x'.repeat(2 * 1024 * 1024) });
    expect(!result.ok && result.reason).toBe('render-threw');
    expect(!result.ok && result.detail).toContain('too large to pass');
  });
});

describe('renderTemplate — every failure reason, produced', () => {
  it('export-not-function: the named export is not there', () => {
    const host = makeEmailHost();
    host.put('lib/email/welcome.ts', STRING_TEMPLATE);
    const result = render(host, 'lib/email/welcome.ts', 'Welcome');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('export-not-function');
    expect(!result.ok && result.detail).toContain('"Welcome"');
  });

  it('export-not-function: a prototype member is not an export', () => {
    // `render.export` is descriptor data, so a bare index would find
    // Object.prototype's `constructor` — a function — and CALL it.
    const host = makeEmailHost();
    host.put('lib/email/welcome.ts', STRING_TEMPLATE);
    const result = render(host, 'lib/email/welcome.ts', 'constructor');
    expect(!result.ok && result.reason).toBe('export-not-function');
  });

  it('render-threw: the export throws, and the stack reaches the report', () => {
    const host = makeEmailHost();
    host.put('lib/email/boom.ts', "export function boom(): string {\n  throw new Error('template exploded');\n}\n");
    const result = render(host, 'lib/email/boom.ts', 'boom');
    expect(!result.ok && result.reason).toBe('render-threw');
    expect(!result.ok && result.detail).toContain('template exploded');
  });

  it('not-renderable: the export returns something that is not markup', () => {
    const host = makeEmailHost();
    host.put('lib/email/counted.ts', 'export function counted(): number {\n  return 41;\n}\n');
    const result = render(host, 'lib/email/counted.ts', 'counted');
    expect(!result.ok && result.reason).toBe('not-renderable');
    expect(!result.ok && result.detail).toContain('a number');
  });

  it('missing-dependency: react-dom is absent at render time, and it is named', () => {
    // Linked with typescript ALONE — the element is hand-built so the failure
    // lands on `react-dom/server`, not on the template's own import.
    const host = makeEmailHost({ deps: ['typescript'] });
    host.put(
      'lib/email/element.ts',
      'export function element(): unknown {\n' +
        "  return { $$typeof: Symbol.for('react.transitional.element'), type: 'p', props: {} };\n" +
        '}\n',
    );
    const result = render(host, 'lib/email/element.ts', 'element');
    expect(!result.ok && result.reason).toBe('missing-dependency');
    expect(!result.ok && result.detail).toContain('react-dom/server');
  });

  it('ts7-unsupported: a typescript exposing version constants only is refused by name', () => {
    const host = makeEmailHost({ deps: [] });
    host.put('node_modules/typescript/package.json', '{ "name": "typescript", "version": "7.0.2", "main": "index.js" }\n');
    host.put('node_modules/typescript/index.js', "module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };\n");
    host.put('lib/email/welcome.ts', STRING_TEMPLATE);
    const result = render(host, 'lib/email/welcome.ts', 'welcome');
    expect(!result.ok && result.reason).toBe('ts7-unsupported');
    expect(!result.ok && result.detail).toBe(TS7_REFUSAL);
  });
});

describe('renderTemplate — module resolution', () => {
  it('resolves the narrow alias form: one wildcard, one candidate, the app’s own tsconfig', () => {
    const host = makeEmailHost();
    host.put('tsconfig.json', '{\n  // create-next-app\'s default\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n');
    host.put('src/email/base.ts', 'export const frame = (inner: string): string => `<html>${inner}</html>`;\n');
    host.put(
      'src/email/welcome.ts',
      "import { frame } from '@/email/base';\n" +
        'export function welcome(props: { name: string }): string {\n' +
        '  return frame(`<h1>${props.name}</h1>`);\n' +
        '}\n',
    );
    const result = render(host, 'src/email/welcome.ts', 'welcome', { name: 'Ada' });
    expect(result.ok).toBe(true);
    expect(result.ok && JSON.parse(result.result)).toBe('<html><h1>Ada</h1></html>');
  });

  it('leaves an alias outside the narrow form unmapped, and names the remedy', () => {
    const host = makeEmailHost();
    host.put('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*", "./other/*"] } } }\n');
    host.put('src/email/base.ts', 'export const frame = (inner: string): string => inner;\n');
    host.put(
      'src/email/welcome.ts',
      "import { frame } from '@/email/base';\nexport function welcome(): string {\n  return frame('x');\n}\n",
    );
    const result = render(host, 'src/email/welcome.ts', 'welcome');
    expect(!result.ok && result.reason).toBe('missing-dependency');
    expect(!result.ok && result.detail).toContain("Cannot find module '@/email/base'");
    expect(!result.ok && result.detail).toContain('Rewrite this import as a relative path');
  });

  it('reads the alias map from own properties only', () => {
    // `readConfigFile` builds its result by assignment, so a `"__proto__"`
    // member replaces the object's PROTOTYPE rather than adding a key — a bare
    // `.compilerOptions` read would then take the attacker's and map `@/` at a
    // directory the tsconfig never named.
    const host = makeEmailHost();
    host.put('tsconfig.json', '{ "__proto__": { "compilerOptions": { "paths": { "@/*": ["./planted/*"] } } } }\n');
    host.put('planted/base.ts', "export const frame = (i: string): string => `planted:${i}`;\n");
    host.put('src/base.ts', "export const frame = (i: string): string => `own:${i}`;\n");
    host.put(
      'src/welcome.ts',
      "import { frame } from '@/base';\nexport function welcome(): string {\n  return frame('x');\n}\n",
    );
    const result = render(host, 'src/welcome.ts', 'welcome');
    expect(!result.ok && result.reason).toBe('missing-dependency');
    expect(result.ok && result.result).not.toContain('planted');
  });

  it('names the install line when the host has no typescript at all', () => {
    const host = makeEmailHost({ deps: [] });
    host.put('lib/email/welcome.ts', STRING_TEMPLATE);
    const result = render(host, 'lib/email/welcome.ts', 'welcome');
    expect(!result.ok && result.reason).toBe('missing-dependency');
    expect(!result.ok && result.detail).toContain('npm i -D typescript');
  });

  it('names the stray bytes when a template writes past the muting', () => {
    // `process.stdout.write` is muted; a raw write to fd 1 is not, and the
    // excerpt is the only way an adopter finds the line that did it.
    const host = makeEmailHost();
    host.put(
      'lib/email/loud.ts',
      "import { writeSync } from 'node:fs';\n" +
        'export function loud(): string {\n' +
        "  writeSync(1, 'RAW FD WRITE');\n" +
        "  return '<p>ok</p>';\n" +
        '}\n',
    );
    const result = render(host, 'lib/email/loud.ts', 'loud');
    expect(!result.ok && result.reason).toBe('render-threw');
    expect(!result.ok && result.detail).toContain('RAW FD WRITE');
  });

  it('names a template’s own missing import without the alias remedy', () => {
    const host = makeEmailHost();
    host.put('lib/email/welcome.ts', "import { gone } from './gone';\nexport function welcome(): string {\n  return gone;\n}\n");
    const result = render(host, 'lib/email/welcome.ts', 'welcome');
    expect(!result.ok && result.reason).toBe('missing-dependency');
    expect(!result.ok && result.detail).toContain("Cannot find module './gone'");
    expect(!result.ok && result.detail).not.toContain('Rewrite this import');
  });
});

describe('the runner asset', () => {
  it('carries the same TypeScript 7 refusal the scanner does', () => {
    // The runner is a shipped `.cjs` and cannot import the constant, so the one
    // string lives twice by necessity — this is what keeps the two copies equal.
    const runner = readFileSync(join(packageRoot(), 'templates', 'email-runner.cjs'), 'utf8');
    expect(runner).toContain(TS7_REFUSAL);
  });
});

describe('templateProps — the one props object every render of a declared template uses', () => {
  const ENTRY: TemplateDef = {
    class: 'transactional',
    trigger: 'manual',
    slots: ['headline'],
    render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: { name: 'Ada' } },
  };
  const valueOf = (value: unknown) => (key: string) => (key === 'welcome__headline' ? value : undefined);

  it('carries the sample props and each slot with its variables filled from them', () => {
    expect(templateProps('welcome', ENTRY, valueOf('Good to see you, {{ name }}'))).toEqual({
      values: { name: 'Ada', welcome__headline: 'Good to see you, Ada' },
    });
  });

  it('says a slot resolves to no value in the words email verify has always used', () => {
    expect(templateProps('welcome', ENTRY, valueOf(undefined))).toEqual({
      missing: 'the slot "headline" resolves to no value (welcome__headline) — seed it before verifying',
    });
  });

  it('names the shape of a slot that is not text', () => {
    expect(templateProps('welcome', ENTRY, valueOf(42))).toEqual({
      missing:
        'welcome__headline resolved to a number, not a string — fix the snapshot value; ' +
        'a slot that is not text cannot be compared as copy',
    });
    expect(templateProps('welcome', ENTRY, valueOf({ subject: 'Hi' }))).toEqual({
      missing:
        'welcome__headline resolved to an object, not a string — fix the snapshot value; ' +
        'a slot that is not text cannot be compared as copy',
    });
  });

  it('refuses a seeded variable the sample props lack, a prototype member included', () => {
    expect(templateProps('welcome', ENTRY, valueOf('Hi {{constructor}}'))).toEqual({
      missing:
        "welcome__headline seeds {{constructor}}, which is not a member of this template's sampleProps — " +
        'add it to the render pointer, or fix the placeholder',
    });
  });
});

describe('renderTemplate — the runner\'s argv', () => {
  // A runner that answers with how many arguments it was started with: the
  // plain pointer must keep the four-argument call every earlier render made.
  it('passes the fifth argument only where the pointer frames, fills or sends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stet-argv-'));
    mkdirSync(join(root, 'templates'));
    writeFileSync(join(root, 'templates', 'email-runner.cjs'), 'process.stdout.write(JSON.stringify(process.argv.length));\n');
    vi.resetModules();
    vi.doMock('../cli/installed.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../cli/installed.js')>()),
      packageRoot: () => root,
    }));
    try {
      const fresh = await import('../cli/email-render.js');
      const plain = { hostDir: root, file: join(root, 'x.ts'), exportName: 'x', props: {} };
      // node, the runner, then hostDir, file, export and props.
      expect(fresh.renderTemplate(io(root), plain)).toEqual({ ok: true, result: '6' });
      expect(fresh.renderTemplate(io(root), { ...plain, fill: true })).toEqual({ ok: true, result: '7' });
      expect(fresh.renderTemplate(io(root), { ...plain, frame: { file: 'f.ts', export: 'f' } })).toEqual({ ok: true, result: '7' });
    } finally {
      vi.doUnmock('../cli/installed.js');
      vi.resetModules();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the runner — one render path (D2)', () => {
  it('awaits an async template, and a log after the await reaches stderr (F6c)', () => {
    const host = makeEmailHost();
    host.put('lib/email/later.ts', "export const later = async () => { await 0; console.log('x'); return '<p/>'; };\n");
    expect(render(host, 'lib/email/later.ts', 'later')).toEqual({ ok: true, result: JSON.stringify('<p/>') });
    const runner = join(packageRoot(), 'templates', 'email-runner.cjs');
    const child = spawnSync(process.execPath, [runner, host.dir, host.path('lib/email/later.ts'), 'later', '{}'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(JSON.stringify('<p/>'));
    expect(child.stderr).toBe('x\n');
  });

  it('renders a markup string export as it stands', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<p>{{name}}</p>';\n");
    expect(rendered(render(host, 'lib/email/plain.ts', 'plain', { name: 'Ada' }))).toBe('<p>{{name}}</p>');
  });

  it('renders a string map export as it stands', () => {
    const host = makeEmailHost();
    host.put('lib/email/map.ts', "export const map = { subject: 'Hi', html: '<p>Hi</p>' };\n");
    expect(rendered(render(host, 'lib/email/map.ts', 'map'))).toEqual({ subject: 'Hi', html: '<p>Hi</p>' });
  });

  it('fills each variable the props hold as plain text, keeping one they lack and a $ pattern literal', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<a href=\"{{url}}\">{{ name }}</a> $& {{missing}}';\n");
    expect(rendered(render(host, 'lib/email/plain.ts', 'plain', { url: 'https://x', name: "$&Ada$'" }, { fill: true }))).toBe(
      "<a href=\"https://x\">$&Ada$'</a> $& {{missing}}",
    );
  });

  it('passes the markup through the frame with the named props, the whole props, or nothing more', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<p>{{name}}</p>';\n");
    host.put(
      'lib/email/base.ts',
      "export const named = (c: string, pre?: string) => `<html>${pre}|${c}</html>`;\n" +
        'export const all = (c: string, props: { name: string }) => `<b>${props.name}</b>${c}`;\n' +
        "export const bare = (c: string, extra?: unknown) => `<f>${c}${typeof extra}</f>`;\n",
    );
    const props = { name: 'Ada', preheader: 'pre' };
    expect(
      rendered(render(host, 'lib/email/plain.ts', 'plain', props, { frame: { file: 'lib/email/base.ts', export: 'named', args: ['preheader'] }, fill: true })),
    ).toBe('<html>pre|<p>Ada</p></html>');
    expect(rendered(render(host, 'lib/email/plain.ts', 'plain', props, { frame: { file: 'lib/email/base.ts', export: 'all', args: '$all' } }))).toBe(
      '<b>Ada</b><p>{{name}}</p>',
    );
    expect(rendered(render(host, 'lib/email/plain.ts', 'plain', props, { frame: { file: 'lib/email/base.ts', export: 'bare' } }))).toBe(
      '<f><p>{{name}}</p>undefined</f>',
    );
  });

  it('frames a string map\'s html member and keeps the others', () => {
    const host = makeEmailHost();
    host.put('lib/email/map.ts', "export const map = { subject: 'Hi {{name}}', html: '<p>{{name}}</p>' };\n");
    host.put('lib/email/base.ts', 'export const all = (c: string, props: { name: string }) => `<b>${props.name}</b>${c}`;\n');
    expect(
      rendered(render(host, 'lib/email/map.ts', 'map', { name: 'Ada' }, { frame: { file: 'lib/email/base.ts', export: 'all', args: '$all' }, fill: true })),
    ).toEqual({ subject: 'Hi Ada', html: '<b>Ada</b><p>Ada</p>' });
  });

  it('fills a variable the frame writes into its shell: the fill runs after the frame', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<p>{{name}}</p>';\n");
    host.put('lib/email/base.ts', "export const shell = (c: string) => `<html>{{preheader}}${c}</html>`;\n");
    expect(
      rendered(render(host, 'lib/email/plain.ts', 'plain', { name: 'Ada', preheader: 'pre' }, { frame: { file: 'lib/email/base.ts', export: 'shell' }, fill: true })),
    ).toBe('<html>pre<p>Ada</p></html>');
  });

  it('passes a frame argument only from the props\' own members, never a prototype member', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<p/>';\n");
    host.put('lib/email/base.ts', 'export const kind = (c: string, x?: unknown) => `${c}${typeof x}`;\n');
    expect(
      rendered(render(host, 'lib/email/plain.ts', 'plain', {}, { frame: { file: 'lib/email/base.ts', export: 'kind', args: ['constructor'] } })),
    ).toBe('<p/>undefined');
  });

  it('refuses a framed map with no html member as not-renderable, naming the template', () => {
    const host = makeEmailHost();
    host.put('lib/email/map.ts', "export const map = { subject: 'Hi', text: 'Hi' };\n");
    host.put('lib/email/base.ts', 'export const shell = (c: string) => `<html>${c}</html>`;\n');
    const result = render(host, 'lib/email/map.ts', 'map', {}, { frame: { file: 'lib/email/base.ts', export: 'shell' } });
    expect(!result.ok && result.reason).toBe('not-renderable');
    expect(!result.ok && result.detail).toBe(`${host.path('lib/email/map.ts')} map: the frame wraps the html member, and this map has none`);
  });

  it('refuses a frame export that is not a function, naming the frame file', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<p/>';\n");
    host.put('lib/email/base.ts', "export const shell = '<html></html>';\n");
    const result = render(host, 'lib/email/plain.ts', 'plain', {}, { frame: { file: 'lib/email/base.ts', export: 'shell' } });
    expect(!result.ok && result.reason).toBe('export-not-function');
    expect(!result.ok && result.detail).toBe('lib/email/base.ts: export "shell" is not a function');
  });

  it('never reports a frame that returns anything but a string as the email', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export const plain = '<p/>';\n");
    host.put(
      'lib/email/base.ts',
      'export const boxed = (c: string) => ({ wrapped: c });\n' + 'export const forgot = (c: string): void => { void c; };\n',
    );
    const frame = (name: string) => ({ file: 'lib/email/base.ts', export: name });
    const object = render(host, 'lib/email/plain.ts', 'plain', {}, { frame: frame('boxed') });
    expect(!object.ok && object.reason).toBe('not-renderable');
    expect(!object.ok && object.detail).toBe('lib/email/base.ts boxed: the frame returned an object — a frame returns a string');
    for (const fill of [false, true]) {
      const none = render(host, 'lib/email/plain.ts', 'plain', {}, { frame: frame('forgot'), fill });
      expect(!none.ok && none.reason).toBe('not-renderable');
      expect(!none.ok && none.detail).toBe('lib/email/base.ts forgot: the frame returned undefined — a frame returns a string');
    }
  });

  it('falls back to a default string export under a wrong export name, and says so', () => {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', "export default '<p/>';\n");
    expect(render(host, 'lib/email/plain.ts', 'welcome')).toEqual({
      ok: true,
      result: JSON.stringify('<p/>'),
      note: 'export "welcome" is not on the module; rendered its default export',
    });
  });

  it('leaves a React element\'s {{x}} alone where the pointer does not ask for the fill', () => {
    const host = makeEmailHost();
    host.put('lib/email/jsx.tsx', "export function Jsx(): JSX.Element {\n  return <p>{'{{x}}'}</p>;\n}\n");
    expect(rendered(render(host, 'lib/email/jsx.tsx', 'Jsx', { x: 'X' }))).toBe('<p>{{x}}</p>');
  });
});

describe('the runner — the send path (D5, stage 5)', () => {
  const SEND = "import { writeFileSync } from 'node:fs';\nexport function sendTest(message: unknown): void {\n  writeFileSync(process.env.SENT_TO as string, JSON.stringify(message));\n}\n";

  function sendHost(template: string): { host: EmailHost; sent: string } {
    const host = makeEmailHost();
    host.put('lib/email/plain.ts', template);
    host.put('lib/email/send.ts', SEND);
    return { host, sent: host.path('sent.json') };
  }

  const sendRender = (host: EmailHost, sent: string, exportName: string, props: Record<string, unknown>, send: RenderRequest['send'], fill = true) =>
    renderTemplate(
      { ...io(host.dir), env: { ...process.env, SENT_TO: sent } },
      { hostDir: host.dir, file: host.path('lib/email/plain.ts'), exportName, props, fill, send },
    );

  it('hands the host function the filled email with the recipient, the subject and the template', () => {
    const { host, sent } = sendHost("export const plain = '<p>{{name}}</p>';\n");
    const result = sendRender(host, sent, 'plain', { name: 'Ada' }, {
      file: 'lib/email/send.ts',
      export: 'sendTest',
      message: { to: 'a@b.c', subject: 'Hello', template: 'welcome' },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(sent, 'utf8'))).toEqual({ to: 'a@b.c', subject: 'Hello', template: 'welcome', html: '<p>Ada</p>' });
  });

  it('takes a string map\'s subject over the message\'s', () => {
    const { host, sent } = sendHost("export const plain = { subject: 'Hi {{name}}', html: '<p>{{name}}</p>' };\n");
    sendRender(host, sent, 'plain', { name: 'Ada' }, {
      file: 'lib/email/send.ts',
      export: 'sendTest',
      message: { to: 'a@b.c', subject: null, template: 'map' },
    });
    expect(JSON.parse(readFileSync(sent, 'utf8'))).toEqual({ to: 'a@b.c', subject: 'Hi Ada', template: 'map', html: '<p>Ada</p>' });
  });

  it('answers send-failed with the stack where the host function throws', () => {
    const { host, sent } = sendHost("export const plain = '<p/>';\n");
    host.put('lib/email/send.ts', "export async function sendTest(): Promise<void> {\n  throw new Error('provider said no');\n}\n");
    const result = sendRender(host, sent, 'plain', {}, { file: 'lib/email/send.ts', export: 'sendTest', message: { to: 'a@b.c', subject: 'x', template: 't' } });
    expect(!result.ok && result.reason).toBe('send-failed');
    expect(!result.ok && result.detail).toContain('Error: provider said no');
    expect(!result.ok && result.detail).toContain('send.ts');
  });

  it('answers not-renderable for a map with no html member, and loads no send file (D29)', () => {
    const { host, sent } = sendHost("export const plain = { subject: 'S', body: '<p/>' };\n");
    const loaded = host.path('send-loaded');
    host.put('lib/email/send.ts', `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, 'x');\nexport function sendTest(): void {}\n`);
    const result = sendRender(host, sent, 'plain', {}, { file: 'lib/email/send.ts', export: 'sendTest', message: { to: 'a@b.c', subject: null, template: 't' } });
    expect(!result.ok && result.reason).toBe('not-renderable');
    expect(!result.ok && result.detail).toContain('no html member');
    expect(existsSync(loaded)).toBe(false);
    expect(existsSync(sent)).toBe(false);
  });

  it('answers send-failed where the send export is not a function', () => {
    const { host, sent } = sendHost("export const plain = '<p/>';\n");
    const result = sendRender(host, sent, 'plain', {}, { file: 'lib/email/send.ts', export: 'nope', message: { to: 'a@b.c', subject: 'x', template: 't' } });
    expect(!result.ok && result.reason).toBe('send-failed');
    expect(!result.ok && result.detail).toBe('lib/email/send.ts: export "nope" is not a function');
  });
});

describe('containedPointer — which pointer file lies outside the project', () => {
  const pointer = (file: string) => ({ file, export: 'welcome', sampleProps: {} });

  it('names a pointer file that points out of the project, whether it exists or not', () => {
    const outside = makeEmailHost({ deps: [] });
    outside.put('tpl.ts', 'export const welcome = 1;\n');
    const host = makeEmailHost({ deps: [] });
    const rel = `../${outside.dir.split('/').pop()}/tpl.ts`;
    expect(containedPointer(host.dir, pointer(rel))).toBe(rel);
    expect(containedPointer(host.dir, pointer('../nowhere/tpl.ts'))).toBe('../nowhere/tpl.ts');
  });

  it('names a symlink inside the project that leads out of it', () => {
    const outside = makeEmailHost({ deps: [] });
    outside.put('tpl.ts', 'export const welcome = 1;\n');
    const host = makeEmailHost({ deps: [] });
    symlinkSync(outside.path('tpl.ts'), host.path('link.ts'));
    expect(containedPointer(host.dir, pointer('link.ts'))).toBe('link.ts');
  });

  it('does not call a missing file inside the project outside because its name starts with two dots', () => {
    const host = makeEmailHost({ deps: [] });
    expect(containedPointer(host.dir, pointer('..x/tpl.ts'))).toBeNull();
  });

  it('leaves a directory inside the project to the caller’s own read', () => {
    const host = makeEmailHost({ deps: [] });
    host.put('lib/email/tpl.ts', 'export const welcome = 1;\n');
    expect(containedPointer(host.dir, pointer('lib/email'))).toBeNull();
  });
});

// An addition beyond the plan's cases: the dev server's asynchronous render shares the status mapping with the
// synchronous one, and this is what keeps the two from answering differently.
describe('renderTemplateAsync — the answers renderTemplate gives', () => {
  const both = async (host: EmailHost, rel: string, exportName: string, props: Record<string, unknown> = {}) => {
    const request: RenderRequest = { hostDir: host.dir, file: host.path(rel), exportName, props };
    return { sync: renderTemplate(io(host.dir), request), async: await renderTemplateAsync(io(host.dir), request) };
  };

  it('answers the same for a render, a throw, the output ceiling and the argument ceiling', async () => {
    const host = makeEmailHost();
    host.put('lib/email/ok.ts', 'export function ok(p: { n: string }): string {\n  return `<p>${p.n}</p>`;\n}\n');
    host.put('lib/email/boom.ts', "export function boom(): string {\n  throw new Error('kaput');\n}\n");
    host.put('lib/email/huge.ts', 'export function huge(): string {\n  return "x".repeat(40 * 1024 * 1024);\n}\n');
    const ok = await both(host, 'lib/email/ok.ts', 'ok', { n: 'Ada' });
    expect(ok.async).toEqual(ok.sync);
    expect(ok.async).toEqual({ ok: true, result: JSON.stringify('<p>Ada</p>') });
    const boom = await both(host, 'lib/email/boom.ts', 'boom');
    expect(boom.async).toEqual(boom.sync);
    expect(!boom.async.ok && boom.async.reason).toBe('render-threw');
    const huge = await both(host, 'lib/email/huge.ts', 'huge');
    expect(huge.async).toEqual(huge.sync);
    expect(!huge.async.ok && huge.async.detail).toContain('32MB');
    const blob = await both(host, 'lib/email/ok.ts', 'ok', { n: 'x'.repeat(2 * 1024 * 1024) });
    expect(blob.async).toEqual(blob.sync);
    expect(!blob.async.ok && blob.async.detail).toContain('too large');
  });

  it('F6 (R5-2): a render that returns at once but leaves a grandchild holding the pipes is answered within the deadline plus the grace', async () => {
    const host = makeEmailHost();
    host.put(
      'lib/email/leaves.ts',
      "import { spawn } from 'node:child_process';\n" +
        'export function leaves(): string {\n' +
        "  spawn('sleep', ['12'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();\n" +
        "  return '<p>x</p>';\n" +
        '}\n',
    );
    const started = Date.now();
    const result = await renderTemplateAsync(io(host.dir), { hostDir: host.dir, file: host.path('lib/email/leaves.ts'), exportName: 'leaves', props: {} }, 2000);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(result).toEqual({ ok: true, result: JSON.stringify('<p>x</p>') });
  }, 30_000);

  // An addition beyond R5-2: the deadline ends the template's children with it.
  it('F6: the deadline ends the whole process group: a child the template started does not outlive it', async () => {
    const host = makeEmailHost();
    const pidFile = host.path('grandchild.pid');
    host.put(
      'lib/email/hangs.ts',
      "import { spawn } from 'node:child_process';\n" +
        "import { writeFileSync } from 'node:fs';\n" +
        'export function hangs(): Promise<string> {\n' +
        "  const child = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });\n" +
        `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        '  return new Promise(() => {});\n' +
        '}\n',
    );
    const result = await renderTemplateAsync(io(host.dir), { hostDir: host.dir, file: host.path('lib/email/hangs.ts'), exportName: 'hangs', props: {} }, 1500);
    expect(!result.ok && result.detail).toContain('did not finish within 1.5s');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 2000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
  }, 30_000);

  it('V4: a render in flight when this process exits takes its process group with it', async () => {
    const host = makeEmailHost();
    const pidFile = host.path('grandchild.pid');
    host.put(
      'lib/email/hangs.cjs',
      "const { spawn } = require('node:child_process');\n" +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] }).pid));\n` +
        'exports.hangs = () => new Promise(() => {});\n',
    );
    const script = [
      `const { renderTemplateAsync } = await import(${JSON.stringify(pathToFileURL(join(packageRoot(), 'dist/cli/email-render.js')).href)});`,
      `renderTemplateAsync({ cwd: ${JSON.stringify(host.dir)}, env: process.env, stdout() {}, stderr() {} }, { hostDir: ${JSON.stringify(host.dir)}, file: ${JSON.stringify(host.path('lib/email/hangs.cjs'))}, exportName: 'hangs', props: {} }, 30000);`,
      'setTimeout(() => process.exit(0), 700);',
    ].join('\n');
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(ran.status).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 1000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
  }, 30_000);

  it('F7 (R5-4): a send that went out is reported as sent although the host module keeps the event loop alive', async () => {
    const host = makeEmailHost();
    const log = host.path('sent.log');
    host.put('lib/email/plain.ts', "export function plain(): string {\n  return '<p>x</p>';\n}\n");
    host.put(
      'lib/mail.ts',
      "import { appendFileSync } from 'node:fs';\n" +
        'setInterval(() => {}, 1000); // a pooled transport\n' +
        'export async function sendMail(m: { to: string }): Promise<void> {\n' +
        `  appendFileSync(${JSON.stringify(log)}, m.to + '\\n');\n` +
        '}\n',
    );
    const started = Date.now();
    const result = await renderTemplateAsync(
      io(host.dir),
      {
        hostDir: host.dir,
        file: host.path('lib/email/plain.ts'),
        exportName: 'plain',
        props: {},
        send: { file: 'lib/mail.ts', export: 'sendMail', message: { to: 'a@b.test', subject: 's', template: 'plain' } },
      },
      2500,
    );
    expect(result).toEqual({ ok: true, result: JSON.stringify('<p>x</p>') });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(readFileSync(log, 'utf8')).toBe('a@b.test\n');
  }, 30_000);

  it('names its own deadline when a template never returns', async () => {
    const host = makeEmailHost();
    host.put('lib/email/hang.ts', 'export function hang(): Promise<string> {\n  setInterval(() => {}, 1000);\n  return new Promise(() => {});\n}\n');
    const result = await renderTemplateAsync(io(host.dir), { hostDir: host.dir, file: host.path('lib/email/hang.ts'), exportName: 'hang', props: {} }, 1500);
    expect(!result.ok && result.detail).toContain('did not finish within 1.5s');
  });
});

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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { renderTemplate } from '../cli/email-render.js';
import { packageRoot } from '../cli/installed.js';
import type { CliIo } from '../cli/main.js';
import { TS7_REFUSAL } from '../cli/source-scan.js';
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

function render(host: EmailHost, rel: string, exportName: string, props: Record<string, unknown> = {}) {
  return renderTemplate(io(host.dir), { hostDir: host.dir, file: host.path(rel), exportName, props });
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

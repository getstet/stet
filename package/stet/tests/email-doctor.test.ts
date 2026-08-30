/**
 * Doctor's wrapper-chain check.
 *
 * `wrapperProvides` is a claim the marketing save gate believes: a template that
 * declares `unsubscribe_url` passes the gate whether or not any wrapper emits
 * one. The validation spec banked that debt explicitly — verifying the claim
 * against the real render path is doctor's job — and the render pointer is what
 * finally makes it cheap, because it names the root of the chain to search.
 *
 * The cases below drive the two halves that matter: a token that IS present but
 * only in an imported file (so the walk has to follow the import), and a token
 * present nowhere (so the warn has to name it and the files it searched).
 */
import { afterAll, describe, expect, it } from 'vitest';

import {
  MARKETING,
  chainProject as project,
  cleanupChainProjects,
  doctor,
  write,
} from './helpers/chain-project.js';

afterAll(cleanupChainProjects);

describe('doctor — the wrapper-chain check', () => {
  it('accepts a token that lives in an IMPORTED file, not the template', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url', 'postal_address']) });
    write(
      dir,
      'lib/email/welcome.ts',
      "import { frame } from './frame';\n" +
        'export function welcome(): string {\n  return frame(`<h1>Hello</h1>`);\n}\n',
    );
    // The wrapper is where these tokens actually live — which is exactly why a
    // file-level grep would report a false absence here.
    write(
      dir,
      'lib/email/frame.ts',
      'export const frame = (inner: string): string =>\n' +
        '  `${inner}<a href="{{unsubscribe_url}}">Unsubscribe</a><p>{{postal_address}}</p>`;\n',
    );

    const result = await doctor(dir);
    expect(result.err).not.toContain('wrapperProvides');
    expect(result.out).toContain('wrapper chain (welcome): 2 file(s)');
  });

  it('warns on a declared token found nowhere, naming it and the files searched', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url', 'postal_address']) });
    write(
      dir,
      'lib/email/welcome.ts',
      'export function welcome(): string {\n  return `<h1>Hello</h1><p>{{postal_address}}</p>`;\n}\n',
    );

    const result = await doctor(dir);
    expect(result.err).toContain('"unsubscribe_url"');
    expect(result.err).toContain('lib/email/welcome.ts');
    // The token that IS there is not reported.
    expect(result.err).not.toContain('"postal_address"');
    // This chain was walked whole — the file imports nothing — so the token is
    // honestly unfound and the line explains nothing it cannot support. The
    // boundary clause here would excuse a real false claim.
    expect(result.out).toContain('wrapper chain (welcome): 1 file(s), 2 declared token(s), 1 unfound');
    expect(result.out).not.toContain('the chain reaches an import it does not follow');
    // Doctor reports; it does not gate.
    expect(result.code).toBe(0);
  });

  it('does not let a COMMENT satisfy a wrapper claim', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url', 'postal_address']) });
    write(
      dir,
      'lib/email/welcome.ts',
      '// TODO: emit unsubscribe_url from the frame one day\n' +
        'export function welcome(): string {\n  return `<h1>Hello</h1><p>{{postal_address}}</p>`;\n}\n',
    );

    const result = await doctor(dir);
    // The token IS in the file — the plain-text grep this replaced called the
    // claim satisfied, which is the false negative that matters here.
    expect(result.err).toContain('"unsubscribe_url"');
    // The one that really is emitted still passes.
    expect(result.err).not.toContain('"postal_address"');
    expect(result.code).toBe(0);
  });

  it('accepts the token as a template span, as a string, or as an identifier', async () => {
    const dir = project(
      {
        spanned: MARKETING(['unsubscribe_url'], 'lib/email/spanned.ts'),
        stringy: MARKETING(['unsubscribe_url'], 'lib/email/stringy.ts'),
        named: MARKETING(['unsubscribe_url'], 'lib/email/named.ts'),
      },
      // The postal half satisfied by the footer key, so these assertions are
      // about the wrapper claim alone.
      { brand__footer_address: '123 Nowhere Lane, Springfield' },
    );
    // Content inside a template literal — the href form a frame really emits,
    // and the reason the slot predicate is the wrong one to reuse here.
    write(
      dir,
      'lib/email/spanned.ts',
      'export function spanned(inner: string): string {\n' +
        '  return `<a href="{{unsubscribe_url}}">${inner}</a>`;\n}\n',
    );
    // The same content as a plain string.
    write(
      dir,
      'lib/email/stringy.ts',
      "const href = '{{unsubscribe_url}}';\n" +
        'export function stringy(): string {\n  return `<a href="${href}">Unsubscribe</a>`;\n}\n',
    );
    // And the token as a NAME the code reads.
    write(
      dir,
      'lib/email/named.ts',
      'export function named(props: { unsubscribe_url: string }): string {\n' +
        '  return `<a href="${props.unsubscribe_url}">Unsubscribe</a>`;\n}\n',
    );

    const result = await doctor(dir);
    expect(result.err).not.toContain('wrapperProvides');
    expect(result.code).toBe(0);
  });

  it('does not let a props-TYPE member satisfy a wrapper claim', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url']) }, { brand__footer_address: '123 Nowhere Lane' });
    write(
      dir,
      'lib/email/welcome.ts',
      "import { frame } from './frame';\n" +
        'export function welcome(): string {\n  return frame(`<h1>Hello</h1>`);\n}\n',
    );
    // The frame TYPES the token and emits nothing. A props-type member is a
    // declaration — the same reasoning that keeps scan's slot predicate out of
    // type positions, and the whole gap between claiming a token and carrying
    // one.
    write(
      dir,
      'lib/email/frame.ts',
      'export interface FrameProps {\n  unsubscribe_url: string;\n}\n' +
        'export const frame = (inner: string): string => `<div>${inner}</div>`;\n',
    );

    const result = await doctor(dir);
    expect(result.err).toContain('"unsubscribe_url"');
    expect(result.err).toContain('lib/email/frame.ts');
    expect(result.code).toBe(0);
  });

  it('does not let a DESTRUCTURED binding satisfy a wrapper claim', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url']) }, { brand__footer_address: '123 Nowhere Lane' });
    write(
      dir,
      'lib/email/welcome.ts',
      "import { frame } from './frame';\n" +
        'export function welcome(): string {\n  return frame({ inner: `<h1>Hello</h1>` });\n}\n',
    );
    // The frame takes the token apart from its props and then does nothing with
    // it: a binding is a declaration of a local name, not an emission.
    write(
      dir,
      'lib/email/frame.tsx',
      'export function frame({ inner, unsubscribe_url }: { inner: string; unsubscribe_url: string }) {\n' +
        '  return `<div>${inner}</div>`;\n}\n',
    );

    const result = await doctor(dir);
    expect(result.err).toContain('"unsubscribe_url"');
    expect(result.code).toBe(0);
  });

  it('follows a re-export barrel to the frame, both routes reaching the same claim', async () => {
    // A component directory's `index.ts` is how most host code reaches its
    // frame. A walk that stopped at the barrel would report every token the
    // frame carries as missing from a chain that never opened the frame.
    const dir = project({
      barrel: MARKETING(['unsubscribe_url', 'postal_address'], 'lib/email/barrel-mail.ts'),
      direct: MARKETING(['unsubscribe_url', 'postal_address'], 'lib/email/direct-mail.ts'),
    });
    write(
      dir,
      'lib/email/components/footer.ts',
      'export function Footer(props: { unsubscribe_url: string }): string {\n' +
        '  return `<a href="${props.unsubscribe_url}">Unsubscribe</a><p>1 Example Street — postal_address</p>`;\n}\n',
    );
    write(dir, 'lib/email/components/index.ts', "export { Footer } from './footer';\n");
    write(
      dir,
      'lib/email/barrel-mail.ts',
      "import { Footer } from './components';\n" +
        'export function BarrelMail(props: { unsubscribe_url: string }): string {\n  return Footer(props);\n}\n',
    );
    write(
      dir,
      'lib/email/direct-mail.ts',
      "import { Footer } from './components/footer';\n" +
        'export function DirectMail(props: { unsubscribe_url: string }): string {\n  return Footer(props);\n}\n',
    );

    const result = await doctor(dir);
    expect(result.err).not.toContain('wrapperProvides');
    expect(result.err).not.toContain('postal address is required');
    // The barrel route reads one more file than the direct one and answers the
    // same, which is the whole point.
    expect(result.out).toContain('wrapper chain (barrel): 3 file(s), 2 declared token(s)');
    expect(result.out).toContain('wrapper chain (direct): 2 file(s), 2 declared token(s)');
  });

  it('counts a token UNCHECKED where the chain reaches a package boundary', async () => {
    const dir = project({ welcome: MARKETING(['unsubscribe_url']) }, { brand__footer_address: '1 Any Road' });
    // The frame is a package's, so the file that would carry the token is
    // exactly the one this walk does not open — warning here would be crying
    // wolf on every react-email project.
    write(
      dir,
      'lib/email/welcome.ts',
      "import { Html } from '@react-email/components';\n" +
        'export function welcome(): string {\n  return Html(`<h1>Hello</h1>`);\n}\n',
    );

    const result = await doctor(dir);
    expect(result.out).toContain('1 unchecked');
    expect(result.out).toContain('the chain reaches an import it does not follow');
    expect(result.err).not.toContain('wrapperProvides');
    expect(result.code).toBe(0);
  });

  it('warns a marketing template with no postal address in the chain or the footer key', async () => {
    const dir = project({ welcome: MARKETING([]) });
    write(dir, 'lib/email/welcome.ts', 'export function welcome(): string {\n  return `<h1>Hello</h1>`;\n}\n');

    const result = await doctor(dir);
    expect(result.err).toContain('postal address is required');
    expect(result.err).toContain('brand__footer_address');
  });

  it('stays quiet where the footer key carries the address', async () => {
    const dir = project({ welcome: MARKETING([]) }, { brand__footer_address: '123 Nowhere Lane, Springfield' });
    write(dir, 'lib/email/welcome.ts', 'export function welcome(): string {\n  return `<h1>Hello</h1>`;\n}\n');

    const result = await doctor(dir);
    expect(result.err).not.toContain('postal address is required');
  });

  it('exempts a transactional template from postal, but not from a false claim', async () => {
    const dir = project({
      receipt: {
        class: 'transactional',
        trigger: 'manual',
        slots: ['headline'],
        wrapperProvides: ['unsubscribe_url'],
        render: { file: 'lib/email/receipt.ts', export: 'receipt', sampleProps: {} },
      },
    });
    write(dir, 'lib/email/receipt.ts', 'export function receipt(): string {\n  return `<h1>Thanks</h1>`;\n}\n');

    const result = await doctor(dir);
    // A receipt needs no unsubscribe link and no postal address…
    expect(result.err).not.toContain('postal address is required');
    // …but a claim it makes is still a claim, and this one is not true.
    expect(result.err).toContain('"unsubscribe_url"');
  });

  it('says nothing about a template with no render pointer', async () => {
    const dir = project({
      manual: { class: 'marketing', trigger: 'manual', slots: ['headline'], wrapperProvides: ['unsubscribe_url'] },
    });

    const result = await doctor(dir);
    expect(result.out).not.toContain('wrapper chain');
    expect(result.err).not.toContain('unsubscribe_url');
  });
});

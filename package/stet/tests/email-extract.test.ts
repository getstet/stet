/**
 * The extraction proposer. Two things are being proven: that the proposal is
 * the whole declaration (entry, slots, key definitions with their variable
 * whitelists, the render pointer, the shell rewrite), and that every shape it
 * cannot read routes to a NAMED skip — each one produced by a fixture, because
 * a taxonomy entry nobody has driven is a claim, not a behavior.
 *
 * The seeding assertions are byte assertions on purpose. A slot's stored value
 * is what the shell renders in place of the text it replaced, so a collapsed
 * double space or a non-breaking space rewritten to an ordinary one is a silent
 * change to somebody's email — `tests/email-verify.test.ts` closes the loop by
 * rendering both sides.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { check } from '../cli/check.js';
import { proposeTemplates, runEmailExtract, type ProposalSet } from '../cli/email-extract.js';
import { defaultConfig, loadConfig, type StetConfig } from '../cli/config.js';
import { packageRoot } from '../cli/installed.js';
import { runCli, type CliIo } from '../cli/main.js';
import { CliError, Report, UsageError } from '../cli/report.js';
import { resolve } from '../src/resolve.js';
import { loadSnapshot, type Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { cleanupEmailHosts, makeEmailHost, type EmailHost } from './helpers/email-host.js';

afterAll(cleanupEmailHosts);

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** `tsc --noEmit` over a host, compiling exactly the program the caller names. */
function tscHost(
  host: EmailHost,
  include: string[],
  extra: Record<string, unknown> = {},
): { ok: boolean; output: string } {
  host.put(
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          jsx: 'react-jsx',
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
          skipLibCheck: true,
          ...extra,
        },
        include,
      },
      null,
      2,
    )}\n`,
  );
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
      cwd: host.dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output: '' };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/**
 * `tsc --noEmit` over one emitted shell, in the host it was written for.
 *
 * Byte equality is NOT enough to know a rewrite is sound: `transpileModule`
 * error-recovers, so a shell with a syntax error still renders — and renders
 * IDENTICALLY — while the host's own build refuses it. Only a real compiler
 * answers the question this asserts, so do not drop it as redundant.
 */
function typechecks(host: EmailHost, rel: string, shell: string): { ok: boolean; output: string } {
  host.put(rel, shell);
  return tscHost(host, [rel]);
}

function read(host: EmailHost, rel: string): string {
  return readFileSync(host.path(rel), 'utf8');
}

function readJson(host: EmailHost, rel: string): Record<string, unknown> {
  return JSON.parse(read(host, rel)) as Record<string, unknown>;
}

const NBSP = String.fromCharCode(160);

/** The Mirra specimen the migration recipe was proven on, verbatim. */
const WELCOME =
  "import { baseTemplate } from '../base';\n" +
  '\n' +
  'export interface WelcomeProps {\n' +
  '  name: string;\n' +
  '  loginUrl: string;\n' +
  '}\n' +
  '\n' +
  'export function welcome(props: WelcomeProps): { subject: string; html: string } {\n' +
  '  return {\n' +
  '    subject: `Welcome to Mirra, ${props.name}`,\n' +
  '    html: baseTemplate(\n' +
  '      `<h1>Good to see you, ${props.name}</h1><p>Your week, sorted. Click below to begin.</p><a href="${props.loginUrl}">Open your dashboard</a>`,\n' +
  '    ),\n' +
  '  };\n' +
  '}\n';

const BASE = "export const baseTemplate = (inner: string): string => `<html><body>${inner}</body></html>`;\n";

function descriptorWith(templates: Descriptor['templates'] = {}): Descriptor {
  return { version: 1, keys: {}, templates };
}

async function propose(
  host: EmailHost,
  globs: string[],
  descriptor: Descriptor = descriptorWith(),
  config: StetConfig = defaultConfig(),
): Promise<ProposalSet> {
  const io: CliIo = { cwd: host.dir, env: {}, stdout: () => {}, stderr: () => {} };
  return proposeTemplates(io, config, descriptor, globs, globs);
}

/** A host holding one template file, plus the shared frame it imports. */
function hostWith(rel: string, text: string): EmailHost {
  const host = makeEmailHost({ deps: [] });
  host.put('lib/email/base.ts', BASE);
  host.put(rel, text);
  return host;
}

describe('extract — the string-template shape', () => {
  it('proposes the whole declaration and the shell, and writes none of it', async () => {
    const host = hostWith('lib/email/templates/welcome.ts', WELCOME);
    const set = await propose(host, ['lib/email/templates/*.ts']);

    expect(set.skips).toEqual([]);
    const proposal = set.proposals[0];
    expect(set.proposals).toHaveLength(1);
    expect(proposal?.name).toBe('welcome');

    // class and trigger have no mechanical source — defaulted, for review.
    expect(proposal?.entry.class).toBe('transactional');
    expect(proposal?.entry.trigger).toBe('manual');
    expect(proposal?.entry.slots).toEqual(['subject', 'headline', 'body', 'cta_label']);

    // The render pointer's stub is read off the signature.
    expect(proposal?.entry.render).toEqual({
      file: 'lib/email/templates/welcome.ts',
      export: 'welcome',
      sampleProps: { name: 'sample-name', loginUrl: 'https://example.com/loginUrl' },
    });

    // One slot per text run, with `${props.name}` shown as `{{name}}`.
    expect(proposal?.slots).toEqual([
      { slot: 'subject', key: 'welcome__subject', value: 'Welcome to Mirra, {{name}}', vars: ['name'] },
      { slot: 'headline', key: 'welcome__headline', value: 'Good to see you, {{name}}', vars: ['name'] },
      { slot: 'body', key: 'welcome__body', value: 'Your week, sorted. Click below to begin.', vars: [] },
      { slot: 'cta_label', key: 'welcome__cta_label', value: 'Open your dashboard', vars: [] },
    ]);

    // Every flattened key is written WITH its definition, `vars` naming exactly
    // what the slot lifted — an undeclared `{{name}}` is a save-gate rejection.
    expect(proposal?.keys['welcome__subject']).toEqual({ shape: 'text', target: 'html-email', vars: ['name'] });
    expect(proposal?.keys['welcome__body']).toEqual({ shape: 'text', target: 'html-email' });

    // The shell: one interpolation per gap, the props type widened, and the
    // `href` interpolation untouched — it was never inside a text run.
    expect(proposal?.edited).toBe(
      "import { baseTemplate } from '../base';\n" +
        '\n' +
        'export interface WelcomeProps {\n' +
        '  name: string;\n' +
        '  loginUrl: string;\n' +
        '  welcome__subject: string;\n' +
        '  welcome__headline: string;\n' +
        '  welcome__body: string;\n' +
        '  welcome__cta_label: string;\n' +
        '}\n' +
        '\n' +
        'export function welcome(props: WelcomeProps): { subject: string; html: string } {\n' +
        '  return {\n' +
        '    subject: props.welcome__subject,\n' +
        '    html: baseTemplate(\n' +
        '      `<h1>${props.welcome__headline}</h1><p>${props.welcome__body}</p><a href="${props.loginUrl}">${props.welcome__cta_label}</a>`,\n' +
        '    ),\n' +
        '  };\n' +
        '}\n',
    );

    // Nothing was written: the file on disk still holds its own bytes.
    expect(read(host, 'lib/email/templates/welcome.ts')).toBe(WELCOME);
    expect(proposal?.source).toBe(WELCOME);
  });

  it('never lifts an imported component’s text', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put(
      'lib/email/footer.ts',
      'export const footer = (): string => `<p>Mirra, 123 Nowhere Lane. You are receiving this because you signed up.</p>`;\n',
    );
    host.put(
      'lib/email/templates/notice.ts',
      "import { footer } from '../footer';\n" +
        'export function notice(props: { name: string }): string {\n' +
        '  return `<h1>Hello ${props.name}</h1>` + footer();\n' +
        '}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const proposal = set.proposals[0];
    expect(proposal?.slots.map((s) => s.value)).toEqual(['Hello {{name}}']);
    expect(proposal?.edited).toContain("import { footer } from '../footer';");
    expect(proposal?.edited).toContain('footer()');
    expect(proposal?.edited).not.toContain('Nowhere Lane');
  });
});

describe('extract — the JSX shape', () => {
  it('proposes one interpolation per gap and leaves attribute text shell', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put(
      'emails/digest.tsx',
      "import * as React from 'react';\n" +
        'export interface DigestProps {\n' +
        '  count: number;\n' +
        '  archiveUrl: string;\n' +
        '}\n' +
        'export function Digest(props: DigestProps): React.ReactElement {\n' +
        '  return (\n' +
        '    <html>\n' +
        '      <body>\n' +
        '        <h1>Your weekly digest</h1>\n' +
        '        <p>{props.count} updates are waiting for you.</p>\n' +
        '        <img src="/logo.png" alt="The Mirra logo, a small bird" />\n' +
        '        <a href={props.archiveUrl}>Read the archive</a>\n' +
        '      </body>\n' +
        '    </html>\n' +
        '  );\n' +
        '}\n',
    );
    const set = await propose(host, ['emails/*.tsx']);
    const proposal = set.proposals[0];
    expect(set.skips).toEqual([]);
    expect(proposal?.slots).toEqual([
      { slot: 'headline', key: 'digest__headline', value: 'Your weekly digest', vars: [] },
      { slot: 'body', key: 'digest__body', value: '{{count}} updates are waiting for you.', vars: ['count'] },
      { slot: 'cta_label', key: 'digest__cta_label', value: 'Read the archive', vars: [] },
    ]);

    // The alt text is copy a scan would report, and shell to extract: an
    // attribute is not a text run in either template shape.
    expect(proposal?.slots.some((s) => s.value.includes('small bird'))).toBe(false);
    expect(proposal?.edited).toContain('alt="The Mirra logo, a small bird"');

    // One expression per gap — the text node and the interpolation beside it
    // become a single child, never two adjacent ones.
    expect(proposal?.edited).toContain('<p>{props.digest__body}</p>');
    expect(proposal?.edited).toContain('<h1>{props.digest__headline}</h1>');
    expect(proposal?.edited).toContain('<a href={props.archiveUrl}>{props.digest__cta_label}</a>');
    expect(proposal?.edited).toContain('  digest__headline: string;');
  });

  it('points a default-exported template at `default`, not at the function’s name', async () => {
    // `export default function Digest` transpiles to `exports.default` and
    // nothing else, so a pointer naming `Digest` fails every render — the
    // pointer names the MODULE's export, and the descriptor name still comes
    // from the file.
    const host = makeEmailHost({ deps: [] });
    host.put(
      'emails/digest.tsx',
      "import * as React from 'react';\n" +
        'export default function Digest(props: { count: number }): React.ReactElement {\n' +
        '  return (\n' +
        '    <div>\n' +
        '      <h1>Your weekly digest</h1>\n' +
        '      <p>{props.count} updates are waiting.</p>\n' +
        '    </div>\n' +
        '  );\n' +
        '}\n',
    );
    const set = await propose(host, ['emails/*.tsx']);
    expect(set.proposals[0]?.name).toBe('digest');
    expect(set.proposals[0]?.entry.render?.export).toBe('default');
  });

  it('points an ANONYMOUS default at `default` as well', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put(
      'emails/notice.tsx',
      "import * as React from 'react';\n" +
        'export default function (props: { name: string }): React.ReactElement {\n' +
        '  return <p>Hello {props.name}, this is a notice.</p>;\n' +
        '}\n',
    );
    const set = await propose(host, ['emails/*.tsx']);
    expect(set.proposals[0]?.entry.render?.export).toBe('default');
  });

  it('seeds a non-breaking space and same-line spacing exactly as rendered', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put(
      'emails/spacing.tsx',
      "import * as React from 'react';\n" +
        'export function Spacing(): React.ReactElement {\n' +
        '  return (\n' +
        '    <html>\n' +
        '      <body>\n' +
        '        <h1> Leading and trailing spaces </h1>\n' +
        '        <p>Doubled  spaces&nbsp;and an &amp; ampersand</p>\n' +
        '        <div>\n' +
        '          A multi-line run\n' +
        '          that wraps with indentation\n' +
        '        </div>\n' +
        '      </body>\n' +
        '    </html>\n' +
        '  );\n' +
        '}\n',
    );
    const set = await propose(host, ['emails/*.tsx']);
    const values = set.proposals[0]?.slots.map((s) => s.value);
    expect(values).toEqual([
      ' Leading and trailing spaces ',
      `Doubled  spaces${NBSP}and an & ampersand`,
      'A multi-line run that wraps with indentation',
    ]);
  });
});

describe('extract — the skip taxonomy, every reason produced', () => {
  const reasonFor = async (rel: string, text: string, descriptor?: Descriptor): Promise<string> => {
    const host = hostWith(rel, text);
    const glob = `${rel.replace(/[^/]+$/, '*')}${rel.split('.').pop() ?? 'ts'}`;
    const set = await propose(host, [glob], descriptor ?? descriptorWith());
    return set.skips[0]?.reason ?? `NO SKIP (${set.proposals.length} proposals)`;
  };

  it('no-template-export: an object of functions is not a template export', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/mailers.ts',
        'export const mailers = {\n  welcome: (): string => `<p>Hello</p>`,\n};\n',
      ),
    ).toBe('no-template-export');
  });

  it('ambiguous-exports: several markup exports and no default', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/pair.ts',
        'export function one(): string {\n  return `<p>One</p>`;\n}\n' +
          'export function two(): string {\n  return `<p>Two</p>`;\n}\n',
      ),
    ).toBe('ambiguous-exports');
  });

  it('unliftable-interpolation: a nested path inside a text run', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/nested.ts',
        'export function nested(props: { user: string }): string {\n' +
          '  return `<p>Hello ${props.user.trim()}</p>`;\n' +
          '}\n',
      ),
    ).toBe('unliftable-interpolation');
  });

  it('interleaved-markup: a sentence split by an inline element', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/rich.ts',
        'export function rich(): string {\n' +
          '  return `<p>Hello <strong>Ada</strong>, welcome aboard</p>`;\n' +
          '}\n',
      ),
    ).toBe('interleaved-markup');
  });

  it('lifts the clean runs and leaves only the split sentence as shell', async () => {
    // The refusal is the SENTENCE's, not the file's. Every real template the
    // lab met carries one footer line of the `<a>Unsubscribe</a> from …` shape
    // beside paragraphs that lift perfectly well, and refusing the file over it
    // stranded all of them.
    const host = hostWith(
      'lib/email/templates/mixed.ts',
      'export function mixed(): string {\n' +
        '  return `<h1>Your subscription has ended</h1>' +
        '<p>Everything you saved is still there.</p>' +
        '<p><a href="https://x.test/u">Unsubscribe</a> from these updates.</p>`;\n' +
        '}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    expect(set.skips).toEqual([]);
    const proposal = set.proposals[0];
    expect(proposal?.slots.map((s) => s.value)).toEqual([
      'Your subscription has ended',
      'Everything you saved is still there.',
    ]);
    // The split sentence is reported rather than dropped silently, and neither
    // half of it is rewritten.
    expect(proposal?.notes.join(' ')).toContain('part of a sentence split by inline markup');
    expect(proposal?.edited).toContain('>Unsubscribe</a> from these updates.');
  });

  it('interleaved-markup: a numbered catalog placeholder', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/catalog.ts',
        'export function catalog(props: { name: string }): string {\n' +
          '  return `<p>Hello <0>${props.name}</0>, welcome</p>`;\n' +
          '}\n',
      ),
    ).toBe('interleaved-markup');
  });

  it('unresolvable-prop-type: a props type that is not primitive members', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/rich-props.ts',
        "import type { User } from '../types';\n" +
          'export function richProps(props: { user: User }): string {\n' +
          '  return `<p>Hello there</p>`;\n' +
          '}\n',
      ),
    ).toBe('unresolvable-prop-type');
  });

  it('unresolvable-prop-type: a POSITIONAL parameter says so, not "cannot read to primitives"', async () => {
    // Mirra's `base.ts` is this shape — `baseTemplate(content: string, …)`, a
    // frame rather than a template. Telling its author their props members are
    // unreadable sends them looking at members nobody wrote.
    const host = hostWith(
      'lib/email/templates/frame.ts',
      'export const frame = (content: string, preheader?: string): string =>\n' +
        '  `<html><body><h1>Your weekly brief</h1>${content}</body></html>`;\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const skip = set.skips[0];
    expect(skip?.reason).toBe('unresolvable-prop-type');
    expect(skip?.detail).toContain('a positional parameter rather than one object of named props');
    expect(skip?.detail).toContain('content: string');
  });

  it('unsupported-import-alias: a specifier the renderer would not resolve', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/aliased.ts',
        "import { frame } from '~/email/frame';\n" +
          'export function aliased(): string {\n' +
          '  return frame(`<p>Hello there</p>`);\n' +
          '}\n',
      ),
    ).toBe('unsupported-import-alias');
  });

  it('already-declared: a hand-written entry survives untouched', async () => {
    const declared = descriptorWith({
      welcome: { class: 'marketing', trigger: 'form', slots: ['subject'] },
    });
    expect(await reasonFor('lib/email/templates/welcome.ts', WELCOME, declared)).toBe('already-declared');
  });

  it('name-collision: a flattened slot name is already a descriptor key', async () => {
    const taken: Descriptor = { version: 1, keys: { welcome__subject: { shape: 'text', target: 'html-email' } } };
    expect(await reasonFor('lib/email/templates/welcome.ts', WELCOME, taken)).toBe('name-collision');
  });

  it('unwritable-props-type: a JavaScript export with no props contract to widen', async () => {
    // The concrete meaning of the reason: stet never writes a type annotation
    // into a `.js` file, and an export taking no props has nowhere else to
    // receive its slots. A `.ts` file in the same shape gains the parameter.
    expect(
      await reasonFor('lib/email/templates/plain.js', 'export function plain() {\n  return `<h1>Static</h1>`;\n}\n'),
    ).toBe('unwritable-props-type');
    expect(
      await reasonFor('lib/email/templates/plain.ts', 'export function plain(): string {\n  return `<h1>Static</h1>`;\n}\n'),
    ).toBe('NO SKIP (1 proposals)');
  });

  it('unresolvable-prop-type: a JavaScript export whose props carry no type at all', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/named.js',
        'export function named(props) {\n  return `<h1>Hi ${props.name}</h1>`;\n}\n',
      ),
    ).toBe('unresolvable-prop-type');
  });

  it('i18n-copy: the template’s copy lives in a message catalog', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/i18n.tsx',
        "import * as React from 'react';\nimport { Trans } from '@lingui/react';\n" +
          'export function I18n(): React.ReactElement {\n' +
          '  return <html><body><h1><Trans>Welcome aboard</Trans></h1></body></html>;\n' +
          '}\n',
      ),
    ).toBe('i18n-copy');
    expect(
      await reasonFor(
        'lib/email/templates/tcall.tsx',
        "import * as React from 'react';\nimport { t } from '@lingui/macro';\n" +
          'export function TCall(): React.ReactElement {\n' +
          "  return <html><body><p>{t('welcome.headline')}</p></body></html>;\n" +
          '}\n',
      ),
    ).toBe('i18n-copy');
    // The TAGGED-TEMPLATE form, which is how Lingui's macros are ordinarily
    // written — a string shape and a JSX one.
    expect(
      await reasonFor(
        'lib/email/templates/tagged.ts',
        "import { t } from '@lingui/macro';\n" +
          'export function tagged(props: { name: string }): string {\n' +
          '  return t`<h1>Hello ${props.name}</h1>`;\n' +
          '}\n',
      ),
    ).toBe('i18n-copy');
    expect(
      await reasonFor(
        'lib/email/templates/tagged.tsx',
        "import * as React from 'react';\nimport { msg } from '@lingui/macro';\n" +
          'export function Tagged(): React.ReactElement {\n' +
          '  return <html><body><p>{msg`Welcome aboard`}</p></body></html>;\n' +
          '}\n',
      ),
    ).toBe('i18n-copy');
  });

  it('ambiguous-exports: markup returned from more than one branch', async () => {
    expect(
      await reasonFor(
        'lib/email/templates/branchy.ts',
        'export function branchy(props: { name: string }): string {\n' +
          '  if (props.name) return `<h1>Hello ${props.name}</h1>`;\n' +
          '  return `<h1>Hello there</h1>`;\n' +
          '}\n',
      ),
    ).toBe('ambiguous-exports');
  });

  it('a non-markup return is a guard, not a branch', async () => {
    // `return ''` used to take the whole file down with it: the finder read the
    // first return rather than the set of returns that carry markup.
    expect(
      await reasonFor(
        'lib/email/templates/guarded.ts',
        'export function guarded(props: { name: string }): string {\n' +
          "  if (props.name === '') return '';\n" +
          '  return `<h1>Hello ${props.name}</h1>`;\n' +
          '}\n',
      ),
    ).toBe('NO SKIP (1 proposals)');
  });
});

describe('extract — what is not copy', () => {
  it('leaves a bare string argument as shell and says why', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put('lib/email/base.ts', 'export const frame = (id: string, inner: string): string => `<html id="${id}">${inner}</html>`;\n');
    host.put(
      'lib/email/templates/idd.ts',
      "import { frame } from '../base';\n" +
        'export function idd(props: { name: string }): string {\n' +
        '  return frame(`welcome-email`, `<h1>Hello ${props.name}</h1>`);\n' +
        '}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const proposal = set.proposals[0];
    expect(proposal?.slots.map((s) => s.value)).toEqual(['Hello {{name}}']);
    expect(proposal?.notes.join(' ')).toContain('carries no markup and names no template member');
    expect(proposal?.edited).toContain('`welcome-email`');
  });

  it('keeps a comparison inside its sentence rather than reading it as a tag', async () => {
    // `5 < 6` is prose. Splitting the run there truncated the slot and stranded
    // the rest of the sentence in what the segmenter had called a tag.
    const host = hostWith(
      'lib/email/templates/math.ts',
      'export function math(): string {\n  return `<p>Only if 5 < 6 holds</p>`;\n}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    expect(set.proposals[0]?.slots.map((s) => s.value)).toEqual(['Only if 5 < 6 holds']);
  });

  it('never seeds a value its own offline check rejects', async () => {
    const host = hostWith(
      'lib/email/templates/merge.ts',
      'export function merge(): string {\n' +
        '  return `<h1>Hello {{first_name}}</h1><p>Plain copy.</p>`;\n' +
        '}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const proposal = set.proposals[0];
    // The host's own merge token is not a variable this key declares, so the
    // save gate rejects it — that run stays shell, and the clean one proposes.
    expect(proposal?.slots.map((s) => s.value)).toEqual(['Plain copy.']);
    expect(proposal?.notes.join(' ')).toContain('undeclared variable {{first_name}}');
    expect(proposal?.edited).toContain('<h1>Hello {{first_name}}</h1>');
  });

  it('leaves a <style> body shell, and the real paragraph keeps the body name', async () => {
    const host = hostWith(
      'lib/email/templates/styled.ts',
      'export function styled(props: { name: string }) {\n' +
        '  return {\n' +
        '    subject: `Your receipt`,\n' +
        '    html: `<html><head><style>body { font-family: Helvetica, Arial; color: #222; }</style></head>' +
        '<body><!-- preheader: keep this out of the dashboard --><h1>Your receipt</h1>' +
        '<p>Thanks ${props.name}, here is your receipt.</p></body></html>`,\n' +
        '  };\n' +
        '}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const proposal = set.proposals[0];

    // No stored value is a stylesheet, and none is the comment's note to the
    // next developer either.
    expect(proposal?.slots.map((s) => s.value)).toEqual([
      'Your receipt',
      'Your receipt',
      'Thanks {{name}}, here is your receipt.',
    ]);
    expect(proposal?.slots.map((s) => s.value).join(' ')).not.toContain('preheader');
    // The naming displacement heals: the CSS took `body` and pushed the real
    // paragraph to `body_2`, and refusing the run before a name is claimed is
    // what gives the paragraph its own name back.
    expect(proposal?.slots.map((s) => s.slot)).toEqual(['subject', 'headline', 'body']);
    expect(proposal?.notes.join(' ')).toContain('<style>');
    expect(proposal?.notes.join(' ')).toContain('code, not copy');
    // The shell carries the stylesheet exactly as the author wrote it.
    expect(proposal?.edited).toContain('<style>body { font-family: Helvetica, Arial; color: #222; }</style>');
  });

  it('leaves a <script> body shell rather than making the send editable JavaScript', async () => {
    // The sharpest case: the shell interpolates a stored value straight back
    // inside the `<script>` tag, so a lifted script body is a dashboard field
    // whose contents every send would execute.
    const host = hostWith(
      'lib/email/templates/scripted.ts',
      'export function scripted(props: { name: string }) {\n' +
        '  return {\n' +
        '    html: `<html><head><script>window.trackOpen("abc123");</script></head>' +
        '<body><h1>Hello</h1><p>Hi ${props.name}.</p><noscript>Enable JavaScript</noscript></body></html>`,\n' +
        '  };\n' +
        '}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const proposal = set.proposals[0];

    expect(proposal?.slots.map((s) => s.value)).toEqual(['Hello', 'Hi {{name}}.']);
    expect(proposal?.slots.map((s) => s.slot)).toEqual(['headline', 'body']);
    expect(proposal?.edited).toContain('<script>window.trackOpen("abc123");</script>');
    expect(proposal?.edited).toContain('<noscript>Enable JavaScript</noscript>');
  });

  it('keeps the JSX shape’s style element out of the proposal too', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put(
      'emails/jsxstyle.tsx',
      'export function JsxStyle(props: { name: string }) {\n' +
        '  return (\n' +
        '    <html>\n' +
        '      <head>\n' +
        '        <style>{`body { color: #222; }`}</style>\n' +
        '      </head>\n' +
        '      <body>\n' +
        '        <h1>Jsx headline</h1>\n' +
        '        <p>Hi {props.name}.</p>\n' +
        '      </body>\n' +
        '    </html>\n' +
        '  );\n' +
        '}\n',
    );
    const set = await propose(host, ['emails/*.tsx']);
    const proposal = set.proposals[0];
    expect(proposal?.slots.map((s) => s.value)).toEqual(['Jsx headline', 'Hi {{name}}.']);
    expect(proposal?.edited).toContain('<style>{`body { color: #222; }`}</style>');
  });

  it('widens the props type in the file’s own line endings', async () => {
    // A CRLF file taking LF-joined members back is a mixed-ending file, and the
    // diff a reviewer opens is then the whole file rather than the rewrite.
    const source =
      'export interface NoticeProps {\n  name: string;\n}\n' +
      'export function notice(props: NoticeProps): string {\n' +
      '  return `<h1>Hello ${props.name}</h1>`;\n' +
      '}\n';
    const host = hostWith('lib/email/templates/notice.ts', source.replace(/\n/g, '\r\n'));
    const set = await propose(host, ['lib/email/templates/*.ts']);
    const edited = set.proposals[0]?.edited ?? '';

    expect(edited).toContain('\r\n  notice__headline: string;\r\n');
    // …and not one lone LF anywhere in the result.
    expect(/[^\r]\n/.test(edited)).toBe(false);
  });

  it('leaves an escape-bearing literal whole, and says so when nothing else lifts', async () => {
    const host = hostWith(
      'lib/email/templates/escaped.ts',
      'export function escaped(): string {\n  return `<p>Line one</p>\\n<p>Line two</p>`;\n}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    expect(set.skips[0]?.reason).toBe('no-template-export');
    expect(set.skips[0]?.detail).toContain('backslash escape');
    expect(set.skips[0]?.notes.join(' ')).toContain('left as shell');
  });
});

describe('extract — the shell reads what is actually in scope', () => {
  it('binds the slots into a destructured parameter', async () => {
    const host = makeEmailHost();
    host.put(
      'emails/greet.tsx',
      "import * as React from 'react';\n" +
        'export function Greet({ name }: { name: string }): React.ReactElement {\n' +
        '  return <html><body><h1>Hello {name}</h1></body></html>;\n' +
        '}\n',
    );
    const proposal = (await propose(host, ['emails/*.tsx'])).proposals[0];
    // There is no `props` identifier here, so the shell must not invent one.
    expect(proposal?.edited).toContain('{ name, greet__headline }: { name: string; greet__headline: string; }');
    expect(proposal?.edited).toContain('<h1>{greet__headline}</h1>');
    expect(proposal?.edited).not.toContain('props.');
    expect(typechecks(host, 'emails/greet.tsx', proposal?.edited ?? '').output).toBe('');
  });

  it('binds after a trailing comma without writing a second one', async () => {
    // Prettier writes a trailing comma on a multi-line pattern by default, and
    // `{ name,, welcome__x }` is TS1180 — which transpileModule recovers from,
    // so verify would bless a shell the host's own build refuses.
    for (const [label, param] of [
      ['single-line', '{ name, }: { name: string }'],
      ['multi-line', '{\n  name,\n}: { name: string }'],
    ] as const) {
      const host = makeEmailHost();
      host.put('emails/note.ts', `export function note(${param}): string {\n  return \`<h1>Hi \${name}</h1>\`;\n}\n`);
      const proposal = (await propose(host, ['emails/*.ts'])).proposals[0];
      expect(`${label}: ${proposal?.edited.includes(',,') ?? 'no proposal'}`).toBe(`${label}: false`);
      const check = typechecks(host, 'emails/note.ts', proposal?.edited ?? '');
      expect(`${label}: ${check.output}`).toBe(`${label}: `);
    }
  });

  it('binds in front of a rest element, which must stay last', async () => {
    // The props-forwarding idiom. A rest element is only legal as the final
    // member (TS1180), and object-pattern order carries no meaning otherwise.
    const host = makeEmailHost();
    host.put(
      'emails/fwd.ts',
      'export function fwd({ name, ...rest }: { name: string; id: string }): string {\n' +
        '  return `<h1>Hi ${name}</h1><p>${JSON.stringify(rest)}</p>`;\n' +
        '}\n',
    );
    const proposal = (await propose(host, ['emails/*.ts'])).proposals[0];
    expect(proposal?.edited).toContain('{ name, fwd__headline, ...rest }');
    expect(typechecks(host, 'emails/fwd.ts', proposal?.edited ?? '').output).toBe('');
  });

  it('reads through the parameter’s own name', async () => {
    const host = hostWith(
      'lib/email/templates/note.ts',
      'export function note(p: { name: string }): string {\n  return `<h1>Hi ${p.name}</h1>`;\n}\n',
    );
    const proposal = (await propose(host, ['lib/email/templates/*.ts'])).proposals[0];
    expect(proposal?.edited).toContain('${p.note__headline}');
    expect(proposal?.edited).not.toContain('props.');
  });
});

// --- --apply ----------------------------------------------------------------

/** A host that is also a stet project — the shape `--apply` writes into. */
function projectHost(
  files: Record<string, string>,
  opts: { descriptor?: Descriptor; snapshot?: Snapshot; config?: Record<string, unknown> } = {},
): EmailHost {
  const host = makeEmailHost();
  host.put(
    'stet.config.json',
    `${JSON.stringify({ project: 't', managedSurfaces: [], emailSurfaces: [], ...opts.config }, null, 2)}\n`,
  );
  host.put('content/descriptor.json', `${JSON.stringify(opts.descriptor ?? descriptorWith(), null, 2)}\n`);
  host.put('content/defaults.json', `${JSON.stringify(opts.snapshot ?? { default: {} }, null, 2)}\n`);
  for (const [rel, text] of Object.entries(files)) host.put(rel, text);
  return host;
}

/** The command itself, argv and all — `--apply` is parsed here, not simulated. */
async function run(host: EmailHost, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEmailExtract(args, {
    cwd: host.dir,
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const WELCOME_HOST = { 'lib/email/base.ts': BASE, 'lib/email/templates/welcome.ts': WELCOME };
const WALK = ['lib/email/templates/*.ts'];

describe('extract --apply — the batch', () => {
  it('writes the declaration, the seeds, the codegen, the shell and the surfaces', async () => {
    const host = projectHost(WELCOME_HOST);
    const { code, out } = await run(host, [...WALK, '--apply']);
    expect(code).toBe(0);

    const descriptor = readJson(host, 'content/descriptor.json') as unknown as Descriptor;
    expect(descriptor.templates?.['welcome']).toEqual({
      class: 'transactional',
      trigger: 'manual',
      slots: ['subject', 'headline', 'body', 'cta_label'],
      render: {
        file: 'lib/email/templates/welcome.ts',
        export: 'welcome',
        sampleProps: { name: 'sample-name', loginUrl: 'https://example.com/loginUrl' },
      },
    });
    // Every flattened key lands WITH its definition — a seeded `{{name}}` with
    // no `vars` declaring it is a save-gate rejection on the next editor save.
    expect(descriptor.keys['welcome__subject']).toEqual({ shape: 'text', target: 'html-email', vars: ['name'] });
    expect(descriptor.keys['welcome__body']).toEqual({ shape: 'text', target: 'html-email' });

    const snapshot = readJson(host, 'content/defaults.json');
    expect((snapshot['default'] as Record<string, unknown>)['welcome__subject']).toBe('Welcome to Mirra, {{name}}');

    // The codegen trio rides the key add, so the new keys are usable at once.
    expect(read(host, 'content/keys.ts')).toContain('welcome__headline');
    expect(read(host, 'content/stet-env.d.ts')).toContain('welcome__headline');
    expect(read(host, 'content/defaults.ts')).toContain('Good to see you, {{name}}');

    // The shell rewrite landed in the host's own file.
    expect(read(host, 'lib/email/templates/welcome.ts')).toContain('subject: props.welcome__subject,');
    expect(read(host, 'lib/email/templates/welcome.ts')).toContain('<h1>${props.welcome__headline}</h1>');

    // Both surface lists carry the walked glob: one alone is either never
    // scanned or never email-typed.
    const config = readJson(host, 'stet.config.json');
    expect(config['managedSurfaces']).toEqual(WALK);
    expect(config['emailSurfaces']).toEqual(WALK);

    // The migration recipe's next steps, printed rather than remembered — and
    // the state this run just put the host in, stated rather than implied.
    expect(out).toContain('changed no call site: every caller of these exports fails to typecheck');
    expect(out).toContain('next: stet email verify');
    expect(out).toContain('then: pass the resolved slot values at every call site your typecheck names');
  });

  it('states the host does not compile yet, on every apply that declares anything', async () => {
    // The lab's finding: `verify` PASSES on a host whose build is red, so an
    // adopter who follows the printed recipe to the end can believe they are
    // done. The statement is true by construction — the props type gained the
    // slot members and no call site was touched — so it prints on every apply
    // that landed a template, whatever shape or count.
    const claim = 'changed no call site: every caller of these exports fails to typecheck';
    const one = projectHost(WELCOME_HOST);
    expect((await run(one, [...WALK, '--apply'])).out).toContain(claim);

    const two = projectHost({
      ...WELCOME_HOST,
      'lib/email/templates/notice.ts':
        'export function notice(props: { name: string }): string {\n' +
        '  return `<h1>Hello ${props.name}</h1>`;\n' +
        '}\n',
    });
    expect((await run(two, [...WALK, '--apply'])).out).toContain(claim);

    // …and not on a run that declared nothing, where no type was widened.
    const none = projectHost({
      'lib/email/templates/rich.ts':
        'export function rich(): string {\n  return `<p>Hello <strong>Ada</strong>, welcome</p>`;\n}\n',
    });
    expect((await run(none, [...WALK, '--apply'])).out).not.toContain(claim);
  });

  it('seeds values the offline check passes — the whitelist round trip', async () => {
    const host = projectHost(WELCOME_HOST);
    await run(host, [...WALK, '--apply']);

    const report = new Report();
    check(loadConfig(host.dir), host.dir, report);
    // The seeded `{{name}}` is declared in its key's `vars`, so the variable
    // whitelist passes it; currency and the generated files agree too.
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
  });

  it('regenerates the codegen so the new slot key typechecks with no stet upgrade', async () => {
    const host = projectHost(WELCOME_HOST);
    await run(host, [...WALK, '--apply']);

    const probe = (key: string): string =>
      "import { createAccessor, type Descriptor } from '@getstet/stet';\n" +
      "import descriptorJson from './content/descriptor.json';\n" +
      'const copy = createAccessor(descriptorJson as unknown as Descriptor, {});\n' +
      `export const s: string = copy('${key}');\n`;
    const compile = (key: string): { ok: boolean; output: string } => {
      host.put('probe.ts', probe(key));
      // An include GLOB over content/, as an init'd host has: a `files:` list
      // would hide the ambient `.d.ts` drop the distinct stem exists to avoid.
      return tscHost(host, ['content/**/*.ts', 'probe.ts'], {
        resolveJsonModule: true,
        baseUrl: '.',
        typeRoots: [join(packageRoot(), '..', 'node_modules', '@types')],
        paths: { '@getstet/stet': [join(packageRoot(), 'src', 'index.ts')] },
      });
    };

    expect(compile('welcome__headline').output).toBe('');
    // And the narrowing is real, not a widened string.
    expect(compile('welcome__not_a_slot').ok).toBe(false);
  });

  it('a seeded slot flows to the locale chain, and other locales survive', async () => {
    const host = projectHost(WELCOME_HOST, {
      descriptor: { version: 1, keys: { greeting: { shape: 'text', target: 'html-email' } }, templates: {} },
      snapshot: { default: { greeting: 'Hello' }, de: { greeting: 'Hallo' } },
    });
    await run(host, [...WALK, '--apply']);

    const snapshot = loadSnapshot(readJson(host, 'content/defaults.json'));
    // The non-default block is untouched by a default-locale seed.
    expect(snapshot['de']?.['greeting']).toBe('Hallo');
    // And the seeded slot resolves under `de` through the chain's fallback,
    // which is the form the generated defaults module serves.
    const descriptor = readJson(host, 'content/descriptor.json') as unknown as Descriptor;
    expect(resolve(descriptor, snapshot, null, { key: 'welcome__headline', locale: 'de' }).value).toBe(
      'Good to see you, {{name}}',
    );
    expect(read(host, 'content/defaults.ts')).toContain('Hallo');
  });
});

describe('extract --apply — what it will not do', () => {
  it('leaves a hand-written entry untouched and lands the others', async () => {
    const host = projectHost(
      {
        ...WELCOME_HOST,
        'lib/email/templates/notice.ts':
          'export function notice(props: { name: string }): string {\n' +
          '  return `<h1>Hello ${props.name}</h1>`;\n' +
          '}\n',
      },
      {
        descriptor: descriptorWith({
          welcome: { class: 'marketing', trigger: 'form', slots: ['subject'] },
        }),
      },
    );
    const { err } = await run(host, [...WALK, '--apply']);

    const descriptor = readJson(host, 'content/descriptor.json') as unknown as Descriptor;
    // The declared entry is exactly as it was — class, trigger, slots, and no
    // render pointer bolted on.
    expect(descriptor.templates?.['welcome']).toEqual({ class: 'marketing', trigger: 'form', slots: ['subject'] });
    expect(descriptor.keys['welcome__headline']).toBeUndefined();
    expect(read(host, 'lib/email/templates/welcome.ts')).toBe(WELCOME);
    expect(err).toContain('already-declared');

    // The other proposal still landed.
    expect(descriptor.templates?.['notice']).toBeDefined();
    expect(read(host, 'lib/email/templates/notice.ts')).toContain('props.notice__headline');
  });

  it('writes only the named templates', async () => {
    const host = projectHost({
      ...WELCOME_HOST,
      'lib/email/templates/notice.ts':
        'export function notice(props: { name: string }): string {\n' +
        '  return `<h1>Hello ${props.name}</h1>`;\n' +
        '}\n',
    });
    await run(host, [...WALK, '--apply', 'notice']);

    const descriptor = readJson(host, 'content/descriptor.json') as unknown as Descriptor;
    expect(Object.keys(descriptor.templates ?? {})).toEqual(['notice']);
    expect(read(host, 'lib/email/templates/welcome.ts')).toBe(WELCOME);
  });

  it('names a template that produced no proposal, and why', async () => {
    const host = projectHost(WELCOME_HOST);
    await expect(run(host, [...WALK, '--apply', 'digest'])).rejects.toThrow(/nothing was proposed under that name/);
    // Skipped is a different mistake from never-walked, and says so.
    const skipped = projectHost({
      'lib/email/templates/rich.ts':
        'export function rich(): string {\n  return `<p>Hello <strong>Ada</strong>, welcome</p>`;\n}\n',
    });
    await expect(run(skipped, [...WALK, '--apply', 'rich'])).rejects.toThrow(/skipped \(interleaved-markup\)/);
  });

  it('leaves nothing half-written when a planned write fails', async () => {
    const host = projectHost(WELCOME_HOST);
    const descriptorBefore = read(host, 'content/descriptor.json');
    const snapshotBefore = read(host, 'content/defaults.json');
    // The failure has to land in the WRITE, not in the planning: a target that
    // exists but cannot be read (a directory) refuses the batch before a byte
    // moves, which proves the conflict check rather than the rollback. A
    // DANGLING symlink reads as absent, plans as an ordinary write, and throws
    // only when the write follows it — and it does so on any filesystem and any
    // uid, where a permission bit would not.
    symlinkSync(host.path('content/nope/deep/defaults.ts'), host.path('content/defaults.ts'));

    // The generated defaults module is the fifth plan of the batch, so the
    // descriptor, the snapshot and two codegen modules are already on disk.
    const failure = await run(host, [...WALK, '--apply']).then(
      () => null,
      (error: unknown) => error,
    );

    // A raw ENOENT would reach the terminal as a stack and say nothing about
    // the batch. `CliError` is the exit-1-and-no-stack contract (cli/main.ts
    // maps it), and the message has to name the path AND say the run undid
    // itself — an atomicity promise nobody is told about is not usable.
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as Error).message).toContain(host.path('content/defaults.ts'));
    expect((failure as Error).message).toContain('Every file this run had already written was put back');
    expect((failure as Error).stack).toBeDefined(); // carried, never printed

    expect(read(host, 'content/descriptor.json')).toBe(descriptorBefore);
    expect(read(host, 'content/defaults.json')).toBe(snapshotBefore);
    expect(read(host, 'lib/email/templates/welcome.ts')).toBe(WELCOME);
    // A file the batch created is unlinked again, not left as a stray.
    expect(() => read(host, 'content/keys.ts')).toThrow();

    // The same failure through the DISPATCH, which is where the contract is
    // kept: a caught CliError is one stderr line and exit 1. Asserting on the
    // thrown object alone leaves the mapping in cli/main.ts unproven.
    const dispatched = projectHost(WELCOME_HOST);
    symlinkSync(dispatched.path('content/nope/deep/defaults.ts'), dispatched.path('content/defaults.ts'));
    const err: string[] = [];
    const code = await runCli(['email', 'extract', ...WALK, '--apply'], {
      cwd: dispatched.dir,
      env: {},
      stdout: () => undefined,
      stderr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    // One formatted finding, which is what says the dispatch caught it rather
    // than the error reaching the terminal on its own.
    expect(err[0]).toMatch(/^error: email extract --apply: the write batch failed at /);
  });

  it('names the other file when two in one walk make the same template name', async () => {
    const host = projectHost({
      'lib/email/base.ts': BASE,
      'lib/email/templates/welcome.ts': WELCOME,
      'lib/email/templates/nested/welcome.ts':
        'export function welcome(props: { name: string }): string {\n' +
        '  return `<h1>Hi ${props.name}</h1>`;\n' +
        '}\n',
    });
    const { err } = await run(host, ['lib/email/templates/**/*.ts']);

    // A collision between two PROPOSALS, not the descriptor declaring one:
    // `already-declared` stays exclusively the descriptor's word, so that a
    // reader who sees it knows a hand-written entry is being protected.
    expect(err).toContain('skipped (name-collision)');
    expect(err).toContain('is already proposing the name "welcome"');
    expect(err).toContain('rename one of the two files');
    expect(err).not.toContain('already-declared');
  });

  it('warns when a seed replaces a value the snapshot already held', async () => {
    const host = projectHost(WELCOME_HOST, {
      snapshot: { default: { welcome__headline: 'The copy a human wrote' } },
    });
    const { code, err } = await run(host, [...WALK, '--apply']);

    // The seed still wins — the custody proof compares the SOURCE text, so a
    // seed that disagreed with the file would fail verify by construction.
    expect(readJson(host, 'content/defaults.json')['default']).toMatchObject({
      welcome__headline: 'Good to see you, {{name}}',
    });
    // But the replaced copy is named, so it can be restored after the proof.
    expect(err).toContain('The copy a human wrote');
    expect(err).toContain('restore your own copy once verify is green');
    expect(code).toBe(0); // a warn, not a failure
  });
});

describe('extract --apply — the surface lists', () => {
  it('appends once, keeps the operator’s own settings, and re-runs clean', async () => {
    const host = projectHost(
      {
        ...WELCOME_HOST,
        'lib/email/templates/notice.ts':
          'export function notice(props: { name: string }): string {\n' +
          '  return `<h1>Hello ${props.name}</h1>`;\n' +
          '}\n',
      },
      { config: { managedSurfaces: ['app/**/*.tsx'], futureField: 'kept' } },
    );

    await run(host, [...WALK, '--apply', 'welcome']);
    const first = readJson(host, 'stet.config.json');
    expect(first['managedSurfaces']).toEqual(['app/**/*.tsx', ...WALK]);
    expect(first['emailSurfaces']).toEqual(WALK);
    // A field this command never reads is a field it must not delete: the
    // config is edited as raw JSON, not round-tripped through the parser.
    expect(first['futureField']).toBe('kept');

    // A second run over the same globs adds nothing.
    await run(host, [...WALK, '--apply', 'notice']);
    const second = readJson(host, 'stet.config.json');
    expect(second['managedSurfaces']).toEqual(['app/**/*.tsx', ...WALK]);
    expect(second['emailSurfaces']).toEqual(WALK);
  });

  it('writes a config where a project has none', async () => {
    const host = makeEmailHost();
    host.put('content/descriptor.json', `${JSON.stringify(descriptorWith(), null, 2)}\n`);
    host.put('content/defaults.json', '{"default":{}}\n');
    host.put('lib/email/base.ts', BASE);
    host.put('lib/email/templates/welcome.ts', WELCOME);

    await run(host, [...WALK, '--apply']);
    const config = readJson(host, 'stet.config.json');
    expect(config['emailSurfaces']).toEqual(WALK);
    expect(config['managedSurfaces']).toEqual(WALK);
    // Written with the defaults, so the file is a complete project config.
    expect(config['descriptorPath']).toBe('content/descriptor.json');
  });

  it('records the surfaces even when every file skipped', async () => {
    const host = projectHost({
      'lib/email/templates/rich.ts':
        'export function rich(): string {\n  return `<p>Hello <strong>Ada</strong>, welcome</p>`;\n}\n',
    });
    const { code, out } = await run(host, [...WALK, '--apply']);
    expect(code).toBe(0);

    // Nothing was declarable, but the operator still told stet where the email
    // lives — and those globs are what puts these files in front of `scan` and
    // the declared-but-unrendered-slot warn, which is what a hand-written entry
    // depends on most.
    const config = readJson(host, 'stet.config.json');
    expect(config['emailSurfaces']).toEqual(WALK);
    expect(config['managedSurfaces']).toEqual(WALK);
    expect(out).toContain('recorded 1 email surface');
    // No declaration means no descriptor write.
    expect(readJson(host, 'content/descriptor.json')['templates']).toEqual({});
  });

  it('warns for a rewritten template git has never seen', async () => {
    // The ordering the custody proof rests on: verify reads the file at HEAD,
    // so a template that was never committed has no before, and the rewrite
    // this run writes is what there is.
    const git = (host: EmailHost, ...args: string[]): void => {
      execFileSync('git', args, { cwd: host.dir, stdio: 'pipe' });
    };
    const repo = (host: EmailHost): void => {
      git(host, 'init', '-q');
      git(host, 'config', 'user.email', 'test@example.com');
      git(host, 'config', 'user.name', 'stet test');
      git(host, 'config', 'commit.gpgsign', 'false');
      host.put('.gitignore', 'node_modules\n');
    };

    const untracked = projectHost(WELCOME_HOST);
    repo(untracked);
    // Everything but the template itself is committed.
    git(untracked, 'add', '.gitignore', 'stet.config.json', 'content');
    git(untracked, 'commit', '-q', '-m', 'the project');
    const applied = await run(untracked, [...WALK, '--apply']);
    expect(applied.code).toBe(0);
    expect(applied.err).toContain('lib/email/templates/welcome.ts: git does not track this file');
    expect(applied.err).toContain('Commit template files before extract --apply rewrites them');

    // Committed first: nothing is said, because there is a before.
    const committed = projectHost(WELCOME_HOST);
    repo(committed);
    git(committed, 'add', '-A');
    git(committed, 'commit', '-q', '-m', 'the originals');
    const clean = await run(committed, [...WALK, '--apply']);
    expect(clean.code).toBe(0);
    expect(clean.err).not.toContain('git does not track this file');
  });

  it('drops a blank path rather than walking the whole tree', async () => {
    const host = projectHost(WELCOME_HOST, { config: { emailSurfaces: WALK, managedSurfaces: WALK } });
    const { code } = await run(host, ['', '--apply']);
    expect(code).toBe(0);

    // An empty glob would match from the repo root. The blank is dropped, so
    // the walk falls back to the configured surfaces and the lists gain nothing.
    const config = readJson(host, 'stet.config.json');
    expect(config['emailSurfaces']).toEqual(WALK);
    expect(readJson(host, 'content/descriptor.json')['templates']).toHaveProperty('welcome');
  });

  it('refuses a blank template NAME rather than applying every template', async () => {
    const host = projectHost(
      {
        ...WELCOME_HOST,
        'lib/email/templates/notice.ts':
          'export function notice(props: { name: string }): string {\n' +
          '  return `<h1>Hello ${props.name}</h1>`;\n' +
          '}\n',
      },
      { config: { emailSurfaces: WALK, managedSurfaces: WALK } },
    );

    // `--apply "$TEMPLATE"` with the variable unset. The blank cannot be
    // dropped the way a blank path is: an empty NAME list means "every
    // proposal", so dropping it turns naming one template into writing both —
    // silently, at exit 0, where a name stet cannot find is a refusal.
    await expect(run(host, ['--apply', ''])).rejects.toThrow(/blank template name/);
    await expect(run(host, ['--apply', ' ', 'notice'])).rejects.toThrow(UsageError);

    expect(readJson(host, 'content/descriptor.json')['templates']).toEqual({});
    expect(read(host, 'lib/email/templates/welcome.ts')).toBe(WELCOME);
  });

  it('records nothing where the walk came from the config', async () => {
    const host = projectHost(WELCOME_HOST, { config: { emailSurfaces: WALK, managedSurfaces: WALK } });
    const before = read(host, 'stet.config.json');
    await run(host, ['--apply']);
    // The globs were not NAMED, so there is nothing new to persist — and the
    // file keeps its own formatting rather than being rewritten to say the same.
    expect(read(host, 'stet.config.json')).toBe(before);
    const descriptor = readJson(host, 'content/descriptor.json') as unknown as Descriptor;
    expect(descriptor.templates?.['welcome']).toBeDefined();
  });
});

describe('extract — a skip never stops the walk', () => {
  it('reports the unreadable file and still proposes the readable one', async () => {
    const host = makeEmailHost({ deps: [] });
    host.put('lib/email/base.ts', BASE);
    host.put('lib/email/templates/welcome.ts', WELCOME);
    host.put(
      'lib/email/templates/rich.ts',
      'export function rich(): string {\n  return `<p>Hello <strong>Ada</strong>, welcome</p>`;\n}\n',
    );
    const set = await propose(host, ['lib/email/templates/*.ts']);
    expect(set.proposals.map((p) => p.name)).toEqual(['welcome']);
    expect(set.skips.map((s) => [s.file, s.reason])).toEqual([
      ['lib/email/templates/rich.ts', 'interleaved-markup'],
    ]);
  });
});

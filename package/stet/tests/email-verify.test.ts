/**
 * The custody proof, end to end, against real git repositories.
 *
 * These are deliberately not unit tests of a comparison function: what is being
 * proven is that HEAD's version of a template can be found, materialized where
 * its own imports resolve, executed through the host's compiler and renderer,
 * and compared with the working tree's version byte for byte. Every one of
 * those steps has a way of appearing to work while silently comparing the wrong
 * thing — a before that resolved against the wrong sibling, a git lookup that
 * reported "untracked" because the repository root sat one level up — so each
 * case drives the whole path and asserts the verdict.
 *
 * Most cases run the real migration: commit the original, `stet email extract
 * --apply`, then verify. A pass therefore means the shell extract WROTE renders
 * what the file rendered before it was touched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runEmailExtract } from '../cli/email-extract.js';
import { runEmailVerify } from '../cli/email-verify.js';
import type { CliIo } from '../cli/main.js';
import type { Descriptor } from '../src/types.js';
import { cleanupEmailHosts, makeEmailHost, type EmailHost } from './helpers/email-host.js';

afterAll(cleanupEmailHosts);

const NBSP = String.fromCharCode(160);

const BASE = "export const baseTemplate = (inner: string): string => `<html><body>${inner}</body></html>`;\n";

/** The Mirra specimen the migration recipe was proven on. */
const WELCOME =
  "import { baseTemplate } from '../base';\n" +
  '\n' +
  'export interface WelcomeProps {\n' +
  '  name: string;\n' +
  '}\n' +
  '\n' +
  'export function welcome(props: WelcomeProps): { subject: string; html: string } {\n' +
  '  return {\n' +
  '    subject: `Welcome, ${props.name}`,\n' +
  '    html: baseTemplate(`<h1>Good to see you, ${props.name}</h1><p>Your week, sorted.</p>`),\n' +
  '  };\n' +
  '}\n';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

/** A repository with an identity, no signing, and `node_modules` left out of it. */
function gitInit(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'stet test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n', 'utf8');
}

function commit(dir: string, message = 'the original templates'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/** The stet project files, at whichever root the case puts them. */
function project(put: (rel: string, text: string) => void, descriptor: Descriptor, snapshot: unknown): void {
  put('stet.config.json', `${JSON.stringify({ project: 't', managedSurfaces: [], emailSurfaces: [] }, null, 2)}\n`);
  put('content/descriptor.json', `${JSON.stringify(descriptor, null, 2)}\n`);
  put('content/defaults.json', `${JSON.stringify(snapshot, null, 2)}\n`);
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function verify(cwd: string, args: string[] = []): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { cwd, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = await runEmailVerify(args, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function extract(cwd: string, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { cwd, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  const code = await runEmailExtract(args, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A committed host holding the string-shape specimen, ready to extract. */
function committedHost(files: Record<string, string> = {}): EmailHost {
  const host = makeEmailHost();
  gitInit(host.dir);
  project(host.put, { version: 1, keys: {}, templates: {} }, { default: {} });
  host.put('lib/email/base.ts', BASE);
  host.put('lib/email/templates/welcome.ts', WELCOME);
  for (const [rel, text] of Object.entries(files)) host.put(rel, text);
  commit(host.dir);
  return host;
}

const WALK = ['lib/email/templates/*.ts'];

describe('email verify — the custody proof', () => {
  it('passes byte-exact on the shell extract itself wrote', async () => {
    const host = committedHost();
    const applied = await extract(host.dir, [...WALK, '--apply']);
    expect(applied.code).toBe(0);
    // The rewrite really happened — otherwise this would compare a file with
    // itself and pass for the wrong reason.
    expect(readFileSync(host.path('lib/email/templates/welcome.ts'), 'utf8')).toContain('props.welcome__headline');

    const result = await verify(host.dir);
    expect(result.err).toBe('');
    expect(result.out).toContain('welcome: PASS');
    expect(result.code).toBe(0);
  });

  it('passes byte-exact on a DEFAULT-exported template', async () => {
    const host = makeEmailHost();
    gitInit(host.dir);
    project(host.put, { version: 1, keys: {}, templates: {} }, { default: {} });
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
    commit(host.dir);

    expect((await extract(host.dir, ['emails/*.tsx', '--apply'])).code).toBe(0);
    // The pointer names the MODULE's export: a default export is `exports.default`
    // under the transpile the runner loads through, whatever the function is
    // called in source.
    const descriptor = JSON.parse(readFileSync(host.path('content/descriptor.json'), 'utf8')) as Descriptor;
    expect(descriptor.templates?.['digest']?.render?.export).toBe('default');

    const result = await verify(host.dir);
    expect(result.out).toContain('digest: PASS');
    expect(result.code).toBe(0);

    // A pointer naming the SOURCE name still renders — and the verdict line
    // says which export answered, so a hand-written typo is visible on a
    // template that passes rather than silently forgiven.
    const byHand = JSON.parse(readFileSync(host.path('content/descriptor.json'), 'utf8')) as {
      templates: Record<string, { render: { export: string } }>;
    };
    const pointer = byHand.templates['digest'];
    expect(pointer).toBeDefined();
    (pointer as { render: { export: string } }).render.export = 'Digest';
    host.put('content/descriptor.json', `${JSON.stringify(byHand, null, 2)}\n`);

    const named = await verify(host.dir);
    expect(named.out).toContain('digest: PASS');
    expect(named.out).toContain('export "Digest" is not on the module; rendered its default export');
    expect(named.code).toBe(0);
  });

  it('passes on the JSX shape, non-breaking space and all', async () => {
    const host = makeEmailHost();
    gitInit(host.dir);
    project(host.put, { version: 1, keys: {}, templates: {} }, { default: {} });
    host.put(
      'emails/digest.tsx',
      "import * as React from 'react';\n" +
        'export interface DigestProps {\n  count: number;\n}\n' +
        'export function Digest(props: DigestProps): React.ReactElement {\n' +
        '  return (\n    <html>\n      <body>\n' +
        '        <h1>Your weekly digest</h1>\n' +
        '        <p>Doubled  spaces&nbsp;and {props.count} waiting</p>\n' +
        '      </body>\n    </html>\n  );\n}\n',
    );
    commit(host.dir);

    await extract(host.dir, ['emails/*.tsx', '--apply']);
    const snapshot = JSON.parse(readFileSync(host.path('content/defaults.json'), 'utf8')) as {
      default: Record<string, string>;
    };
    // The seeded value carries a REAL non-breaking space; the proof below is
    // what says rendering it back produces the same bytes React produced.
    expect(snapshot.default['digest__body']).toContain(NBSP);

    const result = await verify(host.dir);
    expect(result.out).toContain('digest: PASS');
    expect(result.code).toBe(0);
  });

  it('finds the before when the git root sits ABOVE the app root', async () => {
    // The ordinary monorepo shape, and Mirra's own: `.git` at the repository
    // root, the app one level down. `git show HEAD:<path>` is repo-root
    // relative and would fail here, routing every template to "untracked";
    // the `./` form is cwd-relative and finds it.
    const host = makeEmailHost();
    gitInit(host.dir);
    const app = join(host.dir, 'frontend');
    mkdirSync(app, { recursive: true });
    const put = (rel: string, text: string): void => {
      const path = join(app, rel);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text, 'utf8');
    };
    // The app root needs its own manifest; `node_modules` resolves by walking
    // up to the host's, exactly as it would in a real workspace.
    put('package.json', `${JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2)}\n`);
    project(put, { version: 1, keys: {}, templates: {} }, { default: {} });
    put('lib/email/base.ts', BASE);
    put('lib/email/templates/welcome.ts', WELCOME);
    commit(host.dir);

    await extract(app, [...WALK, '--apply']);
    const result = await verify(app);
    expect(result.out).toContain('welcome: PASS');
    expect(result.code).toBe(0);
  });

  it('renders the before against the WORKING TREE’s siblings', async () => {
    const host = committedHost();
    await extract(host.dir, [...WALK, '--apply']);
    // The shared wrapper changes AFTER the commit. Both renders must see this
    // version: the before is materialized beside the original precisely so its
    // `../base` resolves here. Had it been rendered anywhere else, the before
    // would carry the committed wrapper and the two would differ.
    host.put(
      'lib/email/base.ts',
      "export const baseTemplate = (inner: string): string => `<html><body class=\"v2\">${inner}</body></html>`;\n",
    );

    const result = await verify(host.dir);
    expect(result.out).toContain('welcome: PASS');
    expect(result.code).toBe(0);
  });
});

describe('email verify — what fails, and only itself', () => {
  it('fails the drifted template among three and passes the others', async () => {
    const host = committedHost({
      'lib/email/templates/notice.ts':
        'export function notice(props: { name: string }): string {\n' +
        '  return `<h1>Hello ${props.name}</h1>`;\n' +
        '}\n',
      'lib/email/templates/receipt.ts':
        'export function receipt(props: { name: string }): string {\n' +
        '  return `<h1>Thanks ${props.name}</h1>`;\n' +
        '}\n',
    });
    await extract(host.dir, [...WALK, '--apply']);

    // A hand edit to ONE shell, after the custody rewrite: the markup around
    // the slot changed, so that template no longer renders what it did.
    const drifted = readFileSync(host.path('lib/email/templates/notice.ts'), 'utf8').replace('<h1>', '<h2>').replace('</h1>', '</h2>');
    host.put('lib/email/templates/notice.ts', drifted);

    const result = await verify(host.dir);
    expect(result.err).toContain('notice: FAIL');
    expect(result.out).toContain('welcome: PASS');
    expect(result.out).toContain('receipt: PASS');
    expect(result.code).toBe(1);
  });

  it('names the variable when a seeded placeholder has no sample prop', async () => {
    // The hand-written-entry case: nothing mechanical produced this pointer, so
    // nothing guaranteed its sampleProps cover what the value interpolates.
    const host = makeEmailHost();
    gitInit(host.dir);
    project(
      host.put,
      {
        version: 1,
        keys: { welcome__headline: { shape: 'text', target: 'html-email', vars: ['name'] } },
        templates: {
          welcome: {
            class: 'transactional',
            trigger: 'manual',
            slots: ['headline'],
            render: { file: 'lib/email/templates/welcome.ts', export: 'welcome', sampleProps: {} },
          },
        },
      },
      { default: { welcome__headline: 'Good to see you, {{name}}' } },
    );
    host.put(
      'lib/email/templates/welcome.ts',
      'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return `<h1>${props.welcome__headline}</h1>`;\n' +
        '}\n',
    );
    commit(host.dir);

    const result = await verify(host.dir);
    expect(result.err).toContain('{{name}}');
    expect(result.err).toContain('sampleProps');
    expect(result.code).toBe(1);
  });

  it('fails a nondeterministic template and says that is what happened', async () => {
    const host = makeEmailHost();
    gitInit(host.dir);
    project(host.put, { version: 1, keys: {}, templates: {} }, { default: {} });
    // The timestamp sits in an ATTRIBUTE, which extract leaves as shell — a
    // `${Date.now()}` inside a text run would route the whole file to
    // `unliftable-interpolation` and there would be no template to verify.
    host.put(
      'lib/email/templates/stamped.ts',
      'export function stamped(props: { name: string }): string {\n' +
        '  return `<h1>Hello ${props.name}</h1><img src="/pixel.png?t=${Date.now()}" />`;\n' +
        '}\n',
    );
    commit(host.dir);
    await extract(host.dir, [...WALK, '--apply']);

    const result = await verify(host.dir);
    expect(result.err).toContain('stamped: FAIL');
    // Byte equality cannot pass a template whose output changes between two
    // renders, and saying "the copy drifted" would send the reader hunting a
    // change nobody made.
    expect(result.err).toContain('renders differently every time');
    expect(result.code).toBe(1);
  });

  it('names the alias remedy for an import the renderer cannot resolve', async () => {
    const host = makeEmailHost();
    gitInit(host.dir);
    project(
      host.put,
      {
        version: 1,
        keys: { aliased__headline: { shape: 'text', target: 'html-email' } },
        templates: {
          aliased: {
            class: 'transactional',
            trigger: 'manual',
            slots: ['headline'],
            render: { file: 'lib/email/templates/aliased.ts', export: 'aliased', sampleProps: {} },
          },
        },
      },
      { default: { aliased__headline: 'Hello there' } },
    );
    host.put(
      'lib/email/templates/aliased.ts',
      "import { frame } from '~/email/frame';\n" +
        'export function aliased(props: { aliased__headline: string }): string {\n' +
        '  return frame(`<h1>${props.aliased__headline}</h1>`);\n' +
        '}\n',
    );
    commit(host.dir);

    const result = await verify(host.dir);
    expect(result.err).toContain('aliased: FAIL');
    expect(result.err).toContain('missing-dependency');
    // The D1 remedy: the narrow alias form, or a relative import.
    expect(result.err).toMatch(/alias|relative/i);
    expect(result.code).toBe(1);
  });

  it('removes the materialized before even when HEAD’s version will not load', async () => {
    // The AFTER has to SUCCEED for this to prove anything: verify renders the
    // working tree first and returns before it materializes anything when that
    // fails, so a fixture breaking both sides asserts the cleanup of a file
    // that was never written. Here the custody edit dropped the frame import
    // and the frame is gone, so the working tree renders and HEAD's version —
    // which still imports it — cannot.
    const host = makeEmailHost();
    gitInit(host.dir);
    project(
      host.put,
      {
        version: 1,
        keys: { welcome__headline: { shape: 'text', target: 'html-email' } },
        templates: {
          welcome: {
            class: 'transactional',
            trigger: 'manual',
            slots: ['headline'],
            render: {
              file: 'lib/email/templates/welcome.ts',
              export: 'welcome',
              sampleProps: { name: 'sample-name' },
            },
          },
        },
      },
      { default: { welcome__headline: 'Good to see you' } },
    );
    host.put('lib/email/base.ts', BASE);
    host.put(
      'lib/email/templates/welcome.ts',
      "import { baseTemplate } from '../base';\n" +
        'export function welcome(props: { name: string; welcome__headline: string }): string {\n' +
        '  return baseTemplate(`<h1>${props.welcome__headline}</h1>`);\n' +
        '}\n',
    );
    commit(host.dir);
    host.put(
      'lib/email/templates/welcome.ts',
      'export function welcome(props: { name: string; welcome__headline: string }): string {\n' +
        '  return `<html><body><h1>${props.welcome__headline}</h1></body></html>`;\n' +
        '}\n',
    );
    rmSync(host.path('lib/email/base.ts'));

    const result = await verify(host.dir);
    expect(result.code).toBe(1);
    // The before really was written and really was rendered — this failure is
    // what makes the cleanup assertion below non-vacuous.
    expect(result.err).toContain("HEAD's lib/email/templates/welcome.ts did not render");
    const strays = readdirSync(host.path('lib/email/templates')).filter((f) => f.startsWith('.stet-before-'));
    expect(strays).toEqual([]);
  });

  it('refuses a template whose before path is already a host file, and leaves it alone', async () => {
    const host = committedHost();
    await extract(host.dir, [...WALK, '--apply']);
    // A host file under stet's own temp name. The cleanup removes whatever sits
    // at that path, so materializing HEAD there would overwrite it and then
    // delete it — the template is refused instead.
    const squatter = 'lib/email/templates/.stet-before-welcome.ts';
    host.put(squatter, 'export const mine = 1;\n');
    const bytes = readFileSync(host.path(squatter), 'utf8');

    const result = await verify(host.dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('welcome: FAIL');
    expect(result.err).toContain('.stet-before-welcome.ts');
    expect(readFileSync(host.path(squatter), 'utf8')).toBe(bytes);
  });

  it('records no baseline for a collision, whatever --capture was asked for', async () => {
    // A collision is not a capture case: git holds a usable before and the only
    // blocker is the file on the reserved path. Recording the CURRENT render
    // there would bank the already-rewritten template as the truth, and the
    // next run would compare the shell with itself and pass.
    const host = committedHost();
    await extract(host.dir, [...WALK, '--apply']);
    // Real drift, after the rewrite — exactly what HEAD's version would catch.
    const snapshot = JSON.parse(readFileSync(host.path('content/defaults.json'), 'utf8')) as {
      default: Record<string, string>;
    };
    const body = Object.keys(snapshot.default).find((key) => key.endsWith('__body'));
    expect(body).toBeDefined();
    snapshot.default[body as string] = 'DRIFTED COPY NOBODY APPROVED';
    host.put('content/defaults.json', `${JSON.stringify(snapshot, null, 2)}\n`);

    const squatter = 'lib/email/templates/.stet-before-welcome.ts';
    host.put(squatter, 'export const mine = 1;\n');

    const captured = await verify(host.dir, ['--capture']);
    expect(captured.code).toBe(1);
    expect(captured.err).toContain('welcome: FAIL');
    expect(captured.err).toContain('.stet-before-welcome.ts');
    expect(captured.err).toContain('--capture records nothing here');
    expect(existsSync(host.path('.stet/email-fixtures/welcome.json'))).toBe(false);

    // With the squatter gone, HEAD's before catches the drift — which is the
    // whole point: no capture stood in front of it.
    rmSync(host.path(squatter));
    const reread = await verify(host.dir);
    expect(reread.code).toBe(1);
    expect(reread.err).toContain('the render changed');
  });

  it('still compares against a baseline recorded before the collision', async () => {
    // The other half of the same rule: a capture that already happened is a
    // real before, so the collision does not cost the template its proof.
    const host = untrackedTemplateHost();
    expect((await verify(host.dir, ['--capture'])).code).toBe(0);
    commit(host.dir, 'the template and its baseline');
    host.put('lib/email/templates/.stet-before-welcome.ts', 'export const mine = 1;\n');

    const proven = await verify(host.dir);
    expect(proven.out).toContain('welcome: PASS');
    expect(proven.code).toBe(0);

    // And it still catches drift through that baseline.
    host.put('lib/email/templates/welcome.ts', DRIFTED);
    const drifted = await verify(host.dir);
    expect(drifted.err).toContain('welcome: FAIL');
    expect(drifted.code).toBe(1);
  });

  it('names the collision, not --recapture, when the baseline is also unreadable', async () => {
    // Both blockers at once. `--recapture` records nothing on this route, so
    // offering it would send the reader straight back to this message.
    const host = untrackedTemplateHost();
    expect((await verify(host.dir, ['--capture'])).code).toBe(0);
    commit(host.dir, 'the template and its baseline');
    host.put('.stet/email-fixtures/welcome.json', '{ "result": ');
    host.put('lib/email/templates/.stet-before-welcome.ts', 'export const mine = 1;\n');

    const result = await verify(host.dir, ['--capture']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('.stet-before-welcome.ts');
    expect(result.err).toContain('cannot be read either');
    expect(result.err).not.toContain('--recapture');
  });

  it('refuses a DANGLING symlink at the before path rather than writing through it', async () => {
    const host = committedHost();
    await extract(host.dir, [...WALK, '--apply']);
    // `existsSync` FOLLOWS the link, so a broken one reads as absent: HEAD's
    // bytes would land on the link's target, somewhere else in the host tree,
    // and the `finally` would remove only the link — leaving a file stet wrote
    // under a name the host chose. The guard asks whether anything OCCUPIES the
    // path, and a broken link occupies it.
    const reserved = 'lib/email/templates/.stet-before-welcome.ts';
    const victim = 'lib/email/NOT-A-STET-PATH.ts';
    symlinkSync('../NOT-A-STET-PATH.ts', host.path(reserved));

    const result = await verify(host.dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('welcome: FAIL');
    expect(result.err).toContain('.stet-before-welcome.ts');
    expect(existsSync(host.path(victim))).toBe(false);
    // The link is the host's, and stet leaves it where it found it.
    expect(lstatSync(host.path(reserved)).isSymbolicLink()).toBe(true);
  });
});

/**
 * The hand-written-entry path, which is where capture is reachable: the entry
 * has to exist before there is anything to capture, and the template file is
 * written AFTER the commit, so git has no before for it.
 */
function untrackedTemplateHost(): EmailHost {
  const host = makeEmailHost();
  gitInit(host.dir);
  project(
    host.put,
    {
      version: 1,
      keys: { welcome__headline: { shape: 'text', target: 'html-email', vars: ['name'] } },
      templates: {
        welcome: {
          class: 'transactional',
          trigger: 'manual',
          slots: ['headline'],
          render: {
            file: 'lib/email/templates/welcome.ts',
            export: 'welcome',
            sampleProps: { name: 'sample-name' },
          },
        },
      },
    },
    { default: { welcome__headline: 'Good to see you, {{name}}' } },
  );
  commit(host.dir);
  host.put(
    'lib/email/templates/welcome.ts',
    'export function welcome(props: { name: string }): string {\n' +
      '  return `<h1>Good to see you, ${props.name}</h1>`;\n' +
      '}\n',
  );
  return host;
}

/** The custody rewrite, with the copy DRIFTED — `<h1>` becomes `<h2>`. */
const DRIFTED =
  'export function welcome(props: { name: string; welcome__headline: string }): string {\n' +
  '  return `<h2>${props.welcome__headline}</h2>`;\n' +
  '}\n';

function fixtureText(host: EmailHost): string {
  return readFileSync(host.path('.stet/email-fixtures/welcome.json'), 'utf8');
}

describe('email verify --capture', () => {
  it('fails an untracked template, then passes against the captured baseline', async () => {
    const host = untrackedTemplateHost();

    const first = await verify(host.dir);
    // The remedy in honesty order: the commit is what leaves a before nothing
    // can move, and a capture taken after the rewrite proves nothing.
    expect(first.err).toContain('Commit the file as it stands, then verify');
    expect(first.err).toContain('compares the rewritten template against itself');
    expect(first.code).toBe(1);

    const captured = await verify(host.dir, ['--capture']);
    expect(captured.out).toContain('welcome: captured');
    expect(captured.code).toBe(0);
    const fixture = JSON.parse(
      readFileSync(host.path('.stet/email-fixtures/welcome.json'), 'utf8'),
    ) as { result: string };
    expect(fixture.result).toContain('Good to see you, sample-name');

    // Now the custody rewrite, by hand — the first-class path.
    host.put(
      'lib/email/templates/welcome.ts',
      'export function welcome(props: { name: string; welcome__headline: string }): string {\n' +
        '  return `<h1>${props.welcome__headline}</h1>`;\n' +
        '}\n',
    );
    const proven = await verify(host.dir);
    expect(proven.out).toContain('welcome: PASS');
    expect(proven.code).toBe(0);
  });

  it('prefers git over a stale fixture once the file is committed', async () => {
    const host = committedHost();
    await extract(host.dir, [...WALK, '--apply']);
    // A fixture recording something the template never rendered. git has a
    // before for this file, so the fixture must not be consulted at all.
    mkdirSync(host.path('.stet/email-fixtures'), { recursive: true });
    writeFileSync(
      host.path('.stet/email-fixtures/welcome.json'),
      `${JSON.stringify({ result: '"a render this template never produced"' }, null, 2)}\n`,
      'utf8',
    );

    const result = await verify(host.dir);
    expect(result.out).toContain('welcome: PASS');
    expect(result.code).toBe(0);
  });

  it('will not capture over a baseline that is already recorded', async () => {
    // The laundering sequence: capture, rewrite badly, capture again. If the
    // second capture replaced the first, the run after it would compare the
    // drifted render with itself and report a pass.
    const host = untrackedTemplateHost();
    expect((await verify(host.dir, ['--capture'])).code).toBe(0);
    const recorded = fixtureText(host);

    host.put('lib/email/templates/welcome.ts', DRIFTED);
    const again = await verify(host.dir, ['--capture']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('welcome: FAIL');
    expect(again.err).toContain('--capture leaves in place');
    expect(fixtureText(host)).toBe(recorded);

    // …and the run after it still fails, which is the point.
    expect((await verify(host.dir)).code).toBe(1);
  });

  it('replaces the baseline only when --recapture asks for it', async () => {
    const host = untrackedTemplateHost();
    await verify(host.dir, ['--capture']);
    const recorded = fixtureText(host);

    host.put('lib/email/templates/welcome.ts', DRIFTED);
    const replaced = await verify(host.dir, ['--recapture']);
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain('over the one that was there');
    expect(fixtureText(host)).not.toBe(recorded);
    expect(JSON.parse(fixtureText(host)).result).toContain('<h2>');
  });

  it('says a baseline exists but cannot be read, and leaves it alone', async () => {
    const host = untrackedTemplateHost();
    mkdirSync(host.path('.stet/email-fixtures'), { recursive: true });
    const corrupt = '{ "result": ';
    writeFileSync(host.path('.stet/email-fixtures/welcome.json'), corrupt, 'utf8');

    const result = await verify(host.dir, ['--capture']);
    expect(result.code).toBe(1);
    // "no baseline has been captured" would send the reader to capture one,
    // which is not what happened and not what fixes it.
    expect(result.err).toContain('a baseline exists for welcome but cannot be read');
    expect(readFileSync(host.path('.stet/email-fixtures/welcome.json'), 'utf8')).toBe(corrupt);
  });
});

/**
 * The three classes `gitBefore` routes on, each produced rather than reasoned
 * about. Two of them mean "there is no before to compare against" and reach the
 * capture path; the third is an error, and folding it in with the others would
 * report a pass after `--capture` over a repository that is actually broken.
 */
describe('email verify — the git routing, all three classes', () => {
  /** A project whose template is present but has no commit behind it. */
  function pointeredHost(repo: boolean): EmailHost {
    const host = makeEmailHost();
    if (repo) gitInit(host.dir);
    project(
      host.put,
      {
        version: 1,
        keys: { welcome__headline: { shape: 'text', target: 'html-email' } },
        templates: {
          welcome: {
            class: 'transactional',
            trigger: 'manual',
            slots: ['headline'],
            render: {
              file: 'lib/email/templates/welcome.ts',
              export: 'welcome',
              sampleProps: {},
            },
          },
        },
      },
      { default: { welcome__headline: 'Good to see you' } },
    );
    host.put(
      'lib/email/templates/welcome.ts',
      'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return `<h1>${props.welcome__headline}</h1>`;\n' +
        '}\n',
    );
    return host;
  }

  it('routes an UNBORN HEAD to the capture path', async () => {
    // `git init` and nothing committed: there is no commit to compare against,
    // which is the capture case in every ordinary sense.
    const host = pointeredHost(true);
    const first = await verify(host.dir);
    expect(first.code).toBe(1);
    expect(first.err).toContain('--capture');

    const captured = await verify(host.dir, ['--capture']);
    expect(captured.out).toContain('welcome: captured');
    expect(captured.code).toBe(0);
  });

  it('routes a directory that is not a repository the same way', async () => {
    const host = pointeredHost(false);
    const first = await verify(host.dir);
    expect(first.code).toBe(1);
    expect(first.err).toContain('--capture');
    expect((await verify(host.dir, ['--capture'])).code).toBe(0);
  });

  it('reports a corrupted object as that template’s ERROR, never as untracked', async () => {
    const host = pointeredHost(true);
    commit(host.dir);
    // The blob HEAD holds for this file, overwritten with rubbish: git can no
    // longer read a version it still lists. Reading the exit code alone would
    // call that "untracked" and let --capture bank the current render.
    const blob = git(host.dir, 'rev-parse', 'HEAD:./lib/email/templates/welcome.ts').trim();
    // Loose objects are written read-only, so the file is replaced rather than
    // overwritten in place.
    const object = join(host.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    rmSync(object);
    writeFileSync(object, 'not an object', 'utf8');

    const result = await verify(host.dir, ['--capture']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('could not read lib/email/templates/welcome.ts at HEAD');
    // The error class never captures: a baseline recorded here would record the
    // present as the past.
    expect(existsSync(host.path('.stet/email-fixtures/welcome.json'))).toBe(false);
  });
});

/**
 * The two reads that take host data as names. Both are JSON-parsed, so the
 * own-property guards are defence in depth — and defence nobody has driven is a
 * claim, which is what these produce.
 */
describe('email verify — hostile descriptor and fixture data', () => {
  it('fails a seeded {{constructor}} by name instead of rendering a function', async () => {
    const host = untrackedTemplateHost();
    // The placeholder names a prototype member of the JSON-parsed sampleProps.
    // A bare lookup answers with `Object`'s constructor — a function — and the
    // render would carry its SOURCE into the email.
    const path = host.path('content/defaults.json');
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { default: Record<string, string> };
    snapshot.default['welcome__headline'] = 'Good to see you, {{constructor}}';
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    const result = await verify(host.dir, ['--capture']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('{{constructor}}');
    expect(result.err).toContain("not a member of this template's sampleProps");
    expect(existsSync(host.path('.stet/email-fixtures/welcome.json'))).toBe(false);
  });

  it('reports a fixture whose result rides __proto__ as unreadable', async () => {
    const host = untrackedTemplateHost();
    mkdirSync(host.path('.stet/email-fixtures'), { recursive: true });
    writeFileSync(
      host.path('.stet/email-fixtures/welcome.json'),
      '{"__proto__":{"result":"<h1>a baseline nobody recorded</h1>"}}',
      'utf8',
    );

    const result = await verify(host.dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('holds no result field');
  });

  it('fails a slot whose stored value is not text, naming the shape', async () => {
    const host = untrackedTemplateHost();
    const path = host.path('content/defaults.json');
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { default: Record<string, unknown> };
    snapshot.default['welcome__headline'] = 42;
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    const result = await verify(host.dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('welcome__headline resolved to a number, not a string');
    // Never as drift: the reader is not sent hunting a copy edit nobody made.
    expect(result.err).not.toContain('the render changed');
  });

  it('names an object-shaped value with the right article', async () => {
    const host = untrackedTemplateHost();
    const path = host.path('content/defaults.json');
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { default: Record<string, unknown> };
    // The multi-part shape is the one a slot most plausibly holds by mistake,
    // and the one `typeof` words as "a object".
    snapshot.default['welcome__headline'] = { subject: 'Hi', body: 'There' };
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    const result = await verify(host.dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('welcome__headline resolved to an object, not a string');
  });
});

describe('email verify — the pointer boundary', () => {
  it('reports a pointerless entry unverifiable without moving the exit code', async () => {
    const host = makeEmailHost();
    gitInit(host.dir);
    project(
      host.put,
      {
        version: 1,
        keys: { manual__headline: { shape: 'text', target: 'html-email' } },
        templates: { manual: { class: 'transactional', trigger: 'manual', slots: ['headline'] } },
      },
      { default: { manual__headline: 'Hello' } },
    );
    commit(host.dir);

    const result = await verify(host.dir);
    expect(result.out).toContain('manual: unverifiable');
    expect(result.out).toContain('nothing is centrally verifiable');
    expect(result.code).toBe(0);
  });
});

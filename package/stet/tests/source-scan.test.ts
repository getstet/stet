/**
 * The shared source layer: the managed-surface glob matcher, the key slugifier,
 * and the one TSX locator `scan`/`register`/`eject` share. The case tables here
 * are the pinned ones from the plan — each snippet's expected reading, executed.
 */
import { describe, expect, it } from 'vitest';

import {
  blankNonMarkup,
  carriesToken,
  decodeEntities,
  loadTypescript,
  matchGlob,
  mentionsToken,
  proposeKey,
  rendersToken,
  scanDialect,
  scanModule,
  scanSource,
  undecodedEntity,
} from '../cli/source-scan.js';

/** descriptor.schema.json:44 — every proposed key must satisfy it. */
const KEY_REGEX = /^[a-z0-9]+(?:_{1,2}[a-z0-9]+)*$/;

const scan = (file: string, source: string) => scanSource(file, source, { readPathImport: '@/lib/content' });

describe('the html dialect', () => {
  const page = [
    '<!DOCTYPE html>',
    '<html><head>',
    '<style>.a { color: red }</style>',
    '<script>const t = "a script string";</script>',
    '</head><body>',
    '<!-- a comment holding prose -->',
    '<h1>Software histories</h1>',
    '</body></html>',
  ].join('\n');

  it('text-warns a label between tags and reads nothing out of a comment, script or style', () => {
    const texts = scanDialect('index.html', page, 'html').map((f) => f.text);
    expect(texts).toContain('Software histories');
    expect(texts.join(' | ')).not.toContain('a comment holding prose');
    expect(texts.join(' | ')).not.toContain('a script string');
    expect(texts.join(' | ')).not.toContain('color');
  });

  it('keeps no front matter — three leading dashes on a page are prose', () => {
    const framed = ['---', 'This looks like front matter.', '---', '<p>And a paragraph.</p>'].join(
      '\n',
    );
    // The dashes never delimit here, so the block is read as the prose it is —
    // one run carrying the whole thing, rather than a stripped span.
    const texts = scanDialect('index.html', framed, 'html').map((f) => f.text);
    expect(texts.join(' | ')).toContain('This looks like front matter.');
    expect(texts).toContain('And a paragraph.');
  });

  it('blanks without moving a byte, so every offset survives', () => {
    const blanked = blankNonMarkup(page, 'html');
    expect(blanked.length).toBe(page.length);

    // The comment's span is NUL and its brackets are gone with it; the tags the
    // locator reads are untouched.
    const at = page.indexOf('<!-- a comment holding prose -->');
    expect(blanked.slice(at, at + '<!-- a comment holding prose -->'.length)).toBe(
      '\0'.repeat('<!-- a comment holding prose -->'.length),
    );
    expect(blanked).toContain('<h1>Software histories</h1>');
  });
});

describe('decodeEntities over the HTML 4 named set', () => {
  it('reads the names a page actually writes', () => {
    expect(decodeEntities('a &rarr; b &hellip; &mdash;')).toBe('a \u2192 b \u2026 \u2014');
    expect(decodeEntities('&trade; &euro; &laquo; &middot; &times; &eacute; &alpha;')).toBe(
      '\u2122 \u20ac \u00ab \u00b7 \u00d7 \u00e9 \u03b1',
    );
  });

  it('returns a name it does not know unchanged, so the caller can refuse it', () => {
    expect(decodeEntities('&nosuch;')).toBe('&nosuch;');
  });
});

describe('managed-surface glob matcher', () => {
  it('a double-star-slash matches zero or more intermediate segments', () => {
    // Zero segments — the naive `**`->`.*` translation misses exactly these.
    expect(matchGlob('app/**/*.tsx', 'app/page.tsx')).toBe(true);
    expect(matchGlob('app/**/*.tsx', 'app/layout.tsx')).toBe(true);
    // One and many segments.
    expect(matchGlob('app/**/*.tsx', 'app/dashboard/page.tsx')).toBe(true);
    expect(matchGlob('app/**/*.tsx', 'app/a/b/c.tsx')).toBe(true);
    // The extension still gates: `.ts` is not `.tsx`.
    expect(matchGlob('app/**/*.tsx', 'app/route.ts')).toBe(false);
  });

  it('a single star matches within one segment only', () => {
    expect(matchGlob('lib/email/*.ts', 'lib/email/welcome.ts')).toBe(true);
    expect(matchGlob('lib/email/*.ts', 'lib/email/nested/welcome.ts')).toBe(false);
  });

  it('a deeper double-star matches its subtree from its own level', () => {
    expect(matchGlob('lib/email/**/*.ts', 'lib/email/welcome.ts')).toBe(true);
    expect(matchGlob('lib/email/**/*.ts', 'lib/email/transactional/reset.ts')).toBe(true);
    expect(matchGlob('lib/email/**/*.ts', 'lib/marketing/welcome.ts')).toBe(false);
  });

  it('a src-rebased glob matches a src/app host and not a bare-root one', () => {
    expect(matchGlob('src/app/**/*.tsx', 'src/app/page.tsx')).toBe(true);
    expect(matchGlob('src/app/**/*.tsx', 'app/page.tsx')).toBe(false);
  });

  it('a literal dot in the glob is escaped, not a wildcard', () => {
    expect(matchGlob('app/*.tsx', 'app/page.tsx')).toBe(true);
    expect(matchGlob('app/*.tsx', 'app/pageXtsx')).toBe(false);
  });

  it('a leading ./ is stripped so a hand-written glob still matches', () => {
    expect(matchGlob('./lib/email/**/*.ts', 'lib/email/welcome.ts')).toBe(true);
    expect(matchGlob('lib/email/**/*.ts', './lib/email/welcome.ts')).toBe(true);
  });
});

describe('proposeKey', () => {
  it('slugifies the pinned case table and always satisfies the key regex', () => {
    expect(proposeKey('Your week, sorted')).toBe('your_week_sorted');
    expect(proposeKey('Sign up — free')).toBe('sign_up_free');
    expect(proposeKey('24/7 support')).toBe('24_7_support');
    expect(proposeKey('!!!')).toBe('key');
    expect(proposeKey('Café')).toBe('caf');

    for (const input of ['Your week, sorted', 'Sign up — free', '24/7 support', '!!!', 'Café']) {
      expect(KEY_REGEX.test(proposeKey(input))).toBe(true);
    }
  });

  it('a >40-char sentence trims to a word boundary, no trailing underscore', () => {
    const sentence = 'Manage all of your subscription preferences from a single settings page';
    const key = proposeKey(sentence);
    expect(key.length).toBeLessThanOrEqual(40);
    expect(key.startsWith('_')).toBe(false);
    expect(key.endsWith('_')).toBe(false);
    expect(KEY_REGEX.test(key)).toBe(true);
    // Boundary trim: the last kept segment is a whole word, not a cut fragment.
    expect(sentence.toLowerCase().split(/[^a-z0-9]+/).includes(key.split('_').at(-1) ?? '')).toBe(true);
  });

  it('a single over-long word takes the hard 40-cut and stays regex-valid', () => {
    const key = proposeKey('a'.repeat(55));
    expect(key).toBe('a'.repeat(40));
    expect(KEY_REGEX.test(key)).toBe(true);
  });
});

describe('loadTypescript', () => {
  it('returns the compiler when it is installed', async () => {
    const ts = await loadTypescript();
    expect(typeof ts.createSourceFile).toBe('function');
  });
});

/**
 * The two parsed predicates, over the shapes a wrapper claim and a declared slot
 * actually meet. They are one walk with one flag, so the table is where the
 * difference between them stays a real difference: exactly one row, JSX text.
 * Both skip type positions, and neither takes a comment.
 */
describe('rendersToken and carriesToken', () => {
  const TOKEN = 'unsubscribe_url';
  const SHAPES: Array<{ what: string; file: string; source: string; carries: boolean; renders: boolean }> = [
    {
      what: 'a template literal — the href form a frame really emits',
      file: 'f.ts',
      source: 'export const frame = (i: string): string =>\n  `${i}<a href="{{unsubscribe_url}}">Unsubscribe</a>`;\n',
      carries: true,
      renders: true,
    },
    {
      what: 'a no-substitution template literal',
      file: 'f.ts',
      source: 'const tail = `<a href="{{unsubscribe_url}}">u</a>`;\nexport const frame = () => tail;\n',
      carries: true,
      renders: true,
    },
    {
      what: 'a plain string literal',
      file: 'f.ts',
      source: 'const tail = "<a href=\'{{unsubscribe_url}}\'>u</a>";\nexport const frame = () => tail;\n',
      carries: true,
      renders: true,
    },
    {
      what: 'an identifier',
      file: 'f.ts',
      source: 'const unsubscribe_url = "x";\nexport const frame = () => unsubscribe_url;\n',
      carries: true,
      renders: true,
    },
    {
      what: 'a fragment of a longer identifier',
      file: 'f.ts',
      source: 'const my_unsubscribe_url_builder = () => "x";\nexport const frame = () => my_unsubscribe_url_builder();\n',
      carries: false,
      renders: false,
    },
    {
      what: 'a line comment',
      file: 'f.ts',
      source: '// TODO: emit unsubscribe_url one day\nexport const frame = () => "x";\n',
      carries: false,
      renders: false,
    },
    {
      what: 'a block comment',
      file: 'f.ts',
      source: '/* emit unsubscribe_url later */\nexport const frame = () => "x";\n',
      carries: false,
      renders: false,
    },
    {
      what: 'a JSX expression container — an object literal, not text',
      file: 'f.tsx',
      source: 'export const Frame = () => <p>{{unsubscribe_url}} goes here</p>;\n',
      carries: true,
      renders: true,
    },
    {
      what: 'JSX text',
      file: 'f.tsx',
      source: 'export const Frame = () => <p>Manage it at unsubscribe_url today</p>;\n',
      carries: true,
      renders: false,
    },
    {
      what: 'a JSX attribute string',
      file: 'f.tsx',
      source: 'export const Frame = () => <a href="{{unsubscribe_url}}">u</a>;\n',
      carries: true,
      renders: true,
    },
    {
      what: 'a props-type member and nothing else',
      file: 'f.ts',
      source: 'export interface FrameProps {\n  unsubscribe_url: string;\n}\nexport const frame = (p: FrameProps) => "x";\n',
      carries: false,
      renders: false,
    },
    {
      what: 'a destructured binding and nothing else',
      file: 'f.tsx',
      source: 'export function Frame({ unsubscribe_url }: { unsubscribe_url: string }) {\n  return <p>Hello</p>;\n}\n',
      carries: false,
      renders: false,
    },
    {
      what: 'a destructured binding the body then reads',
      file: 'f.tsx',
      source: 'export function Frame({ unsubscribe_url }: { unsubscribe_url: string }) {\n  return <a href={unsubscribe_url}>Unsubscribe</a>;\n}\n',
      carries: true,
      renders: true,
    },
  ];

  it('answer alike on every shape but JSX text', async () => {
    const ts = await loadTypescript();
    for (const shape of SHAPES) {
      expect(carriesToken(ts, shape.file, shape.source, TOKEN), `carries — ${shape.what}`).toBe(shape.carries);
      expect(rendersToken(ts, shape.file, shape.source, TOKEN), `renders — ${shape.what}`).toBe(shape.renders);
    }
    // The one disagreement is a row of this table, not an accident of it: a
    // second one appearing means the two questions have drifted apart.
    expect(SHAPES.filter((s) => s.carries !== s.renders).map((s) => s.what)).toEqual(['JSX text']);
  });

  it('is a parse, not a grep — the comment shapes are where the two answers part from mentionsToken', () => {
    for (const shape of SHAPES.filter((s) => s.what.includes('comment'))) {
      expect(mentionsToken(shape.source, TOKEN)).toBe(true);
    }
  });
});

describe('scanSource', () => {
  it('a JSX text literal is located with its trimmed raw span', async () => {
    const r = await scan('app/page.tsx', 'export function C() { return <h1>Your week</h1>; }');
    expect(r.literals).toHaveLength(1);
    expect(r.literals[0]?.context).toBe('jsx-text');
    expect(r.literals[0]?.raw).toBe('Your week');
    expect(r.literals[0]?.proposedKey).toBe('your_week');
  });

  it('a multi-line JSX text is entity-decoded and whitespace-collapsed, raw is the trimmed source', async () => {
    const src = 'export function C() { return <p>\n  Tom &amp; Jerry\n</p>; }';
    const r = await scan('app/page.tsx', src);
    expect(r.literals).toHaveLength(1);
    const lit = r.literals[0];
    expect(lit?.text).toBe('Tom & Jerry');
    expect(lit?.raw).toBe('Tom &amp; Jerry');
    expect(src.slice(lit?.pos ?? 0, lit?.end ?? 0)).toBe(lit?.raw); // the re-confirm guard holds
  });

  it('captures a copy attribute and ignores a structural one', async () => {
    const r = await scan('app/page.tsx', 'export function C() { return <img alt="A dog" className="x" />; }');
    expect(r.literals).toHaveLength(1);
    expect(r.literals[0]?.context).toBe('jsx-attr');
    expect(r.literals[0]?.raw).toBe('"A dog"');
    expect(r.literals[0]?.text).toBe('A dog');
  });

  it('a copy attribute is entity-decoded but not whitespace-collapsed', async () => {
    // After adopt the value rides `alt={copy('key')}`, which React does NOT
    // entity-decode — so the seeded default must already read "Tom & Jerry".
    const decoded = await scan('app/page.tsx', 'export function C() { return <img alt="Tom &amp; Jerry" />; }');
    expect(decoded.literals[0]?.text).toBe('Tom & Jerry');
    expect(decoded.literals[0]?.raw).toBe('"Tom &amp; Jerry"'); // raw stays the quoted source
    // Attribute whitespace is significant — unlike JSX text, it is not collapsed.
    const spaced = await scan('app/page.tsx', 'export function C() { return <img alt="Two  spaces" />; }');
    expect(spaced.literals[0]?.text).toBe('Two  spaces');
  });

  it('captures a send() copy field and excludes the structural denylist', async () => {
    const r = await scan('lib/email/welcome.ts', "export function f(x: unknown) { send({ subject: 'Welcome', to: x }); }");
    expect(r.literals).toHaveLength(1);
    expect(r.literals[0]?.context).toBe('send-arg');
    expect(r.literals[0]?.text).toBe('Welcome');
  });

  it('captures member-expression send callees', async () => {
    const r = await scan('lib/email/x.ts', "mailer.send({ subject: 'Hi' }); resend.emails.send({ subject: 'Hey' });");
    expect(r.literals.map((l) => l.text).sort()).toEqual(['Hey', 'Hi']);
  });

  it('a send() with only denylisted fields yields nothing', async () => {
    const r = await scan('lib/email/x.ts', "send({ html: '<p>', reply_to: 'a@b' });");
    expect(r.literals).toHaveLength(0);
  });

  it('a direct string send argument is captured', async () => {
    const r = await scan('lib/email/x.ts', "send('Reset');");
    expect(r.literals).toHaveLength(1);
    expect(r.literals[0]?.raw).toBe("'Reset'");
    expect(r.literals[0]?.text).toBe('Reset');
  });

  it('a <Trans> child is an i18n skip and its attributes are suppressed', async () => {
    const r = await scan('app/page.tsx', 'export function C() { return <Trans i18nKey="k">Hello</Trans>; }');
    expect(r.literals).toHaveLength(0);
    expect(r.i18nSkips).toHaveLength(1);
    expect(r.i18nSkips[0]?.text).toBe('Hello');
  });

  it('t() and i18n.t() strings are i18n skips, never literals', async () => {
    const r = await scan('lib/x.ts', "t('welcome'); i18n.t('greeting');");
    expect(r.literals).toHaveLength(0);
    expect(r.i18nSkips.map((s) => s.text).sort()).toEqual(['greeting', 'welcome']);
  });

  it('the TAGGED-TEMPLATE macro form is an i18n skip too', async () => {
    // How Lingui's macros are ordinarily written. The spec's boundary is the
    // copy, not the call syntax it arrives in.
    const r = await scan('lib/x.ts', 'const a = t`Hello ${name}, welcome`; const b = msg`Sign up`;');
    expect(r.literals).toHaveLength(0);
    expect(r.i18nSkips.map((s) => s.text).sort()).toEqual(['Hello , welcome', 'Sign up']);
  });

  it('a literal in a .map callback anchors to the component body, not the callback', async () => {
    const src = 'export function C() { return <ul>{items.map((x) => <li>Free</li>)}</ul>; }';
    const r = await scan('app/page.tsx', src);
    const free = r.literals.find((l) => l.text === 'Free');
    expect(free).toBeDefined();
    // The component body opens at the first `{`; the expression-bodied callback has none.
    expect(free?.enclosingBodyPos).toBe(src.indexOf('{') + 1);
  });

  it('a BLOCK-bodied .map callback returning JSX still anchors to the component, not the callback', async () => {
    // Regression: a block-bodied callback returns JSX too, so a returns-JSX test
    // alone would anchor the hook inside the callback — an Invalid-hook-call crash.
    const src = 'export function C() { return <ul>{items.map((x) => { return <li>Free</li>; })}</ul>; }';
    const r = await scan('app/page.tsx', src);
    const free = r.literals.find((l) => l.text === 'Free');
    expect(free?.enclosingBodyPos).toBe(src.indexOf('{') + 1); // C's body, NOT the callback's
  });

  it('an anonymous default-export arrow component resolves via returns-JSX', async () => {
    // It is not a call argument, so returns-JSX still identifies it as a component.
    const src = 'export default () => { return <p>Hi</p>; };';
    const r = await scan('app/page.tsx', src);
    const hi = r.literals.find((l) => l.text === 'Hi');
    expect(hi?.enclosingBodyPos).toBe(src.indexOf('{') + 1);
  });

  it('a .ts generic is parsed as TS, not mis-read as JSX', async () => {
    const r = await scan('lib/x.ts', 'export function id<T>(x: T): T { return x; }');
    expect(r.parseErrors).toBe(false);
    expect(r.literals).toHaveLength(0);
  });

  it('a file with a syntax error is report-only', async () => {
    const r = await scan('app/page.tsx', 'export const x = ;');
    expect(r.parseErrors).toBe(true);
    expect(r.literals).toHaveLength(0);
  });

  it('a copy() call in JSX is an accessorCall over the whole container, not a literal', async () => {
    const src = "export function C() { return <p>{copy('x')}</p>; }";
    const r = await scan('app/page.tsx', src);
    expect(r.literals).toHaveLength(0);
    expect(r.accessorCalls).toHaveLength(1);
    const call = r.accessorCalls[0];
    expect(call?.key).toBe('x');
    expect(call?.context).toBe('jsx-text');
    expect(src.slice(call?.pos ?? 0, call?.end ?? 0)).toBe("{copy('x')}");
  });

  it('a useCopy()() call in JSX is an accessorCall', async () => {
    const src = "export function C() { return <p>{useCopy()('hero')}</p>; }";
    const r = await scan('app/page.tsx', src);
    expect(r.literals).toHaveLength(0);
    expect(r.accessorCalls).toHaveLength(1);
    expect(r.accessorCalls[0]?.key).toBe('hero');
    expect(src.slice(r.accessorCalls[0]?.pos ?? 0, r.accessorCalls[0]?.end ?? 0)).toBe("{useCopy()('hero')}");
  });

  it('a copy() call inside a send arg is a send-context accessorCall over the call span', async () => {
    const src = "send({ subject: copy('x') });";
    const r = await scan('lib/email/x.ts', src);
    expect(r.literals).toHaveLength(0);
    expect(r.accessorCalls).toHaveLength(1);
    expect(r.accessorCalls[0]?.context).toBe('send-arg');
    expect(src.slice(r.accessorCalls[0]?.pos ?? 0, r.accessorCalls[0]?.end ?? 0)).toBe("copy('x')");
  });

  it('a plain expression and a template literal yield nothing', async () => {
    const expr = await scan('app/page.tsx', 'export function C() { return <p>{count}</p>; }');
    expect(expr.literals).toHaveLength(0);
    expect(expr.accessorCalls).toHaveLength(0);
    const template = await scan('lib/email/x.ts', 'send({ subject: `Hi ${name}` });');
    expect(template.literals).toHaveLength(0);
  });

  it('an ignore comment suppresses a JSX literal and a send literal', async () => {
    const jsx = await scan('app/page.tsx', 'export function C() { return <p>{/* stet-ignore-next-line */}\n  Ignore this\n</p>; }');
    expect(jsx.literals).toHaveLength(0);
    const send = await scan('lib/email/x.ts', "// stet-ignore-next-line\nsend({ subject: 'X' });");
    expect(send.literals).toHaveLength(0);
  });

  it('P2-4 — an ignore comment before an ELEMENT suppresses that element first text child', async () => {
    // The documented form (specs/adoption): the marker sits before the <p>, not
    // before the text — the text is the element's first meaningful child.
    const r = await scan(
      'app/page.tsx',
      'export function C() { return <div>{/* stet-ignore-next-line */}<p>Ignore this whole element</p></div>; }',
    );
    expect(r.literals).toHaveLength(0);
    // The marker guards only the NEXT sibling — a following element still scans.
    const r2 = await scan(
      'app/page.tsx',
      'export function C() { return <div>{/* stet-ignore-next-line */}<p>Skipped copy</p><p>Live copy</p></div>; }',
    );
    expect(r2.literals.map((l) => l.text)).toEqual(['Live copy']);
  });

  it('records use-client, the import-insert offset, and the three-state copy binding', async () => {
    const client = await scan('app/page.tsx', "'use client';\nimport { useCopy } from '@getstet/stet/react';\nexport function C() { return <p>Hi</p>; }");
    expect(client.hasUseClient).toBe(true);
    expect(client.literals[0]?.accessorImported).toBe(true); // useCopy from @getstet/stet/react already imported
    // The `useCopy` import does NOT bind `copy` — no `const copy` in scope — so the
    // binding is 'none' (register inserts the const; accessorImported stops a dup import).
    expect(client.literals[0]?.copyBinding).toBe('none');
    // The import-insert offset lands after the directive AND the last import.
    const afterImport = "'use client';\nimport { useCopy } from '@getstet/stet/react';".length;
    expect(client.literals[0]?.importInsertPos).toBe(afterImport);

    const foreign = await scan('app/page.tsx', "import copy from 'copy-to-clipboard';\nexport function C() { return <p>Hi</p>; }");
    expect(foreign.literals[0]?.copyBinding).toBe('foreign');

    const none = await scan('app/page.tsx', 'export function C() { return <p>Hi</p>; }');
    expect(none.literals[0]?.copyBinding).toBe('none');
    expect(none.literals[0]?.accessorImported).toBe(false);
  });

  it('a const copy = useCopy() gives a stet binding and a copyDecl span', async () => {
    const r = await scan('app/page.tsx', "'use client';\nimport { useCopy } from '@getstet/stet/react';\nexport function C() { const copy = useCopy(); return <p>Hi</p>; }");
    expect(r.literals[0]?.copyBinding).toBe('stet');
    expect(r.copyDeclSpans).toHaveLength(1);
  });

  it('classifies each literal by its lexical copy scope, not file-wide', async () => {
    const src = [
      "'use client';",
      "import copy from 'copy-to-clipboard';",
      "import { useCopy } from '@getstet/stet/react';",
      'function Toolbar() { copy(document.title); return <button>Copy</button>; }',
      'export function C() { const copy = useCopy(); return <p>Hello</p>; }',
    ].join('\n');
    const r = await scan('app/page.tsx', src);
    // 'Copy' sees only the module-level clipboard import → foreign (skip+report);
    // 'Hello' sits in a body with `const copy = useCopy()` → stet (adopt). No over-skip.
    expect(r.literals.find((l) => l.text === 'Copy')?.copyBinding).toBe('foreign');
    expect(r.literals.find((l) => l.text === 'Hello')?.copyBinding).toBe('stet');
  });

  it('a stet-scoped const shadows an outer foreign copy for literals in its body', async () => {
    const src = [
      "import copy from 'copy-to-clipboard';",
      'export function C() { const copy = useCopy(); return <p>Shadowed</p>; }',
    ].join('\n');
    const r = await scan('app/page.tsx', src);
    expect(r.literals.find((l) => l.text === 'Shadowed')?.copyBinding).toBe('stet');
  });

  it('a copy parameter is a foreign binding', async () => {
    const r = await scan('app/page.tsx', 'export function C({ copy }: { copy: unknown }) { return <p>Param</p>; }');
    expect(r.literals.find((l) => l.text === 'Param')?.copyBinding).toBe('foreign');
  });

  it('a block-scoped const copy binds only within its block', async () => {
    const src = [
      'export function C() {',
      '  if (cond) { const copy = useCopy(); render(<p>Inner</p>); }',
      '  return <p>Outer</p>;',
      '}',
    ].join('\n');
    const r = await scan('app/page.tsx', src);
    expect(r.literals.find((l) => l.text === 'Inner')?.copyBinding).toBe('stet');
    expect(r.literals.find((l) => l.text === 'Outer')?.copyBinding).toBe('none');
  });

  it('a copy import from the read-path is a stet binding', async () => {
    const r = await scan('app/page.tsx', "import { copy } from '@/lib/content';\nexport function C() { return <p>Server</p>; }");
    expect(r.literals.find((l) => l.text === 'Server')?.copyBinding).toBe('stet');
  });

  it('a const copy declared AFTER the literal is foreign (TDZ), not stet', async () => {
    // Position-aware block scan: rewriting to `copy(...)` before the decl is TS2448.
    const r = await scan('app/page.tsx', 'export function C() { const el = <p>Hi</p>; const copy = useCopy(); return el; }');
    expect(r.literals.find((l) => l.text === 'Hi')?.copyBinding).toBe('foreign');
  });

  it('a let/var copy is foreign even when initialized from useCopy', async () => {
    const r = await scan('app/page.tsx', 'export function C() { let copy = useCopy(); return <p>LetCase</p>; }');
    expect(r.literals.find((l) => l.text === 'LetCase')?.copyBinding).toBe('foreign');
  });

  it('a default or namespace copy import is foreign; only a named read-path import is stet', async () => {
    const def = await scan('app/page.tsx', "import copy from 'x';\nexport function C() { return <p>DefaultCase</p>; }");
    expect(def.literals.find((l) => l.text === 'DefaultCase')?.copyBinding).toBe('foreign');
    const ns = await scan('app/page.tsx', "import * as copy from 'x';\nexport function C() { return <p>NsCase</p>; }");
    expect(ns.literals.find((l) => l.text === 'NsCase')?.copyBinding).toBe('foreign');
    // A named `{ copy }` from a NON-read-path module is also foreign.
    const other = await scan('app/page.tsx', "import { copy } from 'other-lib';\nexport function C() { return <p>OtherCase</p>; }");
    expect(other.literals.find((l) => l.text === 'OtherCase')?.copyBinding).toBe('foreign');
  });

  it('no copy binding anywhere is none', async () => {
    const r = await scan('app/page.tsx', 'export function C() { return <p>Plain</p>; }');
    expect(r.literals.find((l) => l.text === 'Plain')?.copyBinding).toBe('none');
  });

  it('records the root-layout stet imports and the resolveAll decl for eject', async () => {
    const layout = [
      "import { CopyProvider } from '@getstet/stet/react';",
      "import { resolveAll, readBundle } from '@getstet/stet';",
      "import descriptor from './descriptor.json';",
      "import defaults from './defaults.json';",
      'export default function RootLayout({ children }) {',
      '  const { resolved } = resolveAll(descriptor, readBundle(defaults));',
      '  return <CopyProvider descriptor={descriptor} resolved={resolved}>{children}</CopyProvider>;',
      '}',
    ].join('\n');
    const r = await scan('app/layout.tsx', layout);
    // Both `@getstet/stet/react` and `stet` imports are drop targets; the JSON imports are not.
    expect(r.stetImportSpans).toHaveLength(2);
    expect(r.resolvedMapDeclSpans).toHaveLength(1);
  });
});

/**
 * The whole-statement ignore. One `// stet-ignore-next-line` above an
 * `export const copy = {…}` legally silences every property under it — the
 * walk-up rule — and until the count came back it did so indistinguishably from
 * a module with nothing to report. The tally is what `scan` prints; it counts
 * only literals that WOULD have been findings, because a warn about suppressed
 * junk is the vacuous output this channel exists to remove.
 */
describe('scanModule — the ignore summary', () => {
  it('counts every property one comment above the statement silenced', async () => {
    const result = await scanModule(
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        "  footer_note: 'stet is a working name.',\n" +
        '};\n',
    );
    expect(result.ignoreSummaries).toEqual([{ line: 1, count: 3 }]);
    // And the module reports nothing else: the opt-out did its job.
    expect(result.literals).toHaveLength(0);
  });

  it('says nothing about a comment covering exactly one finding', async () => {
    // The targeted opt-out is the feature working as documented. Only the
    // whole-statement reach needs naming.
    const result = await scanModule(
      'src/copy.ts',
      'export const copy = {\n' +
        '  // stet-ignore-next-line\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        '};\n',
    );
    expect(result.ignoreSummaries).toEqual([]);
    expect(result.literals.map((l) => l.proposedKey)).toEqual(['site_name']);
  });

  it('does not count a suppressed literal that would never have been a finding', async () => {
    // `'x'` sits in an ARRAY, so it takes the qualifying bar and fails it. The
    // would-have-been count is one, and one is not a summary. Counting raw
    // literals would report two here — a line about a comment that silenced one
    // real property and one piece of junk.
    const result = await scanModule(
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero: 'Real prose here',\n" +
        "  items: ['x'],\n" +
        '};\n',
    );
    expect(result.ignoreSummaries).toEqual([]);
  });

  it('counts a repeated name once — the second occurrence would have been a repeat', async () => {
    // Nested groups sharing a property name, the shape a features-data module
    // has by the dozen. Unsuppressed, the first `title` proposes itself and the
    // second falls to the ordinary derived proposal, which takes the qualifying
    // bar — and `'x'` fails it. So the would-have-been count is one, and one is
    // not a summary. `claimed` cannot answer this: it is deliberately never
    // written for a suppressed literal, so both occurrences would read as
    // declarations and the line would claim two findings over one.
    const result = await scanModule(
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero: { title: 'Welcome home to the site' },\n" +
        "  footer: { title: 'x' },\n" +
        '};\n',
    );
    expect(result.ignoreSummaries).toEqual([]);
  });

  it('counts the findings only — two properties beside an array of junk read as two', async () => {
    const result = await scanModule(
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        "  classes: ['x'],\n" +
        '};\n',
    );
    expect(result.ignoreSummaries).toEqual([{ line: 1, count: 2 }]);
  });
});

describe('the stage-5 fold — entity references that name no character', () => {
  it('returns an out-of-range numeric reference unchanged instead of throwing', () => {
    // `String.fromCodePoint` throws above U+10FFFF, which killed every command
    // that read the page — `init` among them, after the scaffold had landed.
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
    expect(decodeEntities('Overflow test &#1114112; here')).toBe('Overflow test &#1114112; here');
  });

  it('returns a lone surrogate unchanged', () => {
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#55296;')).toBe('&#55296;');
  });

  it('still decodes every reference that names a real character', () => {
    expect(decodeEntities('&#65;&#x42;&#1114111;')).toBe(`AB${String.fromCodePoint(0x10ffff)}`);
  });

  it('names an undecodable numeric reference the way it names an unknown entity', () => {
    expect(undecodedEntity('Overflow test &#1114112; here')).toBe('&#1114112;');
    expect(undecodedEntity('A surrogate &#xD800; here')).toBe('&#xD800;');
    expect(undecodedEntity('An ordinary &#65; here')).toBeUndefined();
    expect(undecodedEntity('An unknown &nosuch; here')).toBe('&nosuch;');
  });
});

describe('the stage-5 fold — bogus-comment forms blank like a comment', () => {
  it('blanks a CDATA section, a processing instruction and a markup declaration', () => {
    for (const [source, visible] of [
      ['<div><![CDATA[ raw text here ]]>Hello there</div>', 'Hello there'],
      ['<div><?php echo $x; ?>Hello there</div>', 'Hello there'],
      ['<div><!ENTITY x "y">Hello there</div>', 'Hello there'],
    ] as const) {
      const blanked = blankNonMarkup(source, 'html');
      // Length-preserving, so every reported offset is still the real one.
      expect(blanked).toHaveLength(source.length);
      expect(blanked).toContain(visible);
      expect(blanked.includes('\0')).toBe(true);
    }
  });

  it('blanks the doctype too, and keeps the page byte-aligned', () => {
    const source = '<!DOCTYPE html>\n<html><body><p>Ordinary page copy.</p></body></html>';
    const blanked = blankNonMarkup(source, 'html');
    expect(blanked).toHaveLength(source.length);
    expect(blanked.startsWith('\0'.repeat(15))).toBe(true);
    expect(blanked).toContain('Ordinary page copy.');
  });
});

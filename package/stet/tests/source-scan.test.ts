/**
 * The shared source layer: the managed-surface glob matcher, the key slugifier,
 * and the one TSX locator `scan`/`register`/`eject` share. The case tables here
 * are the pinned ones from the plan — each snippet's expected reading, executed.
 */
import { describe, expect, it } from 'vitest';

import {
  astroFindings,
  blankNonMarkup,
  carriesToken,
  decodeEntities,
  INLINE,
  loadTypescript,
  matchGlob,
  mentionsToken,
  proposeKey,
  rendersToken,
  scanDialect,
  scanModule,
  SCHEME_SPECIFIER,
  scanSource,
  undecodedEntity,
} from '../cli/source-scan.js';
import { SECTION_WORD_ROWS } from './fixtures/section-words.js';

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

describe('SCHEME_SPECIFIER', () => {
  it.each(['node:fs', 'astro:assets', 'virtual:uno.css', 'https://x.test/a.js', 'data:text/javascript,1'])('%s is a scheme', (spec) => {
    expect(SCHEME_SPECIFIER.test(spec)).toBe(true);
  });

  it.each(['@scope/x:y', 'react', './a:b', 'C:\\foo'])('%s is not a scheme', (spec) => {
    expect(SCHEME_SPECIFIER.test(spec)).toBe(false);
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
    // The role name: no page given, no section, so the component's name stands in.
    expect(r.literals[0]?.proposedKey).toBe('c_headline');
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

describe('JSX role names', () => {
  const onPage = (source: string, page = 'home') =>
    scanSource('app/page.tsx', source, { readPathImport: '@/lib/content', page });
  const page = (jsx: string): string => `export default function Page() {\n  return (<>${jsx}</>);\n}\n`;
  const keyOf = async (source: string, text: string, pageWord?: string): Promise<string | undefined> => {
    const r = pageWord === undefined ? await scan('components/x.tsx', source) : await onPage(source, pageWord);
    return r.literals.find((l) => l.text === text)?.proposedKey;
  };

  it('names a literal by its page, its section and its role, and carries its place', async () => {
    const r = await onPage('<section id="hero"><h1>Your week, sorted</h1></section>');
    expect(r.literals).toHaveLength(1);
    expect(r.literals[0]?.proposedKey).toBe('home_hero_headline');
    expect(r.literals[0]?.place).toEqual({ file: 'app/page.tsx', line: 1, tag: 'h1' });
    expect(r.literals[0]?.sectionWord).toBe('hero');
  });

  it('spells no section as page, and main never names one', async () => {
    expect(await keyOf(page('<main><img alt="A diagram of the flow" /></main>'), 'A diagram of the flow', 'home')).toBe(
      'home_page_image_alt_text',
    );
  });

  it('names cards and steps by their place, the adoption spec’s JSX page', async () => {
    const source = page(
      '<section id="services">' +
        ['Data sourcing work', 'Labelling at scale', 'Evaluation of models']
          .map((t, i) => `<article><h3>${t}</h3><p>What card ${i + 1} covers.</p></article>`)
          .join('') +
        '</section>' +
        '<section id="process"><h2>How we work</h2><h3>Four steps in all</h3><ol>' +
        ['Talk it over', 'Scope the set']
          .map((t, i) => `<li><h3>${t}</h3><p>What step ${i + 1} holds.</p></li>`)
          .join('') +
        '</ol></section>',
    );
    const r = await onPage(source);
    expect(r.literals.map((l) => l.proposedKey)).toEqual([
      'home_services_card_1_headline',
      'home_services_card_1_paragraph',
      'home_services_card_2_headline',
      'home_services_card_2_paragraph',
      'home_services_card_3_headline',
      'home_services_card_3_paragraph',
      'home_process_headline',
      'home_process_subheadline',
      'home_process_step_1_headline',
      'home_process_step_1_paragraph',
      'home_process_step_2_headline',
      'home_process_step_2_paragraph',
    ]);
    expect(r.literals[0]).toMatchObject({ sectionWord: 'services', item: 'card_1' });
  });

  it('reads an item holding one text as no item, whatever else the file holds', async () => {
    const source = page('<section id="list"><h2>Our short list</h2><ul><li>First item text</li><li>Second item text</li></ul></section>');
    expect(await keyOf(source, 'First item text', 'home')).toBe('home_list_list_item');
  });

  it('names five thousand list items inside its budget', async () => {
    const items = Array.from({ length: 5_000 }, (_, i) => `<li><h3>Heading ${i}</h3><p>Text number ${i}.</p></li>`).join('');
    const started = Date.now();
    const r = await onPage(page(`<section id="many"><ul>${items}</ul></section>`));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.literals).toHaveLength(10_000);
    expect(r.literals[9_999]?.proposedKey).toBe('home_many_item_5000_paragraph');
  }, 20_000);

  it('gives an accessor call its place and the name the rule gives it', async () => {
    const r = await onPage(page('<section id="hero"><h1>{copy(\'hero_title\')}</h1><img alt={copy(\'hero_alt\')} /></section>'));
    const title = r.accessorCalls.find((c) => c.key === 'hero_title');
    expect(title?.place).toMatchObject({ tag: 'h1' });
    expect(title).toMatchObject({ section: 'hero', role: 'headline' });
    expect(title?.item).toBeUndefined();
    const alt = r.accessorCalls.find((c) => c.key === 'hero_alt');
    expect(alt?.place).toMatchObject({ tag: 'img', attr: 'alt' });
    expect(alt).toMatchObject({ section: 'hero', role: 'image_alt_text' });
  });

  it("names a section with no id by its heading's first words", async () => {
    const source = page('<section><h2>Frequently asked</h2><h3>Does it buy the data?</h3></section>');
    // An <h3> under a section first headed by an <h2> is a subheadline (P4).
    expect(await keyOf(source, 'Does it buy the data?', 'home')).toBe('home_frequently_asked_subheadline');
    expect(await keyOf(source, 'Frequently asked', 'home')).toBe('home_frequently_asked_headline');
  });

  it("names a component file's literal by the component, with no page part", async () => {
    expect(await keyOf('export function PricingCard() { return <div><h2>Premium</h2></div> }', 'Premium')).toBe(
      'pricing_card_headline',
    );
    expect(await keyOf('const Hero = () => <p>Hi there</p>;', 'Hi there')).toBe('hero_paragraph');
    expect(await keyOf('export function Toolbar() { return <Button>Save now</Button> }', 'Save now')).toBe('toolbar_button');
  });

  it('names a symbol-only literal by its role, never the fallback key (F8)', async () => {
    expect(await keyOf(page('<span>%</span>'), '%', 'home')).toBe('home_page_span');
  });

  it('keeps the text-derived name for a send argument, which has no element', async () => {
    const r = await scan('lib/email/welcome.ts', "export function f(x: unknown) { send({ subject: 'Welcome to Mirra', to: x }); }");
    expect(r.literals[0]?.context).toBe('send-arg');
    expect(r.literals[0]?.proposedKey).toBe('welcome_to_mirra');
  });

  it('reads an id given as a braced string', async () => {
    expect(await keyOf(page('<section id={"hero"}><h1>Your week, sorted</h1></section>'), 'Your week, sorted', 'home')).toBe(
      'home_hero_headline',
    );
  });

  it("reads a heading as all the text inside it, an inline element's included", async () => {
    const source = page('<section><h2>Frequently <b>asked</b> things</h2><p>The answers follow.</p></section>');
    const r = await onPage(source);
    expect(r.literals.find((l) => l.text === 'The answers follow.')?.sectionWord).toBe('frequently_asked_things');
  });

  it("reads a meta's content under its name, as a head text with no section", async () => {
    const source = page('<meta property="og:description" content="A share line for the page." />');
    expect(await keyOf(source, 'A share line for the page.', 'home')).toBe('home_share_description');
  });

  it("names a component's prop by the component and the prop", async () => {
    expect(await keyOf(page('<main><Image alt="A friendly face" /></main>'), 'A friendly face', 'home')).toBe('home_page_image_alt');
    const source = page('<title>My page title here</title><Card title="A card heading here" />');
    expect(await keyOf(source, 'My page title here', 'home')).toBe('home_page_title');
    expect(await keyOf(source, 'A card heading here', 'home')).toBe('home_page_card_title');
  });

  it("cuts a long component's name to its first three words", async () => {
    const source = 'export function VeryLongComponentNameForTheMarketingHeroSection() { return <p>Some words here</p>; }';
    expect(await keyOf(source, 'Some words here')).toBe('very_long_component_paragraph');
  });

  for (const row of SECTION_WORD_ROWS) {
    it(`answers the fixture row: ${row.name}`, async () => {
      const source = page(row.markup);
      // The marked element's open tag, and the text directly after it: the
      // literal on it is an attribute inside the tag or the text after it.
      const open = source.indexOf(' data-mark');
      const start = source.lastIndexOf('<', open);
      const end = source.indexOf('>', open);
      const after = source.indexOf('<', end);
      const r = await onPage(source);
      const found = r.literals.filter((l) => (l.pos > start && l.pos < end) || (l.pos > end && l.pos < after));
      expect(found).toHaveLength(1);
      expect(found[0]?.sectionWord).toBe(row.word);
      expect(found[0]?.item).toBe(row.item);
    });
  }
});

describe('scanDialect — what the markup holds beside its text (D13)', () => {
  const texts = (source: string): string[] => scanDialect('a.astro', source, 'astro').map((f) => f.text);

  it("finds a tag's copy attributes and a component's prose props at their values (T13.1)", () => {
    const source = [
      '<SectionHead label="Capabilities" flag="var(--x)" sub="One registry holds them all" variant="primary" hint="/docs/intro" eyebrow="Overview" />',
      '<button title="Copy">Go</button>',
      '<button onClick={() => go()} title="Save">Go</button>',
      '<a title="Next > Previous" href="/x">Go</a>',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="description" content="Plain words here">',
    ].join('\n');
    const found = scanDialect('a.astro', source, 'astro');
    // Each attribute is a finding at its value, in file order; `flag`, `variant`, `hint` and the one-word `eyebrow` are no copy.
    const attrs = ['Capabilities', 'One registry holds them all', 'Copy', 'Save', 'Next > Previous', 'Plain words here'];
    expect(found.filter((f) => attrs.includes(f.text)).map((f) => f.text)).toEqual(attrs);
    for (const f of found.filter((f) => attrs.includes(f.text))) {
      expect(source.slice(f.pos, f.pos + f.text.length)).toBe(f.text);
      expect(source.slice(f.pos - 1, f.pos)).toBe('"');
    }
    const all = found.map((f) => f.text).join('\n');
    for (const absent of ['var(--x)', 'primary', '/docs/intro', 'Overview', 'width=device-width']) expect(all).not.toContain(absent);
  });

  it('keeps the viewport meta out and an empty alt out (T13.1)', () => {
    expect(texts('<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, follow"><img alt="" src="/a.png"><img alt="A team photo" src="/b.png">')).toEqual(['A team photo']);
  });

  it('reads the attributes of a dialect other than Astro the same way (T13.1)', () => {
    expect(scanDialect('a.vue', '<template><Hero heading="Words for everyone" /><input placeholder="Your email" /></template>', 'vue').map((f) => f.text)).toEqual(['Words for everyone', 'Your email']);
  });

  it('finds the markup inside a content brace, and only its words (T13.4)', () => {
    expect(texts('{flags.changelog && <a class="i" href="/changelog">Changelog</a>}')).toEqual(['Changelog']);
    expect(texts('{groups.map((group) => (<p>{group.heading}</p>))}')).toEqual([]);
    expect(texts('{x ? "a" : "b"}')).toEqual([]);
    expect(texts('<div set:html={`<p>Welcome back</p>`} />').join('\n')).not.toContain('Welcome back');
  });

  it('reads one sentence with its inline tags dropped, and only one (T13.5)', () => {
    expect(texts('<p>Install: run <b>npx x init</b> and answer.</p>')).toEqual(['Install: run npx x init and answer.']);
    expect(texts('<p>One</p><div>Two words</div>')).toEqual(['One', 'Two words']);
    expect(texts('<div class="term"><span class="l"><span class="p">$</span> <span class="w">npx x init</span></span><span class="l">next line here</span></div>')).toEqual(['npx x init', 'next line here']);
    expect(texts('<div><a>Docs page</a>\n<a>Pricing page</a></div>')).toEqual(['Docs page', 'Pricing page']);
    // A parent whose own text is no word (`&nbsp;`, an entity for a brace) does not join its children.
    expect(texts('<span class="l"><span class="p">$</span>&nbsp;<span class="w">npx x</span></span>')).toContain('npx x');
    expect(texts('<span class="l"><span class="k">"default"</span>: &#123;</span>')).toContain('"default"');
    // A line with words of its own joins its inline children.
    expect(texts('<span class="l"><span class="k">draft v7 saved</span> · nobody&#39;s live copy changed</span>')).toEqual(["draft v7 saved · nobody's live copy changed"]);
    expect(texts('<p>foo<b>bar</b> baz</p>')).toEqual(['foobar baz']);
    // A brace inside the sentence still breaks it: an expression is not copy.
    expect(texts('<p>Hello <b>{name}</b> there again</p>')).toEqual(['Hello', 'there again']);
  });

  it('keeps a declared name as copy (T13.6)', () => {
    expect(texts('---\nimport SiteNav from "./SiteNav.astro";\n---\n<h2>SiteNav</h2>\n<h2>GitHub</h2>')).toEqual(['SiteNav', 'GitHub']);
  });

  it('leaves a raw sample alone, breaks a sentence at a br, and joins del and ins (T13.13)', () => {
    expect(texts('<h3>Words here</h3><pre is:raw><code>{flag && <a>Sample link</a>}</code></pre>')).toEqual(['Words here']);
    expect(texts('<p>One line<br>two words</p>')).toEqual(['One line', 'two words']);
    expect(texts('<p>Was <del>old</del> <ins>new</ins> words</p>')).toEqual(['Was old new words']);
  });

  it('names the inline set once (T13.5, T13.13)', () => {
    expect(INLINE.has('span') && INLINE.has('del') && INLINE.has('ins')).toBe(true);
    expect(INLINE.has('br') || INLINE.has('wbr') || INLINE.has('button') || INLINE.has('img')).toBe(false);
  });
});

describe('astroFindings — the front matter\'s display data (D13)', () => {
  const dataOf = async (source: string): Promise<Array<{ text: string; at: string }>> => {
    const found = astroFindings(await loadTypescript(), 'a.astro', source);
    return (found.data ?? []).map((f) => ({ text: f.text, at: source.slice(f.pos, f.pos + 1) }));
  };

  it("reports a shown const's words at their opening quote, and not an unused one (T13.2)", async () => {
    const front = '---\nconst surfaces = [{ id: "Site copy id", label: "Site copy", note: "Typed keys, limits.", href: "/docs", img: "/p.webp" }];\n---\n';
    expect(await dataOf(`${front}{surfaces.map((s) => <h3>{s.label}</h3>)}`)).toEqual([
      { text: 'Site copy', at: '"' },
      { text: 'Typed keys, limits.', at: '"' },
    ]);
    expect(await dataOf(`${front}<h3>Plain</h3>`)).toEqual([]);
  });

  it('reads tuples and a conditional spread, not the paths (T13.3)', async () => {
    const source =
      '---\nconst groups = [{ h: "Features", links: [["Email slots", "/features#e"], ["llms.txt", "/llms.txt"]] }, ...(flag ? [["Changelog", "/changelog"]] : [])];\n---\n{groups.map((g) => <p>{g.h}</p>)}';
    expect((await dataOf(source)).map((f) => f.text)).toEqual(['Features', 'Email slots', 'Changelog']);
  });

  it('reads an object under a structural name by its own names', async () => {
    const source = '---\nconst uses = [{ title: "Fixing a word", media: { kind: "code", caption: "stet scan output", src: "/a.webp" } }];\n---\n{uses.map((u) => <p>{u.title}</p>)}';
    expect((await dataOf(source)).map((f) => f.text)).toEqual(['Fixing a word', 'stet scan output']);
  });

  it('skips a string a call, a template or an ignore marker keeps out', async () => {
    const source =
      '---\nconst a = ["First words", t("Second words"), `Third ${x} words`];\n// stet-ignore-next-line\nconst b = ["Fourth words"];\nlet c = ["Fifth words"];\n---\n{a}{b}{c}';
    expect((await dataOf(source)).map((f) => f.text)).toEqual(['First words']);
  });

  it('counts a front matter after a byte-order mark (T13.14)', async () => {
    const source = '﻿---\nconst surfaces = [{ label: "Site copy" }];\n---\n{surfaces.map((s) => <h3>{s.label}</h3>)}';
    const found = astroFindings(await loadTypescript(), 'a.astro', source).data ?? [];
    expect(found.map((f) => f.text)).toEqual(['Site copy']);
    expect(source.slice((found[0] as { pos: number }).pos, (found[0] as { pos: number }).pos + 11)).toBe('"Site copy"');
  });

  it('reports nothing for a front matter that does not parse, and null without the compiler', async () => {
    expect((await dataOf('---\nconst a = [ "Broken words" ;\n---\n{a}')).length).toBe(0);
    expect(astroFindings(null, 'a.astro', '---\nconst a = "Some words";\n---\n{a}').data).toBeNull();
    expect(astroFindings(null, 'a.astro', '<p>Some words</p>').data).toEqual([]);
    // A front matter with no `const` needs no compiler.
    expect(astroFindings(null, 'a.astro', '---\nimport Layout from "./Layout.astro";\n---\n<p>Some words</p>').data).toEqual([]);
  });
});

describe('scanSource — a component\'s prose props and module data (D13)', () => {
  const tsx = (body: string): Promise<Awaited<ReturnType<typeof scanSource>>> => scan('app/page.tsx', body);

  it("reports a component's multi-word string prop as a jsx-attr literal (T13.7)", async () => {
    const r = await tsx('export default function P() {\n  return <SectionHead sub="One registry holds them all" variant="primary" hint="/docs" eyebrow="Overview" />;\n}\n');
    expect(r.literals.map((l) => [l.context, l.place?.attr, l.text])).toEqual([['jsx-attr', 'sub', 'One registry holds them all']]);
  });

  it('keeps a plain element\'s prose attribute out (T13.7)', async () => {
    const r = await tsx('export default function P() {\n  return <div data-x="two words here" className="a b" />;\n}\n');
    expect(r.literals).toEqual([]);
  });

  it('reports a component\'s non-copy props as literals too (T13.12)', async () => {
    const r = await tsx('export default function P() {\n  return <Field aria-describedby="hint error" testID="login button" event="Signup started" sub="One registry holds them all" />;\n}\n');
    expect(r.literals.map((l) => l.place?.attr)).toEqual(['aria-describedby', 'testID', 'event', 'sub']);
  });

  it('reports module data that is rendered, with the opening quote as its position (T13.8)', async () => {
    const source = 'const items = [{ title: "Fixing a word" }];\nconst unused = [{ title: "Never shown" }];\nexport default function P() {\n  return <ul>{items.map((i) => <h3>{i.title}</h3>)}</ul>;\n}\n';
    const r = await tsx(source);
    expect(r.data.map((f) => f.text)).toEqual(['Fixing a word']);
    expect(source.slice((r.data[0] as { pos: number }).pos, (r.data[0] as { pos: number }).pos + 1)).toBe('"');
  });
});

describe('scan gaps — fix round (D13)', () => {
  const texts = (source: string): string[] => scanDialect('a.astro', source, 'astro').map((f) => f.text);
  const dataOf = async (source: string): Promise<string[]> => (astroFindings(await loadTypescript(), 'a.astro', source).data ?? []).map((f) => f.text);
  const tsx = (body: string): Promise<Awaited<ReturnType<typeof scanSource>>> => scan('app/page.tsx', body);

  describe('wiring attributes do not make a const shown', () => {
    it('Astro: a class map, a class:list array and a style object stay out', async () => {
      const variants = '---\nconst variants = { primary: "bg-blue-600 text-white" };\n---\n';
      expect(await dataOf(`${variants}<button class={variants[v]}>Go</button>`)).toEqual([]);
      expect(await dataOf('---\nconst base = "rounded px-4 py-2";\n---\n<a class:list={[base]}>Go</a>')).toEqual([]);
      expect(await dataOf('---\nconst look = { display: "flex items" };\n---\n<div style={look}>Go</div>')).toEqual([]);
      expect(await dataOf('---\nconst hooks = { open: "do open now" };\n---\n<a data-x={hooks.open} id={hooks.open} href={hooks.open}>Go</a>')).toEqual([]);
    });

    it('Astro: copy attributes and component props still show a const', async () => {
      expect(await dataOf('---\nconst labels = { logo: "Company logo" };\n---\n<img alt={labels.logo} />')).toEqual(['Company logo']);
      expect(await dataOf('---\nconst copy = { cap: "Site capabilities" };\n---\n<SectionHead label={copy.cap} />')).toEqual(['Site capabilities']);
    });

    it('JSX: a className map stays out, a rendered child still shows', async () => {
      expect((await tsx('const variants = { primary: "bg-blue-600 text-white" };\nexport default function P() {\n  return <button className={variants[v]}>Go</button>;\n}\n')).data).toEqual([]);
      expect((await tsx('const items = [{ title: "Fixing a word" }];\nexport default function P() {\n  return <ul>{items.map((i) => <h3>{i.title}</h3>)}</ul>;\n}\n')).data.map((f) => f.text)).toEqual(['Fixing a word']);
      expect((await tsx('const labels = { logo: "Company logo" };\nexport default function P() {\n  return <img alt={labels.logo} />;\n}\n')).data.map((f) => f.text)).toEqual(['Company logo']);
    });
  });

  describe('the object walk', () => {
    it('enters an object only under media, img, image or icon', async () => {
      const source = '---\nconst uses = [{ style: { fontFamily: "Helvetica Neue", transition: "all 0.3s ease" }, media: { kind: "code", caption: "stet scan output" } }];\n---\n{uses.map((u) => <p>{u.media.caption}</p>)}';
      expect(await dataOf(source)).toEqual(['stet scan output']);
    });
  });

  describe('wiring props are no copy', () => {
    const card = '<Card wrapperClass="flex items-center gap-2" gradient="from-blue-500 to-indigo-600" align="top left" mode="dark light" heroUrl="the home page" iconColor="deep sky blue" sub="One registry holds them all" />';

    it('scanDialect skips the wiring props of a component and keeps the prose one', () => {
      expect(texts(card)).toEqual(['One registry holds them all']);
    });

    it('scanSource reports the prose prop alone, so register never rewrites the rest', async () => {
      const r = await tsx(`export default function P() {\n  return ${card};\n}\n`);
      expect(r.literals.map((l) => [l.context, l.place?.attr, l.text])).toEqual([['jsx-attr', 'sub', 'One registry holds them all']]);
    });

    it('matches the suffixes whatever the case', () => {
      expect(texts('<Card WrapperClass="flex items-center" cardStyle="a b" imgSrc="a b" filePath="a b" parentRef="a b" buttonVariant="a b" bgcolor="a b" />')).toEqual([]);
    });

    it('a position prop is copy where it reads as words, and a single token is not', async () => {
      expect(texts('<Quote position="Staff engineer" /><Quote position="absolute" />')).toEqual(['Staff engineer']);
      const r = await tsx('export default function P() {\n  return <Quote position="Staff engineer" />;\n}\n');
      expect(r.literals.map((l) => [l.place?.attr, l.text])).toEqual([['position', 'Staff engineer']]);
    });

    it('a data field named for a position is still copy', async () => {
      expect(await dataOf('---\nconst team = [{ position: "Staff engineer" }];\n---\n{team.map((t) => <p>{t.position}</p>)}')).toEqual(['Staff engineer']);
    });
  });

  describe('event props', () => {
    it('keeps only, once and online props as copy', () => {
      expect(texts('<Badge only="Fast sync here" once="Just once more" online="Always on duty" />')).toEqual(['Fast sync here', 'Just once more', 'Always on duty']);
    });

    it('drops camelCase handlers and the lowercase DOM events', async () => {
      expect(texts('<Button onClick="Do something here" onclick="Do other things" onMouseEnter="Hover over this" />')).toEqual([]);
      const r = await tsx('export default function P() {\n  return <Button onClick="Do something here" only="Fast sync here" />;\n}\n');
      expect(r.literals.map((l) => l.place?.attr)).toEqual(['only']);
    });
  });

  describe('a component keeps its prose props under the cases a mutation could blur', () => {
    it('className and srcSet are no prose, in any case (JSX)', async () => {
      expect((await tsx('export default function P() {\n  return <Card className="a b" />;\n}\n')).literals).toEqual([]);
      expect((await tsx('export default function P() {\n  return <Img srcSet="small one 1x, large one 2x" />;\n}\n')).literals).toEqual([]);
    });

    it('a path or URL in a component prop is no copy', () => {
      expect(texts('<Foo hint="/docs/get started" /><Foo hint="https://x.io/a b" /><Foo hint="./a b" /><Foo hint="#top of page" />')).toEqual([]);
    });
  });

  describe('data strings that are paths or file names', () => {
    it('skips a file name, a path, a fragment and a URL', async () => {
      const source = '---\nconst links = ["README.md", "intro.md", "/docs/get started", "./a b c", "#top of page", "https://x.io/a b", "A real label"];\n---\n{links}';
      expect(await dataOf(source)).toEqual(['A real label']);
    });
  });

  describe('a brace run that crosses a masked region', () => {
    it('reports the tags\' own words and not the run around a comment', () => {
      expect(texts('{flag && <b>one</b> some <!-- hidden --> text here <i>two</i>}')).toEqual(['one', 'two']);
    });
  });

  describe('inline joins', () => {
    it('a self-closing inline tag is not a join', () => {
      expect(texts('<p>Hello <span/> world words</p>')).toEqual(['Hello', 'world words']);
    });

    it('does not join under a pre, line by line', () => {
      expect(texts('<pre><code><span class="p">$</span> npx x init\n<span class="m">wrote a.json</span>\n<span class="m">wrote b.json</span></code></pre>')).toEqual(['npx x init', 'wrote a.json', 'wrote b.json']);
      expect(texts('<p>Run <code>npx x init</code> and answer</p>')).toEqual(['Run npx x init and answer']);
    });

    describe('a number that decorates a line (PD1)', () => {
      it('stays out of the sentence at either edge', () => {
        expect(texts('<h2><span class="n">01</span>Scan your components</h2>')).toEqual(['Scan your components']);
        expect(texts('<h2>Scan your components<span class="n">01</span></h2>')).toEqual(['Scan your components']);
        expect(texts('<p>Claim made here<sup>1</sup></p>')).toEqual(['Claim made here']);
        expect(texts('<li><span>2.</span> Run the scan</li>')).toEqual(['Run the scan']);
        // An entity that decodes to no letter (`&nbsp;`) does not make the edge a word.
        expect(texts('<h2>&nbsp;<span class="n">01</span>Scan your components</h2>').filter((t) => t.includes('Scan'))).toEqual(['Scan your components']);
      });

      it('joins a number in the middle, a symbol and a word', () => {
        expect(texts('<p>Price: <b>$5</b> per month</p>')).toEqual(['Price: $5 per month']);
        expect(texts('<p><b>Note:</b> read this</p>')).toEqual(['Note: read this']);
        expect(texts('<span class="l"><span class="g">✓</span> wrote a.json</span>')).toEqual(['✓ wrote a.json']);
        expect(texts('<a>stet<span>.</span></a>')).toEqual(['stet.']);
        expect(texts('<p>Pay <b>5</b> dollars now</p>')).toEqual(['Pay 5 dollars now']);
      });
    });
  });
});

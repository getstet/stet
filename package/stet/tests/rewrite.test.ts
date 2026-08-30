/**
 * The leaf rewrite engine — the source-editing half of adoption. The literals
 * and accessor calls fed in come from the real `scanSource`, and every
 * un-rewrite output is re-scanned to prove it still parses: a serializer that
 * emitted a syntax error would surface as `parseErrors`.
 */
import { describe, expect, it } from 'vitest';

import { applyFileEdits, formatDiff, planRewrite, unRewriteFile } from '../cli/rewrite.js';
import { scanSource } from '../cli/source-scan.js';

const scan = (file: string, src: string) => scanSource(file, src, { readPathImport: '@/lib/content' });

describe('planRewrite', () => {
  it('refuses a non-JSX shape at the entry, ahead of every other check', async () => {
    // This engine takes the JSX walk's findings and nothing else. Its leaf
    // context ternary is not exhaustive, so a copy-module finding reaching it
    // writes a JSX-brace rewrite into a `.ts` file — no compile error, no
    // failing type, the host's source silently corrupted. `LocatedLiteral`
    // carries all four shapes, so only a runtime check can catch it.
    const src = 'export function C() { return <h1>Your week</h1>; }';
    const r = await scan('app/page.tsx', src);
    const jsx = r.literals[0]!;

    expect(() => planRewrite(src, { ...jsx, shape: 'property' }, 'k', 'server', '@/lib/content')).toThrow(
      /stet internal: a property-shaped finding/,
    );
    expect(() => planRewrite(src, { ...jsx, shape: 'template' }, 'k', 'server', '@/lib/content')).toThrow(
      /stet internal: a template-shaped finding/,
    );
    // The message names the file it came from, which is the only way to find it.
    expect(() => planRewrite(src, { ...jsx, shape: 'plain' }, 'k', 'server', '@/lib/content')).toThrow(
      /in app\/page\.tsx reached the rewrite path/,
    );
    // Shape is checked BEFORE staleness: a wrong-shape literal against source
    // it no longer matches must still be refused as the wrong SHAPE, or the
    // operator is sent to re-run a scan that would change nothing.
    expect(() =>
      planRewrite('const unrelated = 1;\n', { ...jsx, shape: 'property' }, 'k', 'server', '@/lib/content'),
    ).toThrow(/stet internal: a property-shaped finding/);

    // …and the JSX shape proceeds, so the guard refuses shapes rather than work.
    expect(planRewrite(src, jsx, 'your_week', 'server', '@/lib/content').edits.length).toBeGreaterThan(0);
  });

  it('a server leaf inserts the read-path import and rewrites the leaf, with no hook', async () => {
    const src = 'export function C() { return <h1>Your week</h1>; }';
    const r = await scan('app/page.tsx', src);
    expect(r.literals).toHaveLength(1);
    const { edits, skipped } = planRewrite(src, r.literals[0]!, 'your_week', 'server', '@/lib/content');
    expect(skipped).toBeUndefined();
    const out = applyFileEdits(src, edits);
    expect(out).toContain("import { copy } from '@/lib/content';");
    expect(out).toContain("{copy('your_week')}");
    expect(out).not.toContain('useCopy'); // server is module-scoped — no hook, no const
    const rescan = await scan('app/page.tsx', out);
    expect(rescan.literals).toHaveLength(0); // idempotent: the leaf is now an accessor call
    expect(rescan.accessorCalls).toHaveLength(1);
  });

  it('a client leaf inserts useCopy AFTER use client and one const copy in the component', async () => {
    const src = "'use client';\nimport { Foo } from 'x';\nexport function C() { return <h1>Hi</h1>; }";
    const r = await scan('app/page.tsx', src);
    const out = applyFileEdits(src, planRewrite(src, r.literals[0]!, 'hi', 'client', '@/lib/content').edits);
    expect(out).toContain("import { useCopy } from '@getstet/stet/react';");
    // the import lands after the directive AND the last import
    expect(out.indexOf("import { useCopy } from '@getstet/stet/react';")).toBeGreaterThan(out.indexOf("import { Foo }"));
    expect(out.match(/const copy = useCopy\(\);/g)).toHaveLength(1);
    expect(out).toContain("{copy('hi')}");
    expect((await scan('app/page.tsx', out)).parseErrors).toBe(false);
  });

  it('a stet-bound leaf gets the leaf ONLY — no duplicate import or const (re-run)', async () => {
    const src = "'use client';\nimport { useCopy } from '@getstet/stet/react';\nexport function C() { const copy = useCopy(); return <h1>Hi</h1>; }";
    const r = await scan('app/page.tsx', src);
    expect(r.literals[0]!.copyBinding).toBe('stet');
    const { edits } = planRewrite(src, r.literals[0]!, 'hi', 'client', '@/lib/content');
    expect(edits).toHaveLength(1); // the leaf edit alone
    const out = applyFileEdits(src, edits);
    expect(out.match(/import \{ useCopy \}/g)).toHaveLength(1);
    expect(out.match(/const copy = useCopy\(\);/g)).toHaveLength(1);
    expect(out).toContain("{copy('hi')}");
  });

  it('a foreign copy binding is skipped as copy-collision, no edits', async () => {
    const src = "import copy from 'copy-to-clipboard';\nexport function C() { return <h1>Hi</h1>; }";
    const r = await scan('app/page.tsx', src);
    expect(r.literals[0]!.copyBinding).toBe('foreign');
    const res = planRewrite(src, r.literals[0]!, 'hi', 'client', '@/lib/content');
    expect(res.skipped).toBe('copy-collision');
    expect(res.edits).toHaveLength(0);
  });

  it('a client leaf with no enclosing component body is skipped as no-component-body', async () => {
    // A bare top-level JSX expression: no block-bodied component to host the hook.
    const src = 'const node = <h1>Hi</h1>;';
    const r = await scan('app/page.tsx', src);
    expect(r.literals[0]!.enclosingBodyPos).toBeNull();
    const res = planRewrite(src, r.literals[0]!, 'hi', 'client', '@/lib/content');
    expect(res.skipped).toBe('no-component-body');
  });

  it('two literals in one component yield ONE import and ONE const, both leaves rewritten', async () => {
    const src = "'use client';\nexport function C() { return <div><h1>One</h1><h2>Two</h2></div>; }";
    const r = await scan('app/page.tsx', src);
    expect(r.literals).toHaveLength(2);
    const edits = r.literals.flatMap((lit, i) => planRewrite(src, lit, `k${i}`, 'client', '@/lib/content').edits);
    const out = applyFileEdits(src, edits);
    expect(out.match(/import \{ useCopy \} from '@getstet\/stet\/react';/g)).toHaveLength(1);
    expect(out.match(/const copy = useCopy\(\);/g)).toHaveLength(1);
    expect(out).toContain("{copy('k0')}");
    expect(out).toContain("{copy('k1')}");
    const rescan = await scan('app/page.tsx', out);
    expect(rescan.parseErrors).toBe(false);
    expect(rescan.literals).toHaveLength(0);
  });

  it('refuses when the source moved since scan (the re-confirm guard)', async () => {
    const src = 'export function C() { return <h1>Your week</h1>; }';
    const r = await scan('app/page.tsx', src);
    const moved = `const x = 1;\n${src}`; // every offset shifts
    expect(() => planRewrite(moved, r.literals[0]!, 'your_week', 'server', '@/lib/content')).toThrow(/re-run stet scan/);
  });

  it('P3-13 — inserts CRLF-terminated lines into a CRLF host, never a mixed ending', async () => {
    const src = ["'use client';", "import { Foo } from 'x';", 'export function C() { return <h1>Hi</h1>; }'].join('\r\n');
    const r = await scan('app/page.tsx', src);
    const out = applyFileEdits(src, planRewrite(src, r.literals[0]!, 'hi', 'client', '@/lib/content').edits);
    // both the import and the hook binding pick up the host's \r\n
    expect(out).toContain("\r\nimport { useCopy } from '@getstet/stet/react';");
    expect(out).toContain('const copy = useCopy();\r\n');
    // no LF that is not part of a CRLF pair — the file stays uniformly CRLF
    expect(/[^\r]\n/.test(out)).toBe(false);
    expect((await scan('app/page.tsx', out)).parseErrors).toBe(false);
  });

  it('a MIXED-ending host takes the majority ending, not whichever appeared first', async () => {
    // `dominantEol` decides, and it counts rather than sniffing: the engine's
    // former inline probe took CRLF the moment ANY CRLF appeared, so one stray
    // CRLF in a vendored LF file made every inserted line CRLF. Pinned here
    // because the promotion into rewrite.ts changed this behaviour, and an
    // unpinned behaviour change is one nothing would notice being reverted.
    const src = [
      "'use client';\r\n", // the one CRLF line
      "import { Foo } from 'x';\n",
      'export function C() {\n',
      '  return <h1>Hi</h1>;\n',
      '}\n',
    ].join('');
    const r = await scan('app/page.tsx', src);
    const out = applyFileEdits(src, planRewrite(src, r.literals[0]!, 'hi', 'client', '@/lib/content').edits);
    expect(out).toContain("\nimport { useCopy } from '@getstet/stet/react';");
    expect(out).not.toContain("\r\nimport { useCopy } from '@getstet/stet/react';");
    expect(out).toContain('const copy = useCopy();\n');
    expect(out).not.toContain('const copy = useCopy();\r\n');
    // the host's own stray CRLF is left exactly as it was
    expect(out).toContain("'use client';\r\n");
    expect((await scan('app/page.tsx', out)).parseErrors).toBe(false);
  });

  it('P3-14 — a leading BOM stays at offset 0; the inserted import lands after it', async () => {
    const bom = String.fromCharCode(0xfeff); // U+FEFF as an escape, so no invisible byte sits in this test
    const src = `${bom}export function C() { return <h1>Your week</h1>; }`;
    const r = await scan('app/page.tsx', src);
    const out = applyFileEdits(src, planRewrite(src, r.literals[0]!, 'your_week', 'server', '@/lib/content').edits);
    expect(out.charCodeAt(0)).toBe(0xfeff); // BOM still first
    expect(out.indexOf(bom, 1)).toBe(-1); // and nowhere else — never mid-file
    expect(out.slice(1)).toMatch(/^import \{ copy \} from '@\/lib\/content';/);
    expect((await scan('app/page.tsx', out)).parseErrors).toBe(false);
  });
});

describe('applyFileEdits', () => {
  it('refuses overlapping edits', () => {
    expect(() =>
      applyFileEdits('abcdef', [
        { pos: 0, end: 3, text: 'X' },
        { pos: 2, end: 4, text: 'Y' },
      ]),
    ).toThrow(/overlapping/);
  });

  it('orders a zero-width insert after a replacement at the same offset', () => {
    // insert "IN" at 0 and replace [0,3) with "R" → the insert survives before R.
    const out = applyFileEdits('abcdef', [
      { pos: 0, end: 0, text: 'IN' },
      { pos: 0, end: 3, text: 'R' },
    ]);
    expect(out).toBe('INRdef');
  });
});

describe('unRewriteFile', () => {
  it('restores jsx-text values (quote, angle brackets, newline) with no syntax error', async () => {
    for (const value of ["Don't miss out", 'a < b', 'a > b', "a < b, don't forget", 'line one\nline two']) {
      const src = "export function C() { return <p>{copy('k')}</p>; }";
      const r = await scan('app/page.tsx', src);
      const { edited } = unRewriteFile(src, r.accessorCalls, { k: value }, []);
      expect((await scan('app/page.tsx', edited)).parseErrors).toBe(false);
    }
    // A value free of < > { } stays raw; one with them rides a JSON expression container.
    const raw = "export function C() { return <p>{copy('k')}</p>; }";
    const rr = await scan('app/page.tsx', raw);
    expect(unRewriteFile(raw, rr.accessorCalls, { k: "Don't" }, []).edited).toContain("<p>Don't</p>");
    expect(unRewriteFile(raw, rr.accessorCalls, { k: 'a < b' }, []).edited).toContain('{"a < b"}');
    // R-CP7-2: a bare `&` re-decodes as an entity in JSX text, so it rides the container too.
    const amp = unRewriteFile(raw, rr.accessorCalls, { k: 'Tom & Jerry' }, []).edited;
    expect(amp).toContain('{"Tom & Jerry"}');
    expect(amp).not.toContain('<p>Tom & Jerry</p>');
    expect((await scan('app/page.tsx', amp)).parseErrors).toBe(false);
  });

  it('un-rewrites a jsx-attr to a quoted value, not alt=alt=…', async () => {
    const src = "export function C() { return <img alt={copy('k')} />; }";
    const r = await scan('app/page.tsx', src);
    expect(r.accessorCalls[0]?.context).toBe('jsx-attr');
    const { edited } = unRewriteFile(src, r.accessorCalls, { k: 'A dog' }, []);
    expect(edited).toContain('alt="A dog"');
    expect(edited).not.toContain('alt=alt=');
    expect((await scan('app/page.tsx', edited)).parseErrors).toBe(false);

    // A value with a double quote flips to single-quote delimiter; `&` is escaped.
    const quoted = unRewriteFile(src, r.accessorCalls, { k: 'a "quoted" word' }, []).edited;
    expect(quoted).toContain(`alt='a "quoted" word'`);
    const amp = unRewriteFile(src, r.accessorCalls, { k: 'Tom & Jerry' }, []).edited;
    expect(amp).toContain('alt="Tom &amp; Jerry"');
    expect((await scan('app/page.tsx', quoted)).parseErrors).toBe(false);
  });

  it('un-rewrites a send-arg via JSON.stringify', async () => {
    const src = "send({ subject: copy('k') });";
    const r = await scan('lib/email/x.ts', src);
    expect(r.accessorCalls[0]?.context).toBe('send-arg');
    const { edited } = unRewriteFile(src, r.accessorCalls, { k: "Don't miss out" }, []);
    expect(edited).toContain('subject: "Don\'t miss out"');
    expect((await scan('lib/email/x.ts', edited)).parseErrors).toBe(false);
  });

  it('a non-string value is JSON.stringified in every context, never [object Object]', async () => {
    const jsxSrc = "export function C() { return <p>{copy('k')}</p>; }";
    const jsx = await scan('app/page.tsx', jsxSrc);
    const e1 = unRewriteFile(jsxSrc, jsx.accessorCalls, { k: 42 }, []).edited;
    expect(e1).toContain('{42}');
    expect(e1).not.toContain('[object Object]');

    const sendSrc = "send({ subject: copy('k') });";
    const send = await scan('lib/email/x.ts', sendSrc);
    const e2 = unRewriteFile(sendSrc, send.accessorCalls, { k: { a: 1 } }, []).edited;
    expect(e2).toContain('subject: {"a":1}');
    expect(e2).not.toContain('[object Object]');
  });

  it('aborts (never emits an undefined token) when a call key has no resolved value', async () => {
    const cases = [
      ['app/page.tsx', "export function C() { return <p>{copy('k')}</p>; }"], // jsx-text
      ['app/page.tsx', "export function C() { return <img alt={copy('k')} />; }"], // jsx-attr
      ['lib/email/x.ts', "send({ subject: copy('k') });"], // send-arg
    ] as const;
    for (const [file, src] of cases) {
      const r = await scan(file, src);
      // key absent from the map entirely
      expect(() => unRewriteFile(src, r.accessorCalls, {}, [])).toThrow(/no resolved value for key k/);
      // key present but undefined (resolveAll omits an unresolved key, but be explicit)
      expect(() => unRewriteFile(src, r.accessorCalls, { k: undefined }, [])).toThrow(/no resolved value for key k/);
    }
  });

  it('drops the orphaned stet import and const copy in the SAME batch as the un-rewrite', async () => {
    const src = [
      "'use client';",
      "import { useCopy } from '@getstet/stet/react';",
      "export function C() { const copy = useCopy(); return <p>{copy('hi')}</p>; }",
    ].join('\n');
    const r = await scan('app/page.tsx', src);
    expect(r.accessorCalls).toHaveLength(1);
    const { edited } = unRewriteFile(src, r.accessorCalls, { hi: 'Hi there' }, [...r.stetImportSpans, ...r.copyDeclSpans]);
    expect(edited).not.toContain('@getstet/stet/react');
    expect(edited).not.toContain('useCopy');
    expect(edited).toContain('<p>Hi there</p>');
    expect((await scan('app/page.tsx', edited)).parseErrors).toBe(false);
  });

  it('R-CP7-1 — a FOREIGN copy() call is returned in skipped, left verbatim, never mangled', async () => {
    const src = "export function C() { const copy = (t: string) => t; return <p>{copy('k')}</p>; }";
    const r = await scan('app/page.tsx', src);
    expect(r.accessorCalls).toHaveLength(1);
    expect(r.accessorCalls[0]?.copyBinding).toBe('foreign');
    const res = unRewriteFile(src, r.accessorCalls, { k: 'Value' }, []);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]?.key).toBe('k');
    expect(res.edits).toHaveLength(0);
    expect(res.edited).toBe(src); // untouched — a live clipboard call, not stet's
  });
});

describe('formatDiff', () => {
  it('is empty for identical input', () => {
    expect(formatDiff('f.tsx', 'a\nb\n', 'a\nb\n')).toBe('');
  });

  it('renders a unified hunk with removed and added lines', () => {
    const d = formatDiff('f.tsx', 'a\nb\nc\n', 'a\nB\nc\n');
    expect(d).toContain('--- a/f.tsx');
    expect(d).toContain('+++ b/f.tsx');
    expect(d).toContain('@@');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
  });

  it('P2-9 — a changed span past the LCS cell bound falls back to a coarse remove-then-add block', () => {
    // The prefix/suffix trim leaves a changed MIDDLE; count its +/- lines. Below the
    // 4M-cell bound the LCS keeps the shared interior as context (1 remove, 1 add);
    // above it, the coarse fallback emits every middle line — so both counts jump to
    // the middle's length. sqrt(4_000_000) = 2000, so 2000² is at the bound and
    // 2001² is just past it.
    const shared = (n: number): string[] => Array.from({ length: n }, (_, i) => `shared line ${i}`);
    const countPM = (d: string): { plus: number; minus: number } => ({
      plus: d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
      minus: d.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
    });

    // Just UNDER the bound (2000×2000): LCS aligns the shared block as context.
    const aUnder = ['X', ...shared(1999)].join('\n');
    const bUnder = [...shared(1999), 'Y'].join('\n');
    const under = countPM(formatDiff('big.tsx', aUnder, bUnder));
    expect(under.plus).toBe(1);
    expect(under.minus).toBe(1);

    // Just OVER the bound (2001×2001): the coarse block emits all middle lines.
    const aOver = ['X', ...shared(2000)].join('\n');
    const bOver = [...shared(2000), 'Y'].join('\n');
    const over = countPM(formatDiff('big.tsx', aOver, bOver));
    expect(over.plus).toBe(2001);
    expect(over.minus).toBe(2001);
  });
});

/**
 * The leaf rewrite engine — the half of adoption that edits a stranger's source,
 * so it is source-safe by construction: every edit is a span against the
 * ORIGINAL text, a file's edits apply as one descending batch that asserts
 * non-overlap before a byte moves, and the inverse un-rewrite serializes each
 * value for its exact JSX/JS context.
 *
 * `planRewrite` proposes; `applyFileEdits` commits; `unRewriteFile` reverses.
 * None parse — they consume the spans `source-scan.ts` already located, so the
 * one parse per file stays in the scanner.
 */

import { parseDiagnosticsOf, scanSource, scriptKindFor, type LocatedAccessor, type LocatedLiteral, type Span } from './source-scan.js';
import { CliError } from './report.js';

/** A span replacement; an insertion has `pos === end`. */
export type Edit = { pos: number; end: number; text: string };

/**
 * The line ending a file mostly uses, which is the one an edit writes into it —
 * a `\n` inserted into a CRLF file is a mixed-ending line (P3-13).
 *
 * It lives here, with the engine that edits a stranger's source, because that is
 * the job it belongs to; `email extract`'s slot widening and the agent-guidance
 * append are its other two consumers.
 */
export function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * The edits that adopt ONE located literal, against the original source. Returns
 * `skipped` (and no edits) for a leaf that cannot be rewritten safely, so the
 * caller reports the manual step rather than mangling the file.
 */
export function planRewrite(
  source: string,
  located: LocatedLiteral,
  key: string,
  kind: 'server' | 'client',
  readPathImport: string,
): { edits: Edit[]; skipped?: 'no-component-body' | 'copy-collision' } {
  // SHAPE FIRST, ahead of the staleness check below. This engine takes the JSX
  // walk's findings and nothing else: the context ternary at the leaf is not
  // exhaustive, so a copy-module finding reaching it would write a JSX-brace
  // rewrite into a `.ts` file — no compile error, no failing type, the host's
  // own source silently corrupted, and an Astro finding has its own leaf.
  // `LocatedLiteral` carries every shape, so the type system cannot catch it
  // and only a runtime check can. It throws
  // rather than reporting: arriving here is a bug in stet, and a bug keeps its
  // stack. Ordered above the staleness guard so a wrong-shape literal is
  // refused as the wrong shape, never misreported as a stale span — which would
  // send the operator to re-run a scan that changes nothing.
  if (located.shape !== 'jsx') {
    throw new Error(
      `stet internal: a ${located.shape}-shaped finding in ${located.file} reached the rewrite path — ` +
        (located.shape === 'astro'
          ? 'an Astro finding is rewritten by astroLeaf alone'
          : 'module findings are adopted as record and are never rewritten'),
    );
  }

  // Re-confirm the literal is still exactly where scan left it — the QUOTED span,
  // not `.text` — before touching bytes. A stale scan must abort, never mis-locate.
  if (source.slice(located.pos, located.end) !== located.raw) {
    throw new CliError('source changed since scan; re-run stet scan');
  }

  // Never shadow the host's own `copy` (e.g. copy-to-clipboard) — skip and report.
  if (located.copyBinding === 'foreign') return { edits: [], skipped: 'copy-collision' };

  const leafText =
    located.context === 'send-arg' ? `copy('${key}')` : located.context === 'jsx-rich' ? richLeaf(source, located, key) : `{copy('${key}')}`;
  const edits: Edit[] = [];
  // Match the host file's newline (P3-13 — a `\n` inserted into a CRLF file is
  // a mixed-ending line).
  const nl = dominantEol(source);
  // An import, unless the file already has it (a re-run must not duplicate it).
  // Insert at the pre-computed offset — AFTER a `'use client'` directive and the
  // last import — never at 0. At file start, insert AFTER a leading BOM so it
  // never lands mid-file (P3-14).
  const importEdit = (stmt: string): Edit => {
    const bomAtStart = located.importInsertPos === 0 && source.charCodeAt(0) === 0xfeff;
    const pos = bomAtStart ? 1 : located.importInsertPos;
    return { pos, end: pos, text: pos === 0 || bomAtStart ? `${stmt}${nl}` : `${nl}${stmt}` };
  };

  if (located.copyBinding === 'none') {
    // A client leaf needs `const copy = useCopy()` in a component body; with no
    // enclosing component there is nowhere safe to put it.
    if (kind === 'client' && located.enclosingBodyPos === null) {
      return { edits: [], skipped: 'no-component-body' };
    }
    if (!located.accessorImported) {
      edits.push(importEdit(kind === 'client' ? "import { useCopy } from '@getstet/stet/react';" : `import { copy } from '${readPathImport}';`));
    }
    // The client hook binding, module-scoped `copy` needs none on the server.
    if (kind === 'client') {
      const bodyPos = located.enclosingBodyPos as number; // non-null, checked above
      edits.push({ pos: bodyPos, end: bodyPos, text: `const copy = useCopy();${nl}` });
    }
  }
  // A sentence key's renderer, from the entry the file's kind reads: a server
  // file's from `react/server`, which keeps the client provider out of its
  // page's client chunk (D16, check 4 K4). Pushed after the accessor import, so
  // every file lists the two in one order.
  if (located.context === 'jsx-rich' && located.richImported !== true) {
    edits.push(importEdit(`import { richParts } from '@getstet/stet/react${kind === 'client' ? '' : '/server'}';`));
  }

  // `'stet'` falls through to the leaf edit alone — a `const copy`/import serves it.
  edits.push({ pos: located.pos, end: located.end, text: leafText });
  return { edits };
}

/**
 * A sentence's children replaced with one `richParts` read (D16): renderer `n`
 * is element `n`'s open tag, copied byte for byte with ` key={k}` after its tag
 * name, then `{c}`, then its close tag. A tag that carries its own `key` keeps
 * it and takes no second parameter, so none goes unused (check 4 K11).
 */
function richLeaf(source: string, located: LocatedLiteral, key: string): string {
  const rich = located.rich;
  if (rich === undefined) throw new Error(`stet internal: a sentence in ${located.file} reached the rewrite path without its renderers`);
  const opens = rich.renderers.map((r) => source.slice(r.open.pos, r.open.end));
  const [c, k] = freeParams(opens, ['c', 'k']);
  const renderers = rich.renderers.map((r, i) => {
    const open = opens[i] as string;
    const close = source.slice(r.close.pos, r.close.end);
    if (r.keyed === true) return `(${c}) => ${open}{${c}}${close}`;
    const at = open.indexOf(r.tag, 1) + r.tag.length;
    return `(${c}, ${k}) => ${open.slice(0, at)} key={${k}}${open.slice(at)}{${c}}${close}`;
  });
  return `{richParts(copy('${key}'), [${renderers.join(', ')}])}`;
}

/**
 * The parameter names a renderer takes: each wanted name, or the first of
 * `name_`, `name__`, … that no copied open tag mentions as a whole word, so a
 * renderer never shadows a name its tag reads. The Astro and the JSX writer
 * both call it (D16, check 4 K17).
 */
export function freeParams(openTags: string[], wanted: string[]): string[] {
  return wanted.map((name) => {
    let free = name;
    while (openTags.some((tag) => new RegExp(`(?<![\\w$])${free.replace(/\$/g, '\\$')}(?![\\w$])`).test(tag))) free += '_';
    return free;
  });
}

/** A planned read of a JSX file for its read-back: the key, its offset in the edited text, its literal's in the original, and whether it is a sentence key's `richParts` read. */
export interface JsxRead {
  key: string;
  at: number;
  from: number;
  rich: boolean;
}

/**
 * Each landed literal's read in the text `applyFileEdits(source, edits)`
 * gives: its leaf's offset moved by every other edit ending at or before it,
 * the identical inserts counted once, as the batch applies them.
 */
export function jsxReads(edits: Edit[], landed: Array<{ literal: LocatedLiteral; key: string }>): JsxRead[] {
  const unique = uniqueEdits(edits);
  return landed.map(({ literal, key }) => {
    const shift = unique
      .filter((e) => e.end <= literal.pos && !(e.pos === literal.pos && e.end === literal.end))
      .reduce((sum, e) => sum + e.text.length - (e.end - e.pos), 0);
    return { key, at: literal.pos + shift, from: literal.pos, rich: literal.context === 'jsx-rich' };
  });
}

/**
 * Whether a JSX file rewritten with sentence keys reads back as planned (D16):
 * it parses with no syntax error; its scan holds a `'jsx-rich'` read of each
 * planned sentence key at its planned offset; and its literals, compared by
 * text in order, are the original's without the ones replaced. The comparison
 * reads texts, keys and offsets, which the read path's name does not change.
 */
export async function jsxRichClean(
  ts: typeof import('typescript'),
  file: string,
  before: string,
  after: string,
  reads: JsxRead[],
): Promise<boolean> {
  if (parseDiagnosticsOf(ts.createSourceFile(file, after, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file))).length > 0) return false;
  const prior = await scanSource(file, before, { readPathImport: '' });
  const next = await scanSource(file, after, { readPathImport: '' });
  for (const read of reads.filter((r) => r.rich)) {
    if (!next.accessorCalls.some((call) => call.context === 'jsx-rich' && call.key === read.key && call.pos === read.at)) return false;
  }
  const replaced = new Set(reads.map((r) => r.from));
  const kept = prior.literals.filter((l) => !replaced.has(l.pos)).map((l) => l.text);
  const found = next.literals.map((l) => l.text);
  return kept.length === found.length && kept.every((text, i) => text === found[i]);
}

/**
 * A file's edits, applied as one pass. Identical zero-width inserts (the shared
 * import; one `const copy` per component body) collapse to one; the batch sorts
 * strictly DESCENDING so no edit shifts another's coordinates, asserts
 * non-overlap on that order, then slices. The guard is what makes "source-safe
 * by construction" true rather than hopeful.
 */
export function applyFileEdits(source: string, edits: Edit[]): string {
  const unique = uniqueEdits(edits);

  // Descending by pos, then by end: a zero-width insert at n orders AFTER a
  // replacement [n, …) so the insert's text survives, independent of input order.
  unique.sort((a, b) => b.pos - a.pos || b.end - a.end);

  // On the descending order the non-overlap invariant is `end <= prev.pos` for
  // every adjacent pair (the ascending `pos >= prev.end` is false post-sort).
  // Touching and zero-width inserts are allowed; a genuine overlap refuses.
  for (let i = 1; i < unique.length; i++) {
    const prev = unique[i - 1] as Edit;
    const cur = unique[i] as Edit;
    if (cur.end > prev.pos) {
      throw new CliError('overlapping edits — refusing to apply a rewrite that would drop source');
    }
  }

  let out = source;
  for (const e of unique) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  return out;
}

/**
 * A file's edits with identical inserts collapsed to the first — two literals
 * in one component both ask for the same `const copy`, two in one file both
 * ask for the same import.
 */
function uniqueEdits(edits: Edit[]): Edit[] {
  const seen = new Set<string>();
  const unique: Edit[] = [];
  for (const e of edits) {
    if (e.pos === e.end) {
      const dup = `${e.pos}\u0000${e.text}`;
      if (seen.has(dup)) continue;
      seen.add(dup);
    }
    unique.push(e);
  }
  return unique;
}

/**
 * Eject's inverse — every register-produced accessor call back to a plain
 * literal, plus the now-orphaned imports and `const copy` lines dropped in the
 * SAME descending batch. It takes the re-scan's `accessorCalls` (an adopted
 * file's `literals` are empty), and the value is serialized for its exact
 * context so a quote, `<`, `>`, `{` or newline never becomes a syntax error.
 */
export function unRewriteFile(
  source: string,
  calls: LocatedAccessor[],
  values: Record<string, unknown>,
  dropSpans: Span[],
): { edited: string; edits: Edit[]; skipped: LocatedAccessor[] } {
  const edits: Edit[] = [];
  const skipped: LocatedAccessor[] = [];
  for (const call of calls) {
    // A FOREIGN `copy` (a copy-to-clipboard binding in scope) is not ours to
    // touch: replacing it with a value makes a dead button, and its argument may
    // not even be a key. Skip it — the caller reports it — never rewrite it and
    // never abort on it. Only `'foreign'` is skipped: a register-produced call
    // is `'stet'`, and a `'none'` (a bare `copy('k')` with no binding in scope)
    // still un-rewrites — the value simply replaces the call, and a missing
    // value still aborts below.
    if (call.copyBinding === 'foreign') {
      skipped.push(call);
      continue;
    }
    // A sentence key's read goes back to markup by its renderers, which this
    // inverse does not rebuild: a value in its place would show its tags.
    if (call.context === 'jsx-rich') throw new CliError(`eject: ${call.file}: a richParts call stet cannot read back`);
    // Fail-safe: a stet key present in the source but ABSENT from the resolved
    // map (never published, no default — `resolveAll` omits undefined values)
    // must ABORT, never emit a silent `undefined` token into host source. eject
    // resolves every key first; this is the last gate before bytes hit the host.
    if (!(call.key in values) || values[call.key] === undefined) {
      throw new CliError(`eject: no resolved value for key ${call.key}`);
    }
    edits.push({ pos: call.pos, end: call.end, text: serializeValue(values[call.key], call.context) });
  }
  for (const span of dropSpans) {
    edits.push({ pos: span.pos, end: span.end, text: '' });
  }
  return { edited: applyFileEdits(source, edits), edits, skipped };
}

/**
 * A resolved value serialized back into its call's context. A non-string value
 * (a number/boolean/object) is `JSON.stringify`'d everywhere — never
 * String-coerced to `[object Object]`.
 */
function serializeValue(value: unknown, context: LocatedAccessor['context']): string {
  if (context === 'send-arg') return JSON.stringify(value);
  if (typeof value !== 'string') return `{${JSON.stringify(value)}}`;
  if (context === 'jsx-attr') return jsxAttrString(value);
  // jsx-text: raw is valid for apostrophes and newlines, but `<`, `>`, `{`, `}`
  // must ride a JSX expression container (a bare `>` in JSX text is TS1382), and
  // `&` too — a raw `&` in JSX text re-decodes as an entity (`Tom & Jerry` would
  // otherwise round-trip through `&amp;` and silently change the copy).
  if (/[<>{}&]/.test(value)) return `{${JSON.stringify(value)}}`;
  return value;
}

/**
 * The QUOTED VALUE for a JSX attribute — `"…"` (or `'…'`), entity-escaped, NOT
 * `alt="…"` (the replaced span is the value container). `JSON.stringify` is
 * wrong here: JSX attribute strings forbid the backslash escapes it emits.
 */
function jsxAttrString(value: string): string {
  const useSingle = value.includes('"') && !value.includes("'");
  const quote = useSingle ? "'" : '"';
  let escaped = value.replace(/&/g, '&amp;');
  escaped = useSingle ? escaped.replace(/'/g, '&#39;') : escaped.replace(/"/g, '&quot;');
  return `${quote}${escaped}${quote}`;
}

/** A minimal line-based unified diff — what `register`/`eject` show before `--write`. */
export function formatDiff(file: string, source: string, edited: string): string {
  if (source === edited) return '';
  const a = source.split('\n');
  const b = edited.split('\n');
  const ops = diffOps(a, b);

  interface Ann {
    t: ' ' | '-' | '+';
    line: string;
    aNo: number;
    bNo: number;
  }
  const ann: Ann[] = [];
  let ai = 1;
  let bi = 1;
  for (const op of ops) {
    ann.push({ t: op.t, line: op.line, aNo: ai, bNo: bi });
    if (op.t !== '+') ai++;
    if (op.t !== '-') bi++;
  }

  const context = 3;
  const n = ann.length;
  const keep = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    if ((ann[k] as Ann).t === ' ') continue;
    for (let d = -context; d <= context; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < n) keep[idx] = true;
    }
  }

  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let k = 0;
  while (k < n) {
    if (!keep[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < n && keep[end]) end++;
    const slice = ann.slice(k, end);
    const aLines = slice.filter((o) => o.t !== '+');
    const bLines = slice.filter((o) => o.t !== '-');
    const aStart = aLines.length > 0 ? (aLines[0] as Ann).aNo : (slice[0] as Ann).aNo;
    const bStart = bLines.length > 0 ? (bLines[0] as Ann).bNo : (slice[0] as Ann).bNo;
    out.push(`@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    k = end;
  }
  return `${out.join('\n')}\n`;
}

/** The DP matrix ceiling — above it the full LCS would allocate gigabytes (P2-9). */
const LCS_CELL_BOUND = 4_000_000;

/**
 * The line ops for a diff, with the O(n·m) LCS bounded. The common prefix and
 * suffix are trimmed first (O(n)) — the output is identical (the hunk grouper
 * would render them as context anyway), but the DP shrinks to the CHANGED middle,
 * so a localized rewrite in a 40k-line vendored file never allocates the full
 * matrix. When the changed span is itself enormous, a coarse remove-then-add
 * block stands in — still a valid unified diff, never a multi-GB matrix (P2-9).
 */
function diffOps(a: string[], b: string[]): Array<{ t: ' ' | '-' | '+'; line: string }> {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);

  const ops: Array<{ t: ' ' | '-' | '+'; line: string }> = [];
  for (let i = 0; i < p; i++) ops.push({ t: ' ', line: a[i] ?? '' });
  if (aMid.length * bMid.length <= LCS_CELL_BOUND) {
    ops.push(...diffLines(aMid, bMid));
  } else {
    for (const line of aMid) ops.push({ t: '-', line });
    for (const line of bMid) ops.push({ t: '+', line });
  }
  for (let i = a.length - s; i < a.length; i++) ops.push({ t: ' ', line: a[i] ?? '' });
  return ops;
}

/** LCS line diff — common lines as context, the rest as removals/additions. */
function diffLines(a: string[], b: string[]): Array<{ t: ' ' | '-' | '+'; line: string }> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? (dp[(i + 1) * w + (j + 1)] ?? 0) + 1 : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + (j + 1)] ?? 0);
    }
  }
  const ops: Array<{ t: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i] ?? '' });
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + (j + 1)] ?? 0)) {
      ops.push({ t: '-', line: a[i] ?? '' });
      i++;
    } else {
      ops.push({ t: '+', line: b[j] ?? '' });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: '-', line: a[i] ?? '' });
    i++;
  }
  while (j < m) {
    ops.push({ t: '+', line: b[j] ?? '' });
    j++;
  }
  return ops;
}

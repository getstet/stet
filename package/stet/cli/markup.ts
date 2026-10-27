/**
 * The markup layer: the template dialects' blanking, the brace and tag
 * matchers, and the walks over a dialect's markup that the text detector, the
 * rename, the route reads and the marks route share.
 *
 * It imports nothing from `cli/`, so every module that reads markup can import
 * it without closing a cycle: `source-scan.ts` and `key-reads.ts` re-export the
 * names their importers use.
 */

/** The template dialects — files the TypeScript compiler refuses and the text detector reads instead. */
export type Dialect = 'astro' | 'vue' | 'svelte' | 'mdx' | 'html';

export const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1[ \t]*>/gi;
export const CODE_FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
export const ESM_LINE = /^[ \t]*(?:import|export)\b[^\n]*$/gm;
/** `<![CDATA[ … ]]>` — its body may carry `>`, so it is matched to the real terminator. */
export const CDATA_SECTION = /<!\[CDATA\[[\s\S]*?\]\]>/g;

/**
 * The remaining bogus-comment forms — a processing instruction (`<? … ?>`), a
 * markup declaration and the doctype (`<! … >`). HTML terminates each at the
 * first `>`, and so does this.
 */
export const BOGUS_COMMENT = /<[?!][^>]*>/g;

export const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Everything that is not markup, blanked — comments, script and style bodies,
 * code fences, an MDX ESM line and (on `astro`/`mdx` alone) the front matter.
 * `.html` keeps no front matter: three leading dashes on a page are prose.
 *
 * Blanked material becomes NUL rather than going away, so every surviving
 * character keeps its original offset and a reported line is the real one. It
 * doubles as the run delimiter: two labels either side of a stripped tag are two
 * findings, not one.
 *
 * `scanDialect` calls this and then strips tags and braces; the static-HTML
 * locator calls it and reads the TAGS the strip would have eaten. The two can
 * never disagree about what was blanked, because there is one blanking.
 */
export function blankNonMarkup(source: string, dialect: Dialect): string {
  let work = source;
  const strip = (pattern: RegExp): void => {
    work = work.replace(pattern, (match) => match.replace(/[^\n]/g, '\0'));
  };

  if (dialect === 'astro' || dialect === 'mdx') strip(FRONTMATTER);
  // Script and style blocks go for every dialect: a `<script>` body is code
  // wherever it is written, and MDX admits one as readily as a `.vue` does.
  strip(SCRIPT_OR_STYLE);
  strip(CODE_FENCE);
  if (dialect === 'mdx') strip(ESM_LINE);
  strip(HTML_COMMENT);
  // The other bogus-comment forms, blanked for every dialect on the same rule as
  // a comment: a browser renders none of them as text, so a run beside one is
  // never adopted. Without this the tokenizer — which matches `<[A-Za-z]` alone —
  // reads the construct as prose, and the first regeneration would print it on
  // the page escaped. CDATA goes first: its body may hold a bare `>`.
  strip(CDATA_SECTION);
  strip(BOGUS_COMMENT);
  return work;
}

/**
 * The open tag at `i` (its `<`): where it ends, as `closing` reads it, its name
 * lowercased, and whether it closes itself (`<script … />`), in which case a
 * template dialect gives its element no body. The one reading of an open tag
 * `dialectCode` and the dashboard's marks route share.
 */
export function openTag(source: string, i: number): { end: number; name: string; selfClosing: boolean } {
  const end = closing(source, i, '>');
  const tag = source.slice(i, end);
  return { end, name: (/^<([A-Za-z][\w:.-]*)/.exec(tag)?.[1] ?? '').toLowerCase(), selfClosing: /\/\s*>$/.test(tag) };
}

/**
 * The offset just past the `>` or `}` that closes the construct opening at
 * `from` — quote-aware, comment-aware inside a brace, and counting nested
 * braces, so `alt={`a > b`}` and `{ {a: 1} }` close where they do and a `}` in a
 * brace's comment closes nothing. The one brace matcher: the rename's walk and
 * the dashboard's marks route both end a brace here.
 */
export function closing(source: string, from: number, close: '>' | '}'): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (depth > 0 && ch === '/' && (source[i + 1] === '*' || (source[i + 1] === '/' && source[i - 1] !== ':'))) {
      // A comment inside an expression: a brace or quote in it closes nothing.
      const end = source[i + 1] === '*' ? source.indexOf('*/', i + 2) : source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : source[i + 1] === '*' ? end + 1 : end - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      // In a tag, a quote opens only an attribute value; in a brace, any string
      // — but a quote right after a letter is JSX text's apostrophe (`We're`),
      // which JavaScript never writes. A backtick there is a tagged template
      // (`t\`Hi\``), a string like any other.
      if (depth > 0 && ch !== '`' && /[A-Za-z0-9]/.test(source[i - 1] ?? '')) continue;
      if (close === '}' || depth > 0 || /=\s*$/.test(source.slice(Math.max(from, i - 8), i))) quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (close === '}' && depth === 0) return i + 1;
    } else if (ch === '>' && close === '>' && depth === 0) return i + 1;
  }
  return source.length;
}

/** The HTML elements that take no close tag: Astro reads `<br>` as JSX reads `<br />`. */
export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** A top-level brace of a dialect's markup: `end` is just past its `}`; `inTag` where it sits inside an open tag. */
export interface MarkupBrace {
  start: number;
  end: number;
  inTag: boolean;
}

/**
 * Every top-level `{…}` of a template dialect's markup. A brace opens only in
 * the markup `blankNonMarkup` leaves, so a `'{'` in front matter or a script
 * opens nothing, and ends where `closing` says, as the rename reads it; the
 * scan resumes after it, so a brace nested inside another is the outer one's.
 * `inTag` is true where the brace lies inside an open tag (`href={x}`,
 * `{...rest}`), as `openTag` ends the tag; a brace with `inTag` false is element
 * content.
 */
export function markupBraces(source: string, dialect: Dialect): MarkupBrace[] {
  const markup = blankNonMarkup(source, dialect);
  const out: MarkupBrace[] = [];
  let tagEnd = -1;
  for (let i = 0; i < source.length; i++) {
    if (markup[i] === '\0') continue;
    if (i >= tagEnd && source[i] === '<' && /[A-Za-z]/.test(source[i + 1] ?? '')) {
      tagEnd = openTag(source, i).end;
      continue;
    }
    if (source[i] !== '{') continue;
    const end = closing(source, i, '}');
    out.push({ start: i, end, inTag: i < tagEnd });
    i = Math.max(i + 1, end - 1) - 1;
  }
  return out;
}

/**
 * A template dialect's markup with the inside of every `{…}` expression masked
 * with `_`, its outer braces and newlines kept: `content={copy.get('k')}` then
 * reads as one unquoted attribute value, where the quotes inside the expression
 * would otherwise end the attribute and the tag early. The braces are
 * `markupBraces`', so the two can never disagree. Every offset stays put.
 */
export function maskExpressions(source: string, dialect: Dialect): string {
  let out = '';
  let from = 0;
  for (const { start, end } of markupBraces(source, dialect)) {
    out += source.slice(from, start + 1) + source.slice(start + 1, Math.max(start + 1, end - 1)).replace(/[^\n]/g, '_');
    from = Math.max(start + 1, end - 1);
  }
  return out + source.slice(from);
}

/**
 * A template dialect's source with each self-closing `<script … />` and
 * `<style … />` blanked as a script body is: in a dialect the element has no
 * body, so the next close tag of its name must not end it and swallow the
 * markup between. The tag is read by `openTag`, as `dialectCode` reads it.
 * Every offset stays put.
 */
export function selfClosedRaw(source: string): string {
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of source.matchAll(/<(?:script|style)\b/gi)) {
    const tag = openTag(source, m.index);
    if (tag.selfClosing) spans.push({ start: m.index, end: tag.end });
  }
  let out = '';
  let from = 0;
  for (const { start, end } of spans) {
    if (start < from) continue;
    out += source.slice(from, start) + source.slice(start, end).replace(/[^\n]/g, '\0');
    from = end;
  }
  return out + source.slice(from);
}

/** The element shape `elementPath` descends: the static-HTML tokenizer's `Element`. */
interface Nested<E> {
  openStart: number;
  closeEnd: number;
  opaque: boolean;
  children: E[];
}

/**
 * Every element whose span (open tag to close tag) holds `at`, outermost
 * first. An opaque element is read whole and never entered, so it ends the path.
 */
export function elementPath<E extends Nested<E>>(roots: readonly E[], at: number): E[] {
  const path: E[] = [];
  let level: readonly E[] = roots;
  for (;;) {
    const el = level.find((e) => e.openStart <= at && at < e.closeEnd);
    if (el === undefined) return path;
    path.push(el);
    if (el.opaque) return path;
    level = el.children;
  }
}

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

export const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?=\r?\n|$)/;
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

/** One open or close tag read out of a dialect's markup. `name` is the source spelling. */
export interface MarkupTag {
  start: number;
  end: number;
  name: string;
  close: boolean;
  selfClosing: boolean;
}

/**
 * Every tag of `markup`, each ended by `openTag` (a close tag by `closing`), so
 * a brace or a quote inside a tag never ends it early.
 */
export function markupTags(markup: string): MarkupTag[] {
  const tags: MarkupTag[] = [];
  for (let i = 0; i < markup.length; i++) {
    if (markup[i] !== '<') continue;
    const next = markup[i + 1] ?? '';
    const close = next === '/' && /[A-Za-z]/.test(markup[i + 2] ?? '');
    if (!close && !/[A-Za-z]/.test(next)) continue;
    const open = close ? null : openTag(markup, i);
    const end = open === null ? closing(markup, i, '>') : open.end;
    const name = /^<\/?([A-Za-z][\w:.-]*)/.exec(markup.slice(i, end))?.[1] ?? '';
    tags.push({ start: i, end, name, close, selfClosing: open?.selfClosing ?? false });
    i = Math.max(i + 1, end) - 1;
  }
  return tags;
}

/**
 * The attributes of the open `tag`, read out of `markup` (offset `offset` into
 * the file it was cut from), a braced value masked first so a quote inside it
 * opens nothing. Offsets are exact; a masked value's text is read from the
 * source, never from `.value`.
 */
export function openTagAttrs(markup: string, tag: MarkupTag, offset = 0): HtmlAttr[] {
  const base = tag.start + 1 + tag.name.length;
  const run = markup.slice(base, markup.charAt(tag.end - 1) === '>' ? tag.end - 1 : tag.end);
  return readAttrs(markup, offset + base, maskExpressions(run, 'astro'));
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

/** A half-open span of source offsets. */
export interface Span {
  start: number;
  end: number;
  /** A script that is its own scope: a client `<script>` in Astro or HTML, which the front matter's imports never reach. */
  own?: true;
}

/** A script whose `type` names no JavaScript is data: JSON-LD, a template. */
const JS_SCRIPT_TYPE = /\btype\s*=\s*["']?(?!module\b|text\/javascript\b|application\/javascript\b)[^"'\s>]+/i;

/** The dialects whose `<script>` elements are client scripts, each its own scope. */
const OWN_SCOPE: ReadonlySet<Dialect> = new Set(['astro', 'html', 'mdx']);

/** The attribute that makes an element's content text, per dialect. */
const RAW_ATTR: Partial<Record<Dialect, RegExp>> = {
  astro: /\sis:raw(?=[\s/>=])/,
  vue: /\sv-pre(?=[\s/>=])/,
};

/** Whether an open tag carries the dialect's raw attribute: the attribute itself, never the words of a quoted value (`title="… is:raw …"`). */
function carriesRaw(tag: string, dialect: Dialect): boolean {
  return RAW_ATTR[dialect]?.test(tag.replace(/(=\s*)(["'])[\s\S]*?\2/g, '$1""')) ?? false;
}

/**
 * The content of each Astro element carrying `is:raw`: text Astro prints as
 * written, a code sample's braces included. Astro ends a raw element at the
 * first close tag of its name, as `dialectCode` reads it.
 */
export function rawSpans(page: string): Span[] {
  const blanked = blankNonMarkup(page, 'astro');
  const lower = page.toLowerCase();
  const out: Span[] = [];
  for (const m of page.matchAll(/<([A-Za-z][\w:.-]*)/g)) {
    if (blanked.charAt(m.index) === '\0' || out.some((s) => s.start <= m.index && m.index < s.end)) continue;
    const tag = openTag(page, m.index);
    if (tag.selfClosing || !carriesRaw(page.slice(m.index, tag.end), 'astro')) continue;
    const close = lower.indexOf(`</${tag.name}`, tag.end);
    out.push({ start: tag.end, end: close === -1 ? page.length : close });
  }
  return out;
}

/** An Astro page with every raw element's content blanked to spaces, its newlines kept: what the markup readers read. Every offset stays put. */
export function unraw(page: string): string {
  let out = '';
  let from = 0;
  for (const span of rawSpans(page)) {
    out += page.slice(from, span.start) + page.slice(span.start, span.end).replace(/[^\n]/g, ' ');
    from = span.end;
  }
  return out + page.slice(from);
}

/**
 * The code spans of a template dialect's source, at the markup level. Front
 * matter, script bodies and MDX's ESM lines are TypeScript regions, returned
 * apart so the caller can take their comments out with the compiler; tag
 * interiors outside their quoted values, and braces, are expressions. A
 * `.html` file on a JavaScript host evaluates only its scripts.
 *
 * One walk over the markup, so a `<script>` inside a raw element is raw too.
 * An open tag closes where `closing` says, quotes and braces respected, so
 * `set:html={a > b}` and `define:vars={{ … }}` stay inside it and count as
 * expressions; a self-closing `<script … />` has no body. An Astro or HTML
 * `<script>` runs in the browser, so it is its own scope; a Vue or Svelte
 * `<script>` is the component's, which its template reads. `braces` lists every
 * brace expression the walk read, in the markup and in its tags, for the
 * rename's parse check, and `raws` counts the `<script>` and `<style>` elements
 * with a body, so a rewrite that splits one can be told by its count.
 */
export function dialectCode(source: string, dialect: Dialect): { scripts: Span[]; expressions: Span[]; braces: Span[]; raws: number } {
  let raws = 0;
  const scripts: Span[] = [];
  const expressions: Span[] = [];
  const braces: Span[] = [];
  const blank: Span[] = [];
  const pass = (pattern: RegExp): void => {
    for (const m of source.matchAll(pattern)) blank.push({ start: m.index, end: m.index + m[0].length });
  };
  if (dialect === 'astro' || dialect === 'mdx') {
    const fm = FRONTMATTER.exec(source);
    if (fm !== null && fm.index === 0) {
      const open = fm[0].indexOf('\n') + 1;
      scripts.push({ start: open, end: fm[0].lastIndexOf('\n') });
      blank.push({ start: 0, end: fm[0].length });
    }
  }
  pass(HTML_COMMENT);
  pass(CDATA_SECTION);
  if (dialect === 'mdx') {
    pass(CODE_FENCE);
    // A fence with no close runs to the end of the document, as CommonMark reads it.
    for (const m of source.matchAll(/^[ \t]*(?:`{3,}|~{3,})/gm)) {
      if (!within(blank, m.index)) blank.push({ start: m.index, end: source.length });
    }
    for (const m of source.matchAll(ESM_LINE)) {
      if (within(blank, m.index)) continue;
      scripts.push({ start: m.index, end: m.index + m[0].length });
      blank.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  pass(BOGUS_COMMENT);

  const lower = source.toLowerCase();
  const n = source.length;
  let i = 0;
  while (i < n) {
    const skip = blank.find((b) => b.start <= i && i < b.end);
    if (skip !== undefined) {
      i = skip.end;
      continue;
    }
    const ch = source[i];
    if (ch === '`' && dialect === 'mdx') {
      // Inline code in MDX prose is text: `{copy.k}` there prints as written.
      const run = /^`+/.exec(source.slice(i))?.[0] ?? '`';
      const shut = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
      shut.lastIndex = i + run.length;
      const found = shut.exec(source);
      i = found === null ? i + run.length : found.index + run.length;
      continue;
    }
    if (ch === '<' && /[A-Za-z]/.test(source[i + 1] ?? '')) {
      const { end, name, selfClosing } = openTag(source, i);
      const tag = source.slice(i, end);
      if (dialect !== 'html') expressions.push(...tagCode(source, i, end, dialect, braces));
      if (name === 'script' || name === 'style') {
        if (selfClosing) {
          i = end;
          continue;
        }
        raws += 1;
        const close = lower.indexOf(`</${name}`, end);
        const bodyEnd = close === -1 ? n : close;
        if (name === 'script' && !JS_SCRIPT_TYPE.test(tag)) {
          scripts.push({ start: end, end: bodyEnd, ...(OWN_SCOPE.has(dialect) ? { own: true as const } : {}) });
        }
        i = close === -1 ? n : closing(source, close, '>');
        continue;
      }
      if (carriesRaw(tag, dialect) && !selfClosing) {
        // Astro ends a raw element at the first close tag of its name, a nested
        // one included (checked with astro build); Vue's parser nests, so
        // `v-pre` ends at the close tag that balances it.
        let close = lower.indexOf(`</${name}`, end);
        if (dialect === 'vue') {
          const opener = new RegExp(`<${name}(?=[\\s/>])`, 'g');
          for (let open = end; close !== -1; ) {
            opener.lastIndex = open;
            const inner = opener.exec(lower);
            if (inner === null || inner.index > close) break;
            const nested = openTag(source, inner.index);
            open = nested.end;
            if (!nested.selfClosing) close = lower.indexOf(`</${name}`, close + 2);
          }
        }
        i = close === -1 ? n : closing(source, close, '>');
        continue;
      }
      i = end;
      continue;
    }
    // Vue interpolates only a double brace: `{see below}` in its text prints.
    if (ch === '{' && dialect !== 'html' && (dialect !== 'vue' || source[i + 1] === '{')) {
      const end = closing(source, i, '}');
      // `{/* a note */}` is a comment in every brace dialect; a brace holding
      // code beside its comments is code, the comments passed over later.
      const inner = source.slice(i + 1, end - 1).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (inner !== '') {
        expressions.push({ start: i, end });
        braces.push({ start: i, end });
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return { scripts, expressions, braces, raws };
}

/** A Vue directive: its quoted value is an expression. */
const VUE_DIRECTIVE = /^(?::|@|#|v-)/;

/**
 * An open tag's code: its interior with every quoted attribute value taken
 * out, so `class="nav_docs"` and `href="#nav_docs"` are text, and a braced
 * value is code. Two dialects read inside the quotes: a Vue directive's value
 * (`:title="copy.k"`, `@click`, `v-if`) is an expression, and a Svelte value's
 * braces (`title="{copy.k}"`) are code.
 */
function tagCode(source: string, start: number, end: number, dialect: Dialect, braces: Span[]): Span[] {
  const out: Span[] = [];
  let from = start;
  let i = start;
  while (i < end) {
    const ch = source[i] as string;
    if ((ch === '"' || ch === "'") && /=\s*$/.test(source.slice(Math.max(start, i - 8), i))) {
      const close = source.indexOf(ch, i + 1);
      const stop = close === -1 || close >= end ? end : close + 1;
      const attr = /([^\s=<]+)\s*=\s*$/.exec(source.slice(start, i))?.[1] ?? '';
      if (dialect === 'vue' && VUE_DIRECTIVE.test(attr)) {
        i = stop;
        continue;
      }
      if (i > from) out.push({ start: from, end: i });
      if (dialect === 'svelte') {
        for (let j = i + 1; j < stop - 1; j++) {
          if (source[j] !== '{') continue;
          const braceEnd = closing(source, j, '}');
          out.push({ start: j, end: braceEnd });
          braces.push({ start: j, end: braceEnd });
          j = braceEnd - 1;
        }
      }
      from = stop;
      i = stop;
      continue;
    }
    if (ch === '{') {
      const braceEnd = closing(source, i, '}');
      braces.push({ start: i, end: braceEnd });
      i = braceEnd;
      continue;
    }
    i += 1;
  }
  if (end > from) out.push({ start: from, end });
  return out;
}

export function within(spans: Span[], at: number): boolean {
  return spans.some((s) => s.start <= at && at < s.end);
}

// --- A tag's attributes --------------------------------------------------

/** One attribute inside a tag's attribute run. Match indices give the value's own offsets. */
const ATTR = /([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gd;

export interface HtmlAttr {
  /** Lower-cased. */
  name: string;
  /** The raw slice between the quotes, or the bare run of an unquoted value. */
  value: string;
  quoted: boolean;
  /** Absolute offsets INSIDE the quotes, so a replacement never touches them. */
  valueStart: number;
  valueEnd: number;
  /** The attribute's whole span, its name included. */
  start: number;
  end: number;
}

/** One tag's attributes, with absolute offsets for the value inside its quotes. */
export function readAttrs(source: string, base: number, run: string): HtmlAttr[] {
  const attrs: HtmlAttr[] = [];
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(run)) !== null) {
    const name = (match[1] as string).toLowerCase();
    const raw = match[2];
    const start = base + match.index;
    if (raw === undefined) {
      attrs.push({
        name,
        value: '',
        quoted: false,
        valueStart: start + (match[1] as string).length,
        valueEnd: start + (match[1] as string).length,
        start,
        end: start + match[0].length,
      });
      continue;
    }
    const span = match.indices?.[2];
    const rawStart = span === undefined ? start + match[0].indexOf(raw) : base + span[0];
    const rawEnd = span === undefined ? rawStart + raw.length : base + span[1];
    const quote = raw.charAt(0);
    const quoted = quote === '"' || quote === "'";
    attrs.push({
      name,
      value: quoted ? raw.slice(1, -1) : raw,
      quoted,
      valueStart: quoted ? rawStart + 1 : rawStart,
      valueEnd: quoted ? rawEnd - 1 : rawEnd,
      start,
      end: start + match[0].length,
    });
  }
  return attrs;
}

/**
 * Where a JavaScript host reads a key in its source, and what a rename may
 * rewrite there.
 *
 * Two consumers: the dashboard's marks route, which answers each key's places
 * from the reads `KEY_READ` finds, and `stet rename`, which sorts every
 * whole-word occurrence of a leaving key into three classes:
 *
 * 1. a READ it rewrites — one of the read forms, in code, through a binding the
 *    file imports by name from the read path or from a declared copy module
 *    (resolved by path, one hop), or `const copy = useCopy()`; or a declared
 *    copy module's own property of that name;
 * 2. a read it CANNOT rewrite — the name anywhere else the language evaluates:
 *    a read through a default or namespace import, a parameter or a `let`, a
 *    string held for `copy[name]`, a string typed as a key, a re-export two
 *    hops away. The rename refuses to write while one remains, because a read
 *    left behind renders nothing at runtime;
 * 3. a MENTION — a comment, prose, a quoted static attribute value, a block
 *    the dialect prints as text, or a read form through a name the file never
 *    declares (a client script's global). Listed and left.
 *
 * What counts as code follows each dialect's own rule: a TypeScript file is
 * code but for its comments and its JSX text; a template dialect's code is its
 * front matter, its scripts, its tag interiors outside quoted values, and its
 * braces — and nothing inside an element carrying `is:raw` in Astro or
 * `v-pre` in Vue, whose content the dialect prints as text, a script or a
 * nested element inside it included.
 */

import type * as TS from 'typescript';

import { lineIndex } from './html-host.js';
import {
  BOGUS_COMMENT,
  CDATA_SECTION,
  CODE_FENCE,
  ESM_LINE,
  FRONTMATTER,
  HTML_COMMENT,
  scriptKindFor,
  type Dialect,
} from './source-scan.js';

/**
 * A read of a key: `copy.get('<key>')`, `copy('<key>')` or `get('<key>')`, and
 * `copy.<key>`, `copy?.<key>` or `copyMap.<key>` — the accessor `register`
 * writes, the map the scaffolded read path exports, and the forms a host
 * re-exports them under. The call alternative comes before the property
 * alternative, so `copy.get('x')` reads `x`, not `get`.
 */
export const KEY_READ =
  /\bcopy(?:Map)?\s*\.\s*get\s*\(\s*(['"`])([^'"`\n]+)\1|\b(?:copy|get)\s*\(\s*(['"`])([^'"`\n]+)\3|\bcopy(?:Map)?\s*\??\.\s*([A-Za-z_$][\w$]*)/g;

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
 * rename's parse check.
 */
export function dialectCode(source: string, dialect: Dialect): { scripts: Span[]; expressions: Span[]; braces: Span[] } {
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

  const raw = RAW_ATTR[dialect];
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
        const close = lower.indexOf(`</${name}`, end);
        const bodyEnd = close === -1 ? n : close;
        if (name === 'script' && !JS_SCRIPT_TYPE.test(tag)) {
          scripts.push({ start: end, end: bodyEnd, ...(OWN_SCOPE.has(dialect) ? { own: true as const } : {}) });
        }
        i = close === -1 ? n : closing(source, close, '>');
        continue;
      }
      // The attribute itself, never the words of a quoted value (`title="… is:raw …"`).
      if (raw !== undefined && raw.test(tag.replace(/(=\s*)(["'])[\s\S]*?\2/g, '$1""')) && !selfClosing) {
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
  return { scripts, expressions, braces };
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

export function within(spans: Span[], at: number): boolean {
  return spans.some((s) => s.start <= at && at < s.end);
}

/**
 * The comments and JSX text of a TypeScript region — the parts of it that are
 * not code. Every token's leading trivia is read, so a comment before a closing
 * brace, which starts no node, is found too.
 */
export function nonCodeOf(ts: typeof import('typescript'), file: string, text: string, base = 0): Span[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const out: Span[] = [];
  const seen = new Set<number>();
  const visit = (node: TS.Node): void => {
    const full = node.getFullStart();
    if (!seen.has(full)) {
      seen.add(full);
      for (const r of ts.getLeadingCommentRanges(text, full) ?? []) out.push({ start: base + r.pos, end: base + r.end });
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      out.push({ start: base + node.getStart(sf), end: base + node.end });
      return;
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return out;
}

/** How `copy`, `copyMap` or `get` is bound in one file. */
export type Binding = 'stet' | 'foreign' | 'none';

const BINDING_NAMES = new Set(['copy', 'copyMap', 'get']);

/**
 * How each of the three read names is bound across a file's TypeScript regions.
 * `stet` where every declaration of the name is a named import from a module
 * `isStetModule` accepts, or `const <name> = useCopy()`; `foreign` where any
 * declaration is anything else — a default or namespace import, a parameter, a
 * `let`, a destructured name, a function or a class; `none` where the name is
 * not declared.
 */
export function bindingsOf(
  ts: typeof import('typescript'),
  file: string,
  regions: string[],
  isStetModule: (spec: string) => boolean,
): Map<string, Binding> {
  const stet = new Set<string>();
  const foreign = new Set<string>();
  for (const text of regions) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
    const visit = (node: TS.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const from = isStetModule(node.moduleSpecifier.text);
        if (clause?.name !== undefined && BINDING_NAMES.has(clause.name.text)) foreign.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named) && BINDING_NAMES.has(named.name.text)) {
          foreign.add(named.name.text);
        }
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (BINDING_NAMES.has(el.name.text)) (from ? stet : foreign).add(el.name.text);
          }
        }
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && BINDING_NAMES.has(node.name.text)) {
        const init = node.initializer;
        const hook =
          init !== undefined &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'useCopy';
        (hook ? stet : foreign).add(node.name.text);
      } else if (
        (ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        BINDING_NAMES.has(node.name.text)
      ) {
        foreign.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const out = new Map<string, Binding>();
  for (const name of BINDING_NAMES) {
    out.set(name, foreign.has(name) ? 'foreign' : stet.has(name) ? 'stet' : 'none');
  }
  return out;
}

/** One occurrence of a leaving key, as the rename plan lists it. */
export interface Occurrence {
  file: string;
  line: number;
  at: number;
  key: string;
  /** The line's text, trimmed — what the plan shows for a rewrite and a refusal. */
  text: string;
}

/** What one file holds of the keys a rename moves. */
export interface ReadRenames {
  /** Token replacements — each the leaving name's span, replaced by the new one. */
  edits: Array<{ pos: number; end: number; text: string }>;
  rewritten: Occurrence[];
  blocked: Occurrence[];
  mentions: Occurrence[];
  /**
   * A brace expression in a file holding a leaving key that does not parse as
   * one expression — where the markup walk may have misread the brace's end, so
   * nothing it sorted in the file can be trusted. The rename refuses on one.
   */
  unparsed: Occurrence[];
}

/**
 * Before-text patterns of the read forms, each ending where the key begins, with
 * the binding name in group 1. `copy.`, `copy?.` and `copyMap.` read a property; the call
 * forms and `copy['<key>']` open a quote the key must close.
 */
const PROPERTY_READ = /(?<![\w$.])(copy|copyMap)\s*\??\.\s*$/;
const GET_CALL = /(?<![\w$.])(copy|copyMap)\s*\.\s*get\s*\(\s*(['"`])$/;
const CALL = /(?<![\w$.])(copy|get)\s*\(\s*(['"`])$/;
const ELEMENT_READ = /(?<![\w$.])(copy|copyMap)\s*\[\s*(['"`])$/;
const HOOK_CALL = /useCopy\s*\(\s*\)\s*\(\s*(['"`])$/;

/**
 * The binding a read form ends at `at` through, or null where the text before
 * `at` is no read form or the key's own closing quote does not follow.
 */
export function readFormAt(source: string, at: number, key: string): string | null {
  const before = source.slice(Math.max(0, at - 120), at);
  const after = source[at + key.length] ?? '';
  const prop = PROPERTY_READ.exec(before);
  if (prop !== null && !/[\w$]/.test(after)) return prop[1] as string;
  for (const form of [GET_CALL, CALL, ELEMENT_READ]) {
    const m = form.exec(before);
    if (m !== null && after === m[2]) return m[1] as string;
  }
  const hook = HOOK_CALL.exec(before);
  if (hook !== null && after === hook[1]) return 'useCopy';
  return null;
}

const TS_FAMILY = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Every occurrence of the leaving keys in one host file, sorted into the three
 * classes. `ts` is the lazily loaded compiler; `isStetModule` answers whether a
 * specifier, resolved from this file, lands on the read path or a declared copy
 * module; `copyModule` says whether this file is itself one.
 */
export function planReadRenames(input: {
  ts: typeof import('typescript');
  file: string;
  source: string;
  dialect: Dialect | null;
  renames: ReadonlyMap<string, string>;
  isStetModule: (spec: string) => boolean;
  copyModule: boolean;
}): ReadRenames {
  const { ts, file, source, dialect, renames, isStetModule, copyModule } = input;
  const out: ReadRenames = { edits: [], rewritten: [], blocked: [], mentions: [], unparsed: [] };
  if (renames.size === 0) return out;

  // The code of this file, and the TypeScript regions its bindings live in.
  let code: Span[];
  let regions: Array<{ start: number; end: number; own?: true; text: string }>;
  let nonCode: Span[];
  let braces: Span[] = [];
  if (dialect === null) {
    if (!TS_FAMILY.test(file)) return out;
    code = [{ start: 0, end: source.length }];
    regions = [{ start: 0, end: source.length, text: source }];
    nonCode = nonCodeOf(ts, file, source);
  } else {
    const found = dialectCode(source, dialect);
    code = [...found.scripts, ...found.expressions];
    braces = found.braces;
    regions = found.scripts.map((s) => ({ ...s, text: source.slice(s.start, s.end) }));
    // The comments of the scripts and of each brace, which the markup walk keeps whole.
    nonCode = [
      ...regions.flatMap((r) => nonCodeOf(ts, `${file}.ts`, r.text, r.start)),
      ...found.expressions
        .filter((e) => source[e.start] === '{')
        .flatMap((e) => nonCodeOf(ts, `${file}.tsx`, source.slice(e.start + 1, e.end - 1), e.start + 1)),
    ];
  }
  // The component's bindings, which its markup reads, and each client script's own.
  const scriptFile = dialect === null ? file : `${file}.ts`;
  const bindings = bindingsOf(
    ts,
    scriptFile,
    regions.filter((r) => r.own !== true).map((r) => r.text),
    isStetModule,
  );
  const clientScripts = regions
    .filter((r) => r.own === true)
    .map((r) => ({ span: r, bindings: bindingsOf(ts, scriptFile, [r.text], isStetModule) }));

  // A declared copy module's own property, named for the key it is: renamed
  // with it where the module holds exactly one such property.
  const props = new Map<string, number[]>();
  if (copyModule && dialect === null) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
    const visit = (node: TS.Node): void => {
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && renames.has(propText(ts, node.name))) {
        const name = node.name;
        const at = ts.isStringLiteral(name) ? name.getStart(sf) + 1 : name.getStart(sf);
        const key = propText(ts, name);
        props.set(key, [...(props.get(key) ?? []), at]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const lineOf = lineIndex(source);
  const lineText = (at: number): string => {
    const end = source.indexOf('\n', at);
    return source.slice(source.lastIndexOf('\n', at - 1) + 1, end === -1 ? source.length : end);
  };

  // The parse check: every brace expression the walk read in a file holding a
  // leaving key parses as one expression, or the file's sorting is refused.
  const held = [...renames.keys()].find((key) => new RegExp(`(?<![\\w$])${key}(?![\\w$])`).test(source));
  if (held !== undefined && dialect !== null) {
    for (const brace of braces) {
      if (parsesAsExpression(ts, dialect, source.slice(brace.start, brace.end))) continue;
      const line = lineOf(brace.start);
      out.unparsed.push({ file, line, at: brace.start, key: held, text: lineText(brace.start).trim() });
    }
  }

  for (const [key, next] of renames) {
    const pattern = new RegExp(`(?<![\\w$])${key}(?![\\w$])`, 'g');
    for (const m of source.matchAll(pattern)) {
      const at = m.index;
      const line = lineOf(at);
      const occ: Occurrence = { file, line, at, key, text: lineText(at).trim() };
      if (!within(code, at) || within(nonCode, at)) {
        out.mentions.push(occ);
        continue;
      }
      const own = props.get(key);
      if (own !== undefined && own.includes(at)) {
        if (own.length === 1) {
          out.edits.push({ pos: at, end: at + key.length, text: next });
          out.rewritten.push(occ);
        } else {
          out.blocked.push(occ);
        }
        continue;
      }
      const through = readFormAt(source, at, key);
      const client = clientScripts.find((c) => within([c.span], at));
      const scope = client?.bindings ?? bindings;
      const binding = through === null || through === 'useCopy' ? null : scope.get(through);
      if (through === 'useCopy' || binding === 'stet') {
        out.edits.push({ pos: at, end: at + key.length, text: next });
        out.rewritten.push(occ);
      } else if (binding === 'none' && client !== undefined) {
        // A read form through a name a client script never declares — a
        // browser global — reads nothing of stet's. Anywhere else an
        // undeclared name is a read stet cannot prove.
        out.mentions.push(occ);
      } else {
        out.blocked.push(occ);
      }
    }
  }
  return out;
}

/**
 * Whether a template dialect's brace expression, `{…}` as the walk read it,
 * parses as one TypeScript expression. What each dialect puts in a brace
 * besides an expression is taken apart first: Vue's double brace, a spread in
 * an Astro or MDX tag, and Svelte's blocks (`{#if x}`, `{:else if x}`, `{/if}`,
 * `{#each xs as x}`, `{#await p then v}`) and tags (`{@html x}`, `{@const a = b}`)
 * by their expression part; Astro's markup is read as written or as JSX spells it (`asJsx`).
 */
export function parsesAsExpression(ts: typeof import('typescript'), dialect: Dialect, brace: string): boolean {
  let inner = dialect === 'vue' && brace.startsWith('{{') && brace.endsWith('}}') ? brace.slice(2, -2) : brace.slice(1, -1);
  if (dialect === 'svelte') {
    const block = /^\s*([#:/@])([\w-]*)\s*/.exec(inner);
    if (block !== null) {
      const [whole, sigil, name] = block as unknown as [string, string, string];
      const rest = inner.slice(whole.length);
      if (sigil === '/' || (sigil === ':' && name !== 'else') || name === 'snippet') return true;
      inner =
        sigil === ':'
          ? rest.replace(/^if\b/, '')
          : name === 'each'
            ? (rest.split(/\sas\s/)[0] as string)
            : name === 'await'
              ? (rest.split(/\s(?:then|catch)\b/)[0] as string)
              : rest;
    }
  } else {
    inner = inner.replace(/^\s*\.\.\./, '');
  }
  // Astro's markup is tried as written, then as JSX spells it: a `<` TSX reads
  // as a comparison (`x<input ? 1 : 2 > 0`) is never rewritten into a tag.
  return parsesAsOne(ts, inner) || (dialect === 'astro' && parsesAsOne(ts, asJsx(inner)));
}

/** Whether `inner` parses as one TypeScript expression; a lone comment counts, closed. */
function parsesAsOne(ts: typeof import('typescript'), inner: string): boolean {
  if (inner.replace(/\/\*[\s\S]*?\*\//g, '').trim() === '') return !/\/\*(?![\s\S]*\*\/)/.test(inner);
  const sf = ts.createSourceFile('brace.tsx', `(${inner}\n)`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const diagnostics = (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];
  const only = sf.statements[0];
  return (
    diagnostics.length === 0 &&
    sf.statements.length === 1 &&
    only !== undefined &&
    ts.isExpressionStatement(only) &&
    ts.isParenthesizedExpression(only.expression)
  );
}

/** The HTML elements that take no close tag: Astro reads `<br>` as JSX reads `<br />`. */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * An attribute's value: quoted or braced as JSX writes it, or unquoted as HTML
 * allows, running to whitespace or `>` (`href=/docs/` keeps its slash).
 */
const ATTR_VALUE = /(=\s*)(?:"[^"]*"|'[^']*'|\{[^}]*\}|([^\s"'<>`{}=]+))/g;

/**
 * Astro markup inside an expression as JSX spells it, for the parse check: an
 * HTML comment dropped, an unquoted attribute value quoted, and a void element
 * (`<br>`, `<img src="…">`) closed. A capitalised tag is a component, which
 * closes as JSX's do.
 */
function asJsx(text: string): string {
  const source = text.replace(/<!--[\s\S]*?-->/g, '');
  let out = '';
  let from = 0;
  for (const m of source.matchAll(/<([A-Za-z][\w:.-]*)/g)) {
    if (m.index < from) continue;
    const { end } = openTag(source, m.index);
    if (source[end - 1] !== '>') continue;
    let tag = source.slice(m.index, end).replace(ATTR_VALUE, (whole, eq: string, bare?: string) => (bare === undefined ? whole : `${eq}"${bare}"`));
    // Self-closing as HTML reads the tag: `<a href=/docs/>` ends in its value's slash.
    if (!/\/\s*>$/.test(tag) && VOID_ELEMENTS.has(m[1] as string)) tag = `${tag.slice(0, -1)} />`;
    out += source.slice(from, m.index) + tag;
    from = end;
  }
  return out + source.slice(from);
}

function propText(ts: typeof import('typescript'), name: TS.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return '';
}

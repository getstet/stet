/**
 * The shared source layer: every walk over a host file, implemented once, plus
 * the glob matcher that decides which host files are managed surfaces at all.
 *
 * Three walks live here, one per shape of host file a project actually has.
 * `scanSource` is the TSX locator `scan`, `register` and `eject` all call — JSX
 * text, COPY attributes and send arguments — and it also yields its parse and
 * the spans it CLASSIFIED, which is what lets a file matched by both the
 * managed surfaces and the copy modules be read once with every literal owned
 * by exactly one walk. `scanModule` covers a DECLARED COPY MODULE, where every
 * string literal in runtime code is presumed copy and an object-literal
 * property proposes its own name as the key. `scanDialect` covers the template
 * dialects by stripping a file down to its prose; it proposes no keys, because
 * nothing text-level can tell an attribute from content.
 *
 * The parsing walks load `typescript` lazily (a host whose surfaces are `.tsx`
 * already has it), so this module carries no eager runtime `typescript` import —
 * only the erased type-only one — and the read path never pulls it in. The
 * dialect detector is compiler-free entirely: it runs on the typescript-less
 * hosts `eject` serves, and its answers do not change under TypeScript 7.
 */

import type * as TS from 'typescript';

import { DESCRIPTOR_SCHEMA } from '../src/descriptor-schema.generated.js';
import { CliError } from './report.js';

// `managedSurfaces` speaks a two-token glob — a single star for one path segment
// and a double star for any run of segments, including none. No glob dependency
// exists and the base install stays `ajv`+`zod`, so the subset is translated
// here rather than pulled in: `fs.globSync` is Node >=22 and the engines floor
// is >=20.
//
// The one trap is a double star followed by a slash: it must match ZERO
// intermediate segments so a `app` + double-star + `/*.tsx` glob still opens
// `app/page.tsx` and `app/layout.tsx`, not only `app/x/y.tsx`. A naive
// double-star -> `.*` requires an intermediate slash and silently skips the home
// page and the root layout, so the double-star-slash token translates to
// `(?:[^/]+/)*` — any run of whole segments, or none.
function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        if (glob.charAt(i + 2) === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a `/`-normalized path is matched by one managed-surface glob. The
 * caller normalizes separators before asking, so this stays a pure string test.
 * A leading `./` is stripped from both sides: a hand-written `./lib/email/**`
 * glob would otherwise silently never match `lib/email/…` — the exact
 * silent-never-match the surface-derived target exists to prevent.
 */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(stripDotSlash(glob)).test(stripDotSlash(path));
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * The refusal a host on TypeScript 7 gets. TS7's package root exports version
 * constants and nothing else — the compiler API moved behind `typescript/
 * unstable/*` — so every source tool here would fail on a missing function
 * rather than on a version. The peer range says the same thing (`>=5 <7`), and
 * `templates/email-runner.cjs` gives this identical string from its own exit-3
 * path, the runner being a standalone asset that cannot import it.
 */
export const TS7_REFUSAL =
  "stet's source tools use the TypeScript 5 compiler API — typescript 7 is not yet supported; install typescript@5 as a devDependency";

/**
 * The `typescript` compiler, imported only on the path that parses TSX.
 *
 * `typescript` is an OPTIONAL peer dependency (`scan`/`register`/`eject` are its
 * only callers; the read path never touches it), so a static import would make
 * every command fail at module load on the default install. Any host whose
 * managed surfaces are `.tsx` already has `typescript` in its own toolchain, so
 * this uses theirs rather than bundling a second copy. Mirrors `store.ts`'s
 * `loadPgAdapter`.
 *
 * A resolution that carries no compiler API is refused by version rather than
 * used: `createSourceFile` is what every walk below calls first, so its absence
 * is the whole diagnosis.
 */
export async function loadTypescript(): Promise<typeof import('typescript')> {
  let ts: typeof import('typescript');
  try {
    ts = await import('typescript');
  } catch (error) {
    if (moduleNotFound(error, 'typescript')) {
      // Named for no one command: scan, register and eject all parse TSX.
      throw new CliError("stet needs 'typescript' to read your source — install it as a dev dependency: npm i -D typescript");
    }
    throw error;
  }
  if (typeof ts.createSourceFile !== 'function') throw new CliError(TS7_REFUSAL);
  return ts;
}

/**
 * Whether a failed dynamic import means the package is simply not installed. The
 * signal is `ERR_MODULE_NOT_FOUND` or Node's "Cannot find package" message; the
 * cause chain is walked (bounded) because a runner may wrap the import rejection
 * before it reaches this catch, and the real code then rides `.cause`.
 */
function moduleNotFound(error: unknown, pkg: string): boolean {
  const pattern = new RegExp(`Cannot find (package|module) '${pkg}'`);
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 5; depth++, cur = (cur as { cause?: unknown }).cause) {
    const code = (cur as { code?: string }).code;
    const message = cur instanceof Error ? cur.message : '';
    if (code === 'ERR_MODULE_NOT_FOUND' || pattern.test(message)) return true;
  }
  return false;
}

/**
 * What produced a located literal, and what it is. `'jsx'` is the JSX walk's —
 * text, COPY attributes and send arguments alike — and it is the ONLY shape the
 * rewrite engine may ever see. The three module shapes are record-only: a copy
 * module's literals are adopted into the descriptor and left where they are, and
 * `register`'s runtime guard enumerates on this to keep them out of `planRewrite`.
 */
export type LiteralShape = 'jsx' | 'property' | 'template' | 'plain';

/** A located copy literal a re-scan could still surface (unkeyed). */
export interface LocatedLiteral {
  file: string;
  pos: number;
  end: number;
  /** Exactly `source.slice(pos,end)` — the re-confirm guard and replacement basis. jsx-attr/send-arg spans are QUOTED; jsx-text is the TRIMMED extent. */
  raw: string;
  /** The unquoted, entity-decoded copy — seeds the default and derives the key. jsx-text is also whitespace-collapsed; jsx-attr keeps its significant whitespace; send-arg is a plain string literal (no entities). */
  text: string;
  context: 'jsx-text' | 'jsx-attr' | 'send-arg' | 'module';
  shape: LiteralShape;
  proposedKey: string;
  /** Insert point for `const copy = useCopy();` — the nearest block-bodied COMPONENT (not any callback); null otherwise. A module literal carries `null`: it is never rewritten. */
  enclosingBodyPos: number | null;
  /** Per-literal LEXICAL scope — what `copy` binds to AT this literal (nearest enclosing scope wins). `'stet'` = the nearest `copy` is the accessor: `const copy = useCopy()`, or a named `{ copy }` import from the read-path module. `'foreign'` = any other `copy` binding (a param, a `let`/`var copy`, a non-`useCopy` `const`, a `function copy`, a default/namespace import, a non-read-path `{ copy }`, or a block `const`/`let` declared AFTER this literal — TDZ) → register skips+reports. `'none'` = no `copy` in scope → register inserts. */
  copyBinding: 'stet' | 'foreign' | 'none';
  /** The accessor import is ALREADY in the file, so a re-run inserts no duplicate. */
  accessorImported: boolean;
  /** The offset to insert the accessor import at: max(directive-prologue end, last-import end), so it lands AFTER `'use client'`. */
  importInsertPos: number;
}

/** A copy string the scanner recognizes as i18n's — reported, never rewritten. */
export interface I18nSkip {
  file: string;
  pos: number;
  text: string;
}

/** A source span `eject` deletes. */
export interface Span {
  pos: number;
  end: number;
}

/** An existing register-produced accessor call — `eject`'s un-rewrite target, which a re-scan's empty `literals` could never supply. */
export interface LocatedAccessor {
  file: string;
  /** The span to REPLACE: the whole `{copy('k')}` container (jsx-text/jsx-attr) or the `copy('k')` call (send-arg). */
  pos: number;
  end: number;
  /** The string-literal argument — the resolved value keys off it. */
  key: string;
  context: 'jsx-text' | 'jsx-attr' | 'send-arg';
  /**
   * What `copy` binds to at the call — `'stet'` is the accessor (`useCopy()` or
   * a read-path `copy`) and eject un-rewrites it; `'foreign'`/`'none'` is some
   * other `copy` (copy-to-clipboard) and eject SKIPS it, never replacing a live
   * call with a value nor aborting on a non-key argument.
   */
  copyBinding: 'stet' | 'foreign' | 'none';
}

/** One managed-surface file, walked once. */
export interface ScanResult {
  file: string;
  hasUseClient: boolean;
  literals: LocatedLiteral[];
  accessorCalls: LocatedAccessor[];
  /** Every import whose specifier is `stet`, begins `stet/`, or is the read-path import — `eject`'s orphan-drop targets. */
  stetImportSpans: Span[];
  /** `const copy = useCopy()` declaration spans. */
  copyDeclSpans: Span[];
  /** The `const … = resolveAll(…)` statement `init` added to the root layout — dropping it with the `stet` import avoids a dangling call. */
  resolvedMapDeclSpans: Span[];
  i18nSkips: I18nSkip[];
  parseErrors: boolean;
  /**
   * The parse itself, so a file BOTH declarations match is parsed once: the
   * copy-module walk runs over this rather than building a second tree.
   */
  sourceFile: TS.SourceFile;
  /**
   * Every span this walk CLASSIFIED — deliberately wider than the spans it
   * reported. A structural attribute and a denied `send` field are decisions
   * this walk made and is silent about, and a second walk over the same file
   * must not reopen them: the four classes are every JSX attribute whole, every
   * send-call argument list whole, every i18n call's arguments (the tagged form
   * included), and every accessor call's key argument — the last of which
   * matters most, because a file already rewritten to `copy('hero')` would
   * otherwise be warned about the very key it correctly reads, forever.
   */
  claimed: Span[];
}

/** The JSX attributes that carry copy — every other attribute is structural. */
const COPY_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label', 'label', 'caption', 'summary', 'content']);

/** Structural `send()` object fields — routing and body wiring, never copy. */
const SEND_DENY = new Set(['from', 'to', 'cc', 'bcc', 'replyTo', 'reply_to', 'html', 'react', 'headers', 'attachments']);

/** JSX elements whose subtree is i18n's, reported and never rewritten. */
const I18N_ELEMENTS = new Set(['Trans']);

const IGNORE_MARKER = 'stet-ignore-next-line';

/**
 * The descriptor's own key grammar, compiled once — the schema's `keyName`
 * pattern, read from the generated zero-dependency module rather than
 * `descriptor.ts`'s re-export, which would drag `ajv` into this file's graph.
 * A copy module's property name proposes ITSELF as a key, so the question
 * "could this name be a key" has to be answered by the thing that decides it.
 */
const KEY_NAME = new RegExp(DESCRIPTOR_SCHEMA.$defs.keyName.pattern);

/**
 * The named HTML entities worth decoding so a seeded default matches what render
 * shows. Non-ASCII values go through `String.fromCharCode` rather than a `\u`
 * escape, which the authoring tools decode into a literal byte.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(160),
  copy: String.fromCharCode(169),
  reg: String.fromCharCode(174),
  hellip: String.fromCharCode(8230),
  mdash: String.fromCharCode(8212),
  ndash: String.fromCharCode(8211),
  lsquo: String.fromCharCode(8216),
  rsquo: String.fromCharCode(8217),
  ldquo: String.fromCharCode(8220),
  rdquo: String.fromCharCode(8221),
};

/**
 * HTML entities (named + numeric) → their characters, for the seeded default.
 *
 * Exported for `cli/email-extract.ts`, which seeds a JSX slot from the same text
 * this decodes and must reach the same characters — one entity table, or a
 * template's `&nbsp;` means one thing to scan and another to extract.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Runs of whitespace (a multi-line JSX node's indentation included) → one space. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A descriptor key proposed from a copy string — the INVERSE of
 * `descriptor.ts`'s `deriveLabel` (key→label), which must NOT be reused. Scan
 * proposes; register writes and resolves collisions. The truncation branch trims
 * to a word boundary without leaving a trailing `_`, and a single over-long word
 * takes the hard cut, so the output always matches the schema key regex
 * (`^[a-z0-9]+(?:_{1,2}[a-z0-9]+)*$`).
 */
export function proposeKey(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = s.length <= 40 ? s : s.slice(0, 40).replace(/_[^_]*$/, '') || s.slice(0, 40);
  return key || 'key';
}

/**
 * Why a JSX text node is out of stet's reach: it lives inside a message
 * catalog's element, or its author opted it out at the source. `null` where it
 * is ordinary copy.
 */
export type JsxTextSuppression = 'i18n' | 'ignored' | null;

/**
 * The one answer to "is this JSXText out of scope, and why".
 *
 * `scan` reports what it finds here and rewrites none of it; `email extract`
 * lifts none of it into a slot. Two walks reaching different answers is how a
 * `<Trans>` sentence ends up rewritten by one tool after the other promised
 * never to touch it, so the rules live once and both call this.
 */
export function jsxTextSuppression(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  text: TS.JsxText,
): JsxTextSuppression {
  if (insideI18nElement(ts, sf, text)) return 'i18n';
  return jsxTextIgnored(ts, sf, text) ? 'ignored' : null;
}

/**
 * A node whose copy belongs to a message catalog — `t(…)`, `i18n.t(…)`,
 * `msg(…)`, and the TAGGED-TEMPLATE forms of the same (`` t`Hello ${name}` ``,
 * `` msg`…` ``), which is how Lingui's macros are ordinarily written. Both
 * shapes answer here, so neither walk lifts a catalog string and both report it.
 */
export function isI18nCall(ts: typeof import('typescript'), node: TS.Node): boolean {
  const tag = ts.isCallExpression(node)
    ? node.expression
    : ts.isTaggedTemplateExpression(node)
      ? node.tag
      : undefined;
  if (tag === undefined) return false;
  if (ts.isIdentifier(tag)) return tag.text === 't' || tag.text === 'msg';
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text === 't';
  return false;
}

/** A template literal's cooked text, spans included — what a catalog key reads as. */
export function templateText(
  ts: typeof import('typescript'),
  literal: TS.TemplateLiteral,
): string {
  if (ts.isNoSubstitutionTemplateLiteral(literal)) return literal.text;
  return literal.head.text + literal.templateSpans.map((span) => span.literal.text).join('');
}

/** A property's name where it is written as one — an identifier or a string. Computed and numeric names answer `undefined`. */
function propName(ts: typeof import('typescript'), name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** A `send(…)`/`x.send(…)` call — the mailer shape whose arguments the JSX walk owns. */
function isSendCall(ts: typeof import('typescript'), call: TS.CallExpression): boolean {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text === 'send';
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'send';
  return false;
}

function jsxTagName(ts: typeof import('typescript'), sf: TS.SourceFile, el: TS.Node): string | undefined {
  if (ts.isJsxElement(el)) return el.openingElement.tagName.getText(sf);
  if (ts.isJsxSelfClosingElement(el)) return el.tagName.getText(sf);
  return undefined;
}

function insideI18nElement(ts: typeof import('typescript'), sf: TS.SourceFile, node: TS.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur)) {
      const tag = jsxTagName(ts, sf, cur);
      if (tag !== undefined && I18N_ELEMENTS.has(tag)) return true;
    }
  }
  return false;
}

/**
 * The JSX escape hatch: an ignore-marker comment container immediately before
 * the literal's JSX child. A line comment cannot sit between JSX siblings, so
 * the send-site hatch is a leading one instead.
 */
function hasJsxIgnoreBefore(ts: typeof import('typescript'), sf: TS.SourceFile, child: TS.Node): boolean {
  const parent = child.parent;
  if (!parent || !(ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return false;
  const idx = parent.children.indexOf(child as TS.JsxChild);
  if (idx < 0) return false;
  for (let i = idx - 1; i >= 0; i--) {
    const sib = parent.children[i];
    if (sib === undefined) continue;
    if (ts.isJsxText(sib) && sib.containsOnlyTriviaWhiteSpaces) continue;
    return ts.isJsxExpression(sib) && sib.getText(sf).includes(IGNORE_MARKER);
  }
  return false;
}

function firstMeaningfulChild(
  ts: typeof import('typescript'),
  el: TS.JsxElement | TS.JsxFragment,
): TS.JsxChild | undefined {
  return el.children.find((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
}

/**
 * jsx-text is opted out when the ignore marker sits before the TEXT (a direct
 * sibling) OR — the documented form (specs/adoption) — before the ELEMENT that
 * wraps it, where the text is that element's first meaningful child (P2-4).
 */
function jsxTextIgnored(ts: typeof import('typescript'), sf: TS.SourceFile, text: TS.JsxText): boolean {
  if (hasJsxIgnoreBefore(ts, sf, text)) return true;
  const parent = text.parent;
  return (
    !!parent &&
    ts.isJsxElement(parent) &&
    firstMeaningfulChild(ts, parent) === text &&
    hasJsxIgnoreBefore(ts, sf, parent)
  );
}

/**
 * The parse kind by extension — a `.ts` mailer parsed as TSX mis-reads `<T>`.
 * Exported for `cli/email-extract.ts`, which parses the same host files for
 * their export shape and must not disagree with this walk about what they are.
 */
export function scriptKindFor(ts: typeof import('typescript'), file: string): TS.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * One managed-surface file, walked once for everything its three consumers need:
 * scan's/register's unkeyed literals, eject's already-adopted accessor calls,
 * and the orphan-import/decl spans eject drops. A file the compiler cannot parse
 * cleanly is report-only — `parseErrors: true` and no literals, never rewritten.
 */
export async function scanSource(
  file: string,
  source: string,
  opts: { readPathImport: string },
): Promise<ScanResult> {
  const ts = await loadTypescript();
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));

  const empty: ScanResult = {
    file,
    hasUseClient: false,
    literals: [],
    accessorCalls: [],
    stetImportSpans: [],
    copyDeclSpans: [],
    resolvedMapDeclSpans: [],
    i18nSkips: [],
    parseErrors: false,
    sourceFile: sf,
    claimed: [],
  };

  // The parse-error gate. `parseDiagnostics` is an internal `SourceFile` field —
  // read via a typed reach, no `any` — and any syntax error makes the file
  // report-only: a file the compiler could not parse is never rewritten.
  const diagnostics =
    (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return { ...empty, parseErrors: true };

  // The directive prologue and the imports — a top-level pass. `hasUseClient`,
  // the import-insert offset, the stet-import drop spans and `accessorImported`
  // are all read off it. (The per-literal `copy` binding is the scope-walk below.)
  let hasUseClient = false;
  let importInsertPos = 0;
  let inPrologue = true;
  const stetImportSpans: Span[] = [];
  let accessorImported = false;

  for (const stmt of sf.statements) {
    if (inPrologue && ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === 'use client') hasUseClient = true;
      importInsertPos = Math.max(importInsertPos, stmt.end);
      continue;
    }
    inPrologue = false;
    if (!ts.isImportDeclaration(stmt)) continue;
    importInsertPos = Math.max(importInsertPos, stmt.end);

    const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : '';
    const isStet = spec === '@getstet/stet' || spec.startsWith('@getstet/stet/');
    const isReadPath = spec === opts.readPathImport;
    if (isStet || isReadPath) stetImportSpans.push(lineSpan(source, stmt.getStart(sf), stmt.end));

    const clause = stmt.importClause;
    if (!clause) continue;
    // `accessorImported` (file-level): the accessor import is ALREADY present, so
    // a re-run inserts no duplicate. The accessor is always a NAMED import —
    // `{ copy }` from the read-path, or `{ useCopy }` from @getstet/stet/react; a
    // default/namespace `copy` is not the accessor.
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if (el.name.text === 'copy' && isReadPath) accessorImported = true;
        if (el.name.text === 'useCopy' && spec === '@getstet/stet/react') accessorImported = true;
      }
    }
  }

  // The tree walk. `.parent` links (set by `createSourceFile`'s fourth arg)
  // carry ancestry, so context, the enclosing component and the i18n/ignore
  // suppressions are all read off the node rather than threaded through.
  interface PartialLiteral {
    pos: number;
    end: number;
    raw: string;
    text: string;
    context: 'jsx-text' | 'jsx-attr' | 'send-arg';
    enclosingBodyPos: number | null;
    copyBinding: 'stet' | 'foreign' | 'none';
  }
  const partials: PartialLiteral[] = [];
  const accessorCalls: LocatedAccessor[] = [];
  const i18nSkips: I18nSkip[] = [];
  const claimed: Span[] = [];
  /** A whole argument list, claimed — the decisions inside it are this walk's, reported or not. */
  const claimArguments = (call: TS.CallExpression): void => {
    if (call.arguments.length > 0) claimed.push({ pos: call.arguments.pos, end: call.arguments.end });
  };
  const copyDeclSpans: Span[] = [];
  const resolvedMapDeclSpans: Span[] = [];

  const functionName = (fn: TS.Node): string | undefined => {
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    return undefined;
  };
  const isFunctionLike = (n: TS.Node): boolean =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const bodyReturnsJsx = (body: TS.Block): boolean => {
    let found = false;
    const look = (n: TS.Node): void => {
      if (found || isFunctionLike(n)) return; // never descend into a nested function
      if (ts.isReturnStatement(n) && n.expression) {
        let e: TS.Expression = n.expression;
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) found = true;
      }
      ts.forEachChild(n, look);
    };
    ts.forEachChild(body, look);
    return found;
  };
  // The nearest ancestor that is BOTH block-bodied AND a component — an
  // expression-bodied `.map(x => <li/>)` callback is not block-bodied, so a hook
  // never lands inside it; the walk continues to the real component.
  const enclosingComponentBodyPos = (node: TS.Node): number | null => {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (!(ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur))) continue;
      const body = cur.body;
      if (!body || !ts.isBlock(body)) continue;
      const name = functionName(cur);
      // A function passed DIRECTLY as a call argument (e.g. `.map((x) => {…})`)
      // is a callback, not a component — even a block-bodied one that returns
      // JSX — so a hook never lands inside it and crashes at render. A
      // Capitalized name still wins (a named component handed to an HOC), and an
      // anonymous `export default () => {…}` still resolves via returns-JSX
      // because it is not a call argument.
      const isCallback =
        !!cur.parent && ts.isCallExpression(cur.parent) && cur.parent.arguments.includes(cur as TS.Expression);
      const isComponent = (name !== undefined && /^[A-Z]/.test(name)) || (!isCallback && bodyReturnsJsx(body));
      if (isComponent) return body.getStart(sf) + 1;
    }
    return null;
  };

  // --- Per-literal lexical `copy` binding (operator 2026-08-24) ---
  // Whether a binding name binds `copy` — an identifier, or a destructuring
  // pattern (`{ copy }` / `[copy]` / `{ x: copy }`) whose LOCAL name is `copy`.
  const bindingNameHasCopy = (name: TS.BindingName): boolean => {
    if (ts.isIdentifier(name)) return name.text === 'copy';
    for (const el of name.elements) {
      if (ts.isBindingElement(el) && bindingNameHasCopy(el.name)) return true;
    }
    return false;
  };
  // A `copy` variable binding in one list. `'stet'` ONLY for the exact
  // `const copy = useCopy()`; a `let`/`var copy` (even `= useCopy()`), any other
  // initializer, or a destructured `copy` is `'foreign'`. In a position-aware
  // (block) scope, a `const`/`let copy` declared AFTER the literal is in its TDZ
  // → `'foreign'` (never `'stet'`, which would emit a use-before-declare; never
  // `'none'`, since a second `const copy` would redeclare).
  const classifyVarList = (
    list: TS.VariableDeclarationList,
    fromPos: number,
    positionAware: boolean,
  ): 'stet' | 'foreign' | null => {
    for (const decl of list.declarations) {
      if (ts.isIdentifier(decl.name)) {
        if (decl.name.text !== 'copy') continue;
        if (positionAware && decl.getStart(sf) > fromPos) return 'foreign';
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
        const init = decl.initializer;
        const isUseCopy =
          !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCopy';
        return isConst && isUseCopy ? 'stet' : 'foreign';
      }
      if (bindingNameHasCopy(decl.name)) return 'foreign';
    }
    return null;
  };
  // A `copy` import. The accessor is ONLY a named `{ copy }` (incl. `{ x as copy }`)
  // from the read-path module → `'stet'`. A default `import copy from …` or a
  // namespace `import * as copy from …` binds `copy` but calling it leaf-only
  // would hit a namespace/default at runtime → `'foreign'`; a named `{ copy }`
  // from any other module is `'foreign'` too.
  const classifyImport = (imp: TS.ImportDeclaration): 'stet' | 'foreign' | null => {
    const spec = ts.isStringLiteral(imp.moduleSpecifier) ? imp.moduleSpecifier.text : '';
    const clause = imp.importClause;
    if (!clause) return null;
    if (clause.name?.text === 'copy') return 'foreign';
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb) && nb.name.text === 'copy') return 'foreign';
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.name.text !== 'copy') continue;
        return spec === opts.readPathImport ? 'stet' : 'foreign';
      }
    }
    return null;
  };
  // Whether ONE enclosing scope binds `copy`, and how — `null` if it does not.
  // A Block is position-aware (TDZ); the SourceFile is NOT (a function body runs
  // after module init, so a later top-level binding is still in scope at call).
  const bindingInScope = (node: TS.Node, fromPos: number): 'stet' | 'foreign' | null => {
    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isSourceFile(node)) {
      const positionAware = !ts.isSourceFile(node);
      for (const stmt of node.statements) {
        if (ts.isVariableStatement(stmt)) {
          const k = classifyVarList(stmt.declarationList, fromPos, positionAware);
          if (k) return k;
        } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'copy') {
          return 'foreign';
        } else if (ts.isImportDeclaration(stmt)) {
          const k = classifyImport(stmt);
          if (k) return k;
        }
      }
      return null;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return node.parameters.some((p) => bindingNameHasCopy(p.name)) ? 'foreign' : null;
    }
    if (ts.isCatchClause(node)) {
      return node.variableDeclaration && bindingNameHasCopy(node.variableDeclaration.name) ? 'foreign' : null;
    }
    // A `for`/`for-in`/`for-of` header binding is always in scope for the body.
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      return classifyVarList(node.initializer, fromPos, false);
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      return classifyVarList(node.initializer, fromPos, false);
    }
    return null;
  };
  // The `copy` binding visible AT a literal — nearest enclosing scope wins; no
  // binding anywhere is `'none'`. Same-file only: a cross-module alias/re-export
  // chain, a `var copy` hoisted from a sibling block, and a locally-shadowed
  // `useCopy` identifier are the documented residuals (they need the
  // type-checker — §2.3 known-limits); it resolves to the nearest LOCAL binding
  // and never crashes.
  const copyBindingAt = (node: TS.Node): 'stet' | 'foreign' | 'none' => {
    const fromPos = node.getStart(sf);
    for (let cur: TS.Node | undefined = node; cur; cur = cur.parent) {
      const kind = bindingInScope(cur, fromPos);
      if (kind) return kind;
      if (ts.isSourceFile(cur)) break;
    }
    return 'none';
  };

  const elementOfAttr = (attr: TS.JsxAttribute): TS.Node | undefined => {
    const owner = attr.parent.parent; // JsxAttributes -> Jsx(Opening|SelfClosing)Element
    if (ts.isJsxSelfClosingElement(owner)) return owner;
    if (ts.isJsxOpeningElement(owner)) return owner.parent; // JsxElement
    return undefined;
  };
  // The send-site escape hatch: a leading `// stet-ignore-next-line` on the
  // statement the send call sits in.
  const enclosingStatement = (node: TS.Node): TS.Node => {
    let cur = node;
    while (cur.parent && !ts.isSourceFile(cur.parent) && !ts.isBlock(cur.parent)) cur = cur.parent;
    return cur;
  };
  const hasLineIgnore = (node: TS.Node): boolean => {
    const stmt = enclosingStatement(node);
    const ranges = ts.getLeadingCommentRanges(source, stmt.getFullStart()) ?? [];
    return ranges.some((r) => source.slice(r.pos, r.end).includes(IGNORE_MARKER));
  };

  // `copy('k')` or `useCopy()('k')` with a single string-literal argument.
  const accessorKeyArg = (call: TS.CallExpression): TS.StringLiteral | undefined => {
    const e = call.expression;
    const isAccessor =
      (ts.isIdentifier(e) && e.text === 'copy') ||
      (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'useCopy');
    if (!isAccessor || call.arguments.length !== 1) return undefined;
    const a = call.arguments[0];
    return a !== undefined && ts.isStringLiteral(a) ? a : undefined;
  };
  const accessorContext = (call: TS.CallExpression): { context: LocatedAccessor['context']; pos: number; end: number } => {
    const p = call.parent;
    if (p && ts.isJsxExpression(p)) {
      const context = ts.isJsxAttribute(p.parent) ? 'jsx-attr' : 'jsx-text';
      return { context, pos: p.getStart(sf), end: p.end };
    }
    return { context: 'send-arg', pos: call.getStart(sf), end: call.end };
  };
  const pushSendLiteral = (lit: TS.StringLiteral): void => {
    const pos = lit.getStart(sf);
    partials.push({ pos, end: lit.end, raw: source.slice(pos, lit.end), text: lit.text, context: 'send-arg', enclosingBodyPos: enclosingComponentBodyPos(lit), copyBinding: copyBindingAt(lit) });
  };

  const visit = (node: TS.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        // `const copy = useCopy()` — eject's drop target (the orphaned hook binding).
        const isCopyUseCopy =
          ts.isIdentifier(decl.name) &&
          decl.name.text === 'copy' &&
          !!init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'useCopy';
        if (isCopyUseCopy) copyDeclSpans.push(lineSpan(source, node.getStart(sf), node.end));
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'resolveAll') {
          resolvedMapDeclSpans.push(lineSpan(source, node.getStart(sf), node.end));
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const keyArg = accessorKeyArg(node);
      if (keyArg) {
        const { context, pos, end } = accessorContext(node);
        // `useCopy()('k')` is definitionally the stet hook; a bare `copy('k')`
        // resolves through the same scope-walk the literals use, so eject can
        // tell the accessor from a foreign `copy` (copy-to-clipboard) and skip it.
        const copyBinding = ts.isIdentifier(node.expression) ? copyBindingAt(node) : 'stet';
        accessorCalls.push({ file, pos, end, key: keyArg.text, context, copyBinding });
        claimArguments(node);
      } else if (isI18nCall(ts, node)) {
        // The WHOLE call, not just its arguments: a catalog call is an i18n
        // position entire, and a second walk must not re-report the string
        // inside it as an ordinary literal.
        claimed.push({ pos: node.getStart(sf), end: node.end });
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg)) i18nSkips.push({ file, pos: arg.getStart(sf), text: arg.text });
        }
      } else if (isSendCall(ts, node)) {
        // Claimed whether or not it reports: the deny list and the ignore
        // comment are decisions this walk made, not positions it left open.
        claimArguments(node);
        if (!hasLineIgnore(node)) {
          const first = node.arguments[0];
          if (first !== undefined && ts.isStringLiteral(first)) {
            pushSendLiteral(first);
          } else {
            const obj = node.arguments.find(ts.isObjectLiteralExpression);
            if (obj) {
              for (const prop of obj.properties) {
                if (!ts.isPropertyAssignment(prop)) continue;
                const name = propName(ts, prop.name);
                if (name === undefined || SEND_DENY.has(name)) continue;
                if (ts.isStringLiteral(prop.initializer)) pushSendLiteral(prop.initializer);
              }
            }
          }
        }
      }
    }

    // The tagged-template form of the same macros: `` t`Hello ${name}` ``.
    // Reported like the call form, and rewritten by nothing.
    if (ts.isTaggedTemplateExpression(node) && isI18nCall(ts, node)) {
      i18nSkips.push({ file, pos: node.template.getStart(sf), text: templateText(ts, node.template) });
      claimed.push({ pos: node.getStart(sf), end: node.end });
    }

    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
      const raw = source.slice(node.pos, node.end);
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const pos = node.pos + leading;
      const end = node.end - trailing;
      const trimmed = source.slice(pos, end);
      const text = collapseWhitespace(decodeEntities(trimmed));
      if (text !== '') {
        const suppression = jsxTextSuppression(ts, sf, node);
        if (suppression === 'i18n') i18nSkips.push({ file, pos, text });
        else if (suppression === null) partials.push({ pos, end, raw: trimmed, text, context: 'jsx-text', enclosingBodyPos: enclosingComponentBodyPos(node), copyBinding: copyBindingAt(node) });
      }
    }

    if (ts.isJsxAttribute(node)) {
      // The whole attribute is claimed, structural ones included: deciding that
      // `className` is not copy IS this walk's decision.
      claimed.push({ pos: node.getStart(sf), end: node.end });
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (COPY_ATTRS.has(name) && init && ts.isStringLiteral(init) && !insideI18nElement(ts, sf, node)) {
        const element = elementOfAttr(node);
        if (!element || !hasJsxIgnoreBefore(ts, sf, element)) {
          // Decode entities so the seeded default matches what render shows —
          // after adopt the value is served via `alt={copy('key')}`, an
          // expression React does NOT entity-decode. Attribute whitespace is
          // significant, so it is NOT collapsed (unlike jsx-text). `raw` stays
          // the quoted source slice, so the §2.4 re-confirm guard is untouched.
          const pos = init.getStart(sf);
          partials.push({ pos, end: init.end, raw: source.slice(pos, init.end), text: decodeEntities(init.text), context: 'jsx-attr', enclosingBodyPos: enclosingComponentBodyPos(node), copyBinding: copyBindingAt(node) });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  const literals: LocatedLiteral[] = partials.map((p) => ({
    file,
    pos: p.pos,
    end: p.end,
    raw: p.raw,
    text: p.text,
    context: p.context,
    // The JSX walk's own — send arguments included. It is the one shape the
    // rewrite engine accepts, and the one site that ever emits it.
    shape: 'jsx',
    proposedKey: proposeKey(p.text),
    enclosingBodyPos: p.enclosingBodyPos,
    copyBinding: p.copyBinding,
    accessorImported,
    importInsertPos,
  }));

  return { file, hasUseClient, literals, accessorCalls, stetImportSpans, copyDeclSpans, resolvedMapDeclSpans, i18nSkips, parseErrors: false, sourceFile: sf, claimed };
}

/**
 * A statement's span extended over its leading indent AND one trailing line
 * break, so eject's drop removes the whole line — no blank line, no dangling
 * indent where a `const copy` or an import used to be.
 */
function lineSpan(source: string, pos: number, nodeEnd: number): Span {
  let start = pos;
  while (start > 0 && (source.charAt(start - 1) === ' ' || source.charAt(start - 1) === '\t')) start -= 1;
  let end = nodeEnd;
  if (source.charAt(end) === '\r') end += 1;
  if (source.charAt(end) === '\n') end += 1;
  return { pos: start, end };
}

/**
 * The qualifying bar the copy-module walk and the dialect detector share: with
 * tags stripped, does the text carry two consecutive word characters, one of
 * them a letter?
 *
 * It is what keeps a declared module's non-copy strings quiet — `'x'`,
 * `'12345'`, a class list, and above all the pure-markup template shell
 * `email extract --apply` leaves behind, whose spans are tags and nothing else.
 * A `property` finding never takes the bar: the declared list is the contract
 * there, and a property the host named is copy by declaration.
 *
 * The strip is the module's own `TAG`, the one tag pattern both detectors read.
 * The looser `<[^>]*>` this once inlined diverged from it in one direction only
 * — it swallows a `<…>` span containing a second `<` whole, dropping the prose
 * between the brackets and with it the finding — and it carried the last of the
 * adversarial backtracking, since the bar runs per dialect run and per module
 * literal alike.
 */
function qualifiesAsCopy(text: string): boolean {
  return /[A-Za-z]\w|\w[A-Za-z]/.test(text.replace(TAG, ' '));
}

/** One declared copy module, walked once — the module twin of `ScanResult`. */
export interface ModuleScanResult {
  file: string;
  literals: LocatedLiteral[];
  i18nSkips: I18nSkip[];
  /**
   * By literal `pos`: the ONE warn line that REPLACES the ordinary unkeyed one
   * — a property name that fails the key grammar, or one that repeats in the
   * module. Never a second line beside the unkeyed one; the reader gets one
   * sentence per finding.
   */
  notes: Map<number, string>;
  /**
   * One entry per ignore comment that silenced MORE THAN ONE literal which
   * would otherwise have been a finding — the whole-statement opt-out, which the
   * walk-up rule makes legal above an `export const copy = {…}` and which is
   * otherwise indistinguishable from a clean module. A comment covering exactly
   * one finding is the targeted opt-out working and yields no entry, and a
   * suppressed literal that never met the qualifying bar is not counted: a warn
   * about junk that never warranted a warn is the vacuity this channel exists to
   * remove.
   */
  ignoreSummaries: { line: number; count: number }[];
  parseErrors: boolean;
}

/**
 * One DECLARED COPY MODULE, walked for the string literals its host means as
 * copy — the sibling of `scanSource` for the files the JSX locator has nothing
 * to say about: an object-literal `copy.ts`, a string-shape email template.
 *
 * Everything in runtime code is presumed copy, with the non-copy positions
 * excluded by ENUMERATION: type positions and comments, module specifiers, the
 * directive prologue, string-literal property names, and — in a `.tsx`/`.jsx`
 * module the JSX walk also covers — every position that walk classifies, its
 * attributes and send arguments included, so a dual-declared file loses no JSX
 * coverage and nothing reports twice.
 *
 * An object-literal property VALUE whose name fits the descriptor key grammar
 * proposes THAT name as its key, on the name's first occurrence in the file:
 * the module's own names are the registry, and a derived key would fork the two
 * apart on every entry. Everything else takes the ordinary derived proposal and
 * must clear the qualifying bar.
 *
 * Where the file is ALSO a managed surface, the caller hands over `scanSource`'s
 * own parse and the spans it claimed: the file is parsed once, and every
 * position that walk classified is its own — so a dual-declared file neither
 * loses coverage nor reports anything twice. The extension rules below still
 * stand on their own, for a `.tsx` declared as a copy module and nothing else,
 * where no JSX walk ran and there is nothing to hand over.
 *
 * The rewrite-only fields of a returned literal are inert — no enclosing body,
 * no `copy` binding, no import position — because a module finding is adopted
 * as RECORD and its source is never edited. `register`'s runtime guard is what
 * enforces that, not these values.
 */
export async function scanModule(
  file: string,
  source: string,
  opts: { sourceFile?: TS.SourceFile; claimed?: readonly Span[] } = {},
): Promise<ModuleScanResult> {
  const ts = await loadTypescript();
  const sf =
    opts.sourceFile ?? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const claimedSpans = opts.claimed ?? [];
  // POSITIONS BELONG TO THE TREE, so the text is read from the tree too. A
  // handed-over parse may predate an edit the caller has since applied to the
  // file on disk — `register --write` rewrites a leaf in the very file this
  // walk is about to cover — and every offset here indexes the tree the nodes
  // came from. Reading the caller's `source` against those offsets slides an
  // ignore comment out of view and slices a literal's `raw` out of the wrong
  // bytes.
  const text = opts.sourceFile === undefined ? source : opts.sourceFile.text;

  const literals: LocatedLiteral[] = [];
  const i18nSkips: I18nSkip[] = [];
  const notes = new Map<number, string>();
  const ignoreSummaries: { line: number; count: number }[] = [];
  const result: ModuleScanResult = { file, literals, i18nSkips, notes, ignoreSummaries, parseErrors: false };

  // The same parse-error gate `scanSource` uses: a file the compiler could not
  // read is reported and left alone.
  const diagnostics =
    (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return { ...result, literals: [], parseErrors: true };

  // The directive prologue. `'use client'` is an instruction to the bundler, and
  // it sits in exactly the position an ordinary top-level string would.
  const prologue = new Set<number>();
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    prologue.add(stmt.expression.getStart(sf));
  }

  // A `.tsx`/`.jsx` module: the JSX-side positions are the JSX walk's whether or
  // not it ran here, so a structural attribute never becomes a module finding.
  // Where it DID run, `claimedSpans` covers the same ground exactly and more.
  const jsxWalked = isJsxFile(file);
  /** A position the JSX walk already classified — reported or silently decided. */
  const isClaimed = (node: TS.Node): boolean => {
    const start = node.getStart(sf);
    return claimedSpans.some((span) => start >= span.pos && node.end <= span.end);
  };

  // The first occurrence of each grammar-valid property name. A name-keyed
  // registry over repeats is order-dependent — and its adopted-suppression could
  // only ever match one of them — so only the first proposes itself.
  const claimed = new Set<string>();

  /**
   * What `claimed` WOULD hold if the module carried no ignore comments — the
   * counterfactual the tally below reads, and the only thing that can answer
   * "would this literal have been a finding?" for a repeated name.
   *
   * `claimed` itself is never written on the suppressed path, because claiming a
   * name for a literal nobody sees would flip a later real property of that name
   * into the repeats path. That leaves `claimed` blind to suppressed names: two
   * suppressed properties both called `title` would each read as a declaration,
   * counting two where the real gate would have made the second a repeat that
   * takes the qualifying bar. This set carries the names the real gate claims AND
   * the ones the tally counts, so the count matches the module that would have
   * been reported.
   */
  const wouldClaim = new Set<string>();

  /**
   * The source opt-out: an ignore comment above the literal, its property, or
   * the statement holding it, answered with the GOVERNING COMMENT'S OWN
   * position. The position is what lets everything one comment silences be
   * tallied together — a comment above an `export const copy = {…}` reaches
   * every property under it, and the count is the only thing that tells that
   * apart from a clean module.
   */
  const ignoreAbove = (node: TS.Node): number | undefined => {
    for (let cur: TS.Node = node; ; cur = cur.parent) {
      const ranges = ts.getLeadingCommentRanges(text, cur.getFullStart()) ?? [];
      const hit = ranges.find((r) => text.slice(r.pos, r.end).includes(IGNORE_MARKER));
      if (hit !== undefined) return hit.pos;
      const parent: TS.Node | undefined = cur.parent;
      if (parent === undefined || ts.isSourceFile(parent) || ts.isBlock(parent)) return undefined;
    }
  };

  /** Would-have-been findings per governing comment position — the summary's tally. */
  const suppressed = new Map<number, number>();

  /** The literal is a NAME, not a value — `{ 'hero-title': 'x' }`'s left half. */
  const isPropertyName = (lit: TS.Node): boolean => {
    const parent: TS.Node | undefined = lit.parent;
    if (parent === undefined) return false;
    if (ts.isComputedPropertyName(parent)) return true;
    return (parent as TS.Node & { name?: TS.Node }).name === lit;
  };

  /**
   * The name of the object-literal property this literal is the value of.
   *
   * A per-value cast or parenthesis wraps the literal without changing what the
   * property is — `{ hero: 'Hero copy' as const }` names its key just as plainly
   * as the whole-object `as const` form does — so the wrapper chain is climbed
   * before the question is asked. Reading the literal's immediate parent alone
   * dropped those to derived keys, forking the registry from the module through
   * a side door.
   */
  const valueOfProperty = (lit: TS.Node): string | undefined => {
    let node: TS.Node = lit;
    for (
      let up: TS.Node | undefined = node.parent;
      up !== undefined &&
      (ts.isAsExpression(up) || ts.isSatisfiesExpression(up) || ts.isParenthesizedExpression(up));
      up = node.parent
    ) {
      node = up;
    }
    const parent: TS.Node | undefined = node.parent;
    if (parent === undefined || !ts.isPropertyAssignment(parent) || parent.initializer !== node) return undefined;
    if (!ts.isObjectLiteralExpression(parent.parent)) return undefined;
    return propName(ts, parent.name);
  };

  const record = (node: TS.Node, literalText: string, isTemplate: boolean): void => {
    const pos = node.getStart(sf);
    if (prologue.has(pos) || isPropertyName(node)) return;

    // The suppressed literal returns HERE, above the qualifying gate and above
    // the property claim below it: claiming a name for a literal nobody will see
    // would flip a later real property of the same name into the repeats path.
    // The tally is the gate's own logic applied locally instead — a property the
    // host named under a grammar-valid unclaimed name is a finding by
    // declaration, anything else takes the bar — so the count is
    // would-have-been findings and never suppressed junk.
    const ignoredAt = ignoreAbove(node);
    if (ignoredAt !== undefined) {
      const ignoredName = isTemplate ? undefined : valueOfProperty(node);
      let declared = false;
      if (ignoredName !== undefined && KEY_NAME.test(ignoredName) && !wouldClaim.has(ignoredName)) {
        wouldClaim.add(ignoredName);
        declared = true;
      }
      if (declared || qualifiesAsCopy(literalText)) suppressed.set(ignoredAt, (suppressed.get(ignoredAt) ?? 0) + 1);
      return;
    }

    let shape: LiteralShape = isTemplate ? 'template' : 'plain';
    let key = proposeKey(literalText);
    let note: string | undefined;
    // A template with substitutions is never a property proposal — a default has
    // to be a literal value, and the slotted-template shape is extract's.
    const name = isTemplate ? undefined : valueOfProperty(node);
    if (name !== undefined) {
      if (!KEY_NAME.test(name)) {
        note = `property name ${name} fails the key grammar — propose key ${key}`;
      } else if (claimed.has(name)) {
        note = `${name} repeats in this module — only the first occurrence proposes it as a key`;
      } else {
        claimed.add(name);
        wouldClaim.add(name);
        shape = 'property';
        key = name;
      }
    }
    if (shape !== 'property' && !qualifiesAsCopy(literalText)) return;
    if (note !== undefined) notes.set(pos, note);
    literals.push({
      file,
      pos,
      end: node.end,
      raw: text.slice(pos, node.end),
      text: literalText,
      context: 'module',
      shape,
      proposedKey: key,
      enclosingBodyPos: null,
      copyBinding: 'none',
      accessorImported: false,
      importInsertPos: 0,
    });
  };

  const visit = (node: TS.Node): void => {
    // Whatever the JSX walk classified is the JSX walk's, whole.
    if (isClaimed(node)) return;
    // Types first — `type Variant = 'primary'` declares a name, it does not say
    // it — and comments are trivia this walk never reaches at all.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node)) return;
    // Module specifiers, every form one is written in. A `declare module` names
    // its specifier with a STRING; a `namespace Copy { … }` names itself with an
    // identifier and holds ordinary runtime code, so only the string form is a
    // specifier and only it is skipped.
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') return;
      if (isI18nCall(ts, node)) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteralLike(arg)) i18nSkips.push({ file, pos: arg.getStart(sf), text: arg.text });
        }
        return;
      }
      // The send walk owns its arguments whole where it runs — the routing
      // fields it denies as much as the subject it takes.
      if (jsxWalked && isSendCall(ts, node)) return;
    }
    if (ts.isTaggedTemplateExpression(node) && isI18nCall(ts, node)) {
      i18nSkips.push({ file, pos: node.template.getStart(sf), text: templateText(ts, node.template) });
      return;
    }
    // Attributes are the JSX walk's, structural ones included: `className="btn"`
    // in a declared module can never become a finding.
    if (jsxWalked && ts.isJsxAttribute(node)) return;

    if (ts.isTemplateExpression(node)) {
      // The qualifying text is the LITERAL SPANS concatenated — the substitutions
      // are code, and counting their source would keep an adopted email shell
      // warning forever on the prop names inside it.
      record(node, templateText(ts, node), true);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text, false);
      return;
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  // Only a comment that silenced MORE THAN ONE would-have-been finding is
  // reported: a single-finding opt-out is the source-level feature working.
  for (const [commentPos, count] of suppressed) {
    if (count > 1) ignoreSummaries.push({ line: sf.getLineAndCharacterOfPosition(commentPos).line + 1, count });
  }
  ignoreSummaries.sort((a, b) => a.line - b.line);

  return result;
}

/**
 * Whether a file is one the JSX walk can read. Three consumers ask: `register`
 * (a non-JSX file has no client-component form on any router), the copy-module
 * walk (whose JSX-side exclusions turn on it), and `scan` (which says so out
 * loud where a `.tsx` is declared as a copy module and nothing else).
 */
export function isJsxFile(name: string): boolean {
  return name.endsWith('.tsx') || name.endsWith('.jsx');
}

/** The template dialects — files the TypeScript compiler refuses and the text detector reads instead. */
export type Dialect = 'astro' | 'vue' | 'svelte' | 'mdx';

/**
 * The ONE dialect-extension test. `eject` reads it for the files it sweeps for
 * imports without parsing, and `scan` for the files it text-detects rather than
 * handing to a compiler that would refuse them — one list, so the two can never
 * disagree about what a dialect is.
 *
 * Deliberately case-SENSITIVE, which is what eject's own test was: `.MDX` is not
 * a dialect here, and a case-insensitive widening is a change to what eject
 * sweeps, not a tidy-up.
 */
const DIALECT_EXTENSION = /\.(astro|vue|svelte|mdx)$/;

export function isDialectFile(name: string): boolean {
  return DIALECT_EXTENSION.test(name);
}

/** Which dialect a file is, or `null` where it is not one. */
export function dialectOf(name: string): Dialect | null {
  const matched = DIALECT_EXTENSION.exec(name);
  return matched === null ? null : (matched[1] as Dialect);
}

/**
 * A possible-copy text run in a template dialect. It carries NO proposed key —
 * the compiler never parsed the file, so nothing here can tell an attribute
 * from content or an expression from prose, and a guessed key would poison a
 * registry `register` then trusts. It is its own type for the same reason: it
 * can supply none of a `LocatedLiteral`'s rewrite fields, and faking them is how
 * a dialect finding would reach `planRewrite`.
 */
export interface DialectFinding {
  file: string;
  pos: number;
  /** The trimmed run — what the warn quotes. */
  text: string;
}

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1[ \t]*>/gi;
const CODE_FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
const ESM_LINE = /^[ \t]*(?:import|export)\b[^\n]*$/gm;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/**
 * A tag, whose body cannot contain another `<`. The looser `<[^>]*>` treats a
 * bare `<` in prose as a tag opening and swallows everything up to the real
 * element's closing bracket — a sentence comparing two numbers loses its second
 * half — and it backtracks quadratically on a file with many stray brackets.
 *
 * The trade it accepts: a `<` inside a quoted attribute value ends the match
 * early, so the tag's own source can survive as a reported run. That is the
 * toward-REPORTING direction this detector commits to everywhere else.
 */
const TAG = /<[^<>]*>/g;
/**
 * A braced expression, ONE level flat: a nested `{` ends the match, and an
 * unbalanced one never matches at all. Both failures leave the text in place to
 * be REPORTED, which is the safe direction for a detector that proposes nothing.
 */
const BRACED = /\{[^{}]*\}/g;

/**
 * Code spillover from an unbalanced multi-line expression — the one shape this
 * detector drops rather than reports.
 *
 * `BRACED` is one level flat, so a multi-line expression it cannot balance
 * survives in two halves: the opening one (`{prev ?`, `{groups.map((g) => (`)
 * and, where a conditional's second branch begins a line, the closing one. Prose
 * takes neither shape. The quote guard is the toward-REPORTING half: a
 * brace-opening run carrying `'`, `"` or a backtick is a braced expression
 * holding a string, and a page-title template is exactly that — those keep
 * warning.
 *
 * This is the detector's ONE deliberate inversion of its report-when-unsure
 * default, and it reaches no further: the code-shaped runs that open with
 * anything else stay findings.
 */
function isCodeSpillover(text: string): boolean {
  return (text.startsWith('{') || text.startsWith('}')) && !/['"`]/.test(text);
}

/**
 * The template-dialect detector — pure text, and deliberately compiler-free, so
 * it works on the typescript-less hosts `eject` now serves and its answers do
 * not change under TypeScript 7.
 *
 * The strip order is load-bearing: comments go before tags, or the tag strip
 * eats `<!--` and `-->` and leaks the comment's prose as copy. What survives is
 * prose candidates, and a run qualifies on the same bar the module walk uses.
 *
 * Two limits ride it, both stated rather than silent. Attribute values die with
 * the tag strip — the JSX path's COPY attributes (`alt`, `title`,
 * `placeholder`, `aria-label`) are exactly what a text detector cannot see —
 * and frontmatter and script blocks are stripped whole, so copy a component
 * declares in its frontmatter const is not found here.
 */
export function scanDialect(file: string, source: string, dialect: Dialect): DialectFinding[] {
  // Stripped material is blanked to NUL rather than deleted, so every surviving
  // character keeps its original offset and the reported line is the real one.
  // It doubles as the run delimiter: two labels either side of a stripped tag
  // are two findings, not one.
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
  strip(TAG);
  strip(BRACED);

  const findings: DialectFinding[] = [];
  let start = -1;
  const flush = (end: number): void => {
    if (start < 0) return;
    const from = start;
    start = -1;
    const run = work.slice(from, end);
    const text = run.trim();
    if (text !== '' && !isCodeSpillover(text) && qualifiesAsCopy(text)) {
      findings.push({ file, pos: from + (run.length - run.trimStart().length), text });
    }
  };
  for (let i = 0; i < work.length; i++) {
    const ch = work.charAt(i);
    if (ch === '\0' || (ch === '\n' && blankLineFrom(work, i))) {
      flush(i);
      continue;
    }
    if (start < 0) start = i;
  }
  flush(work.length);
  return findings;
}

/** Whether the newline at `i` closes a paragraph — the next line is blank, or the text ends. */
function blankLineFrom(text: string, i: number): boolean {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text.charAt(j);
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

/**
 * A token present in host source as an identifier or inside a string, never as
 * a fragment of a longer name.
 *
 * The token is always a NAME the HOST chose — a `wrapperProvides` entry,
 * a flattened slot key — so it arrives here as data and is escaped before it
 * becomes a pattern. A slot named `cta(label` would otherwise build an
 * unbalanced group and throw, and the two callers are `doctor` and the scan
 * warn that rides the pre-commit hook: a crash there fails somebody's commit
 * over a typo in their descriptor.
 */
export function mentionsToken(source: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` asserts a boundary only beside a word character, so a token that
  // begins or ends with punctuation takes a bare match on that side rather
  // than one that can never hold.
  const left = /^\w/.test(token) ? '\\b' : '';
  const right = /\w$/.test(token) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`).test(source);
}

/**
 * The parsed token search both predicates below run, with `jsxText` the one
 * thing they disagree about.
 *
 * What it takes: an identifier by name equality, and the CONTENT of a string or
 * template span by containment — `href="{{unsubscribe_url}}"` inside a literal
 * is the source carrying that token. What it skips: TYPE positions whole — an
 * interface, a type alias, every `TypeNode` — because a declaration of a name is
 * not a use of it, and `email extract`'s own rewrite writes every slot name into
 * the props type it widens. And comments, which are trivia and are never
 * visited, so `// TODO: emit unsubscribe_url one day` satisfies nothing where
 * the plain-text grep accepted it.
 *
 * Containment runs through `mentionsToken`, so a token is never matched as a
 * fragment of a longer name.
 */
function tokenInCode(
  ts: typeof import('typescript'),
  file: string,
  source: string,
  token: string,
  jsxText: boolean,
): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  let found = false;

  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node)) return;
    // A destructured binding DECLARES a local name — `({ welcome__headline })`
    // — and declaring is not reading, exactly as a props-type member is not.
    // The shell `email extract` writes binds every slot into the parameter
    // pattern, so counting the binding would leave both questions blind to the
    // day the line that uses it is deleted. Only a default VALUE is a read.
    if (ts.isBindingElement(node)) {
      if (node.initializer !== undefined) visit(node.initializer);
      return;
    }
    if (ts.isIdentifier(node) && node.text === token) {
      found = true;
      return;
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || (jsxText && ts.isJsxText(node))) &&
      mentionsToken(node.text, token)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return found;
}

/**
 * Does this source RENDER the token — read it as a value, rather than merely
 * declare it as a type member?
 *
 * Scan's question, about a declared slot. `mentionsToken` cannot tell a render
 * from a declaration, and the difference decides whether a slot is still wired
 * up: the widened props type carries `welcome__headline: string;` whatever the
 * body does, so a grep over that file can never see the day somebody deletes the
 * line that reads it.
 *
 * JSX text does not count. A slot's value reaches the page through an
 * expression, and prose that happens to spell the flattened key is not the file
 * reading it.
 */
export function rendersToken(
  ts: typeof import('typescript'),
  file: string,
  source: string,
  token: string,
): boolean {
  return tokenInCode(ts, file, source, token, false);
}

/**
 * Does this source CARRY the token — emit it, under any of the forms a wrapper
 * emits one?
 *
 * Doctor's wrapper-chain question, about a `wrapperProvides` claim. It differs
 * from `rendersToken` in exactly one way: JSX text counts, because a wrapper can
 * carry a token as visible rendered text. Everything else the two share, down to
 * skipping types — a `FrameProps` member declaring `unsubscribe_url: string` is
 * a declaration, and a frame that only types the token emits nothing.
 *
 * Two names, because they answer two questions: is this slot READ, and is this
 * token CARRIED.
 */
export function carriesToken(
  ts: typeof import('typescript'),
  file: string,
  source: string,
  token: string,
): boolean {
  return tokenInCode(ts, file, source, token, true);
}

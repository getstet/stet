/**
 * What one `.astro` file yields for `register`: the literals it can rewrite
 * into key reads safely, the findings it cannot with the reason for each, how
 * the file reads a key (its `copy` binding and the read form), the read-back
 * every edited file passes before it counts, and the name of a read already
 * there, which `split` and `rename --propose` give a place.
 *
 * Fail-safe is the rule over all of it: a rewrite is planned only where the
 * file's structure proves it renders what the literal rendered, every planned
 * literal is one scan reported at the same position with the same text (the
 * cross-check), and anything else is listed for adoption by hand with the rule
 * that refused it. An edit is a span of the original text; every byte outside
 * a replaced span or the one insertion point stays as it was.
 *
 * A byte-order mark is read past, as Astro builds such a page: the file is read
 * without it and every offset handed out is based at 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import type * as TS from 'typescript';

import { loadConfig, pathAliasMappings, resolveSpecifier, type StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import {
  attrOf,
  htmlItems,
  lineIndex,
  namingOf,
  parentsOf,
  placeOf,
  readDocument,
  textOf,
  type Document,
  type Element,
} from './html-host.js';
import { baseName, isHeadKind, metaCopyNameOf, roleOf, type Place } from './key-names.js';
import { bindingsOf, braceRoot, braceTree, codeOf, KEY_READ, parsesAsExpression, stetModuleTest, type FileCode } from './key-reads.js';
import {
  blankNonMarkup,
  dialectCode,
  elementPath,
  FRONTMATTER,
  markupBraces,
  markupTags,
  maskExpressions,
  openTag,
  openTagAttrs,
  rawSpans,
  readAttrs,
  selfClosedRaw,
  unraw,
  VOID_ELEMENTS,
  within,
  type MarkupTag,
  type Span,
} from './markup.js';
import { CliError } from './report.js';
import { applyFileEdits, dominantEol, type Edit } from './rewrite.js';
import {
  astroFindings,
  collapseWhitespace,
  componentName,
  componentProse,
  COPY_ATTRS,
  decodeEntities,
  INLINE,
  nonCopyProp,
  parseDiagnosticsOf,
  qualifiesAsCopy,
  undecodedEntity,
  type DialectFinding,
  type LocatedLiteral,
} from './source-scan.js';

/** What one `.astro` file yields for register: the literals it can rewrite, the findings it cannot, and how the file reads a key. */
export interface AstroPlan {
  form: 'call' | 'property';
  /** The accessor import (with the fence where the file has no front matter), or null where `copy` is already stet's. */
  insert: Edit | null;
  /** The renderer import a rich literal needs (D16), or null. */
  richInsert: Edit | null;
  skips: Array<{ pos: number; text: string; reason: string }>;
  /** Each `application/ld+json` script, by its open tag's offset: listed apart from the findings, never rewritten. */
  structured: number[];
}

/** One file's reading, shared by the file's own plan and the one-hop read of a component it renders. */
interface Reading {
  file: string;
  /** The source with no byte-order mark: every offset here is into this. */
  page: string;
  bom: 0 | 1;
  /** The front matter's body, its offsets in `page` and its tree; null where the file has none. */
  front: { open: number; close: number; sf: TS.SourceFile } | null;
  document: Document;
  parents: Map<Element, Element>;
  code: FileCode;
  /** `page` with comments, scripts, styles and the front matter NUL-blanked. */
  blanked: string;
  /** The markup braces `dialectCode` also reads (a raw element's text holds none), each with its tree. */
  braces: Brace[];
  /** Each raw element's content. */
  raw: Span[];
}

interface Brace {
  start: number;
  end: number;
  /** Inside an open tag: an attribute's value, a spread. */
  inTag: boolean;
  tree: TS.SourceFile | null;
  /** The names the brace binds: parameters, binding elements and declarations; null where it does not parse. */
  binds: Set<string> | null;
}

/** Where a head text renders: the page's title, its description, or any other head text (a share title, a feed link's title). */
type HeadKind = 'title' | 'description' | 'other';

/** The skip reasons, as the terminal prints them. */
const BESIDE = 'beside an expression';
const UNPLACED = 'stet cannot place this text';
const IN_CODE = 'used in code';
const UNFOLLOWED = 'shown where stet cannot follow';
const MIXED = 'shown in the page and in its head';
const REBOUND = 'copy is rebound here';
const CANNOT_TELL = 'stet cannot tell how copy reads keys in this file';
const PAGES_SCAN = 'SEO text — adopt it with stet pages scan';

/** The elements whose text is code, a field's value, a graphic or a slot's fallback, never copy stet rewrites. */
const SKIP_TAGS = new Set(['code', 'kbd', 'samp', 'textarea', 'svg', 'math', 'slot']);
/** The attributes that make an element's content Astro's own: printed raw, or replaced. */
const RAW_ATTRS = ['is:raw', 'set:html', 'set:text'];
/** A rule that shows white space as written. */
const PRESERVED = /white-space\s*:\s*(?:pre|pre-wrap|pre-line|break-spaces)\b|whiteSpace\s*:\s*["'`](?:pre|pre-wrap|pre-line|break-spaces)\b/i;
/** A name the property form can read as `copy.<name>`. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Each component's file read once per run, and each prop's answer. */
export interface ComponentCache {
  readings: Map<string, Reading | null>;
  props: Map<string, PropVerdict>;
}

export function componentCache(): ComponentCache {
  return { readings: new Map(), props: new Map() };
}

/**
 * The characters Astro escapes in a value it prints, by the set a use names:
 * D14 passes Astro's own (`& < > " '`), so a slot read as a string compares to
 * what the literal handed it.
 */
export function astroEscape(text: string, set: string): string {
  return text.replace(/[&<>"'{}]/g, (c) => (set.includes(c) ? (ESCAPES[c] as string) : c));
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' };

/** The set D14's component-children rule compares through: Astro's own escape. */
const ASTRO_SET = '&<>"\'';

// --- The reading ------------------------------------------------------------

/** One `.astro` file read: its reading, or the reason every finding of it is listed. */
function readAstro(ts: typeof import('typescript'), file: string, source: string): Reading | { fault: string } {
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const page = source.slice(bom);
  let front: Reading['front'] = null;
  const fm = FRONTMATTER.exec(page);
  if (fm !== null) {
    const open = fm[0].indexOf('\n') + 1;
    // An empty body has no newline of its own after the open one: it spans nothing.
    const close = Math.max(open, fm[0].lastIndexOf('\n'));
    const sf = ts.createSourceFile(`${file}.ts`, page.slice(open, close), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (parseDiagnosticsOf(sf).length > 0) return { fault: 'front matter stet cannot read' };
    front = { open, close, sf };
  } else {
    // A fence the pattern does not take there is front matter stet would misread as markup.
    const tag = page.indexOf('<');
    if (/^---[ \t]*\r?$/m.test(tag === -1 ? page : page.slice(0, tag))) return { fault: 'front matter stet cannot read' };
  }
  const document = documentOf(file, page);
  if (document === null) return { fault: 'markup stet cannot pair' };
  const code = codeOf(ts, file, page, 'astro') as FileCode;
  const read = new Set(code.braces.map((b) => b.start));
  const braces = markupBraces(selfClosedRaw(unraw(page)), 'astro')
    .filter((b) => read.has(b.start))
    .map((b) => {
      const tree = braceTree(ts, page.slice(b.start, b.end));
      return { ...b, tree, binds: tree === null ? null : boundNames(ts, tree) };
    });
  return { file, page, bom, front, document, parents: parentsOf(document), code, blanked: blankNonMarkup(page, 'astro'), braces, raw: rawSpans(page) };
}

/**
 * The element tree of an Astro file's markup, its expressions masked and its
 * raw elements' content blank, or null where it does not pair. A component's
 * tag is read under a name no HTML element has (its first letter `z`,
 * lowercase as the tokenizer reads every name), so `<Base>`, `<Link>` or
 * `<Head>` is never a void element, a raw text element or the page's head;
 * `sourceTag` reads the name the source spells.
 */
function documentOf(file: string, page: string): Document | null {
  const markup = maskExpressions(selfClosedRaw(unraw(page)), 'astro').replace(/(<\/?)[A-Z](?=[\w:-]*)/g, '$1z');
  try {
    const document = readDocument(file, markup, 'astro');
    return document.faults.length > 0 ? null : document;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Every name a tree binds: parameters, binding elements, and variable, function and class declarations. */
function boundNames(ts: typeof import('typescript'), tree: TS.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: TS.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) for (const name of patternNames(ts, node.name)) names.add(name);
    else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name !== undefined) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names;
}

function patternNames(ts: typeof import('typescript'), name: TS.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : patternNames(ts, el.name)));
}

/** An element's tag as the source spells it: a component keeps its case. */
function sourceTag(r: Reading, el: Element): string {
  return /^<([A-Za-z][\w:.-]*)/.exec(r.page.slice(el.openStart, el.openEnd))?.[1] ?? el.tag;
}

/** The tag a place names: a component's source name, else the lowercase element. */
function placeTag(name: string): string {
  return componentName(name) ? name : name.toLowerCase();
}

/** Whether a brace binds `copy`: by its tree, or by the word where it does not parse. */
function bindsCopy(r: Reading, brace: Brace): boolean {
  return brace.binds === null ? /(?<![\w$])copy(?![\w$])/.test(r.page.slice(brace.start, brace.end)) : brace.binds.has('copy');
}

// --- The binding and the form ----------------------------------------------

interface Binding {
  binding: 'stet' | 'none';
  form: 'call' | 'property';
  insert: Edit | null;
}

/**
 * How the file reads a key: stet's `copy` and the form its own reads use, or
 * the read path's import planned where nothing binds `copy`. A reason in place
 * of the answer lists every finding of the file.
 */
function bindingOf(ts: typeof import('typescript'), cwd: string, config: StetConfig, r: Reading, source: string): Binding | { fault: string } {
  const stetModule = stetModuleTest(cwd, [config.readPath.file, ...filesForGlobs(cwd, config.copyModules)])(r.file);
  const readPath = stetModuleTest(cwd, [config.readPath.file])(r.file);
  const binding = bindingsOf(ts, `${r.file}.ts`, r.front === null ? [] : [r.front.sf.text], stetModule).get('copy');
  if (binding === 'foreign') return { fault: 'a foreign copy is bound in this file' };
  const braces = r.braces.filter((b) => !bindsCopy(r, b));
  if (binding === 'stet') {
    // The read path's `copy` is the accessor `init` scaffolds: callable only.
    const accessor = r.front !== null && r.front.sf.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        readPath(s.moduleSpecifier.text) &&
        s.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        s.importClause.namedBindings.elements.some((el) => el.name.text === 'copy' && (el.propertyName?.text ?? 'copy') === 'copy'),
    );
    const evidence = { call: false, property: false };
    const spans: Span[] = [...(r.front === null ? [] : [{ start: r.front.open, end: r.front.close }]), ...braces];
    for (const span of spans) {
      for (const m of r.page.slice(span.start, span.end).matchAll(KEY_READ)) {
        const at = span.start + m.index;
        if (within(r.code.nonCode, at) || !/^copy(?!Map)/.test(m[0]) || /[\w$.]/.test(r.page.charAt(at - 1))) continue;
        if (m[2] !== undefined || m[4] !== undefined) evidence.call = true;
        else if (m[5] !== 'get') evidence.property = true;
      }
    }
    if (accessor) return evidence.property ? { fault: CANNOT_TELL } : { binding, form: 'call', insert: null };
    if (evidence.property === evidence.call) return { fault: CANNOT_TELL };
    return { binding, form: evidence.property ? 'property' : 'call', insert: null };
  }
  // Nothing binds `copy`: an import would shadow a global the file already
  // reads, and a brace that names its own `copy` leaves the file's reading open.
  const global = (text: string): boolean => /(?<![\w$])copy(?![\w$])/.test(text);
  if (r.braces.some((b) => global(r.page.slice(b.start, b.end)))) return { fault: CANNOT_TELL };
  if (r.front !== null && refsTo(ts, r.front.sf, 'copy').length > 0) return { fault: CANNOT_TELL };
  const eol = dominantEol(source);
  const statement = `import { copy } from '${config.readPath.import}';`;
  let insert: Edit;
  if (r.front === null) {
    insert = { pos: 0, end: 0, text: `---${eol}${statement}${eol}---${eol}` };
  } else {
    const last = r.front.sf.statements.filter((s) => ts.isImportDeclaration(s)).at(-1);
    // After the comment that trails the last import, which stays on its own import.
    const after = last === undefined ? 0 : (ts.getTrailingCommentRanges(r.front.sf.text, last.end)?.at(-1)?.end ?? last.end);
    insert =
      last === undefined
        ? { pos: r.front.open, end: r.front.open, text: `${statement}${eol}` }
        : { pos: r.front.open + after, end: r.front.open + after, text: `${eol}${statement}` };
  }
  return { binding: 'none', form: 'call', insert: { ...insert, pos: insert.pos + r.bom, end: insert.end + r.bom } };
}

// --- Names and their references --------------------------------------------

/** Whether an identifier reads a binding: not a declaration's name, a property's, an attribute's or an intrinsic tag's, and not a type. */
function isReference(ts: typeof import('typescript'), id: TS.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && (p.propertyName === id || p.name === id)) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === id && /^[a-z]/.test(id.text)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  for (let a: TS.Node | undefined = p; a !== undefined; a = a.parent) {
    if (ts.isTypeNode(a) || ts.isInterfaceDeclaration(a) || ts.isTypeAliasDeclaration(a) || ts.isHeritageClause(a)) return false;
  }
  return true;
}

/** Whether a scope node binds `name` itself, so a reference beneath it reads that binding and not the one traced. */
function shadows(ts: typeof import('typescript'), node: TS.Node, name: string): boolean {
  if (ts.isFunctionLike(node)) {
    if (node.parameters.some((p) => patternNames(ts, p.name).includes(name))) return true;
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name) return true;
  }
  if (ts.isClassExpression(node) && node.name?.text === name) return true;
  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined && patternNames(ts, node.variableDeclaration.name).includes(name)) return true;
  const statements = ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) ? node.statements : ts.isCaseClause(node) || ts.isDefaultClause(node) ? node.statements : undefined;
  if (statements !== undefined) {
    for (const s of statements) {
      if (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => patternNames(ts, d.name).includes(name))) return true;
      if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) return true;
    }
  }
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
    if (node.initializer.declarations.some((d) => patternNames(ts, d.name).includes(name))) return true;
  }
  return false;
}

/** The references to `name` under `node` that read the binding `node` sees: a nested scope that binds the name again stops the walk beneath it. */
function refsTo(ts: typeof import('typescript'), node: TS.Node, name: string): TS.Identifier[] {
  const out: TS.Identifier[] = [];
  const visit = (n: TS.Node): void => {
    if (n !== node && shadows(ts, n, name)) return;
    if (ts.isIdentifier(n) && n.text === name && isReference(ts, n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

// --- Uses and the display classification -----------------------------------

/** A path step: `#i` an array index, `#?` an index stet cannot fix, `.p` a property, `[*]` every element. */
type Step = string;

interface Use {
  kind: 'display' | 'test' | 'code' | 'head';
  head?: HeadKind;
  pattern: Step[];
  /** Where a display or head use renders: its element's tag, and the attribute it fills. */
  at?: { kind: 'element' | 'attribute'; tag: string; attr?: string; metaName?: string; inSvg?: true };
  /** The brace it sits in, which names the place. */
  brace?: Brace;
}

/** The context a brace's tree is classified in: the document's elements around it, and for a tag brace the element and attribute it fills. */
interface BraceContext {
  brace: Brace;
  path: Element[];
  attr?: { el: Element; name: string; tag: string };
}

function braceContext(r: Reading, brace: Brace): BraceContext {
  const path = elementPath(r.document.roots, brace.start);
  if (!brace.inTag) return { brace, path };
  const el = path.at(-1);
  if (el === undefined || !(el.openStart < brace.start && brace.start < el.openEnd)) return { brace, path };
  const name = /([^\s"'=<>/{}]+)\s*=\s*$/.exec(r.page.slice(el.openStart, brace.start))?.[1];
  return { brace, path: path.slice(0, -1), ...(name === undefined ? {} : { attr: { el, name: name.toLowerCase(), tag: sourceTag(r, el) } }) };
}

/** Whether the document path, read outermost first, puts a run inside a `<title>` that no `<svg>` holds, inside `<head>`, or inside an `<svg>`. */
function pathHead(path: readonly { tag: string }[]): { title: boolean; head: boolean; svg: boolean } {
  let svg = false;
  let title = false;
  let head = false;
  for (const el of path) {
    if (el.tag === 'svg') svg = true;
    if (el.tag === 'title' && !svg) title = true;
    if (el.tag === 'head') head = true;
  }
  return { title, head, svg };
}

/** The JSX string attributes of an element in a tree, for `metaCopyNameOf`. */
function jsxAttrText(ts: typeof import('typescript'), owner: TS.JsxOpeningLikeElement, name: string): string | undefined {
  for (const prop of owner.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name && prop.initializer !== undefined && ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
  }
  return undefined;
}

/**
 * Where an expression sits in a brace's tree: head is read first, then display,
 * then a test; every other position is code.
 */
function classify(ts: typeof import('typescript'), r: Reading, ctx: BraceContext, node: TS.Node, pattern: Step[]): Use {
  const root = braceRoot(ts, ctx.brace.tree as TS.SourceFile);
  let n = node;
  while (n !== root && n.parent !== undefined && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  // The JSX elements around the expression, nearest first, and the document's around the brace.
  const jsx: string[] = [];
  for (let a: TS.Node | undefined = n.parent; a !== undefined; a = a.parent) {
    if (ts.isJsxElement(a)) jsx.push(a.openingElement.tagName.getText());
  }
  const around = pathHead([...ctx.path, ...[...jsx].reverse().map((tag) => ({ tag: tag.toLowerCase() }))]);
  const inner = r.page.slice(ctx.brace.start + 1, ctx.brace.end - 1);
  const content = (tag: string): Use => {
    if (around.title) return { kind: 'head', head: 'title', pattern };
    if (around.head) return { kind: 'head', head: 'other', pattern, at: { kind: 'element', tag: placeTag(tag) }, brace: ctx.brace };
    const inSvg = tag === 'title' && around.svg;
    return { kind: 'display', pattern, at: { kind: 'element', tag: placeTag(tag), ...(inSvg ? { inSvg: true as const } : {}) }, brace: ctx.brace };
  };
  const attribute = (tag: string, attr: string, meta: string | null): Use | null => {
    const intrinsic = !componentName(tag);
    if (intrinsic && attr === 'content' && tag.toLowerCase() === 'meta' && meta !== null) {
      const at = { kind: 'attribute' as const, tag: 'meta', attr: 'content', metaName: meta };
      return { kind: 'head', head: meta === 'description' ? 'description' : 'other', pattern, at, brace: ctx.brace };
    }
    if (!intrinsic || !COPY_ATTRS.has(attr) || attr === 'content') return null;
    if (around.head) return { kind: 'head', head: 'other', pattern, at: { kind: 'attribute', tag: tag.toLowerCase(), attr }, brace: ctx.brace };
    return { kind: 'display', pattern, at: { kind: 'attribute', tag: tag.toLowerCase(), attr }, brace: ctx.brace };
  };
  if (p !== undefined && ts.isJsxExpression(p) && p.dotDotDotToken === undefined && (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))) {
    return content(jsx[0] ?? (ctx.path.at(-1)?.tag ?? ''));
  }
  if (n === root && !ctx.brace.inTag) return content(ctx.path.at(-1) === undefined ? '' : sourceTag(r, ctx.path.at(-1) as Element));
  if (n === root && ctx.brace.inTag && !/^\s*\.\.\./.test(inner) && ctx.attr !== undefined) {
    const el = ctx.attr.el;
    const used = attribute(ctx.attr.tag, ctx.attr.name, metaCopyNameOf(el.tag, (name) => attrOf(el, name)));
    if (used !== null) return used;
  }
  if (p !== undefined && ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) {
    const owner = p.parent.parent.parent;
    const tag = owner.tagName.getText();
    const used = attribute(tag, p.parent.name.getText().toLowerCase(), metaCopyNameOf(tag.toLowerCase(), (name) => jsxAttrText(ts, owner, name)));
    if (used !== null) return used;
  }
  if (p !== undefined) {
    if (ts.isBinaryExpression(p) && p.left === n) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return { kind: 'test', pattern };
    }
    if (ts.isConditionalExpression(p) && p.condition === n) return { kind: 'test', pattern };
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return { kind: 'test', pattern };
  }
  return { kind: 'code', pattern };
}

/**
 * The uses of one reference: a property or numeric element access extends its
 * pattern, a `.map(cb)` traces on into the callback with `[*]`, a method call
 * or any other element access is a code use of the pattern so far, and the
 * chain's end is classified where it sits.
 */
function traceRef(ts: typeof import('typescript'), r: Reading, ctx: BraceContext, id: TS.Node, start: Step[], uses: Use[]): void {
  const root = braceRoot(ts, ctx.brace.tree as TS.SourceFile);
  let node: TS.Node = id;
  let pattern = start;
  for (;;) {
    const parent = node.parent;
    if (parent === undefined || node === root) break;
    if (ts.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const call = parent.parent;
      if (call !== undefined && ts.isCallExpression(call) && call.expression === parent) {
        const cb = call.arguments[0];
        if (parent.name.text === 'map' && cb !== undefined && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          traceCallback(ts, r, ctx, cb, [...pattern, '[*]'], uses);
          return;
        }
        uses.push({ kind: 'code', pattern });
        return;
      }
      pattern = [...pattern, `.${parent.name.text}`];
      node = parent;
      continue;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      if (ts.isNumericLiteral(parent.argumentExpression)) {
        pattern = [...pattern, `#${parent.argumentExpression.text}`];
        node = parent;
        continue;
      }
      uses.push({ kind: 'code', pattern });
      return;
    }
    break;
  }
  uses.push(classify(ts, r, ctx, node, pattern));
}

/** A callback traced with its first parameter bound to `pattern`; the index binds nothing. */
function traceCallback(ts: typeof import('typescript'), r: Reading, ctx: BraceContext, cb: TS.ArrowFunction | TS.FunctionExpression, pattern: Step[], uses: Use[]): void {
  const first = cb.parameters[0];
  if (first === undefined) return;
  if (first.initializer !== undefined || first.dotDotDotToken !== undefined) {
    uses.push({ kind: 'code', pattern });
    return;
  }
  for (const [name, bound] of patternBindings(ts, first.name, pattern, uses)) {
    for (const ref of refsTo(ts, cb, name)) traceRef(ts, r, ctx, ref, bound, uses);
  }
}

/** The names a binding pattern binds, each with its pattern; a rest element or a default value is a code use of its pattern. */
function patternBindings(ts: typeof import('typescript'), name: TS.BindingName, pattern: Step[], uses: Use[]): Array<[string, Step[]]> {
  if (ts.isIdentifier(name)) return [[name.text, pattern]];
  const out: Array<[string, Step[]]> = [];
  if (ts.isArrayBindingPattern(name)) {
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      if (el.dotDotDotToken !== undefined) {
        uses.push({ kind: 'code', pattern });
        return;
      }
      const at = [...pattern, `#${i}`];
      if (el.initializer !== undefined) uses.push({ kind: 'code', pattern: at });
      else out.push(...patternBindings(ts, el.name, at, uses));
    });
    return out;
  }
  for (const el of name.elements) {
    if (el.dotDotDotToken !== undefined) {
      uses.push({ kind: 'code', pattern });
      continue;
    }
    const key = el.propertyName ?? el.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) {
      uses.push({ kind: 'code', pattern });
      continue;
    }
    const at = [...pattern, `.${key.text}`];
    if (el.initializer !== undefined) uses.push({ kind: 'code', pattern: at });
    else out.push(...patternBindings(ts, el.name, at, uses));
  }
  return out;
}

/** Whether a use's pattern step matches a literal's path step: `[*]` any index, `#?` any index in the code test. */
function stepMatches(pattern: Step, path: Step, code: boolean): boolean {
  if (pattern === path) return true;
  if (pattern === '[*]') return path.startsWith('#');
  return code && path === '#?' && pattern.startsWith('#');
}

/** Whether a display use names the whole path. */
function wholeMatch(pattern: Step[], path: Step[]): boolean {
  return pattern.length === path.length && pattern.every((step, i) => stepMatches(step, path[i] as Step, false));
}

/** Whether a code or head use reaches the path: one is a prefix of the other. */
function reaches(pattern: Step[], path: Step[]): boolean {
  const n = Math.min(pattern.length, path.length);
  for (let i = 0; i < n; i++) if (!stepMatches(pattern[i] as Step, path[i] as Step, true)) return false;
  return true;
}

// --- The one-hop component read --------------------------------------------

/** What a component makes of one prop: shown, shown in its head, both, or a reason it is listed. */
type PropVerdict = { kind: 'display' } | { kind: 'head'; head: HeadKind } | { kind: 'skip'; reason: string };

/** The `.astro` file a component tag resolves to, one hop through the front matter's default import, or null. */
function componentFile(ts: typeof import('typescript'), cwd: string, r: Reading, tag: string): string | null {
  if (r.front === null || tag.includes('.')) return null;
  for (const s of r.front.sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.importClause?.name?.text !== tag) continue;
    for (const candidate of resolveSpecifier(s.moduleSpecifier.text, r.file, cwd, pathAliasMappings(cwd))) {
      if (candidate.endsWith('.astro') && existsSync(candidate)) return relative(cwd, candidate).split(sep).join('/');
    }
    return null;
  }
  return null;
}

function readComponent(ts: typeof import('typescript'), cwd: string, file: string, cache: ComponentCache): Reading | null {
  if (cache.readings.has(file)) return cache.readings.get(file) as Reading | null;
  let reading: Reading | null = null;
  try {
    const read = readAstro(ts, file, readFileSync(join(cwd, file), 'utf8'));
    reading = 'fault' in read ? null : read;
  } catch {
    reading = null;
  }
  cache.readings.set(file, reading);
  return reading;
}

/**
 * One prop of an `.astro` component, read where the component destructures it
 * from `Astro.props` by name: each use of its local name classified, the front
 * matter's other references and a client script's mentions being code.
 */
function propVerdict(ts: typeof import('typescript'), cwd: string, file: string, prop: string, cache: ComponentCache): PropVerdict {
  const id = `${file}\u0000${prop}`;
  const cached = cache.props.get(id);
  if (cached !== undefined) return cached;
  const verdict = readProp(ts, readComponent(ts, cwd, file, cache), prop);
  cache.props.set(id, verdict);
  return verdict;
}

function readProp(ts: typeof import('typescript'), c: Reading | null, prop: string): PropVerdict {
  const unfollowed: PropVerdict = { kind: 'skip', reason: UNFOLLOWED };
  if (c === null || c.front === null) return unfollowed;
  const sf = c.front.sf;
  // Every `Astro.props` is a destructuring, or the props reach code stet cannot follow.
  let local: string | undefined;
  let other = false;
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Astro' && node.name.text === 'props') {
      let up: TS.Node = node.parent;
      while (ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isSatisfiesExpression(up)) up = up.parent;
      if (ts.isVariableDeclaration(up) && ts.isObjectBindingPattern(up.name)) {
        for (const el of up.name.elements) {
          const key = el.propertyName ?? el.name;
          if (el.dotDotDotToken === undefined && ts.isIdentifier(key) && key.text === prop && ts.isIdentifier(el.name)) local = el.name.text;
        }
      } else {
        other = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const markupCode = [...c.braces, ...c.code.regions.filter((s) => s.own === true)];
  if (other || markupCode.some((s) => /\bAstro\s*\.\s*props\b/.test(c.page.slice(s.start, s.end)))) return unfollowed;
  if (local === undefined) return unfollowed;
  const name = local;
  const uses: Use[] = [];
  if (refsTo(ts, sf, name).length > 0) uses.push({ kind: 'code', pattern: [] });
  for (const script of c.code.regions.filter((s) => s.own === true)) {
    if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(script.text)) uses.push({ kind: 'code', pattern: [] });
  }
  for (const brace of c.braces) {
    const text = c.page.slice(brace.start, brace.end);
    if (!new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(text)) continue;
    if (brace.tree === null) {
      uses.push({ kind: 'code', pattern: [] });
      continue;
    }
    const ctx = braceContext(c, brace);
    const root = braceRoot(ts, brace.tree);
    for (const ref of refsTo(ts, brace.tree, name)) {
      // A tag brace hands the value to its attribute whole, or to code.
      if (brace.inTag && ref !== root) uses.push({ kind: 'code', pattern: [] });
      else uses.push(classify(ts, c, ctx, ref, []));
    }
  }
  return verdictOf(uses.filter((u) => u.kind !== 'test'));
}

/** A value's verdict from its non-test uses: code lists it, a head use beside a display lists it, a head use alone takes its kind, a display alone rewrites it. */
function verdictOf(uses: Use[]): PropVerdict {
  if (uses.some((u) => u.kind === 'code')) return { kind: 'skip', reason: IN_CODE };
  const display = uses.some((u) => u.kind === 'display');
  const heads = uses.filter((u) => u.kind === 'head');
  if (display && heads.length > 0) return { kind: 'skip', reason: MIXED };
  if (heads.length > 0) {
    const kinds = new Set(heads.map((u) => u.head));
    return { kind: 'head', head: kinds.has('title') ? 'title' : kinds.has('description') ? 'description' : 'other' };
  }
  return display ? { kind: 'display' } : { kind: 'skip', reason: UNFOLLOWED };
}

/** Where a component renders the slot `name`: inside its `<title>`, its `<head>`, its body, or null where it holds no such slot. */
function slotSite(c: Reading, name: string): 'title' | 'head' | 'body' | null {
  // A `<title>`'s content is raw text to the tokenizer, so a slot there is read from the text.
  const named = new RegExp(`<slot\\b[^>]*\\bname\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
  const walk = (els: readonly Element[], path: Element[]): 'title' | 'head' | 'body' | null => {
    for (const el of els) {
      const at = [...path, el];
      if (el.tag === 'title' && !pathHead(path).svg && named.test(c.page.slice(el.contentStart, el.contentEnd))) return 'title';
      if (el.tag === 'slot' && attrOf(el, 'name') === name) {
        const head = pathHead(at);
        return head.title ? 'title' : head.head ? 'head' : 'body';
      }
      const found = walk(el.children, at);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(c.document.roots, []);
}

// --- The plan ---------------------------------------------------------------

/** One rewrite the file's structure proves safe, or the reason a run there is refused. */
interface Candidate {
  /** Where scan reports it, and the texts it may report there. */
  scanPos: number;
  scanTexts: string[];
  /** The replaced span. */
  pos: number;
  end: number;
  seed: string;
  context: 'astro-text' | 'astro-attr' | 'astro-data';
  at: { kind: 'element' | 'attribute'; tag: string; attr?: string; metaName?: string; inSvg?: true };
  /** The document element its name is read from. */
  el: Element | undefined;
  inHead?: true;
}

/**
 * The file's literals and its plan: every candidate its structure proves safe,
 * kept only where scan reported a finding at the same position with the same
 * text, named as the JSX walk names its literals; every other finding listed
 * with the rule that refused it.
 */
export function planAstroFile(input: {
  ts: typeof import('typescript');
  cwd: string;
  config: StetConfig;
  file: string;
  source: string;
  page: string | undefined;
  cache?: ComponentCache;
}): { literals: LocatedLiteral[]; plan: AstroPlan } {
  const { ts, cwd, config, file, source, page } = input;
  const cache = input.cache ?? componentCache();
  const found = astroFindings(ts, file, source);
  const findings: DialectFinding[] = [...found.markup, ...(found.data ?? [])].sort((a, b) => a.pos - b.pos);
  const plan: AstroPlan = { form: 'call', insert: null, richInsert: null, skips: [], structured: [] };
  const listAll = (reason: string): { literals: LocatedLiteral[]; plan: AstroPlan } => {
    plan.skips = findings.map((f) => ({ pos: f.pos, text: f.text, reason }));
    return { literals: [], plan };
  };
  try {
    const read = readAstro(ts, file, source);
    if ('fault' in read) return listAll(read.fault);
    const r = read;
    plan.structured = structuredData(r);
    const bound = bindingOf(ts, cwd, config, r, source);
    if ('fault' in bound) return listAll(bound.fault);
    plan.form = bound.form;
    plan.insert = bound.insert;

    const candidates: Candidate[] = [];
    const refusals: Array<{ start: number; end: number; reason: string }> = [];
    const refuse = (start: number, end: number, reason: string): void => {
      refusals.push({ start, end: Math.max(end, start + 1), reason });
    };
    const context: Context = { ts, cwd, r, page, cache, preserved: preservesWhiteSpace(cwd, r), candidates, refuse };
    textCandidates(context);
    attributeCandidates(context);
    braceTextCandidates(context);
    dataCandidates(context, found.data ?? []);

    // The cross-check: a candidate counts only where scan reported it.
    const byPos = new Map(candidates.map((c) => [c.scanPos, c]));
    const kept: Candidate[] = [];
    for (const finding of findings) {
      const at = finding.pos - r.bom;
      const candidate = byPos.get(at);
      if (candidate !== undefined && candidate.scanTexts.includes(finding.text)) {
        if (!kept.includes(candidate)) kept.push(candidate);
        continue;
      }
      const refusal = refusals.filter((x) => x.start <= at && at < x.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      const opaque = r.document.opaque.find((o) => o.start <= at && at < o.end);
      const raw = within(r.raw, at);
      const reason = refusal?.reason ?? (opaque !== undefined ? `inside <${opaque.tag}>` : raw ? 'inside an element with is:raw' : UNPLACED);
      plan.skips.push({ pos: finding.pos, text: finding.text, reason });
    }

    // The names: html-host's section word and item over the element enclosing each literal, the role from its place.
    const lineAt = lineIndex(source);
    const items = htmlItems(r.parents, new Set(candidates.flatMap((c) => (c.el === undefined ? [] : [c.el]))));
    const literals: LocatedLiteral[] = kept.map((c) => {
      const line = lineAt(c.pos + r.bom);
      const place = placeOf({ file, line, ...c.at });
      const head = isHeadKind(place) || c.inHead === true;
      const naming = c.el === undefined ? { sectionWord: null, role: roleOf(place) } : namingOf(c.el, r.parents, items, place);
      const proposedKey = baseName({
        ...(page === undefined ? {} : { page }),
        ...(head ? {} : { section: naming.sectionWord }),
        ...(naming.item === undefined ? {} : { item: naming.item }),
        role: naming.role,
      });
      return {
        file,
        pos: c.pos + r.bom,
        end: c.end + r.bom,
        raw: source.slice(c.pos + r.bom, c.end + r.bom),
        text: c.seed,
        context: c.context,
        shape: 'astro' as const,
        proposedKey,
        place,
        sectionWord: naming.sectionWord,
        ...(naming.item === undefined ? {} : { item: naming.item }),
        enclosingBodyPos: null,
        copyBinding: bound.binding,
        accessorImported: bound.binding === 'stet',
        importInsertPos: bound.insert?.pos ?? 0,
        ...(c.inHead === true ? { inHead: true as const } : {}),
      };
    });
    plan.skips.sort((a, b) => a.pos - b.pos);
    return { literals, plan };
  } catch (error) {
    // A document nested past the stack is listed whole, as one that does not pair.
    if (!(error instanceof RangeError)) throw error;
    Object.assign(plan, { form: 'call', insert: null, richInsert: null, structured: [] });
    return listAll('markup stet cannot pair');
  }
}

/** What every candidate builder reads. */
interface Context {
  ts: typeof import('typescript');
  cwd: string;
  r: Reading;
  page: string | undefined;
  cache: ComponentCache;
  /** Whether the file shows white space as written somewhere. */
  preserved: boolean;
  candidates: Candidate[];
  refuse: (start: number, end: number, reason: string) => void;
}

/**
 * Whether the file shows preserved white space: a rule in its own source (a
 * `<style>` body, a `style` attribute or object), or in a stylesheet its front
 * matter imports by a relative specifier.
 */
function preservesWhiteSpace(cwd: string, r: Reading): boolean {
  if (PRESERVED.test(r.page)) return true;
  if (r.front === null) return false;
  for (const m of r.front.sf.text.matchAll(/\bimport\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    try {
      if (PRESERVED.test(readFileSync(join(cwd, dirname(r.file), m[1] as string), 'utf8'))) return true;
    } catch {
      // A stylesheet that does not read shows nothing stet can check.
    }
  }
  return false;
}

/** Each `application/ld+json` script's open tag, outside comments and the front matter. */
function structuredData(r: Reading): number[] {
  const out: number[] = [];
  for (const m of r.page.matchAll(/<script\b[^>]*>/gi)) {
    if (/\btype\s*=\s*["']?application\/ld\+json\b/i.test(m[0]) && !inComment(r, m.index)) out.push(m.index + r.bom);
  }
  return out;
}

function inComment(r: Reading, at: number): boolean {
  if (r.front !== null && at < r.front.close) return true;
  for (const m of r.page.matchAll(/<!--[\s\S]*?-->/g)) if (m.index <= at && at < m.index + m[0].length) return true;
  return false;
}

/** The reason an entity refuses a value: one the table cannot decode, or a legacy form with no semicolon the browser decodes and stet would not. */
function entityReason(raw: string): string | undefined {
  const unknown = undecodedEntity(raw);
  if (unknown !== undefined) return `an entity stet cannot read: ${unknown}`;
  for (const m of raw.matchAll(/&(?=[#0-9A-Za-z])/g)) {
    const whole = /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/.exec(raw.slice(m.index));
    if (whole === null || decodeEntities(whole[0]) === whole[0]) return `an entity stet cannot read: ${raw.slice(m.index, m.index + 8)}`;
  }
  return undefined;
}

/** The ASCII white space a run is trimmed of. */
const LEAD = /^[ \t\n\r\f]*/;
const TRAIL = /[ \t\n\r\f]*$/;
/** White space a preserving rule shows: a line break, a tab, two spaces. */
const SHOWN_SPACE = /[\t\n\r\f]| {2}/;

/**
 * The page's own title or description: listed for `stet pages scan` where it
 * binds the field, else naming the shape it cannot bind.
 */
function pageField(ctx: Context, field: 'title' | 'description', shape: string | null): string {
  if (shape === null && ctx.page !== undefined) return PAGES_SCAN;
  const why = shape ?? (ctx.r.file.startsWith('src/pages/') ? UNFOLLOWED : 'set in a layout every page shares');
  return `a page ${field} stet pages scan cannot bind: ${why}`;
}

/** An element around a run, as the run's rules read it: its source tag and its attributes. */
interface Around {
  name: string;
  attrs: Element['attrs'];
}

/** The rules every text run passes, in order, past the run's own: the element, a named slot, a component's children, entities, spacing. */
function runRules(ctx: Context, path: readonly Around[], raw: string, bordering: string): string | null {
  const { r } = ctx;
  const nearest = (path.at(-1) as Around).name;
  for (const el of path) {
    if (SKIP_TAGS.has(el.name) && !(el.name === 'svg' && nearest === 'title')) return `inside <${el.name}>`;
    const rawAttr = RAW_ATTRS.find((a) => el.attrs.some((x) => x.name === a));
    if (rawAttr !== undefined) return `inside an element with ${rawAttr}`;
  }
  // A named slot is followed one hop to the component it fills.
  for (let i = path.length - 1; i >= 1; i--) {
    const slot = (path[i] as Around).attrs.find((a) => a.name === 'slot' && a.quoted);
    if (slot === undefined) continue;
    const parent = (path[i - 1] as Around).name;
    if (!componentName(parent)) break;
    const target = componentFile(ctx.ts, ctx.cwd, r, parent);
    const c = target === null ? null : readComponent(ctx.ts, ctx.cwd, target, ctx.cache);
    const site = c === null ? null : slotSite(c, slot.value);
    if (site === 'title') return pageField(ctx, 'title', UNFOLLOWED);
    if (site !== 'body') return UNFOLLOWED;
    break;
  }
  if (componentName(nearest) && astroEscape(textOf(raw), ASTRO_SET) !== raw) {
    // A component that reads its slot as a string would receive the escaped value.
    const target = componentFile(ctx.ts, ctx.cwd, r, nearest);
    const c = target === null ? null : readComponent(ctx.ts, ctx.cwd, target, ctx.cache);
    if (c === null || /Astro\s*\.\s*slots\s*\.\s*render/.test(c.page)) return UNFOLLOWED;
  }
  const entity = entityReason(raw);
  if (entity !== undefined) return entity;
  if (ctx.preserved && (SHOWN_SPACE.test(raw) || SHOWN_SPACE.test(bordering))) return 'spacing the page may show';
  return null;
}

/** The text runs of the document's elements, depth-first; an opaque element is never entered. */
function textCandidates(ctx: Context): void {
  const { r } = ctx;
  const firstTitle = firstOf(r, (el, path) => el.tag === 'title' && !pathHead(path).svg);
  const visit = (el: Element, path: Element[]): void => {
    for (const segment of el.segments) {
      if ('tag' in segment) {
        visit(segment, [...path, segment]);
        continue;
      }
      const lead = (LEAD.exec(segment.text)?.[0] ?? '').length;
      const trail = (TRAIL.exec(segment.text)?.[0] ?? '').length;
      const start = segment.start + lead;
      const end = segment.end - trail;
      if (end <= start) continue;
      const masked = segment.text.slice(lead, segment.text.length - trail);
      const raw = r.page.slice(start, end);
      if (!qualifiesAsCopy(raw)) continue;
      const head = pathHead(path);
      const nearest = path.at(-1) as Element;
      if (head.title) {
        // The page's own title is pages scan's to bind.
        const shape = masked.includes('{')
          ? 'written as an expression'
          : (entityReason(raw) ?? (masked.includes('\0') || nearest !== firstTitle || el.segments.length !== 1 ? UNFOLLOWED : null));
        ctx.refuse(start, end, pageField(ctx, 'title', shape));
        continue;
      }
      if (masked.includes('{')) {
        ctx.refuse(start, end, BESIDE);
        continue;
      }
      if (masked.includes('\0')) {
        ctx.refuse(start, end, UNPLACED);
        continue;
      }
      const bordering = segment.text.slice(0, lead) + segment.text.slice(segment.text.length - trail);
      const tag = sourceTag(r, nearest);
      const why = runRules(ctx, path.map((e) => ({ name: sourceTag(r, e), attrs: e.attrs })), raw, bordering);
      if (why !== null) {
        ctx.refuse(start, end, why);
        continue;
      }
      ctx.candidates.push({
        scanPos: start,
        scanTexts: [raw, collapseWhitespace(decodeEntities(raw))],
        pos: start,
        end,
        seed: textOf(raw),
        context: 'astro-text',
        at: { kind: 'element', tag: placeTag(tag), ...(nearest.tag === 'title' && head.svg ? { inSvg: true as const } : {}) },
        el: nearest,
        ...(head.head ? { inHead: true as const } : {}),
      });
    }
  };
  for (const root of r.document.roots) visit(root, [root]);
}

/** The first element of the document, depth-first, that `test` accepts. */
function firstOf(r: Reading, test: (el: Element, path: Element[]) => boolean): Element | undefined {
  const walk = (els: readonly Element[], path: Element[]): Element | undefined => {
    for (const el of els) {
      const at = [...path, el];
      if (test(el, at)) return el;
      const found = walk(el.children, at);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(r.document.roots, []);
}

/** Each quoted copy attribute of an HTML element, each prose prop of a component, and each copy `<meta>`'s `content`. */
function attributeCandidates(ctx: Context): void {
  const { ts, r } = ctx;
  const firstDescription = firstOf(r, (el) => el.tag === 'meta' && attrOf(el, 'name') === 'description');
  const visit = (el: Element, path: Element[]): void => {
    const tag = sourceTag(r, el);
    const component = componentName(tag);
    const head = pathHead(path).head;
    for (const attr of el.attrs) {
      if (!attr.quoted) continue;
      const value = r.page.slice(attr.valueStart, attr.valueEnd);
      const scanText = collapseWhitespace(decodeEntities(value));
      if (scanText === '') continue;
      const start = attr.valueStart;
      const span = { scanPos: start, scanTexts: [scanText], pos: start - 1, end: attr.valueEnd + 1, context: 'astro-attr' as const, el };
      if (attr.name === 'content' && !component) {
        const meta = metaCopyNameOf(el.tag, (name) => attrOf(el, name));
        if (meta === null) continue;
        const entity = entityReason(value);
        if (meta === 'description') {
          ctx.refuse(start, attr.valueEnd, pageField(ctx, 'description', entity ?? (el === firstDescription ? null : UNFOLLOWED)));
          continue;
        }
        if (entity !== undefined) {
          ctx.refuse(start, attr.valueEnd, entity);
          continue;
        }
        ctx.candidates.push({ ...span, seed: decodeEntities(value), at: { kind: 'attribute', tag: 'meta', attr: 'content', metaName: meta }, inHead: true });
        continue;
      }
      if (!component) {
        if (!COPY_ATTRS.has(attr.name) || (attr.name === 'alt' && value === '')) continue;
        const entity = entityReason(value);
        if (entity !== undefined) {
          ctx.refuse(start, attr.valueEnd, entity);
          continue;
        }
        ctx.candidates.push({ ...span, seed: decodeEntities(value), at: { kind: 'attribute', tag: el.tag, attr: attr.name }, ...(head ? { inHead: true as const } : {}) });
        continue;
      }
      if (!COPY_ATTRS.has(attr.name) && !componentProse(attr.name, scanText)) continue;
      if (nonCopyProp(attr.name)) {
        ctx.refuse(start, attr.valueEnd, 'a prop stet does not rewrite');
        continue;
      }
      // The prop's name as the component destructures it: the source's spelling.
      const prop = r.page.slice(attr.start, attr.start + attr.name.length);
      const target = componentFile(ts, ctx.cwd, r, tag);
      const verdict: PropVerdict = target === null ? { kind: 'skip', reason: UNFOLLOWED } : propVerdict(ts, ctx.cwd, target, prop, ctx.cache);
      if (verdict.kind === 'skip') {
        ctx.refuse(start, attr.valueEnd, verdict.reason);
        continue;
      }
      if (verdict.kind === 'head' && verdict.head !== 'other') {
        // A layout prop that reaches the page's title or description: pages scan binds it from a page with none of its own.
        const own = verdict.head === 'title' ? firstOf(r, (e, p) => e.tag === 'title' && !pathHead(p).svg) : firstDescription;
        ctx.refuse(start, attr.valueEnd, pageField(ctx, verdict.head, own === undefined ? null : UNFOLLOWED));
        continue;
      }
      ctx.candidates.push({
        ...span,
        seed: value,
        at: { kind: 'attribute', tag, attr: prop },
        ...(verdict.kind === 'head' || head ? { inHead: true as const } : {}),
      });
    }
    for (const child of el.children) visit(child, [...path, child]);
  };
  for (const root of r.document.roots) visit(root, [root]);
}

/** The words that are the whole content of one element inside a content brace (`{flag && <a href="/x">Changelog</a>}`), and the copy attributes of its HTML tags. */
function braceTextCandidates(ctx: Context): void {
  const { ts, r } = ctx;
  for (const brace of r.braces) {
    if (brace.inTag) continue;
    const base = brace.start + 1;
    const inside = r.blanked.slice(base, brace.end - 1);
    if (!/<[A-Za-z]/.test(inside)) continue;
    const tags = markupTags(inside);
    const path = elementPath(r.document.roots, brace.start);
    for (const open of tags) {
      if (open.close || componentName(open.name)) continue;
      for (const attr of openTagAttrs(inside, open, base)) {
        if (!attr.quoted || !COPY_ATTRS.has(attr.name)) continue;
        const value = r.page.slice(attr.valueStart, attr.valueEnd);
        const scanText = collapseWhitespace(decodeEntities(value));
        if (scanText === '') continue;
        const entity = bindsCopy(r, brace) ? REBOUND : entityReason(value);
        if (entity !== undefined) {
          ctx.refuse(attr.valueStart, attr.valueEnd, entity);
          continue;
        }
        const tag = open.name.toLowerCase();
        ctx.candidates.push({
          scanPos: attr.valueStart,
          scanTexts: [scanText],
          pos: attr.valueStart - 1,
          end: attr.valueEnd + 1,
          seed: decodeEntities(value),
          context: 'astro-attr',
          at: { kind: 'attribute', tag, attr: attr.name },
          el: path.at(-1),
          ...(pathHead([...path, { tag }]).head ? { inHead: true as const } : {}),
        });
      }
    }
    for (let k = 0; k + 1 < tags.length; k++) {
      const open = tags[k] as MarkupTag;
      const close = tags[k + 1] as MarkupTag;
      const run = inside.slice(open.end, close.start);
      const lead = (LEAD.exec(run)?.[0] ?? '').length;
      const trail = (TRAIL.exec(run)?.[0] ?? '').length;
      if (lead === run.length || run.includes('\0')) continue;
      const start = base + open.end + lead;
      const end = base + close.start - trail;
      const raw = r.page.slice(start, end);
      if (!qualifiesAsCopy(raw)) continue;
      if (bindsCopy(r, brace)) {
        ctx.refuse(start, end, REBOUND);
        continue;
      }
      // The run is the whole content of one element: the tags around it open and close it, and the tree agrees.
      // An inline element whose parent holds words of its own is a piece of a sentence.
      const whole =
        !open.close && !open.selfClosing && close.close && open.name === close.name && brace.tree !== null ? holdsOnly(ts, brace.tree, open.name, run) : null;
      if (whole === null || (INLINE.has(open.name) && whole.inSentence)) {
        ctx.refuse(start, end, 'a sentence with markup inside an expression');
        continue;
      }
      const attrs = readAttrs(inside, open.start + 1 + open.name.length, inside.slice(open.start + 1 + open.name.length, open.end - 1));
      const head = pathHead([...path, { tag: open.name.toLowerCase() }]);
      if (head.title) {
        ctx.refuse(start, end, pageField(ctx, 'title', 'written as an expression'));
        continue;
      }
      const around = [...path.map((e) => ({ name: sourceTag(r, e), attrs: e.attrs })), { name: open.name, attrs }];
      const why = runRules(ctx, around, raw, run.slice(0, lead) + run.slice(run.length - trail));
      if (why !== null) {
        ctx.refuse(start, end, why);
        continue;
      }
      ctx.candidates.push({
        scanPos: start,
        scanTexts: [raw, collapseWhitespace(decodeEntities(raw))],
        pos: start,
        end,
        seed: textOf(raw),
        context: 'astro-text',
        at: { kind: 'element', tag: placeTag(open.name) },
        el: path.at(-1),
        ...(head.head ? { inHead: true as const } : {}),
      });
    }
  }
}

/**
 * Whether a brace's tree holds an element `tag` whose one child is the text
 * `run`, as written, and whether its parent element holds words of its own;
 * null where it holds no such element.
 */
function holdsOnly(ts: typeof import('typescript'), tree: TS.SourceFile, tag: string, run: string): { inSentence: boolean } | null {
  let found: { inSentence: boolean } | null = null;
  const visit = (node: TS.Node): void => {
    if (found !== null) return;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === tag) {
      const only = node.children[0];
      if (node.children.length === 1 && only !== undefined && ts.isJsxText(only) && only.text === run) {
        const parent = node.parent;
        const words = ts.isJsxElement(parent) && parent.children.some((c) => ts.isJsxText(c) && /[\p{L}\p{N}]/u.test(decodeEntities(c.text)));
        found = { inSentence: words };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/**
 * The front matter's data strings scan reported, each rewritten where every use
 * of its const is traced through content braces to a display position.
 */
function dataCandidates(ctx: Context, data: DialectFinding[]): void {
  const { ts, r } = ctx;
  if (r.front === null || data.length === 0) return;
  const front = r.front;
  const sf = front.sf;
  const verdicts = new Map<string, { reason: string } | { uses: Use[] }>();
  for (const finding of data) {
    const at = finding.pos - r.bom - front.open;
    const literal = literalAt(ts, sf, at);
    const start = finding.pos - r.bom;
    if (literal === null) {
      ctx.refuse(start, start + 1, UNPLACED);
      continue;
    }
    const end = front.open + literal.end;
    const declared = constOf(ts, literal);
    if (declared === null) {
      ctx.refuse(start, end, IN_CODE);
      continue;
    }
    const name = declared.name.text;
    let verdict = verdicts.get(name);
    if (verdict === undefined) {
      verdict = constUses(ctx, declared);
      verdicts.set(name, verdict);
    }
    if ('reason' in verdict) {
      ctx.refuse(start, end, verdict.reason);
      continue;
    }
    const path = literalPath(ts, literal, declared.initializer as TS.Expression);
    const uses = verdict.uses;
    if (uses.some((u) => u.kind === 'code' && reaches(u.pattern, path))) {
      ctx.refuse(start, end, IN_CODE);
      continue;
    }
    const heads = uses.filter((u) => u.kind === 'head' && reaches(u.pattern, path));
    const shown = uses.filter((u) => u.kind === 'display' && wholeMatch(u.pattern, path));
    if (heads.length > 0 && shown.length > 0) {
      ctx.refuse(start, end, MIXED);
      continue;
    }
    if (heads.some((u) => u.head !== 'other')) {
      const field = heads.some((u) => u.head === 'title') ? 'title' : 'description';
      ctx.refuse(start, end, pageField(ctx, field, ctx.page === undefined ? null : 'written as an expression'));
      continue;
    }
    const first = shown[0] ?? heads[0];
    if (first === undefined) {
      ctx.refuse(start, end, UNFOLLOWED);
      continue;
    }
    ctx.candidates.push({
      scanPos: start,
      scanTexts: [finding.text],
      pos: start,
      end,
      seed: finding.text,
      context: 'astro-data',
      at: first.at ?? { kind: 'element', tag: 'meta' },
      el: first.brace === undefined ? undefined : elementPath(r.document.roots, first.brace.start).at(-1),
      ...(shown.length === 0 ? { inHead: true as const } : {}),
    });
  }
}

/** The string literal starting at `at` in the front matter's tree. */
function literalAt(ts: typeof import('typescript'), sf: TS.SourceFile, at: number): TS.StringLiteral | TS.NoSubstitutionTemplateLiteral | null {
  let found: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral | null = null;
  const visit = (node: TS.Node): void => {
    if (found !== null || node.end <= at || node.getStart(sf) > at) return;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.getStart(sf) === at) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The top-level `const` declaration holding a literal, or null where it is not one plain `const`. */
function constOf(ts: typeof import('typescript'), node: TS.Node): (TS.VariableDeclaration & { name: TS.Identifier }) | null {
  let n: TS.Node = node;
  while (n.parent !== undefined && !ts.isVariableDeclaration(n)) n = n.parent;
  if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.initializer === undefined) return null;
  const list = n.parent;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  return n as TS.VariableDeclaration & { name: TS.Identifier };
}

/** A data literal's path from its const's initializer: `#i`, `#?` at or after a spread, `.p`. */
function literalPath(ts: typeof import('typescript'), literal: TS.Node, init: TS.Expression): Step[] {
  const steps: Step[] = [];
  let node: TS.Node = literal;
  while (node !== init && node.parent !== undefined) {
    const parent: TS.Node = node.parent;
    if (ts.isArrayLiteralExpression(parent)) {
      const i = parent.elements.indexOf(node as TS.Expression);
      const spread = parent.elements.slice(0, i + 1).some((e) => ts.isSpreadElement(e)) || spreadArray(ts, parent);
      if (!ts.isSpreadElement(node)) steps.unshift(spread ? '#?' : `#${i}`);
    } else if (ts.isPropertyAssignment(parent)) {
      const key = parent.name;
      steps.unshift(`.${ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : '?'}`);
    }
    node = parent;
  }
  return steps;
}

/** Whether an array is a spread's: its elements are another array's, at an index stet cannot fix. */
function spreadArray(ts: typeof import('typescript'), array: TS.Node): boolean {
  let n: TS.Node = array;
  while (n.parent !== undefined && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isSatisfiesExpression(n.parent) || ts.isConditionalExpression(n.parent))) n = n.parent;
  return n.parent !== undefined && ts.isSpreadElement(n.parent);
}

/**
 * A const's uses: refused whole where it is exported, typed by `as const` or
 * `satisfies`, named again in the front matter, or met in code outside a
 * content brace; else every use its content braces trace.
 */
function constUses(ctx: Context, declared: TS.VariableDeclaration & { name: TS.Identifier }): { reason: string } | { uses: Use[] } {
  const { ts, r } = ctx;
  const sf = (r.front as NonNullable<Reading['front']>).sf;
  const name = declared.name.text;
  const statement = declared.parent.parent as TS.VariableStatement;
  if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return { reason: IN_CODE };
  let init = declared.initializer as TS.Expression;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) return { reason: IN_CODE };
  let named = false;
  const visit = (node: TS.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== declared.name) named = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (named) return { reason: IN_CODE };
  const word = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
  const uses: Use[] = [];
  // Only braces and client scripts evaluate markup's code: a tag's other text is attribute names.
  for (const script of r.code.regions.filter((s) => s.own === true)) if ([...script.text.matchAll(word)].length > 0) return { reason: IN_CODE };
  for (const brace of r.braces) {
    const text = r.page.slice(brace.start, brace.end);
    const mentions = [...text.matchAll(word)].filter((m) => !within(r.code.nonCode, brace.start + m.index));
    if (mentions.length === 0) continue;
    if (brace.inTag || brace.tree === null) return { reason: IN_CODE };
    const ctxOf = braceContext(r, brace);
    for (const ref of refsTo(ts, brace.tree, name)) {
      const call = ref.parent?.parent;
      const cb = call !== undefined && ts.isCallExpression(call) ? call.arguments[0] : undefined;
      if (
        ts.isPropertyAccessExpression(ref.parent) &&
        ref.parent.name.text === 'map' &&
        call !== undefined &&
        ts.isCallExpression(call) &&
        call.expression === ref.parent &&
        cb !== undefined &&
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))
      ) {
        traceCallback(ts, r, ctxOf, cb, ['[*]'], uses);
      } else {
        uses.push({ kind: 'code', pattern: [] });
      }
    }
  }
  return { uses: uses.filter((u) => u.kind !== 'test') };
}

// --- The leaf and the read-back ---------------------------------------------

/** The one edit that replaces an Astro literal with its read of `key`. */
export function astroLeaf(source: string, literal: LocatedLiteral, key: string, form: 'call' | 'property'): Edit {
  if (literal.shape !== 'astro') throw new Error(`stet internal: a ${literal.shape}-shaped finding in ${literal.file} reached the Astro leaf`);
  if (source.slice(literal.pos, literal.end) !== literal.raw) throw new CliError('source changed since scan; re-run stet scan');
  const read = readOf(key, form);
  return { pos: literal.pos, end: literal.end, text: literal.context === 'astro-data' ? read : `{${read}}` };
}

function readOf(key: string, form: 'call' | 'property'): string {
  return form === 'property' ? `copy.${key}` : `copy('${key}')`;
}

/** Whether the property form can read a key: `copy.404_title` is no JavaScript. */
export function readableAs(key: string, form: 'call' | 'property'): boolean {
  return form === 'call' || IDENTIFIER.test(key);
}

/** Where scan reports a literal: an attribute's value starts after its quote. */
function scanPosOf(literal: LocatedLiteral): number {
  return literal.context === 'astro-attr' ? literal.pos + 1 : literal.pos;
}

/**
 * A file's edits for the literals that land, each with the key it reads, and
 * the reads `rereadsClean` checks: each at its literal's offset moved by every
 * edit ending at or before it, inside its leaf.
 */
export function astroEdits(
  source: string,
  plan: AstroPlan,
  landed: Array<{ literal: LocatedLiteral; key: string }>,
): { edits: Edit[]; reads: Array<{ at: number; text: string; key: string; from: number }> } {
  if (landed.length === 0) return { edits: [], reads: [] };
  const leaves = landed.map(({ literal, key }) => astroLeaf(source, literal, key, plan.form));
  const edits = [...leaves, ...(plan.insert === null ? [] : [plan.insert])];
  const reads = landed.map(({ literal, key }, i) => {
    const shift = edits.filter((e) => e.end <= literal.pos && e !== leaves[i]).reduce((sum, e) => sum + e.text.length - (e.end - e.pos), 0);
    return { at: literal.pos + shift + (literal.context === 'astro-data' ? 0 : 1), text: readOf(key, plan.form), key, from: scanPosOf(literal) };
  });
  return { edits, reads };
}

/**
 * Whether an edited Astro file reads back as planned: its front matter parses,
 * its markup pairs with the same elements (less the `moved` a renderer takes),
 * every brace parses as one expression, every planned read sits at its offset,
 * and scan finds every other text where it was. A read's `from` is the finding
 * it replaced; one without `from` counts as replacing one finding, unnamed.
 */
export function rereadsClean(
  ts: typeof import('typescript'),
  file: string,
  before: string,
  after: string,
  reads: Array<{ at: number; text: string; key: string; from?: number }>,
  moved: number,
): boolean {
  const bb = before.charCodeAt(0) === 0xfeff ? 1 : 0;
  const ab = after.charCodeAt(0) === 0xfeff ? 1 : 0;
  const b = before.slice(bb);
  const a = after.slice(ab);
  // 1. The front matter parses.
  const fmBefore = FRONTMATTER.exec(b);
  const fmAfter = FRONTMATTER.exec(a);
  if (fmBefore !== null && fmAfter === null) return false;
  if (fmAfter !== null) {
    const body = a.slice(fmAfter[0].indexOf('\n') + 1, fmAfter[0].lastIndexOf('\n'));
    if (parseDiagnosticsOf(ts.createSourceFile(`${file}.ts`, body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)).length > 0) return false;
  }
  // 2. The markup pairs, with the same elements.
  const count = (text: string): number | null => {
    const document = documentOf(file, text);
    const all = (els: readonly Element[]): number => els.reduce((n, el) => n + 1 + all(el.children), 0);
    try {
      return document === null ? null : all(document.roots);
    } catch (error) {
      // Nested past the stack: the markup does not read back.
      if (error instanceof RangeError) return null;
      throw error;
    }
  };
  const elementsBefore = count(b);
  const elementsAfter = count(a);
  if (elementsBefore === null || elementsAfter === null || elementsAfter !== elementsBefore - moved) return false;
  // 3. Every brace parses as one expression.
  const code = dialectCode(a, 'astro');
  if (!code.braces.every((brace) => parsesAsExpression(ts, 'astro', a.slice(brace.start, brace.end)))) return false;
  // 4. Each planned read is where it was planned, in code.
  const spans = [...code.scripts, ...code.expressions];
  const sticky = new RegExp(KEY_READ.source, 'y');
  for (const read of reads) {
    const at = read.at - ab;
    if (a.slice(at, at + read.text.length) !== read.text || !within(spans, at)) return false;
    sticky.lastIndex = at;
    const m = sticky.exec(a);
    if (m === null || (m[2] ?? m[4] ?? m[5]) !== read.key) return false;
  }
  // 5. Scan finds no text at a read, and every text it found before but the replaced ones, in order.
  const found = (text: string): DialectFinding[] => {
    const f = astroFindings(ts, file, text);
    return [...f.markup, ...(f.data ?? [])].sort((x, y) => x.pos - y.pos);
  };
  const was = found(before);
  const now = found(after);
  const listed = new Set(reads.map((read) => read.at));
  if (now.some((f) => listed.has(f.pos))) return false;
  const replaced = new Set(reads.flatMap((read) => (read.from === undefined ? [] : [read.from])));
  let unnamed = reads.filter((read) => read.from === undefined).length;
  const expected = was.filter((f) => !replaced.has(f.pos)).map((f) => f.text);
  let i = 0;
  for (const text of expected) {
    if (i < now.length && (now[i] as DialectFinding).text === text) i += 1;
    else if (unnamed > 0) unnamed -= 1;
    else return false;
  }
  return i === now.length && unnamed === 0;
}

// --- The name of a read already there ---------------------------------------

/** A read of a key in an `.astro` file, through stet's binding: its place and the name register would give it. */
export interface AstroRead {
  key: string;
  line: number;
  place: Place;
  /** The role name before its number. */
  base: string;
  section: string | null;
}

/**
 * Every read of a declared or undeclared key an `.astro` file makes through
 * stet's `copy`, `copyMap` or `get`, in its front matter or its markup braces,
 * each named as register names the literal it replaced: a content read by its
 * element, a tag-brace read by its attribute, a front-matter read by its first
 * display use. A read stet cannot place takes no name and is left out.
 */
export function astroReads(
  ts: typeof import('typescript'),
  cwd: string,
  config: StetConfig,
  file: string,
  source: string,
  page: string | undefined,
): AstroRead[] {
  const read = readAstro(ts, file, source);
  if ('fault' in read) return [];
  const r = read;
  const stetModule = stetModuleTest(cwd, [config.readPath.file, ...filesForGlobs(cwd, config.copyModules)])(file);
  const bindings = bindingsOf(ts, `${file}.ts`, r.front === null ? [] : [r.front.sf.text], stetModule);
  const ctx: Context = { ts, cwd, r, page, cache: componentCache(), preserved: false, candidates: [], refuse: () => undefined };
  const lineAt = lineIndex(source);
  const found: Array<{ key: string; at: number; where: Candidate['at']; el: Element | undefined; head: boolean }> = [];
  const spans: Array<Span & { brace?: Brace }> = [
    ...(r.front === null ? [] : [{ start: r.front.open, end: r.front.close }]),
    ...r.braces.filter((b) => !bindsCopy(r, b)).map((brace) => ({ start: brace.start, end: brace.end, brace })),
  ];
  for (const span of spans) {
    for (const m of r.page.slice(span.start, span.end).matchAll(KEY_READ)) {
      const at = span.start + m.index;
      const name = /^(copyMap|copy|get)/.exec(m[0])?.[1] as string;
      const key = m[2] ?? m[4] ?? m[5];
      if (key === undefined || (m[5] !== undefined && key === 'get') || within(r.code.nonCode, at) || /[\w$.]/.test(r.page.charAt(at - 1))) continue;
      if (bindings.get(name) !== 'stet') continue;
      const placed = span.brace === undefined ? frontRead(ctx, at) : braceRead(ctx, span.brace, at);
      if (placed !== null) found.push({ key, at, ...placed });
    }
  }
  const items = htmlItems(r.parents, new Set(found.flatMap((f) => (f.el === undefined ? [] : [f.el]))));
  return found.map((f) => {
    const place = placeOf({ file, line: lineAt(f.at + r.bom), ...f.where });
    const head = f.head || isHeadKind(place);
    const naming = f.el === undefined ? { sectionWord: null, role: roleOf(place) } : namingOf(f.el, r.parents, items, place);
    const base = baseName({
      ...(page === undefined ? {} : { page }),
      ...(head ? {} : { section: naming.sectionWord }),
      ...(naming.item === undefined ? {} : { item: naming.item }),
      role: naming.role,
    });
    return { key: f.key, line: place.line, place, base, section: head ? null : naming.sectionWord };
  });
}

/** The name register gives the first read of `key` on `line` of an `.astro` file, or null where no read there can be placed. */
export function astroPlaceName(
  ts: typeof import('typescript'),
  cwd: string,
  file: string,
  source: string,
  key: string,
  line: number,
  page: string | undefined,
): string | null {
  return astroReads(ts, cwd, loadConfig(cwd), file, source, page).find((read) => read.key === key && read.line === line)?.base ?? null;
}

/** A read inside a markup brace: a tag brace's by its attribute, a content brace's by the element it sits in. */
function braceRead(ctx: Context, brace: Brace, at: number): { where: Candidate['at']; el: Element | undefined; head: boolean } | null {
  const { r } = ctx;
  const around = braceContext(r, brace);
  if (brace.inTag) {
    if (around.attr === undefined) return null;
    const { el, tag } = around.attr;
    const spelled = /([^\s"'=<>/{}]+)\s*=\s*$/.exec(r.page.slice(el.openStart, brace.start))?.[1] as string;
    const meta = metaCopyNameOf(el.tag, (n) => attrOf(el, n));
    const attr = componentName(tag) ? spelled : spelled.toLowerCase();
    return { where: { kind: 'attribute', tag: placeTag(tag), attr, ...(meta === null ? {} : { metaName: meta }) }, el, head: pathHead(around.path).head };
  }
  // A read in the attribute of a tag the brace's own markup holds names that attribute, as register named the literal.
  const inner = brace.start + 1;
  const holder = markupTags(r.blanked.slice(inner, brace.end - 1)).find((t) => !t.close && inner + t.start < at && at < inner + t.end);
  if (holder !== undefined && !componentName(holder.name)) {
    const before = r.page.slice(inner + holder.start, at);
    const spelled = /([^\s"'=<>/{}]+)\s*=\s*$/.exec(before.slice(0, before.lastIndexOf('{')))?.[1];
    if (spelled !== undefined) {
      const tag = holder.name.toLowerCase();
      return { where: { kind: 'attribute', tag, attr: spelled.toLowerCase() }, el: around.path.at(-1), head: pathHead([...around.path, { tag }]).head };
    }
  }
  // The innermost element the brace's own markup opens around the read.
  const open: string[] = [];
  for (const tag of markupTags(r.blanked.slice(brace.start + 1, at))) {
    if (tag.close) {
      const i = open.lastIndexOf(tag.name);
      if (i >= 0) open.length = i;
    } else if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name.toLowerCase())) {
      open.push(tag.name);
    }
  }
  const el = around.path.at(-1);
  const tag = open.at(-1) ?? (el === undefined ? undefined : sourceTag(r, el));
  if (tag === undefined) return null;
  const head = pathHead([...around.path, ...open.map((name) => ({ tag: name.toLowerCase() }))]);
  return { where: { kind: 'element', tag: placeTag(tag), ...(tag === 'title' && head.svg ? { inSvg: true as const } : {}) }, el, head: head.head || head.title };
}

/** A read in the front matter's data, named by the first display use of the place it fills. */
function frontRead(ctx: Context, at: number): { where: Candidate['at']; el: Element | undefined; head: boolean } | null {
  const { ts, r } = ctx;
  const front = r.front as NonNullable<Reading['front']>;
  let node: TS.Node | null = null;
  const visit = (n: TS.Node): void => {
    if (node !== null) return;
    if (ts.isIdentifier(n) && n.getStart(front.sf) === at - front.open) node = n;
    else ts.forEachChild(n, visit);
  };
  visit(front.sf);
  if (node === null) return null;
  let read: TS.Node = node;
  while (read.parent !== undefined && ((ts.isPropertyAccessExpression(read.parent) || ts.isCallExpression(read.parent)) && read.parent.expression === read)) read = read.parent;
  const declared = constOf(ts, read);
  if (declared === null) return null;
  const uses = constUses(ctx, declared);
  if ('reason' in uses) return null;
  const path = literalPath(ts, read, declared.initializer as TS.Expression);
  const first = uses.uses.find((u) => (u.kind === 'display' || u.kind === 'head') && wholeMatch(u.pattern, path) && u.at !== undefined);
  if (first?.at === undefined) return null;
  return { where: first.at, el: first.brace === undefined ? undefined : elementPath(r.document.roots, first.brace.start).at(-1), head: first.kind === 'head' };
}

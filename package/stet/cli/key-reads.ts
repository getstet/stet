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

import { join } from 'node:path';

import type * as TS from 'typescript';

import { normalizeNoExt, pathAliasMappings, resolveSpecifier } from './config.js';
import { lineIndex } from './html-host.js';
import { dialectCode, openTag, VOID_ELEMENTS, within, type Dialect, type Span } from './markup.js';
import { parseDiagnosticsOf, scriptKindFor } from './source-scan.js';

/**
 * A read of a key: `copy.get('<key>')`, `copy('<key>')` or `get('<key>')`, and
 * `copy.<key>`, `copy?.<key>` or `copyMap.<key>` — the accessor `register`
 * writes, the map the scaffolded read path exports, and the forms a host
 * re-exports them under. The call alternative comes before the property
 * alternative, so `copy.get('x')` reads `x`, not `get`.
 */
export const KEY_READ =
  /\bcopy(?:Map)?\s*\.\s*get\s*\(\s*(['"`])([^'"`\n]+)\1|\b(?:copy|get)\s*\(\s*(['"`])([^'"`\n]+)\3|\bcopy(?:Map)?\s*\??\.\s*([A-Za-z_$][\w$]*)/g;

export { dialectCode, within, type Span } from './markup.js';

/**
 * The comments and JSX text of a TypeScript region — the parts of it that are
 * not code. Every token's leading trivia is read, so a comment before a closing
 * brace, which starts no node, is found too. `parsed` is the region's parse
 * where the caller already holds it.
 */
export function nonCodeOf(
  ts: typeof import('typescript'),
  file: string,
  text: string,
  base = 0,
  parsed?: TS.SourceFile,
): Span[] {
  const sf = parsed ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
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

/** Where code is in one file, as every reader of a key's name in source reads it. */
export interface FileCode {
  /** Where code is: the whole file for the TypeScript family, the scripts and expressions of a dialect. */
  code: Span[];
  /** The TypeScript regions bindings live in, with their text. */
  regions: Array<Span & { text: string }>;
  /** Comments and JSX text inside `code`. */
  nonCode: Span[];
  braces: Span[];
}

/**
 * One file's code: the whole file for the TypeScript family, its comments and
 * JSX text excepted; a template dialect's scripts and expressions, with the
 * comments of each script and brace, which the markup walk keeps whole. Null
 * where the file is neither the TypeScript family nor a dialect.
 *
 * `parse`, where given, makes each parse this reads — the whole file, each
 * script region and each brace's inside, named and based as here — so a caller
 * that walks the same trees afterwards parses each once.
 */
export function codeOf(
  ts: typeof import('typescript'),
  file: string,
  source: string,
  dialect: Dialect | null,
  parse?: (file: string, text: string, base: number) => TS.SourceFile,
): FileCode | null {
  const nonCode = (name: string, text: string, base: number): Span[] =>
    nonCodeOf(ts, name, text, base, parse?.(name, text, base));
  if (dialect === null) {
    if (!TS_FAMILY.test(file)) return null;
    return {
      code: [{ start: 0, end: source.length }],
      regions: [{ start: 0, end: source.length, text: source }],
      nonCode: nonCode(file, source, 0),
      braces: [],
    };
  }
  const found = dialectCode(source, dialect);
  const regions = found.scripts.map((s) => ({ ...s, text: source.slice(s.start, s.end) }));
  return {
    code: [...found.scripts, ...found.expressions],
    regions,
    nonCode: [
      ...regions.flatMap((r) => nonCode(`${file}.ts`, r.text, r.start)),
      ...found.expressions
        .filter((e) => source[e.start] === '{')
        .flatMap((e) => nonCode(`${file}.tsx`, source.slice(e.start + 1, e.end - 1), e.start + 1)),
    ],
    braces: found.braces,
  };
}

/**
 * `(rel) => (spec) => boolean`: whether `spec`, imported from `rel`, resolves
 * to one of `targets` (repo-relative files) under the host's own resolution
 * rules — relative to the importer, or through its path aliases.
 */
export function stetModuleTest(cwd: string, targets: readonly string[]): (rel: string) => (spec: string) => boolean {
  const mappings = pathAliasMappings(cwd);
  const wanted = new Set(targets.map((rel) => normalizeNoExt(join(cwd, rel))));
  return (rel) => (spec) => resolveSpecifier(spec, rel, cwd, mappings).some((target) => wanted.has(target));
}

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
  const found = codeOf(ts, file, source, dialect);
  if (found === null) return out;
  const { code, regions, nonCode, braces } = found;
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

/**
 * An Astro brace's inside as one TSX expression — as written, or as JSX spells
 * it — or null where neither parses as one. The root expression is
 * `braceRoot`'s. `asJsx` changes lengths, so the tree is read for its shape and
 * its names: no offset in it is a source offset, and no edit is placed from it.
 */
export function braceTree(ts: typeof import('typescript'), brace: string): TS.SourceFile | null {
  const inner = brace.slice(1, -1).replace(/^\s*\.\.\./, '');
  return parseOne(ts, inner, true) ?? parseOne(ts, asJsx(inner), true);
}

/** The expression a `braceTree` holds. */
export function braceRoot(ts: typeof import('typescript'), tree: TS.SourceFile): TS.Expression {
  const only = tree.statements[0] as TS.ExpressionStatement;
  return (only.expression as TS.ParenthesizedExpression).expression;
}

/** Whether `inner` parses as one TypeScript expression; a lone comment counts, closed. */
function parsesAsOne(ts: typeof import('typescript'), inner: string): boolean {
  if (inner.replace(/\/\*[\s\S]*?\*\//g, '').trim() === '') return !/\/\*(?![\s\S]*\*\/)/.test(inner);
  return parseOne(ts, inner, false) !== null;
}

/** `inner` parsed as one parenthesized TSX expression, or null where it is not one. */
function parseOne(ts: typeof import('typescript'), inner: string, parents: boolean): TS.SourceFile | null {
  const sf = ts.createSourceFile('brace.tsx', `(${inner}\n)`, ts.ScriptTarget.Latest, parents, ts.ScriptKind.TSX);
  const only = sf.statements[0];
  const one =
    parseDiagnosticsOf(sf).length === 0 &&
    sf.statements.length === 1 &&
    only !== undefined &&
    ts.isExpressionStatement(only) &&
    ts.isParenthesizedExpression(only.expression);
  return one ? sf : null;
}

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

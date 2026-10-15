/**
 * The root-layout `CopyProvider` mount: whether a layout carries it, where it
 * wraps, the edits that insert it (`register` plans them through `planMount`)
 * and the snippet that names it by hand.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type * as TS from 'typescript';

import type { StetConfig } from './config.js';
import { posixRelative, type Report } from './report.js';
import { applyFileEdits, dominantEol, type Edit } from './rewrite.js';
import { loadTypescript, scriptKindFor } from './source-scan.js';

/** A `/`-normalized, `./`-prefixed specifier from one file to a target path. */
export function relImport(fromFile: string, toDiskPath: string, opts: { stripExt?: boolean } = {}): string {
  let spec = posixRelative(dirname(fromFile), toDiskPath);
  if (!spec.startsWith('.')) spec = `./${spec}`;
  if (opts.stripExt) spec = spec.replace(/\.(tsx?|jsx?|json)$/, '');
  return spec;
}

/** Already carries `import { CopyProvider } from '@getstet/stet/react'`? Then the mount is done. */
export function importsCopyProvider(ts: typeof import('typescript'), sf: TS.SourceFile): boolean {
  return sf.statements.some((stmt) => {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) return false;
    if (stmt.moduleSpecifier.text !== '@getstet/stet/react') return false;
    const bindings = stmt.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((e) => e.name.text === 'CopyProvider')
    );
  });
}

/** Where the provider wraps: the span its element replaces. */
export interface WrapTarget {
  pos: number;
  end: number;
}

/**
 * Where the provider wraps, or null where the layout does not say it
 * unambiguously — the caller then mounts nothing rather than guess.
 *
 * - An App-Router layout under the `resolved` form: the content of its one
 *   `<body>` element, from the opening element's end to the closing element's
 *   start, so a component the layout renders beside `{children}` is served
 *   too; else the sole `{children}` expression. Under the `resolveAll` form
 *   (0.6.0's mount, kept for the unmount's round trip) the sole `{children}`.
 * - A Pages `_app`: the sole `<Component … />`, the whole tree already.
 * - A Vite entry: the one JSX argument of the one `….render(…)` call on a
 *   `createRoot(…)` result.
 */
export function locateWrapTarget(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  router: 'app' | 'pages' | 'vite',
  form: 'resolved' | 'resolveAll',
): WrapTarget | null {
  const hits: TS.Node[] = [];
  const bodies: TS.JsxElement[] = [];
  const visit = (node: TS.Node): void => {
    if (router === 'app') {
      if (ts.isJsxExpression(node) && node.expression !== undefined && ts.isIdentifier(node.expression) && node.expression.text === 'children') {
        hits.push(node);
      }
      if (ts.isJsxElement(node) && ts.isIdentifier(node.openingElement.tagName) && node.openingElement.tagName.text === 'body') bodies.push(node);
    } else if (router === 'pages') {
      if (ts.isJsxSelfClosingElement(node) && ts.isIdentifier(node.tagName) && node.tagName.text === 'Component') hits.push(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'render' &&
      ts.isCallExpression(node.expression.expression) &&
      /(^|\.)createRoot$/.test(node.expression.expression.expression.getText(sf)) &&
      node.arguments.length === 1 &&
      (ts.isJsxElement(node.arguments[0] as TS.Node) ||
        ts.isJsxSelfClosingElement(node.arguments[0] as TS.Node) ||
        ts.isJsxFragment(node.arguments[0] as TS.Node))
    ) {
      hits.push(node.arguments[0] as TS.Node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (router === 'app' && form === 'resolved' && bodies.length === 1) {
    const body = bodies[0] as TS.JsxElement;
    return { pos: body.openingElement.getEnd(), end: body.closingElement.getStart(sf) };
  }
  if (hits.length !== 1) return null;
  const hit = hits[0] as TS.Node;
  return { pos: hit.getStart(sf), end: hit.getEnd() };
}

/** The import block a mount inserts, in the layout's line endings. */
export function mountBlock(layoutFile: string, cwd: string, config: StetConfig, form: 'resolved' | 'resolveAll', nl: string): string {
  const relDescriptor = relImport(layoutFile, join(cwd, config.descriptorPath));
  const js = jsHost(layoutFile);
  if (form === 'resolveAll') {
    const relDefaults = relImport(layoutFile, join(cwd, config.codegen.defaults), { stripExt: true });
    const descriptorExpr = js ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
    return [
      "import { CopyProvider } from '@getstet/stet/react';",
      js ? "import { readBundle, resolveAll } from '@getstet/stet';" : "import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
      `import descriptorJson from '${relDescriptor}';`,
      `import { DEFAULTS } from '${relDefaults}';`,
      '',
      `const { resolved } = resolveAll(${descriptorExpr}, readBundle(DEFAULTS));`,
    ].join(nl);
  }
  return [
    "import { CopyProvider } from '@getstet/stet/react';",
    ...(js ? [] : ["import type { Descriptor } from '@getstet/stet';"]),
    `import descriptorJson from '${relDescriptor}';`,
    `import { RESOLVED } from '${relImport(layoutFile, join(cwd, config.codegen.resolved), { stripExt: true })}';`,
  ].join(nl);
}

/** The block's insert: before everything at offset 0, else on its own lines after the last import. */
export function importEditAt(at: number, block: string, nl: string): Edit {
  return { pos: at, end: at, text: at === 0 ? `${block}${nl}${nl}` : `${nl}${block}${nl}` };
}

/** The provider element around the wrap target, as two inserts, fed the map the form names. */
export function wrapEdit(sf: TS.SourceFile, wrap: WrapTarget, descriptorExpr: string, form: 'resolved' | 'resolveAll'): Edit[] {
  const map = form === 'resolveAll' ? 'resolved' : 'RESOLVED';
  // `applyFileEdits` sorts descending by position, keeps list order among equal
  // positions and applies in that order, so of two inserts at one offset the last
  // listed lands first in the text: an empty span (`<body></body>`) comes out
  // `<CopyProvider …></CopyProvider>` only with the closing tag listed first. On a
  // non-empty span the positions order them, and an insert at the span's start
  // lands before a leaf edit starting there, one at its end after a leaf edit
  // ending there.
  return [
    { pos: wrap.end, end: wrap.end, text: '</CopyProvider>' },
    { pos: wrap.pos, end: wrap.pos, text: `<CopyProvider descriptor={${descriptorExpr}} resolved={${map}}>` },
  ];
}

/** The import block and the wrap of the target, in the layout's own line endings. */
export function providerEdits(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  source: string,
  layoutFile: string,
  cwd: string,
  config: StetConfig,
  wrap: WrapTarget,
  form: 'resolved' | 'resolveAll',
): Edit[] {
  // A JS layout gets no TypeScript syntax — no `type` import, no `as` cast (P1-3).
  const descriptorExpr = jsHost(layoutFile) ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
  // The layout's OWN line ending: a `\n` inserted into a CRLF file leaves
  // mixed endings in a file stet did not write (P3-13).
  const nl = dominantEol(source);
  return [importEditAt(importInsertPos(ts, sf), mountBlock(layoutFile, cwd, config, form, nl), nl), ...wrapEdit(sf, wrap, descriptorExpr, form)];
}

/** A planned mount: the layout, its source, the edits and the text they give. */
export interface MountPlan {
  layout: string;
  source: string;
  edits: Edit[];
  text: string;
}

/**
 * The CopyProvider mount on the root layout: `'mounted'` where the layout
 * already imports it (`importsCopyProvider`, the one test), the plan, or null
 * where there is no layout to edit or the wrap target cannot be located.
 */
export async function planMount(cwd: string, config: StetConfig): Promise<'mounted' | MountPlan | null> {
  if (config.rootLayout === undefined || config.router === 'astro') return null;
  const path = join(cwd, config.rootLayout);
  if (!existsSync(path)) return null;
  let ts: typeof import('typescript');
  try {
    ts = await loadTypescript();
  } catch {
    return null;
  }
  const source = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, path));
  if (importsCopyProvider(ts, sf)) return 'mounted';
  const wrap = locateWrapTarget(ts, sf, config.router, 'resolved');
  if (wrap === null) return null;
  const edits = providerEdits(ts, sf, source, path, cwd, config, wrap, 'resolved');
  return { layout: config.rootLayout, source, edits, text: applyFileEdits(source, edits) };
}

/**
 * The layout with the CopyProvider mount taken out exactly — the bytes before
 * `init` (0.6.0) or `register` (0.7.0) mounted it — or null where the mount is
 * not one of those two forms as written. The proof is the round trip:
 * mounting the result again gives back the layout byte for byte.
 */
export function unmountEdits(
  ts: typeof import('typescript'),
  layoutPath: string,
  source: string,
  cwd: string,
  config: StetConfig,
): { edits: Edit[]; block: { pos: number; end: number } } | null {
  const router = config.router;
  if (router === 'astro') return null;
  const sf = ts.createSourceFile(layoutPath, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, layoutPath));
  const providers: TS.JsxElement[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isJsxElement(node) && ts.isIdentifier(node.openingElement.tagName) && node.openingElement.tagName.text === 'CopyProvider') providers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (providers.length !== 1) return null;
  const element = providers[0] as TS.JsxElement;
  const inner = source.slice(element.openingElement.getEnd(), element.closingElement.getStart(sf));
  const nl = dominantEol(source);
  for (const form of ['resolved', 'resolveAll'] as const) {
    const block = mountBlock(layoutPath, cwd, config, form, nl);
    const at = source.indexOf(block);
    if (at === -1 || source.indexOf(block, at + 1) !== -1) continue;
    // `providerEdits` inserted `${nl}${block}${nl}` after the last import, or `${block}${nl}${nl}` at offset 0.
    // The blank line after the block is the mount's only where it is still there: a
    // later `register` run inserts its own leaf import right after the block's last
    // line, and taking the leading newline then would join two statements.
    const span =
      at === 0
        ? { pos: 0, end: block.length + 2 * nl.length }
        : source.startsWith(nl + nl, at + block.length)
          ? { pos: at - nl.length, end: at + block.length + nl.length }
          : { pos: at, end: at + block.length + nl.length };
    const edits: Edit[] = [
      { pos: span.pos, end: span.end, text: '' },
      { pos: element.getStart(sf), end: element.getEnd(), text: inner },
    ];
    const candidate = applyFileEdits(source, edits);
    const again = ts.createSourceFile(layoutPath, candidate, ts.ScriptTarget.Latest, true, scriptKindFor(ts, layoutPath));
    const wrap = locateWrapTarget(ts, again, router, form);
    if (wrap === null) continue;
    // The block goes back where it was taken from, not after the last import: a
    // leaf import `register` inserted after the block (its own `import { copy }`)
    // would otherwise move `importInsertPos` past it and fail the round trip.
    const descriptorExpr = jsHost(layoutPath) ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
    const remount = [{ pos: span.pos, end: span.pos, text: source.slice(span.pos, span.end) }, ...wrapEdit(again, wrap, descriptorExpr, form)];
    if (applyFileEdits(candidate, remount) === source) return { edits, block: span };
  }
  return null;
}

/** After the last import (or the directive prologue), never before `'use client'`. */
export function importInsertPos(ts: typeof import('typescript'), sf: TS.SourceFile): number {
  let pos = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      pos = stmt.getEnd();
      continue;
    }
    if (
      pos === 0 &&
      ts.isExpressionStatement(stmt) &&
      ts.isStringLiteral(stmt.expression)
    ) {
      pos = stmt.getEnd(); // a leading directive such as 'use client'
    }
  }
  return pos;
}

export function printProviderSnippet(
  report: Report,
  config: StetConfig,
  layoutFile: string,
  cwd: string,
  router: 'app' | 'pages' | 'vite',
): void {
  const descriptorExpr = jsHost(layoutFile) ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
  const wrapee =
    router === 'app'
      ? 'everything inside <body>'
      : router === 'pages'
        ? '<Component {...pageProps} />'
        : 'the element createRoot(...).render() receives';
  for (const line of [
    ...mountBlock(layoutFile, cwd, config, 'resolved', '\n').split('\n'),
    '',
    `wrap ${wrapee} in:`,
    `<CopyProvider descriptor={${descriptorExpr}} resolved={RESOLVED}>…</CopyProvider>`,
  ]) {
    report.line(line === '' ? '' : `  ${line}`);
  }
}

/** A `.js`/`.jsx` file — a JS host, so the scaffold must carry no TypeScript syntax (P1-3). */
export function jsHost(file: string): boolean {
  return /\.(js|jsx)$/.test(file);
}

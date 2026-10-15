/**
 * The root-layout `CopyProvider` mount: whether a layout carries it, where it
 * wraps, the edits that insert it and the snippet that names it by hand.
 */

import { dirname, join } from 'node:path';

import type * as TS from 'typescript';

import type { StetConfig } from './config.js';
import { posixRelative, type Report } from './report.js';
import { dominantEol, type Edit } from './rewrite.js';

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

/**
 * The node to wrap: the sole `{children}` expression in an App-Router layout, or
 * the sole `<Component … />` in a Pages `_app` (which has no `children` prop).
 * More than one candidate, or none, is ambiguous — the caller skips and prints
 * the snippet rather than guess.
 */
export function locateWrapTarget(ts: typeof import('typescript'), sf: TS.SourceFile, router: 'app' | 'pages'): TS.Node | null {
  const hits: TS.Node[] = [];
  const visit = (node: TS.Node): void => {
    if (router === 'app') {
      if (ts.isJsxExpression(node) && node.expression !== undefined && ts.isIdentifier(node.expression) && node.expression.text === 'children') {
        hits.push(node);
      }
    } else if (ts.isJsxSelfClosingElement(node) && ts.isIdentifier(node.tagName) && node.tagName.text === 'Component') {
      hits.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits.length === 1 ? (hits[0] as TS.Node) : null;
}

/** The import block + resolved-map declaration, plus the wrap of the target node. */
export function providerEdits(
  ts: typeof import('typescript'),
  sf: TS.SourceFile,
  source: string,
  layoutFile: string,
  target: string,
  config: StetConfig,
  wrap: TS.Node,
): Edit[] {
  const relDescriptor = relImport(layoutFile, join(target, config.descriptorPath));
  const relDefaults = relImport(layoutFile, join(target, config.codegen.defaults), { stripExt: true });
  // A JS layout gets no TypeScript syntax — no `type` import, no `as` cast (P1-3).
  const js = jsHost(layoutFile);
  const descriptorExpr = js ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
  // The layout's OWN line ending: a `\n` inserted into a CRLF file leaves
  // mixed endings in a file stet did not write (P3-13, the same rule the
  // guidance append follows).
  const nl = dominantEol(source);
  const block = [
    "import { CopyProvider } from '@getstet/stet/react';",
    js ? "import { readBundle, resolveAll } from '@getstet/stet';" : "import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    `import descriptorJson from '${relDescriptor}';`,
    `import { DEFAULTS } from '${relDefaults}';`,
    '',
    `const { resolved } = resolveAll(${descriptorExpr}, readBundle(DEFAULTS));`,
  ].join(nl);

  const at = importInsertPos(ts, sf);
  const importEdit: Edit = { pos: at, end: at, text: at === 0 ? `${block}${nl}${nl}` : `${nl}${block}${nl}` };

  const inner = source.slice(wrap.getStart(sf), wrap.getEnd());
  const wrapped = `<CopyProvider descriptor={${descriptorExpr}} resolved={resolved}>${inner}</CopyProvider>`;
  const wrapEdit: Edit = { pos: wrap.getStart(sf), end: wrap.getEnd(), text: wrapped };

  return [importEdit, wrapEdit];
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
  target: string,
  router: 'app' | 'pages',
): void {
  const relDescriptor = relImport(layoutFile, join(target, config.descriptorPath));
  const relDefaults = relImport(layoutFile, join(target, config.codegen.defaults), { stripExt: true });
  const wrapee = router === 'app' ? '{children}' : '<Component {...pageProps} />';
  const js = jsHost(layoutFile);
  const descriptorExpr = js ? 'descriptorJson' : 'descriptorJson as unknown as Descriptor';
  for (const line of [
    "  import { CopyProvider } from '@getstet/stet/react';",
    js ? "  import { readBundle, resolveAll } from '@getstet/stet';" : "  import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';",
    `  import descriptorJson from '${relDescriptor}';`,
    `  import { DEFAULTS } from '${relDefaults}';`,
    '',
    `  const { resolved } = resolveAll(${descriptorExpr}, readBundle(DEFAULTS));`,
    '',
    `  wrap ${wrapee} in:`,
    `  <CopyProvider descriptor={${descriptorExpr}} resolved={resolved}>…</CopyProvider>`,
  ]) {
    report.line(line);
  }
}

/** A `.js`/`.jsx` file — a JS host, so the scaffold must carry no TypeScript syntax (P1-3). */
export function jsHost(file: string): boolean {
  return /\.(js|jsx)$/.test(file);
}

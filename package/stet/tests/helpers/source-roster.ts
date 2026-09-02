/**
 * What the package's source files ARE, in one place — the collection every
 * structural guard walks.
 *
 * Two properties are the whole point, and both were holes that shipped past a
 * guard before this existed. The walk is RECURSIVE: a bare `readdirSync` lists
 * no subdirectory, so a new layer under `src/` sits outside the check written
 * to cover it, silently — which is the exact failure mode a structural check is
 * supposed to make impossible. And the extension test is `.ts`, `.mts` AND
 * `.cts`, because TypeScript compiles all three into `dist/` while
 * `endsWith('.ts')` sees only the first.
 *
 * It lives here, beside the other cross-suite helper, because both the offline
 * guard and the conformance walk's CLI-boundary case collect the same files:
 * two consumers, one collection, no second definition of "source file" to
 * drift.
 *
 * `runtimeImportClosure` and `isNodeBuiltin` are here for the same reason: the
 * conformance walk's builtin-freedom requirement and the offline guard's purity
 * block are two consumers of one walk and one predicate, and a second spelling
 * of "what this entry reaches at runtime" is exactly the drift a structural
 * guard cannot survive.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import type * as TS from 'typescript';

/** The extensions TypeScript compiles — the one definition of a source file. */
const SOURCE = /\.[cm]?ts$/;

/**
 * Every source file under `dir`, recursively, as `/`-separated paths relative
 * to it, sorted. Directory entries and non-source files are dropped, and the
 * platform separator is normalized so a roster reads the same everywhere.
 */
export function sourceFiles(dir: URL): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => entry.toString().split(sep).join('/'))
    .filter((name) => SOURCE.test(name))
    .sort();
}

/**
 * A path's filename without its source extension — `targets/web.mts` → `web`.
 * It reads the same extension set as the collection above, which is why it
 * lives here: a banned-name check that stripped only `.ts` would wave through
 * the `utils.mts` the check exists to stop.
 */
export function stemOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(SOURCE, '');
}

/**
 * A specifier a bundler targeting the browser refuses. The `node:` scheme is
 * the guard's semantics — webpack refuses the scheme whether or not the module
 * behind it exists, which is why `node:module`'s own `isBuiltin` is not the
 * predicate here: it answers false for `node:nope`. The unprefixed spelling is
 * closed by the list.
 */
export const isNodeBuiltin = (spec: string): boolean =>
  spec.startsWith('node:') || builtinModules.includes(spec);

/** The package root — `modules` paths read the same from either entry. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The extensions a `./x.js` specifier is emitted from. */
const EMITTED_FROM = ['.ts', '.tsx', '.mts'];

/** The one extension a `./x.mjs` specifier is emitted from. */
const EMITTED_FROM_MJS = ['.mts'];

/**
 * An entry and every module it reaches at RUNTIME, plus every bare specifier
 * that closure names — the graph a bundler follows out of a published entry.
 *
 * The walk applies tsc's own erasure under `verbatimModuleSyntax`: a
 * declaration-level `import type` / `export type` is erased and is not an edge,
 * while every other import or re-export survives into `dist/` and is one. An
 * inline-`type`-only clause is an edge, because `import { type X } from './m.js'`
 * emits `import {} from './m.js'` — the module is still loaded — and a type
 * pulled through a plain `import { X }` is a compile error (TS1484), so no
 * source can rely on the erasure this walk does not perform. The source walk
 * and the emitted graph therefore agree, and no build is needed to run it.
 *
 * A string-literal dynamic `import()` or `require()` is an edge, because a
 * bundler follows both; a computed one throws rather than vanishing, since a
 * guard that silently drops what it cannot read vouches for nothing. A relative
 * specifier that resolves to no source file throws for the same reason.
 *
 * `new URL('./x.js', import.meta.url)` is a module or asset reference to webpack
 * and to Vite, which both follow it. Reading it here would mean resolving a form
 * whose base is computed, so the walk refuses it outright: any `import.meta`
 * inside a `new URL(...)` throws, and the guard stays fail-closed rather than
 * silently blind to an edge a bundler takes.
 *
 * The walk is FIRST-PARTY only: a bare specifier is collected, never entered,
 * so what a dependency's own graph reaches is outside it — that half is the
 * process's fourth high-stakes trigger (`docs/canon/change-process.md`), not a
 * property this guard can assert.
 *
 * `cli/doctor.ts`'s own closure is host semantics — depth-capped, refusing
 * `node_modules`, with no erasure rule — and answers a different question about
 * someone else's tree, so it is checked against rather than reused.
 *
 * `modules` are package-root-relative (`src/codegen.ts`, `react/provider.tsx`),
 * `bare` holds every non-relative specifier, and both are sorted and deduped.
 */
export function runtimeImportClosure(entry: URL): { modules: string[]; bare: string[] } {
  const modules = new Set<string>();
  const bare = new Set<string>();
  const queue: URL[] = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as URL;
    const path = fileURLToPath(file);
    const name = relative(PACKAGE_ROOT, path).split(sep).join('/');
    if (modules.has(name)) continue;
    modules.add(name);

    for (const spec of runtimeSpecifiers(path)) {
      if (spec.startsWith('./') || spec.startsWith('../')) queue.push(resolveSource(spec, file));
      else bare.add(spec);
    }
  }

  return { modules: [...modules].sort(), bare: [...bare].sort() };
}

/**
 * Every specifier ONE file loads at runtime, in source order — the per-file half
 * of the walk. The closure aggregates these across a graph; a caller asking what
 * a single module names for itself, rather than what its graph reaches, reads
 * this: attribution stays with the file that wrote the import.
 */
export function runtimeImports(file: URL): string[] {
  return runtimeSpecifiers(fileURLToPath(file));
}

/** Every specifier one file loads at runtime, in source order. */
function runtimeSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs: string[] = [];

  // Every node, not just the statements: an import can sit inside a function
  // body, and a walk over `sf.statements` alone would never reach it.
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import type X = require()` is erased; the value form is not.
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const target = node.moduleReference.expression;
        if (ts.isStringLiteral(target)) specs.push(target.text);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specs.push(literalArgument(node, `unanalyzable dynamic import in ${path}`));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        specs.push(literalArgument(node, `unanalyzable require in ${path}`));
      }
    } else if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'URL' && namesImportMeta(node)) {
        throw new Error(`unanalyzable import.meta URL in ${path}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return specs;
}

/** Does this expression reach an `import.meta` anywhere inside it? */
function namesImportMeta(node: TS.Node): boolean {
  let found = false;
  const scan = (n: TS.Node): void => {
    if (found) return;
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(n, scan);
  };
  ts.forEachChild(node, scan);
  return found;
}

/** The one string argument a load call names, or a loud failure. */
function literalArgument(call: TS.CallExpression, failure: string): string {
  const first = call.arguments[0];
  if (first === undefined || !ts.isStringLiteral(first)) throw new Error(failure);
  return first.text;
}

/** The source file a relative specifier is emitted from. */
function resolveSource(spec: string, from: URL): URL {
  const [base, extensions] = spec.endsWith('.mjs')
    ? [spec.slice(0, -'.mjs'.length), EMITTED_FROM_MJS]
    : spec.endsWith('.js')
      ? [spec.slice(0, -'.js'.length), EMITTED_FROM]
      : [spec, []];
  for (const ext of extensions) {
    const candidate = new URL(`${base}${ext}`, from);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `unresolved import ${spec} from ${fileURLToPath(from)} — the walk resolves ./x.js to ` +
      `x.ts|x.tsx|x.mts and ./x.mjs to x.mts; a JSON, query-string or other specifier is ` +
      `outside it`,
  );
}

/**
 * `stet eject` — reverse every stet edit to the host, write the content back to
 * plain files, and remove the dependency, so the project keeps its copy with no
 * `stet` runtime anywhere. The WHOLE command is `--write`-gated, and it is
 * PLAN-THEN-APPLY: it computes every edit, deletion, snapshot and history in
 * memory, then a whole-host backstop sweep proves nothing still imports stet
 * BEFORE a single byte is written. A survivor — an aliased import, an
 * un-parseable leaf, an out-of-surface consumer — refuses the whole run
 * (recoverable: nothing was written), never a host left importing a dependency
 * it just dropped.
 *
 * Steps: (1) the snapshot, every enabled locale written back (+ the regenerated
 * defaults module); (2) the managed leaves un-rewritten (a foreign `copy` is
 * skipped, never mangled); (3) init's root-layout mount reversed WHOLE — unwrap
 * `CopyProvider`, drop its stet imports, its `resolveAll` decl AND its now-orphan
 * descriptor/defaults imports — then delete the read-path module, the API route
 * and the ambient `.d.ts`; (4) the history per key; (5) the dep, the pre-commit
 * hook, and the agent-guidance block (every span gone from `AGENTS.md`/
 * `CLAUDE.md` at the eject root, a marker anywhere else reported by the
 * backstop). Snapshot-only degrades to 1–3 + 5, no history.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';

import type * as TS from 'typescript';

import { generateDefaultsModule } from '../src/codegen.js';
import { escapeRegExp } from '../src/seo.js';
import { activeRow, resolve } from '../src/resolve.js';
import type { StoreRow } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import type { StoreAdapter, VersionRow } from '../src/store.js';
import type { Descriptor } from '../src/types.js';
import {
  GUIDANCE_NAMES,
  buildGuidanceBlock,
  errorCode,
  fileIdentity,
  hasGuidanceMarker,
  planGuidanceRemoval,
} from './agents.js';
import { flag, ENV_OPTION, noPositionals, parse, text as argText } from './args.js';
import { writeJsonDeterministic, writeText } from './artifacts.js';
import {
  CONFIG_FILE,
  HOST_MIGRATIONS,
  isHtmlHost,
  normalizeNoExt,
  pathAliasMappings,
  resolveSpecifier,
  selectStoreBlock,
  type StetConfig,
} from './config.js';
import { planDocuments, stripMarks } from './html-host.js';
import { removeFromGate } from './hook.js';
import type { CliIo } from './main.js';
import { loadProject, refuseAbsence } from './project.js';
import { walk } from './pages.js';
import { CliError, Report, collapseLines, posixRelative } from './report.js';
import { applyFileEdits, formatDiff, unRewriteFile, type Edit } from './rewrite.js';
import { filesForGlobs } from './scan.js';
import { TS7_REFUSAL, isDialectFile, loadTypescript, matchGlob, scanSource, scriptKindFor } from './source-scan.js';
import { isStoreBacked } from './store.js';

const HISTORY_FILE = 'stet-history.json';
const HISTORY_LIMIT = 200;

export async function runEject(args: string[], io: CliIo): Promise<number> {
  const { values: opts, positionals } = parse(args, { write: 'boolean', verbose: 'boolean', ...ENV_OPTION });
  noPositionals(positionals, 'eject');
  const write = flag(opts, 'write');
  const verbose = flag(opts, 'verbose');

  const project = await loadProject(io, { env: argText(opts, 'env') });
  const report = new Report();
  try {
    const { config, descriptor, snapshot, store } = project;
    const storeBacked = isStoreBacked(project.environment.block);
    report.line(write ? 'eject --write: applying' : 'eject: plan only (pass --write to apply)');

    // The root layout is ALWAYS in the set — a JS host's `app/layout.js` is not
    // in the tsx globs, and a mounted provider needs the compiler at zero
    // accessor calls. An Astro host records none, and there is nothing to add.
    const fileSet = new Set<string>([
      ...filesForGlobs(io.cwd, config.managedSurfaces),
      ...(config.rootLayout === undefined ? [] : [config.rootLayout]),
    ]);
    const stetImports = stetImportRegex(config);
    // What eject writes or deletes itself, excluded everywhere a HOST file is
    // being counted: a host whose globs happen to cover the generated modules
    // must not read as having rewrites to reverse.
    const stetWritten = new Set<string>([
      config.readPath.file,
      config.codegen.dts,
      config.codegen.registry,
      config.codegen.defaults,
      ...(config.mountRoute === undefined ? [] : [config.mountRoute]),
    ]);
    // Every surface file's text, read ONCE: the probe below and the un-rewrite
    // loop want the same bytes, and a host is not asked for them twice.
    const surfaceText = new Map<string, string>();
    for (const file of fileSet) {
      const abs = join(io.cwd, file);
      if (!existsSync(abs)) continue; // a layout-less host's probed .tsx fallback
      surfaceText.set(file, readFileSync(abs, 'utf8'));
    }
    // The compiler-less probe that decides whether typescript is needed at all.
    // A register rewrite always inserts an import this pattern matches, and the
    // provider mount hangs off `import { CopyProvider } from '@getstet/stet/react'` — so
    // zero matching HOST files is provably nothing to un-rewrite.
    const importers = [...surfaceText]
      .filter(([file, text]) => !stetWritten.has(file) && stetImports.test(text))
      .map(([file]) => file);
    // typescript is loaded BEFORE anything is written — its absence must abort
    // at the plan, not halfway through — and only where there is something to
    // parse. The gate covers the WHOLE un-rewrite loop, not one load:
    // `scanSource` loads the compiler itself, per file.
    let ts: typeof import('typescript') | null = null;
    // On the static-HTML host there is no accessor call to reverse, no provider
    // to unwrap and no stet-written module to delete — so no compiler is asked
    // for, and the un-rewrite prints nothing at all rather than a line about
    // reversing nothing.
    if (isHtmlHost(config)) {
      // nothing to un-rewrite
    } else if (importers.length > 0) {
      try {
        ts = await loadTypescript();
      } catch (error) {
        // A resolved-but-API-less typescript is a different fault with its own
        // remedy; only an ABSENT compiler routes to the count-and-refuse path.
        if (!(error instanceof CliError) || error.message === TS7_REFUSAL) throw error;
        if (write) {
          throw new CliError(
            `eject --write cannot reverse the accessor calls without typescript: ${importers.length} ` +
              'file(s) import stet or the read path. Install it (npm i -D typescript) and re-run',
          );
        }
        report.line(
          'un-rewrite: unverifiable — typescript is not installed ' +
            `(${importers.length} file(s) import the accessor)`,
        );
      }
    } else if (!isHtmlHost(config)) {
      report.line('un-rewrite: nothing to reverse (no stet imports in the managed surfaces)');
    }

    // Resolve default-locale values (for the un-rewrite; derived included), and
    // build the multi-locale snapshot (pull's own-row rule) — a store-backed
    // host's non-default blocks must not be silently discarded.
    let rows: StoreRow[] = [];
    if (storeBacked) {
      const answer = await project.readRows();
      refuseAbsence(answer, 'eject');
      rows = answer.rows;
    }
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(descriptor.keys)) {
      const r = resolve(descriptor, snapshot, storeBacked ? rows : null, { key, locale: config.locales.default });
      if (r.value !== undefined) values[key] = r.value;
    }
    const merged = buildSnapshot(descriptor, snapshot, storeBacked ? rows : [], config);

    if (isHtmlHost(config)) {
      return ejectHtml({ io, config, descriptor, merged, write, report });
    }

    // PLAN the host source edits: un-rewrite the leaves, reverse the layout
    // mount. Skipped WHOLE where the probe found nothing to reverse, or where
    // the compiler is absent in plan-only mode.
    const edited = new Map<string, string>();
    const foreign: string[] = [];
    // Accumulated rather than printed in the loop, so a dialect host's wall of
    // refusals can collapse to one line. They flush as one block below, above
    // the closing lines instead of interleaved with the diffs.
    const refusals: string[] = [];
    let leaves = 0;
    if (ts !== null) {
      for (const [file, source] of surfaceText) {
        const abs = join(io.cwd, file);
        const result = await scanSource(file, source, { readPathImport: config.readPath.import });
        // `undefined === file` is never true, so an Astro host's absent layout
        // simply matches nothing and the unwrap path is unreachable.
        const isLayout = file === config.rootLayout;
        if (result.parseErrors) {
          refusals.push(`${file}: could not be parsed cleanly — not un-rewritten (the backstop refuses the dep drop if it still imports stet)`);
          continue;
        }
        if (result.accessorCalls.length === 0 && !isLayout) continue;

        const un = unRewriteFile(source, result.accessorCalls, values, [...result.stetImportSpans, ...result.copyDeclSpans]);
        for (const call of un.skipped) foreign.push(`${file}: left copy('${call.key}') untouched — a foreign copy binding, not stet's`);
        const extra: Edit[] = [];
        if (isLayout) {
          const unwrap = copyProviderUnwrap(ts, source, abs);
          if (unwrap) extra.push(unwrap);
          for (const span of result.resolvedMapDeclSpans) extra.push({ pos: span.pos, end: span.end, text: '' });
          for (const span of layoutOrphanImports(ts, source, abs, io.cwd, config)) extra.push({ pos: span.pos, end: span.end, text: '' });
        }
        const combined = [...un.edits, ...extra];
        if (combined.length === 0) continue;
        const out = applyFileEdits(source, combined);
        edited.set(file, out);
        leaves += result.accessorCalls.length - un.skipped.length;
        report.line(`${file}: un-rewrite${isLayout ? ' + unwrap CopyProvider' : ''}`);
        const diff = formatDiff(file, source, out);
        if (diff !== '') report.line(diff);
      }
      for (const line of collapseLines(
        refusals,
        `${refusals.length} file(s) could not be parsed cleanly — not un-rewritten ` +
          '(the backstop refuses the dep drop if they still import stet); run with --verbose to list them',
        verbose,
      )) {
        report.line(line);
      }
      for (const line of foreign) report.line(line);
      report.line(`un-rewrite: ${leaves} accessor call(s) reversed across ${edited.size} file(s)`);
    }

    // (3, cont.) Every OTHER stet-importing file init wrote. The lines DEFER
    // until the backstop has run: a deletion the host wired itself onto flips
    // to kept, and the plan must say so rather than promise a delete.
    const deletions = [config.readPath.file, config.codegen.dts, ...(config.mountRoute ? [config.mountRoute] : [])].filter(
      (rel) => existsSync(join(io.cwd, rel)),
    );

    // (4) History, per key, keyset-paged. Store-backed only.
    let history: Record<string, VersionRow[]> | null = null;
    if (storeBacked) {
      history = await exportHistory(store, Object.keys(descriptor.keys), report);
      report.line(`history: ${Object.keys(history).length} key(s) → ${HISTORY_FILE}`);
    }

    // BACKSTOP: the post-edit host must import no stet of any kind. This covers
    // every shape the recognizer misses — aliased imports, un-parsed leaves,
    // out-of-surface read-path consumers — and REFUSES before any write.
    const { survivors, markerCarriers, deletionConsumers } = backstop(
      io.cwd,
      config,
      edited,
      new Set(deletions),
      { deletions, stetWritten },
    );

    // A deletion some host file imports flips to KEPT: eject must never cut
    // loose a file that hand-wired itself onto the scaffold. The deletion block
    // prints here — both modes — so the manifest is complete on both sides even
    // when the run then refuses.
    // …EXCEPT where the un-rewrite could not run at all: with the loop gated
    // off, the consumers verdict read un-edited text and names imports the
    // un-rewrite itself would have removed, so a kept line there would be a
    // claim about a plan nobody verified. The honest output is the unverifiable
    // line and the survivors refusal. The zero-shape keeps its kept lines —
    // there the compiler was never needed, so the verdict stands.
    const unverifiable = ts === null && importers.length > 0;
    const kept = unverifiable ? [] : deletions.filter((rel) => (deletionConsumers.get(rel)?.length ?? 0) > 0);
    const removable = deletions.filter((rel) => !kept.includes(rel));
    for (const rel of removable) report.line(`delete ${rel}`);
    // A kept file that STILL imports stet joins the survivors and the existing
    // refusal aborts the run, so its line carries the un-wire remedy. One that
    // does not — a host's own hand-written read path — is simply retained, and
    // a run that then succeeds has nothing for the reader to re-run. The walk
    // excluded every deletion by name before reading its text, so each kept
    // path is regex-tested here directly rather than re-walked.
    for (const rel of kept) {
      const importedBy = deletionConsumers.get(rel) ?? [];
      const refuses = stetImports.test(edited.get(rel) ?? readFileSync(join(io.cwd, rel), 'utf8'));
      if (refuses) survivors.push(rel);
      const remedy = refuses
        ? importedBy.length === 1
          ? '; un-wire that import first, then re-run eject'
          : '; un-wire those imports first, then re-run eject'
        : '';
      report.line(`${rel}: kept — imported by ${importedBy.join(', ')}${remedy}`);
    }
    const stays = staysList(io.cwd, config);
    if (stays.length > 0) report.line(`stays (no stet imports): ${stays.join(', ')}`);
    reportContactsStay(config, report);

    // Under `--write` the refusal fires before a single byte is written. Under
    // plan-only it DEFERS until the full plan has printed — the guidance, hook
    // and dependency lines included — and then exits nonzero all the same.
    const refusal =
      survivors.length === 0
        ? null
        : new CliError(
            `eject found ${survivors.length} file(s) still importing stet after the un-rewrite — nothing was written. ` +
              'Resolve them (an aliased import, an unparseable file, or a consumer outside the managed surfaces) and re-run',
          );
    if (refusal !== null) {
      for (const s of survivors) report.line(`still imports stet: ${s}`);
      if (write) throw refusal;
    }

    // (1) The snapshot + regenerated defaults module.
    report.line(`snapshot: ${Object.keys(merged[config.locales.default] ?? {}).length} default key(s) → ${config.snapshotPath}, + ${config.codegen.defaults}`);
    if (write) {
      writeJsonDeterministic(join(io.cwd, config.snapshotPath), merged);
      writeText(join(io.cwd, config.codegen.defaults), generateDefaultsModule(merged));
      for (const [file, out] of edited) writeText(join(io.cwd, file), out);
      // `force` because a file already gone is a completed deletion: a racing
      // remove must not throw here, after the snapshot has been written.
      for (const rel of removable) rmSync(join(io.cwd, rel), { force: true });
      if (history !== null) writeJsonDeterministic(join(io.cwd, HISTORY_FILE), history);
    }

    // (5) The agent guidance goes FIRST, then the hook, then the dependency.
    // The order decides what a failure part-way leaves behind: this way the
    // worst state is guidance-gone-dependency-present, which a re-run heals,
    // rather than dependency-gone-guidance-still-routing agents at a stet that
    // is no longer installed.
    removeGuidanceBlocks(io.cwd, buildGuidanceBlock(config), write, report, markerCarriers);
    removeFromGate(io.cwd, write, report);
    dropDependency(io.cwd, write, report);

    if (refusal !== null) throw refusal;
    return report.emit(io);
  } catch (error) {
    // Work planned before a failure is shown, not swallowed — then the failure
    // propagates to the dispatch, which sets the exit code.
    report.emit(io);
    throw error;
  } finally {
    await project.dispose();
  }
}

/** Every enabled locale written back — the default block in full, others from their own rows (pull's rule). */
function buildSnapshot(descriptor: Descriptor, snapshot: Snapshot, rows: StoreRow[], config: { locales: { default: string; enabled: string[] } }): Snapshot {
  const merged: Snapshot = {};
  for (const locale of Object.keys(snapshot)) merged[locale] = { ...snapshot[locale] };
  const keys = Object.keys(descriptor.keys).sort();
  const defaultLocale = config.locales.default;
  for (const locale of config.locales.enabled) {
    const block = { ...(merged[locale] ?? {}) };
    for (const key of keys) {
      const live = activeRow(rows.filter((r) => r.key === key), locale);
      let value: unknown;
      if (locale === defaultLocale) {
        const r = resolve(descriptor, snapshot, rows, { key, locale });
        if (r.value === undefined) continue;
        value = r.value;
      } else if (live !== undefined) {
        value = live.value;
      } else {
        continue;
      }
      // The snapshot never carries a derived key — it is the source derivation runs from.
      if (descriptor.keys[key]?.derivesFrom === undefined) block[key] = value;
    }
    merged[locale] = block;
  }
  return merged;
}

/**
 * The `<CopyProvider>…</CopyProvider>` unwrap: its children, fragment-wrapped
 * unless a single child can stand exactly where the element did. A single child
 * bare is fine among JSX siblings, or when it is itself a JSX element in a
 * returned-expression slot — but a lone `{expr}` returned bare becomes an object
 * literal (`return {children}`), so it must be `<>{expr}</>`.
 */
function copyProviderUnwrap(ts: typeof import('typescript'), source: string, file: string): Edit | null {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  let found: TS.JsxElement | null = null;
  const visit = (node: TS.Node): void => {
    if (
      ts.isJsxElement(node) &&
      ts.isIdentifier(node.openingElement.tagName) &&
      node.openingElement.tagName.text === 'CopyProvider'
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found === null) return null;
  const element = found as TS.JsxElement;
  const inner = source.slice(element.openingElement.getEnd(), element.closingElement.getStart(sf));
  const meaningful = element.children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces));
  const parent = element.parent;
  const inJsxContainer = ts.isJsxElement(parent) || ts.isJsxFragment(parent);
  const single = meaningful.length === 1 ? meaningful[0] : undefined;
  const singleIsElement =
    single !== undefined && (ts.isJsxElement(single) || ts.isJsxSelfClosingElement(single) || ts.isJsxFragment(single));
  const needsFragment = meaningful.length !== 1 || (!inJsxContainer && !singleIsElement);
  const text = needsFragment ? `<>${inner}</>` : inner;
  return { pos: element.getStart(sf), end: element.getEnd(), text };
}

/**
 * The layout's now-orphan `descriptorJson` and `DEFAULTS` imports — the two
 * init added ONLY for the `resolveAll` call the un-rewrite drops. Left behind,
 * they are unused imports (TS6133 under a host's `noUnusedLocals`), so eject
 * removes them in the same batch. Both are relative specifiers resolved against
 * the layout's absolute directory, so the match holds under any cwd.
 */
function layoutOrphanImports(
  ts: typeof import('typescript'),
  source: string,
  absFile: string,
  cwd: string,
  config: { descriptorPath: string; codegen: { defaults: string } },
): { pos: number; end: number }[] {
  const sf = ts.createSourceFile(absFile, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, absFile));
  const targets = new Set([
    normalizeNoExt(join(cwd, config.descriptorPath)),
    normalizeNoExt(join(cwd, config.codegen.defaults)),
  ]);
  const spans: { pos: number; end: number }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    if (targets.has(normalizeNoExt(resolvePath(dirname(absFile), spec)))) {
      const end = source.charAt(stmt.getEnd()) === '\n' ? stmt.getEnd() + 1 : stmt.getEnd();
      spans.push({ pos: stmt.getStart(sf), end });
    }
  }
  return spans;
}

/** Every version of every key, over the keyset cursor, with a non-advance guard against a loop. */
async function exportHistory(
  store: Pick<StoreAdapter, 'history'>,
  keys: string[],
  report: Report,
): Promise<Record<string, VersionRow[]>> {
  const history: Record<string, VersionRow[]> = {};
  for (const key of keys) {
    const rows: VersionRow[] = [];
    let beforeId: number | undefined;
    for (;;) {
      const page = beforeId === undefined ? await store.history({ key, limit: HISTORY_LIMIT }) : await store.history({ key, beforeId, limit: HISTORY_LIMIT });
      if (!isHistoryPage(page)) {
        report.line(`history: ${key} unavailable — the store did not return history`);
        break;
      }
      rows.push(...page.rows);
      if (page.nextBeforeId === null) break;
      // A cursor that does not strictly retreat would loop forever — stop.
      if (beforeId !== undefined && page.nextBeforeId >= beforeId) {
        report.line(`history: ${key} paging did not advance — stopped`);
        break;
      }
      beforeId = page.nextBeforeId;
    }
    if (rows.length > 0) history[key] = rows;
  }
  return history;
}

function isHistoryPage(value: unknown): value is { rows: VersionRow[]; nextBeforeId: number | null } {
  return typeof value === 'object' && value !== null && 'rows' in value && 'nextBeforeId' in value;
}

/**
 * The whole-host sweep: no source file may still name a
 * `@getstet/stet`/`@getstet/stet/*` or read-path specifier once the un-rewrite
 * has run. `package.json` and JSON are excluded — the dep line is dropped
 * separately, and a `"@getstet/stet"` key there is not an import.
 *
 * The walk is `pages`' dirent walk, the one `filesForGlobs` already bounds
 * scan, register and eject's own surface set with: symlinked host files are
 * outside every walk stet makes, so a symlinked file, a symlinked directory and
 * a dangling link are not visited here either — a dangling source link used to
 * crash this sweep at its bare read — and a missing root yields nothing rather
 * than throwing.
 */
function backstop(
  cwd: string,
  config: { readPath: { import: string } },
  edited: Map<string, string>,
  deleted: Set<string>,
  consumers: { deletions: string[]; stetWritten: Set<string> },
): { survivors: string[]; markerCarriers: string[]; deletionConsumers: Map<string, string[]> } {
  const re = stetImportRegex(config);
  const survivors: string[] = [];
  // The THIRD channel: who imports a file eject plans to delete. The walk is
  // shared — enumerating and resolving every specifier is the new part — and it
  // reaches template-dialect files the survivors sweep skips, because the delta
  // quantifies over ANY host file and the first real host is Astro.
  const deletionConsumers = new Map<string, string[]>();
  const aliases = pathAliasMappings(cwd);
  const byTarget = new Map<string, string>();
  for (const rel of consumers.deletions) byTarget.set(normalizeNoExt(join(cwd, rel)), rel);
  // The second channel. `survivors` is consumed as the stet-import list and
  // refuses the run; a moved guidance block is a REPORT, so it cannot ride it.
  const markerCarriers: string[] = [];
  // The removal step's own two files, held by file IDENTITY rather than by
  // name: a case-insensitive filesystem answers to `Claude.md`, and a symlink
  // or a HARDLINK reaches the same file under a third name — each would
  // otherwise be reported as a moved block immediately after its own removal.
  const owned = new Set<string>();
  for (const name of GUIDANCE_NAMES) {
    const path = join(cwd, name);
    if (existsSync(path)) owned.add(fileIdentity(path));
  }
  walk(cwd, (abs) => {
    const name = basename(abs);
    const rel = posixRelative(cwd, abs);
    // Markdown is not in the import sweep's extensions and never will be, but
    // it is where a guidance block lives — so the walk that already visits
    // every file probes it, rather than a second walk of the whole host. The
    // two names at the eject root are the removal step's own.
    if (/\.md$/i.test(name)) {
      if (owned.has(fileIdentity(abs))) return;
      // A doc that cannot be read — a permission, a race — is not a carrier,
      // and it must not abort the run with a raw stack. The probe is a report
      // channel; nothing downstream depends on having read it.
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      if (hasGuidanceMarker(text)) markerCarriers.push(rel);
      return;
    }
    // Every extension node itself will load as a module: `.mts`/`.cts` are
    // as much host source as `.mjs`/`.cjs`, and a file eject never opens is
    // a file whose stet import it never sees.
    const isSource = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(name);
    // The dialects are read for the consumers channel only: the survivors
    // sweep does not parse one, but any of them can import the read path. The
    // set includes `.html` now, whose sweep finds no import specifier at all —
    // a plain page carries none — so the file is read and contributes nothing.
    const isDialect = isDialectFile(name);
    if (!isSource && !isDialect) return;
    // The walk's own post-edit text (:372's idiom), so an import the
    // un-rewrite already removed never counts as a consumer.
    const text = edited.get(rel) ?? readFileSync(abs, 'utf8');

    // A consumer is any importer stet did not write itself — eject deletes or
    // regenerates its own files, so those are never what keeps one alive.
    if (!consumers.stetWritten.has(rel)) {
      for (const spec of importSpecifiers(text)) {
        for (const candidate of resolveSpecifier(spec, rel, cwd, aliases)) {
          const deletion = byTarget.get(candidate);
          if (deletion === undefined || deletion === rel) continue;
          const found = deletionConsumers.get(deletion);
          if (found === undefined) deletionConsumers.set(deletion, [rel]);
          else if (!found.includes(rel)) found.push(rel);
        }
      }
    }

    if (!isSource) return;
    if (deleted.has(rel)) return;
    if (re.test(text)) survivors.push(rel);
  });
  return { survivors, markerCarriers, deletionConsumers };
}

/**
 * The import-position pattern for a stet specifier — `@getstet/stet`,
 * `@getstet/stet/*`, or the host's own read-path specifier. ONE construction
 * site, shared by the whole-host backstop and the compiler-less probe that
 * decides whether eject needs typescript at all, so the safety net and the gate
 * can never disagree about what a stet import looks like.
 */
function stetImportRegex(config: { readPath: { import: string } }): RegExp {
  const specifier = `(?:@getstet/stet(?:/[^'"]*)?|${escapeRegExp(config.readPath.import)})`;
  // ONE line break before the specifier is tolerated — a formatter that wraps
  // after `from` writes real host code, and missing it means the gate counts
  // zero on a file that does import stet. Never `[^;]*`, which would wander
  // through semicolon-free code into an unrelated string two functions down.
  return new RegExp(`(?:\\bfrom\\b|\\bimport\\b|\\brequire\\b)[^;\\n]*(?:\\n\\s*)?['"]${specifier}['"]`);
}

/**
 * Every module specifier a file names, in import position — `from`, `import`,
 * `require`. Text-level, so a specifier quoted inside a comment or a string
 * counts: deliberate, because the only direction that error runs is a deletion
 * kept and a run refused, never a host file cut loose.
 */
function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  const re = /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/**
 * What the plan says STAYS: the inert files eject leaves behind, none of which
 * imports stet. Naming them makes the manifest complete on both sides, so a
 * host reading a refusal still knows what a successful run would have left.
 */
/**
 * `eject` on the static-HTML host.
 *
 * There is nothing to un-rewrite, unwrap or delete: the marks ARE the whole
 * install. So each document is regenerated from the resolved snapshot — so the
 * text left behind is the committed truth rather than whatever the page last
 * held — and then every mark is stripped with its text kept. The guidance, hook
 * and dependency stages run exactly as on every host.
 *
 * A document it cannot regenerate refuses the run WHOLE: under `--write` before
 * a byte is written, and in plan-only after the full plan has printed, the way
 * the survivors refusal does.
 *
 * The repo-wide backstop does not run here — there is no stet import anywhere
 * to sweep for — so a guidance block a host moved into some other file is not
 * reported on this host. Bounded residue, stated.
 */
function ejectHtml(d: {
  io: CliIo;
  config: StetConfig;
  descriptor: Descriptor;
  merged: Snapshot;
  write: boolean;
  report: Report;
}): number {
  const { io, config, descriptor, merged, write, report } = d;
  const files = filesForGlobs(io.cwd, config.managedSurfaces).filter((f) => f.endsWith('.html'));
  const { writes, skips } = planDocuments(io.cwd, files, descriptor, merged, report);
  const first = skips[0];
  const refusal =
    first === undefined
      ? null
      : new CliError(
          `eject found ${skips.length} document(s) it cannot regenerate — ` +
            `${first.file}:${first.line} ${first.reason}; nothing was written`,
        );
  if (refusal !== null && write) throw refusal;

  const rebuilt = new Map(writes.map((w) => [w.rel, w.text]));
  const stripped = new Map<string, string>();
  for (const file of files) {
    const current = readFileSync(join(io.cwd, file), 'utf8');
    stripped.set(file, stripMarks(rebuilt.get(file) ?? current));
    report.line(`document: ${file} — every mark removed, the text stays`);
  }

  const keys = Object.keys(merged[config.locales.default] ?? {}).length;
  report.line(`snapshot: ${keys} default key(s) → ${config.snapshotPath}`);
  if (write && refusal === null) {
    writeJsonDeterministic(join(io.cwd, config.snapshotPath), merged);
    for (const [file, text] of stripped) writeText(join(io.cwd, file), text);
  }

  // What stays: the config, the descriptor and the snapshot. No registry on
  // this host, and no migration copies unless the operator put them there.
  const stays = [CONFIG_FILE, config.descriptorPath, config.snapshotPath].filter((rel) =>
    existsSync(join(io.cwd, rel)),
  );
  if (stays.length > 0) report.line(`stays (no stet imports): ${stays.join(', ')}`);
  reportContactsStay(config, report);

  // The guidance goes first, then the hook, then the dependency — the same
  // order, for the same reason, as on every other host.
  removeGuidanceBlocks(io.cwd, buildGuidanceBlock(config), write, report, []);
  removeFromGate(io.cwd, write, report);
  dropDependency(io.cwd, write, report);

  if (refusal !== null) throw refusal;
  return report.emit(io);
}

/**
 * The contacts tables, where the project has them: eject drops no table, so
 * the people a form recorded stay in the database, and the line says how to
 * write one person to a file before the dependency goes.
 */
function reportContactsStay(config: StetConfig, report: Report): void {
  if (config.contacts === undefined && !isStoreBacked(selectStoreBlock(config, undefined).block)) return;
  report.line(
    'stays in the database: the contacts tables (stet_groups, stet_contacts, stet_group_memberships, stet_suppressions, ' +
      'stet_erasures) — eject drops no table; run stet contacts export <email> before --write to write a person to a file',
  );
}

function staysList(
  cwd: string,
  config: { descriptorPath: string; snapshotPath: string; codegen: { registry: string } },
): string[] {
  const candidates = [CONFIG_FILE, config.descriptorPath, config.snapshotPath, config.codegen.registry];
  const stays = candidates.filter((rel) => existsSync(join(cwd, rel)));
  if (existsSync(join(cwd, HOST_MIGRATIONS))) stays.push(`${HOST_MIGRATIONS.split(sep).join('/')}/`);
  return stays;
}

/**
 * The one true path behind a name, or `null` where nothing resolves.
 *
 * `realpathSync.native` rather than the JS one: only the OS call folds a
 * case-insensitive filesystem's `Claude.md` onto the `CLAUDE.md` it is, which
 * is what makes an identity compare hold where a name compare does not.
 */
function canonical(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** Drop `@getstet/stet` from the host package.json, or print the manual step where there is none. */
function dropDependency(cwd: string, write: boolean, report: Report): void {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) {
    report.line('remove the stet dependency by hand: npm rm @getstet/stet');
    return;
  }
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  let present = false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps !== null && typeof deps === 'object' && '@getstet/stet' in (deps as Record<string, unknown>)) {
      present = true;
      if (write) delete (deps as Record<string, unknown>)['@getstet/stet'];
    }
  }
  if (!present) {
    report.line('the stet dependency is not in package.json — remove it by hand if a lockfile still carries it');
    return;
  }
  report.line('drop the stet dependency from package.json');
  if (write) writeText(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * The agent-guidance block gone from the two agent-instruction files at the
 * eject root, and every marker found ELSEWHERE named rather than chased.
 *
 * This deliberately diverges from `removeHook`'s leave-a-differing-hook posture,
 * and the reason is what differs: the hook is host-executable code whose edited
 * form may carry the host's OWN lines, while the guidance span is stet-authored
 * prose inside stet's own markers — its removal is printed line-counted and
 * `(edited)`-marked before `--write` applies it, and leaving it means a file
 * keeps instructing agents toward a dependency that is gone.
 */
function removeGuidanceBlocks(
  cwd: string,
  block: string,
  write: boolean,
  report: Report,
  markerCarriers: string[],
): void {
  // BOTH names are resolved before anything is planned, because the two can be
  // one file and the answer depends on knowing that: deleting the real one
  // would leave the other name dangling, and a plan that says `delete AGENTS.md`
  // while `CLAUDE.md` silently becomes a broken link is worse than not deleting.
  const root = canonical(cwd) ?? cwd;
  const targets = GUIDANCE_NAMES.map((name) => {
    const path = join(cwd, name);
    return { name, path, real: canonical(path), id: existsSync(path) ? fileIdentity(path) : null };
  });
  // Identity, not resolved path: two HARDLINKS have different realpaths and are
  // still one file, and deleting either would leave the other holding a block
  // this run claimed to have removed.
  const aliased = new Set(
    targets.filter((a) => a.id !== null && targets.some((b) => b !== a && b.id === a.id)).map((a) => a.id),
  );

  const seen = new Set<string>();
  for (const { name, path, real, id } of targets) {
    let isLink: boolean;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      continue; // nothing at that name
    }
    // Two names on ONE file plan once — a second pass would re-report a file
    // the first already handled.
    if (seen.has(id ?? path)) continue;
    seen.add(id ?? path);

    // A link is named WITH its target, so the host knows which file the plan is
    // actually about — the write follows the link, and the target may sit
    // outside the project entirely. The target is shown relative to the
    // CANONICAL cwd: `realpathSync` resolved it, and on a host whose root is
    // itself reached through a link (macOS `/var` → `/private/var`) a raw
    // `relative(cwd, …)` climbs out of the project and back down.
    const shown = isLink && real !== null ? `${name} → ${posixRelative(root, real) || real}` : name;

    const plan = planGuidanceRemoval(path, block);
    if (plan.status === 'absent') continue;
    if (plan.status === 'skip') {
      // Under `--write` a skip is a removal that did NOT happen, so the block
      // is still there instructing agents toward a dependency this run drops —
      // the same false-success an outright write failure would be. Plan-only
      // changes nothing by definition, so there it is a line.
      if (write) report.error('config', `${shown}: ${plan.note}`);
      else report.line(`${shown}: ${plan.note}`);
      continue;
    }
    if (plan.result === null) {
      // Never delete through a link: `rmSync` would remove the LINK and leave
      // the block alive in its target, making the plan line a false claim.
      if (isLink) {
        report.line(`${shown}: a symlink whose target holds only the stet agent-guidance block — remove it by hand`);
        continue;
      }
      // Nor delete a file the OTHER name also reaches: which of the two should
      // survive is the host's layout decision, not eject's.
      if (id !== null && aliased.has(id)) {
        const both = targets.filter((t) => t.id === id).map((t) => t.name).join(' and ');
        report.line(`${both} are one file holding only the stet agent-guidance block — remove it by hand`);
        continue;
      }
      // The line prints AFTER the deletion, never before: a plan line for a
      // removal that then failed is a false claim about the host's own files.
      if (write) {
        try {
          rmSync(path);
        } catch (error) {
          // An ERROR, not a line: exiting 0 while a file still instructs agents
          // toward a dependency that is gone is the false-success this whole
          // step exists to prevent. The rest of eject still completes.
          report.error('config', `${name}: could not be deleted (${errorCode(error)}) — remove it by hand`);
          continue;
        }
      }
      report.line(`delete ${name} (it holds only the stet agent-guidance block)`);
      continue;
    }
    if (write) {
      try {
        writeText(path, plan.result);
      } catch (error) {
        report.error(
          'config',
          `${shown}: could not remove the stet agent-guidance block (${errorCode(error)}) — remove it by hand`,
        );
        continue;
      }
    }
    report.line(
      `remove the stet agent-guidance block from ${shown} (${plan.lines} lines)${plan.edited ? ' (edited)' : ''}`,
    );
  }
  // Named, never chased: a block a host moved or nested is theirs to remove.
  for (const rel of markerCarriers) {
    report.line(
      `${rel}: carries the stet agent-guidance markers — remove the block by hand ` +
        `(eject removes it from ${GUIDANCE_NAMES.join(' and ')} at the eject root only)`,
    );
  }
}


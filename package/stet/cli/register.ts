/**
 * `stet register --from scan` — adopt scanned literals: add the descriptor key,
 * seed its default through the save gate, and rewrite the consuming leaf to the
 * ambient accessor. It ONLY ADDS keys — it never reads or writes the store and
 * never alters a published value, so a branch run cannot damage what is live.
 *
 * It re-scans (so a leaf already rewritten to an accessor call is a no-op —
 * idempotent), resolves key collisions with a `_2`/`_3` suffix, and refuses to
 * rewrite what it cannot do safely: a client leaf with no `CopyProvider` mounted
 * (which would throw at render), a scope that already binds a foreign `copy`, a
 * client literal with no component body, or an ambiguous un-directived
 * App-Router component. The descriptor and default are written either way; the
 * host source edit is gated on `--write` and shown as a diff first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type * as TS from 'typescript';

import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, EMAIL_TARGET, type Descriptor, type Target } from '../src/types.js';
import { parse, flag, text as argText, noPositionals } from './args.js';
import {
  asUpdate,
  planJson,
  planRepoForms,
  planWrite,
  rethrowBatchFailure,
  writePlanned,
  writeText,
} from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import {
  CONFIG_FILE,
  isHtmlHost,
  loadConfig,
  normalizeNoExt,
  pathAliasMappings,
  resolveSpecifier,
  type StetConfig,
} from './config.js';
import { filesForGlobs } from './files.js';
import { planHtmlRegister } from './html-host.js';
import type { CliIo } from './main.js';
import { clip, collapseLines, CliError, Report, UsageError } from './report.js';
import { applyFileEdits, formatDiff, planRewrite, type Edit } from './rewrite.js';
import {
  freeKey,
  isJsxFile,
  matchGlob,
  scanModule,
  scanSource,
  type Span,
} from './source-scan.js';
import { classifyAdoption } from './scan.js';
import { validateValue } from './validate.js';

/** App-Router files that are server components by default — every other .tsx is ambiguous without a directive. */
const ROUTE_FILES = new Set([
  'page',
  'layout',
  'template',
  'default',
  'loading',
  'error',
  'global-error',
  'not-found',
  'route',
]);

export async function runRegister(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { from: 'string', write: 'boolean', kind: 'string', verbose: 'boolean' });
  noPositionals(positionals, 'register');
  if (argText(values, 'from') !== 'scan') {
    throw new UsageError('stet register --from scan [--write] [--kind server|client] [--verbose]');
  }
  const forcedKind = argText(values, 'kind');
  if (forcedKind !== undefined && forcedKind !== 'server' && forcedKind !== 'client') {
    throw new UsageError('stet register --kind must be "server" or "client"');
  }
  const write = flag(values, 'write');
  const verbose = flag(values, 'verbose');

  const config = loadConfig(io.cwd);
  const report = new Report();

  // The html branch runs FIRST — ahead of the alias guard, which throws on the
  // defaulted `@/lib/content` of a config that writes no read path, and ahead of
  // the surface loop, which would hand every `.html` to a compiler that refuses
  // it. Nothing on this path loads `typescript`, and `--kind` selects nothing.
  if (isHtmlHost(config)) {
    const htmlDescriptor = descriptorOf(config, io.cwd, report);
    if (!htmlDescriptor) return report.emit(io);
    const htmlSnapshot = snapshotOf(config, io.cwd, report);
    if (!htmlSnapshot) return report.emit(io);
    return registerHtml({ io, config, descriptor: htmlDescriptor, snapshot: htmlSnapshot, write, report });
  }

  // Before ANY write, the descriptor and snapshot included: a rewrite that
  // inserts an import the host cannot resolve breaks every file it touched.
  if (write) refuseUnresolvableAlias(io.cwd, config);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io);
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io);

  let added = 0;
  // Leaf rewrites shown but not applied — the only thing `--write` has left to
  // do. A module-shaped adoption completes on the plain run, so a run that
  // adopted only modules has nothing pending and must not say it has.
  let printedDiffs = 0;

  // What the JSX walk parsed and CLAIMED, per file. A file both declarations
  // match is parsed once and every literal is owned by exactly one
  // classification; `null` marks a file the parser refused, which the module
  // loop then leaves alone rather than refusing it a second time.
  const walked = new Map<string, { sourceFile: TS.SourceFile; claimed: Span[] } | null>();

  // ONE collection across BOTH loops, flushed below the adopted lines: a dialect
  // host refuses the same files in the surface loop that the module loop would
  // meet, and the walked map above already yields a single refusal per file.
  const refusals: string[] = [];

  for (const file of filesForGlobs(io.cwd, config.managedSurfaces)) {
    const source = readFileSync(join(io.cwd, file), 'utf8');
    const result = await scanSource(file, source, { readPathImport: config.readPath.import });
    if (result.parseErrors) {
      refusals.push(`${file}: could not be parsed cleanly — reported, not adopted`);
      walked.set(file, null);
      continue;
    }
    // Recorded BEFORE the early returns below: this walk classified the file's
    // JSX positions whether or not it went on to adopt any of them.
    walked.set(file, { sourceFile: result.sourceFile, claimed: result.claimed });
    if (result.literals.length === 0) continue;

    const target = targetFor(file, config);
    const kind = kindFor(file, result.hasUseClient, config, forcedKind);
    if (kind === null) {
      report.warn('scan', `${file}: ambiguous — an un-directived App-Router component; re-run with --kind server|client`);
      continue;
    }
    if (kind === 'client' && !providerMounted(io.cwd, config)) {
      for (const literal of result.literals) {
        report.warn(
          'scan',
          `${file}: ${JSON.stringify(literal.proposedKey)} needs a client rewrite, but no CopyProvider is mounted — ` +
            'mount CopyProvider in the root layout first (stet init can do it)',
        );
      }
      continue;
    }

    const edits: Edit[] = [];
    for (const literal of result.literals) {
      const key = freeKey(descriptor, literal.proposedKey);
      // Tentatively add so the save gate can read the key's rules; revert on any refusal.
      descriptor.keys[key] = { shape: 'text', target };
      (snapshot['default'] ??= {})[key] = literal.text;

      if (!validateValue(descriptor, snapshot, key, literal.text, 'default', report)) {
        delete descriptor.keys[key];
        delete snapshot['default']?.[key];
        continue;
      }

      const planned = planRewrite(source, literal, key, kind, config.readPath.import);
      if (planned.skipped !== undefined) {
        delete descriptor.keys[key];
        delete snapshot['default']?.[key];
        report.warn('scan', `${file}: ${JSON.stringify(key)} ${skipReason(planned.skipped)} — adopt by hand`);
        continue;
      }
      edits.push(...planned.edits);
      added += 1;
    }

    if (edits.length === 0) continue;
    const edited = applyFileEdits(source, edits);
    printedDiffs += 1;
    report.line(formatDiff(file, source, edited));
    if (write) {
      writeText(join(io.cwd, file), edited);
      report.line(`${file}: rewrote ${edits.length === 1 ? '1 edit' : `${edits.length} edits`}`);
    }
  }

  // The SECOND loop: the declared copy modules. `register` re-walks the host
  // itself and never consumes scan's output, so these files are unreachable
  // without it. It reuses the descriptor-entry and seeded-default machinery
  // above and the shared write block below, and NOTHING else — no component
  // kind, no provider check, no import insertion, and above all no rewrite. A
  // copy module is adopted as RECORD: it keeps its literals, and byte-equality
  // against the snapshot is what the drift gate then watches.
  for (const file of filesForGlobs(io.cwd, config.copyModules)) {
    const handoff = walked.get(file);
    if (handoff === null) continue; // already refused in the surface loop; the flush reports it once
    const source = readFileSync(join(io.cwd, file), 'utf8');
    // The handoff carries the tree parsed BEFORE the surface loop's own
    // `--write` may have rewritten this file, so the tree is stale relative to
    // disk. That is safe rather than merely tolerated: `scanModule` reads the
    // TREE's own text wherever it reads by position, so its offsets and its
    // bytes always come from the same document. Re-walking instead would be
    // worse — the rewrite just wrote fresh `copy('key')` calls whose key
    // arguments would need fresh claims, re-opening the accessor-key leak on
    // exactly the files most likely to have one.
    const result = await scanModule(file, source, handoff);
    if (result.parseErrors) {
      refusals.push(`${file}: could not be parsed cleanly — reported, not adopted`);
      continue;
    }
    const target = targetFor(file, config);

    for (const literal of result.literals) {
      // A template-shaped finding carries no key to trust, and nothing else
      // reaches the descriptor write.
      if (literal.shape !== 'property' && literal.shape !== 'plain') continue;

      // OWN NAME ONLY — `freeKey` is never called for a module shape. A
      // suffixed key forks the registry from the module it was read out of,
      // silently, and every later comparison is against a name the module does
      // not use.
      const key = literal.proposedKey;
      const verdict = classifyAdoption(descriptor, snapshot, key, literal.text);
      // Idempotence, mechanized rather than asserted: run two classifies
      // everything adopted and adds nothing.
      if (verdict === 'adopted') continue;
      if (verdict === 'diverged') {
        // Reported, never adopted and never written. `register` only ADDS keys,
        // and with `freeKey` gone the assignment below would otherwise replace
        // an existing definition outright — these verdicts are the only guard.
        report.warn(
          'scan',
          `${file}: ${key} diverged from the snapshot default — register only adds keys; resolve the difference by hand`,
        );
        continue;
      }

      // Tentatively add so the save gate can read the key's rules; revert on any refusal.
      descriptor.keys[key] = { shape: 'text', target };
      (snapshot['default'] ??= {})[key] = literal.text;
      if (!validateValue(descriptor, snapshot, key, literal.text, 'default', report)) {
        delete descriptor.keys[key];
        delete snapshot['default']?.[key];
        continue;
      }
      // One line per adopted key, never a diff: there is no source edit to show.
      report.line(`adopted ${key} = ${clip(literal.text, ADOPTED_EXCERPT)}`);
      added += 1;
    }
  }

  for (const line of collapseLines(
    refusals,
    `${refusals.length} file(s) could not be parsed cleanly — reported, not adopted; run with --verbose to list them`,
    verbose,
  )) {
    report.line(line);
  }

  if (added > 0) {
    // ONE batch, with rollback: the descriptor, the snapshot and the codegen
    // modules land together or not at all. The codegen regenerates here so the
    // `copy('new_key')` leaf register just wrote typechecks immediately — the
    // Accessor sig is narrow (`ContentKey`), so a stale `.d.ts` would red the
    // host tsc until a separate `stet upgrade`.
    try {
      writePlanned(planRepoForms(io.cwd, config, descriptor, snapshot, report));
    } catch (error) {
      rethrowBatchFailure('stet register', error);
    }
    report.line(`wrote ${config.descriptorPath}, ${config.snapshotPath} and the codegen modules: ${added} key${added === 1 ? '' : 's'} added`);
  }
  // The closing line turns on whether there were LEAF EDITS, not on `--write`:
  // a `--write` run that adopted only module shapes applied nothing, and
  // "applied" is the very confusion the record line exists to remove.
  report.line(
    added === 0
      ? 'register: nothing to adopt'
      : printedDiffs === 0
        ? 'register: adopted as record — there are no source edits to apply'
        : write
          ? 'register: applied'
          : 'register: run with --write to apply the leaf edits',
  );
  return report.emit(io);
}

/**
 * The import `register` is about to write into host source has to resolve.
 * `init` records `readPath.import` from a probe that may have found no alias at
 * all and defaulted to `@/lib/content`; applying a rewrite around that
 * specifier leaves every touched file importing a path that maps nowhere, and
 * the host learns at its next build. The diff-only path never guards — a
 * printed diff misleads nobody.
 */
function refuseUnresolvableAlias(cwd: string, config: StetConfig): void {
  const spec = config.readPath.import;
  // Alias-shaped only: an `@scope/pkg` npm name starts with `@` but not `@/`,
  // and relative and bare specifiers resolve without any mapping.
  if (!spec.startsWith('@/') && !spec.startsWith('~/')) return;
  // Covered means RESOLVED ONTO THE READ PATH, never merely prefix-matched: a
  // host declaring `@/*: ['./src/*']` with its read path at `lib/content.ts`
  // matches the prefix and lands somewhere else entirely, and every rewritten
  // file would import a module that is not there.
  const target = normalizeNoExt(join(cwd, config.readPath.file));
  if (resolveSpecifier(spec, config.readPath.file, cwd, pathAliasMappings(cwd)).includes(target)) return;
  throw new CliError(
    `readPath.import is '${spec}', but no tsconfig/jsconfig path mapping in this project resolves it to ` +
      `${config.readPath.file} (extends not followed) — every rewritten file would import a path that ` +
      `resolves nowhere. Declare the alias in the project file, or edit readPath.import in ${CONFIG_FILE}`,
  );
}

/** The accessor kind, or null when an un-directived App-Router component is ambiguous. */
function kindFor(
  file: string,
  hasUseClient: boolean,
  config: StetConfig,
  forced: string | undefined,
): 'server' | 'client' | null {
  // A non-JSX file (a `.ts`/`.js` mailer) has no client-component form on ANY
  // router — checked FIRST, so a Pages host's email mailer is still server (and
  // reaches EMAIL_TARGET), not client-skipped for want of a provider.
  if (!isJsxFile(file)) return 'server';
  // Only `pages` forces the client form: a Pages-Router file is client-rendered
  // with no directive to detect it by. `app` and `astro` both fall through to
  // the directive and the route-file test.
  if (config.router === 'pages' || hasUseClient) return 'client';
  if (isRouteFile(file)) return 'server';
  if (forced === 'server' || forced === 'client') return forced;
  return null;
}

function isRouteFile(file: string): boolean {
  return ROUTE_FILES.has(basename(file).replace(/\.(tsx|jsx|ts|js)$/, ''));
}

/** Enough of an adopted default to recognize it on the line that reports it. */
const ADOPTED_EXCERPT = 60;

/**
 * `register` on the static-HTML host: every located proposal becomes a key and
 * a mark, in one batch with the descriptor and the snapshot.
 *
 * The plain run writes NOTHING — a departure from the JavaScript branch, whose
 * descriptor and snapshot land either way. A descriptor entry written without
 * its mark is half a batch, and the next `check` would report every such key as
 * marked in no document.
 */
function registerHtml(d: {
  io: CliIo;
  config: StetConfig;
  descriptor: Descriptor;
  snapshot: Snapshot;
  write: boolean;
  report: Report;
}): number {
  const { io, config, descriptor, snapshot, write, report } = d;
  const plan = planHtmlRegister({
    cwd: io.cwd,
    files: filesForGlobs(io.cwd, config.managedSurfaces),
    descriptor,
    snapshot,
    report,
  });
  for (const document of plan.edited) {
    if (document.diff !== '') report.line(document.diff);
  }
  if (plan.marked === 0) {
    report.line('register: nothing to adopt');
    return report.emit(io);
  }
  if (!write) {
    report.line(
      `register: run with --write to apply ${plan.marked} mark${plan.marked === 1 ? '' : 's'} ` +
        `across ${plan.edited.length} document${plan.edited.length === 1 ? '' : 's'}`,
    );
    return report.emit(io);
  }
  try {
    writePlanned([
      asUpdate(planJson(join(io.cwd, config.descriptorPath), descriptor, config.descriptorPath)),
      asUpdate(planJson(join(io.cwd, config.snapshotPath), snapshot, config.snapshotPath)),
      ...plan.edited.map((e) => asUpdate(planWrite(e.abs, e.text, e.rel))),
    ]);
  } catch (error) {
    rethrowBatchFailure('stet register --write', error);
  }
  report.line(
    `wrote ${config.descriptorPath}, ${config.snapshotPath} and ${plan.edited.length} ` +
      `document${plan.edited.length === 1 ? '' : 's'}: ${plan.added} key${plan.added === 1 ? '' : 's'} added, ` +
      `${plan.shared} shared`,
  );
  report.line('register: applied');
  return report.emit(io);
}

/**
 * The target a file's keys take. Derived from the SURFACE the file matched — an
 * email surface gets email rules — never from a send-arg heuristic, which
 * misfires on `res.send`/`socket.send`. A copy module declared into the email
 * surfaces takes the email target and its validation rules by the same rule.
 */
function targetFor(file: string, config: StetConfig): Target {
  return config.emailSurfaces.some((g) => matchGlob(g, file)) ? EMAIL_TARGET : DEFAULT_TARGET;
}

/** The live grep P1-H uses: a `CopyProvider` import from `@getstet/stet/react` in the root layout. */
function providerMounted(cwd: string, config: StetConfig): boolean {
  // No recorded root layout is no layout, and no layout is no provider — an
  // Astro host, whose site layout is a `.astro` template.
  if (config.rootLayout === undefined) return false;
  const path = join(cwd, config.rootLayout);
  if (!existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');
  return /import\s*\{[^}]*\bCopyProvider\b[^}]*\}\s*from\s*['"]@getstet\/stet\/react['"]/.test(source);
}

function skipReason(skip: 'no-component-body' | 'copy-collision'): string {
  return skip === 'copy-collision'
    ? 'a foreign `copy` is already bound in scope'
    : 'a client literal with no enclosing component body';
}

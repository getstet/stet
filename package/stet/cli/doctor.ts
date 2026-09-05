/**
 * `stet doctor` — what mode this host is in, and whether everything it needs
 * is where it should be. "No database" is one of the answers, never a failure:
 * snapshot-only is a supported mode, and a tool that scolds a project for
 * being in it teaches its operator to ignore the tool.
 *
 * Exit 0 unless the descriptor cannot be parsed — with no descriptor there is
 * no project to diagnose. Everything else, including an unreachable store and
 * a stale generated file, reports as a warning.
 *
 * `--report` emits the pasteable block the issue template asks for: a tool
 * that writes migrations into strangers' repos generates exactly one kind of
 * issue, and each costs half an hour of triage without one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';

import type * as TS from 'typescript';

import { resolve } from '../src/resolve.js';
import { ENV_OPTION, flag, noPositionals, parse, text } from './args.js';
import { check } from './check.js';
import { CONFIG_FILE, isHtmlHost } from './config.js';
import { hooksDir } from './hook.js';
import { packageVersion } from './installed.js';
import type { CliIo } from './main.js';
import { readProjectMeta } from './meta.js';
import { loadProject, type LoadedProject } from './project.js';
import { Report, UsageError, formatFinding, posixRelative, shapeOf } from './report.js';
import { TS7_REFUSAL, carriesToken, loadTypescript, mentionsToken, scriptKindFor } from './source-scan.js';
import { isStoreBacked } from './store.js';

export async function runDoctor(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, {
    ...ENV_OPTION,
    report: 'boolean',
    url: 'string',
    key: 'string',
    json: 'boolean',
  });
  noPositionals(positionals, 'doctor');
  const url = text(values, 'url');
  const key = text(values, 'key');
  if ((url === undefined) !== (key === undefined)) {
    throw new UsageError('--url and --key are one check and go together');
  }

  // A broken store block is diagnosed here rather than exited on — reporting
  // it IS this command's job.
  const project = await loadProject(io, { tolerateStoreConfig: true, env: text(values, 'env') });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    const { config } = project;

    const configPath = join(io.cwd, CONFIG_FILE);
    report.line(
      existsSync(configPath)
        ? `config: ${CONFIG_FILE} found in ${io.cwd}`
        : `config: no ${CONFIG_FILE} in ${io.cwd} — every setting defaulted, mode snapshot-only`,
    );
    report.line('  (the config is read from the working directory only; there is no upward search)');
    report.line(`descriptor: ${config.descriptorPath}, ${Object.keys(project.descriptor.keys).length} keys`);
    if (isHtmlHost(config)) {
      report.line('host: html — the marked documents are the rendered form; publish = commit');
    }

    // The descriptor, snapshot, currency and generated-file sections are `stet
    // check`'s own output, folded in at warn: one implementation of the rules,
    // two contracts over them.
    const checks = new Report();
    check(config, io.cwd, checks);
    report.absorb(checks, 'warn');

    environmentsSection(project, report);
    await wrapperChainSection(io, project, report);
    await storeSection(io, project, report);
    // On any host whose publish IS a commit, a checkout outside git has no way
    // to publish at all. Never on a store-backed host, where publish is a store
    // write and git is beside the point.
    if (!isStoreBacked(project.environment.block) && hooksDir(io.cwd) === null) {
      report.warn('config', 'git: not a repository — publish cannot be a commit; run git init');
    }
    if (url !== undefined && key !== undefined) await liveCheck(io, project, report, url, key);

    if (flag(values, 'report')) {
      const { name, block: selected } = project.environment;
      const block = [
        '```',
        `stet ${packageVersion()} · node ${process.version} · ${process.platform}`,
        `project: ${config.project}`,
        // The selected block, not the default one: a paste that reads `store:
        // pg` under `--env staging` sends a triager at the wrong database.
        ...(name === 'default' ? [] : [`environment: ${name}`]),
        `store: ${selected?.adapter ?? 'none (snapshot-only)'}`,
        ...(isHtmlHost(config) ? ['host: html'] : []),
        `descriptor: ${config.descriptorPath} · snapshot: ${config.snapshotPath}`,
        // Through the one formatter, not a second copy of its template: this
        // block is store-controlled text on a human channel, and it travels
        // further than the terminal — an operator pastes it into an issue.
        ...report.findings.map(formatFinding),
        '```',
      ];
      report.line('');
      for (const line of block) report.line(line);
      // The block is what the issue template asks a reporter to paste, so
      // `--json --report` has to carry it too — otherwise the machine-readable
      // form is the one that cannot be pasted.
      report.data('report', block.join('\n'));
    }

    // Every finding here is informational: a mode is not a fault, and this
    // command's contract is to report rather than to gate.
    return report.emit(io, { json: flag(values, 'json') });
  } finally {
    await project.dispose();
  }
}

/**
 * The wrapper claim, checked against the render path (§13.1e).
 *
 * A template declares `wrapperProvides: ['unsubscribe_url']` and the marketing
 * save gate believes it — that is the whole point of the field, and it is also
 * its weakness: nothing at save time can see whether the wrapper really emits
 * the token. The render pointer makes the check cheap, because it names the
 * root of the chain. So each declared token is looked for across the pointer's
 * file and its relative-import closure, and a token found nowhere is reported
 * with the files that were searched.
 *
 * It warns and never fails: stet can see that a token is absent from the source
 * it can reach, and cannot know that a wrapper three layers of indirection away
 * does not produce it.
 */
async function wrapperChainSection(io: CliIo, project: LoadedProject, report: Report): Promise<void> {
  const templates = project.descriptor.templates ?? {};
  const pointered = Object.keys(templates)
    .sort()
    .filter((name) => templates[name]?.render !== undefined);
  if (pointered.length === 0) return;

  const ts = await chainCompiler(report);

  for (const name of pointered) {
    const entry = templates[name];
    const pointer = entry?.render;
    if (entry === undefined || pointer === undefined) continue;
    const declared = entry.wrapperProvides ?? [];

    const chain = ts === null ? pointerOnly(io.cwd, pointer.file) : importClosure(ts, io.cwd, pointer.file);
    if (chain.files.length === 0) {
      report.line(`wrapper chain (${name}): ${pointer.file} could not be read`);
      continue;
    }
    // Parsed where the compiler is there, so a token named only in a comment
    // satisfies nothing; grepped where it is not, over the one file this mode
    // can read.
    const carries = (token: string): boolean =>
      chain.files.some((f) =>
        ts === null ? mentionsToken(f.text, token) : carriesToken(ts, join(io.cwd, f.rel), f.text, token),
      );

    const missing = declared.filter((token) => !carries(token));
    // A chain that stopped somewhere — no compiler to walk it, or a package
    // import whose files are not the host's source — cannot say a token is
    // absent, only that it is not in what was read.
    const unchecked = ts === null || chain.boundary;
    // The clause explains a token the walk could not REACH, so only a walk that
    // crossed a boundary earns it: the compiler-less mode reads one file and
    // gives its own reason on the degraded line, and a fully walked chain
    // reaches no boundary to blame — there the token is honestly unfound.
    const atBoundary = ts !== null && chain.boundary;
    report.line(
      `wrapper chain (${name}): ${chain.files.length} file(s), ${declared.length} declared token(s)` +
        `${missing.length === 0 ? '' : `, ${missing.length} ${unchecked ? 'unchecked' : 'unfound'}`}` +
        `${missing.length === 0 || !atBoundary ? '' : ', because the chain reaches an import it does not follow'}`,
    );

    // A run that claims nothing it could not check: the wrapper carrying the
    // token is exactly the file this chain did not open, so the warn would fire
    // on healthy projects. The postal check below follows the same rule.
    if (unchecked) continue;

    for (const token of missing) {
      report.warn(
        'email',
        `${name}: wrapperProvides declares ${JSON.stringify(token)}, and it appears nowhere in the render chain ` +
          `(${chain.files.map((f) => f.rel).join(', ')}) — the save gate accepts the claim on its word, so either ` +
          'the wrapper emits it under another name, or the claim is wrong',
        name,
      );
    }

    // §13.1e's own warn: a marketing send with no postal address anywhere. Both
    // halves have to be absent — the wrapper may carry it, or the footer key.
    if (entry.class !== 'marketing') continue;
    if (carries(POSTAL_TOKEN)) continue;
    const footer = resolve(project.descriptor, project.snapshot, null, {
      key: FOOTER_ADDRESS_KEY,
      locale: project.config.locales.default,
    });
    if (typeof footer.value === 'string' && footer.value.trim() !== '') continue;
    report.warn(
      'email',
      `${name}: a marketing template whose render chain carries no ${POSTAL_TOKEN} and whose ` +
        `${FOOTER_ADDRESS_KEY} is empty — a physical postal address is required in commercial email. ` +
        `Set ${FOOTER_ADDRESS_KEY}, or have the wrapper emit the address`,
      name,
    );
  }
}

/** The postal token a marketing wrapper is expected to emit. */
const POSTAL_TOKEN = 'postal_address';

/** The descriptor key that carries the address where no wrapper does. */
const FOOTER_ADDRESS_KEY = 'brand__footer_address';

/** How deep the relative-import walk goes before it stops following. */
const CHAIN_DEPTH = 10;

/** The extensions a relative specifier may resolve to, in resolution order. */
const CHAIN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * The compiler the chain walk needs, or `null` with the degradation stated.
 *
 * `typescript` is an optional peer, and a host without it still gets an answer
 * rather than a skipped section — a coarser one, said out loud, because the
 * search that replaces the parse cannot tell a comment from code and the walk
 * that finds the wrapper files is itself a parse.
 *
 * A host on TypeScript 7 lands here too, and gets `loadTypescript`'s own
 * refusal rather than the install line: it HAS typescript, and telling it to
 * install typescript names the one remedy that changes nothing.
 */
async function chainCompiler(report: Report): Promise<typeof import('typescript') | null> {
  try {
    return await loadTypescript();
  } catch (error) {
    const cause =
      error instanceof Error && error.message === TS7_REFUSAL
        ? TS7_REFUSAL
        : 'typescript is not installed (npm i -D typescript)';
    report.line(
      `wrapper chains: degraded — ${cause}. Each pointer file is searched on its own, as plain text; ` +
        'a token missing from it is reported unchecked rather than unfound, because the wrapper that would ' +
        'carry it is never opened',
    );
    return null;
  }
}

/** The files a wrapper claim was searched in, and whether that was all of them. */
interface Chain {
  files: Array<{ rel: string; text: string }>;
  /** The walk met an import it does not follow — a package, or an unreadable file. */
  boundary: boolean;
}

/** The pointer's own file — the whole chain a run without the compiler can reach. */
function pointerOnly(cwd: string, entryFile: string): Chain {
  try {
    return { files: [{ rel: entryFile, text: readFileSync(join(cwd, entryFile), 'utf8') }], boundary: true };
  } catch {
    return { files: [], boundary: true };
  }
}

/**
 * A file and everything it reaches by RELATIVE import or re-export,
 * depth-bounded, plus whether the walk stopped somewhere it could not follow.
 *
 * Package imports are never followed: a wrapper that lives in `node_modules` is
 * not the host's source, and walking into one would turn a bounded read into a
 * dependency-tree crawl. But a chain that met one is INCOMPLETE, and the caller
 * has to know: the frame carrying the token may be exactly the file behind that
 * import, so "not found here" is not "not there" — the same distinction the
 * compiler-less degradation draws.
 *
 * Re-exports are followed because a component directory's barrel
 * (`export { Footer } from './footer'`) is how most host code reaches its
 * frame, and a walk that stopped at the barrel would report every token the
 * frame carries as missing from a chain that never opened the frame.
 */
function importClosure(
  ts: typeof import('typescript'),
  cwd: string,
  entryFile: string,
): Chain {
  const files: Array<{ rel: string; text: string }> = [];
  const seen = new Set<string>();
  let boundary = false;

  const visit = (rel: string, depth: number): void => {
    if (seen.has(rel)) return;
    if (depth > CHAIN_DEPTH) {
      boundary = true;
      return;
    }
    seen.add(rel);
    const abs = join(cwd, rel);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      boundary = true;
      return;
    }
    files.push({ rel, text });

    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, abs));
    for (const stmt of sf.statements) {
      const spec = moduleSpecifier(ts, stmt);
      if (spec === undefined) continue;
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        boundary = true;
        continue;
      }
      const target = resolveRelative(cwd, rel, spec);
      if (target === null) boundary = true;
      else visit(target, depth + 1);
    }
  };

  visit(entryFile, 0);
  return { files, boundary };
}

/** The module an import or a re-export names, where it names one. */
function moduleSpecifier(ts: typeof import('typescript'), stmt: TS.Statement): string | undefined {
  if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) return stmt.moduleSpecifier.text;
  if (
    ts.isExportDeclaration(stmt) &&
    stmt.moduleSpecifier !== undefined &&
    ts.isStringLiteral(stmt.moduleSpecifier)
  ) {
    return stmt.moduleSpecifier.text;
  }
  return undefined;
}

/** A relative specifier as a repo-relative path, extension probed. */
function resolveRelative(cwd: string, fromRel: string, spec: string): string | null {
  const base = resolvePath(dirname(join(cwd, fromRel)), spec);
  const candidates = [
    base,
    ...CHAIN_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...CHAIN_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    // `node_modules` is never entered, even by a specifier that reaches it the
    // long way round (`../../node_modules/x`).
    if (candidate.split(sep).includes('node_modules')) continue;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    return posixRelative(cwd, candidate);
  }
  return null;
}

/**
 * What this project can be pointed at, and where this run was pointed. Offline
 * and a listing only: naming a connection is not dialling it, and diagnosing
 * four environments by connecting to all four would make `doctor` the slowest
 * and least reliable command in the set.
 */
function environmentsSection(project: LoadedProject, report: Report): void {
  const declared = project.config.environments ?? {};
  const names = Object.keys(declared).sort();
  const selected = project.environment.name;

  if (names.length === 0) {
    report.line('environments: none declared — the store block is the only connection (--env default)');
    report.data('environments', { declared: [], selected });
    return;
  }
  report.line('environments:');
  const mark = (name: string): string => (name === selected ? ' ← selected' : '');
  report.line(
    `  default (${project.config.store?.adapter ?? 'none (snapshot-only)'})${mark('default')}`,
  );
  for (const name of names) report.line(`  ${name} (${declared[name]?.adapter})${mark(name)}`);
  report.data('environments', { declared: names, selected });
}

async function storeSection(
  io: CliIo,
  project: LoadedProject,
  report: Report,
): Promise<void> {
  const { config } = project;
  // The SELECTED environment's block — `--env staging` must not report the
  // default connection's adapter and call the section done.
  const block = project.environment.block;
  const adapter = block?.adapter;

  if (project.storeProblem !== undefined) {
    report.line(`store: configured (${adapter ?? 'unknown'}), MISCONFIGURED`);
    report.warn('config', project.storeProblem);
    report.data('store', { mode: 'misconfigured', adapter });
    return;
  }
  if (!isStoreBacked(block)) {
    report.line('store: snapshot-only — publish = commit; no database is required or expected');
    report.data('store', { mode: 'snapshot-only' });
    return;
  }

  const answer = await project.readRows();
  if (answer.storeDown) {
    report.line(`store: configured (${adapter}), UNREACHABLE`);
    report.warn('store', `the store did not answer: ${answer.message ?? 'unreachable'}`);
    report.data('store', { mode: 'unreachable', adapter });
    return;
  }
  report.line(`store: configured (${adapter}), reachable — ${answer.rows.length} rows`);
  report.data('store', { mode: 'reachable', adapter, rows: answer.rows.length });

  try {
    const meta = await readProjectMeta(config, io.env, project.environment.name, io.fetchImpl);
    if (meta === 'unsupported') return;
    if (meta === null) {
      report.line('meta: no stet_meta — this database is unversioned; run stet upgrade');
      report.warn('store', 'stet_meta is absent: migration 1 has not been applied');
      return;
    }
    const stamped = meta.descriptorVersion === '' ? 'not yet stamped' : meta.descriptorVersion;
    report.line(`meta: schema_version ${meta.schemaVersion} · descriptor_version ${stamped}`);
    report.data('meta', meta);
  } catch (error) {
    report.warn('store', `stet_meta could not be read: ${(error as Error).message}`);
  }
}

/**
 * Is production actually serving the database copy? The check is containment
 * of the key's ACTIVE resolved text in the fetched HTML, with the HTML's
 * character references decoded first so an escaped page and a literal one read
 * the same. Stated limitation, not buried: a value a template splits across
 * elements reports a false miss. It is a diagnostic and gates nothing.
 */
async function liveCheck(
  io: CliIo,
  project: LoadedProject,
  report: Report,
  url: string,
  key: string,
): Promise<void> {
  // `Object.hasOwn`, not `in`: the descriptor is JSON-parsed and the name comes
  // off the command line, so `--key constructor` passes a prototype-chain test
  // and fails several steps later saying the key "resolves to a function".
  if (!Object.hasOwn(project.descriptor.keys, key)) {
    throw new UsageError(`"${key}" is not a key in ${project.config.descriptorPath}`);
  }
  const answer = await project.readRows({ keys: [key] });
  const value = resolve(project.descriptor, project.snapshot, answer.rows, { key }).value;
  if (typeof value !== 'string') {
    throw new UsageError(`--key ${key} resolves to ${shapeOf(value)}; the live check reads text`);
  }

  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  let html: string;
  try {
    const response = await fetchImpl(url);
    html = await response.text();
  } catch (error) {
    report.error('store', `could not fetch ${url}: ${(error as Error).message}`);
    return;
  }

  const found = decodeEntities(html).includes(value);
  if (found) {
    report.line(`live: ${url} is serving ${key}`);
  } else {
    report.error(
      'store',
      `live: ${url} does not contain ${key}'s active value ${JSON.stringify(value)} — ` +
        'the deploy may be stale, or the value renders split across elements (this check reads whole text)',
      key,
    );
  }
}

/**
 * The fetched HTML with its character references resolved, so containment is
 * checked once against text rather than against a guessed set of encodings.
 *
 * Enumerating encodings was the earlier approach and it false-alarms on real
 * output: serializers escape per character, so one sentence arrives with an
 * `&amp;` beside a literal apostrophe and matches none of the whole-string
 * variants. Decoding handles the mixture by construction. `&amp;` is resolved
 * LAST, so an escaped `&amp;amp;` does not become an `&` that swallows the
 * text after it.
 *
 * The mirror image is `src/targets/web.ts`'s `escape`, which goes ampersand
 * FIRST for the same reason in the other direction. They are deliberately not
 * shared code: an encoder emits one canonical form per character (five of them,
 * a strict subset of what this resolves), while this reads whatever a host's
 * serializer produced. Unifying them would make one of the two wrong.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&(?:apos|#0*39|#[xX]0*27);/g, "'")
    .replace(/&(?:quot|#0*34|#[xX]0*22);/g, '"')
    .replace(/&(?:lt|#0*60|#[xX]0*3[cC]);/g, '<')
    .replace(/&(?:gt|#0*62|#[xX]0*3[eE]);/g, '>')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

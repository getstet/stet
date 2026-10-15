/**
 * `stet audit lighthouse` — Lighthouse's four categories per declared page,
 * each failing audit printed with its owner, its place and its remedy, over a
 * target that follows the host: the checkout's own documents on the
 * static-HTML host, `--url` or `--build` on a JavaScript one. Lighthouse,
 * chrome-launcher and selfsigned load only inside this command's run.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

import { headLimitsFor } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import { DEFAULT_TARGET, type Descriptor, type PageDef } from '../src/types.js';
import { flag, noPositionals, parse, refuseEnv, text } from './args.js';
import { asUpdate, planJson, planWrite, rethrowBatchFailure, writeJsonDeterministic, writePlanned, type WritePlan } from './artifacts.js';
import { startFront, type Front } from './audit-target.js';
import { descriptorOf, snapshotOf } from './check.js';
import { isHtmlHost, loadConfig, type StetConfig } from './config.js';
import { LOG_LINES } from './dev-routes.js';
import { filesForGlobs } from './files.js';
import { clientReadFiles, readPathImport } from './footprint.js';
import { trackable } from './git.js';
import { readDocument } from './html-host.js';
import {
  chosenRun,
  closingLine,
  medianScores,
  readRun,
  scoreLine,
  type AuditReport,
  type Owner,
  type PageContext,
} from './lighthouse-audits.js';
import { astroFixLines, planDocumentFix, planNextLang, planViteShell, type DocumentFix } from './lighthouse-fix.js';
import { CATEGORIES, ChromeMissing, chromeRunner, type FormFactor, type LighthouseResult, type LighthouseRunner } from './lighthouse-run.js';
import { answers, endGroup, untilInterrupted } from './liveness.js';
import type { CliIo } from './main.js';
import { applyPages, pageOfFile, proposeForHost, servedRoute } from './pages.js';
import { plural, Report, UsageError } from './report.js';
import { applyFileEdits } from './rewrite.js';
import { loadTypescript } from './source-scan.js';
import { servableFile } from './static-files.js';
import { childEnv, devDefaults, PREVIEW_COMMANDS, readWorkspace, workspacePath, type WorkspaceEntry } from './workspace.js';

const CHROME_MISSING = 'Chrome was not found — Lighthouse needs it; install Google Chrome, or set CHROME_PATH to a Chrome or Chromium binary';
const NO_TARGET = 'this host builds before it serves — pass --url <server>, or --build to build and serve the production output here';
const SET_LANGUAGE = 'set language in stet.config.json (a BCP 47 tag such as en-GB), then run stet audit lighthouse --fix';

/** One page to audit: its name, the label its score line opens with, its route and its URL. */
interface PageTarget {
  page: string;
  label: string;
  route: string;
  url: string;
  /** The html host's document for the page. */
  file?: string;
}

/** What the run measures through. */
interface Target {
  base: string;
  kind: 'documents' | 'build' | 'url';
  front?: Front;
}

export async function runAuditLighthouse(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'audit lighthouse');
  const { values, positionals } = parse(args, {
    url: 'string',
    build: 'boolean',
    desktop: 'boolean',
    applied: 'boolean',
    pages: 'string',
    runs: 'string',
    fix: 'boolean',
    write: 'boolean',
    json: 'boolean',
    raw: 'string',
    strict: 'boolean',
  });
  noPositionals(positionals, 'audit lighthouse');
  const url = text(values, 'url');
  const build = flag(values, 'build');
  const fix = flag(values, 'fix');
  const write = flag(values, 'write');
  const json = flag(values, 'json');
  const raw = text(values, 'raw');
  const runsText = text(values, 'runs');
  if (url !== undefined && build) throw new UsageError('stet audit lighthouse takes --url or --build, not both');
  if (runsText !== undefined && !/^[1-9]$/.test(runsText)) throw new UsageError('stet audit lighthouse --runs takes a whole number from 1 to 9');
  if (write && !fix) throw new UsageError("stet audit lighthouse --write applies --fix's plan — pass both");
  if (raw !== undefined && !json) throw new UsageError('stet audit lighthouse --raw writes beside --json — pass both');
  const runs = runsText === undefined ? 1 : Number(runsText);
  const formFactor: FormFactor = flag(values, 'desktop') ? 'desktop' : 'mobile';
  const applied = flag(values, 'applied');

  const report = new Report();
  const config = loadConfig(io.cwd);
  const descriptor = descriptorOf(config, io.cwd, report);
  if (descriptor === null) return report.emit(io, { json });
  const snapshot = snapshotOf(config, io.cwd, report);
  if (snapshot === null) return report.emit(io, { json });

  // The pages: the declared ones in name order, narrowed by --pages; none declared is `/` alone.
  const declared = descriptor.pages ?? {};
  const names = Object.keys(declared).sort();
  let selected = names;
  const pagesText = text(values, 'pages');
  if (pagesText !== undefined) {
    const asked = pagesText.split(',').map((name) => name.trim()).filter((name) => name !== '');
    for (const name of asked) {
      if (!Object.hasOwn(declared, name)) throw new UsageError(`stet audit lighthouse --pages: ${name} is not a declared page`);
    }
    selected = names.filter((name) => asked.includes(name));
  }

  const html = isHtmlHost(config);
  // stet's own footprint, read before any target starts.
  const footprint = html ? { lines: [], entries: [] } : footprintOf(io.cwd, config);
  if (!html && url === undefined && !build) {
    for (const line of footprint.lines) report.line(line);
    report.error('lighthouse', NO_TARGET);
    return report.emit(io, { json });
  }

  const interrupt = untilInterrupted();
  const held: Held = {};
  const work = (async (): Promise<number> => {
    const target = await startTarget(io, config, { url, build }, report, held);
    if (target === null) return report.emit(io, { json });
    held.target = target;
    const { pages, skips } = pageTargets(io.cwd, config, declared, selected, target);
    try {
      held.runner = await (io.lighthouse ?? chromeRunner)(target.kind !== 'url');
    } catch (error) {
      if (!(error instanceof ChromeMissing)) throw error;
      report.error('lighthouse', CHROME_MISSING);
      return report.emit(io, { json });
    }
    const runner = held.runner as { run: LighthouseRunner; close: () => Promise<void> };
    const measure = async (list: PageTarget[]): Promise<Array<{ target: PageTarget; results: LighthouseResult[] }> | null> => {
      const measured: Array<{ target: PageTarget; results: LighthouseResult[] }> = [];
      for (const page of list) {
        const results: LighthouseResult[] = [];
        for (let n = 1; n <= runs; n += 1) {
          io.stderr(`auditing ${page.page}… ${n}/${runs}`);
          const result = await runner.run(page.url, { formFactor, applied });
          if (result.runtimeError !== undefined) {
            report.error('lighthouse', `${page.url} did not answer — start the server, or pass --url (${result.runtimeError.message})`);
            return null;
          }
          results.push(result);
        }
        measured.push({ target: page, results });
      }
      return measured;
    };

    const measured = await measure(pages);
    if (measured === null) return report.emit(io, { json });

    // The fixes, planned over the files as they stand: the documents on the html
    // host, the shell on Vite, the root layout's lang on Next, lines on Astro.
    const plans = fix ? await planFixes(io.cwd, config, descriptor, measured) : [];

    const first = measured[0]?.results[0];
    const version = first?.lighthouseVersion ?? 'unknown';
    const devServer = target.kind === 'url' && isDevServer(io, config, target.base);
    report.line(firstLine(version, formFactor, applied, target));
    for (const line of skips) report.line(line);
    for (const line of footprint.lines) report.line(line);
    if (devServer) report.line('note  Performance is measured on the dev server — run with --build for the production number');
    if (selected.length === 0 && names.length === 0) report.line('no pages declared — audited / alone; run stet pages scan to declare them');

    const owners: Owner[] = footprint.entries.map(() => 'stet' as const);
    const pageReports: unknown[] = [];
    const contextFor = (page: PageTarget): PageContext => pageContext(io.cwd, config, descriptor, snapshot, page, fix);
    const printPages = (list: Array<{ target: PageTarget; results: LighthouseResult[] }>): void => {
      for (const { target: page, results } of list) {
        const chosen = results[chosenRun(results)] as LighthouseResult;
        const read = readRun(chosen, contextFor(page));
        const notes = notesFor(chosen, results, page, config, target, applied);
        report.line('');
        report.line(scoreLine(page.label, page.route, results, { devServer }));
        const diag = read.lines.filter((line) => line.startsWith('diag  '));
        for (const line of [...read.lines.filter((line) => !line.startsWith('diag  ')), ...notes.lines, ...diag]) report.line(`  ${line}`);
        owners.push(...read.audits.map((audit) => audit.owner));
        pageReports.push(pageJson(page, results, chosen, read.audits, read.diagnostics, notes.thirdParty, runsText !== undefined));
        strictFinding(report, page.page, results, flag(values, 'strict'));
      }
    };
    printPages(measured);
    report.line('');
    report.line(closingLine(measured.length, owners));

    printPlans(report, plans);
    report.data('lighthouse', {
      version,
      formFactor,
      runs,
      target: target.front?.url ?? target.base,
      targetKind: target.kind,
      protocol: target.kind === 'url' ? mainProtocol(first) : 'h2',
    });
    report.data('footprint', footprint.entries);
    report.data('fixes', plans.map((plan) => ('skip' in plan ? { skip: plan.skip } : { file: plan.file, lines: plan.lines, edits: plan.edits.length })));

    if (fix && !write) {
      const line = applyLine(plans, measured);
      if (line !== null) report.line(line);
    }
    if (fix && write) {
      const edited = writeFixes(io.cwd, config, descriptor, snapshot, plans, report);
      if (edited.length > 0) {
        if (target.kind === 'url') {
          report.line(`run stet audit lighthouse again once ${target.base} serves the edit`);
        } else {
          if (target.kind === 'build') {
            // The edit is in source the running build does not carry: build and serve again.
            await stopTarget(held);
            const again = await startTarget(io, config, { url, build }, report, held);
            if (again === null) return report.emit(io, { json });
            held.target = again;
          }
          const base = held.target?.front?.url ?? target.base;
          const rerun = pages
            .filter((page) => edited.includes(page.file ?? '') || target.kind === 'build')
            .map((page) => ({ ...page, url: page.url.replace(target.front?.url ?? target.base, base) }));
          const again = await measure(rerun);
          if (again === null) return report.emit(io, { json });
          printPages(again);
        }
      }
    }
    report.data('pages', pageReports);

    if (raw !== undefined) {
      const dir = join(io.cwd, raw);
      // git matches a `dir/` ignore rule against a directory that exists, so the probe runs on one made for it.
      const made = mkdirSync(dir, { recursive: true });
      if (trackable(dir) === true) {
        if (made !== undefined) rmSync(made, { recursive: true });
        report.error('lighthouse', `--raw ${raw}: git would track it — name a directory git ignores`);
      } else {
        for (const { target: page, results } of measured) {
          writeJsonDeterministic(join(dir, `${page.page === '/' ? 'root' : page.page}.json`), results[chosenRun(results)]);
        }
      }
    }
    return report.emit(io, { json });
  })();
  // Its late rejection, once Chrome is gone, is never unhandled.
  work.catch(() => undefined);
  try {
    const signal = await Promise.race([work.then(() => null), interrupt.interrupted]);
    if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
    return await work;
  } finally {
    await stopTarget(held);
    interrupt.release();
  }
}

/** What the run has started, held for the one `finally`: the preview from its spawn, before it answers. */
interface Held {
  runner?: { run: LighthouseRunner; close: () => Promise<void> };
  target?: Target;
  preview?: number;
}

/** The runner's Chrome, then the front, then the preview's group — on every exit path. */
async function stopTarget(held: Held): Promise<void> {
  const { runner, target, preview } = held;
  delete held.runner;
  delete held.target;
  delete held.preview;
  if (runner !== undefined) await runner.close();
  if (target?.front !== undefined) await target.front.close();
  if (preview !== undefined) await endGroup(preview);
}

/** stet's own footprint on a JavaScript host's page: the read path's provider import, and a mount no client reads. */
function footprintOf(cwd: string, config: StetConfig): { lines: string[]; entries: Array<{ file: string; kind: 'read-path' | 'provider' }> } {
  const lines: string[] = [];
  const entries: Array<{ file: string; kind: 'read-path' | 'provider' }> = [];
  if (readPathImport(cwd, config) !== 'clean') {
    lines.push(
      `stet  ${config.readPath.file} imports from '@getstet/stet/react', which ships the client provider with every page — stet upgrade rewrites it to '@getstet/stet/react/server'`,
    );
    entries.push({ file: config.readPath.file, kind: 'read-path' });
  }
  const layout = config.rootLayout === undefined ? undefined : join(cwd, config.rootLayout);
  if (layout !== undefined && existsSync(layout) && readFileSync(layout, 'utf8').includes('<CopyProvider') && clientReadFiles(cwd, config).length === 0) {
    lines.push(`stet  ${config.rootLayout as string} mounts CopyProvider and no client component reads copy — stet upgrade unmounts it`);
    entries.push({ file: config.rootLayout as string, kind: 'provider' });
  }
  return { lines, entries };
}

/** The target, started: the documents' front, the `--url` server asked once, or the production build fronted. Null after an error is reported. */
async function startTarget(
  io: CliIo,
  config: StetConfig,
  flags: { url: string | undefined; build: boolean },
  report: Report,
  held: Held,
): Promise<Target | null> {
  if (isHtmlHost(config)) {
    const front = await startFront({ root: io.cwd });
    return { base: front.url, kind: 'documents', front };
  }
  if (flags.url !== undefined) {
    if (!(await answers(io.fetchImpl ?? fetch, flags.url, 1_500))) {
      report.error('lighthouse', `${flags.url} did not answer — start the server, or pass --url`);
      return null;
    }
    return { base: flags.url, kind: 'url' };
  }
  const preview = await startBuild(io, config, report, held);
  if (preview === null) return null;
  const target: Target = { base: `http://127.0.0.1:${preview.port}/`, kind: 'build' };
  target.front = await startFront({ upstream: new URL(target.base) });
  report.line(`serving the build on ${target.front.url} (${preview.command})`);
  return target;
}

/** `npm run build`, then the preview command on a free loopback port, waited for. Null after an error is reported. */
async function startBuild(io: CliIo, config: StetConfig, report: Report, held: Held): Promise<{ pid: number; command: string; port: number } | null> {
  io.stderr('building (npm run build)…');
  const code = await new Promise<number>((resolve) => {
    const child = spawn('npm run build', { cwd: io.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    const relay = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') io.stderr(line);
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);
    child.on('error', () => resolve(127));
    child.on('close', (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    report.error('lighthouse', `npm run build exited ${code} — its output is above`);
    return null;
  }
  const port = await freePort();
  const command = previewCommandOf(io, config).replaceAll('{port}', String(port));
  const child = spawn(command, { cwd: io.cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv(), PORT: String(port) } });
  const lines: string[] = [];
  const keep = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') lines.push(line);
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const pid = child.pid ?? 0;
  // Held from the spawn: a signal during the wait ends the group through the `finally`.
  held.preview = pid;
  const deadline = Date.now() + (io.previewWaitMs ?? 60_000);
  while (!exited && Date.now() < deadline) {
    if (await answers(io.fetchImpl ?? fetch, `http://127.0.0.1:${port}/`, 1_500)) return { pid, command, port };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await endGroup(pid);
  delete held.preview;
  report.error('lighthouse', [`the production preview did not start (${command}) — its last lines:`, ...lines].join('\n'));
  return null;
}

/** The workspace entry's preview command, else the router's. */
function previewCommandOf(io: CliIo, config: StetConfig): string {
  const entry = workspaceEntry(io);
  if (entry?.previewCommand !== undefined) return entry.previewCommand;
  return PREVIEW_COMMANDS[config.router === 'pages' || config.router === 'astro' || config.router === 'vite' ? config.router : 'app'];
}

/** This checkout's workspace entry, where the workspace lists it. */
function workspaceEntry(io: CliIo): WorkspaceEntry | undefined {
  try {
    const real = realpathSync(io.cwd);
    return readWorkspace(workspacePath(io)).sites.find((site) => site.path === real);
  } catch {
    return undefined;
  }
}

/** A port the system hands out on 127.0.0.1, its server closed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Each page's URL. On the html host a page's document is the managed document
 * whose file route is the page's route, else the managed document its route
 * names on disk, else the page is skipped; elsewhere the base joined with the
 * route.
 */
function pageTargets(
  cwd: string,
  config: StetConfig,
  declared: Record<string, PageDef>,
  selected: string[],
  target: Target,
): { pages: PageTarget[]; skips: string[] } {
  const base = target.front?.url ?? target.base;
  const wanted = selected.length > 0 ? selected.map((name) => ({ name, route: (declared[name] as PageDef).route })) : Object.keys(declared).length > 0 ? [] : [{ name: '/', route: '/' }];
  if (!isHtmlHost(config)) {
    return { pages: wanted.map(({ name, route }) => ({ page: name, label: name, route, url: new URL(route, base).href })), skips: [] };
  }
  const documents = filesForGlobs(cwd, config.managedSurfaces).filter((file) => file.endsWith('.html'));
  const pages: PageTarget[] = [];
  const skips: string[] = [];
  for (const { name, route } of wanted) {
    const file =
      name === '/'
        ? documents.find((doc) => servedRoute(doc) === '/')
        : documents.find((doc) => pageOfFile(cwd, doc, declared, { html: true, declaredOnly: true }) === name);
    if (file !== undefined) {
      pages.push({ page: name, label: file, route, url: base + servedRoute(file).slice(1), file });
      continue;
    }
    // The front serves the file the route names, so it is that page's document.
    const served = servableFile(cwd, route);
    // `servableFile` answers the real path, so each document is compared by its own.
    const onDisk = served === null ? undefined : documents.find((doc) => realpathSync(join(cwd, doc)) === served);
    if (onDisk !== undefined) {
      pages.push({ page: name, label: onDisk, route, url: base + route.replace(/^\//, ''), file: onDisk });
      continue;
    }
    skips.push(`${name}: no managed document serves ${route} — skipped`);
  }
  return { pages, skips };
}

/** What one page's run is read against. */
function pageContext(cwd: string, config: StetConfig, descriptor: Descriptor, snapshot: Snapshot, page: PageTarget, fix: boolean): PageContext {
  const def = page.page === '/' ? undefined : descriptor.pages?.[page.page];
  const router = isHtmlHost(config) ? 'html' : config.router;
  const document = page.file === undefined ? null : readDocument(page.file, readFileSync(join(cwd, page.file), 'utf8'));
  return {
    router,
    page: page.page === '/' ? null : page.page,
    def,
    descriptor,
    snapshot,
    document,
    file: page.file ?? fileForPage(cwd, config, descriptor.pages, page.page),
    fix,
  };
}

/** The file a JavaScript host's head line names: Vite's shell, the page's own file, else the root layout. */
function fileForPage(cwd: string, config: StetConfig, pages: Record<string, PageDef> | undefined, page: string): string | null {
  if (config.router === 'vite') return 'index.html';
  const own = page === '/' ? undefined : filesForGlobs(cwd, config.managedSurfaces).find((file) => pageOfFile(cwd, file, pages) === page);
  return own ?? config.rootLayout ?? null;
}

/** The first line: the version, the form factor, the throttling and what is served. */
function firstLine(version: string, formFactor: FormFactor, applied: boolean, target: Target): string {
  const head = `lighthouse ${version} · ${formFactor} · ${applied ? 'applied throttling · ' : ''}`;
  if (target.kind === 'documents') return `${head}${target.base} serves the checkout's documents as deployed (HTTP/2)`;
  if (target.kind === 'build') return `${head}${target.front?.url ?? target.base} (the production build, HTTP/2)`;
  return `${head}${target.base}`;
}

/** Whether `--url` names the entry's dev server: the same port on a loopback host, or the same origin. */
function isDevServer(io: CliIo, config: StetConfig, url: string): boolean {
  const dev = devDefaults(config, workspaceEntry(io) ?? { path: io.cwd })?.dev;
  if (dev === undefined) return false;
  let a: URL;
  let b: URL;
  try {
    a = new URL(url);
    b = new URL(dev);
  } catch {
    return false;
  }
  const loopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (loopback(a.hostname) && loopback(b.hostname)) return a.port === b.port;
  return a.origin === b.origin;
}

type Request = Record<string, unknown>;
const requestsOf = (lhr: LighthouseResult | undefined): Request[] => lhr?.audits['network-requests']?.details?.items ?? [];

/** The main document's protocol, as the run's network requests report it. */
function mainProtocol(lhr: LighthouseResult | undefined): string | null {
  const main = requestsOf(lhr).find((item) => item['resourceType'] === 'Document') ?? requestsOf(lhr)[0];
  return typeof main?.['protocol'] === 'string' ? (main['protocol'] as string) : null;
}

/** A page's notes: HTTP/1.1, the third-party origins, and the bundle before the paint. */
function notesFor(
  lhr: LighthouseResult,
  results: LighthouseResult[],
  page: PageTarget,
  config: StetConfig,
  target: Target,
  applied: boolean,
): { lines: string[]; thirdParty: string[] } {
  const lines: string[] = [];
  if (target.kind === 'url' && mainProtocol(lhr) === 'http/1.1') {
    lines.push(`note  ${page.url} serves HTTP/1.1 — Lighthouse queues its requests six at a time, which production over HTTP/2 does not; treat Performance as a floor`);
  }
  let own: string;
  try {
    own = new URL(lhr.finalDisplayedUrl).origin;
  } catch {
    own = '';
  }
  const thirdParty: string[] = [];
  for (const item of requestsOf(lhr)) {
    try {
      const at = new URL(String(item['url']));
      if ((at.protocol === 'http:' || at.protocol === 'https:') && at.origin !== own && !thirdParty.includes(at.origin)) thirdParty.push(at.origin);
    } catch {
      // A request with no URL names no origin.
    }
  }
  if (thirdParty.length > 0) {
    const shown = thirdParty.map((origin) => (origin.startsWith('https://') ? new URL(origin).host : origin));
    const list = shown.length <= 1 ? (shown[0] as string) : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] as string}`;
    lines.push(`note  ${list} are third-party requests — Performance moves with the network; run with --runs 3 before acting on one number`);
  }
  const performance = medianScores(results).performance;
  if (config.router === 'vite' && target.kind !== 'url' && !applied && performance !== null && performance < 100) {
    const largest = Math.max(0, ...requestsOf(lhr).filter((item) => item['resourceType'] === 'Script').map((item) => Number(item['transferSize'] ?? 0)));
    lines.push(
      `note  the bundle (${Math.round(largest / 1024)} KB) arrives before the first paint on this connection — Performance is a floor here; run with --applied, or audit the deployed preview, for the production number`,
    );
  }
  return { lines, thirdParty };
}

/** A page in the `--json` report. */
function pageJson(
  page: PageTarget,
  results: LighthouseResult[],
  chosen: LighthouseResult,
  audits: AuditReport[],
  diagnostics: string[],
  thirdParty: string[],
  withRuns: boolean,
): Record<string, unknown> {
  const metric = (chosen.audits['metrics']?.details?.items?.[0] ?? {}) as Record<string, unknown>;
  const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  return {
    page: page.page,
    route: page.route,
    url: page.url,
    scores: medianScores(results),
    metrics: {
      fcp: number(metric['firstContentfulPaint']),
      lcp: number(metric['largestContentfulPaint']),
      tbt: number(metric['totalBlockingTime']),
      cls: number(metric['cumulativeLayoutShift']),
      si: number(metric['speedIndex']),
    },
    audits,
    diagnostics,
    thirdParty,
    ...(withRuns
      ? { runs: CATEGORIES.map((category) => results.map((run) => (typeof run.categories[category]?.score === 'number' ? Math.round((run.categories[category]?.score as number) * 100) : null))) }
      : {}),
  };
}

/** `--strict`: one error per page with a category below 100. */
function strictFinding(report: Report, page: string, results: LighthouseResult[], strict: boolean): void {
  if (!strict) return;
  const scores = medianScores(results);
  const below = (
    [
      ['performance', scores.performance],
      ['accessibility', scores.accessibility],
      ['best-practices', scores.bestPractices],
      ['seo', scores.seo],
    ] as const
  ).filter(([, score]) => score === null || score < 100);
  if (below.length > 0) report.error('lighthouse', `${page}: ${below.map(([name, score]) => `${name} ${score ?? '–'}`).join(', ')} below 100`);
}

type Plan = DocumentFix | { skip: string };

/** The fixes per host type, each over a file as it stands. */
async function planFixes(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
  measured: Array<{ target: PageTarget; results: LighthouseResult[] }>,
): Promise<Plan[]> {
  const keys = new Set(Object.keys(descriptor.keys));
  if (isHtmlHost(config)) {
    const plans: Plan[] = [];
    for (const { target } of measured) {
      if (target.file === undefined || plans.some((plan) => 'file' in plan && plan.file === target.file)) continue;
      const document = readDocument(target.file, readFileSync(join(cwd, target.file), 'utf8'));
      const page = pageOfFile(cwd, target.file, descriptor.pages, { html: true }) ?? null;
      const plan = planDocumentFix(document, { ...(config.language === undefined ? {} : { language: config.language }), page, keys });
      // A key minted for one document is taken for the next.
      if (!('skip' in plan)) for (const mint of plan.mints) keys.add(mint.key);
      plans.push(plan);
    }
    return plans;
  }
  if (config.router === 'vite') {
    const path = join(cwd, 'index.html');
    if (!existsSync(path)) return [];
    return [planViteShell(readDocument('index.html', readFileSync(path, 'utf8')), config.language)];
  }
  if ((config.router === 'app' || config.router === 'pages') && config.rootLayout !== undefined && existsSync(join(cwd, config.rootLayout))) {
    let ts: typeof import('typescript');
    try {
      ts = await loadTypescript();
    } catch {
      return [];
    }
    return [planNextLang(ts, config.rootLayout, readFileSync(join(cwd, config.rootLayout), 'utf8'), config.language)];
  }
  if (config.router === 'astro') {
    return measured.flatMap(({ target, results }) => {
      const failing = new Set(
        Object.entries((results[chosenRun(results)] as LighthouseResult).audits)
          .filter(([, audit]) => typeof audit.score === 'number' && audit.score < 1)
          .map(([id]) => id),
      );
      const lines = astroFixLines(failing, config.language);
      return lines.length === 0 ? [] : [{ file: target.page, edits: [], lines, mints: [] }];
    });
  }
  return [];
}

/** The plan as printed: each document's lines under its header, each skip on its line. */
function printPlans(report: Report, plans: Plan[]): void {
  for (const plan of plans) {
    if ('skip' in plan) {
      report.line('');
      for (const line of plan.skip.split('\n')) report.line(line);
      continue;
    }
    if (plan.lines.length === 0) continue;
    report.line('');
    report.line(`fixes (${plan.lines.length}) — ${plan.file}:`);
    for (const line of plan.lines) report.line(`  ${line}`);
  }
}

/** The audits each plan line clears, by the line's tag. */
function clearedBy(line: string): { now: string[]; later: string[] } {
  if (line.startsWith('<!DOCTYPE html>')) return { now: ['doctype'], later: [] };
  if (line.startsWith('<meta charset')) return { now: ['charset'], later: [] };
  if (line.startsWith('<meta name="viewport"')) return { now: ['meta-viewport', 'viewport-insight'], later: [] };
  if (line.startsWith('lang=')) return { now: ['html-has-lang', 'html-lang-valid'], later: [] };
  if (line.startsWith('<title') || line.startsWith('<meta name="description"')) {
    return { now: [], later: [...(line.includes('<title') ? ['document-title'] : []), ...(line.includes('name="description"') ? ['meta-description'] : [])] };
  }
  return { now: [], later: [] };
}

/** `run with --fix --write to apply: …`, naming the failing audits the edits clear; null where nothing is planned. */
function applyLine(plans: Plan[], measured: Array<{ results: LighthouseResult[] }>): string | null {
  const planned = plans.filter((plan): plan is DocumentFix => !('skip' in plan) && plan.edits.length > 0);
  if (planned.length === 0) return null;
  const failing = new Set(
    measured.flatMap(({ results }) =>
      Object.entries((results[chosenRun(results)] as LighthouseResult).audits)
        .filter(([, audit]) => typeof audit.score === 'number' && audit.score < 1 && audit.scoreDisplayMode !== 'notApplicable')
        .map(([id]) => id),
    ),
  );
  const now = new Set<string>();
  const later = new Set<string>();
  for (const plan of planned) {
    for (const line of plan.lines) {
      const cleared = clearedBy(line);
      for (const id of cleared.now) if (failing.has(id)) now.add(id);
      for (const id of cleared.later) if (failing.has(id)) later.add(id);
    }
  }
  const named = (ids: Set<string>): string => {
    const list = [...ids];
    const joined = list.length <= 1 ? (list[0] as string) : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1] as string}`;
    return `${joined} ${list.length === 1 ? 'clears' : 'clear'}`;
  };
  const parts = [...(now.size > 0 ? [named(now)] : []), ...(later.size > 0 ? [`${named(later)} once the words are written`] : [])];
  return parts.length === 0 ? 'run with --fix --write to apply' : `run with --fix --write to apply: ${parts.join('; ')}`;
}

/**
 * `--fix --write`: every edited file, and the minted keys in the descriptor and
 * the snapshot, in one batch; then each minted-for page declared the way
 * `pages scan --apply` declares it. Answers the files written.
 */
function writeFixes(cwd: string, config: StetConfig, descriptor: Descriptor, snapshot: Snapshot, plans: Plan[], report: Report): string[] {
  const planned = plans.filter((plan): plan is DocumentFix => !('skip' in plan) && plan.edits.length > 0);
  if (planned.length === 0) return [];
  const writes: WritePlan[] = [];
  const mintsByPage = new Map<string, Array<{ key: string; role: 'page_title' | 'meta_description' }>>();
  for (const plan of planned) {
    const source = readFileSync(join(cwd, plan.file), 'utf8');
    writes.push(asUpdate(planWrite(join(cwd, plan.file), applyFileEdits(source, plan.edits), plan.file)));
    if (plan.mints.length === 0) continue;
    const page = pageOfFile(cwd, plan.file, descriptor.pages, { html: true });
    if (page !== undefined) mintsByPage.set(page, [...(mintsByPage.get(page) ?? []), ...plan.mints]);
    for (const mint of plan.mints) {
      // No `pages` yet: the validator refuses a key naming an undeclared page, and the declaration lists it.
      const limits = headLimitsFor([mint.role]);
      descriptor.keys[mint.key] = { shape: 'text', target: DEFAULT_TARGET, ...(limits === undefined ? {} : { limits }) };
      (snapshot[config.locales.default] ??= {})[mint.key] = '';
    }
  }
  if (mintsByPage.size > 0) {
    writes.push(asUpdate(planJson(join(cwd, config.descriptorPath), descriptor, config.descriptorPath)));
    writes.push(asUpdate(planJson(join(cwd, config.snapshotPath), snapshot, config.snapshotPath)));
  }
  try {
    writePlanned(writes);
  } catch (error) {
    rethrowBatchFailure('stet audit lighthouse --fix --write', error);
  }
  report.line('');
  for (const plan of planned) report.line(`${plan.file}: ${plural(plan.lines.filter((line) => !line.startsWith('set language')).length, 'edit')} applied`);
  for (const [page, mints] of mintsByPage) {
    const keys = mints.map((mint) => mint.key);
    let declaredRoute: string | undefined;
    try {
      const set = proposeForHost(cwd, config, descriptor);
      if (set !== null) applyPages(cwd, config, descriptor, snapshot, set, [page], new Report());
      declaredRoute = descriptor.pages?.[page]?.route;
    } catch {
      declaredRoute = undefined;
    }
    if (declaredRoute === undefined) {
      report.line(`${page}: not declared — run stet pages scan --apply ${page}`);
      continue;
    }
    report.line(
      keys.length === 1
        ? `${page}: declared (${declaredRoute}) — ${keys[0] as string} is empty; fill it in the dashboard's SEO group or ${config.snapshotPath}`
        : `${page}: declared (${declaredRoute}) — ${keys.join(' and ')} are empty; fill them in the dashboard's SEO group or ${config.snapshotPath}`,
    );
  }
  return planned.map((plan) => plan.file);
}

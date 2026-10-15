/**
 * Reading one Lighthouse run: who acts on each failing audit, where its
 * element sits, the line it prints, and the median over `--runs`.
 */

import { noindexes, resolvedString } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, PageDef } from '../src/types.js';
import { attrOf, attrValueOf, htmlBaseName, parentsOf, readDocument, sectionWordOf, type Document, type Element } from './html-host.js';
import { numberNames } from './key-names.js';
import { CATEGORIES, type LighthouseResult } from './lighthouse-run.js';
import { sharedTextIndex } from './register-run.js';
import { plural } from './report.js';
import { labelRemedy } from './seo-documents.js';

/** Who acts on a failing audit; `diag` is printed on one line and never counted. */
export type Owner = 'copy' | 'fix' | 'stet' | 'host' | 'diag';

/** The owner per audit id, or a rule for the two whose owner depends on the page. */
export const AUDIT_OWNERS: Readonly<Record<string, Owner | 'robots' | 'canonical'>> = {
  // Performance — the five metrics. The two `stet` footprint lines print before them.
  'first-contentful-paint': 'host',
  'largest-contentful-paint': 'host',
  'total-blocking-time': 'host',
  'cumulative-layout-shift': 'host',
  'speed-index': 'host',
  // Accessibility — copy.
  label: 'copy', 'select-name': 'copy', 'button-name': 'copy', 'link-name': 'copy', 'input-button-name': 'copy',
  'input-image-alt': 'copy', 'object-alt': 'copy', 'frame-title': 'copy', 'image-alt': 'copy', 'document-title': 'copy',
  'aria-command-name': 'copy', 'aria-dialog-name': 'copy', 'aria-input-field-name': 'copy', 'aria-meter-name': 'copy',
  'aria-progressbar-name': 'copy', 'aria-toggle-field-name': 'copy', 'aria-tooltip-name': 'copy', 'aria-treeitem-name': 'copy',
  'svg-img-alt': 'copy',
  // Accessibility — fix.
  'html-has-lang': 'fix', 'html-lang-valid': 'fix',
  // Accessibility — host.
  'meta-viewport': 'host', 'landmark-one-main': 'host', 'heading-order': 'host', bypass: 'host', 'skip-link': 'host',
  'color-contrast': 'host', 'link-in-text-block': 'host', 'target-size': 'host', accesskeys: 'host', tabindex: 'host',
  'duplicate-id-aria': 'host', 'meta-refresh': 'host', 'autocomplete-valid': 'host', 'presentation-role-conflict': 'host',
  'aria-allowed-attr': 'host', 'aria-conditional-attr': 'host', 'aria-deprecated-role': 'host', 'aria-hidden-body': 'host',
  'aria-hidden-focus': 'host', 'aria-prohibited-attr': 'host', 'aria-required-attr': 'host', 'aria-required-children': 'host',
  'aria-required-parent': 'host', 'aria-roles': 'host', 'aria-text': 'host', 'aria-valid-attr-value': 'host',
  'aria-valid-attr': 'host', 'form-field-multiple-labels': 'host', list: 'host', listitem: 'host', 'definition-list': 'host',
  dlitem: 'host', 'td-headers-attr': 'host', 'th-has-data-cells': 'host', 'valid-lang': 'host', 'html-xml-lang-mismatch': 'host',
  'video-caption': 'host',
  // Best Practices.
  doctype: 'fix', charset: 'fix',
  'is-on-https': 'host', 'redirects-http': 'host', 'errors-in-console': 'host', deprecations: 'host',
  'third-party-cookies': 'host', 'inspector-issues': 'host', 'geolocation-on-start': 'host', 'notification-on-start': 'host',
  'paste-preventing-inputs': 'host', 'image-aspect-ratio': 'host', 'image-size-responsive': 'host',
  // SEO.
  'meta-description': 'copy', 'link-text': 'copy',
  'is-crawlable': 'robots', canonical: 'canonical',
  hreflang: 'host', 'http-status-code': 'host', 'crawlable-anchors': 'host', 'robots-txt': 'host',
};

type Audit = LighthouseResult['audits'][string];

/** A failing audit: a score below 1 that is not a not-applicable, manual or informative one. */
export function isFailing(audit: Audit | undefined): boolean {
  return (
    audit !== undefined &&
    typeof audit.score === 'number' &&
    audit.score < 1 &&
    audit.scoreDisplayMode !== 'notApplicable' &&
    audit.scoreDisplayMode !== 'manual' &&
    audit.scoreDisplayMode !== 'informative'
  );
}

/** What a page's run is read against: the page and its record, the forms, and the file the head lines name. */
export interface PageContext {
  router: 'app' | 'pages' | 'astro' | 'vite' | 'html';
  page: string | null;
  def: PageDef | undefined;
  descriptor: Descriptor;
  snapshot: Snapshot;
  /** The page's document on the html host. */
  document: Document | null;
  /** The file a head line names: the document, Vite's `index.html`, the Next layout or page file, the Astro page. */
  file: string | null;
  /** `--fix` runs, so a fix line points at the plan printed below. */
  fix: boolean;
}

/**
 * The owner of an audit: its row, `robots` reading `copy` where the page's
 * robots key carries `noindex` and `canonical` where its canonical key
 * resolves non-empty; an id the table does not carry is `diag` where every
 * reference to it in this run weighs 0, else `host` — a newer Lighthouse's
 * weighted audit.
 */
export function ownerOf(id: string, lhr: LighthouseResult, context: Pick<PageContext, 'def' | 'descriptor' | 'snapshot'>): Owner {
  const row = Object.hasOwn(AUDIT_OWNERS, id) ? AUDIT_OWNERS[id] : undefined;
  const { def, descriptor, snapshot } = context;
  if (row === 'robots') return def !== undefined && noindexes(descriptor, snapshot, def, 'default') ? 'copy' : 'host';
  if (row === 'canonical') {
    const key = def?.seo?.canonical;
    return key !== undefined && resolvedString(descriptor, snapshot, key, 'default') !== undefined ? 'copy' : 'host';
  }
  if (row !== undefined) return row;
  const weights = Object.values(lhr.categories).flatMap((category) => category.auditRefs.filter((ref) => ref.id === id).map((ref) => ref.weight));
  return weights.some((weight) => weight > 0) ? 'host' : 'diag';
}

/** The snippet's open tag as an element: its tag and attributes. */
function snippetElement(snippet: string): Element | null {
  const open = /^<[a-zA-Z][^>]*>/.exec(snippet.trim());
  if (open === null) return null;
  return readDocument('snippet', open[0]).roots[0] ?? null;
}

/**
 * The one element of `document` a Lighthouse snippet's open tag names, or null
 * where none or several match. A subset match, because Lighthouse's snippet can
 * drop attributes the source carries: the tag equal, and every attribute the
 * snippet carries present with an equal decoded value — a value ending `…`
 * matching by its prefix.
 */
export function elementOfSnippet(document: Document, snippet: string): Element | null {
  const wanted = snippetElement(snippet);
  if (wanted === null) return null;
  const all = document.roots.flatMap((root) => [root, ...root.descendants]);
  const matches = all.filter(
    (el) =>
      el.tag === wanted.tag &&
      wanted.attrs.every((want) => {
        const have = el.attrs.find((a) => a.name === want.name);
        if (have === undefined) return false;
        const value = attrValueOf(want);
        return value.endsWith('…') ? attrValueOf(have).startsWith(value.slice(0, -1)) : attrValueOf(have) === value;
      }),
  );
  return matches.length === 1 ? (matches[0] as Element) : null;
}

/** One failing weighted audit as the page reads it. */
export interface AuditReport {
  id: string;
  category: string;
  weight: number;
  score: number | null;
  owner: Owner;
  at?: string;
  key?: string;
  snippet?: string;
  items?: Array<Record<string, unknown>>;
  remedy: string;
}

/** The first item's node, at `items[0].node` or under `items[0].node` of a nested table. */
function firstNode(audit: Audit): Record<string, unknown> | undefined {
  for (const item of audit.details?.items ?? []) {
    const node = item['node'];
    if (node !== null && typeof node === 'object') return node as Record<string, unknown>;
  }
  return undefined;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** `a`, `a and b`, `a, b and c`. */
function listed(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
}

/** The key a mark on the element names, or the first key holding its text on a JavaScript host. */
function keyOf(el: Element | null, node: Record<string, unknown> | undefined, context: PageContext): string | undefined {
  if (el !== null) return attrOf(el, 'data-stet');
  if (context.router === 'html') return undefined;
  const label = str(node?.['nodeLabel']);
  return label === undefined ? undefined : sharedTextIndex(context.descriptor, context.snapshot).get(label)?.[0];
}

/** A key declared and resolving to nothing. */
function emptyKey(context: PageContext, key: string | undefined): key is string {
  return key !== undefined && Object.hasOwn(context.descriptor.keys, key) && resolvedString(context.descriptor, context.snapshot, key, 'default') === undefined;
}

/** The pathname of a URL, else the text as given. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * The remedy for one failing audit, and whether the line carries the
 * element's place before it: a page-level remedy names its own file.
 */
function remedyOf(
  id: string,
  audit: Audit,
  lhr: LighthouseResult,
  el: Element | null,
  key: string | undefined,
  context: PageContext,
): { text: string; place: boolean; owner?: Owner } {
  const node = firstNode(audit);
  const snippet = str(node?.['snippet']);
  const file = context.file ?? context.page ?? '/';
  const viaFix = context.fix ? '— in the plan below' : '— stet audit lighthouse --fix plans it';
  const shaped = el ?? (snippet === undefined ? null : snippetElement(snippet));
  switch (id) {
    case 'label':
    case 'select-name': {
      const base = `has no label — ${shaped === null ? 'wrap it in a <label>' : labelRemedy(shaped)}`;
      if (context.router !== 'html' || el === null || context.document === null || context.page === null) return { text: base, place: true };
      const name = htmlBaseName(context.page, { sectionWord: sectionWordOf(el, parentsOf(context.document)), role: 'label', kind: 'element', tag: 'label' });
      const [numbered] = numberNames([name], (n) => Object.hasOwn(context.descriptor.keys, n));
      return { text: `${base}; stet register adopts its words as ${numbered as string}`, place: true };
    }
    case 'button-name':
    case 'link-name':
    case 'input-button-name':
    case 'input-image-alt':
    case 'object-alt':
    case 'frame-title':
      return { text: emptyKey(context, key) ? `${key} is empty` : 'has no accessible name — give it text, or an aria-label', place: true };
    case 'image-alt':
      return { text: 'has no alt — write alt text, or alt="" for a decorative image', place: true };
    case 'svg-img-alt':
      return { text: 'has no <title> — give it a <title> or an aria-label', place: true };
    case 'document-title':
    case 'meta-description': {
      const title = id === 'document-title';
      const pageKey = title ? context.def?.seo?.title : context.def?.seo?.description;
      if (emptyKey(context, pageKey)) return { text: `${pageKey} is empty`, place: false };
      const tag = title ? 'title' : 'description';
      if (context.router === 'html' && context.page !== null) {
        const [bound] = numberNames([`${context.page}_${title ? 'page_title' : 'meta_description'}`], (n) => Object.hasOwn(context.descriptor.keys, n));
        return { text: `${file} has no ${tag} ${viaFix}, bound to ${bound as string}`, place: false };
      }
      if ((context.router === 'app' || context.router === 'pages') && context.file !== null) {
        return { text: `set ${tag} in the metadata export of ${context.file}`, place: false };
      }
      if (context.router === 'astro' && context.file !== null && context.page !== null) {
        const [bound] = numberNames([`${context.page}_${title ? 'page_title' : 'meta_description'}`], (n) => Object.hasOwn(context.descriptor.keys, n));
        const element = title ? `<title data-stet="${bound as string}"></title>` : `<meta name="description" content="" data-stet-content="${bound as string}">`;
        return { text: `add ${element} to ${context.file}`, place: false };
      }
      return { text: audit.title, place: false };
    }
    case 'link-text': {
      const text = str(node?.['nodeLabel']) ?? '';
      return { text: `"${text}"${key === undefined ? '' : ` (${key})`} is a generic link label — anchor text should name where it goes`, place: true };
    }
    case 'is-crawlable':
      return { text: `${context.def?.seo?.robots ?? ''} says noindex — this page will not be indexed; clear it if that is not meant`, place: false };
    case 'canonical':
      return { text: `${context.def?.seo?.canonical ?? ''} sets the canonical — Lighthouse reports: ${audit.title}`, place: false };
    case 'html-has-lang':
    case 'html-lang-valid':
      return { text: `${file} has no lang ${viaFix}`, place: false };
    case 'charset':
      return { text: `${file} has no meta charset ${viaFix}`, place: false };
    case 'doctype':
      // A legacy doctype is one `--fix` counts as present: replacing it changes the document's mode, so it is reported.
      if (context.document !== null && /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\s+html\b/i.test(context.document.source)) {
        return { text: `${file} — replace the legacy doctype with <!DOCTYPE html>`, place: false, owner: 'host' };
      }
      return { text: `${file} has no doctype ${viaFix}`, place: false };
    case 'target-size': {
      const rect = node?.['boundingRect'] as { width?: number; height?: number } | undefined;
      const noun = shaped?.tag === 'a' ? 'link' : shaped?.tag === 'button' ? 'button' : 'control';
      return { text: `is ${Math.round(rect?.width ?? 0)}×${Math.round(rect?.height ?? 0)} px — pad the ${noun} to at least 24×24 px and space it from its neighbours`, place: true };
    }
    case 'errors-in-console': {
      const items = audit.details?.items ?? [];
      const url = (item: Record<string, unknown>): string => str((item['sourceLocation'] as Record<string, unknown> | undefined)?.['url']) ?? '';
      if (items.length > 0 && items.every((item) => /status of 404\b/.test(str(item['description']) ?? ''))) {
        return { text: `${listed(items.map((item) => pathOf(url(item))))} answered 404 — add the files, or drop the references`, place: false };
      }
      const first = items[0];
      return {
        text: `${plural(items.length, 'console error')} — the first: ${str(first?.['description']) ?? audit.title} (${first === undefined ? '' : url(first)})`,
        place: false,
      };
    }
    case 'landmark-one-main': {
      const body = context.document?.roots.flatMap((root) => [root, ...root.descendants]).find((e) => e.tag === 'body');
      const first = body?.children[0];
      if (context.document === null || first === undefined) return { text: audit.title, place: false };
      return { text: `wrap the page's content in <main> — the first content element is ${context.document.source.slice(first.openStart, first.openEnd)}`, place: false };
    }
    case 'list':
      return { text: 'holds text outside an <li> — move the bare run into an <li>, or out of the list', place: true };
    case 'color-contrast': {
      const explanation = str(node?.['explanation']) ?? '';
      const m = /contrast of ([\d.]+) \(foreground color: (#[0-9a-f]{3,8}), background color: (#[0-9a-f]{3,8}).*?expected contrast ratio of ([\d.]+):1/i.exec(explanation.replace(/\n/g, ' '));
      return m === null
        ? { text: audit.title, place: true }
        : { text: `has contrast ${m[1] as string}:1 (${m[2] as string} on ${m[3] as string}) — raise it to ${m[4] as string}:1`, place: true };
    }
    case 'image-size-responsive': {
      const item = audit.details?.items?.[0] ?? {};
      return {
        text: `${str(item['url']) ?? ''} is shown at ${str(item['displayedSize']) ?? ''} and is ${str(item['actualSize']) ?? ''} — serve one at least ${str(item['expectedSize']) ?? ''}`,
        place: false,
      };
    }
    case 'first-contentful-paint':
    case 'largest-contentful-paint': {
      const blocking = lhr.audits['render-blocking-insight']?.details?.items?.[0];
      const url = str(blocking?.['url']);
      const shown = audit.displayValue ?? '';
      if (url === undefined) return { text: `${shown} — ${audit.title}`, place: false };
      const request = (lhr.audits['network-requests']?.details?.items ?? []).find((item) => item['url'] === url);
      const seconds = (Number(blocking?.['wastedMs'] ?? 0) / 1000).toFixed(1);
      const how = request?.['resourceType'] === 'Script' ? 'defer it' : `load it with media="print" onload="this.media='all'", or self-host it`;
      return { text: `${shown} — ${url} blocks the first paint for ${seconds} s: ${how}`, place: false };
    }
    case 'meta-viewport':
      return { text: 'stops pinch zoom — drop user-scalable=no and keep maximum-scale at 5 or more', place: true };
    default:
      return { text: audit.title, place: false };
  }
}

/** One page's run read: the failing weighted audits with their lines, and the diagnostics. */
export interface PageRead {
  audits: AuditReport[];
  lines: string[];
  diagnostics: string[];
}

/**
 * Every failing audit of a run, read once per page: an audit two categories
 * weight prints once, under the first that weights it. The weighted ones print
 * a line each in category, then reference order; the `diag` ones share one
 * line in the order Lighthouse lists them.
 */
export function readRun(lhr: LighthouseResult, context: PageContext): PageRead {
  const seen = new Set<string>();
  const audits: AuditReport[] = [];
  const lines: string[] = [];
  for (const category of CATEGORIES) {
    for (const ref of lhr.categories[category]?.auditRefs ?? []) {
      if (seen.has(ref.id)) continue;
      const audit = lhr.audits[ref.id];
      if (!isFailing(audit) || audit === undefined) continue;
      const owner = ownerOf(ref.id, lhr, context);
      if (owner === 'diag') continue;
      seen.add(ref.id);
      const node = firstNode(audit);
      const snippet = str(node?.['snippet']);
      const el = context.document !== null && snippet !== undefined ? elementOfSnippet(context.document, snippet) : null;
      const key = keyOf(el, node, context);
      const at = el !== null && context.document !== null ? `${context.document.file}:${context.document.lineAt(el.openStart)}` : undefined;
      const remedy = remedyOf(ref.id, audit, lhr, el, key, context);
      const lineOwner = remedy.owner ?? owner;
      const place = remedy.place ? [at, snippet].filter((part) => part !== undefined).join(' ') : '';
      lines.push(`${lineOwner}  ${ref.id}  ${place === '' ? '' : `${place} `}${remedy.text}`);
      audits.push({
        id: ref.id,
        category,
        weight: ref.weight,
        score: audit.score,
        owner: lineOwner,
        ...(at === undefined ? {} : { at }),
        ...(key === undefined ? {} : { key }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(audit.details?.items === undefined ? {} : { items: audit.details.items }),
        remedy: remedy.text,
      });
    }
  }
  const diagnostics: string[] = [];
  const shown: string[] = [];
  for (const [id, audit] of Object.entries(lhr.audits)) {
    if (seen.has(id) || !isFailing(audit) || ownerOf(id, lhr, context) !== 'diag') continue;
    diagnostics.push(id);
    shown.push(audit.displayValue === undefined ? id : `${id} ${audit.displayValue}`);
  }
  if (shown.length > 0) lines.push(`diag  ${shown.join(' · ')} — Lighthouse diagnostics; they do not move the score`);
  return { audits, lines, diagnostics };
}

/** A category score on the page line: 0–100, or `–` where the run gave none. */
export function percent(score: number | null | undefined): number | null {
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

/** The middle of the values sorted, the lower middle for an even count. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** The scores of one category across runs, the null ones left out. */
function scoresOf(runs: LighthouseResult[], category: string): number[] {
  return runs.flatMap((run) => {
    const value = percent(run.categories[category]?.score);
    return value === null ? [] : [value];
  });
}

/** The run the lines come from: the first whose Performance equals the median. */
export function chosenRun(runs: LighthouseResult[]): number {
  const performance = scoresOf(runs, 'performance');
  if (performance.length === 0) return 0;
  const middle = median(performance);
  const at = runs.findIndex((run) => percent(run.categories['performance']?.score) === middle);
  return at === -1 ? 0 : at;
}

const LABELS: Record<(typeof CATEGORIES)[number], string> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
};

/**
 * The page line: `<document or page>  <route>  Performance <n> · …`, each
 * category's median; under `--runs` Performance names its runs in run order,
 * and on a dev server it says so.
 */
export function scoreLine(label: string, route: string, runs: LighthouseResult[], options: { devServer?: boolean } = {}): string {
  const parts = CATEGORIES.map((category) => {
    const values = scoresOf(runs, category);
    const shown = values.length === 0 ? '–' : String(median(values));
    if (category !== 'performance') return `${LABELS[category]} ${shown}`;
    const suffix = runs.length > 1 ? ` (median of ${runs.length}: ${values.join(' · ')})` : options.devServer ? ' (dev server)' : '';
    return `${LABELS[category]} ${shown}${suffix}`;
  });
  return `${label}  ${route}  ${parts.join(' · ')}`;
}

/** Each category's median score, 0–100 or null. */
export function medianScores(runs: LighthouseResult[]): Record<'performance' | 'accessibility' | 'bestPractices' | 'seo', number | null> {
  const of = (category: string): number | null => {
    const values = scoresOf(runs, category);
    return values.length === 0 ? null : median(values);
  };
  return { performance: of('performance'), accessibility: of('accessibility'), bestPractices: of('best-practices'), seo: of('seo') };
}

/**
 * The closing line: failing weighted audits across pages, the ones stet fixes
 * with the owners present, and the host's.
 */
export function closingLine(pages: number, owners: Owner[]): string {
  const counted = owners.filter((owner) => owner !== 'diag');
  const ours = (['copy', 'fix', 'stet'] as const).filter((owner) => counted.includes(owner));
  const fixes = counted.filter((owner) => owner !== 'host').length;
  return (
    `${plural(pages, 'page')} · ${plural(counted.length, 'failing audit')} · ` +
    `stet fixes ${fixes}${fixes === 0 ? '' : ` (${ours.join(', ')})`} · the host owns ${counted.filter((owner) => owner === 'host').length}`
  );
}

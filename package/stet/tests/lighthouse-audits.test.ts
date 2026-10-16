/**
 * `cli/lighthouse-audits.ts` — reading one Lighthouse run: the owner table and
 * its rules, locating an item's element, the lines, and the median over runs.
 * The runs are the saved results under `tests/fixtures/lhr/`, edited per case.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readDocument } from '../cli/html-host.js';
import {
  AUDIT_OWNERS,
  chosenRun,
  closingLine,
  elementOfSnippet,
  isFailing,
  median,
  ownerOf,
  readRun,
  scoreLine,
  type PageContext,
} from '../cli/lighthouse-audits.js';
import type { LighthouseResult } from '../cli/lighthouse-run.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { cleanLhr, savedLhr } from './helpers/lighthouse.js';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'html-host');
const fixtureDocument = (file: string) => readDocument(file, readFileSync(join(HOST, file), 'utf8'));

const homeDescriptor = (): Descriptor => ({ version: 1, keys: {}, pages: { home: { route: '/' } } });

function context(over: Partial<PageContext> = {}): PageContext {
  const descriptor = over.descriptor ?? homeDescriptor();
  return {
    router: 'html',
    page: 'home',
    def: descriptor.pages?.['home'],
    descriptor,
    snapshot: { default: {} },
    document: fixtureDocument('index.html'),
    file: 'index.html',
    fix: false,
    ...over,
  };
}

/** A clean run with one audit failing, its first item's node given. */
function failing(id: string, item: Record<string, unknown> = {}, base: LighthouseResult = cleanLhr()): LighthouseResult {
  const lhr = structuredClone(base);
  const audit = lhr.audits[id] ?? { id, title: `${id} title`, description: '', score: 0, scoreDisplayMode: 'binary' };
  lhr.audits[id] = { ...audit, score: 0, scoreDisplayMode: 'binary', details: { type: 'table', items: Object.keys(item).length === 0 ? [] : [item] } };
  return lhr;
}

describe('the owner table (D4)', () => {
  it("carries exactly the ids Lighthouse 13.5.0's four categories weight above 0, each once", async () => {
    const { default: config } = (await import('lighthouse/core/config/default-config.js')) as {
      default: { categories: Record<string, { auditRefs: Array<{ id: string; weight: number }> }> };
    };
    const weighted = new Set<string>();
    for (const category of ['performance', 'accessibility', 'best-practices', 'seo']) {
      for (const ref of config.categories[category]?.auditRefs ?? []) if (ref.weight > 0) weighted.add(ref.id);
    }
    const rows = Object.keys(AUDIT_OWNERS);
    expect(rows).toHaveLength(84);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...weighted].sort()).toEqual([...rows].sort());
    // The walkthrough's §2 rows, spot-checked by owner; meta-viewport is host (D4's correction).
    expect(AUDIT_OWNERS['label']).toBe('copy');
    expect(AUDIT_OWNERS['meta-description']).toBe('copy');
    expect(AUDIT_OWNERS['html-has-lang']).toBe('fix');
    expect(AUDIT_OWNERS['charset']).toBe('fix');
    expect(AUDIT_OWNERS['meta-viewport']).toBe('host');
    expect(AUDIT_OWNERS['target-size']).toBe('host');
    expect(AUDIT_OWNERS['is-crawlable']).toBe('robots');
    expect(AUDIT_OWNERS['canonical']).toBe('canonical');
  });

  it('reads is-crawlable and canonical by the page: copy where its key says so, host otherwise', () => {
    const descriptor: Descriptor = {
      version: 1,
      keys: { home_robots: { shape: 'text', target: 'web' }, home_canonical: { shape: 'text', target: 'web' } },
      pages: { home: { route: '/', seo: { robots: 'home_robots', canonical: 'home_canonical' } } },
    };
    const def = descriptor.pages?.['home'];
    const lhr = cleanLhr();
    const with_ = (snapshot: Snapshot) => ({ def, descriptor, snapshot });
    expect(ownerOf('is-crawlable', lhr, with_({ default: { home_robots: 'noindex, follow', home_canonical: '' } }))).toBe('copy');
    expect(ownerOf('is-crawlable', lhr, with_({ default: { home_robots: 'index', home_canonical: '' } }))).toBe('host');
    expect(ownerOf('canonical', lhr, with_({ default: { home_robots: '', home_canonical: 'https://example.com/' } }))).toBe('copy');
    expect(ownerOf('canonical', lhr, with_({ default: { home_robots: '', home_canonical: '' } }))).toBe('host');
    expect(ownerOf('canonical', lhr, { def: { route: '/' }, descriptor, snapshot: { default: {} } })).toBe('host');
  });

  it("reads an id the table does not carry as host where the run weighs it, else diag", () => {
    const lhr = cleanLhr();
    lhr.categories['accessibility']?.auditRefs.push({ id: 'foo-bar', weight: 3 });
    expect(ownerOf('foo-bar', lhr, context())).toBe('host');
    lhr.categories['accessibility']?.auditRefs.splice(-1, 1, { id: 'foo-bar', weight: 0 });
    expect(ownerOf('foo-bar', lhr, context())).toBe('diag');
  });

  it('never counts a notApplicable, manual or informative audit as failing', () => {
    const audit = { id: 'x', title: 'x', description: '', score: 0, scoreDisplayMode: 'binary' };
    expect(isFailing(audit)).toBe(true);
    for (const mode of ['notApplicable', 'manual', 'informative']) expect(isFailing({ ...audit, scoreDisplayMode: mode })).toBe(false);
    expect(isFailing({ ...audit, score: null })).toBe(false);
    expect(isFailing({ ...audit, score: 1 })).toBe(false);
  });

  it("fails a numeric audit only below Lighthouse's 0.9 pass band, a binary one below 1", () => {
    const audit = { id: 'x', title: 'x', description: '', score: 0.95, scoreDisplayMode: 'numeric' };
    expect(isFailing(audit)).toBe(false);
    expect(isFailing({ ...audit, score: 0.9 })).toBe(false);
    expect(isFailing({ ...audit, score: 0.85 })).toBe(true);
    expect(isFailing({ ...audit, score: 0, scoreDisplayMode: 'binary' })).toBe(true);
    expect(isFailing({ ...audit, score: 0.95, scoreDisplayMode: 'binary' })).toBe(true);
  });
});

describe('elementOfSnippet (D4)', () => {
  it("names the fixture's <a href=\"/plain\"> at index.html:47 though the source carries title=plain", () => {
    const document = fixtureDocument('index.html');
    const el = elementOfSnippet(document, '<a href="/plain">');
    expect(el).not.toBeNull();
    expect(document.lineAt(el?.openStart ?? 0)).toBe(47);
  });

  it('matches a snippet value decoded, and a …-truncated value by its prefix', () => {
    const document = readDocument('a.html', '<html><body><img alt="&nosuch;" src="/a.png"><img alt="A very long description of the bench" src="/b.png"></body></html>');
    expect(elementOfSnippet(document, '<img alt="&amp;nosuch;">')?.attrs.find((a) => a.name === 'src')?.value).toBe('/a.png');
    expect(elementOfSnippet(document, '<img alt="A very long desc…">')?.attrs.find((a) => a.name === 'src')?.value).toBe('/b.png');
  });

  it('answers null for two equal elements, and for none', () => {
    const document = readDocument('a.html', '<html><body><a href="/x">One</a><a href="/x">Two</a></body></html>');
    expect(elementOfSnippet(document, '<a href="/x">')).toBeNull();
    expect(elementOfSnippet(document, '<a href="/y">')).toBeNull();
  });

  it("reads link-text's own rows, href and text with no node, and names the key by the text", () => {
    const lhr = failing('link-text', { href: 'https://react.dev/', text: 'Learn more', textLang: 'en' });
    const descriptor: Descriptor = { version: 1, keys: { app_link_text: { shape: 'text', target: 'web' } } };
    const read = readRun(lhr, context({ router: 'vite', document: null, descriptor, def: undefined, snapshot: { default: { app_link_text: 'Learn more' } }, file: 'index.html' }));
    expect(read.lines[0]).toBe('copy  link-text  "Learn more" (app_link_text) is a generic link label — anchor text should name where it goes');
    expect(read.audits[0]?.key).toBe('app_link_text');
  });

  it("names the key on a JavaScript host by the element's text", () => {
    const lhr = failing('link-text', { node: { snippet: '<a href="/docs">', nodeLabel: 'Learn more' } });
    const descriptor: Descriptor = { version: 1, keys: { home_link_text: { shape: 'text', target: 'web' } } };
    const read = readRun(lhr, context({ router: 'app', document: null, descriptor, def: undefined, snapshot: { default: { home_link_text: 'Learn more' } }, file: 'app/layout.tsx' }));
    expect(read.lines[0]).toBe('copy  link-text  <a href="/docs"> "Learn more" (home_link_text) is a generic link label — anchor text should name where it goes');
    expect(read.audits[0]?.key).toBe('home_link_text');
  });
});

describe('the lines (D4)', () => {
  it("prints the fixture's three findings with their owners, the diagnostics line and the closing line", () => {
    const read = readRun(savedLhr('index.html'), context());
    expect(read.lines).toEqual([
      'copy  label  index.html:50 <textarea name="notes"> has no label — give it id="notes" and write a <label for="notes">; stet register adopts its words as home_contact_label',
      'host  target-size  index.html:47 <a href="/plain"> is 76×18 px — pad the link to at least 24×24 px and space it from its neighbours',
      'host  errors-in-console  /bench.jpg and /favicon.ico answered 404 — add the files, or drop the references',
      'diag  unsized-images · document-latency-insight Est savings of 1 KiB — Lighthouse diagnostics; they do not move the score',
    ]);
    // The diagnostics never count, though they pass through the closing line's owners.
    expect(closingLine(1, [...read.audits.map((a) => a.owner), ...read.diagnostics.map(() => 'diag' as const)])).toBe(
      '1 page · 3 failing audits · stet fixes 1 (copy) · the host owns 2',
    );
  });

  it('prints a fix line pointing at --fix, or at the plan below under it', () => {
    const lhr = failing('html-has-lang', { node: { snippet: '<html>' } });
    const edges = context({ document: fixtureDocument('edges.html'), file: 'edges.html', page: 'edges' });
    const plain = readRun(lhr, edges);
    expect(plain.lines).toEqual(['fix  html-has-lang  edges.html has no lang — stet audit lighthouse --fix plans it']);
    expect(closingLine(1, plain.audits.map((a) => a.owner))).toBe('1 page · 1 failing audit · stet fixes 1 (fix) · the host owns 0');
    expect(readRun(lhr, { ...edges, fix: true }).lines).toEqual(['fix  html-has-lang  edges.html has no lang — in the plan below']);
  });

  it('reads a failing doctype on a document carrying a legacy one as the host’s', () => {
    const document = readDocument('legacy.html', '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html lang="en"><head><title>Old</title></head><body></body></html>\n');
    const read = readRun(failing('doctype'), context({ document, file: 'legacy.html' }));
    expect(read.lines).toEqual(['host  doctype  legacy.html — replace the legacy doctype with <!DOCTYPE html>']);
    expect(closingLine(1, read.audits.map((a) => a.owner))).toBe('1 page · 1 failing audit · stet fixes 0 · the host owns 1');
  });

  it('prints image-alt once though Accessibility and SEO both weigh it, under accessibility', () => {
    const read = readRun(failing('image-alt', { node: { snippet: '<img src="/x.png">' } }), context({ document: null }));
    expect(read.lines).toEqual(['copy  image-alt  <img src="/x.png"> has no alt — write alt text, or alt="" for a decorative image']);
    expect(read.audits.map((a) => a.category)).toEqual(['accessibility']);
    expect(closingLine(1, read.audits.map((a) => a.owner))).toBe('1 page · 1 failing audit · stet fixes 1 (copy) · the host owns 0');
  });

  it('names a render-blocking stylesheet in the paint lines, and a script with defer', () => {
    const fonts = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap';
    const lhr = cleanLhr();
    for (const id of ['first-contentful-paint', 'largest-contentful-paint']) {
      lhr.audits[id] = { ...(lhr.audits[id] as LighthouseResult['audits'][string]), score: 0.85, scoreDisplayMode: 'numeric', displayValue: '1.6 s' };
    }
    lhr.audits['render-blocking-insight'] = { id: 'render-blocking-insight', title: 'Render blocking requests', description: '', score: 0, scoreDisplayMode: 'metricSavings', details: { type: 'table', items: [{ url: fonts, totalBytes: 1245, wastedMs: 869 }] } };
    lhr.audits['network-requests']?.details?.items?.push({ url: fonts, resourceType: 'Stylesheet' });
    const read = readRun(lhr, context({ document: null }));
    const line = `host  first-contentful-paint  1.6 s — ${fonts} blocks the first paint for 0.9 s: load it with media="print" onload="this.media='all'", or self-host it`;
    expect(read.lines[0]).toBe(line);
    expect(read.lines[1]).toBe(line.replace('first-contentful-paint', 'largest-contentful-paint'));
    const items = lhr.audits['network-requests']?.details?.items ?? [];
    (items[items.length - 1] as Record<string, unknown>)['resourceType'] = 'Script';
    expect(readRun(lhr, context({ document: null })).lines[0]).toMatch(/blocks the first paint for 0\.9 s: defer it$/);
  });

  it("prints Lighthouse's title where the render-blocking saving is under 50 ms", () => {
    const fonts = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap';
    const lhr = cleanLhr();
    for (const id of ['first-contentful-paint', 'largest-contentful-paint']) {
      lhr.audits[id] = { ...(lhr.audits[id] as LighthouseResult['audits'][string]), score: 0.85, scoreDisplayMode: 'numeric', displayValue: '1.6 s' };
    }
    lhr.audits['render-blocking-insight'] = { id: 'render-blocking-insight', title: 'Render blocking requests', description: '', score: 0, scoreDisplayMode: 'metricSavings', details: { type: 'table', items: [{ url: fonts, totalBytes: 1245, wastedMs: 20 }] } };
    lhr.audits['network-requests']?.details?.items?.push({ url: fonts, resourceType: 'Stylesheet' });
    const fcp = lhr.audits['first-contentful-paint'] as LighthouseResult['audits'][string];
    expect(readRun(lhr, context({ document: null })).lines[0]).toBe(`host  first-contentful-paint  1.6 s — ${fcp.title}`);
    // 50 ms is the bound itself: the remedy prints.
    (lhr.audits['render-blocking-insight']?.details?.items?.[0] as Record<string, unknown>)['wastedMs'] = 50;
    expect(readRun(lhr, context({ document: null })).lines[0]).toMatch(/blocks the first paint for 0\.1 s: load it with media="print"/);
  });

  it("reads color-contrast's explanation, and prints the title where it cannot", () => {
    const explanation =
      'Fix any of the following:\n  Element has insufficient color contrast of 3.2 (foreground color: #777777, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1';
    const read = readRun(failing('color-contrast', { node: { snippet: '<p class="muted">', explanation } }), context({ document: null }));
    expect(read.lines[0]).toBe('host  color-contrast  <p class="muted"> has contrast 3.2:1 (#777777 on #ffffff) — raise it to 4.5:1');
    const title = cleanLhr().audits['color-contrast']?.title as string;
    expect(readRun(failing('color-contrast', { node: { snippet: '<p>', explanation: 'no numbers here' } }), context({ document: null })).lines[0]).toBe(
      `host  color-contrast  <p> ${title}`,
    );
  });

  it('prints an image-size-responsive item and a meta-viewport snippet', () => {
    const sized = readRun(
      failing('image-size-responsive', { url: 'https://127.0.0.1:1/bench.jpg', displayedSize: '209 x 140', actualSize: '209 x 140', expectedSize: '418 x 280' }),
      context({ document: null }),
    );
    expect(sized.lines[0]).toBe('host  image-size-responsive  https://127.0.0.1:1/bench.jpg is shown at 209 x 140 and is 209 x 140 — serve one at least 418 x 280');
    const zoom = readRun(failing('meta-viewport', { node: { snippet: '<meta name="viewport" content="width=device-width, user-scalable=no">' } }), context({ document: null }));
    expect(zoom.lines[0]).toBe(
      'host  meta-viewport  <meta name="viewport" content="width=device-width, user-scalable=no"> stops pinch zoom — drop user-scalable=no and keep maximum-scale at 5 or more',
    );
  });

  it("prints an unknown weighted audit with Lighthouse's title and counts it under the host", () => {
    const lhr = failing('foo-bar');
    lhr.categories['accessibility']?.auditRefs.push({ id: 'foo-bar', weight: 3 });
    const read = readRun(lhr, context({ document: null }));
    expect(read.lines).toEqual(['host  foo-bar  foo-bar title']);
    expect(closingLine(1, read.audits.map((a) => a.owner))).toBe('1 page · 1 failing audit · stet fixes 0 · the host owns 1');
  });

  it('prints the empty key where the page binds one, and the plan line where the head lacks the tag', () => {
    const descriptor: Descriptor = {
      version: 1,
      keys: { edges_meta_description: { shape: 'text', target: 'web' } },
      pages: { edges: { route: '/edges', seo: { description: 'edges_meta_description' } } },
    };
    const bound = readRun(failing('meta-description'), context({ descriptor, def: descriptor.pages?.['edges'], page: 'edges', snapshot: { default: { edges_meta_description: '' } }, file: 'edges.html' }));
    expect(bound.lines).toEqual(['copy  meta-description  edges_meta_description is empty']);
    expect(bound.audits[0]?.key).toBe('edges_meta_description');
    const absent = readRun(failing('meta-description'), context({ def: { route: '/edges' }, page: 'edges', file: 'edges.html', fix: true }));
    expect(absent.lines).toEqual(['copy  meta-description  edges.html has no description — in the plan below, bound to edges_meta_description']);
    expect(absent.audits[0]?.key).toBe('edges_meta_description');
  });

  it('carries no key on an audit whose line names none, though a remedy word could match a declared key', () => {
    const descriptor: Descriptor = { version: 1, keys: { label: { shape: 'text', target: 'web' }, alt: { shape: 'text', target: 'web' } }, pages: { home: { route: '/' } } };
    const read = readRun(failing('image-alt', { node: { snippet: '<img src="/a.png">' } }), context({ descriptor, def: descriptor.pages?.['home'], document: null }));
    expect(read.lines[0]).toContain('has no alt — write alt text');
    expect(read.audits[0]?.key).toBeUndefined();
  });
});

describe('runs and the median (D4)', () => {
  const withPerformance = (scores: number[]): LighthouseResult[] =>
    scores.map((score) => {
      const lhr = cleanLhr();
      (lhr.categories['performance'] as { score: number | null }).score = score / 100;
      return lhr;
    });

  it('prints the median of five with its runs, the lines from the first run equal to it', () => {
    const runs = withPerformance([92, 99, 92, 100, 92]);
    expect(scoreLine('index.html', '/', runs)).toBe('index.html  /  Performance 92 (median of 5: 92 · 99 · 92 · 100 · 92) · Accessibility 100 · Best Practices 100 · SEO 100');
    expect(chosenRun(runs)).toBe(0);
    expect(chosenRun(withPerformance([100, 90, 95]))).toBe(2);
  });

  it('takes the lower middle for an even count', () => {
    expect(median([100, 90])).toBe(90);
    expect(median([97, 99, 98, 100])).toBe(98);
  });
});

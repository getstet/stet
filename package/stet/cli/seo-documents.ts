/**
 * `seo check`'s copy-shaped accessibility rules: what Lighthouse's label, name,
 * alt and lang audits test, read offline from the managed html documents and
 * from each key's places, so the commit gate catches them before a page ships.
 *
 * The document rules read every managed html document through `readDocument`,
 * the tokenizer `check` runs; the key rules read each key's places and its
 * default-locale value. Neither reads a store or the network.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { resolve } from '../src/resolve.js';
import { SEO_SEVERITY, type SeoFinding, type SeoRule } from '../src/seo.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { isHtmlHost, isLanguageTag, type StetConfig } from './config.js';
import { filesForGlobs } from './files.js';
import { attrOf as attr, isFaulted, placeOf, proposeHtml, readDocument, stripMarks, valueOf, type Document, type Element } from './html-host.js';
import { kindOf, type Place } from './key-names.js';
import { dialectOf, isJsxFile, loadTypescript, rootHtmlJsx, scanSource, scriptKindFor } from './source-scan.js';

/** The `<input>` types that carry no typed value a label could name. */
const UNLABELLED_INPUTS = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

/** Alt text that says what a screen reader already announces (canon §13.1c's alt lint). */
const REDUNDANT_PREFIXES = ['image of', 'picture of', 'photo of', 'graphic of', 'icon of'];

/** The kinds whose empty value leaves a control without a name, and what the line calls it. */
const NAMING_KINDS: Record<string, 'link' | 'button' | 'control'> = {
  'link text': 'link',
  'button text': 'button',
  'aria label': 'control',
};

/** A place's attribute as `kindOf` reads it, a Vue binding prefix dropped. */
function placeAttr(place: Place): string | undefined {
  return place.attr?.replace(/^(?::|v-bind:)/, '');
}

/** What an empty value leaves nameless: a link — `<a>`, or next/link's `<Link>`, whose kind reads `text in <Link>` — a button, or an aria-labelled control. */
function nameKindOf(place: Place): 'link' | 'button' | 'control' | null {
  const kind = kindOf(place);
  if (Object.hasOwn(NAMING_KINDS, kind)) return NAMING_KINDS[kind] as 'link' | 'button' | 'control';
  return place.tag === 'Link' && placeAttr(place) === undefined ? 'link' : null;
}

/** An `alt` on any tag: `<img>`, next/image's `<Image>` (whose kind reads `image alt`), a component's own prop. */
function altPlace(place: Place): boolean {
  return placeAttr(place) === 'alt';
}

type Emit = (rule: SeoRule, message: string, about?: { key?: string }) => void;

/** A key's place, with the image source where the place is a marked `<img>`'s `alt`. */
interface KeyPlace {
  place: Place;
  src?: string;
}

/** The document and key rules' findings, each at its effective severity. */
export async function documentRules(
  cwd: string,
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  overrides: Partial<Record<SeoRule, 'error' | 'warning'>> | undefined,
): Promise<SeoFinding[]> {
  const severity: Record<SeoRule, 'error' | 'warning'> = { ...SEO_SEVERITY, ...overrides };
  const findings: SeoFinding[] = [];
  const emit: Emit = (rule, message, about = {}) => {
    findings.push({ rule, severity: severity[rule], ...about, message });
  };
  if (isHtmlHost(config)) {
    for (const document of proposeHtml(cwd, filesForGlobs(cwd, config.managedSurfaces)).documents) documentFindings(document, emit);
  } else {
    await shellLang(cwd, config, emit);
  }
  keyFindings(descriptor, snapshot, await keyPlaces(cwd, config, descriptor), emit, isHtmlHost(config));
  return findings;
}

function filled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * The subset of an accessible name the rules read: the element's text (every
 * descendant's text with it — an `<svg>`'s `<title>` included, which is how
 * axe names an icon link), each descendant image's alt and descendant's aria-label.
 */
function nameOf(el: Element): string {
  const parts = [valueOf(el).plain];
  for (const d of el.descendants) {
    if (d.tag === 'img') parts.push(attr(d, 'alt') ?? '');
    parts.push(attr(d, 'aria-label') ?? '');
  }
  return parts.join(' ').trim();
}

/** `<file>:<line> <open tag>`, the open tag as the source spells it with stet's marks taken out. */
function where(document: Document, el: Element): string {
  return `${document.file}:${document.lineAt(el.openStart)} ${stripMarks(document.source.slice(el.openStart, el.openEnd))}`;
}

function documentFindings(document: Document, emit: Emit): void {
  const all: Element[] = document.roots.flatMap((root) => [root, ...root.descendants]);
  const labelled = new Set(all.flatMap((el) => (el.tag === 'label' && attr(el, 'for') !== undefined ? [attr(el, 'for') as string] : [])));
  const insideLabel = new Set(all.filter((el) => el.tag === 'label').flatMap((el) => el.descendants));

  for (const el of all) {
    // `<html>`'s lang is an attribute of its open tag, read exactly whatever its content holds.
    if (el.tag === 'html') {
      langFinding(document.file, attr(el, 'lang'), emit);
      continue;
    }
    // Markup the tokenizer could not pair is never judged, as `check` never adopts over it.
    if (isFaulted(document, el)) continue;
    const type = (attr(el, 'type') ?? 'text').toLowerCase();
    if ((el.tag === 'input' && !UNLABELLED_INPUTS.has(type)) || el.tag === 'textarea' || el.tag === 'select') {
      const id = attr(el, 'id');
      const named =
        (id !== undefined && labelled.has(id)) ||
        insideLabel.has(el) ||
        filled(attr(el, 'aria-label')) ||
        filled(attr(el, 'aria-labelledby')) ||
        filled(attr(el, 'placeholder')) ||
        filled(attr(el, 'title'));
      if (!named) {
        const remedy =
          id !== undefined
            ? `write a <label for="${id}">`
            : attr(el, 'name') !== undefined
              ? `give it id="${attr(el, 'name') as string}" and write a <label for="${attr(el, 'name') as string}">`
              : 'wrap it in a <label>';
        emit('missing-label', `${where(document, el)} has no label — ${remedy}, then run stet register`);
      }
    }
    const nameable =
      el.tag === 'button' ||
      (el.tag === 'a' && attr(el, 'href') !== undefined) ||
      el.tag === 'iframe' ||
      (el.tag === 'input' && (type === 'button' || type === 'image'));
    if (nameable && ![nameOf(el), attr(el, 'aria-label'), attr(el, 'aria-labelledby'), attr(el, 'value'), attr(el, 'alt'), attr(el, 'title')].some(filled)) {
      emit('missing-name', `${where(document, el)} has no accessible name — give it text, or an aria-label`);
    }
    if (el.tag === 'img' && attr(el, 'alt') === undefined) {
      const role = attr(el, 'role');
      if (role !== 'presentation' && role !== 'none' && !filled(attr(el, 'aria-label')) && !filled(attr(el, 'aria-labelledby')) && !filled(attr(el, 'title'))) {
        emit('missing-alt', `${where(document, el)} has no alt — write alt text, or alt="" for a decorative image`);
      }
    }
    if (/^h[1-6]$/.test(el.tag) && nameOf(el) === '' && !filled(attr(el, 'aria-label'))) {
      emit('empty-heading', `${where(document, el)} is empty`);
    }
  }
}

function langFinding(file: string, lang: string | undefined, emit: Emit): void {
  if (!filled(lang)) {
    emit('missing-lang', `${file}: <html> has no lang — set language in stet.config.json and run stet audit lighthouse --fix`);
    return;
  }
  if (!isLanguageTag(lang as string)) emit('missing-lang', `${file}: lang="${lang as string}" is not a language tag`);
}

/** A Vite SPA's `index.html` shell and a Next App Router root layout's `<html lang>`. */
async function shellLang(cwd: string, config: StetConfig, emit: Emit): Promise<void> {
  if (config.router === 'vite' && existsSync(join(cwd, 'index.html'))) {
    const html = readDocument('index.html', readFileSync(join(cwd, 'index.html'), 'utf8')).roots.find((el) => el.tag === 'html');
    if (html !== undefined) langFinding('index.html', attr(html, 'lang'), emit);
    return;
  }
  if (config.router !== 'app' || config.rootLayout === undefined || !existsSync(join(cwd, config.rootLayout))) return;
  let ts: typeof import('typescript');
  try {
    ts = await loadTypescript();
  } catch {
    return;
  }
  const path = join(cwd, config.rootLayout);
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, scriptKindFor(ts, path));
  // None or several is a layout stet does not read; the audit reports what the browser sees.
  const html = rootHtmlJsx(ts, sf);
  if (html === null) return;
  const lang = html.attributes.properties.find(
    (p): p is import('typescript').JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'lang',
  );
  if (lang === undefined) return langFinding(config.rootLayout, undefined, emit);
  // An expression is the host's own choice, read at runtime.
  if (lang.initializer !== undefined && ts.isStringLiteral(lang.initializer)) langFinding(config.rootLayout, lang.initializer.text, emit);
}

/** Each declared key's places: the marks on the static-HTML host, the accessor calls a JavaScript host's JSX makes. */
async function keyPlaces(cwd: string, config: StetConfig, descriptor: Descriptor): Promise<Map<string, KeyPlace[]>> {
  const out = new Map<string, KeyPlace[]>();
  const add = (key: string, found: KeyPlace): void => {
    if (Object.hasOwn(descriptor.keys, key)) out.set(key, [...(out.get(key) ?? []), found]);
  };
  if (isHtmlHost(config)) {
    for (const mark of proposeHtml(cwd, filesForGlobs(cwd, config.managedSurfaces)).claimed) {
      const src = mark.tag === 'img' && mark.attr === 'alt' ? attr(mark.element, 'src') : undefined;
      add(mark.key, { place: placeOf(mark), ...(src === undefined ? {} : { src }) });
    }
    return out;
  }
  try {
    await loadTypescript();
  } catch {
    // Without the compiler a JSX read carries no element, and no kind is known.
    return out;
  }
  for (const file of filesForGlobs(cwd, config.managedSurfaces)) {
    if (dialectOf(file) !== null || !isJsxFile(file)) continue;
    const result = await scanSource(file, readFileSync(join(cwd, file), 'utf8'), { readPathImport: config.readPath.import });
    if (result.parseErrors) continue;
    for (const call of result.accessorCalls) if (call.copyBinding === 'stet') add(call.key, { place: call.place });
  }
  return out;
}

/** A file name read as words: its stem, `-` and `_` as spaces, case-folded. */
function stemWords(src: string): string {
  return basename(src.split(/[?#]/)[0] ?? '', extname(src.split(/[?#]/)[0] ?? '')).replace(/[-_]+/g, ' ').trim().toLowerCase();
}

function keyFindings(descriptor: Descriptor, snapshot: Snapshot, places: Map<string, KeyPlace[]>, emit: Emit, html: boolean): void {
  for (const key of [...places.keys()].sort()) {
    const list = places.get(key) as KeyPlace[];
    const value = resolve(descriptor, snapshot, [], { key, locale: 'default' }).value;
    const text = typeof value === 'string' ? value.trim() : '';
    const names = list.map((p) => nameKindOf(p.place)).filter((n): n is 'link' | 'button' | 'control' => n !== null);
    if (names.length > 0 && text === '') emit('missing-name', `${key} is empty, and it names a ${names[0] as string}`, { key });
    if (!list.some((p) => altPlace(p.place))) continue;
    if (text === '') {
      // `stet remove` strips a mark but leaves a JSX read: the document already renders `alt=""`, the source must be edited first.
      const decorative = html
        ? `run stet remove ${key}; the document keeps alt=""`
        : `replace alt={copy('${key}')} with alt="" and run stet remove ${key}`;
      emit('missing-alt', `${key} is empty, and it is an image's alt text — write it, or for a decorative image ${decorative}`, { key });
      continue;
    }
    const lower = text.toLowerCase();
    const prefix = REDUNDANT_PREFIXES.find((p) => lower.startsWith(p));
    if (prefix !== undefined) {
      emit('redundant-alt', `${key}: "${text}" repeats what a screen reader already says — drop "${prefix}"`, { key });
    } else if (list.some((p) => p.src !== undefined && stemWords(p.src) === lower)) {
      emit('redundant-alt', `${key}: "${text}" is the file name`, { key });
    }
  }
}

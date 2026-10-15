/**
 * `stet audit lighthouse --fix`: the head edits that are the same on every
 * site lacking them — the doctype, the charset and viewport metas, the title
 * and description tags a page's keys fill, and `lang` from the config.
 */

import type * as TS from 'typescript';

import { isLanguageTag } from './config.js';
import { attrOf, isFaulted, type Document, type Element } from './html-host.js';
import { numberNames } from './key-names.js';
import { dominantEol, type Edit } from './rewrite.js';
import { rootHtmlJsx, scriptKindFor } from './source-scan.js';

export interface DocumentFix {
  file: string;
  /** The edits, applied together through `applyFileEdits`. */
  edits: Edit[];
  /** One line per edit, in the plan's order. */
  lines: string[];
  /** The head keys the inserted tags carry, minted empty on `--write`. */
  mints: Array<{ key: string; role: 'page_title' | 'meta_description' }>;
}

/** A doctype at the document's start, after a BOM and any comments; a legacy one counts. */
const DOCTYPE = /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\s+html\b/i;

const CHARSET = '<meta charset="utf-8">';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** A `<meta>` that declares the charset: one carrying `charset`, or the `http-equiv` form naming one. */
function declaresCharset(el: Element): boolean {
  if (el.tag !== 'meta') return false;
  if (attrOf(el, 'charset') !== undefined) return true;
  return (attrOf(el, 'http-equiv') ?? '').toLowerCase() === 'content-type' && /charset=/i.test(attrOf(el, 'content') ?? '');
}

const metaNamed = (el: Element, name: string): boolean => el.tag === 'meta' && (attrOf(el, 'name') ?? '').toLowerCase() === name;

/** The whitespace before `offset` on its line, or null where the line carries anything else before it. */
function leadingIndent(source: string, offset: number): string | null {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0);
  const before = source.slice(lineStart, offset).replace(/^﻿/, '');
  return /^[ \t]*$/.test(before) ? before : null;
}

/** The head edits one html document needs, or the reason it takes none. */
export function planDocumentFix(
  document: Document,
  context: { language?: string; page: string | null; keys: ReadonlySet<string> },
): DocumentFix | { skip: string } {
  const { file, source } = document;
  const htmls = document.roots.filter((el) => el.tag === 'html');
  if (htmls.length !== 1) return { skip: `${file}: no single <html> element — no head edits` };
  const html = htmls[0] as Element;
  // Head-scoped: a fault in `<body>` cannot move the head's offsets, so it blocks nothing here.
  const heads = html.children.filter((el) => el.tag === 'head');
  if (heads.length !== 1 || isFaulted(document, heads[0] as Element)) return { skip: `${file}: no single readable <head> — no head edits` };
  const head = heads[0] as Element;
  const nl = dominantEol(source);
  const edits: Edit[] = [];
  const lines: string[] = [];
  const mints: DocumentFix['mints'] = [];

  if (!DOCTYPE.test(source)) {
    const at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    edits.push({ pos: at, end: at, text: `<!DOCTYPE html>${nl}` });
    lines.push('<!DOCTYPE html> as the first line');
  }

  // The head inserts are ONE edit: `applyFileEdits` applies equal-position
  // inserts in reverse of their order, which would land the viewport above the
  // charset. Nothing lands above a charset meta the head already carries — it
  // must stay within the document's first 1,024 bytes.
  const charsetMeta = head.children.find(declaresCharset);
  const first = head.children[0];
  const indent =
    (first === undefined ? null : leadingIndent(source, first.openStart)) ?? `${leadingIndent(source, head.openStart) ?? ''}  `;
  const inserts: string[] = [];
  if (charsetMeta === undefined) {
    inserts.push(CHARSET);
    lines.push(`${CHARSET} as the first element of <head>`);
  }
  if (!head.children.some((el) => metaNamed(el, 'viewport'))) {
    inserts.push(VIEWPORT);
    lines.push(`${VIEWPORT} ${charsetMeta === undefined ? 'after it' : 'after the <meta charset>'}`);
  }
  const tags: string[] = [];
  if (context.page !== null && !head.children.some((el) => el.tag === 'title')) {
    const key = numberNames([`${context.page}_page_title`], (n) => context.keys.has(n))[0] as string;
    tags.push(`<title data-stet="${key}"></title>`);
    mints.push({ key, role: 'page_title' });
  }
  if (context.page !== null && !head.children.some((el) => metaNamed(el, 'description'))) {
    const key = numberNames([`${context.page}_meta_description`], (n) => context.keys.has(n))[0] as string;
    tags.push(`<meta name="description" content="" data-stet-content="${key}">`);
    mints.push({ key, role: 'meta_description' });
  }
  if (tags.length === 2) {
    lines.push(`${tags.join(' and ')} — ${context.page as string} is declared as a page and its two keys are empty until you write them`);
  } else if (tags.length === 1) {
    lines.push(`${tags[0] as string} — ${context.page as string} is declared as a page and the key is empty until you write it`);
  }
  inserts.push(...tags);
  if (inserts.length > 0) {
    const at = charsetMeta?.openEnd ?? head.openEnd;
    edits.push({ pos: at, end: at, text: inserts.map((tag) => `${nl}${indent}${tag}`).join('') });
  }

  const lang = html.attrs.find((a) => a.name === 'lang');
  if (lang === undefined || !isLanguageTag(lang.value)) {
    if (context.language === undefined) {
      lines.push('set language in stet.config.json (a BCP 47 tag such as en-GB), then run stet audit lighthouse --fix');
    } else {
      if (lang === undefined) {
        // Before `>`, or before `/` where the open tag ends `/>`.
        const at = source.slice(html.openStart, html.openEnd).endsWith('/>') ? html.openEnd - 2 : html.openEnd - 1;
        edits.push({ pos: at, end: at, text: ` lang="${context.language}"` });
      } else if (lang.valueStart === lang.valueEnd && !lang.quoted) {
        // A bare `lang` carries no value span to replace: the attribute is written whole.
        edits.push({ pos: lang.start, end: lang.end, text: `lang="${context.language}"` });
      } else {
        edits.push({ pos: lang.valueStart, end: lang.valueEnd, text: context.language });
      }
      lines.push(`lang="${context.language}" on <html> (from language in stet.config.json)`);
    }
  }
  return { file, edits, lines, mints };
}

/** The Vite shell's copy, which nothing on that host reads a mark from yet. */
export const VITE_SHELL_LINE =
  'add <title> and <meta name="description" content="…"> to index.html — stet does not manage the shell\'s copy yet';

/**
 * A Vite SPA's `index.html`: the doctype, charset, viewport and `lang` edits
 * with no page, and the title and description reported, since an inserted
 * empty tag there would stay empty.
 */
export function planViteShell(document: Document, language: string | undefined): DocumentFix | { skip: string } {
  const fix = planDocumentFix(document, { ...(language === undefined ? {} : { language }), page: null, keys: new Set() });
  if ('skip' in fix) return fix;
  const head = document.roots.find((el) => el.tag === 'html')?.children.find((el) => el.tag === 'head');
  const lacks = head === undefined || !head.children.some((el) => el.tag === 'title') || !head.children.some((el) => metaNamed(el, 'description'));
  return lacks ? { ...fix, lines: [...fix.lines, VITE_SHELL_LINE] } : fix;
}

/**
 * A Next root layout's `lang`: inserted at the one `<html>` JSX element's tag
 * name, or an invalid string literal's text replaced; none or several
 * elements, or an expression-valued `lang`, are left with the attribute to
 * write by hand.
 */
export function planNextLang(
  ts: typeof import('typescript'),
  layout: string,
  source: string,
  language: string | undefined,
): DocumentFix | { skip: string } {
  const sf = ts.createSourceFile(layout, source, ts.ScriptTarget.Latest, true, scriptKindFor(ts, layout));
  const html = rootHtmlJsx(ts, sf);
  const byHand = language === undefined ? '' : `\n  <html lang="${language}">`;
  if (html === null) return { skip: `${layout}: no single <html> element — set lang by hand${byHand}` };
  const lang = html.attributes.properties.find((p): p is TS.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'lang');
  if (lang !== undefined && (lang.initializer === undefined || !ts.isStringLiteral(lang.initializer))) {
    return { skip: `${layout}: lang is set by an expression — set it by hand${byHand}` };
  }
  if (lang?.initializer !== undefined && ts.isStringLiteral(lang.initializer) && isLanguageTag(lang.initializer.text)) {
    return { file: layout, edits: [], lines: [], mints: [] };
  }
  if (language === undefined) {
    return { file: layout, edits: [], lines: ['set language in stet.config.json (a BCP 47 tag such as en-GB), then run stet audit lighthouse --fix'], mints: [] };
  }
  const literal = lang?.initializer;
  const edit: Edit =
    literal === undefined
      ? { pos: html.tagName.getEnd(), end: html.tagName.getEnd(), text: ` lang="${language}"` }
      : { pos: literal.getStart(sf) + 1, end: literal.getEnd() - 1, text: language };
  return { file: layout, edits: [edit], lines: [`lang="${language}" on <html> (from language in stet.config.json)`], mints: [] };
}

/**
 * An Astro page's fixes, reported and never written: the template is not
 * parsed, so each failing fix audit names its tag or attribute.
 */
export function astroFixLines(failing: ReadonlySet<string>, language: string | undefined): string[] {
  const lines: string[] = [];
  if (failing.has('doctype')) lines.push('<!DOCTYPE html> as the first line');
  if (failing.has('charset')) lines.push(`${CHARSET} as the first element of <head>`);
  if (failing.has('html-has-lang') || failing.has('html-lang-valid')) {
    lines.push(
      language === undefined
        ? 'set language in stet.config.json (a BCP 47 tag such as en-GB), then run stet audit lighthouse --fix'
        : `lang="${language}" on <html> (from language in stet.config.json)`,
    );
  }
  return lines;
}

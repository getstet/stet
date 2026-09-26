/**
 * The static-HTML host: a site with no framework and no build, whose `.html`
 * documents ARE the rendered form of the committed snapshot.
 *
 * This module is a PLANNER. It reads and computes; it writes nothing. Each
 * command wraps what it returns in the all-or-nothing batch that command
 * already uses, so a document is never left half-true.
 *
 * It reads a document with a TOKENIZER over `blankNonMarkup`'s output, not with
 * a parser: tags, a fixed void list, quoted attributes, `title`/`textarea` read
 * whole as RCDATA and `template`/`noscript`/`xmp`/`plaintext` read whole as
 * opaque. Markup it cannot pair is a REPORTED skip, never a guess — the same
 * fail-safe posture the leaf rewrite takes toward a stranger's source.
 *
 * It is a leaf by construction: it imports the detector, the reporter, the edit
 * engine, the placeholder grammar and the target adapter, and nothing from
 * `artifacts`, `check`, `scan`, `pages` or `config`. Those modules import THIS
 * one; the edge runs one way.
 *
 * The skip taxonomy below is EXHAUSTIVE by construction, the discipline
 * `cli/pages.ts` states for its own: a fault outside these reasons means the
 * reader guessed, which is the one thing it may not do. Every reason is
 * produced by a fixture.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { keyDefOf } from '../src/descriptor.js';
import { derivedText, resolve } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import { targetAdapter } from '../src/targets/adapter.js';
import { DEFAULT_TARGET, type Descriptor, type KeyDef } from '../src/types.js';
import { plainOf } from '../src/validate.js';
import { CliError, Report } from './report.js';
import {
  baseName,
  isHeadKind,
  metaCopyNameOf,
  META_NAME_COPY,
  META_PROPERTY_COPY,
  numberNames,
  roleOf,
  sectionWord,
  SITE_PAGE,
  type Place,
  type SectionNode,
} from './key-names.js';
import { applyFileEdits, formatDiff, type Edit } from './rewrite.js';
import { validateUnnamed } from './validate.js';
import {
  blankNonMarkup,
  decodeEntities,
  type Dialect,
  qualifiesAsCopy,
  undecodedEntity,
} from './source-scan.js';

// --- The grammar ------------------------------------------------------------

/**
 * An open or close tag: the slash, the name, the attribute run, and the
 * self-closing slash. Run over the BLANKED text, so a comment, a script body
 * and a style block are NUL and can never match.
 *
 * Two shapes deliberately do NOT match, and both are stated limits rather than
 * guesses: attributes with no whitespace between them (`href="x"title="y"`) and
 * an empty unquoted value (`class=`). Such an open tag reads as text and its
 * close tag becomes an unpaired skip — reported, never repaired.
 */
const TAG_TOKEN =
  /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

/** One attribute inside a tag's attribute run. Match indices give the value's own offsets. */
const ATTR = /([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gd;

/** Elements that never have content, so they close themselves. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Read whole to the matching close tag as ONE text segment — their content is text, not markup. */
const RCDATA = new Set(['title', 'textarea']);

/**
 * Read whole to the matching close tag and never entered: nothing inside is copy
 * stet manages. `pre` is here because its whitespace IS its content — the copy
 * collapse would fold a three-line block onto one line and the page could never
 * get those newlines back.
 */
const OPAQUE = new Set(['template', 'noscript', 'xmp', 'plaintext', 'pre']);

/**
 * Elements that hold structure rather than a sentence. Their text segments are
 * whitespace by construction, so a bare run directly inside one has no element
 * to mark and is reported rather than adopted.
 */
const STRUCTURAL = new Set([
  'html',
  'head',
  'body',
  'select',
  'datalist',
  'optgroup',
  'ul',
  'ol',
  'dl',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
]);

/** Elements whose `id` names the section a finding sits in. */
const SECTIONING = new Set(['section', 'main', 'header', 'footer', 'nav', 'article', 'aside']);

/** The copy attributes, on any element: what a reader sees but the tag strip hides. */
const ATTR_COPY = ['alt', 'aria-label', 'title', 'placeholder'] as const;

/** `<meta name=…>` values whose `content` is copy. */


/** The attributes a `data-stet-<attr>` mark may name. */
const MARKABLE_ATTRS = new Set<string>([...ATTR_COPY, 'content']);

/** A mark, as it appears in source: `data-stet` or `data-stet-<attr>`. */
const MARK_ATTR = /^data-stet(?:-([a-z-]+))?$/;

/** Every mark occurrence in raw source — the sweep that finds one inside a blanked or opaque span. */
const MARK_IN_SOURCE = /\bdata-stet(-[a-z-]+)?\s*=/g;

/** Every mark attribute with its value, for the strip `eject` and a removed key need. */
const MARK_WITH_VALUE = /\s*data-stet(?:-[a-z-]+)?="[^"]*"/g;

// --- What the reader yields -------------------------------------------------

export interface HtmlAttr {
  /** Lower-cased. */
  name: string;
  /** The raw slice between the quotes, or the bare run of an unquoted value. */
  value: string;
  quoted: boolean;
  /** Absolute offsets INSIDE the quotes, so a replacement never touches them. */
  valueStart: number;
  valueEnd: number;
  /** The attribute's whole span, its name included. */
  start: number;
  end: number;
}

export interface TextSegment {
  text: string;
  start: number;
  end: number;
}

export interface Element {
  tag: string;
  openStart: number;
  /** Just past the open tag's `>`. */
  openEnd: number;
  contentStart: number;
  contentEnd: number;
  closeStart: number;
  closeEnd: number;
  attrs: HtmlAttr[];
  children: Element[];
  /** Content in document order — text runs and child elements interleaved. */
  segments: Array<TextSegment | Element>;
  /** The id of the innermost sectioning ancestor carrying one. */
  section?: string;
  /** Read whole and never entered, so its span is reproduced verbatim. */
  opaque: boolean;
  /** Every descendant, depth-first in document order — the placeholder numbering. */
  descendants: Element[];
}

export interface Document {
  /** Repo-relative, `/`-joined. */
  file: string;
  source: string;
  /** The same text with comments, scripts, styles and fences NUL-blanked; every offset intact. */
  blanked: string;
  roots: Element[];
  /** Spans read whole and never entered. */
  opaque: Array<{ tag: string; start: number; end: number }>;
  /** Markup the tokenizer could not pair, each named once. */
  faults: Fault[];
  /**
   * The 1-based line an offset falls on, by binary search over a newline index
   * built once per document. `lineCol` scans from offset 0 every time, which is
   * linear per lookup and quadratic over a page with thousands of marks — and
   * `check` runs in the pre-commit hook. `report.ts`'s `lineCol` stays for
   * scan's single lookups.
   */
  lineAt: (offset: number) => number;
}

export interface Fault {
  tag: string;
  /** The open tag's offset for an element that never closed; the close tag's own for a stray close. */
  offset: number;
  kind: 'never-closed' | 'closes-nothing';
  /** Where the fault's element span ends — the region an enclosing element must not be adopted over. */
  until: number;
}

export type HtmlSkipReason =
  | 'unpaired-markup'
  | 'text-in-structure'
  | 'text-beside-code'
  | 'mark-on-non-key-element'
  | 'mark-in-refused-context'
  | 'unknown-entity'
  | 'tag-count-mismatch';

export interface HtmlSkip {
  file: string;
  line: number;
  reason: HtmlSkipReason;
  /**
   * `mark` where the fault involves a mark — the three mark reasons and the
   * count mismatch always, and unpaired markup or an unknown entity when it
   * sits inside a marked element. `check` and the regenerator read those alone;
   * an `adoption` skip is scan's to name and never stops a write, because
   * markup stet does not manage is not stet's red.
   */
  scope: 'adoption' | 'mark';
  detail: string;
  remedy: string;
}

export interface HtmlProposal {
  file: string;
  line: number;
  tag: string;
  section?: string;
  kind: 'element' | 'attribute';
  /** The attribute a `kind: 'attribute'` proposal names. */
  attr?: string;
  /** The `name`/`property` of a `<meta>` whose `content` is proposed. */
  metaName?: string;
  /** Inside an `<svg>`, where a `<title>` names the graphic rather than the page. */
  inSvg?: true;
  /** Decoded, whitespace-collapsed, with placeholder tags where the element has descendants. */
  value: string;
  /** The value with its placeholders removed — what the key is named from. */
  plain: string;
  tags: number;
  /**
   * The section word of the element (`sectionWordOf`), `null` where no section
   * answers — which the role name spells `page`.
   */
  sectionWord: string | null;
  /** The role part of the element's name: its kind word underscored, else its tag or attribute. */
  role: string;
  /** The offset of the open tag's `>` (or its `/>`), where a mark is inserted. */
  insertAt: number;
}

export interface HtmlMark {
  file: string;
  line: number;
  tag: string;
  kind: 'element' | 'attribute';
  attr?: string;
  /** The `name`/`property` of a `<meta>` whose `content` the mark binds. */
  metaName?: string;
  /** Inside an `<svg>`, where a `<title>` names the graphic rather than the page. */
  inSvg?: true;
  key: string;
  /** What the document says NOW, read the way a proposal's value is; null where a skip says why not. */
  value: string | null;
  tags: number;
  element: Element;
  document: Document;
}

export interface HtmlProposalSet {
  proposals: HtmlProposal[];
  claimed: HtmlMark[];
  skips: HtmlSkip[];
  documents: Document[];
}

// --- The reader -------------------------------------------------------------

/**
 * The 1-based line of an offset in `source`, over one index of its newlines
 * built once — every lookup a binary search, however many a caller makes.
 */
export function lineIndex(source: string): (offset: number) => number {
  const newlines: number[] = [];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) newlines.push(i);
  return (offset: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((newlines[mid] as number) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/**
 * One document's element tree, over `blankNonMarkup`'s output.
 *
 * The stack rule is fail-safe: a close tag pops to the nearest open element of
 * its name, and every element it pops PAST is a fault at its own open offset.
 * The tokenizer never absorbs a stray element, and an element still open when
 * the text ends is a fault too.
 */
export function readDocument(file: string, source: string, dialect: Dialect = 'html'): Document {
  const blanked = blankNonMarkup(source, dialect);
  const lineAt = lineIndex(source);
  const roots: Element[] = [];
  const stack: Element[] = [];
  const opaque: Document['opaque'] = [];
  const faults: Fault[] = [];

  const top = (): Element | undefined => stack[stack.length - 1];

  const pushText = (start: number, end: number): void => {
    if (end <= start) return;
    const parent = top();
    // Text with no element around it — a doctype, a stray run before <html> —
    // has nothing to mark and nothing to regenerate, so it is not read.
    if (parent === undefined) return;
    parent.segments.push({ text: blanked.slice(start, end), start, end });
  };

  const attach = (el: Element): void => {
    const parent = top();
    if (parent === undefined) {
      roots.push(el);
      return;
    }
    parent.children.push(el);
    parent.segments.push(el);
  };

  const sectionOf = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const el = stack[i] as Element;
      if (!SECTIONING.has(el.tag)) continue;
      const id = el.attrs.find((a) => a.name === 'id');
      if (id !== undefined) return id.value;
    }
    return undefined;
  };

  /** The matching close tag's span, searched case-insensitively from `from`. */
  const closeTagAt = (name: string, from: number): { start: number; end: number } | null => {
    const pattern = new RegExp(`</${name}\\s*>`, 'gi');
    pattern.lastIndex = from;
    const found = pattern.exec(blanked);
    return found === null ? null : { start: found.index, end: found.index + found[0].length };
  };

  TAG_TOKEN.lastIndex = 0;
  let textFrom = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_TOKEN.exec(blanked)) !== null) {
    const whole = match[0];
    const isClose = match[1] === '/';
    const name = (match[2] as string).toLowerCase();
    const attrRun = match[3] ?? '';
    const selfClosing = match[4] === '/';
    const openStart = match.index;
    const openEnd = openStart + whole.length;

    pushText(textFrom, openStart);
    textFrom = openEnd;

    if (isClose) {
      const at = lastIndexOfTag(stack, name);
      if (at < 0) {
        // A close that opened nothing. Its own offset is the fault, and the
        // elements enclosing it are the ones that must not be adopted over.
        faults.push({ tag: name, offset: openStart, kind: 'closes-nothing', until: openEnd });
        continue;
      }
      // Everything above the match was never closed — popped past, not absorbed.
      for (let i = stack.length - 1; i > at; i--) {
        const orphan = stack[i] as Element;
        orphan.contentEnd = openStart;
        orphan.closeStart = openStart;
        orphan.closeEnd = openStart;
        faults.push({
          tag: orphan.tag,
          offset: orphan.openStart,
          kind: 'never-closed',
          until: openEnd,
        });
      }
      const closed = stack[at] as Element;
      closed.contentEnd = openStart;
      closed.closeStart = openStart;
      closed.closeEnd = openEnd;
      stack.length = at;
      continue;
    }

    const attrs = readAttrs(blanked, openStart + 1 + (match[1] ?? '').length + name.length, attrRun);
    const el: Element = {
      tag: name,
      openStart,
      openEnd,
      contentStart: openEnd,
      contentEnd: openEnd,
      closeStart: openEnd,
      closeEnd: openEnd,
      attrs,
      children: [],
      segments: [],
      opaque: false,
      descendants: [],
    };
    const section = sectionOf();
    if (section !== undefined) el.section = section;
    attach(el);

    if (VOID.has(name) || selfClosing) continue;

    if (RCDATA.has(name)) {
      const close = closeTagAt(name, openEnd);
      if (close === null) {
        el.contentEnd = el.closeStart = el.closeEnd = blanked.length;
        faults.push({ tag: name, offset: openStart, kind: 'never-closed', until: blanked.length });
        textFrom = blanked.length;
        TAG_TOKEN.lastIndex = blanked.length;
        continue;
      }
      // RCDATA content is text by definition: a `<` inside a `<title>` is a
      // character, not a tag, so the span is taken whole rather than tokenized.
      el.contentEnd = close.start;
      el.closeStart = close.start;
      el.closeEnd = close.end;
      if (close.start > openEnd) {
        el.segments.push({ text: blanked.slice(openEnd, close.start), start: openEnd, end: close.start });
      }
      textFrom = close.end;
      TAG_TOKEN.lastIndex = close.end;
      continue;
    }

    if (OPAQUE.has(name)) {
      const close = closeTagAt(name, openEnd);
      const end = close === null ? blanked.length : close.end;
      const contentEnd = close === null ? blanked.length : close.start;
      el.opaque = true;
      el.contentEnd = contentEnd;
      el.closeStart = contentEnd;
      el.closeEnd = end;
      opaque.push({ tag: name, start: openEnd, end: contentEnd });
      if (close === null) {
        faults.push({ tag: name, offset: openStart, kind: 'never-closed', until: blanked.length });
      }
      textFrom = end;
      TAG_TOKEN.lastIndex = end;
      continue;
    }

    stack.push(el);
  }

  // Whatever is still open when the text ends never closed.
  for (const orphan of stack) {
    orphan.contentEnd = blanked.length;
    orphan.closeStart = blanked.length;
    orphan.closeEnd = blanked.length;
    faults.push({
      tag: orphan.tag,
      offset: orphan.openStart,
      kind: 'never-closed',
      until: blanked.length,
    });
  }

  for (const root of roots) fillDescendants(root);
  return { file, source, blanked, roots, opaque, faults, lineAt };
}

/** The topmost open element of this name, or -1 — the pop target. */
function lastIndexOfTag(stack: Element[], name: string): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if ((stack[i] as Element).tag === name) return i;
  }
  return -1;
}

/**
 * Depth-first, document order — the numbering a placeholder tag stands for.
 *
 * Iterative, and deliberately so: `flat.push(...fillDescendants(child))` passes
 * one argument per descendant, which blows the engine's argument limit near
 * 40,000 elements under a single parent. A page can carry that many, so the
 * array's own length is the only bound here. Each element is visited once, its
 * own list built after its children's, so the whole tree is linear in nodes.
 */
function fillDescendants(root: Element): void {
  // Post-order: a parent's list is assembled only once every child has its own.
  const order: Element[] = [];
  const pending: Element[] = [root];
  while (pending.length > 0) {
    const el = pending.pop() as Element;
    order.push(el);
    for (const child of el.children) pending.push(child);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const el = order[i] as Element;
    const flat: Element[] = [];
    for (const child of el.children) {
      flat.push(child);
      for (const deep of child.descendants) flat.push(deep);
    }
    el.descendants = flat;
  }
}

/** One tag's attributes, with absolute offsets for the value inside its quotes. */
function readAttrs(source: string, base: number, run: string): HtmlAttr[] {
  const attrs: HtmlAttr[] = [];
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(run)) !== null) {
    const name = (match[1] as string).toLowerCase();
    const raw = match[2];
    const start = base + match.index;
    if (raw === undefined) {
      attrs.push({
        name,
        value: '',
        quoted: false,
        valueStart: start + (match[1] as string).length,
        valueEnd: start + (match[1] as string).length,
        start,
        end: start + match[0].length,
      });
      continue;
    }
    const span = match.indices?.[2];
    const rawStart = span === undefined ? start + match[0].indexOf(raw) : base + span[0];
    const rawEnd = span === undefined ? rawStart + raw.length : base + span[1];
    const quote = raw.charAt(0);
    const quoted = quote === '"' || quote === "'";
    attrs.push({
      name,
      value: quoted ? raw.slice(1, -1) : raw,
      quoted,
      valueStart: quoted ? rawStart + 1 : rawStart,
      valueEnd: quoted ? rawEnd - 1 : rawEnd,
      start,
      end: start + match[0].length,
    });
  }
  return attrs;
}

// --- The value --------------------------------------------------------------

/** A flattened key element: text runs and the open/close/self tokens of its descendants. */
type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'open'; n: number }
  | { kind: 'close'; n: number }
  | { kind: 'self'; n: number };

/**
 * Whether a descendant is reproduced by its WHOLE source span rather than by
 * rebuilding its content: a void element, one read opaquely, and one whose
 * content is empty. Never an open tag alone — that would leave the document
 * unbalanced.
 */
function isWholeSpan(el: Element): boolean {
  if (VOID.has(el.tag) || el.opaque) return true;
  if (el.children.length > 0) return false;
  return textOf(el.segments.map((s) => ('tag' in s ? '' : s.text)).join('')) === '';
}

/**
 * Runs of ASCII whitespace → one space, edges dropped. The locator's own
 * collapse, deliberately NOT `collapseWhitespace`: its `\s` folds U+00A0 and
 * U+2009 into an ASCII space, and a page that writes a non-breaking space as
 * the CHARACTER rather than the entity would lose it on the first regeneration,
 * with the snapshot no longer recording that one was ever meant. Only the
 * indentation the rule is actually about collapses here.
 */
function collapseAscii(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');
}

/**
 * The value as the reader will read it back — the fixed point every write aims
 * at. A padded or double-spaced snapshot value lands as the page renders it, so
 * the second `pull` is current instead of re-appending the padding forever.
 */
function readBack(value: string): string {
  // The SAME whitespace class the collapse uses: `.trim()` strips U+00A0 and
  // U+2009 at the edges, which would lose at the boundary exactly what
  // `collapseAscii` is careful to keep in the middle.
  return collapseAscii(value).replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, '');
}

/** A raw slice as text: blanked spans removed, runs collapsed, entities decoded. */
function textOf(raw: string): string {
  return decodeEntities(collapseAscii(raw.replace(/\0/g, '')));
}

/**
 * An element's text exactly as the source spells it: every text token's raw
 * slice with NULs dropped, nothing collapsed and nothing decoded. The entity
 * test runs over THIS rather than the decoded value, so prose whose source
 * reads `&amp;nosuch;` is the literal text `&nosuch;` — proposed, and
 * regenerated back to `&amp;nosuch;` byte-identically — while a source
 * `&nosuch;` is still an entity the table cannot decode.
 */
function rawTextOf(el: Element): string {
  let out = '';
  for (const token of tokensOf(el)) if (token.kind === 'text') out += token.raw.replace(/\0/g, '');
  return out;
}

/** The element flattened into its token stream, descendants numbered `1..n`. */
function tokensOf(el: Element): Token[] {
  const number = new Map<Element, number>();
  el.descendants.forEach((d, i) => number.set(d, i + 1));
  const out: Token[] = [];
  const walkInto = (node: Element): void => {
    for (const segment of node.segments) {
      if (!('tag' in segment)) {
        out.push({ kind: 'text', raw: segment.text });
        continue;
      }
      const n = number.get(segment) as number;
      if (isWholeSpan(segment)) {
        out.push({ kind: 'self', n });
        continue;
      }
      out.push({ kind: 'open', n });
      walkInto(segment);
      out.push({ kind: 'close', n });
    }
  };
  walkInto(el);
  return out;
}

/**
 * The element's value: its text with numbered placeholder tags standing for its
 * descendants. A whitespace run at a tag boundary keeps ONE space, so a
 * sentence broken across lines reads as a sentence; whitespace at the very
 * start or end of the content contributes nothing, so the indentation the
 * document keeps is never part of the value.
 */
export function valueOf(el: Element): { value: string; plain: string; tags: number } {
  const tokens = tokensOf(el);
  const parts: string[] = [];
  tokens.forEach((token, i) => {
    if (token.kind !== 'text') {
      parts.push(token.kind === 'open' ? `<${token.n}>` : token.kind === 'close' ? `</${token.n}>` : `<${token.n}/>`);
      return;
    }
    const stripped = token.raw.replace(/\0/g, '');
    const core = textOf(token.raw);
    const before = i > 0;
    const after = i < tokens.length - 1;
    if (core === '') {
      if (before && after && /[ \t\r\n\f]/.test(stripped)) parts.push(' ');
      return;
    }
    const lead = before && /^[ \t\r\n\f]/.test(stripped) ? ' ' : '';
    const trail = after && /[ \t\r\n\f]$/.test(stripped) ? ' ' : '';
    parts.push(`${lead}${core}${trail}`);
  });
  const value = parts.join('');
  return { value, plain: plainOf(value), tags: el.descendants.length };
}

/** An attribute's value as the key would carry it. */
function attrValueOf(attr: HtmlAttr): string {
  return textOf(attr.value);
}

// --- The skip taxonomy ------------------------------------------------------

/** Each reason's pinned detail and remedy, so one message shape serves every caller. */
function skipOf(
  document: Document,
  offset: number,
  reason: HtmlSkipReason,
  scope: 'adoption' | 'mark',
  detail: string,
  remedy: string,
): HtmlSkip {
  return {
    file: document.file,
    line: document.lineAt(offset),
    reason,
    scope,
    detail,
    remedy,
  };
}

function unpairedSkip(document: Document, fault: Fault, scope: 'adoption' | 'mark'): HtmlSkip {
  const line = document.lineAt(fault.offset);
  return fault.kind === 'never-closed'
    ? skipOf(
        document,
        fault.offset,
        'unpaired-markup',
        scope,
        `<${fault.tag}> at line ${line} is never closed`,
        'close it, then run stet scan again',
      )
    : skipOf(
        document,
        fault.offset,
        'unpaired-markup',
        scope,
        `</${fault.tag}> at line ${line} closes nothing`,
        'remove it, or open the element it closes',
      );
}

// --- The key-element rule ---------------------------------------------------

/** Whether any text segment of this element's own passes the qualifying bar. */
function hasBareRun(el: Element): boolean {
  for (const segment of el.segments) {
    if ('tag' in segment) continue;
    const text = collapseAscii(segment.text.replace(/\0/g, ''));
    if (text !== '' && qualifiesAsCopy(text)) return true;
  }
  return false;
}

/**
 * Whether the element's content holds a span the detector blanked — a comment,
 * a script or style body, a code fence.
 *
 * Such an element is never a key element: its value could not carry what the
 * blanked span holds, so regenerating the content from that value would delete
 * markup stet was never asked to manage. Skipping is the fail-safe half of the
 * same rule that refuses to guess at markup it cannot pair.
 */
function holdsBlankedSpan(document: Document, el: Element): boolean {
  return document.blanked.slice(el.contentStart, el.contentEnd).includes('\0');
}

/** Whether the element sits over markup the tokenizer could not pair. */
function isFaulted(document: Document, el: Element): boolean {
  return document.faults.some((f) => el.openStart <= f.offset && f.offset < el.closeEnd);
}

interface Located {
  keyElements: Element[];
  /** Elements carrying a `data-stet` that is not on a key element. */
  strayMarks: Element[];
  structuralRuns: Element[];
  blankedRuns: Element[];
  /** Marked elements the tokenizer could not pair — `unpaired-markup` at mark scope. */
  faultedMarks: Element[];
  /** Elements carrying two `data-stet` attributes. */
  duplicateMarks: Element[];
  /** Element marks on a void or self-closed element — nowhere to hold text. */
  emptyMarks: Element[];
  /** Element marks on a `<pre>`, whose whitespace stet does not manage. */
  preMarks: Element[];
}

/**
 * The key elements: the OUTERMOST elements whose content includes a bare text
 * run, decided top-down so a sentence stays whole and a pure container's
 * children are read on their own.
 */
function locate(document: Document): Located {
  const keyElements: Element[] = [];
  const strayMarks: Element[] = [];
  const structuralRuns: Element[] = [];
  const blankedRuns: Element[] = [];
  const faultedMarks: Element[] = [];
  const duplicateMarks: Element[] = [];
  const emptyMarks: Element[] = [];
  const preMarks: Element[] = [];
  const isKey = new Set<Element>();

  const visit = (el: Element): void => {
    const bare = hasBareRun(el);
    // A MARK is the developer's own declaration that this element is a key
    // element, and it outranks the qualifying bar entirely. The bar reads the
    // element's CURRENT text, so re-applying it here made an ordinary edit to a
    // value — a heading changed to a price, a number, an arrow, or emptied —
    // un-declare the mark that names it, and every write command then refused
    // the document with a message blaming the wrong thing. The bar belongs to
    // the proposal path alone; from here on a mark is honoured whatever the
    // element currently says.
    const marked = el.attrs.filter((a) => a.name === 'data-stet').length;
    if (isFaulted(document, el)) {
      // The fault is already reported; the rest of the document reads normally.
      // A MARKED element here is named by `unpaired-markup` at mark scope (the
      // accurate reason) and never also by `mark-on-non-key-element`, whose
      // remedy would be wrong.
      if (marked > 0) faultedMarks.push(el);
      for (const child of el.children) visit(child);
      return;
    }
    if (STRUCTURAL.has(el.tag)) {
      if (bare) structuralRuns.push(el);
      for (const child of el.children) visit(child);
      return;
    }
    if (marked > 0 && el.opaque) {
      // A `<pre>` gets its own reason: its whitespace IS its content, and the
      // copy collapse would fold a three-line block onto one line with no way
      // back. Every other opaque container falls to the stray sweep, whose
      // "holds no text of its own" is already accurate for it.
      if (el.tag === 'pre') preMarks.push(el);
      return;
    }
    if (marked > 0 && (VOID.has(el.tag) || el.closeEnd === el.openEnd)) {
      // 9.1 admits a marked element whatever its TEXT, which also admits one
      // with nowhere to put text at all. Its content span is zero-width, so the
      // regenerator would splice the value outside the element and append
      // another copy on every pull. The attribute form is the one that works.
      emptyMarks.push(el);
      return;
    }
    if (marked > 1) {
      // Two marks on one element: the reader would honour the first and drop the
      // second in silence, so neither is honoured and the pair is reported.
      duplicateMarks.push(el);
      return;
    }
    if ((bare || marked > 0) && holdsBlankedSpan(document, el)) {
      blankedRuns.push(el);
      for (const child of el.children) visit(child);
      return;
    }
    if (bare || marked > 0) {
      keyElements.push(el);
      isKey.add(el);
      return;
    }
    for (const child of el.children) visit(child);
  };
  for (const root of document.roots) visit(root);

  // Every `data-stet` in the tree that did not land on a key element. A mark
  // inside unpaired markup or doubled on one element has its own, accurate
  // reason and is not swept up here as well.
  const named = new Set<Element>([...faultedMarks, ...duplicateMarks, ...emptyMarks, ...preMarks]);
  const sweep = (el: Element): void => {
    if (el.attrs.some((a) => a.name === 'data-stet') && !isKey.has(el) && !named.has(el)) {
      strayMarks.push(el);
    }
    for (const child of el.children) sweep(child);
  };
  for (const root of document.roots) sweep(root);

  return {
    keyElements,
    strayMarks,
    structuralRuns,
    blankedRuns,
    faultedMarks,
    duplicateMarks,
    emptyMarks,
    preMarks,
  };
}

// --- Attribute candidates ---------------------------------------------------

/** The `name`/`property` a `<meta>`'s `content` is copy under, or null. */
export function metaCopyName(el: Element): string | null {
  return metaCopyNameOf(el.tag, (name) => el.attrs.find((a) => a.name === name)?.value);
}

/** Whether `<attr>` on this element is one stet manages — the refused set is everything else. */
function attrIsCopy(el: Element, attr: string): boolean {
  if (attr === 'content') return metaCopyName(el) !== null;
  return (ATTR_COPY as readonly string[]).includes(attr);
}

interface AttrCandidate {
  el: Element;
  attr: HtmlAttr;
  metaName: string | null;
}

/** Every quoted, qualifying copy attribute in the document. */
function attrCandidates(document: Document): AttrCandidate[] {
  const found: AttrCandidate[] = [];
  const visit = (el: Element): void => {
    if (!isFaulted(document, el)) {
      for (const attr of el.attrs) {
        if (!attrIsCopy(el, attr.name) || !attr.quoted) continue;
        const text = attrValueOf(attr);
        if (text === '' || !qualifiesAsCopy(text)) continue;
        found.push({ el, attr, metaName: attr.name === 'content' ? metaCopyName(el) : null });
      }
    }
    for (const child of el.children) visit(child);
  };
  for (const root of document.roots) visit(root);
  return found;
}

// --- The proposal set -------------------------------------------------------

/**
 * Every document's proposals, claimed marks and skips.
 *
 * The caller lists the files (each does so with `filesForGlobs` over its own
 * managed surfaces), and this reads each once. It takes no descriptor and no
 * snapshot: a document's marks are the only read the walk makes, so the forms
 * the caller holds have nothing to contribute.
 */
export function proposeHtml(cwd: string, files: string[]): HtmlProposalSet {
  const proposals: HtmlProposal[] = [];
  const claimed: HtmlMark[] = [];
  const skips: HtmlSkip[] = [];
  const documents: Document[] = [];

  for (const file of [...files].filter((f) => f.endsWith('.html')).sort()) {
    let source: string;
    try {
      source = readFileSync(join(cwd, file), 'utf8');
    } catch (error) {
      // ENOENT is the stated vanish case — the file went between the walk and
      // this read, and there is nothing to report. Anything else (a permission
      // bit, a directory in a document's place, a torn device) means the batch's
      // all-or-nothing promise would otherwise cover the READABLE subset of the
      // managed set while `check` reported green over a stale page.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw new CliError(
        `${file}: could not be read (${code ?? 'unknown'}) — fix its permissions, ` +
          'or remove it from the managed surfaces',
      );
    }
    const document = readDocument(file, source);
    documents.push(document);
    readOne(document, proposals, claimed, skips);
  }

  const order = (a: { file: string; line: number }, b: { file: string; line: number }): number =>
    a.file.localeCompare(b.file) || a.line - b.line;
  proposals.sort(order);
  skips.sort(order);
  return { proposals, claimed, skips, documents };
}

/** Every element's parent in a document — the tree the tokenizer builds carries children alone. */
export function parentsOf(document: Document): Map<Element, Element> {
  const parents = new Map<Element, Element>();
  const visit = (el: Element): void => {
    for (const child of el.children) {
      parents.set(child, el);
      visit(child);
    }
  };
  for (const root of document.roots) visit(root);
  return parents;
}

/**
 * The section word of an element (key-names' `sectionWord`) over its chain of
 * parents: an `id` attribute, and a headed section's first heading's plain
 * text, all of it.
 *
 * A word of its own beside `Element.section`, which stays the innermost id and
 * keeps its meaning for scan's `--json` and the dashboard's grouping.
 */
export function sectionWordOf(el: Element, parents: Map<Element, Element>): string | null {
  function* chain(): Generator<SectionNode> {
    for (let at: Element | undefined = el; at !== undefined; at = parents.get(at)) {
      const here = at;
      yield {
        tag: here.tag,
        id: () => here.attrs.find((a) => a.name === 'id')?.value,
        heading: () => {
          const found = here.descendants.find((d) => /^h[1-6]$/.test(d.tag));
          return found === undefined ? undefined : valueOf(found).plain;
        },
      };
    }
  }
  return sectionWord(chain());
}

function readOne(
  document: Document,
  proposals: HtmlProposal[],
  claimed: HtmlMark[],
  skips: HtmlSkip[],
): void {
  const {
    keyElements,
    strayMarks,
    structuralRuns,
    blankedRuns,
    faultedMarks,
    duplicateMarks,
    emptyMarks,
    preMarks,
  } = locate(document);
  const line = document.lineAt;
  // Every element inside an `<svg>`: a `<title>` there names the graphic, not the page.
  const svg = new Set<Element>();
  const underSvg = (els: Element[], under: boolean): void => {
    for (const el of els) {
      if (under) svg.add(el);
      underSvg(el.children, under || el.tag === 'svg');
    }
  };
  underSvg(document.roots, false);
  const parents = parentsOf(document);

  // Which attributes a `data-stet-<attr>` already binds, so an attribute is
  // proposed exactly once and a bound one is silent.
  const bound = new Set<string>();
  const markScopes: Array<{ start: number; end: number }> = [];

  for (const el of keyElements) {
    const mark = el.attrs.find((a) => a.name === 'data-stet');
    const read = valueOf(el);
    const unknown = undecodedEntity(rawTextOf(el));
    if (mark !== undefined) {
      markScopes.push({ start: el.openStart, end: el.closeEnd });
      if (unknown !== undefined) {
        skips.push(
          skipOf(
            document,
            el.openStart,
            'unknown-entity',
            'mark',
            `${unknown} is not an entity stet can decode`,
            'replace it with the character itself',
          ),
        );
      }
      claimed.push({
        file: document.file,
        line: line(el.openStart),
        tag: el.tag,
        kind: 'element',
        ...(svg.has(el) ? { inSvg: true as const } : {}),
        key: mark.value,
        value: unknown === undefined ? read.value : null,
        tags: read.tags,
        element: el,
        document,
      });
      continue;
    }
    if (unknown !== undefined) {
      skips.push(
        skipOf(
          document,
          el.openStart,
          'unknown-entity',
          'adoption',
          `${unknown} is not an entity stet can decode`,
          'replace it with the character itself',
        ),
      );
      continue;
    }
    proposals.push({
      file: document.file,
      line: line(el.openStart),
      tag: el.tag,
      ...(el.section === undefined ? {} : { section: el.section }),
      kind: 'element',
      ...(svg.has(el) ? { inSvg: true as const } : {}),
      value: read.value,
      plain: read.plain,
      tags: read.tags,
      sectionWord: sectionWordOf(el, parents),
      role: roleOf({ file: document.file, line: line(el.openStart), tag: el.tag, ...(svg.has(el) ? { svg: true as const } : {}) }),
      insertAt: insertAtOf(document, el),
    });
  }

  // Marks that name an attribute — bound where the attribute is one stet
  // manages and carries a quoted value, refused otherwise.
  const visitMarks = (el: Element): void => {
    for (const attr of el.attrs) {
      const named = MARK_ATTR.exec(attr.name);
      if (named === null || named[1] === undefined) continue;
      const target = named[1];
      const on = el.attrs.find((a) => a.name === target);
      const refused = !MARKABLE_ATTRS.has(target) || !attrIsCopy(el, target);
      if (refused || on === undefined || !on.quoted) {
        // Two different faults, two different remedies: an attribute stet does
        // not manage is the mark's own mistake, while a managed attribute that
        // is absent or unquoted is a page the operator can fix.
        skips.push(
          skipOf(
            document,
            attr.start,
            'mark-in-refused-context',
            'mark',
            refused
              ? `data-stet-${target} names an attribute stet does not manage`
              : `data-stet-${target} names an attribute this element does not carry quoted`,
            refused ? 'remove the mark' : 'add the attribute with a quoted value, or remove the mark',
          ),
        );
        continue;
      }
      bound.add(`${el.openStart}:${target}`);
      markScopes.push({ start: el.openStart, end: el.closeEnd });
      const text = attrValueOf(on);
      const metaName = target === 'content' ? metaCopyName(el) : null;
      const unknown = undecodedEntity(on.value);
      if (unknown !== undefined) {
        skips.push(
          skipOf(
            document,
            attr.start,
            'unknown-entity',
            'mark',
            `${unknown} is not an entity stet can decode`,
            'replace it with the character itself',
          ),
        );
      }
      claimed.push({
        file: document.file,
        line: line(el.openStart),
        tag: el.tag,
        kind: 'attribute',
        attr: target,
        ...(metaName === null ? {} : { metaName }),
        key: attr.value,
        value: unknown === undefined ? text : null,
        tags: 0,
        element: el,
        document,
      });
    }
    for (const child of el.children) visitMarks(child);
  };
  for (const root of document.roots) visitMarks(root);

  for (const candidate of attrCandidates(document)) {
    if (bound.has(`${candidate.el.openStart}:${candidate.attr.name}`)) continue;
    const text = attrValueOf(candidate.attr);
    const unknown = undecodedEntity(candidate.attr.value);
    if (unknown !== undefined) {
      skips.push(
        skipOf(
          document,
          candidate.attr.start,
          'unknown-entity',
          'adoption',
          `${unknown} is not an entity stet can decode`,
          'replace it with the character itself',
        ),
      );
      continue;
    }
    proposals.push({
      file: document.file,
      line: line(candidate.el.openStart),
      tag: candidate.el.tag,
      ...(candidate.el.section === undefined ? {} : { section: candidate.el.section }),
      kind: 'attribute',
      attr: candidate.attr.name,
      ...(candidate.metaName === null ? {} : { metaName: candidate.metaName }),
      value: text,
      plain: text,
      tags: 0,
      sectionWord: sectionWordOf(candidate.el, parents),
      role: roleOf({
        file: document.file,
        line: line(candidate.el.openStart),
        tag: candidate.el.tag,
        attr: candidate.attr.name,
        ...(candidate.metaName === null ? {} : { meta: candidate.metaName }),
      }),
      insertAt: insertAtOf(document, candidate.el),
    });
  }

  for (const el of strayMarks) {
    const key = el.attrs.find((a) => a.name === 'data-stet')?.value ?? '';
    const detail = holdsBlankedSpan(document, el)
      ? `data-stet="${key}" sits on <${el.tag}>, whose content holds a script, style or comment stet does not manage`
      : `data-stet="${key}" sits on <${el.tag}>, which holds no text of its own`;
    const remedy = holdsBlankedSpan(document, el)
      ? 'move the mark onto an element that holds text alone'
      : 'move the mark onto the element that holds the text';
    skips.push(
      skipOf(document, el.openStart, 'mark-on-non-key-element', 'mark', detail, remedy),
    );
  }

  const markKey = (el: Element): string => el.attrs.find((a) => a.name === 'data-stet')?.value ?? '';

  for (const el of emptyMarks) {
    skips.push(
      skipOf(
        document,
        el.openStart,
        'mark-on-non-key-element',
        'mark',
        `data-stet="${markKey(el)}" sits on <${el.tag}>, which has no content to hold text`,
        'mark a copy attribute with data-stet-<attr> instead',
      ),
    );
  }

  for (const el of preMarks) {
    skips.push(
      skipOf(
        document,
        el.openStart,
        'mark-on-non-key-element',
        'mark',
        `data-stet="${markKey(el)}" sits on <pre>, whose whitespace stet does not manage`,
        'mark the elements around it instead',
      ),
    );
  }

  for (const el of duplicateMarks) {
    skips.push(
      skipOf(
        document,
        el.openStart,
        'mark-on-non-key-element',
        'mark',
        `<${el.tag}> carries two data-stet marks`,
        'keep one',
      ),
    );
  }

  for (const el of structuralRuns) {
    skips.push(
      skipOf(
        document,
        el.openStart,
        'text-in-structure',
        'adoption',
        `text sits directly inside <${el.tag}>, which has no element to mark`,
        'wrap it in a p, span or li',
      ),
    );
  }
  // An element whose bare run shares its content with a span the detector
  // blanked. Marked, it is already a `mark-on-non-key-element` above; UNMARKED
  // it is scan's to name, because scan's contract is to report every run it did
  // not adopt and silence would read as "stet has this covered".
  for (const el of blankedRuns) {
    if (el.attrs.some((a) => a.name === 'data-stet')) continue;
    skips.push(
      skipOf(
        document,
        el.openStart,
        'text-beside-code',
        'adoption',
        `text in <${el.tag}> sits beside a script, style, comment or declaration stet cannot regenerate whole`,
        'move the script, style, comment or declaration outside the element, or the text into one of its own',
      ),
    );
  }

  for (const fault of document.faults) {
    // A fault inside a marked element, or one that faulted a marked element
    // itself, is the mark's problem: `check` and the regenerator read mark scope
    // alone, and this is the accurate reason for a mark they must refuse.
    const inMark =
      markScopes.some((s) => s.start <= fault.offset && fault.offset < s.end) ||
      faultedMarks.some((el) => el.openStart <= fault.offset && fault.offset < el.closeEnd);
    skips.push(unpairedSkip(document, fault, inMark ? 'mark' : 'adoption'));
  }

  // A mark inside a span the reader never enters — a script, a style, a comment,
  // or one of the opaque containers.
  MARK_IN_SOURCE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = MARK_IN_SOURCE.exec(document.source)) !== null) {
    const at = found.index;
    const container = refusedContainerAt(document, at);
    if (container === null) continue;
    skips.push(
      skipOf(
        document,
        at,
        'mark-in-refused-context',
        'mark',
        `${found[0].replace(/\s*=$/, '')} sits inside <${container}>`,
        'remove the mark',
      ),
    );
  }
}

/** The offset a mark is inserted at: the open tag's `>`, or its `/>`. */
function insertAtOf(document: Document, el: Element): number {
  const openTag = document.blanked.slice(el.openStart, el.openEnd);
  if (!openTag.endsWith('/>')) return el.openStart + openTag.length - 1;
  // Step back over the whitespace already before `/>` so `<img … />` gains
  // ` data-stet-alt="…" />` — one space each side — rather than a doubled space
  // before the mark and none after it.
  let at = openTag.length - 2;
  while (at > 0 && /[ \t\r\n]/.test(openTag.charAt(at - 1))) at -= 1;
  return el.openStart + at;
}

/** The container a refused mark sits inside, or null where the mark is in ordinary markup. */
function refusedContainerAt(document: Document, at: number): string | null {
  for (const span of document.opaque) {
    if (span.start <= at && at < span.end) return span.tag;
  }
  if (document.blanked.charAt(at) !== '\0') return null;
  const before = document.source.slice(0, at);
  const script = before.lastIndexOf('<script');
  const style = before.lastIndexOf('<style');
  const comment = before.lastIndexOf('<!--');
  const nearest = Math.max(script, style, comment);
  if (nearest < 0) return null;
  return nearest === comment ? 'comment' : nearest === script ? 'script' : 'style';
}

// --- The documents as generated forms ---------------------------------------

/**
 * The body escape: three characters and no more. An apostrophe or a quote in
 * prose stays exactly as written, because a body text node has no delimiter to
 * break — the web target's full escaper is for a QUOTED ATTRIBUTE value, which
 * is the contract `src/targets/adapter.ts` states and the only place it runs.
 */
function escapeBody(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Every mark attribute removed with the whitespace before it, the text kept.
 *
 * By recorded ATTRIBUTE SPAN, never by regex over the whole document. A regex
 * cannot tell an attribute from prose that quotes one, so it deleted a
 * `<code>data-stet-alt="…"</code>` sample out of a page about stet, and its
 * unbounded `[^"]*` ran past a mark text with no closing quote nearby — in one
 * measured case eighty-nine characters spanning two paragraphs, `</p>` and a
 * `<p>` among them. `readDocument` already records every attribute's exact
 * offsets; this deletes those and nothing else.
 */
export function stripMarks(text: string): string {
  const document = readDocument('', text);
  const edits: Edit[] = [];
  const visit = (el: Element): void => {
    for (const attr of el.attrs) {
      if (!MARK_ATTR.test(attr.name)) continue;
      let from = attr.start;
      while (from > 0 && /[ \t]/.test(text.charAt(from - 1))) from -= 1;
      edits.push({ pos: from, end: attr.end, text: '' });
    }
    for (const child of el.children) visit(child);
  };
  for (const root of document.roots) visit(root);
  return edits.length === 0 ? text : applyFileEdits(text, edits);
}

/**
 * A marked element's content, rebuilt from its key's value.
 *
 * The value is walked against the element's FLAT DESCENDANT list — the same
 * depth-first numbering the value was written from — so a placeholder reaches
 * the right element however deeply it nests. A text run is escaped; `<n>…</n>`
 * reproduces descendant `n`'s open and close tags verbatim with the
 * placeholder's own inner text between them; `<n/>` reproduces that
 * descendant's WHOLE source span, so a void element's tag and an empty
 * element's tag PAIR both come back and the document stays balanced.
 *
 * `null` where the value's placeholders are not exactly `1..n`, each once and
 * balanced: the save gate stops a candidate reaching the snapshot in that
 * state, so this fires only on a hand edit to one side or the other.
 */
function rebuild(
  document: Document,
  el: Element,
  value: string,
  tags: number | undefined,
): string | null {
  // The key's DECLARATION decides, never the value's shape. `checkTags` in
  // src/validate.ts deliberately does not check a key without `tags` — a `<1>`
  // in ordinary prose is prose — so scanning for placeholders here regardless
  // made the save gate admit exactly the value the regenerator then refused,
  // wedging every write while `check` reported the host green.
  if (tags === undefined) {
    return el.descendants.length === 0 ? escapeBody(readBack(value)) : null;
  }
  // Normalised ONCE over the whole value: collapsing per run would trim the
  // single space that separates a run from a placeholder.
  const text = readBack(value);
  const stack: string[][] = [[]];
  const open: number[] = [];
  const used = new Set<number>();
  const top = (): string[] => stack[stack.length - 1] as string[];
  const at = (n: number): Element | undefined => el.descendants[n - 1];

  let last = 0;
  for (const found of text.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
    const index = found.index;
    top().push(escapeBody(text.slice(last, index)));
    last = index + found[0].length;
    const n = Number(found[2]);
    const descendant = at(n);
    if (descendant === undefined) return null;
    if (found[1] === '/') {
      if (open.pop() !== n) return null;
      const inner = (stack.pop() as string[]).join('');
      top().push(
        document.source.slice(descendant.openStart, descendant.openEnd) +
          inner +
          document.source.slice(descendant.closeStart, descendant.closeEnd),
      );
      continue;
    }
    if (used.has(n)) return null;
    used.add(n);
    if (found[3] === '/') {
      top().push(document.source.slice(descendant.openStart, descendant.closeEnd));
      continue;
    }
    open.push(n);
    stack.push([]);
  }
  top().push(escapeBody(text.slice(last)));
  if (open.length > 0 || stack.length !== 1) return null;
  if (used.size !== el.descendants.length) return null;
  return (stack[0] as string[]).join('');
}

/**
 * A key's declared `tags`, read as an own property (`keyDefOf`) because the name
 * comes off the DOCUMENT and the map is JSON-parsed. The regenerator and `check` both
 * read it here, so the hook and the write can never disagree about a value.
 */
function tagsOf(descriptor: Descriptor, key: string): number | undefined {
  return keyDefOf(descriptor, key)?.tags;
}

/**
 * Why the value and the element disagree, in the operator's terms. An UNDECLARED
 * key is a different fault from a declared one whose count is wrong: the value
 * carries no placeholders because the key never asked for any, so naming its
 * placeholder count would describe a symptom rather than the cause.
 */
function mismatchOf(
  el: Element,
  value: string,
  declared: number | undefined,
): { detail: string; remedy: string } {
  const count = el.descendants.length;
  if (declared === undefined) {
    return {
      detail: `the key declares no tags, the element has ${count} descendant element(s)`,
      remedy:
        `declare tags: ${count} on the key and give the value its placeholders, ` +
        'or mark the elements inside it instead',
    };
  }
  return {
    detail:
      `the value carries ${placeholderCount(value)} placeholder tag(s), the element has ` +
      `${count} descendant element(s)`,
    remedy: 'edit one side',
  };
}

/** How many distinct placeholder numbers a value references. */
function placeholderCount(value: string): number {
  const seen = new Set<string>();
  for (const found of value.matchAll(/<\/?(\d+)\/?>/g)) seen.add(found[1] as string);
  return seen.size;
}

/**
 * The content span with its leading and trailing whitespace left alone, so the
 * indentation inside the tags survives a regeneration and only the runs inside
 * the mark collapse.
 */
function trimmedContent(document: Document, el: Element): { start: number; end: number } {
  let start = el.contentStart;
  let end = el.contentEnd;
  // The SAME ASCII class the collapse and the trim use. `\s` would eat a
  // leading or trailing U+00A0 out of the span while the value still carries
  // it, and the splice would then write a second one on every regeneration.
  while (start < end && /[ \t\r\n\f]/.test(document.source.charAt(start))) start += 1;
  while (end > start && /[ \t\r\n\f]/.test(document.source.charAt(end - 1))) end -= 1;
  return { start, end };
}

/**
 * The text a mark renders: a derived key's resolution, else the key's own
 * default-locale value. `planDocuments` and `checkDocuments` both read it, so a
 * derived key's element or attribute is regenerated and checked like any other.
 */
function markValue(descriptor: Descriptor, snapshot: Snapshot, key: string): unknown {
  const def = keyDefOf(descriptor, key);
  if (def?.derivesFrom !== undefined) return resolve(descriptor, snapshot, null, { key }).value;
  const values = snapshot['default'] ?? {};
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/**
 * Every managed document regenerated from the snapshot — one write triple per
 * document whose rebuilt text differs from what is on disk.
 *
 * Only `scope: 'mark'` skips come back: a stray run in a `<ul>` or an unknown
 * entity in unmarked prose is scan's to name and never stops a write, because
 * markup stet does not manage is not stet's red. The CALLER refuses the batch
 * while any skip stands — nothing here writes.
 */
export function planDocuments(
  cwd: string,
  files: string[],
  descriptor: Descriptor,
  snapshot: Snapshot,
  report: Report,
): { writes: Array<{ abs: string; text: string; rel: string }>; skips: HtmlSkip[] } {
  const set = proposeHtml(cwd, files);
  const skips = set.skips.filter((s) => s.scope === 'mark');
  const writes: Array<{ abs: string; text: string; rel: string }> = [];

  for (const document of set.documents) {
    const edits: Edit[] = [];
    for (const mark of set.claimed.filter((m) => m.document === document)) {
      // A mark naming no declared key is STRIPPED and its text kept — how
      // `remove` drops a mark, and how a typo'd hand-written one becomes
      // visible rather than silently ignored.
      if (!Object.hasOwn(descriptor.keys, mark.key)) {
        const attr = mark.element.attrs.find(
          (a) => a.name === (mark.kind === 'element' ? 'data-stet' : `data-stet-${mark.attr}`),
        );
        if (attr === undefined) continue;
        let from = attr.start;
        while (from > 0 && /[ \t]/.test(document.source.charAt(from - 1))) from -= 1;
        edits.push({ pos: from, end: attr.end, text: '' });
        report.line(
          `${document.file}:${mark.line}: data-stet="${mark.key}" names no key — the mark is removed and the text stays`,
        );
        continue;
      }
      const value = markValue(descriptor, snapshot, mark.key);
      if (typeof value !== 'string') continue; // a missing value is `check`'s `missing` finding
      if (mark.kind === 'attribute') {
        const attr = mark.element.attrs.find((a) => a.name === mark.attr);
        if (attr === undefined || !attr.quoted) continue;
        edits.push({
          pos: attr.valueStart,
          end: attr.valueEnd,
          text: targetAdapter(DEFAULT_TARGET).escape(value),
        });
        continue;
      }
      const declared = tagsOf(descriptor, mark.key);
      const built = rebuild(document, mark.element, value, declared);
      if (built === null) {
        const fault = mismatchOf(mark.element, value, declared);
        skips.push(
          skipOf(document, mark.element.openStart, 'tag-count-mismatch', 'mark', fault.detail, fault.remedy),
        );
        continue;
      }
      const span = trimmedContent(document, mark.element);
      edits.push({ pos: span.start, end: span.end, text: built });
    }
    if (edits.length === 0) continue;
    const out = applyFileEdits(document.source, edits);
    if (out === document.source) continue;
    writes.push({ abs: join(cwd, document.file), text: out, rel: document.file });
  }
  return { writes, skips };
}

// --- register's html branch -------------------------------------------------

export interface HtmlRegisterPlan {
  edited: Array<{ abs: string; text: string; rel: string; diff: string }>;
  added: number;
  shared: number;
  marked: number;
  /** Head texts this run minted as derived keys. */
  derived: HtmlDerivation[];
  /** Existing literal head keys this run turns into derived ones; no document changes for them. */
  converted: HtmlDerivation[];
  /** The keys this run adds, in the order it minted them: what a naming plan lists. */
  minted: HtmlMint[];
}

/** A key this run adds, as a naming plan shows it. */
export interface HtmlMint {
  /** Its role name (`numberNames` over the run), or the name a plan chose. */
  key: string;
  /** The role name the rule gave it, before any plan. */
  proposed: string;
  /** Every element and attribute the run marks with it, in document order. */
  places: Place[];
  /** The value it is seeded with, or the template of a derived key. */
  text: string;
  sectionWord: string | null;
  /** The name of the key a derived key follows. */
  derivesFrom?: string;
}

/** What a naming plan says about one proposed key: its name, and the words that go on its entry. */
export interface ChosenName {
  /** `false` leaves the key out: no entry, no value, no mark. */
  adopt?: false;
  key: string;
  label?: string;
  help?: string;
  /** The section word the entry writes; `null` writes none. */
  section?: string | null;
}

/** One head text's derivation, where register reports it. */
export interface HtmlDerivation {
  key: string;
  source: string;
  tmpl: string;
  file: string;
  line: number;
}

/**
 * A head text: the page's `<title>` element's text — a `<title>` inside an
 * `<svg>` names the graphic and is not one — or the `content` of a meta whose
 * text is copy: the description, and the share title and description. The page
 * shows these outside its body, and each may carry text the body shows.
 */
export function isHeadText(at: {
  kind: 'element' | 'attribute';
  tag: string;
  attr?: string;
  metaName?: string;
  inSvg?: true;
}): boolean {
  return isHeadKind(placeOf({ file: '', line: 0, ...at }));
}

/** Visible text: an element's text anywhere but `<title>`. */
function isVisibleText(at: { kind: 'element' | 'attribute'; tag: string }): boolean {
  return at.kind === 'element' && at.tag !== 'title';
}

/**
 * A proposal or a mark as the place the vocabulary reads: its file and line,
 * its element, and for an attribute its name — a meta's `name` beside its
 * `content` — and whether an `<svg>` holds it. The one place object the naming
 * plan, the head-text rule and the dashboard's marks route share.
 */
export function placeOf(at: {
  file: string;
  line: number;
  kind: 'element' | 'attribute';
  tag: string;
  attr?: string;
  metaName?: string;
  inSvg?: true;
}): Place {
  return {
    file: at.file,
    line: at.line,
    tag: at.tag,
    ...(at.kind === 'attribute' && at.attr !== undefined ? { attr: at.attr } : {}),
    ...(at.metaName === undefined ? {} : { meta: at.metaName }),
    ...(at.inSvg === undefined ? {} : { svg: true as const }),
  };
}

/** A visible text shorter than this is never read as the heart of a longer head text. */
const DERIVE_MIN = 12;

/** A letter or a digit: what a word boundary may not cut through. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The first occurrence of `part` in `text` with no letter or digit against either end, or -1. */
function wordBoundedIndex(text: string, part: string): number {
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) {
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = text.charAt(at + part.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return at;
  }
  return -1;
}

/**
 * The derivation a head text carries, or null: the visible key whose text it
 * holds — whole, or with words before or after it — and the template that
 * rebuilds the head text from it.
 *
 * The visible text is read through `derivedText`, the resolver's own rule, so a
 * headline's placeholder tags are dropped before the comparison, and a
 * template is kept only when the derivation renders the head text exactly —
 * which is what keeps the documents byte-identical when a literal becomes a
 * derivation. An equal text always qualifies. A text found inside a longer one
 * qualifies only when it is at least `DERIVE_MIN` characters, at least half the
 * head text, and word-bounded: a one-word button inside a description is not
 * what the description says. The longest visible text wins, then the first key
 * by name. A head text that already holds `{v}` is never templated, since the
 * resolver fills the first `{v}` alone.
 */
export function derivationOf(
  descriptor: Descriptor,
  text: string,
  visible: ReadonlyArray<{ key: string; value: string }>,
): { source: string; tmpl: string } | null {
  if (text === '' || text.includes('{v}')) return null;
  let best: { source: string; tmpl: string; length: number } | null = null;
  for (const { key, value } of visible) {
    const plain = derivedText(descriptor, key, value, '{v}');
    if (plain === '') continue;
    if (plain !== text && (plain.length < DERIVE_MIN || plain.length * 2 < text.length)) continue;
    const at = plain === text ? 0 : wordBoundedIndex(text, plain);
    if (at === -1) continue;
    const tmpl = `${text.slice(0, at)}{v}${text.slice(at + plain.length)}`;
    if (derivedText(descriptor, key, value, tmpl) !== text) continue;
    if (best === null || plain.length > best.length || (plain.length === best.length && key < best.source)) {
      best = { source: key, tmpl, length: plain.length };
    }
  }
  return best === null ? null : { source: best.source, tmpl: best.tmpl };
}

/**
 * Every proposal turned into a key and a mark, and every literal head key that
 * carries visible text turned into a derivation — the descriptor and snapshot
 * mutated in place and the edited documents returned for the caller's batch.
 *
 * Visible text is placed first, in document order, then the head texts, so a
 * head text can derive from a key this same run mints. Identical visible text
 * SHARES one key: the reverse map is built once from the default-locale
 * snapshot and extended as keys land, so a run's second occurrence of a value is
 * marked rather than minted. Only a `text` key of the web target with no
 * derivation is shared onto a page — an email key's value carries email rules,
 * and a derived one has no value of its own.
 *
 * A head text never shares a key with visible text. Identical head texts share
 * one key (a page's title and its share title, where they match); a head text
 * holding a visible key's text derives from that key (`derivationOf`); any
 * other head text takes a literal key. A source is a visible key marked in the
 * head text's own document and in no other: a nav label or a footer line
 * carried by every page belongs to none of them, and a title derived from it
 * would change on every page at once. For the same reason a derived key is
 * shared only onto a head text in its source's document, and a source is never
 * shared onto visible text in another document. The conversion reads
 * the same rule over the keys a document already carries: a key marked only on
 * head texts, all in one document, whose literal a derivation renders exactly,
 * gains `derivesFrom` and `tmpl` and leaves the snapshot, and no document
 * changes, because the resolved value is the literal it replaces.
 */
export function planHtmlRegister(input: {
  cwd: string;
  files: string[];
  descriptor: Descriptor;
  snapshot: Snapshot;
  report: Report;
  /** The page word of a document (`pageOfFile`); pages.ts owns routes, and importing it here would close a ring. */
  pageOf: (file: string) => string;
  /** A naming plan's choice for a proposed name, where the run applies one. */
  chosen?: (proposed: string) => ChosenName | undefined;
}): HtmlRegisterPlan {
  const { cwd, files, descriptor, snapshot, report, pageOf, chosen } = input;
  const set = proposeHtml(cwd, files);
  // The names the descriptor held before the run: a role name never lands on one.
  const before = new Set(Object.keys(descriptor.keys));
  const defaults = (): Record<string, unknown> => snapshot['default'] ?? {};
  // An own-property read (`keyDefOf`), not a bare index: a name from the
  // SNAPSHOT or a DOCUMENT is read against the DESCRIPTOR's map, so
  // `constructor` would otherwise resolve to a prototype member.
  const defOf = (key: string): KeyDef | undefined => keyDefOf(descriptor, key);
  /** A key's own text, where it is a web `text` key with no derivation. */
  const literalOf = (key: string): string | null => {
    const def = defOf(key);
    const value = Object.hasOwn(defaults(), key) ? defaults()[key] : undefined;
    if (def === undefined || def.shape !== 'text' || def.target !== DEFAULT_TARGET) return null;
    return def.derivesFrom === undefined && typeof value === 'string' ? value : null;
  };

  // Where the documents already carry each key.
  const marksOf = new Map<string, HtmlMark[]>();
  for (const mark of set.claimed) marksOf.set(mark.key, [...(marksOf.get(mark.key) ?? []), mark]);
  const headOnly = new Set([...marksOf].filter(([, marks]) => marks.every(isHeadText)).map(([key]) => key));
  // The documents each key is marked in, before the run and as it marks.
  const docsOf = new Map<string, Set<string>>();
  const markedIn = (key: string, file: string): void => {
    docsOf.set(key, (docsOf.get(key) ?? new Set<string>()).add(file));
  };
  for (const mark of set.claimed) markedIn(mark.key, mark.file);
  /** Whether every mark of `key` is in `file`. */
  const onlyIn = (key: string, file: string): boolean => {
    const docs = docsOf.get(key);
    return docs !== undefined && docs.size === 1 && docs.has(file);
  };
  // Visible keys and their text, the sources a head text may derive from.
  const visible = new Map<string, string>();
  for (const [key, marks] of marksOf) {
    const text = literalOf(key);
    if (text !== null && marks.some(isVisibleText)) visible.set(key, text);
  }

  // Keyed by value AND declared tag count: sharing a `tags: 1` key onto an
  // element with no descendants writes a value the regenerator must refuse. A
  // key marked only on head texts is left out: visible text never shares one.
  // EVERY key per value, in name order and then as the run mints them (F40): a
  // key tied to a derivation in another document is passed over for the next,
  // so a third page carrying the text shares the second page's key.
  const byValue = new Map<string, string[]>();
  const holdValue = (slot: string, key: string): void => {
    byValue.set(slot, [...(byValue.get(slot) ?? []), key]);
  };
  for (const key of Object.keys(defaults()).sort()) {
    const text = literalOf(key);
    if (text === null || headOnly.has(key)) continue;
    holdValue(`${defOf(key)?.tags ?? 0}\u0000${text}`, key);
  }
  // Head texts by the text they render, derived keys by their resolution.
  const byHeadText = new Map<string, string>();
  for (const key of [...headOnly].sort()) {
    const text = resolve(descriptor, snapshot, null, { key }).value;
    if (typeof text === 'string' && !byHeadText.has(text)) byHeadText.set(text, key);
  }

  // A mark's edit names its key at the end, once the run's keys have their names.
  // Whether each mark shares a key it did not mint, so the counts are read from
  // the marks that land, once a plan has left some out.
  const edits = new Map<Document, Array<{ at: number; key: string; attr?: string; shared: boolean }>>();
  const placesOf = new Map<string, Place[]>();
  const minting: Array<{ tmp: string; proposal: HtmlProposal; text: string }> = [];
  const derived: HtmlDerivation[] = [];

  const markWith = (proposal: HtmlProposal, key: string, shared: boolean): void => {
    const document = set.documents.find((d) => d.file === proposal.file) as Document;
    // The ONE edit: an attribute at the end of the open tag. The text is
    // never touched.
    const list = edits.get(document) ?? [];
    list.push({ at: proposal.insertAt, key, shared, ...(proposal.kind === 'attribute' ? { attr: proposal.attr as string } : {}) });
    edits.set(document, list);
    placesOf.set(key, [...(placesOf.get(key) ?? []), placeOf(proposal)]);
    markedIn(key, proposal.file);
  };
  /** A fresh key, tentatively added so the save gate can read its own rules; reverted on a refusal, the JSX loop's idiom. */
  // A fresh key takes a placeholder no descriptor key can equal (the key grammar
  // admits no control character); its role name is given once the run knows
  // every key it adds, so a repeated role is numbered from 1 across the run.
  const mint = (proposal: HtmlProposal, def: KeyDef, value: string | null): string | null => {
    const key = `\u0001${minting.length}`;
    // The gate's findings name the key; the placeholder never reaches output, so
    // they are told by the element's file and line.
    const passed = validateUnnamed({
      descriptor,
      snapshot,
      placeholder: key,
      def,
      stored: value,
      value: proposal.value,
      report,
      name: `${proposal.file}:${proposal.line}`,
      at: { at: { file: proposal.file, line: proposal.line } },
      keep: true,
    });
    if (!passed) return null;
    minting.push({ tmp: key, proposal, text: value ?? def.tmpl ?? '' });
    return key;
  };

  // Document order within a file; an attribute before the element text at one offset.
  const order = [...set.proposals].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.insertAt - b.insertAt ||
      (a.kind === 'attribute' ? 0 : 1) - (b.kind === 'attribute' ? 0 : 1),
  );

  // A derivation source keeps its single document: visible text elsewhere that
  // repeats it takes a key of its own, so the head texts derived from it never
  // start following a second page.
  const sources = new Set(Object.values(descriptor.keys).map((def) => def.derivesFrom));
  const tiedElsewhere = (key: string, file: string): boolean =>
    sources.has(key) && [...(docsOf.get(key) ?? [])].some((doc) => doc !== file);

  for (const proposal of order.filter((p) => !isHeadText(p))) {
    let key = (byValue.get(`${proposal.tags}\u0000${proposal.value}`) ?? []).find((k) => !tiedElsewhere(k, proposal.file));
    if (key === undefined) {
      const minted = mint(
        proposal,
        { shape: 'text', target: DEFAULT_TARGET, ...(proposal.tags > 0 ? { tags: proposal.tags } : {}) },
        proposal.value,
      );
      if (minted === null) continue;
      key = minted;
      holdValue(`${proposal.tags}\u0000${proposal.value}`, key);
      if (isVisibleText(proposal)) visible.set(key, proposal.value);
      markWith(proposal, key, false);
      continue;
    }
    if (isVisibleText(proposal)) visible.set(key, proposal.value);
    markWith(proposal, key, true);
  }

  /** The visible keys a head text in `file` may derive from: those marked in that document alone. */
  const sourcesIn = (file: string): Array<{ key: string; value: string }> =>
    [...visible]
      .filter(([key]) => onlyIn(key, file))
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const proposal of order.filter(isHeadText)) {
    let key = byHeadText.get(proposal.value);
    const from = key === undefined ? undefined : defOf(key)?.derivesFrom;
    if (key !== undefined && (from === undefined || onlyIn(from, proposal.file))) {
      markWith(proposal, key, true);
      continue;
    }
    const found = derivationOf(descriptor, proposal.value, sourcesIn(proposal.file));
    const unmarked = (byValue.get(`0\u0000${proposal.value}`) ?? [])[0];
    if (found !== null) {
      const minted = mint(proposal, { shape: 'text', target: DEFAULT_TARGET, derivesFrom: found.source, tmpl: found.tmpl }, null);
      if (minted === null) continue;
      key = minted;
      derived.push({ key, ...found, file: proposal.file, line: proposal.line });
    } else if (unmarked !== undefined && !docsOf.has(unmarked)) {
      // A key declared before the run and marked nowhere, before it or in it, is shared, as ever.
      byHeadText.set(proposal.value, unmarked);
      markWith(proposal, unmarked, true);
      continue;
    } else {
      const minted = mint(proposal, { shape: 'text', target: DEFAULT_TARGET }, proposal.value);
      if (minted === null) continue;
      key = minted;
    }
    byHeadText.set(proposal.value, key);
    markWith(proposal, key, false);
  }

  // The conversion: literal head keys the documents already carry.
  const converted: HtmlDerivation[] = [];
  const derivedFrom = new Set(Object.values(descriptor.keys).map((def) => def.derivesFrom));
  // `headOnly` holds only keys no visible text carries: visible text never shares one, so none is a source.
  for (const key of [...headOnly].sort()) {
    const text = literalOf(key);
    if (text === null || defOf(key)?.tags !== undefined || derivedFrom.has(key)) continue;
    // Only a key whose value lives in the default locale alone: a derivation replaces every locale's literal.
    if (Object.keys(snapshot).some((locale) => locale !== 'default' && Object.hasOwn(snapshot[locale] ?? {}, key))) continue;
    // Only a key marked in one document, deriving from a key marked in that document alone.
    const docs = [...(docsOf.get(key) as Set<string>)];
    if (docs.length !== 1) continue;
    const found = derivationOf(descriptor, text, sourcesIn(docs[0] as string));
    if (found === null) continue;
    const def = defOf(key) as KeyDef;
    descriptor.keys[key] = { ...def, derivesFrom: found.source, tmpl: found.tmpl };
    delete snapshot['default']?.[key];
    // The byte-identity guard: the resolution must give back the literal, or the
    // key stays as it was. A cross-check: `derivationOf` keeps a template only
    // where the derivation renders the text exactly, so this never fires.
    if (resolve(descriptor, snapshot, null, { key }).value !== text) {
      descriptor.keys[key] = def;
      (snapshot['default'] ??= {})[key] = text;
      continue;
    }
    const first = (marksOf.get(key) as HtmlMark[])[0] as HtmlMark;
    converted.push({ key, ...found, file: first.file, line: first.line });
  }

  // The names. Each key this run adds is named from its first mark — `site` for
  // its page where it is marked in more than one document, no section for a
  // head text — and the run's names are numbered together.
  const bases = minting.map(({ tmp, proposal }) => {
    const docs = docsOf.get(tmp) ?? new Set<string>();
    return baseName({
      page: docs.size > 1 ? SITE_PAGE : pageOf(proposal.file),
      ...(isHeadText(proposal) ? {} : { section: proposal.sectionWord }),
      role: proposal.role,
    });
  });
  const proposedNames = numberNames(bases, (name) => before.has(name));
  const finalOf = new Map<string, string>();
  const minted: HtmlMint[] = [];
  const dropped = new Set<string>();
  minting.forEach(({ tmp, proposal, text }, i) => {
    const proposed = proposedNames[i] as string;
    const choice = chosen?.(proposed);
    const def = descriptor.keys[tmp] as KeyDef;
    delete descriptor.keys[tmp];
    if (choice?.adopt === false) {
      // Left out by the plan: its entry, its value and every mark it would get.
      delete snapshot['default']?.[tmp];
      dropped.add(tmp);
      return;
    }
    const name = choice?.key ?? proposed;
    finalOf.set(tmp, name);
    const section = choice?.section === undefined ? proposal.sectionWord : choice.section;
    descriptor.keys[name] = {
      ...def,
      ...(section === null ? {} : { section }),
      ...(choice?.label === undefined ? {} : { label: choice.label }),
      ...(choice?.help === undefined ? {} : { help: choice.help }),
    };
    const block = snapshot['default'];
    if (block !== undefined && Object.hasOwn(block, tmp)) {
      block[name] = block[tmp];
      delete block[tmp];
    }
    minted.push({
      key: name,
      proposed,
      places: placesOf.get(tmp) ?? [],
      text,
      sectionWord: proposal.sectionWord,
      ...(def.derivesFrom === undefined ? {} : { derivesFrom: def.derivesFrom }),
    });
  });
  const named = (key: string): string => finalOf.get(key) ?? key;
  for (const def of Object.values(descriptor.keys)) {
    if (def.derivesFrom !== undefined) def.derivesFrom = named(def.derivesFrom);
  }
  for (const mint of minted) if (mint.derivesFrom !== undefined) mint.derivesFrom = named(mint.derivesFrom);
  const keptDerived = derived.filter((d) => !dropped.has(d.key));
  derived.length = 0;
  derived.push(...keptDerived);
  for (const derivation of [...derived, ...converted]) {
    derivation.key = named(derivation.key);
    derivation.source = named(derivation.source);
  }

  const edited: HtmlRegisterPlan['edited'] = [];
  for (const document of set.documents) {
    const marks = (edits.get(document) ?? []).filter((m) => !dropped.has(m.key));
    if (marks.length === 0) continue;
    const list: Edit[] = marks.map(({ at, key, attr }) => ({
      pos: at,
      end: at,
      text: attr === undefined ? ` data-stet="${named(key)}"` : ` data-stet-${attr}="${named(key)}"`,
    }));
    const out = applyFileEdits(document.source, list);
    edited.push({
      abs: join(cwd, document.file),
      text: out,
      rel: document.file,
      diff: formatDiff(document.file, document.source, out),
    });
  }
  // The counts, from what lands: every key kept, every mark kept, and the
  // marks among them that carry a key the mark did not mint.
  const kept = [...edits.values()].flat().filter((m) => !dropped.has(m.key));
  const added = minted.length;
  const marked = kept.length;
  const shared = kept.filter((m) => m.shared).length;
  return { edited, added, shared, marked, derived, converted, minted };
}

// --- check's documents ------------------------------------------------------

/**
 * The generated-file check on an html host: every mark walked, two states.
 *
 * A document carries no source-hash header, so "the snapshot moved" and "the
 * page was edited" are ONE observation — hence one message naming both fixes
 * rather than two findings that cannot be told apart. The comparison decodes
 * entities and collapses whitespace on the document side first, so an entity
 * spelling or a reindent is never drift.
 *
 * The unmarked-key warn is provable HERE and only here: on this host the mark
 * is the only read, so a key no document carries is genuinely rendered nowhere.
 */
export function checkDocuments(
  cwd: string,
  files: string[],
  descriptor: Descriptor,
  snapshot: Snapshot,
  report: Report,
): void {
  const set = proposeHtml(cwd, files);
  const states: Record<string, { marks: number; status: string }> = {};
  const carried = new Set<string>();

  for (const document of set.documents) {
    const marks = set.claimed.filter((m) => m.document === document);
    const faults = set.skips.filter((s) => s.scope === 'mark' && s.file === document.file);
    let clean = faults.length === 0;
    for (const skip of faults) {
      report.error('config', `${skip.file}:${skip.line} skipped (${skip.reason}) — ${skip.detail}; ${skip.remedy}`);
    }
    for (const mark of marks) {
      carried.add(mark.key);
      if (!Object.hasOwn(descriptor.keys, mark.key)) {
        report.error(
          'config',
          `${document.file}:${mark.line} data-stet="${mark.key}" names no descriptor key — run stet register, or remove the mark`,
          mark.key,
          { at: { file: document.file, line: mark.line } },
        );
        clean = false;
        continue;
      }
      const value = markValue(descriptor, snapshot, mark.key);
      if (typeof value !== 'string' || mark.value === null) continue;
      // The SAME refusal the regenerator would raise, so the hook and the write
      // agree about a value: a `check` that passes what `pull` then rejects is
      // the wedge this rule exists to prevent.
      const declared = tagsOf(descriptor, mark.key);
      if (mark.kind === 'element' && rebuild(document, mark.element, value, declared) === null) {
        const fault = mismatchOf(mark.element, value, declared);
        report.error(
          'config',
          `${document.file}:${mark.line} skipped (tag-count-mismatch) — ${fault.detail}; ${fault.remedy}`,
          mark.key,
        );
        clean = false;
        continue;
      }
      // Compared through the value's read-back form on BOTH sides: a padded or
      // double-spaced snapshot value is what the page will render, so it is not
      // a difference the operator can act on.
      if (Buffer.from(readBack(mark.value), 'utf8').equals(Buffer.from(readBack(value), 'utf8'))) continue;
      report.error(
        'config',
        `${document.file}:${mark.line} ${mark.key} differs from the snapshot — run stet pull to apply the snapshot, ` +
          "or edit the snapshot to keep the page's text",
        mark.key,
        { at: { file: document.file, line: mark.line } },
      );
      clean = false;
    }
    if (clean) report.line(`document: ${document.file} current (${marks.length} marks)`);
    states[document.file] = { marks: marks.length, status: clean ? 'current' : 'differs' };
  }

  for (const key of Object.keys(descriptor.keys).sort()) {
    const def = descriptor.keys[key];
    if (def === undefined || def.target !== DEFAULT_TARGET) continue;
    if (typeof markValue(descriptor, snapshot, key) !== 'string' || carried.has(key)) continue;
    report.warn('config', `${key}: marked in no document`, key);
  }
  report.data('documents', states);
}

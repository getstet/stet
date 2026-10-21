/**
 * The email preview — a declared template rendered with the dashboard's words,
 * each slot value traceable in the markup, and `stet dev`'s mount renderer.
 *
 * Both go through the one render path `email verify` uses: the pointer's
 * request, `containedPointer` before anything is spawned, `renderTemplate`, the
 * runner. What this module adds is the values (a draft over the snapshot or the
 * store's drafts), the sentinels each slot value is wrapped in so a click on
 * rendered text can name the slot that wrote it, and where those sentinels
 * become `data-stet` spans and where they are only removed.
 *
 * Nothing here renders markup itself: the markup is host code's, returned as
 * data for a frame that runs no scripts.
 */

import type { StoreRow } from '../src/resolve.js';
import { resolve } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import type { StoreAdapter } from '../src/store.js';
import type { Descriptor, TemplateDef } from '../src/types.js';
import {
  containedPointer,
  outsideLine,
  pointerRequest,
  renderTemplateAsync,
  sendRequest,
  slotSubject,
  templateProps,
  type RenderFailure,
} from './email-render.js';
import { RCDATA, readDocument, type Document, type Element } from './html-host.js';
import type { CliIo } from './main.js';

/** A slot value's wrapper: private-use code points no template produces. */
const OPEN = '\uE000';
const MID = '\uE001';
const END = '\uE002';

/** A whole run — an index, then a value holding neither an opener nor a closer. */
const RUN = /\uE000(\d+)\uE001([^\uE000\uE002]*)\uE002/g;
/** What is left of a run a template cut short: an opener with its digits, then every stray mid and closer. */
const STRAY = /\uE000\d*\uE001?|[\uE001\uE002]/g;

/** The elements whose text a span would not survive in: foreign content, where an HTML span breaks out of the element. */
const FOREIGN = new Set(['svg', 'math']);

/** The failure a surface answers instead of html. */
export interface PreviewFailure {
  reason: RenderFailure;
  detail: string;
}

export type PreviewReply = { html: string; subject: string; preheader: string } | { failure: PreviewFailure };

/** The checkout a render is about: its folder and the forms the values resolve from. */
export interface PreviewSite {
  path: string;
  descriptor: Descriptor;
  snapshot: Snapshot;
}

/**
 * `text` with every slot run replaced by its value and every sentinel gone.
 * A subject, a preheader and any text a surface shows as plain text comes
 * through here.
 */
export function stripSlotMarks(text: string): string {
  return text.replace(RUN, (_run, _index: string, value: string) => value).replace(STRAY, '');
}

/**
 * The offsets of every text segment a span can sit in: the text of an element
 * that is neither a text-only element (`<title>`, `<textarea>`) nor foreign
 * content, read from `readDocument` over the same markup, so comments, scripts
 * and styles (blanked there) and tags (never a segment) are outside by
 * construction.
 */
function markableSegments(document: Document): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const pending: Array<{ element: Element; skip: boolean }> = document.roots.map((element) => ({ element, skip: false }));
  while (pending.length > 0) {
    const { element, skip } = pending.pop() as { element: Element; skip: boolean };
    const here = skip || RCDATA.has(element.tag) || FOREIGN.has(element.tag);
    for (const part of element.segments) {
      if ('tag' in part) pending.push({ element: part, skip: here });
      else if (!here) spans.push({ start: part.start, end: part.end });
    }
  }
  return spans;
}

/** `value` as an attribute value inside double quotes. */
function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `html` with each marker a template wrote in an encoded spelling put back as
 * the marker: percent-encoded (`encodeURIComponent` in an href) or as a
 * character reference (a template that escapes non-ASCII). Only the three
 * markers are read; any other private-use character is the template's own.
 */
function rawMarkers(html: string): string {
  const marker = (at: string): string => [OPEN, MID, END][Number(at)] as string;
  return html
    .replace(/&#[xX][eE]00([0-2]);/g, (_ref, at: string) => marker(at))
    .replace(/&#5734([4-6]);/g, (_ref, at: string) => marker(String(Number(at) - 4)))
    .replace(/%[eE][eE]%80%8([0-2])/g, (_ref, at: string) => marker(at));
}

/**
 * The rendered markup with each slot run that sits in a text segment turned
 * into `<span data-stet="<key>"><value></span>`; every other run — in a tag, in
 * `<title>`, in a region the tokenizer blanks (`<style>`, `<script>`, a
 * comment), in markup it reports as a fault, across an element boundary, or
 * naming no slot — loses its sentinels and keeps its value.
 *
 * The spans come from `readDocument('email', html)`, never from walking the
 * markup by hand: one tokenizer decides what is text for the corpus, the
 * dashboard and the CLI alike.
 */
export function markSlots(rendered: string, slotKeys: string[]): string {
  const html = rawMarkers(rendered);
  if (!html.includes(OPEN)) return html;
  const document = readDocument('email', html);
  const segments = markableSegments(document);
  const marked = html.replace(RUN, (whole: string, index: string, value: string, at: number): string => {
    const key = slotKeys[Number(index)];
    const end = at + whole.length;
    const segment = segments.find((span) => span.start <= at && end <= span.end);
    if (key === undefined || segment === undefined) return value;
    const blanked = document.blanked.slice(at, end).includes('\0');
    const faulted = document.faults.some((fault) => fault.offset < end && at < fault.until);
    if (blanked || faulted || inStrayTag(document.blanked, segment, at, end)) return value;
    return `<span data-stet="${attribute(key)}">${value}</span>`;
  });
  return marked.replace(STRAY, '');
}

/**
 * Whether a run the tokenizer calls text sits inside a tag it could not read —
 * `<a href="x"class="…">`, with no space between attributes, is text to it.
 * A `<` opening a tag with no `>` before the run, or a `>` before any `<` after
 * it, means the run is inside markup: a span there would break the tag.
 */
function inStrayTag(blanked: string, segment: { start: number; end: number }, at: number, end: number): boolean {
  const before = blanked.slice(segment.start, at);
  const opened = Math.max(before.lastIndexOf('<'), -1);
  if (opened !== -1 && /[A-Za-z/!?]/.test(before.charAt(opened + 1)) && !before.includes('>', opened)) return true;
  const after = blanked.slice(end, segment.end);
  const next = after.search(/[<>]/);
  return next !== -1 && after.charAt(next) === '>';
}

/** One slot key's value: the request's draft where it holds one (own, never inherited), else what the forms or the store resolve. */
type ValueOf = (key: string) => unknown;

/** The slot keys of a template, in slot order. */
const slotKeysOf = (name: string, entry: TemplateDef): string[] => entry.slots.map((slot) => `${name}__${slot}`);

/**
 * The store's preview rows for a template's slot keys, or the store's own
 * message when it did not answer. A site with no store has no rows.
 */
async function previewRows(store: StoreAdapter | null, keys: string[]): Promise<StoreRow[] | null | { down: string }> {
  if (store === null) return null;
  const answer = await store.read({ keys, preview: true });
  if (Array.isArray(answer)) return answer;
  return { down: (answer as { message?: string }).message ?? 'unreachable' };
}

function isDown(rows: StoreRow[] | null | { down: string }): rows is { down: string } {
  return rows !== null && !Array.isArray(rows);
}

/** The email a runner result holds: a string is the html, a map's `html` member is; `subject` is a map's, where it has one. */
function readResult(result: string): { html: string | null; subject: string | undefined } {
  const parsed = JSON.parse(result) as string | Record<string, unknown>;
  if (typeof parsed === 'string') return { html: parsed, subject: undefined };
  const { html, subject } = parsed;
  return { html: typeof html === 'string' ? html : null, subject: typeof subject === 'string' ? subject : undefined };
}

/** The values a template's slots resolve to, in the default locale unless told otherwise. */
function resolver(site: PreviewSite, rows: StoreRow[] | null, locale: string, preview: boolean): ValueOf {
  return (key) => resolve(site.descriptor, site.snapshot, rows, { key, locale, preview }).value;
}

/**
 * One template rendered with the request's drafts over what the site resolves.
 *
 * In order: the pointer must exist and lie inside the project (before the store
 * is read and before anything is spawned), then the values, then the render
 * with every slot value wrapped in its sentinels. `store` is the selected
 * environment's adapter on a store-backed site and null on a snapshot-only one.
 * The render is asynchronous, so a template that hangs holds this request and
 * no other route of the dev server; `deadlineMs` shortens its deadline for a fixture.
 */
export async function renderPreview(
  io: CliIo,
  site: PreviewSite,
  store: StoreAdapter | null,
  request: { template: string; locale: string; drafts: Map<string, unknown> },
  deadlineMs?: number,
): Promise<PreviewReply> {
  const { template: name, locale, drafts } = request;
  const entry = site.descriptor.templates?.[name] as TemplateDef;
  const pointer = entry.render;
  const probe = pointerRequest(site.path, site.descriptor, name, {});
  if (pointer === undefined || probe === null) {
    return { failure: { reason: 'not-renderable', detail: `${name} has no render pointer — declare one, or render it through the host` } };
  }
  const outside = containedPointer(site.path, pointer);
  if (outside !== null) return { failure: { reason: 'not-renderable', detail: outsideLine(outside) } };

  const keys = slotKeysOf(name, entry);
  const rows = await previewRows(store, keys);
  if (isDown(rows)) {
    return { failure: { reason: 'not-renderable', detail: `the store did not answer: ${rows.down} — nothing was rendered` } };
  }
  const resolved = resolver(site, rows, locale, store !== null);
  const props = templateProps(name, entry, (key) => (drafts.has(key) ? drafts.get(key) : resolved(key)));
  if ('missing' in props) return { failure: { reason: 'not-renderable', detail: `${name}: ${props.missing}` } };

  const wrapped = { ...props.values };
  keys.forEach((key, index) => {
    wrapped[key] = `${OPEN}${index}${MID}${String(props.values[key])}${END}`;
  });
  const rendered = await renderTemplateAsync(io, { ...probe, props: wrapped }, deadlineMs);
  if (!rendered.ok) return { failure: { reason: rendered.reason, detail: rendered.detail } };

  const { html, subject: mapSubject } = readResult(rendered.result);
  if (html === null) {
    return { failure: { reason: 'not-renderable', detail: `${name} renders a map with no html member — the email is its html` } };
  }
  const slotValue = (slot: string): string => (entry.slots.includes(slot) ? String(props.values[`${name}__${slot}`]) : '');
  return {
    html: markSlots(html, keys),
    subject: mapSubject === undefined ? slotValue('subject') : stripSlotMarks(mapSubject),
    preheader: slotValue('preheader'),
  };
}

/** The mount's `renderEmail`, for a host that wires none. */
export type MountRenderer = (template: string, opts?: { version?: number; override?: Record<string, unknown> }) => Promise<string>;

/** The last render a request made, which the same request's test send re-renders with the send attached. */
export interface LastRender {
  current: { template: string; props: Record<string, unknown>; subject: string | null } | null;
}

/**
 * `stet dev`'s `renderEmail` for the mounted API: the template rendered through
 * its pointer with the store's preview values, `opts.override` laid over them
 * key by key. Every failure rejects with a sentence, which the mount's routes
 * answer as the error it is. A successful render is recorded in `last`, for the
 * request's `mountSender`.
 *
 * It exists only in `stet dev`: `createStetHandler` carries no compiler and no
 * child process, and a production host wires its own.
 */
export function mountRenderer(
  io: CliIo,
  site: PreviewSite,
  store: StoreAdapter,
  last: LastRender = { current: null },
  deadlineMs?: number,
): MountRenderer {
  return async (name, opts = {}) => {
    if (opts.version !== undefined) throw new Error("render by version needs the host's renderEmail");
    // `pointerRequest` answers null for a name the descriptor does not own, `constructor` among them.
    const entry = site.descriptor.templates?.[name];
    const probe = pointerRequest(site.path, site.descriptor, name, {});
    if (entry?.render === undefined || probe === null) {
      throw new Error(`${name} has no render pointer — declare one, or render it through the host`);
    }
    const outside = containedPointer(site.path, entry.render);
    if (outside !== null) throw new Error(outsideLine(outside));

    const rows = await previewRows(store, slotKeysOf(name, entry));
    if (isDown(rows)) throw new Error(`the store did not answer: ${rows.down}`);
    const resolved = resolver(site, rows, 'default', true);
    const override = opts.override ?? {};
    const valueOf = (key: string): unknown => (Object.hasOwn(override, key) ? override[key] : resolved(key));
    const props = templateProps(name, entry, valueOf);
    if ('missing' in props) throw new Error(props.missing);

    const rendered = await renderTemplateAsync(io, { ...probe, props: props.values }, deadlineMs);
    if (!rendered.ok) throw new Error(`${rendered.reason}: ${rendered.detail}`);
    const { html } = readResult(rendered.result);
    if (html === null) throw new Error(`not-renderable: ${name} renders a map with no html member — the email is its html`);
    last.current = { template: name, props: props.values, subject: slotSubject(name, entry, site.descriptor, props.values, valueOf) };
    return html;
  };
}

/** The mount's `sendTest`, for a host that wires none. */
export type MountSender = (html: string, to: string) => Promise<void>;

/**
 * `stet dev`'s `sendTest` for the mounted API, over the host function
 * `emailSend` names. It sends what the same request's `mountRenderer` last
 * rendered: the template is rendered again in the child that calls the host's
 * function, so the function receives the markup after the frame and the fill —
 * the one `stet email test` hands it — and `html` is not what is sent. The
 * send file lies inside the project, as the pointer's files do; a failure
 * rejects with a sentence, which the mount answers as the error it is.
 */
export function mountSender(
  io: CliIo,
  site: PreviewSite,
  send: { file: string; export: string },
  last: LastRender,
  deadlineMs?: number,
): MountSender {
  return async (_html, to) => {
    const sent = last.current;
    if (sent === null) throw new Error('nothing was rendered to send');
    const probe = pointerRequest(site.path, site.descriptor, sent.template, {});
    const pointer = site.descriptor.templates?.[sent.template]?.render;
    if (probe === null || pointer === undefined) {
      throw new Error(`${sent.template} has no render pointer — declare one, or render it through the host`);
    }
    const outside = containedPointer(site.path, pointer, send);
    if (outside !== null) throw new Error(outsideLine(outside));

    const rendered = await renderTemplateAsync(io, sendRequest(probe, sent.props, sent.template, sent.subject, { ...send, to }), deadlineMs);
    if (!rendered.ok) throw new Error(rendered.reason === 'send-failed' ? rendered.detail : `${rendered.reason}: ${rendered.detail}`);
  };
}

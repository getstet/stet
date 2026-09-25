/**
 * The preview agent (`templates/preview-agent.js`) inside a framed page, under
 * jsdom: an outer window at the dashboard's origin frames a document, the
 * agent is added to it the way `stet dev` serves it, and messages reach it as
 * the dashboard would send them — from the framing window, at the dashboard's
 * origin. jsdom lays nothing out, so the frame gets a stand-in layout: every
 * element in the body has a box 20 px high, 40 px below the one before it in
 * document order, starting at 1000; an element under `hidden`, an inline
 * `display: none` or a closed <details> (outside its summary) has none. The
 * frame's `scrollTo` is recorded. `tests/preview-agent.test.ts` and the
 * conformance walk's `dashboard` section both frame pages through here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';

import { packageRoot } from '../../cli/installed.js';

export const AGENT = readFileSync(join(packageRoot(), 'templates', 'preview-agent.js'), 'utf8');
export const DASHBOARD = 'http://127.0.0.1:4400';
export const SOLID = '2px solid hsl(38 92% 50%)';
export const DASHED = '2px dashed hsl(38 92% 50%)';

export type Message = Record<string, unknown>;

export interface Framed {
  win: Window & typeof globalThis;
  doc: Document;
  /** What the agent posted to the dashboard window, in order. */
  sent: Message[];
  /** Every `scrollTo` call on the frame's window. */
  scrolls: Array<{ top: number; behavior: unknown }>;
  send(data: unknown, origin?: string, source?: unknown): void;
  locate(request: Message): Promise<Message | undefined>;
  close(): void;
}

const open: Framed[] = [];
/** Closes every frame opened since the last call; a test file runs it after each case. */
export function closeFrames(): void {
  for (const framed of open.splice(0)) framed.close();
}

export const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the stand-in layout gives `el` no box. */
function unrendered(el: Element): boolean {
  if (!el.ownerDocument.body.contains(el)) return true;
  for (let at: Element | null = el; at !== null; at = at.parentElement) {
    if (at.hasAttribute('hidden') || /display:\s*none/.test(at.getAttribute('style') ?? '')) return true;
    const details = at.parentElement;
    if (details?.tagName === 'DETAILS' && !details.hasAttribute('open') && at.tagName !== 'SUMMARY') return true;
  }
  return false;
}

/** The stand-in box: 20 px high, 40 px apart in document order from 1000, none when unrendered. */
export function boxOf(el: Element): DOMRect {
  if (unrendered(el)) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect;
  const top = 1000 + 40 * [...el.ownerDocument.body.querySelectorAll('*')].indexOf(el);
  return { top, bottom: top + 20, left: 0, right: 200, width: 200, height: 20, x: 0, y: top } as DOMRect;
}

/** Where the agent scrolls the frame's window to centre `el`: jsdom's window is 768 px high. */
export const centred = (el: Element): { top: number; behavior: string } => ({ top: boxOf(el).top - (768 - 20) / 2, behavior: 'instant' });

/**
 * A framed page holding `body`, the agent added with the dashboard's origin
 * and, unless null, channel `c1`; `agent` is the script's text, the shipped
 * template's by default.
 */
export async function frame(body: string, channel: string | null = 'c1', head = '', agent = AGENT): Promise<Framed> {
  const outer = new JSDOM('<!DOCTYPE html><iframe></iframe>', { url: `${DASHBOARD}/`, runScripts: 'dangerously' });
  const iframe = outer.window.document.querySelector('iframe') as HTMLIFrameElement;
  const win = iframe.contentWindow as Window & typeof globalThis;
  const doc = win.document;
  doc.head.innerHTML = head;
  doc.body.innerHTML = body;
  const sent: Message[] = [];
  outer.window.addEventListener('message', (event) => sent.push(event.data as Message));
  const scrolls: Array<{ top: number; behavior: unknown }> = [];
  win.scrollTo = ((options: { top: number; behavior: unknown }) => {
    scrolls.push({ top: options.top, behavior: options.behavior });
  }) as typeof win.scrollTo;
  const proto = win.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
    getClientRects: () => DOMRect[];
  };
  proto.getBoundingClientRect = function (this: Element) {
    return boxOf(this);
  };
  proto.getClientRects = function (this: Element) {
    return unrendered(this) ? [] : [boxOf(this)];
  };
  const script = doc.createElement('script');
  script.setAttribute('data-parent', DASHBOARD);
  if (channel !== null) script.setAttribute('data-channel', channel);
  script.textContent = agent;
  doc.head.appendChild(script);
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));
  await tick();
  const send = (data: unknown, origin = DASHBOARD, source: unknown = outer.window): void => {
    win.dispatchEvent(new win.MessageEvent('message', { data, origin, source: source as Window }));
  };
  let seq = 0;
  const framed: Framed = {
    win,
    doc,
    sent,
    scrolls,
    send,
    async locate(request) {
      seq += 1;
      const before = sent.length;
      send({ stet: 'locate', seq, texts: [], draft: null, scroll: false, ...request });
      await tick();
      return sent.slice(before).find((m) => m['stet'] === 'located');
    },
    close: () => outer.window.close(),
  };
  open.push(framed);
  return framed;
}

export const located = (framed: Framed): Message[] => framed.sent.filter((m) => m['stet'] === 'located');

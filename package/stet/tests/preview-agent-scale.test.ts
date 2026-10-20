/**
 * The census at scale (D7): the shipped agent, run in a `node:vm` context over
 * a stand-in DOM of plain objects — no jsdom, whose own tree walk would be
 * what this measured — answers a census of 1,000 keys over a page of 32,000
 * elements, three times in a row, each under 100 ms. The page is
 * `v9-census-scale.mjs`'s shape: rows of a label, an action and a cell, with
 * one key's text in every 97th cell, a `{{name}}` key every tenth key, and a
 * key's text inside a longer cell every 50th row.
 */
import { runInNewContext } from 'node:vm';

import { expect, it } from 'vitest';

import { AGENT, DASHBOARD } from './helpers/preview-frame.js';

type Message = Record<string, unknown>;

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
}

/** One simple selector as a test: `*`, a tag, `[attr]`, `[attr="value"]` or a tag with one attribute test. */
function selector(text: string): (el: FakeElement) => boolean {
  if (text === '*') return () => true;
  const m = /^([a-z0-9]*)(?:\[([\w:-]+)(?:="([^"]*)")?\])?$/.exec(text);
  if (m === null) throw new Error(`the stand-in DOM reads no selector ${text}`);
  const [, tag, attr, value] = m;
  const upper = tag ? tag.toUpperCase() : null;
  return (el) => {
    if (upper !== null && el.tagName !== upper) return false;
    if (attr === undefined) return true;
    const held = el.getAttribute(attr);
    return value === undefined ? held !== null : held === value;
  };
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  childNodes: Array<FakeElement | FakeText> = [];
  parentNode: FakeElement | null = null;
  private attrs = new Map<string, string>();
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  get firstElementChild(): FakeElement | null {
    return (this.childNodes.find((c) => c.nodeType === 1) as FakeElement | undefined) ?? null;
  }
  get attributes(): Array<{ name: string; value: string }> {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get textContent(): string {
    return this.childNodes.map((c) => (c.nodeType === 3 ? (c as FakeText).data : (c as FakeElement).textContent)).join('');
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  append(...children: Array<FakeElement | FakeText>): this {
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }
  contains(other: FakeElement | FakeText | null): boolean {
    for (let at = other; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  /** Every descendant in document order. */
  descendants(): Array<FakeElement | FakeText> {
    const out: Array<FakeElement | FakeText> = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.childNodes) {
        out.push(child);
        if (child.nodeType === 1) walk(child as FakeElement);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(selectors: string): FakeElement[] {
    const tests = selectors.split(',').map((s) => selector(s.trim()));
    return this.descendants().filter((n): n is FakeElement => n.nodeType === 1 && tests.some((test) => test(n as FakeElement)));
  }
  querySelector(selectors: string): FakeElement | null {
    return this.querySelectorAll(selectors)[0] ?? null;
  }
}

const KEYS = 1000;
const ELEMENTS = 32_000;

/** 1,000 keys: every tenth a `{{name}}` text. */
const keys = Array.from({ length: KEYS }, (_, i) => ({
  key: `k_${i}`,
  texts: [i % 10 === 0 ? `Hello {{name}}, item ${i} is ready` : `Key number ${i} says something useful here`],
}));

/** 8,000 rows of four elements each: the row and its three cells. */
function page(): { root: FakeElement; head: FakeElement; body: FakeElement } {
  const root = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  root.append(head, body);
  for (let i = 0; i < ELEMENTS / 4; i += 1) {
    const cell =
      i % 97 === 0
        ? `Key number ${(i % KEYS) | 1} says something useful here`
        : i % 50 === 0
          ? `Note: Key number ${(i % KEYS) | 1} says something useful here, today.`
          : `x${i}`;
    body.append(
      new FakeElement('div').append(
        new FakeElement('span').append(new FakeText(`Row ${i} label`)),
        new FakeElement('button').append(new FakeText(`Open ${i}`)),
        new FakeElement('span').append(new FakeText(cell)),
      ),
    );
  }
  body.append(new FakeElement('p').append(new FakeText('Hello Maya, item 10 is ready')));
  return { root, head, body };
}

/** The agent in a context of its own, the stand-in page as its document; `census` posts one census and times it. */
function agentOn(dom: { root: FakeElement; head: FakeElement; body: FakeElement }): { census: () => { ms: number; reply: Message } } {
  const sent: Message[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const parent = { postMessage: (message: Message) => sent.push(message) };
  const script = new FakeElement('script', { 'data-parent': DASHBOARD, 'data-channel': 'c1' });
  const document = {
    currentScript: script,
    readyState: 'complete',
    documentElement: dom.root,
    head: dom.head,
    body: dom.body,
    title: '',
    addEventListener: () => {},
    querySelectorAll: (s: string) => dom.root.querySelectorAll(s),
    querySelector: (s: string) => dom.root.querySelector(s),
    createTreeWalker: (root: FakeElement) => {
      const texts = root.descendants().filter((n) => n.nodeType === 3);
      let at = -1;
      return { nextNode: () => texts[(at += 1)] ?? null };
    },
  };
  const context: Record<string, unknown> = {
    document,
    location: { pathname: '/scale', search: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    },
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    parent,
  };
  context['window'] = context;
  runInNewContext(AGENT, context);
  expect(sent.map((m) => m['stet'])).toEqual(['ready']);
  return {
    census: () => {
      const before = sent.length;
      const started = performance.now();
      for (const fn of listeners.get('message') ?? []) fn({ source: parent, origin: DASHBOARD, data: { stet: 'census', keys } });
      const ms = performance.now() - started;
      return { ms, reply: sent.slice(before).find((m) => m['stet'] === 'census') as Message };
    },
  };
}

it('answers a census of 1,000 keys over 32,000 elements three times in a row, each under 100 ms', () => {
  const dom = page();
  expect(dom.body.querySelectorAll('*')).toHaveLength(ELEMENTS + 1);
  const agent = agentOn(dom);
  const passes = [agent.census(), agent.census(), agent.census()];
  const found = passes[0]?.reply['found'] as Record<string, number>;
  // Whole cells, cells holding a key's text inside more text, and the {{name}} key, each counted once per element.
  const rows = Array.from({ length: ELEMENTS / 4 }, (_, i) => i);
  expect(found['k_1']).toBe(rows.filter((i) => (i % 97 === 0 || i % 50 === 0) && ((i % KEYS) | 1) === 1).length);
  expect(found['k_10']).toBe(1);
  expect(Object.keys(found).length).toBeGreaterThan(80);
  for (const pass of passes) expect(pass.reply).toEqual(passes[0]?.reply);
  console.info(`census scale: ${passes.map((p) => p.ms.toFixed(1)).join(' / ')} ms (1,000 keys, ${ELEMENTS} elements)`);
  for (const pass of passes) expect(pass.ms).toBeLessThan(100);
});

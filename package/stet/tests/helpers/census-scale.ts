/**
 * The census at scale, as a fixture: the shipped agent run in a `node:vm`
 * context over a stand-in DOM of plain objects — no jsdom, whose own tree walk
 * would be what a measurement took — answering a census of 1,000 keys over a
 * page of 32,000 elements. The page is `v9-census-scale.mjs`'s shape: rows of a
 * label, an action and a cell, with one key's text in every 97th cell, a
 * `{{name}}` key every tenth key, and a key's text inside a longer cell every
 * 50th row. The stand-in counts every read of the page it serves, so a case can
 * bound the work as well as the time.
 *
 * Consumers: `tests/preview-agent-scale.test.ts` and the conformance walk's
 * `preview-editing` section.
 */
import { runInNewContext } from 'node:vm';

import { expect } from 'vitest';

import { AGENT, DASHBOARD } from './preview-frame.js';

type Message = Record<string, unknown>;

/** Reads of the stand-in page since the last reset: a text's data, an attribute, a tag's text. */
export const reads = { count: 0 };

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  private held: string;
  constructor(data: string) {
    this.held = data;
  }
  get data(): string {
    reads.count += 1;
    return this.held;
  }
  set data(value: string) {
    this.held = value;
  }
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
    reads.count += 1;
    return this.childNodes.map((c) => (c.nodeType === 3 ? (c as FakeText).data : (c as FakeElement).textContent)).join('');
  }
  getAttribute(name: string): string | null {
    reads.count += 1;
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    reads.count += 1;
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

export const KEYS = 1000;
export const ELEMENTS = 32_000;

/** 1,000 keys: every tenth a `{{name}}` text. */
export const keys = Array.from({ length: KEYS }, (_, i) => ({
  key: `k_${i}`,
  texts: [i % 10 === 0 ? `Hello {{name}}, item ${i} is ready` : `Key number ${i} says something useful here`],
}));

/** 8,000 rows of four elements each: the row and its three cells. */
export function page(): { root: FakeElement; head: FakeElement; body: FakeElement } {
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
export function agentOn(dom: { root: FakeElement; head: FakeElement; body: FakeElement }): {
  census: () => { ms: number; reads: number; reply: Message };
} {
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
      reads.count = 0;
      const started = performance.now();
      for (const fn of listeners.get('message') ?? []) fn({ source: parent, origin: DASHBOARD, data: { stet: 'census', keys } });
      const ms = performance.now() - started;
      return {
        ms,
        reads: reads.count,
        reply: sent.slice(before).find((m) => m['stet'] === 'census') as Message,
      };
    },
  };
}


export type Pass = ReturnType<ReturnType<typeof agentOn>['census']>;

/** Three consecutive censuses of 1,000 keys over the 32,000-element page, the first of them cold. */
export function censusPasses(): Pass[] {
  const agent = agentOn(page());
  return [agent.census(), agent.census(), agent.census()];
}

/** The spec's figure for one pass on a quiet machine. */
export const PASS_MS = 100;
/** What a pass may take on a loaded one: a stall (the earlier matcher's 3.3 s) stays far above it. */
export const CEILING_MS = 300;
/** Reads of the page per element a linear census makes (12.5 measured at 1,000 keys), with room for 1.5x on the walk; a scan of every key over every element reads thousands of times more. */
export const READS_PER_ELEMENT = 14;

/**
 * The census-at-scale bounds. The work is counted, which the machine's load
 * cannot change; the fastest pass keeps the spec's 100 ms, since a pass that
 * was descheduled says nothing about the matcher; and no pass reaches the ceiling.
 */
export function expectCensusScale(passes: Pass[]): void {
  expect(passes).toHaveLength(3);
  for (const pass of passes) {
    expect(pass.reads).toBeLessThan(READS_PER_ELEMENT * ELEMENTS);
    expect(pass.ms).toBeLessThan(CEILING_MS);
    expect(pass.reply).toEqual(passes[0]?.reply);
  }
  expect(Math.min(...passes.map((p) => p.ms))).toBeLessThan(PASS_MS);
}

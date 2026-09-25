/**
 * The dashboard under test: its handler over a workspace, a request at its own
 * origin, and the real page booted in jsdom. `tests/dev.test.ts` and the
 * conformance walk's `dashboard` section both drive the dashboard through here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JSDOM, VirtualConsole } from 'jsdom';
import { expect } from 'vitest';

import { createDevHandler, type DevContext } from '../../cli/dev-routes.js';
import { dashboardPage } from '../../cli/dev.js';
import { addSite } from '../../cli/workspace.js';

export const TOKEN = 'dev-run-token';

/** A handler over a workspace holding the given checkouts, with a page of known text. */
export function handlerOver(
  paths: string[],
  over: Partial<DevContext> = {},
): {
  handler: (req: Request) => Promise<Response>;
  ctx: DevContext;
  file: string;
  origin: string;
} {
  const file = join(mkdtempSync(join(tmpdir(), 'stet-ws-')), 'projects.json');
  for (const path of paths) addSite(file, path);
  const origin = 'http://127.0.0.1:4400';
  const ctx: DevContext = {
    token: TOKEN,
    origin,
    workspaceFile: file,
    io: { cwd: mkdtempSync(join(tmpdir(), 'stet-dev-')), env: {}, stdout: () => {}, stderr: () => {} },
    page: '<style nonce="__STET_NONCE__"></style><script nonce="__STET_NONCE__"></script>',
    fetchImpl: globalThis.fetch,
    children: new Map(),
    stores: new Map(),
    queues: new Map(),
    ...over,
  };
  return { handler: createDevHandler(ctx), ctx, file, origin };
}

/** A request at the dashboard's own origin, with the run token unless told otherwise. */
export function req(
  path: string,
  init: { method?: string; token?: string | null; host?: string | null; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.host !== null) headers['host'] = init.host ?? '127.0.0.1:4400';
  if (init.token !== null) headers['authorization'] = `Bearer ${init.token ?? TOKEN}`;
  const method = init.method ?? 'GET';
  return new Request(`http://127.0.0.1:4400${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** The nonce the page is booted with when the caller hands over no page of its own. */
export const NONCE = 'test-nonce';

/** A booted page and the ways a case drives it. */
export interface PaintedPage {
  dom: JSDOM;
  errors: string[];
  /** Every request the page made, in order, with the body it sent. */
  sent: Array<{ path: string; body: unknown }>;
  /** The paths of every request sent so far whose path starts with `prefix`. */
  requested(prefix: string): string[];
  /** This page's local storage, as a map a second page can be seeded with. */
  storage(): Record<string, string>;
  /** Clicks the one control carrying this `data-act`, then lets the page settle. */
  act(name: string): Promise<void>;
  /** Sets a `data-act-change` select and fires the event the page listens for. */
  change(name: string, value: string): Promise<void>;
  /** Types into a `data-act-input` field and fires the event the page listens for. */
  type(name: string, value: string): Promise<void>;
  /** The same, with the field focused and the caret where a real keystroke would leave it. */
  typeAt(name: string, value: string, at: number): Promise<void>;
  /** The keys the list is showing right now. */
  keys(): string[];
  settle(): Promise<void>;
  html(): string;
  toast(): string;
}

/**
 * The real page, booted in jsdom, its every request answered by `serve`. The
 * token rides the address bar exactly as the terminal's link delivers it, and
 * a request that does not carry it back is answered 401 before `serve` sees it.
 */
export async function paintPage(opts: {
  /** One request's answer, by its path (query included) and the body it sent. */
  serve: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  /** The page's text, its nonce filled; the shipped page with `NONCE` by default. */
  html?: string;
  token?: string;
  expects?: string;
  /** The query after `/`; `?t=<token>` by default. */
  url?: string;
  /** Local and session storage as a page before this one left them. */
  storage?: Record<string, string>;
  session?: Record<string, string>;
  /** Run on the page's window before its script, after the storage is seeded. */
  prepare?: (window: JSDOM['window']) => void;
}): Promise<PaintedPage> {
  const sent: Array<{ path: string; body: unknown }> = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(`${error.name}: ${error.message}`));
  virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));

  const token = opts.token ?? 'fixture-token';
  const accepted = opts.expects ?? token;
  const dom = new JSDOM(opts.html ?? dashboardPage().split('__STET_NONCE__').join(NONCE), {
    url: `http://127.0.0.1:4400/${opts.url ?? (token === '' ? '' : `?t=${token}`)}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      for (const [name, value] of Object.entries(opts.storage ?? {})) window.localStorage.setItem(name, value);
      for (const [name, value] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(name, value);
      opts.prepare?.(window);
      (window as unknown as { fetch: unknown }).fetch = async (
        path: string,
        init?: { headers?: Record<string, string>; body?: string },
      ) => {
        // Every request must carry the run token: a stub that answered
        // without it would hide a broken header.
        if (init?.headers?.['authorization'] !== `Bearer ${accepted}`) {
          return { status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) };
        }
        const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
        sent.push({ path: String(path), body });
        const answer = await opts.serve(String(path), body);
        // A fresh copy per answer, as a real reply is: the page must not hold
        // a reference into the fixture's own tables.
        return {
          status: answer.status,
          ok: answer.status < 400,
          json: async () => JSON.parse(JSON.stringify(answer.body)) as unknown,
        };
      };
    },
  });

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();

  const painted: PaintedPage = {
    dom,
    errors,
    sent,
    requested: (prefix: string) => sent.map((r) => r.path).filter((path) => path.startsWith(prefix)),
    storage(): Record<string, string> {
      const held = dom.window.localStorage;
      const out: Record<string, string> = {};
      for (let i = 0; i < held.length; i += 1) {
        const name = held.key(i) as string;
        out[name] = held.getItem(name) as string;
      }
      return out;
    },
    settle,
    html: () => dom.window.document.body.outerHTML,
    toast: () => dom.window.document.getElementById('tst')?.textContent ?? '',
    async change(name: string, value: string): Promise<void> {
      const el = dom.window.document.querySelector(`[data-act-change="${name}"]`) as HTMLSelectElement | null;
      expect(el, `no control carries data-act-change="${name}"`).not.toBeNull();
      (el as HTMLSelectElement).value = value;
      (el as HTMLSelectElement).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await settle();
      expect(errors, `after ${name}=${value}`).toEqual([]);
    },
    async type(name: string, value: string): Promise<void> {
      const el = dom.window.document.querySelector(`[data-act-input="${name}"]`) as HTMLTextAreaElement | null;
      expect(el, `no control carries data-act-input="${name}"`).not.toBeNull();
      (el as HTMLTextAreaElement).value = value;
      (el as HTMLTextAreaElement).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await settle();
      expect(errors, `after typing into ${name}`).toEqual([]);
    },
    async typeAt(name: string, value: string, at: number): Promise<void> {
      const el = dom.window.document.querySelector(`[data-act-input="${name}"]`) as HTMLTextAreaElement | null;
      expect(el, `no control carries data-act-input="${name}"`).not.toBeNull();
      const field = el as HTMLTextAreaElement;
      field.focus();
      field.value = value;
      field.selectionStart = at;
      field.selectionEnd = at;
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await settle();
      expect(errors, `after typing into ${name}`).toEqual([]);
    },
    keys(): string[] {
      return [...dom.window.document.querySelectorAll('[data-act^="key:"]')].map(
        (el) => (el.getAttribute('data-act') ?? '').slice('key:'.length),
      );
    },
    async act(name: string): Promise<void> {
      const el = dom.window.document.querySelector(`[data-act="${name}"]`);
      expect(el, `no control carries data-act="${name}"`).not.toBeNull();
      (el as HTMLElement).click();
      await settle();
      // A loader's own failure is swallowed by the page's guard and shown as
      // a toast, so the toast is read as an error channel here.
      expect(painted.toast(), `after ${name}`).not.toMatch(/is not defined|is not a function/);
      expect(errors, `after ${name}`).toEqual([]);
    },
  };
  return painted;
}

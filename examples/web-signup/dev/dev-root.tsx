'use client';

import * as React from 'react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CopyProvider } from '@getstet/stet/react';
import type { Descriptor } from '@getstet/stet';

import flows from '@/stet.flows.json';
import { ACCOUNTS, FIXTURES } from '@/dev/fixtures';
import { setOutcomes } from '@/lib/api';
import { setScreenSeeds } from '@/lib/screen-seed';
import { signIn, signOut } from '@/lib/session';
import { THEME_STYLE_ID, baseTokens, flattenTokens, themeCss, type TokenTree } from '@/lib/theme';

// Development builds only (the root layout imports this behind a NODE_ENV
// check). Three things stet's Flows map drives:
//  - `?stet-state=<pointId>&appearance=dark&textScale=1.2` opens a point: the
//    recipe's account and fixture are loaded, the overrides applied, and the
//    route replaced with the recipe's screen.
//  - `stet:draft` / `stet:draft-clear` messages from the parent frame show a
//    copy draft in place of a key's value, and take it back.
//  - `stet:tokens` messages restyle the app with token overrides.
// `window.__stet` answers the capture script: the point's status and which
// component read which key.

interface Recipe {
  screen: string;
  stack: string[];
  account?: string;
  fixture?: string;
}

interface Request {
  point: string;
  appearance: 'light' | 'dark' | null;
  textScale: number;
  signature: string;
}

type Status = 'ready' | 'point-not-found' | 'failed';

const POINTS = flows.points as Record<string, Recipe>;

let applied: { signature: string; status: Status; reason?: string } | null = null;

function readRequest(): Request | null {
  const params = new URLSearchParams(window.location.search);
  const point = params.get('stet-state');
  if (point === null || point === '') return null;
  const appearance = params.get('appearance');
  const scale = Number(params.get('textScale') ?? '1');
  return {
    point,
    appearance: appearance === 'dark' || appearance === 'light' ? appearance : null,
    textScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    signature: `${point}|${appearance}|${scale}`,
  };
}

/** Load a point's recipe into the app: variations, account, fixture. Runs before the screen renders. */
function applyRequest(request: Request) {
  if (applied?.signature === request.signature) return;
  const root = document.documentElement;
  if (request.appearance === null) delete root.dataset.appearance;
  else root.dataset.appearance = request.appearance;
  root.style.setProperty('--text-scale', String(request.textScale));
  const recipe = POINTS[request.point];
  if (recipe === undefined) {
    applied = { signature: request.signature, status: 'point-not-found' };
    return;
  }
  const account = recipe.account === undefined ? null : ACCOUNTS[recipe.account];
  const fixture = recipe.fixture === undefined ? {} : FIXTURES[recipe.fixture];
  if (account === undefined || fixture === undefined) {
    applied = { signature: request.signature, status: 'failed', reason: `unknown ${account === undefined ? `account "${recipe.account}"` : `fixture "${recipe.fixture}"`}` };
    return;
  }
  if (account === null) signOut();
  else signIn(structuredClone(account));
  setOutcomes(fixture.outcomes ?? {});
  setScreenSeeds(fixture.seeds ?? {});
  applied = { signature: request.signature, status: 'ready' };
}

/** A token override as a tree: dot paths (`color.primary`) and nested objects both accepted. */
function asTree(tokens: Record<string, unknown>): TokenTree {
  const tree: TokenTree = {};
  const flat = flattenTokens(tokens as TokenTree);
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let at = tree;
    for (const part of parts.slice(0, -1)) {
      if (typeof at[part] !== 'object') at[part] = {};
      at = at[part] as TokenTree;
    }
    at[parts[parts.length - 1]] = value;
  }
  return tree;
}

function merge(base: TokenTree, over: TokenTree): TokenTree {
  const out: TokenTree = { ...base };
  for (const [name, value] of Object.entries(over)) {
    const current = out[name];
    out[name] = typeof value === 'object' && typeof current === 'object' ? merge(current, value) : value;
  }
  return out;
}

function applyTokens(tokens: Record<string, unknown> | null) {
  const style = document.getElementById(THEME_STYLE_ID);
  if (style === null) return;
  style.textContent = themeCss(tokens === null ? baseTokens : merge(baseTokens, asTree(tokens)));
}

// Which rendering component read which key, from React's development-only
// owner: the capture script narrows a text match to the elements those
// components created.
type Fiber = object;
const reads = new Map<string, Set<Fiber>>();
const internals = (React as unknown as Record<string, { A?: { getOwner?: () => Fiber | null } } | undefined>)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// A read outside any component's render (React's development tooling
// comparing props) is not a screen showing the key, and is not recorded.
function recordRead(key: string) {
  if (typeof window === 'undefined') return;
  const owner = internals?.A?.getOwner?.() ?? null;
  if (owner === null) return;
  let owners = reads.get(key);
  if (owners === undefined) reads.set(key, (owners = new Set()));
  owners.add(owner);
}

declare global {
  interface Window {
    __stet?: {
      status: () => { point: string | null; status: Status | 'none'; reason?: string; route: string };
      refresh: () => void;
      reads: () => Array<{ key: string; value: string; owners: Fiber[] }>;
    };
  }
}

export function DevRoot({ descriptor, resolved, children }: { descriptor: Descriptor; resolved: Record<string, unknown>; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // Applied during the first client render, so the screen's own effects see the recipe's account and fixture.
  const [request] = useState(() => {
    if (typeof window === 'undefined') return null;
    const next = readRequest();
    if (next !== null) applyRequest(next);
    return next;
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [epoch, setEpoch] = useState(0);

  const view = useMemo(() => {
    const merged: Record<string, unknown> = { ...resolved, ...drafts };
    return new Proxy(merged, {
      get(target, key) {
        if (typeof key === 'string' && Object.hasOwn(target, key)) recordRead(key);
        return Reflect.get(target, key);
      },
    });
    // `epoch` makes a new view, so every reader renders again and re-records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, drafts, epoch]);

  // Reset the navigation: the point's screen replaces whatever route opened it.
  useEffect(() => {
    if (request === null || applied?.status !== 'ready') return;
    const screen = POINTS[request.point].screen;
    if (pathname !== screen) router.replace(`${screen}${window.location.search}`);
  }, [request, pathname, router]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; key?: unknown; value?: unknown; tokens?: unknown } | null;
      if (data === null || typeof data !== 'object') return;
      if (data.type === 'stet:draft' && typeof data.key === 'string' && typeof data.value === 'string') {
        if (!Object.hasOwn(descriptor.keys, data.key)) return;
        const key = data.key;
        const value = data.value;
        setDrafts((current) => ({ ...current, [key]: value }));
      } else if (data.type === 'stet:draft-clear') {
        const key = data.key;
        setDrafts((current) => {
          if (typeof key !== 'string') return {};
          const { [key]: _dropped, ...rest } = current;
          return rest;
        });
      } else if (data.type === 'stet:tokens') {
        applyTokens(data.tokens !== null && typeof data.tokens === 'object' ? (data.tokens as Record<string, unknown>) : null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [descriptor]);

  useEffect(() => {
    window.__stet = {
      status: () => ({
        point: request?.point ?? null,
        status: request === null ? 'none' : (applied?.status ?? 'failed'),
        reason: applied?.reason,
        route: window.location.pathname,
      }),
      refresh: () => {
        reads.clear();
        setEpoch((n) => n + 1);
      },
      reads: () => {
        const view = { ...resolved, ...drafts };
        return [...reads.entries()].map(([key, owners]) => ({ key, value: String(view[key]), owners: [...owners] }));
      },
    };
  }, [request, resolved, drafts]);

  return <CopyProvider descriptor={descriptor} resolved={view}>{children}</CopyProvider>;
}

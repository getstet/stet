// Development builds only: reading the rendered screen through React's
// DevTools hook. Finds the focused route's subtree, the text and input hosts
// in it, the app's own components (by source file, through Metro's development
// module registry) and measures them with measureInWindow.
import { processColor, StyleSheet } from 'react-native';

export type Fiber = any;
export type Box = [number, number, number, number];

// Fiber tags (React 19): the composite kinds and the two host kinds this walk reads.
const COMPOSITE = new Set([0, 1, 11, 14, 15]);
const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const TEXT_HOSTS = new Set(['RCTText']);
const INPUT_HOSTS = new Set(['RCTSinglelineTextInputView', 'RCTMultilineTextInputView', 'AndroidTextInput']);

let appFiles: Map<unknown, string> = new Map();

/** Rebuilt per capture: a route module may initialise after the first one. */
export function indexAppFiles() {
  appFiles = new Map();
  const mods = (globalThis as any).__r?.getModules?.();
  const entries: [unknown, any][] = mods instanceof Map ? [...mods] : Object.entries(mods ?? {});
  for (const [, m] of entries) {
    const file: string | undefined = m?.verboseName;
    if (!m?.isInitialized || !file || file.includes('node_modules') || file.includes('stet-dev')) continue;
    if (!file.startsWith('src/')) continue;
    const ex = m.publicModule?.exports;
    if (typeof ex === 'function') appFiles.set(ex, file);
    if (ex && typeof ex === 'object') for (const v of Object.values(ex)) if (typeof v === 'function') appFiles.set(v, file);
  }
}

export function appFileOf(type: any): string | null {
  if (!type) return null;
  const inner = type.type ?? type.render ?? type;
  return appFiles.get(type) ?? appFiles.get(inner) ?? null;
}

export function nameOf(fiber: Fiber): string | null {
  const t = fiber.type;
  if (!t) return null;
  if (typeof t === 'string') return t;
  const inner = t.type ?? t.render ?? t;
  return inner.name || t.displayName || inner.displayName || null;
}

export const norm = (text: string) => String(text).replace(/\s+/g, ' ').trim();

/**
 * Ported from stet's preview agent (`pattern()` in templates/preview-agent.js):
 * a value as a test over rendered text. `{{name}}` matches any non-empty run,
 * placeholder tags none; the literal pieces are found in order, leftmost first.
 */
export function pattern(value: string) {
  const plain = norm(String(value).replace(/<\d+\/>/g, ' ').replace(/<\/?\d+>/g, ''));
  if (plain === '') return null;
  const parts = plain.split(/\{\{\s*[\w.]+\s*\}\}/);
  const first = parts[0];
  const tail = parts[parts.length - 1];
  return (text: string) => {
    if (parts.length === 1) return text === plain;
    if (text.slice(0, first.length) !== first || text.slice(text.length - tail.length) !== tail) return false;
    let at = first.length;
    for (let i = 1; i < parts.length - 1; i += 1) {
      const found = text.indexOf(parts[i], at + 1);
      if (found === -1) return false;
      at = found + parts[i].length;
    }
    return text.length - tail.length >= at + 1;
  };
}

function roots(): Fiber[] {
  const hook = (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return [];
  const out: Fiber[] = [];
  const ids: Iterable<number> = hook.renderers?.keys?.() ?? [];
  for (const id of ids) {
    const set = hook.getFiberRoots?.(id);
    if (set) for (const root of set) out.push(root.current);
  }
  return out;
}

/** The text a host Text renders: every string under it, nested Text included. */
export function textOf(fiber: Fiber): string {
  let out = '';
  const stack: Fiber[] = fiber.child ? [fiber.child] : [];
  while (stack.length) {
    const f = stack.pop();
    if (f.sibling) stack.push(f.sibling);
    if (f.tag === HOST_TEXT) out += f.memoizedProps;
    else if (f.child) stack.push(f.child);
  }
  return out;
}

export function firstHost(fiber: Fiber): Fiber | null {
  const queue: Fiber[] = [fiber];
  while (queue.length) {
    const f = queue.shift();
    if (f.tag === HOST_COMPONENT) return f;
    for (let c = f.child; c; c = c.sibling) queue.push(c);
  }
  return null;
}

function firstText(fiber: Fiber): Fiber | null {
  const queue: Fiber[] = [fiber];
  while (queue.length) {
    const f = queue.shift();
    if (f.tag === HOST_COMPONENT && TEXT_HOSTS.has(f.type)) return f;
    for (let c = f.child; c; c = c.sibling) queue.push(c);
  }
  return null;
}

export function measure(host: Fiber | null): Promise<Box | null> {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    const done = (x: number, y: number, w: number, h: number) =>
      resolve([x, y, w, h].map((v) => Math.round(v * 10) / 10) as Box);
    const sn = host.stateNode;
    const pub = sn?.canonical?.publicInstance ?? (typeof sn?.measureInWindow === 'function' ? sn : null);
    if (pub?.measureInWindow) return pub.measureInWindow(done);
    const fabric = (globalThis as any).nativeFabricUIManager;
    if (fabric && sn?.node) return fabric.measureInWindow(sn.node, done);
    resolve(null);
  });
}

export type Screen = {
  nav: any;
  routeName: string | null;
  screen: Fiber | null;
  texts: Fiber[];
  /** Hosts whose words sit in a prop: an input's placeholder, an accessibility label. */
  labelled: { host: Fiber; prop: 'placeholder' | 'accessibilityLabel' }[];
  components: Fiber[];
  /** Every composite under the route, app component or not: the candidates for having read a key. */
  composites: Fiber[];
  /** Views with an opaque fill, and every host's paint order (tree order: later is drawn on top). */
  opaque: Fiber[];
  order: Map<Fiber, number>;
};

/** A fill with full alpha on a view that is not itself faded. */
function paintsOpaque(fiber: Fiber): boolean {
  const s = StyleSheet.flatten(fiber.memoizedProps?.style);
  if (!s?.backgroundColor || (s.opacity ?? 1) < 1) return false;
  const argb = processColor(s.backgroundColor);
  return typeof argb === 'number' && ((argb >>> 24) & 0xff) === 0xff;
}

/**
 * The focused screen. A subtree whose props carry a React Navigation
 * `navigation` that is not focused (a screen below the top of the stack) is
 * skipped; the first app component under the focused route is the screen.
 */
export function focusedScreen(): Screen {
  const out: Screen = { nav: null, routeName: null, screen: null, texts: [], labelled: [], components: [], composites: [], opaque: [], order: new Map() };
  const visit = (fiber: Fiber, underRoute: boolean) => {
    for (let f = fiber; f; f = f.sibling) {
      const props = f.memoizedProps;
      const nav = props?.navigation;
      let route = underRoute;
      if (props?.route?.key && typeof nav?.isFocused === 'function') {
        if (!nav.isFocused()) continue;
        // Routes nest (Expo Router's `__root` holds the app's stack): the innermost focused one is the screen.
        out.nav = nav;
        out.routeName = props.route.name;
        out.screen = null;
        out.components = [];
        out.texts = [];
        out.labelled = [];
        out.composites = [];
        out.opaque = [];
        route = true;
      }
      if (route && f.tag === HOST_COMPONENT) out.order.set(f, out.order.size);
      if (route && f.tag === HOST_COMPONENT && TEXT_HOSTS.has(f.type)) {
        out.texts.push(f);
        continue;
      }
      if (route && f.tag === HOST_COMPONENT) {
        if (INPUT_HOSTS.has(f.type) && props?.placeholder) out.labelled.push({ host: f, prop: 'placeholder' });
        if (props?.accessibilityLabel) out.labelled.push({ host: f, prop: 'accessibilityLabel' });
        if (!TEXT_HOSTS.has(f.type) && paintsOpaque(f)) out.opaque.push(f);
      }
      if (route && COMPOSITE.has(f.tag)) {
        out.composites.push(f);
        const file = appFileOf(f.type);
        if (file && !/\/_layout\.[jt]sx?$/.test(file)) {
          if (!out.screen && file.startsWith('src/app/')) out.screen = f;
          else out.components.push(f);
        }
      }
      if (f.child) visit(f.child, route);
    }
  };
  for (const root of roots()) visit(root, false);
  return out;
}

/** Composite ancestors of a fiber, nearest first, up to the route. */
export function ancestors(fiber: Fiber): Fiber[] {
  const out: Fiber[] = [];
  for (let f = fiber.return; f; f = f.return) {
    if (COMPOSITE.has(f.tag)) out.push(f);
    if (f.memoizedProps?.route?.key && f.memoizedProps?.navigation) break;
  }
  return out;
}

export function textStyle(host: Fiber) {
  const s = StyleSheet.flatten(host?.memoizedProps?.style) ?? {};
  return {
    fontFamily: s.fontFamily ?? 'System',
    fontSize: s.fontSize ?? 14,
    fontWeight: String(s.fontWeight ?? '400'),
    color: s.color ?? null,
    textAlign: s.textAlign ?? 'auto',
    ...(s.lineHeight ? { lineHeight: s.lineHeight } : {}),
    ...(s.letterSpacing ? { letterSpacing: s.letterSpacing } : {}),
  };
}

/** The drawn style a look-alike comparison reads: the fill, the corners and the first text. */
export function drawnStyle(fiber: Fiber) {
  const host = firstHost(fiber);
  const s = StyleSheet.flatten(host?.memoizedProps?.style) ?? {};
  const text = firstText(fiber);
  const out: Record<string, unknown> = {};
  for (const k of ['backgroundColor', 'borderRadius', 'borderWidth', 'borderColor', 'height', 'minHeight']) if (s[k] != null) out[k] = s[k];
  if (text) out.text = textStyle(text);
  return out;
}

export function plainProps(props: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'children' || k === 'style') continue;
    if (k === 'value' && props.secureTextEntry) out[k] = '[secure]';
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === 'object' ? '[object]' : x));
    else if (typeof v === 'function') out[k] = '[function]';
    else if (v && typeof v === 'object' && '$$typeof' in (v as object)) out[k] = '[element]';
    else if (v && typeof v === 'object') out[k] = depth < 2 ? plainProps(v as Record<string, unknown>, depth + 1) : '[object]';
    else out[k] = v;
  }
  return out;
}

function isAncestor(ancestor: Fiber, fiber: Fiber): boolean {
  for (let f = fiber.return; f; f = f.return) if (f === ancestor || f === ancestor.alternate) return true;
  return false;
}

const contains = (outer: Box, inner: Box) =>
  outer[0] <= inner[0] + 0.5 && outer[1] <= inner[1] + 0.5 &&
  outer[0] + outer[2] >= inner[0] + inner[2] - 0.5 && outer[1] + outer[3] >= inner[1] + inner[3] - 0.5;

/**
 * Whether an opaque view drawn after the host (a dialog card) covers its whole
 * box. A semi-transparent scrim does not count; neither do the host's own
 * ancestors (its button's fill) or descendants.
 */
export function covered(screen: Screen, host: Fiber, box: Box | null, opaqueBoxes: (Box | null)[]): boolean {
  if (!box) return false;
  const at = screen.order.get(host) ?? -1;
  return screen.opaque.some((view, i) => {
    const b = opaqueBoxes[i];
    return b != null && (screen.order.get(view) ?? -1) > at && !isAncestor(view, host) && !isAncestor(host, view) && contains(b, box);
  });
}

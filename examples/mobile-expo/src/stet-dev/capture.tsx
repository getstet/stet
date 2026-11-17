// Development builds only: the capture helper's measuring half. After a point's
// recipe is applied it waits for the screen to settle (the navigator's
// transition ended, then every measured box unchanged across three polls),
// locates each key by matching its current value against the rendered text,
// narrows the matches to the components that read the key, and records every
// app component on the screen with its box, props and file.
import { useEffect, useState } from 'react';
import { Dimensions, PixelRatio, Platform, StyleSheet, Text, View } from 'react-native';

import { copyDrafts, descriptor, resolved } from '@/copy';

import { readBy, readsTracked } from './copy-reads';
import {
  ancestors,
  appFileOf,
  covered,
  drawnStyle,
  firstHost,
  focusedScreen,
  indexAppFiles,
  measure,
  nameOf,
  norm,
  pattern,
  plainProps,
  textOf,
  textStyle,
  type Box,
  type Fiber,
} from './walk';

const POLL_MS = 100;
const STABLE_POLLS = 3;
const TRANSITION_MAX_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- line layout probes ----------------------------------------------------

type Probe = { id: number; text: string; style: unknown; width: number };
let addProbe: ((p: Probe) => void) | null = null;
const waiting = new Map<number, (lines: { text: string }[]) => void>();

/** Lays text out again, unconstrained, at a measured width: its lines against numberOfLines say whether it is cut. */
function layoutLines(probe: Omit<Probe, 'id'>): Promise<{ text: string }[]> {
  const id = Math.random();
  return new Promise((resolve) => {
    if (!addProbe) return resolve([]);
    const timer = setTimeout(() => (waiting.delete(id), resolve([])), 1000);
    waiting.set(id, (lines) => (clearTimeout(timer), resolve(lines)));
    addProbe({ ...probe, id });
  });
}

export function Probes() {
  const [probes, setProbes] = useState<Probe[]>([]);
  useEffect(() => {
    addProbe = (p) => setProbes((all) => [...all, p]);
    return () => {
      addProbe = null;
    };
  }, []);
  if (!probes.length) return null;
  return (
    <View pointerEvents="none" style={styles.probes}>
      {probes.map((p) => (
        <Text
          key={p.id}
          style={[p.style as any, styles.probe, { width: p.width }]}
          onTextLayout={(e) => {
            waiting.get(p.id)?.(e.nativeEvent.lines);
            waiting.delete(p.id);
            setProbes((all) => all.filter((q) => q.id !== p.id));
          }}>
          {p.text}
        </Text>
      ))}
    </View>
  );
}

// --- the measurement ---------------------------------------------------------

type Match = { key: string; host: Fiber; text: string; prop: 'placeholder' | 'accessibilityLabel' | null };

function currentValues(): Record<string, string> {
  const values: Record<string, string> = {};
  const drafts = copyDrafts.get();
  for (const key of Object.keys(descriptor.keys)) {
    const v = Object.hasOwn(drafts, key) ? drafts[key] : resolved[key];
    if (typeof v === 'string') values[key] = v;
  }
  return values;
}

/** Each key's matches on the focused screen, narrowed to the components that read it. */
function locate(screen: ReturnType<typeof focusedScreen>) {
  const tracked = readsTracked();
  const hosts = [
    ...screen.texts.map((host) => ({ host, text: norm(textOf(host)), prop: null })),
    ...screen.labelled.map(({ host, prop }) => ({ host, text: norm(host.memoizedProps?.[prop] ?? ''), prop })),
  ];
  const out: { key: string; value: string; matches: Match[]; readOnScreen: boolean }[] = [];
  for (const [key, value] of Object.entries(currentValues())) {
    const test = pattern(value);
    const matches: Match[] = test ? hosts.filter((h) => h.text && test(h.text)).map((h) => ({ key, ...h })) : [];
    if (!tracked) {
      if (matches.length) out.push({ key, value, matches, readOnScreen: false });
      continue;
    }
    const readOnScreen = screen.composites.some((c) => readBy(key, c));
    const narrowed = matches.filter((m) => ancestors(m.host).some((a) => readBy(key, a)));
    // A match no reader of the key encloses is someone else's text with the same words.
    if (narrowed.length || readOnScreen) out.push({ key, value, matches: narrowed, readOnScreen });
  }
  return out;
}

export type Measured = {
  status: 'captured' | 'unsettled';
  reason?: string;
  screen: string | null;
  routeName: string | null;
  transition: string;
  record: Record<string, unknown>;
};

/**
 * Waits until the stack's top route is `target`, then until the screen has
 * settled, then measures. Past `deadline` it measures what is there and
 * returns `unsettled`.
 */
export async function measurePoint(target: string, deadline: number): Promise<Measured> {
  indexAppFiles();
  let screen = focusedScreen();
  while (screen.routeName !== target && Date.now() < deadline) {
    await sleep(50);
    screen = focusedScreen();
  }
  const transition = await new Promise<string>((resolve) => {
    const nav = screen.nav;
    if (!nav?.addListener) return resolve('no-navigator');
    const timer = setTimeout(() => (off(), resolve('timeout')), Math.min(TRANSITION_MAX_MS, Math.max(0, deadline - Date.now())));
    const off = nav.addListener('transitionEnd', () => (clearTimeout(timer), off(), resolve('transitionEnd')));
  });

  let last = '';
  let stable = 0;
  let located: ReturnType<typeof locate> = [];
  let keyBoxes: (Box | null)[][] = [];
  let compBoxes: (Box | null)[] = [];
  while (true) {
    screen = focusedScreen();
    located = locate(screen);
    keyBoxes = await Promise.all(located.map((k) => Promise.all(k.matches.map((m) => measure(m.host)))));
    compBoxes = await Promise.all(screen.components.map((c) => measure(firstHost(c))));
    const sig = JSON.stringify([screen.routeName, located.map((k) => k.key), keyBoxes, compBoxes]);
    stable = sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= STABLE_POLLS - 1 && screen.routeName === target) break;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  const settled = stable >= STABLE_POLLS - 1 && screen.routeName === target;

  // A drawn text two keys both claim cannot be told apart: those keys are
  // ambiguous. A key alone on several texts (a repeated row) is located at each.
  const opaqueBoxes = await Promise.all(screen.opaque.map((v) => measure(v)));
  const coveredAt = (m: Match, box: Box | null) => covered(screen, m.host, box, opaqueBoxes);
  const claims = new Map<Fiber, number>();
  for (const k of located) for (const m of k.matches) claims.set(m.host, (claims.get(m.host) ?? 0) + 1);

  const keys = await Promise.all(
    located.map(async (k, i) => {
      const boxes = keyBoxes[i];
      if (!k.matches.length) return { key: k.key, value: k.value, status: 'not-located' };
      const shared = k.matches.some((m) => (claims.get(m.host) ?? 0) > 1);
      // `covered` on the key when every match is covered, as web-signup records it; per candidate as well.
      const hidden = k.matches.map((m, i) => coveredAt(m, boxes[i]));
      const allHidden = hidden.every(Boolean) ? { covered: true } : {};
      if (k.matches.length > 1 && shared) {
        return { key: k.key, value: k.value, status: 'ambiguous', candidates: boxes, candidatesCovered: hidden, ...allHidden };
      }
      const repeated = k.matches.length > 1 ? { boxes, count: k.matches.length, ...(hidden.some(Boolean) ? { boxesCovered: hidden } : {}) } : {};
      const m = k.matches[0];
      const box = boxes[0];
      if (m.prop) {
        // Words in a prop have no text box of their own: the box is the element's.
        return { key: k.key, value: k.value, status: 'located', box, ...repeated, ...allHidden, text: m.text, element: m.prop, ...(m.prop === 'placeholder' ? { style: textStyle(m.host) } : {}) };
      }
      const numberOfLines: number | undefined = m.host.memoizedProps?.numberOfLines || undefined;
      const full = box ? await layoutLines({ text: m.text, style: m.host.memoizedProps?.style, width: box[2] }) : [];
      const lines = numberOfLines ? Math.min(full.length, numberOfLines) : full.length;
      return {
        key: k.key,
        value: k.value,
        status: 'located',
        box,
        ...repeated,
        ...allHidden,
        text: m.text,
        lines,
        truncated: Boolean(numberOfLines && full.length > numberOfLines),
        style: textStyle(m.host),
      };
    }),
  );

  const components = screen.components.map((fiber, i) => ({
    name: nameOf(fiber),
    file: appFileOf(fiber.type),
    box: compBoxes[i],
    props: plainProps(fiber.memoizedProps),
    style: drawnStyle(fiber),
  }));

  const win = Dimensions.get('window');
  const routeName = screen.routeName;
  return {
    status: settled ? 'captured' : 'unsettled',
    ...(settled ? {} : { reason: screen.routeName === target ? 'the screen kept moving' : `the stack did not reach ${target}` }),
    screen: routeName,
    routeName,
    transition,
    record: {
      platform: `${Platform.OS} ${Platform.Version}`,
      window: { width: win.width, height: win.height, pixelRatio: PixelRatio.get() },
      fontScale: PixelRatio.getFontScale(),
      screenComponent: screen.screen ? { name: nameOf(screen.screen), file: appFileOf(screen.screen.type) } : null,
      keys,
      components,
      transition,
    },
  };
}

const styles = StyleSheet.create({
  probes: { position: 'absolute', left: -10000, top: 0, opacity: 0 },
  probe: { position: 'absolute', margin: 0, marginTop: 0, left: 0, top: 0 },
});

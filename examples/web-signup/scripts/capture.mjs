#!/usr/bin/env node
// Capture every point in stet.flows.json on every device, from the running
// development server: settle, screenshot, locate each key the screen read,
// record the app's components, and write the records under .stet/captures/.
//
//   npm run dev                      # in another terminal
//   npm run capture                  # every point × every device
//   npm run capture -- --point signup.invalid --device mobile
//   npm run capture -- --appearance dark --text-scale 1.3
//
// The design this script stands in for is `stet capture` (walkthrough §5).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.stet/captures');
const TIME_LIMIT_MS = 10_000;
const POLL_MS = 100;

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.STET_APP_URL ?? 'http://127.0.0.1:3100' },
    point: { type: 'string', multiple: true },
    device: { type: 'string', multiple: true },
    appearance: { type: 'string', default: 'light' },
    'text-scale': { type: 'string', default: '1' },
  },
});
const base = args.url.replace(/\/$/, '');
const appearance = args.appearance === 'dark' ? 'dark' : 'light';
const textScale = Number(args['text-scale']) > 0 ? Number(args['text-scale']) : 1;
// A variation other than the default writes beside the default capture, never over it.
const variation = (appearance === 'light' ? '' : `.${appearance}`) + (textScale === 1 ? '' : `.text${textScale}`);

const flows = JSON.parse(readFileSync(join(ROOT, 'stet.flows.json'), 'utf8'));
const pointIds = args.point ?? Object.keys(flows.points);
const devices = flows.devices.filter((d) => args.device === undefined || args.device.includes(d.id));
for (const id of pointIds) if (!flows.points[id]) fail(`no point "${id}" in stet.flows.json`);
if (devices.length === 0) fail(`no device ${args.device.join(', ')} in stet.flows.json`);

// Every component exported from the app's own component files.
const COMPONENTS = Object.fromEntries(
  readdirSync(join(ROOT, 'components'))
    .filter((f) => f.endsWith('.tsx'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'components', f), 'utf8').matchAll(/export function (\w+)/g)]
      .map((m) => [m[1], `components/${f}`])),
);

const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = (git('status', '--porcelain', '--', '.') ?? '') !== '';

function fail(message) {
  console.error(`capture: ${message}`);
  process.exit(1);
}

// The app must be up before the first point.
try {
  await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
} catch {
  fail(`the app is not answering at ${base}. Start it with: npm run dev`);
}

const indexPath = join(OUT, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { version: 1, records: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs in the page. The preview agent's text matcher (`pattern`, `byNode`,
 * `byElement`, `byContained` from templates/preview-agent.js), ported: each key
 * the screen read is matched by its current value, narrowed to the elements
 * made by a component that read it, and measured.
 */
function measure(components) {
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  var CONTAINED_MIN = 12;
  var norm = function (text) { return String(text).replace(/\s+/g, ' ').trim(); };

  // --- ported from preview-agent.js ---
  function pattern(value) {
    var plain = norm(String(value).replace(/<\d+\/>/g, ' ').replace(/<\/?\d+>/g, ''));
    if (plain === '') return null;
    var parts = plain.split(/\{\{\s*[\w.]+\s*\}\}/);
    var first = parts[0];
    var tail = parts[parts.length - 1];
    return {
      test: function (text) {
        if (parts.length === 1) return text === plain;
        if (text.slice(0, first.length) !== first || text.slice(text.length - tail.length) !== tail) return false;
        var at = first.length;
        for (var i = 1; i < parts.length - 1; i += 1) {
          var found = text.indexOf(parts[i], at + 1);
          if (found === -1) return false;
          at = found + parts[i].length;
        }
        return text.length - tail.length >= at + 1;
      },
    };
  }
  function byNode(test) {
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var parent = node.parentElement;
      var t = norm(node.data);
      if (parent && !SKIP[parent.tagName] && t !== '' && test(t)) nodes.push({ el: parent, node: node });
    }
    return nodes;
  }
  function byElement(test) {
    var found = [];
    var all = document.body.querySelectorAll('*');
    for (var i = all.length - 1; i >= 0; i -= 1) {
      var el = all[i];
      if (SKIP[el.tagName]) continue;
      var t = norm(el.textContent);
      if (t === '' || !test(t) || found.some(function (f) { return el.contains(f.el); })) continue;
      found.push({ el: el });
    }
    return found;
  }
  function byContained(value) {
    var plain = norm(String(value).replace(/<\d+\/>/g, ' ').replace(/<\/?\d+>/g, ''));
    if (plain.length < CONTAINED_MIN || /\{\{/.test(plain)) return [];
    var body = plain.split(' ').map(function (word) { return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('\\s+');
    var re = new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'gu');
    var hits = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var parent = node.parentElement;
      if (!parent || SKIP[parent.tagName]) continue;
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(node.data)) !== null) hits.push({ el: parent, node: node, start: m.index, end: m.index + m[0].length });
    }
    return hits;
  }
  // --- end of the port ---

  function byAttribute(test) {
    var found = [];
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      for (var j = 0; j < ATTRS.length; j += 1) {
        var v = all[i].getAttribute(ATTRS[j]);
        if (v === null || norm(v) === '' || !test(norm(v))) continue;
        // A placeholder shows only while its field is empty.
        found.push({ el: all[i], attr: ATTRS[j], hidden: ATTRS[j] === 'placeholder' && Boolean(all[i].value) });
      }
    }
    return found;
  }

  var sx = window.scrollX;
  var sy = window.scrollY;
  var r2 = function (n) { return Math.round(n * 100) / 100; };
  var boxOf = function (rect) { return [r2(rect.left + sx), r2(rect.top + sy), r2(rect.width), r2(rect.height)]; };
  var hex = function (rgb) {
    var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(rgb);
    if (!m) return rgb;
    var h = '#' + [m[1], m[2], m[3]].map(function (c) { return Number(c).toString(16).padStart(2, '0'); }).join('').toUpperCase();
    return m[4] !== undefined && Number(m[4]) < 1 ? h + Math.round(Number(m[4]) * 255).toString(16).padStart(2, '0').toUpperCase() : h;
  };
  var styleOf = function (el, attr) {
    var cs = getComputedStyle(el);
    var color = attr === 'placeholder' ? getComputedStyle(el, '::placeholder').color : cs.color;
    return {
      fontFamily: cs.fontFamily,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
      color: hex(color),
      textAlign: cs.textAlign,
    };
  };
  var fiberOf = function (el) {
    for (var k in el) if (k.indexOf('__reactFiber$') === 0) return el[k];
    return null;
  };
  var visible = function (el) {
    var box = el.getBoundingClientRect();
    return el.getClientRects().length > 0 && box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  /** Whether a component that read the key made `el`: its owner chain reaches one of `owners`. */
  function madeBy(el, owners) {
    for (var fiber = fiberOf(el); fiber; fiber = fiber._debugOwner) {
      if (owners.has(fiber) || (fiber.alternate && owners.has(fiber.alternate))) return true;
    }
    return false;
  }

  function place(hit) {
    var rect;
    var lines = 1;
    if (hit.attr) {
      rect = hit.el.getBoundingClientRect();
    } else {
      var range = document.createRange();
      if (hit.node && hit.start !== undefined) { range.setStart(hit.node, hit.start); range.setEnd(hit.node, hit.end); }
      else if (hit.node) range.selectNodeContents(hit.node);
      else range.selectNodeContents(hit.el);
      rect = range.getBoundingClientRect();
      var tops = [];
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i += 1) {
        if (rects[i].width === 0) continue;
        var top = Math.round(rects[i].top);
        if (!tops.some(function (t) { return Math.abs(t - top) <= 2; })) tops.push(top);
      }
      lines = Math.max(1, tops.length);
    }
    var truncated = false;
    for (var el = hit.el, depth = 0; el && depth < 3; el = el.parentElement, depth += 1) {
      var cs = getComputedStyle(el);
      var clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) { truncated = true; break; }
    }
    // Covered: something else (a dialog) is drawn over the key's centre.
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var top = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight ? document.elementFromPoint(cx, cy) : null;
    var covered = top !== null && !hit.el.contains(top) && !top.contains(hit.el);
    var placed = { box: boxOf(rect), container: boxOf(hit.el.getBoundingClientRect()), lines: lines, truncated: truncated, style: styleOf(hit.el, hit.attr) };
    if (covered) placed.covered = true;
    return placed;
  }

  var reads = window.__stet.reads();
  var keys = reads.map(function (read) {
    var p = pattern(read.value);
    var entry = { key: read.key, value: read.value };
    if (p === null) return Object.assign(entry, { status: 'not-located' });
    var owners = new Set(read.owners);
    // An attribute key: its value sits in an attribute of an element a reading
    // component made. It is matched there alone, never inside other text.
    var inAttribute = owners.size === 0 ? [] : byAttribute(p.test).filter(function (hit) { return madeBy(hit.el, owners); });
    var hits;
    if (inAttribute.length > 0) {
      hits = inAttribute.filter(function (hit) { return !hit.hidden; });
      if (hits.length === 0) return Object.assign(entry, { status: 'not-located', reason: inAttribute[0].attr + ' hidden' });
    } else {
      hits = byNode(p.test);
      if (hits.length === 0) hits = byElement(p.test);
      if (hits.length === 0) hits = byAttribute(p.test).filter(function (hit) { return !hit.hidden; });
      if (hits.length === 0) hits = byContained(read.value);
    }
    hits = hits.filter(function (hit) { return visible(hit.el); });
    // Every match made by a component that read the key, and no other key of
    // the same value read by that component: each match is this key.
    var owned = false;
    if (owners.size > 0) {
      var narrowed = hits.filter(function (hit) { return madeBy(hit.el, owners); });
      if (narrowed.length > 0) {
        hits = narrowed;
        owned = !reads.some(function (other) {
          return other.key !== read.key && norm(other.value) === norm(read.value) &&
            other.owners.some(function (o) { return owners.has(o) || (o.alternate && owners.has(o.alternate)); });
        });
      }
    }
    if (hits.length === 0) return Object.assign(entry, { status: 'not-located' });
    if (hits.length === 1) return Object.assign(entry, { status: 'located' }, place(hits[0]));
    var placed = hits.map(place);
    var covered = placed.every(function (p) { return p.covered; }) ? { covered: true } : {};
    // A key the reading component renders more than once: the first is measured, the count noted.
    if (owned) {
      var first = Object.assign({}, placed[0]);
      delete first.covered;
      return Object.assign(entry, { status: 'located' }, first, {
        boxes: placed.map(function (p) { return p.box; }),
        count: placed.length,
        truncated: placed.some(function (p) { return p.truncated; }),
      }, covered);
    }
    return Object.assign(entry, {
      status: 'ambiguous',
      candidates: placed.map(function (p) { return p.box; }),
      lines: placed[0].lines,
      truncated: placed.some(function (p) { return p.truncated; }),
      style: placed[0].style,
    }, covered);
  });

  // Components: every fiber of an app component, measured over its host nodes.
  var seen = new Set();
  var found = [];
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i += 1) {
    for (var f = fiberOf(all[i]); f; f = f.return) {
      if (typeof f.type !== 'function' || !Object.prototype.hasOwnProperty.call(components, f.type.name)) continue;
      if (seen.has(f) || (f.alternate && seen.has(f.alternate))) continue;
      seen.add(f);
      found.push(f);
    }
  }
  var hostNodes = function (fiber) {
    var out = [];
    var walk = function (node) {
      for (var c = node.child; c; c = c.sibling) {
        if (c.stateNode instanceof Element) out.push(c.stateNode);
        else walk(c);
      }
    };
    walk(fiber);
    return out;
  };
  var componentRecords = found.map(function (fiber) {
    var rects = hostNodes(fiber).filter(visible).map(function (el) { return el.getBoundingClientRect(); });
    var props = {};
    var raw = fiber.memoizedProps || {};
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') props[k] = v;
      else if (k === 'children' && Array.isArray(v) && v.every(function (x) { return typeof x === 'string'; })) props[k] = v.join('');
    });
    var box = null;
    if (rects.length > 0) {
      var l = Math.min.apply(null, rects.map(function (r) { return r.left; }));
      var t = Math.min.apply(null, rects.map(function (r) { return r.top; }));
      var rr = Math.max.apply(null, rects.map(function (r) { return r.right; }));
      var b = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
      box = boxOf({ left: l, top: t, width: rr - l, height: b - t });
    }
    return { name: fiber.type.name, file: components[fiber.type.name], box: box, props: props };
  }).filter(function (c) { return c.box !== null; });

  return {
    keys: keys,
    components: componentRecords,
    // A page that cannot scroll (a dialog holds it) is captured as the window shows it.
    document: getComputedStyle(document.documentElement).overflowY === 'hidden'
      ? { width: window.innerWidth, height: window.innerHeight, scrolls: false }
      : { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrolls: true },
  };
}

async function capturePoint(page, pointId, device) {
  const recipe = flows.points[pointId];
  const stem = `${device.id}${variation}`;
  const dir = join(OUT, pointId);
  const recordPath = join(dir, `${stem}.json`);
  const image = `${pointId}/${stem}.png`;
  const previous = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  const started = Date.now();
  const deadline = started + TIME_LIMIT_MS;
  const record = {
    point: pointId,
    screen: recipe.screen,
    state: recipe.fixture ?? null,
    account: recipe.account ?? null,
    appearance,
    textScale,
    device: device.id,
    commit,
    dirty,
    status: 'captured',
    window: { width: device.viewport.width, height: device.viewport.height, pixelRatio: device.viewport.pixelRatio },
  };
  const failed = (status, reason) => {
    // A failed point keeps its last good capture, marked with the failure.
    const kept = previous !== null && previous.image ? previous : { ...record, keys: [], components: [] };
    return { ...kept, status, reason, failedAt: new Date().toISOString(), lastCapturedAt: previous?.capturedAt ?? null };
  };

  const query = new URLSearchParams({ 'stet-state': pointId, appearance, textScale: String(textScale) });
  let response;
  try {
    response = await page.goto(`${base}${recipe.screen}?${query}`, { waitUntil: 'load', timeout: TIME_LIMIT_MS });
  } catch (error) {
    return failed('failed', `the page did not load: ${error.message.split('\n')[0]}`);
  }
  if (response && response.status() === 404) return failed('screen-not-found', `${recipe.screen} answers 404`);

  // 1. The route has reached the point's screen and the recipe is applied.
  const status = await page.waitForFunction(
    (screen) => {
      const s = window.__stet?.status();
      if (!s || s.status === 'none') return false;
      return s.status !== 'ready' || s.route === screen ? s : false;
    },
    recipe.screen,
    { timeout: Math.max(1, deadline - Date.now()), polling: POLL_MS },
  ).then((h) => h.jsonValue()).catch(() => null);
  if (status === null) return failed('failed', 'the development state handling did not answer; is this a development server?');
  if (status.status !== 'ready') return failed('failed', status.reason ?? status.status);

  // Fonts loaded and the network quiet.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForLoadState('networkidle', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});

  // 2. The measured boxes unchanged across three polls. Each poll has every
  // copy reader render again, so the keys read are the screen's current ones.
  let measured = null;
  let lastSignature = null;
  let same = 0;
  let settled = false;
  while (Date.now() < deadline) {
    await page.evaluate(() => {
      window.__stet.refresh();
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    measured = await page.evaluate(measure, COMPONENTS);
    const signature = JSON.stringify([measured.keys, measured.components.map((c) => c.box), measured.document]);
    same = signature === lastSignature ? same + 1 : 0;
    lastSignature = signature;
    if (same >= 2) { settled = true; break; }
    await sleep(POLL_MS);
  }

  // 3. Two consecutive screenshots identical.
  const fullPage = measured?.document.scrolls !== false;
  let shot = await page.screenshot({ fullPage, animations: 'disabled' });
  let identical = false;
  while (settled && Date.now() < deadline) {
    await sleep(POLL_MS);
    const next = await page.screenshot({ fullPage, animations: 'disabled' });
    identical = next.equals(shot);
    shot = next;
    if (identical) break;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(OUT, image), shot);
  return {
    ...record,
    status: settled && identical ? 'captured' : 'unsettled',
    ...(settled && identical ? {} : { reason: `did not settle within ${TIME_LIMIT_MS / 1000} s` }),
    document: measured?.document ?? null,
    image,
    keys: measured?.keys ?? [],
    components: measured?.components ?? [],
    capturedAt: new Date().toISOString(),
    ms: Date.now() - started,
  };
}

const browser = await chromium.launch();
let failures = 0;
try {
  for (const device of devices) {
    const context = await browser.newContext({
      viewport: { width: device.viewport.width, height: device.viewport.height },
      deviceScaleFactor: device.viewport.pixelRatio,
      isMobile: device.viewport.width < 600,
      hasTouch: device.viewport.width < 600,
      colorScheme: appearance,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    for (const pointId of pointIds) {
      const record = await capturePoint(page, pointId, device);
      mkdirSync(join(OUT, pointId), { recursive: true });
      const stem = `${device.id}${variation}`;
      writeFileSync(join(OUT, pointId, `${stem}.json`), `${JSON.stringify(record, null, 2)}\n`);
      // Each point is written as it finishes, so a run that stops keeps every point before it.
      index.records = index.records.filter((r) => !(r.point === pointId && r.device === device.id && (r.variation ?? '') === variation));
      index.records.push({
        point: pointId,
        device: device.id,
        ...(variation ? { variation: variation.slice(1) } : {}),
        status: record.status,
        image: record.image ?? null,
        record: `${pointId}/${stem}.json`,
      });
      Object.assign(index, { version: 1, app: flows.app.id, capturedAt: new Date().toISOString(), commit, dirty });
      writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
      if (record.status !== 'captured') failures += 1;
      const counts = ['located', 'ambiguous', 'not-located'].map((s) => record.keys.filter((k) => k.status === s).length);
      console.log(
        `${record.status.padEnd(16)} ${pointId.padEnd(22)} ${stem.padEnd(10)} ${String(record.ms ?? '-').padStart(5)} ms` +
          `  keys ${counts[0]} located, ${counts[1]} ambiguous, ${counts[2]} not located` +
          `  components ${record.components.length}${record.reason ? `  (${record.reason})` : ''}`,
      );
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${pointIds.length * devices.length - failures} of ${pointIds.length * devices.length} captured → ${OUT}`);
process.exitCode = failures === 0 ? 0 : 1;

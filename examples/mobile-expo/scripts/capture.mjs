// Captures every point in stet.flows.json on the simulators and emulator: the
// app's development helper resets the navigation stack to the point's recipe,
// waits for the screen to settle and posts the record over the capture
// channel; this script takes screenshots until two in a row match and saves
// the record and the PNG under .stet/captures/.
//
//   node scripts/capture.mjs [--device <id>] [--point <id>] [--flow <id>]
//                            [--appearance light|dark] [--text-scale <n>] [--port <n>]
//
// --device, --point and --flow take a comma-separated list or repeat. The app
// must be running on each device (npm run ios / npm run android, with Metro).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.stet', 'captures');
const BUNDLE_ID = 'dev.getstet.examples.weather';
const POINT_LIMIT_MS = 10000;
const ANSWER_LIMIT_MS = 20000;

// --- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { device: [], point: [], flow: [], appearance: 'light', textScale: 1, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--device') out.device.push(...value().split(','));
    else if (flag === '--point') out.point.push(...value().split(','));
    else if (flag === '--flow') out.flow.push(...value().split(','));
    else if (flag === '--appearance') out.appearance = value();
    else if (flag === '--text-scale') out.textScale = Number(value());
    else if (flag === '--port') out.port = Number(value());
    else {
      console.error(`unknown option ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!['light', 'dark'].includes(out.appearance)) throw new Error('--appearance is light or dark');
  if (!(out.textScale > 0)) throw new Error('--text-scale is a positive number');
  return out;
}

/** The app reads EXPO_PUBLIC_STET_CAPTURE_PORT (from the environment or .env.local); so does this script. */
function capturePort(flag) {
  if (flag) return flag;
  if (process.env.EXPO_PUBLIC_STET_CAPTURE_PORT) return Number(process.env.EXPO_PUBLIC_STET_CAPTURE_PORT);
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^EXPO_PUBLIC_STET_CAPTURE_PORT=(\d+)/m);
    if (m) return Number(m[1]);
  }
  return 8765;
}

const args = parseArgs(process.argv.slice(2));
const PORT = capturePort(args.port);
const flows = JSON.parse(readFileSync(path.join(ROOT, 'stet.flows.json'), 'utf8'));

function selectedPoints() {
  if (args.point.length) return args.point;
  if (args.flow.length) {
    const ids = [];
    for (const flow of flows.flows.filter((f) => args.flow.includes(f.id))) {
      for (const step of flow.steps) ids.push(step.point);
      for (const branch of flow.branches ?? []) for (const step of branch.steps) ids.push(step.point);
      for (const edge of flows.edgeStates ?? []) if (edge.flows?.includes(flow.id)) ids.push(...edge.points);
    }
    return [...new Set(ids)];
  }
  return Object.keys(flows.points);
}

const devices = flows.devices.filter((d) => !args.device.length || args.device.includes(d.id));
const pointIds = selectedPoints();
// A variation run writes `<device>.<appearance>.text<scale>` beside the default `<device>`.
const variationSuffix = args.appearance !== 'light' || args.textScale !== 1 ? `.${args.appearance}.text${args.textScale}` : '';

// --- device commands (argument arrays, never a shell string) ----------------

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADB = path.join(process.env.ANDROID_HOME ?? path.join(process.env.HOME, 'Library/Android/sdk'), 'platform-tools/adb');

// iOS content size categories and the font scale each applies.
const CONTENT_SIZES = [
  ['extra-small', 0.82], ['small', 0.88], ['medium', 0.94], ['large', 1], ['extra-large', 1.12],
  ['extra-extra-large', 1.24], ['extra-extra-extra-large', 1.35], ['accessibility-medium', 1.64],
  ['accessibility-large', 1.95], ['accessibility-extra-large', 2.35], ['accessibility-extra-extra-large', 2.76],
  ['accessibility-extra-extra-extra-large', 3.12],
];
const contentSizeFor = (scale) =>
  CONTENT_SIZES.reduce((best, c) => (Math.abs(c[1] - scale) < Math.abs(best[1] - scale) ? c : best))[0];

function resolveDevice(device) {
  if (device.platform === 'ios') {
    const list = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).toString());
    const sim = Object.values(list.devices).flat().find((d) => d.name === device.name);
    if (!sim) throw new Error(`${device.name} is not booted — boot it and start the app (npm run ios)`);
    return { ...device, udid: sim.udid };
  }
  const serials = run(ADB, ['devices']).toString().split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)).filter(([s, state]) => s && state === 'device').map(([s]) => s);
  const avd = device.name.match(/\(([^)]+)\)/)?.[1];
  const serial = serials.find((s) => {
    try {
      return !avd || run(ADB, ['-s', s, 'emu', 'avd', 'name']).toString().split('\n')[0].trim() === avd;
    } catch {
      return false;
    }
  });
  if (!serial) throw new Error(`no running Android emulator${avd ? ` named ${avd}` : ''} — start it and the app (npm run android)`);
  return { ...device, serial };
}

function prepareDevice(d) {
  if (d.platform === 'ios') {
    run('xcrun', ['simctl', 'spawn', d.udid, 'defaults', 'write', BUNDLE_ID, 'stetDevice', d.id]);
    run('xcrun', ['simctl', 'status_bar', d.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active',
      '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100']);
    run('xcrun', ['simctl', 'ui', d.udid, 'appearance', args.appearance]);
    run('xcrun', ['simctl', 'ui', d.udid, 'content_size', contentSizeFor(args.textScale)]);
    return 0;
  }
  const adb = (...a) => run(ADB, ['-s', d.serial, ...a]);
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('reverse', 'tcp:8081', 'tcp:8081');
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  const demo = (command, ...extra) => adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', command, ...extra);
  demo('enter');
  demo('clock', '-e', 'hhmm', '0941');
  demo('battery', '-e', 'level', '100', '-e', 'plugged', 'false');
  demo('network', '-e', 'wifi', 'show', '-e', 'level', '4');
  demo('network', '-e', 'mobile', 'show', '-e', 'level', '4', '-e', 'datatype', 'none');
  demo('notifications', '-e', 'visible', 'false');
  adb('shell', 'cmd', 'uimode', 'night', args.appearance === 'dark' ? 'yes' : 'no');
  adb('shell', 'settings', 'put', 'system', 'font_scale', String(args.textScale));
  // Demo mode pins the status bar only after a delay.
  return 2500;
}

function restoreDevice(d) {
  if (d.platform === 'ios') {
    if (args.appearance !== 'light') run('xcrun', ['simctl', 'ui', d.udid, 'appearance', 'light']);
    if (args.textScale !== 1) run('xcrun', ['simctl', 'ui', d.udid, 'content_size', 'large']);
    return;
  }
  if (args.appearance !== 'light') run(ADB, ['-s', d.serial, 'shell', 'cmd', 'uimode', 'night', 'no']);
  if (args.textScale !== 1) run(ADB, ['-s', d.serial, 'shell', 'settings', 'put', 'system', 'font_scale', '1.0']);
}

function relaunch(d) {
  if (d.platform === 'ios') {
    try {
      run('xcrun', ['simctl', 'terminate', d.udid, BUNDLE_ID]);
    } catch {}
    run('xcrun', ['simctl', 'launch', d.udid, BUNDLE_ID]);
  } else {
    run(ADB, ['-s', d.serial, 'shell', 'am', 'force-stop', BUNDLE_ID]);
    run(ADB, ['-s', d.serial, 'shell', 'monkey', '-p', BUNDLE_ID, '-c', 'android.intent.category.LAUNCHER', '1']);
  }
}

function screenshot(d) {
  if (d.platform === 'ios') {
    const tmp = path.join(os.tmpdir(), `stet-shot-${d.id}.png`);
    run('xcrun', ['simctl', 'io', d.udid, 'screenshot', '--type=png', tmp]);
    return readFileSync(tmp);
  }
  return run(ADB, ['-s', d.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
}

// --- the capture channel ------------------------------------------------------

const queues = new Map(); // device id → { commands, waiter, lastSeen }
const answers = new Map(); // command id → resolve

function queueOf(id) {
  if (!queues.has(id)) queues.set(id, { commands: [], waiter: null, lastSeen: 0 });
  return queues.get(id);
}

/** The helper names its device; an Android helper says only `android`, which is the one emulator. */
function deviceKey(named, platform) {
  if (devices.some((d) => d.id === named)) return named;
  if (platform === 'android') return devices.find((d) => d.platform === 'android')?.id ?? null;
  return null;
}

const warned = new Set();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/next') {
    const key = deviceKey(url.searchParams.get('device'), url.searchParams.get('platform'));
    if (!key) {
      const named = url.searchParams.get('device');
      if (!warned.has(named)) console.log(`a helper polled as "${named}", which is not a selected device`);
      warned.add(named);
      res.writeHead(204).end();
      return;
    }
    const q = queueOf(key);
    q.lastSeen = Date.now();
    const send = (command) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(command));
    };
    if (q.commands.length) return send(q.commands.shift());
    if (q.waiter) q.waiter.end();
    const timer = setTimeout(() => {
      if (q.waiter?.res === res) q.waiter = null;
      res.writeHead(204).end();
    }, 20000);
    q.waiter = { res, send, end: () => (clearTimeout(timer), res.writeHead(204).end()) };
    req.on('close', () => {
      clearTimeout(timer);
      if (q.waiter?.res === res) q.waiter = null;
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/record') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.end('ok');
      try {
        const answer = JSON.parse(body);
        answers.get(answer.id)?.(answer);
        answers.delete(answer.id);
      } catch {}
    });
    return;
  }
  res.writeHead(404).end();
});

function ask(deviceId, command, limit = ANSWER_LIMIT_MS) {
  const id = `${deviceId}-${command.cmd}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const full = { ...command, id };
  return new Promise((resolve) => {
    const timer = setTimeout(() => (answers.delete(id), resolve(null)), limit);
    answers.set(id, (a) => (clearTimeout(timer), resolve(a)));
    const q = queueOf(deviceId);
    if (q.waiter) {
      const w = q.waiter;
      q.waiter = null;
      w.send(full);
    } else q.commands.push(full);
  });
}

// --- records ------------------------------------------------------------------

function git(...argv) {
  try {
    return run('git', ['-C', ROOT, ...argv]).toString().trim();
  } catch {
    return null;
  }
}
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = Boolean(git('status', '--porcelain', '--', '.'));

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

/** `{version, app, capturedAt, commit, dirty, records}`; paths are relative to .stet/captures. */
function writeIndex() {
  const records = [];
  for (const pointDir of existsSync(OUT) ? readdirSync(OUT, { withFileTypes: true }) : []) {
    if (!pointDir.isDirectory()) continue;
    for (const f of readdirSync(path.join(OUT, pointDir.name)).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const r = JSON.parse(readFileSync(path.join(OUT, pointDir.name, f), 'utf8'));
        records.push({
          point: r.point, device: r.device, status: r.status, image: r.image ?? null, record: `${pointDir.name}/${f}`,
          appearance: r.appearance ?? 'light', textScale: r.textScale ?? 1,
        });
      } catch {}
    }
  }
  const index = { version: 1, app: flows.app.id, capturedAt: new Date().toISOString(), commit, dirty, records };
  writeAtomic(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
}

async function capturePoint(d, pointId) {
  const point = flows.points[pointId] ?? null;
  const name = `${d.id}${variationSuffix}`;
  const jsonPath = path.join(OUT, pointId, `${name}.json`);
  const imageRel = `${pointId}/${name}.png`;
  const t0 = Date.now();
  const base = {
    point: pointId,
    title: point?.title ?? null,
    screen: point?.screen ?? null,
    state: point?.fixture ?? null,
    account: point?.account ?? null,
    stack: point?.stack ?? null,
    device: d.id,
    appearance: args.appearance,
    textScale: args.textScale,
    commit,
    dirty,
  };
  const answer = await ask(d.id, { cmd: 'show', point: pointId, appearance: args.appearance, textScale: args.textScale });

  const fail = (reason) => {
    // The failed point keeps its last good capture, dated, with the reason.
    const previous = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;
    const record = previous?.image
      ? { ...previous, status: 'failed', reason, failedAt: new Date().toISOString() }
      : { ...base, status: 'failed', reason, failedAt: new Date().toISOString() };
    writeAtomic(jsonPath, JSON.stringify(record, null, 2));
    return record;
  };

  if (!answer) return fail('the helper did not answer');
  if (answer.status === 'failed') return fail(answer.reason ?? 'the helper failed');
  if (answer.status === 'screen-not-found') {
    const record = { ...base, status: 'screen-not-found', reason: answer.reason, capturedAt: new Date().toISOString() };
    writeAtomic(jsonPath, JSON.stringify(record, null, 2));
    return record;
  }

  // Settled, last step: two consecutive screenshots identical.
  const deadline = Date.now() + POINT_LIMIT_MS;
  let previous = null;
  let shot = null;
  let shots = 0;
  let matched = false;
  while (true) {
    try {
      shot = screenshot(d);
    } catch (e) {
      return fail(`screenshot failed: ${String(e.message ?? e).split('\n')[0]}`);
    }
    shots += 1;
    if (previous && previous.equals(shot)) {
      matched = true;
      break;
    }
    // Two screenshots at least, however slow the simulator is to take one.
    if (Date.now() >= deadline && shots >= 2) break;
    previous = shot;
  }
  writeAtomic(path.join(OUT, imageRel), shot);
  const status = answer.status === 'captured' && matched ? 'captured' : 'unsettled';
  const reason =
    answer.status !== 'captured' ? answer.reason : matched ? undefined : 'the screenshots kept changing';
  const { id, device, point: _p, status: _s, reason: _r, screen, appearance: _a, ...measured } = answer;
  const record = {
    ...base,
    screen: screen ?? base.screen,
    status,
    ...(reason ? { reason } : {}),
    image: imageRel,
    ...measured,
    capturedAt: new Date().toISOString(),
    timings: { ...(measured.timings ?? {}), totalMs: Date.now() - t0, screenshots: shots },
  };
  writeAtomic(jsonPath, JSON.stringify(record, null, 2));
  return record;
}

async function connect(d) {
  if (await ask(d.id, { cmd: 'ping' }, 6000)) return true;
  // An iOS app reads its device id at launch: relaunch it once after the
  // defaults write, and the same for an Android app that was not polling.
  console.log(`[${d.id}] no answer; relaunching the app`);
  relaunch(d);
  return Boolean(await ask(d.id, { cmd: 'ping' }, 30000));
}

async function captureDevice(device) {
  const d = resolveDevice(device);
  const settle = prepareDevice(d);
  if (settle) await sleep(settle);
  if (!(await connect(d))) {
    throw new Error(
      `[${d.id}] the app's capture helper does not answer. Start Metro (npx expo start) and the app ` +
        `(${d.platform === 'ios' ? 'npm run ios' : 'npm run android'}), then run this again.`,
    );
  }
  const results = [];
  for (const pointId of pointIds) {
    const r = await capturePoint(d, pointId);
    writeIndex();
    results.push(r);
    console.log(`[${d.id}] ${pointId}: ${r.status}${r.reason ? ` (${r.reason})` : ''} ${r.timings?.totalMs ?? ''}ms`);
  }
  restoreDevice(d);
  return results;
}

/**
 * Captures hold the app's animations still. Every way out (done, failed,
 * interrupted) asks each helper that polled to let them run again; a helper
 * that never hears it releases them itself after 10 s without a command.
 */
async function releaseAll() {
  const seen = [...queues.entries()].filter(([, q]) => q.lastSeen).map(([id]) => id);
  await Promise.all(seen.map((id) => ask(id, { cmd: 'release' }, 3000)));
}

let leaving = false;
async function leave(code) {
  if (leaving) return;
  leaving = true;
  await releaseAll();
  server.close();
  process.exit(code);
}
process.on('SIGINT', () => leave(130));
process.on('SIGTERM', () => leave(143));
process.on('uncaughtException', (e) => (console.error(e), leave(1)));
process.on('unhandledRejection', (e) => (console.error(e), leave(1)));

mkdirSync(OUT, { recursive: true });
server.on('error', (e) => {
  console.error(`the capture channel cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`capture channel on 127.0.0.1:${PORT}; ${pointIds.length} point(s) × ${devices.length} device(s)`);
  const started = Date.now();
  const outcomes = await Promise.allSettled(devices.map(captureDevice));
  let failed = 0;
  for (const [i, o] of outcomes.entries()) {
    if (o.status === 'rejected') {
      failed += 1;
      console.error(o.reason.message);
    } else {
      const counts = {};
      for (const r of o.value) counts[r.status] = (counts[r.status] ?? 0) + 1;
      console.log(`${devices[i].id}: ${JSON.stringify(counts)}`);
    }
  }
  writeIndex();
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s; index: ${path.relative(ROOT, path.join(OUT, 'index.json'))}`);
  await leave(failed ? 1 : 0);
});

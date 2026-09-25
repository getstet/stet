// Development builds only: the capture channel's client. The helper connects
// out to the capture server on the Mac (the iOS simulator shares its
// 127.0.0.1; Android reaches it through `adb reverse tcp:<port> tcp:<port>`),
// long-polls for a command and posts each point's record back.
import { LogBox, Platform, Settings } from 'react-native';

import { measurePoint } from './capture';
import { applyPoint, pathOf, pointOf } from './recipe';

// 8765 unless EXPO_PUBLIC_STET_CAPTURE_PORT (inlined by Metro, e.g. from
// .env.local) names another; scripts/capture.mjs reads the same variable.
const SERVER = `http://127.0.0.1:${Number(process.env.EXPO_PUBLIC_STET_CAPTURE_PORT) || 8765}`;
const POINT_LIMIT_MS = 10000;

type Command =
  | { cmd: 'ping'; id?: string }
  | { cmd: 'show'; id?: string; point: string; appearance?: 'light' | 'dark'; textScale?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The capture script names each simulator in its defaults (`stetDevice`); Android has one emulator. */
function deviceId(): string {
  if (Platform.OS === 'ios') {
    const id = Settings.get('stetDevice');
    return typeof id === 'string' && id ? id : 'ios';
  }
  return Platform.OS;
}

async function post(body: unknown) {
  await fetch(`${SERVER}/record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function show(command: Extract<Command, { cmd: 'show' }>, navRef: any) {
  const started = Date.now();
  const device = deviceId();
  const base = { id: command.id, device, point: command.point };
  const point = pointOf(command.point);
  const applied = applyPoint(command.point, navRef, { appearance: command.appearance, textScale: command.textScale });
  if (!applied.ok) {
    return post({ ...base, status: 'screen-not-found', reason: applied.reason, screen: point?.screen ?? null });
  }
  const measured = await measurePoint(applied.target, started + POINT_LIMIT_MS);
  await post({
    ...base,
    status: measured.status,
    ...(measured.reason ? { reason: measured.reason } : {}),
    screen: pathOf(measured.routeName),
    appearance: command.appearance ?? null,
    ...measured.record,
    timings: { receivedAt: started, settledAt: Date.now() },
  });
}

let running = false;

/** Polls the capture server until the app is reloaded. Quiet while no server is up. */
export function startChannel(navRef: any) {
  if (running) return;
  running = true;
  (async () => {
    while (running) {
      let command: Command | null = null;
      try {
        const res = await fetch(`${SERVER}/next?device=${encodeURIComponent(deviceId())}&platform=${Platform.OS}`);
        if (res.status === 200) command = await res.json();
        else if (res.status !== 204) await sleep(2000);
      } catch {
        await sleep(3000);
        continue;
      }
      if (!command) continue;
      // A LogBox toast would land in the screenshot.
      LogBox.ignoreAllLogs(true);
      try {
        if (command.cmd === 'ping') await post({ id: command.id, device: deviceId(), status: 'pong' });
        else if (command.cmd === 'show') await show(command, navRef);
      } catch (e) {
        try {
          await post({ id: command.id, device: deviceId(), point: (command as any).point, status: 'failed', reason: String(e) });
        } catch {}
      }
    }
  })();
}

export function stopChannel() {
  running = false;
}

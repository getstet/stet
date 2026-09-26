import type { GuardVerdict } from '@getstet/stet/server';

const WINDOW_MS = 10 * 60 * 1000;
const seen = new Map<string, number[]>();

export function limitByAddress(req: Request): GuardVerdict {
  const address = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ?? 'unknown';
  const now = Date.now();
  const recent = (seen.get(address) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= 5) return { status: 429, error: 'rate_limited' };
  seen.set(address, [...recent, now]);
  return true;
}

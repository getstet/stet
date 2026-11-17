// Development builds only: the mock API layer. A fixture answers the API calls
// with a fixed state; an account preset signs in as a seeded account. Nothing
// here is bundled into a release build.
import { register, session, type Account, type Units } from '@/auth/session';
import { createStore } from '@/lib/store';

import { ApiError, type FailReason, type WeatherAnswer } from '../types';

type Fixture = {
  weather: { city?: string; temperature: number; high: number; low: number; code: number } | 'pending' | 'not-found' | FailReason;
  alerts?: number;
};

const LOADED = { temperature: 21, high: 24, low: 15, code: 2 };

export const fixtures: Record<string, Fixture> = {
  'weather-loaded': { weather: LOADED },
  'weather-loading': { weather: 'pending' },
  'weather-failed': { weather: 'unavailable' },
  'city-not-found': { weather: 'not-found' },
  offline: { weather: 'offline' },
  'session-expired': { weather: 'unauthorized' },
  'many-alerts': { weather: LOADED, alerts: 500 },
};

const DAY = 24 * 60 * 60 * 1000;
const base = { units: 'celsius' as Units, notifications: true, alerts: 1 };

/** Seeded accounts. The password is for signing in by hand; a recipe names only the preset. */
export const accountPresets: Record<string, { password: string; account: () => Account }> = {
  returning: {
    password: 'weather-demo',
    account: () => ({ ...base, email: 'returning@example.com', name: 'Ada', city: 'Lisbon', trialEndsAt: Date.now() + 12 * DAY }),
  },
  new: {
    password: 'weather-demo',
    account: () => ({ ...base, email: 'new@example.com', name: 'Sam', city: null, notifications: false, alerts: 0, trialEndsAt: Date.now() + 14 * DAY }),
  },
  'trial-ended': {
    password: 'weather-demo',
    account: () => ({ ...base, email: 'trial-ended@example.com', name: 'Noor', city: 'Oslo', trialEndsAt: Date.now() - 2 * DAY }),
  },
  'long-name': {
    password: 'weather-demo',
    account: () => ({
      ...base,
      email: 'long-name@example.com',
      name: 'Maximiliana Theodora Vandenbergh-Okonkwo',
      city: 'Reykjavik',
      trialEndsAt: Date.now() + 12 * DAY,
    }),
  },
};

// Seed the presets so they can be signed into by hand in development.
for (const preset of Object.values(accountPresets)) {
  const account = preset.account();
  register(account.email, preset.password, account);
}

export const activeFixture = createStore<string | null>(null);

/** Applies a recipe's account and fixture. `null` signs out and returns to the real API. */
export function applyMockState(account: string | null | undefined, fixture: string | null | undefined): string | null {
  if (account && !accountPresets[account]) return `unknown account preset "${account}"`;
  if (fixture && !fixtures[fixture]) return `unknown fixture "${fixture}"`;
  activeFixture.set(fixture ?? null);
  session.set(account ? accountPresets[account].account() : null);
  return null;
}

export function mockWeather(query: string, units: Units): Promise<WeatherAnswer> | null {
  const name = activeFixture.get();
  if (!name) return null;
  const answer = fixtures[name].weather;
  if (answer === 'pending') return new Promise(() => {});
  if (answer === 'not-found') return Promise.resolve({ kind: 'not-found', query });
  if (typeof answer === 'string') return Promise.reject(new ApiError(answer));
  const convert = (c: number) => (units === 'fahrenheit' ? Math.round((c * 9) / 5 + 32) : c);
  return Promise.resolve({
    kind: 'loaded',
    weather: {
      city: answer.city ?? query,
      temperature: convert(answer.temperature),
      high: convert(answer.high),
      low: convert(answer.low),
      code: answer.code,
    },
  });
}

export function mockAlerts(): number | null {
  const name = activeFixture.get();
  return name ? (fixtures[name].alerts ?? null) : null;
}

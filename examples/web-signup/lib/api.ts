import { signIn, updateUser, type User } from '@/lib/session';

// The mock API: every call answers in this browser after a short wait, so
// nothing leaves the machine.

export type Outcome = 'ok' | 'unavailable' | 'pending';
type Call = 'signUp' | 'saveSettings';

export class ServiceUnavailable extends Error {}

let outcomes: Partial<Record<Call, Outcome>> = {};

/** Fix how the next calls answer; an empty map restores normal answers. */
export function setOutcomes(next: Partial<Record<Call, Outcome>>) {
  outcomes = next;
}

async function answer(call: Call, ms: number): Promise<void> {
  const outcome = outcomes[call];
  if (outcome === 'pending') return new Promise<void>(() => {});
  await new Promise((resolve) => setTimeout(resolve, outcome === undefined ? ms : 0));
  if (outcome === 'unavailable') throw new ServiceUnavailable();
}

export async function signUp(details: { name: string; email: string }): Promise<User> {
  await answer('signUp', 800);
  const user: User = { ...details, prefs: { updates: true, summary: false }, projects: [] };
  signIn(user);
  return user;
}

export async function saveSettings(patch: Pick<User, 'name' | 'prefs'>): Promise<void> {
  await answer('saveSettings', 500);
  updateUser(patch);
}

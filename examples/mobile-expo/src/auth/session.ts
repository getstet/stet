import { createStore } from '@/lib/store';

export type Units = 'celsius' | 'fahrenheit';

export type Account = {
  email: string;
  name: string;
  city: string | null;
  units: Units;
  notifications: boolean;
  trialEndsAt: number;
  alerts: number;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * Local, fake sign-in: accounts live in memory for as long as the app runs.
 * Nothing leaves the device and there is no password recovery.
 */
const accounts = new Map<string, { password: string; account: Account }>();

export const session = createStore<Account | null>(null);

export function useAccount() {
  return session.use();
}

export function register(email: string, password: string, account: Account) {
  accounts.set(email.trim().toLowerCase(), { password, account });
}

export function createAccount(email: string, password: string): Account {
  const account: Account = {
    email: email.trim(),
    name: '',
    city: null,
    units: 'celsius',
    notifications: false,
    trialEndsAt: Date.now() + 14 * DAY,
    alerts: 0,
  };
  register(email, password, account);
  session.set(account);
  return account;
}

export function signIn(email: string, password: string): boolean {
  const entry = accounts.get(email.trim().toLowerCase());
  if (!entry || entry.password !== password) return false;
  session.set(entry.account);
  return true;
}

export function signOut() {
  session.set(null);
}

export function updateAccount(patch: Partial<Account>) {
  const current = session.get();
  if (!current) return;
  const next = { ...current, ...patch };
  const entry = accounts.get(current.email.toLowerCase());
  if (entry) entry.account = next;
  session.set(next);
}

export function trialDaysLeft(account: Account, now = Date.now()): number {
  return Math.max(0, Math.ceil((account.trialEndsAt - now) / DAY));
}

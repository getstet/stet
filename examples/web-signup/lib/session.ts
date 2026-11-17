import { useSyncExternalStore } from 'react';

export interface Project {
  id: string;
  name: string;
  updated: string;
}

export interface User {
  name: string;
  email: string;
  prefs: { updates: boolean; summary: boolean };
  projects: Project[];
}

// Fake local auth: the signed-in user lives in this browser's storage and
// nowhere else.
const STORAGE_KEY = 'taskboard.session';
const listeners = new Set<() => void>();
let cached: { raw: string | null; user: User | null } | undefined;

function read(): User | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (cached === undefined || cached.raw !== raw) {
    let user: User | null = null;
    try {
      user = raw === null ? null : (JSON.parse(raw) as User);
    } catch {
      user = null;
    }
    cached = { raw, user };
  }
  return cached.user;
}

function write(user: User | null) {
  try {
    if (user === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // Storage blocked: the session lasts as long as the page.
  }
  cached = { raw: user === null ? null : JSON.stringify(user), user };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The signed-in user; null when signed out, undefined until the browser has been read. */
export function useSession(): User | null | undefined {
  return useSyncExternalStore<User | null | undefined>(subscribe, read, () => undefined);
}

export function signIn(user: User) {
  write(user);
}

export function signOut() {
  write(null);
}

export function updateUser(patch: Partial<User>) {
  const user = read();
  if (user !== null) write({ ...user, ...patch });
}

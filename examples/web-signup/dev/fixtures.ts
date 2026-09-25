import type { Outcome } from '@/lib/api';
import type { User } from '@/lib/session';

// The seeded accounts and fixtures the points in stet.flows.json name.
// Development builds only.

const returning: User = {
  name: 'Maya Chen',
  email: 'maya@example.com',
  prefs: { updates: true, summary: false },
  projects: [
    { id: 'spring-launch', name: 'Spring launch', updated: '24 Sep' },
    { id: 'help-centre', name: 'Help centre refresh', updated: '19 Sep' },
    { id: 'onboarding-emails', name: 'Onboarding emails', updated: '2 Sep' },
  ],
};

export const ACCOUNTS: Record<string, User> = {
  new: { name: 'Sam Rivera', email: 'sam@example.com', prefs: { updates: true, summary: false }, projects: [] },
  returning,
  'long-name': { ...returning, name: 'Alexandria Featherstonehaugh-Worthington', email: 'alexandria@example.com' },
};

export interface Fixture {
  outcomes?: Partial<Record<'signUp' | 'saveSettings', Outcome>>;
  seeds?: Record<string, unknown>;
}

const samDetails = { name: 'Sam Rivera', email: 'sam@example.com', submit: true };

export const FIXTURES: Record<string, Fixture> = {
  'signup-invalid': { seeds: { '/signup': { name: 'Sam Rivera', email: 'sam@example', submit: true } } },
  'signup-sending': { outcomes: { signUp: 'pending' }, seeds: { '/signup': samDetails } },
  'signup-joined': { outcomes: { signUp: 'ok' }, seeds: { '/signup': samDetails } },
  'signup-unavailable': { outcomes: { signUp: 'unavailable' }, seeds: { '/signup': samDetails } },
  'settings-saved': { outcomes: { saveSettings: 'ok' }, seeds: { '/settings': { name: 'Maya C.', submit: true } } },
  'settings-leaving': { seeds: { '/settings': { name: 'Maya C.', leaving: '/dashboard' } } },
  'settings-edited': { seeds: { '/settings': { name: 'Maya C.' } } },
};

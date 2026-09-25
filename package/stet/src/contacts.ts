/**
 * The contacts rules every surface applies the same way — the forms handler's
 * join route, the CLI's `group add` and `import`, and every adapter's
 * `addGroup`: what an address is, what a group key is, what a group may ask,
 * and whether a set of answers is what a group asks. Pure, like the rest of
 * `src/`.
 */

import type { GroupProperty } from './store.js';

/** URL-shaped: the join route's last path segment (Mirra's list-key grammar). */
export const GROUP_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A form's name as the join route stores it: `waitlist-page`, `consent_label@v12`. */
export const FORM_KEY = /^[A-Za-z0-9._@:-]{1,100}$/;
/** A declared question's name. */
export const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The characters a terminal acts on: C0 and C1 controls (NUL, CR, LF, ESC and
 * the rest) and the bidirectional overrides. A stranger types the address and
 * the answers, and `stet contacts` prints them, so neither may hold one;
 * `cli/report.ts` replaces the same class in every line it prints. No `g`
 * flag: a `.test()` caller would carry `lastIndex` between calls.
 */
export const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/**
 * Half a UTF-16 surrogate pair with no other half. A JSON body can carry one
 * (`"\ud800"`), and no text encoding can store it, so Postgres refuses the row
 * the route would write. Under `u` a paired surrogate is one code point, so
 * only a lone one matches \u2014 `isWellFormed()` is ES2024, past this build's lib.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export const EMAIL_MAX = 254;
export const ANSWER_MAX = 500;
export const PAGE_MAX = 2000;

/** The address, trimmed and lowercased — the form every contacts table stores. */
export function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether a NORMALIZED address is shaped like one (Mirra's pattern, the length bound, no control character, well-formed text). */
export function isEmail(email: string): boolean {
  return (
    email.length <= EMAIL_MAX &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    !CONTROL_CHARACTERS.test(email) &&
    !LONE_SURROGATE.test(email)
  );
}

export type AnswersCheck =
  | { ok: true; properties: Record<string, string> }
  | { ok: false; property: string | null; reason: string; missing: boolean };

/**
 * Answers against a group's declaration. Every answer must be a question the
 * group asks (an undeclared one is refused, never stored), a string, one of an
 * enum's values, at most 500 characters, well-formed text and free of control
 * characters but the line feed a multi-line text field sends; an empty answer
 * counts as absent;
 * a required question must be answered. The result keeps the declaration's
 * order. Membership is own-property only: a key named `constructor` is refused
 * unless a group really declares it.
 */
export function checkAnswers(declared: GroupProperty[], raw: unknown): AnswersCheck {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, property: null, reason: 'the answers must be an object', missing: false };
  }
  const given = raw as Record<string, unknown>;
  const byName = new Map(declared.map((d) => [d.name, d]));
  for (const name of Object.keys(given)) {
    if (!byName.has(name)) return { ok: false, property: name, reason: 'not a question this group asks', missing: false };
  }
  const properties: Record<string, string> = {};
  for (const d of declared) {
    const value = Object.hasOwn(given, d.name) ? given[d.name] : undefined;
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, property: d.name, reason: 'must be text', missing: false };
    }
    const answer = (value ?? '').trim();
    if (answer === '') {
      if (d.required === true) return { ok: false, property: d.name, reason: 'is required', missing: true };
      continue;
    }
    if (d.type === 'enum' && !(d.values ?? []).includes(answer)) {
      return { ok: false, property: d.name, reason: `must be one of ${(d.values ?? []).join(', ')}`, missing: false };
    }
    if (answer.length > ANSWER_MAX) {
      return { ok: false, property: d.name, reason: `longer than ${ANSWER_MAX} characters`, missing: false };
    }
    if (CONTROL_CHARACTERS.test(answer.replace(/\n/g, ''))) {
      return { ok: false, property: d.name, reason: 'holds a control character', missing: false };
    }
    if (LONE_SURROGATE.test(answer)) {
      return { ok: false, property: d.name, reason: 'is not well-formed text', missing: false };
    }
    properties[d.name] = answer;
  }
  return { ok: true, properties };
}

/** The fields a declared question may carry. */
const DECLARATION_FIELDS = new Set(['name', 'type', 'values', 'required']);

/**
 * A group's declared questions, checked the one way `group add` and every
 * adapter's `addGroup` check them: a list of questions, each named by
 * `PROPERTY_NAME` and named once, carrying no field but the four, an enum
 * listing its values with no blank, padded, repeated or control-character
 * one (`stet contacts` prints them), a text question listing none, and
 * `required` true or false where given. The first fault as a phrase that
 * follows a flag or a prefix (`tier: the values are …`), or null.
 */
export function checkDeclaration(properties: unknown): string | null {
  if (!Array.isArray(properties)) return 'the properties must be a list';
  const seen = new Set<string>();
  for (const [i, raw] of properties.entries()) {
    const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof GroupProperty, unknown>>;
    if (typeof p.name !== 'string') return `property ${i + 1} has no name`;
    const name = p.name;
    if (!PROPERTY_NAME.test(name)) return `${name}: a name is lowercase letters, digits and _, starting with a letter`;
    if (seen.has(name)) return `${name} is given twice`;
    seen.add(name);
    const unknown = Object.keys(p).find((field) => !DECLARATION_FIELDS.has(field));
    if (unknown !== undefined) return `${name}: ${unknown} is not a field of a declaration (name, type, values, required)`;
    if (p.type !== 'enum' && p.type !== 'text') return `${name}: the type is enum or text`;
    if (p.type === 'enum') {
      const values = p.values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((v) => typeof v !== 'string' || v === '' || v !== v.trim()) ||
        new Set(values).size !== values.length
      ) {
        return `${name}: the values are a list with no blanks or repeats`;
      }
      if (values.some((v) => CONTROL_CHARACTERS.test(v))) return `${name}: a value holds a control character`;
    } else if (p.values !== undefined) {
      return `${name}: a text property lists no values`;
    }
    if (p.required !== undefined && typeof p.required !== 'boolean') return `${name}: required is true or false`;
  }
  return null;
}

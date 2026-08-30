/**
 * The phase-1 SEO rules: eight checks over the descriptor and the committed
 * snapshot, one severity table, zero I/O. Every value the rules read is
 * resolved through the package's one resolution path with no store rows, so the
 * check sees the same text production serves — and so it runs on a fork PR with
 * no network, no database and every secret unset.
 *
 * The vocabulary is its own on purpose. `SeoRule` is not `FindingRule`: the
 * save-time rules gate one candidate value before it is stored, these audit the
 * committed whole after the fact, and putting audit rules in `validateSave`'s
 * closed union would serve no caller. Only the severity language is shared —
 * `Finding`'s `'error' | 'warning'`, so the package speaks one.
 */

import { resolve } from './resolve.js';
import type { Snapshot } from './snapshot.js';
import { webTarget } from './targets/web.js';
import type { Descriptor, PageDef } from './types.js';

export type SeoRule =
  | 'missing-description'
  | 'duplicate-title'
  | 'over-length'
  | 'canonical-noindex'
  | 'visible-content'
  | 'missing-alt'
  | 'anchor-text'
  | 'machine-field';

export interface SeoFinding {
  rule: SeoRule;
  severity: 'error' | 'warning';
  /** The page a finding is about, where it is about one. */
  page?: string;
  /** The content key at fault, where one is. */
  key?: string;
  locale?: string;
  message: string;
}

/**
 * The one severity table (§13.1c): six errors, two warns. A project may flip a
 * rule either way through `stet.config.json`'s `seoCheck` block; there is no
 * third state, because a warn already never gates and an `off` would only add
 * surface. It doubles as the runtime rule list — `id in SEO_SEVERITY` is what
 * the config validator tests membership with, a type having no `.includes`.
 */
export const SEO_SEVERITY: Record<SeoRule, 'error' | 'warning'> = {
  'missing-description': 'error',
  'duplicate-title': 'error',
  'over-length': 'error',
  'canonical-noindex': 'error',
  'visible-content': 'error',
  'missing-alt': 'error',
  'anchor-text': 'warning',
  'machine-field': 'warning',
};

/**
 * The phase-1 bounds, and they are approximations: Google truncates a SERP
 * entry by PIXELS — roughly 600px for a desktop title, 920px for a description
 * — so sixty narrow characters can survive where fifty wide ones do not. The
 * font-metrics table that would measure it properly ships as a static asset in
 * phase 2 (§16); until then the caveat is stated here and in the operator doc.
 */
const TITLE_MAX_CHARS = 60;
const DESCRIPTION_MAX_CHARS = 160;

/**
 * The generic-anchor list, shipped inside the package because the check is
 * offline. Pack-configurable lists arrive with `add-packs`; until then this is
 * the list, and it is matched against a WHOLE value rather than searched for
 * inside one — see `anchorText`.
 */
const GENERIC_ANCHORS: readonly string[] = [
  'click here',
  'here',
  'learn more',
  'read more',
  'more',
  'see more',
  'this page',
  'link',
  'check it out',
];

/**
 * Imperative and incentive shapes that must not reach a machine-only field.
 * Markup written to steer a machine reader rather than describe the page is a
 * Google policy violation, and stet will not ship the tactic.
 */
const MACHINE_IMPERATIVES: readonly string[] = [
  'buy now',
  'order now',
  'act now',
  'sign up now',
  'subscribe now',
  'call now',
  'visit now',
  'limited time',
  'best ever',
  'top rated',
  '#1',
];

/** `noindex` as a directive, not as a substring of a longer word. */
const NOINDEX = /\bnoindex\b/i;

/**
 * No regex-escape helper exists anywhere in the package, so this is a local
 * one. Purely defensive against today's list — no pinned phrase carries a regex
 * special — and load-bearing the moment pack-configurable lists arrive.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One matcher per phrase, compiled once.
 *
 * The word boundaries exist only where the phrase itself starts or ends with a
 * word character: `\b` before `#` asserts a word character precedes it, so
 * `/\b#1\b/` matches nothing at all — while a bare substring test on `#1` fires
 * on `#16`. The asymmetric form is what makes "The #1 plan" a hit and "#16" a
 * miss. No `g` flag, so `.test` carries no state between calls.
 */
const MACHINE_PATTERNS: ReadonlyArray<{ phrase: string; pattern: RegExp }> = MACHINE_IMPERATIVES.map(
  (phrase) => ({
    phrase,
    pattern: new RegExp(
      `${/^\w/.test(phrase) ? '\\b' : ''}${escapeRegExp(phrase)}${/\w$/.test(phrase) ? '\\b' : ''}`,
      'i',
    ),
  }),
);

/**
 * Every rule's verdict on a descriptor and its committed snapshot. `overrides`
 * is applied to the severity table first, so every finding carries its
 * EFFECTIVE severity and the caller's exit contract is a filter, not a second
 * lookup.
 */
export function seoCheck(
  d: Descriptor,
  snapshot: Snapshot,
  overrides?: Partial<Record<SeoRule, 'error' | 'warning'>>,
): SeoFinding[] {
  const severity: Record<SeoRule, 'error' | 'warning'> = { ...SEO_SEVERITY, ...overrides };
  const findings: SeoFinding[] = [];
  const emit: Emit = (rule, message, about = {}) => {
    findings.push({ rule, severity: severity[rule], ...about, message });
  };

  pageRules(d, snapshot, emit);
  anchorText(d, snapshot, emit);
  machineField(d, snapshot, emit);
  return findings;
}

type Emit = (
  rule: SeoRule,
  message: string,
  about?: { page?: string; key?: string; locale?: string },
) => void;

/**
 * The resolved value of a key, raw.
 *
 * `resolve` with no rows is derived-then-snapshot — the read path's own order,
 * one derivation home — and `[]` means the same thing to it as `null`. The raw
 * form is what the rules that walk list entries need: a robots record is
 * naturally a list of directives, and a string-only accessor would type-check
 * against it silently while the entry walk never ran.
 */
function resolvedValue(d: Descriptor, s: Snapshot, key: string, locale: string): unknown {
  return resolve(d, s, [], { key, locale }).value;
}

/**
 * The resolved value as usable copy: a string whose trim is non-empty, else
 * `undefined`. The page-scoped rules read through this, so "resolves to nothing
 * or an empty string" covers a whitespace-only value too.
 */
function resolvedString(
  d: Descriptor,
  s: Snapshot,
  key: string,
  locale: string,
): string | undefined {
  const value = resolvedValue(d, s, key, locale);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The locale, named only where naming it says something. */
function at(locale: string): string {
  return locale === 'default' ? '' : ` (${locale})`;
}

/**
 * One trailing slash off both sides, so `/pricing/` and `/pricing` are one
 * route. Exported for the route detector, which compares what a host's routing
 * convention serves against what the descriptor declares — one trim, so the two
 * cannot disagree about whether `/pricing/` is `/pricing`.
 */
export function route(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/** A member of a duplicate-title group: the page, and the key its title came from. */
interface TitleMember {
  page: string;
  key: string;
}

/**
 * The page-scoped rules, in one walk over pages × their declared locales:
 * missing-description, over-length, missing-alt and canonical-noindex, plus the
 * title collection duplicate-title groups from. `visible-content` rides the
 * same walk but sits outside the locale loop — a JSON-LD binding is a
 * descriptor fact, and reporting it once per locale would multiply one bug.
 */
function pageRules(d: Descriptor, s: Snapshot, emit: Emit): void {
  const titles = new Map<string, { locale: string; title: string; members: TitleMember[] }>();

  for (const [page, def] of Object.entries(d.pages ?? {})) {
    for (const locale of def.locales ?? ['default']) {
      const titleKey = def.seo?.title;
      const title = titleKey === undefined ? undefined : resolvedString(d, s, titleKey, locale);
      const descriptionKey = def.seo?.description;
      const description =
        descriptionKey === undefined ? undefined : resolvedString(d, s, descriptionKey, locale);

      if (titleKey !== undefined && title !== undefined) {
        // A page with no resolvable title joins no group: a missing title is
        // not a row of the severity table, and grouping the absences together
        // would invent one.
        const id = JSON.stringify([locale, title]);
        const group = titles.get(id) ?? { locale, title, members: [] };
        group.members.push({ page, key: titleKey });
        titles.set(id, group);
      }

      missingDescription(emit, page, locale, descriptionKey, description);
      overLength(emit, page, locale, titleKey, title, 'title', TITLE_MAX_CHARS);
      overLength(emit, page, locale, descriptionKey, description, 'description', DESCRIPTION_MAX_CHARS);
      missingAlt(d, s, emit, page, def, locale);
      canonicalNoindex(d, s, emit, page, def, locale);
    }

    visibleContent(d, emit, page, def);
  }

  duplicateTitle(d, emit, titles);
}

/**
 * Every declared page needs a description, and it must resolve to something.
 * Two causes, two messages: an unreferenced field is a descriptor edit, an
 * unresolvable reference is a publish.
 */
function missingDescription(
  emit: Emit,
  page: string,
  locale: string,
  key: string | undefined,
  description: string | undefined,
): void {
  if (key === undefined) {
    emit(
      'missing-description',
      `page "${page}" declares no SEO description — name the content key that carries it in the page's seo record`,
      { page, locale },
    );
    return;
  }
  if (description === undefined) {
    emit(
      'missing-description',
      `page "${page}"${at(locale)}: its description key "${key}" resolves to nothing — publish a value or point the reference elsewhere`,
      { page, key, locale },
    );
  }
}

/**
 * The character bound, for whichever field was handed over. It fires on the
 * RESOLVED value, which is the whole point: a valid headline pushed over the
 * limit by its derivation template is a bug no external crawler could
 * attribute, because the crawler never sees the template.
 */
function overLength(
  emit: Emit,
  page: string,
  locale: string,
  key: string | undefined,
  value: string | undefined,
  field: 'title' | 'description',
  max: number,
): void {
  if (key === undefined || value === undefined || value.length <= max) return;
  emit(
    'over-length',
    `page "${page}"${at(locale)}: its ${field} resolves through "${key}" to ${value.length} characters, over the ${max}-character bound`,
    { page, key, locale },
  );
}

/** An OG image without alt text. Alt text is copy, and it is the field the web misses most. */
function missingAlt(
  d: Descriptor,
  s: Snapshot,
  emit: Emit,
  page: string,
  def: PageDef,
  locale: string,
): void {
  const imageKey = def.seo?.ogImage;
  if (imageKey === undefined || resolvedString(d, s, imageKey, locale) === undefined) return;
  const altKey = def.seo?.ogImageAlt;
  if (altKey !== undefined && resolvedString(d, s, altKey, locale) !== undefined) return;
  emit(
    'missing-alt',
    `page "${page}"${at(locale)}: its OG image "${imageKey}" has no resolving alt text — alt text is copy, not a technical field`,
    { page, key: imageKey, locale },
  );
}

/**
 * A canonical override pointing at a page the same project marks `noindex`.
 * A canonical resolving to no declared page is deliberately out of scope: the
 * framework computes canonicals and stet audits only the override, so a route
 * stet does not know about is not stet's to judge.
 */
function canonicalNoindex(
  d: Descriptor,
  s: Snapshot,
  emit: Emit,
  page: string,
  def: PageDef,
  locale: string,
): void {
  const key = def.seo?.canonical;
  const canonical = key === undefined ? undefined : resolvedString(d, s, key, locale);
  if (key === undefined || canonical === undefined) return;

  for (const [target, targetDef] of Object.entries(d.pages ?? {})) {
    if (route(targetDef.route) !== route(canonical)) continue;
    if (!noindexes(d, s, targetDef, locale)) continue;
    emit(
      'canonical-noindex',
      `page "${page}"${at(locale)} canonicalizes to "${canonical}", the route of page "${target}", which is noindex — a canonical to an unindexable page deindexes both`,
      { page, key, locale },
    );
  }
}

/**
 * Whether a page's robots record carries `noindex`, in EITHER shape: the value
 * may be one string, or a list — §13.1c's directive set (`nosnippet`,
 * `max-snippet`, …) is naturally a list, and a string-only test would silently
 * never fire on the shape the field usually takes.
 */
function noindexes(d: Descriptor, s: Snapshot, def: PageDef, locale: string): boolean {
  const key = def.seo?.robots;
  if (key === undefined) return false;
  const value = resolvedValue(d, s, key, locale);
  if (typeof value === 'string') return NOINDEX.test(value);
  if (!Array.isArray(value)) return false;
  return value.some((entry) => typeof entry === 'string' && NOINDEX.test(entry));
}

/**
 * Markup must represent visible content, on pain of a manual action. The
 * registry is what makes it checkable: a key declares the pages it renders on,
 * so a binding to a key that never renders on the bound page is provable from
 * the descriptor alone.
 */
function visibleContent(d: Descriptor, emit: Emit, page: string, def: PageDef): void {
  for (const [field, key] of Object.entries(def.jsonLd?.bindings ?? {})) {
    if ((d.keys[key]?.pages ?? []).includes(page)) continue;
    emit(
      'visible-content',
      `page "${page}" binds JSON-LD field "${field}" to "${key}", which does not render on that page — markup must represent visible content`,
      { page, key },
    );
  }
}

/**
 * Duplicated titles within one locale. When every member of a colliding group
 * derives through one identical template, the TEMPLATE is the unit of blame and
 * the finding names it once — forty pages sharing a template is one bug, not
 * forty. A mixed group names its pages, because there is nothing else to fix.
 */
function duplicateTitle(
  d: Descriptor,
  emit: Emit,
  titles: Map<string, { locale: string; title: string; members: TitleMember[] }>,
): void {
  for (const { locale, title, members } of titles.values()) {
    if (members.length < 2) continue;
    const templates = members.map((m) => d.keys[m.key]?.tmpl);
    const shared = templates[0];
    if (shared !== undefined && templates.every((t) => t === shared)) {
      emit(
        'duplicate-title',
        `the derivation template "${shared}" resolves to "${title}"${at(locale)} on ${members.length} pages — fix the template, not the pages`,
        { locale },
      );
      continue;
    }
    emit(
      'duplicate-title',
      `pages ${members.map((m) => `"${m.page}"`).join(', ')} share the title "${title}"${at(locale)} — a duplicate title makes them one result`,
      { locale },
    );
  }
}

/**
 * Generic link labels, warn-level. The match is on a WHOLE value: a value that
 * IS "Learn more" is a label, while a sentence containing the phrase is prose,
 * and substring matching would drown the warn in false positives. No link-label
 * marker exists in the descriptor yet, so the scope is web-targeted keys —
 * §13.1c's rule is about anchors on pages, and an email subject reading "Click
 * here" is the email lints' business.
 */
function anchorText(d: Descriptor, s: Snapshot, emit: Emit): void {
  for (const [key, def] of Object.entries(d.keys)) {
    // The adapter's own name, never the literal: no consumer branches on a
    // target name, which is what keeps "one adapter file plus one registry row"
    // true (`src/targets/adapter.ts`, and `validate.ts` names web the same way).
    if (def.target !== webTarget.name) continue;
    if (def.shape !== 'text' && def.shape !== 'list') continue;
    for (const locale of localesOf(s, key)) {
      const value = resolvedValue(d, s, key, locale);
      for (const { path, text } of strings(key, value)) {
        if (!GENERIC_ANCHORS.includes(text.trim().toLowerCase())) continue;
        emit(
          'anchor-text',
          `${path}${at(locale)}: "${text}" is a generic link label — anchor text should name where it goes`,
          { key: path, locale },
        );
      }
    }
  }
}

/**
 * Imperative or incentive copy in a machine-only field, warn-level. Scope is
 * the keys bound in some page's JSON-LD — the one machine surface that exists
 * today; `llms.txt` and MCP descriptions join it when those surfaces do. One
 * finding per page × field × key × locale, naming the first phrase that hit, so
 * a value carrying three of them is still one thing to fix.
 */
function machineField(d: Descriptor, s: Snapshot, emit: Emit): void {
  for (const [page, def] of Object.entries(d.pages ?? {})) {
    for (const [field, key] of Object.entries(def.jsonLd?.bindings ?? {})) {
      for (const locale of localesOf(s, key)) {
        const value = resolvedValue(d, s, key, locale);
        const hit = strings(key, value)
          .flatMap(({ text }) => MACHINE_PATTERNS.filter(({ pattern }) => pattern.test(text)))
          .at(0);
        if (hit === undefined) continue;
        emit(
          'machine-field',
          `page "${page}"${at(locale)} binds JSON-LD field "${field}" to "${key}", whose value carries "${hit.phrase}" — machine-only fields describe the page, they do not sell it`,
          { page, key, locale },
        );
      }
    }
  }
}

/**
 * The locales a key-scoped lint audits: every locale the snapshot carries —
 * the check audits ALL committed copy — minus any non-`default` locale where
 * the key has no value of its OWN.
 *
 * The skip is what keeps one committed value from warning once per locale: the
 * locale chain resolves a missing `de` value to the `default` one, so without
 * it a single offending entry reports twice. `resolve` does not say which
 * locale it landed on, which is why the snapshot lookup is the direct test. A
 * genuinely `de`-only value still warns, attributed to `de`.
 *
 * A DERIVED key therefore scans in `default` only — it never carries an own
 * value in any locale — even where its derivation source is per-locale. That is
 * a stated decision, not an oversight: the miss is warn-level, the source key
 * the author would edit still fires under its own name, and i18n is out for v1.
 * The locale work revisits it. Do not "fix" it by dropping the skip, which
 * trades this for a duplicate on every committed value.
 */
function localesOf(s: Snapshot, key: string): string[] {
  return Object.keys(s).filter((locale) => locale === 'default' || s[locale]?.[key] !== undefined);
}

/**
 * The strings inside a resolved value, entry-pathed as `key[i]` for a list —
 * the same path grammar `src/validate.ts` reports findings under.
 */
function strings(key: string, value: unknown): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path: key, text: value }];
  if (!Array.isArray(value)) return [];
  const found: Array<{ path: string; text: string }> = [];
  value.forEach((entry, index) => {
    if (typeof entry === 'string') found.push({ path: `${key}[${index}]`, text: entry });
  });
  return found;
}

/**
 * What a key is and where it sits, in words: the element kinds the dashboard
 * shows, and the role name `register` gives a key it adds.
 *
 * One vocabulary serves both. The marks route sends each place's kind to the
 * page, so the page shows the words this module holds, and a role name is the
 * same word written with underscores — `share description` on the page is
 * `share_description` in `home_share_description`.
 *
 * A role name is up to four parts: the page, the nearest section, the role and
 * a number where the same page, section and role repeat within one run. It
 * records where adoption found the element. Nothing moves the key when the page
 * changes; `stet rename` is how a name that stops describing its place changes.
 */

// A leaf: it imports nothing at runtime, so every module that names or words a
// key — html-host, source-scan, pages, register, scan, rename, the dashboard's
// routes — can import it without closing a ring.

/** Where a key renders: a file and line, and the element's tag and attribute where stet can read them. */
export interface Place {
  file: string;
  line: number;
  tag?: string;
  attr?: string;
  meta?: string;
  /** A `<title>` inside an `<svg>`: the graphic's name, which a browser shows as a tooltip. */
  svg?: true;
}

const HEAD_META: Record<string, string> = {
  description: 'meta description',
  'og:title': 'share title',
  'twitter:title': 'share title',
  'og:description': 'share description',
  'twitter:description': 'share description',
};
const ATTR_KINDS: Record<string, string> = {
  alt: 'image alt text',
  'aria-label': 'aria label',
  title: 'tooltip',
  placeholder: 'placeholder',
};
const TAG_KINDS: Record<string, string> = {
  p: 'paragraph',
  a: 'link text',
  button: 'button text',
  li: 'list item',
  title: 'page title',
};

/** Every kind word the tables and rules give, which a component's prop must not spell. */
const VOCABULARY: ReadonlySet<string> = new Set([
  ...Object.values(HEAD_META),
  ...Object.values(ATTR_KINDS),
  ...Object.values(TAG_KINDS),
  'headline',
]);

/** `<meta name=…>` values whose `content` is copy. */
export const META_NAME_COPY: ReadonlySet<string> = new Set(['description', 'twitter:title', 'twitter:description']);
/** `<meta property=…>` values whose `content` is copy. A URL-valued meta (`og:url`) is never one. */
export const META_PROPERTY_COPY: ReadonlySet<string> = new Set(['og:title', 'og:description']);

/**
 * The `name` or `property` a `<meta>`'s `content` is copy under, or null — the
 * one reading for the static-HTML host's elements and the JSX walk's.
 */
export function metaCopyNameOf(tag: string, attr: (name: string) => string | undefined): string | null {
  if (tag !== 'meta') return null;
  const name = attr('name');
  if (name !== undefined && META_NAME_COPY.has(name)) return name;
  const property = attr('property');
  if (property !== undefined && META_PROPERTY_COPY.has(property)) return property;
  return null;
}

/** The kinds that name a head text, which carries no section in its role name. */
export const HEAD_KINDS: ReadonlySet<string> = new Set(['page title', 'meta description', 'share title', 'share description']);

/**
 * A place's kind in the page's words. A kind word where one exists; a
 * component's prop as the component and the prop (`<Card title>` is
 * `card title`), since the prop is the component's own and never an HTML
 * attribute's kind; otherwise `text in <tag>`, `<attr> attribute`, or
 * `text in <file>` where stet read no element at all. Own-property reads
 * throughout: a tag, attribute or meta name comes out of the host's markup, and
 * `constructor` is a legal tag name.
 */
export function kindOf(place: Place): string {
  if (place.svg === true && place.tag === 'title') return 'tooltip';
  const attr = attrOf(place);
  if (attr !== undefined && place.tag !== undefined && /^[A-Z]/.test(place.tag)) {
    // A prop whose words spell a kind of the vocabulary (`<Page title>`) says
    // it is a prop, so it never reads as the page's own `<title>`.
    const prop = `${wordsOf(place.tag)}_${wordsOf(attr)}`.replace(/_/g, ' ');
    return VOCABULARY.has(prop) ? `${prop} prop` : prop;
  }
  if (attr === 'content' && place.meta !== undefined && Object.hasOwn(HEAD_META, place.meta)) {
    return HEAD_META[place.meta] as string;
  }
  if (attr !== undefined) {
    return Object.hasOwn(ATTR_KINDS, attr) ? (ATTR_KINDS[attr] as string) : `${attr} attribute`;
  }
  if (place.tag === undefined) return `text in ${place.file}`;
  if (/^h[1-6]$/.test(place.tag)) return 'headline';
  return Object.hasOwn(TAG_KINDS, place.tag) ? (TAG_KINDS[place.tag] as string) : `text in <${place.tag}>`;
}

/** A place's attribute without a Vue binding prefix: `:title` and `v-bind:title` are `title`. */
function attrOf(place: Place): string | undefined {
  return place.attr?.replace(/^(?::|v-bind:)/, '');
}

/**
 * The role part of a name: the kind word written as words where the vocabulary
 * has one — a component's prop included (`card_title`) — else the element's
 * own tag name (`span`), else the attribute's (operator, 2026-09-25: an element
 * without a kind word is named by its tag). A component tag (`PricingCard`) is
 * written as its words (`pricing_card`). At most {@link BASE_MAX} characters,
 * cut on a word boundary.
 */
export function roleOf(place: Place): string {
  const kind = kindOf(place);
  const word =
    !kind.startsWith('text in ') && !kind.endsWith(' attribute')
      ? wordsOf(kind)
      : wordsOf(attrOf(place) ?? place.tag ?? '');
  return firstWords(word === '' ? 'text' : word, Infinity, BASE_MAX);
}

/** Whether a place is a head text: the page title, the meta description or a share text. */
export function isHeadKind(place: Place): boolean {
  return HEAD_KINDS.has(kindOf(place));
}

/**
 * Text as descriptor words: camel case split (`PricingCard` → `pricing_card`),
 * lowercase ASCII letters and digits, every other run one `_`, none at either
 * end. The one spelling a page name, a section word and a role share.
 */
export function wordsOf(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** A descriptor name part: lowercase letters and digits in words joined by single underscores. */
export const NAME_PART = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** The first `words` words of a text, cut on a word boundary at `max` characters. */
export function firstWords(text: string, words: number, max: number): string {
  const parts = wordsOf(text).split('_').filter((w) => w !== '').slice(0, words);
  let out = '';
  for (const word of parts) {
    const next = out === '' ? word : `${out}_${word}`;
    if (next.length > max) break;
    out = next;
  }
  // A first word longer than `max` takes the hard cut, as `proposeKey` does.
  return out !== '' ? out : (parts[0] ?? '').slice(0, max);
}

/** A section word: three words, 24 characters. */
export const SECTION_WORDS = 3;
export const SECTION_MAX = 24;
/** A role name before its number: 48 characters. */
export const BASE_MAX = 48;
/** The fixed section word where an element sits in no section (operator, 2026-09-25). */
export const NO_SECTION = 'page';
/** The page word for a key marked in more than one document. */
export const SITE_PAGE = 'site';

/** The elements that name a section by their `id`, or by their own tag name where they carry none. */
export const SECTION_LANDMARKS: ReadonlySet<string> = new Set(['header', 'footer', 'nav']);
/** The elements that name a section by their `id`, or by their first heading's first words. */
export const SECTION_HEADED: ReadonlySet<string> = new Set(['section', 'article', 'aside']);

/** One element on the way up from a marked element, as the section rule reads it. */
export interface SectionNode {
  tag: string;
  /** Its `id`, where the source gives a literal one. */
  id(): string | undefined;
  /** Its first heading's text, all of it, in order. */
  heading(): string | undefined;
}

/**
 * The section word a key is named under (operator, 2026-09-25), over the chain
 * from the marked element up: the nearest `header`, `footer`, `nav`, `section`,
 * `article` or `aside`, the element itself included, by its `id`; else a
 * landmark by its own name; else a `section`, `article` or `aside` by its first
 * heading's first three words. One with none of them passes the question to its
 * parent, and `main` never answers: it is the page itself. `null` where nothing
 * answers. The static-HTML host and the JSX walk each hand their own chain.
 */
export function sectionWord(chain: Iterable<SectionNode>): string | null {
  for (const at of chain) {
    if (!SECTION_LANDMARKS.has(at.tag) && !SECTION_HEADED.has(at.tag)) continue;
    const id = at.id();
    const fromId = id === undefined ? '' : firstWords(id, SECTION_WORDS, SECTION_MAX);
    if (fromId !== '') return fromId;
    if (SECTION_LANDMARKS.has(at.tag)) return at.tag;
    const heading = at.heading();
    const words = heading === undefined ? '' : firstWords(heading, SECTION_WORDS, SECTION_MAX);
    if (words !== '') return words;
  }
  return null;
}

/** The parts of a role name before it is joined and numbered. */
export interface NameParts {
  /** Absent for a component file, which renders wherever it is used. */
  page?: string;
  /** Absent for a head text; `null` where no section answers, which takes {@link NO_SECTION}. */
  section?: string | null;
  role: string;
}

/**
 * A role name before its number: the parts joined by `_`, at most
 * {@link BASE_MAX} characters. Past it the section loses words from its end,
 * then the page from its start, then whatever is left is cut on a word
 * boundary; the role is never cut here, being capped by `roleOf`. A name that
 * would open with a digit takes {@link NO_SECTION} in front, since
 * `copy.2026_x` is no JavaScript a host could write.
 */
export function baseName(parts: NameParts): string {
  let page = parts.page === undefined ? [] : parts.page.split('_').filter((w) => w !== '');
  let section =
    parts.section === undefined ? [] : (parts.section ?? NO_SECTION).split('_').filter((w) => w !== '');
  const join = (): string => [...page, ...section, parts.role].join('_');
  while (join().length > BASE_MAX && section.length > 1) section = section.slice(0, -1);
  while (join().length > BASE_MAX && page.length > 1) page = page.slice(1);
  if (join().length > BASE_MAX) section = [];
  if (join().length > BASE_MAX) page = [];
  const joined = join();
  return /^[0-9]/.test(joined) ? firstWords(`${NO_SECTION}_${joined}`, Infinity, BASE_MAX) : joined;
}

/**
 * Final names for a run's keys, in the run's order. A base that occurs once,
 * whose name and whose `_1` are both free, keeps its name. Every other base is
 * a numbered group (fork 5): its members are numbered in order from the next
 * free number — from 1 where the bare name is free, from 2 where a key the
 * descriptor declared before the run holds it, so the bare one reads as the
 * group's first — and a number `taken` answers true for is skipped.
 */
export function numberNames(bases: readonly string[], taken: (name: string) => boolean): string[] {
  const count = new Map<string, number>();
  for (const base of bases) count.set(base, (count.get(base) ?? 0) + 1);
  const used = new Set<string>();
  const next = new Map<string, number>();
  const free = (name: string): boolean => !taken(name) && !used.has(name);
  return bases.map((base) => {
    let name = base;
    if (count.get(base) !== 1 || !free(base) || taken(`${base}_1`)) {
      let n = next.get(base) ?? (taken(base) ? 2 : 1);
      while (!free(`${base}_${n}`)) n += 1;
      name = `${base}_${n}`;
      next.set(base, n + 1);
    }
    used.add(name);
    return name;
  });
}

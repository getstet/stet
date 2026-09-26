/**
 * The vocabulary and the naming rule (cli/key-names.ts): the element kinds the
 * dashboard shows, the role a new key takes from them, the section word, and
 * how a run's names are joined and numbered.
 */
import { describe, expect, it } from 'vitest';

import {
  baseName,
  firstWords,
  kindOf,
  metaCopyNameOf,
  numberNames,
  roleOf,
  sectionWord,
  wordsOf,
  type Place,
  type SectionNode,
} from '../cli/key-names.js';
import { SECTION_WORD_ROWS } from './fixtures/section-words.js';

const at = (extra: Partial<Place>): Place => ({ file: 'index.html', line: 1, ...extra });

describe('kindOf', () => {
  it('words every row of the head-meta table', () => {
    const rows: Array<[string, string]> = [
      ['description', 'meta description'],
      ['og:title', 'share title'],
      ['twitter:title', 'share title'],
      ['og:description', 'share description'],
      ['twitter:description', 'share description'],
    ];
    for (const [meta, kind] of rows) expect(kindOf(at({ tag: 'meta', attr: 'content', meta }))).toBe(kind);
  });

  it('words every row of the attribute table', () => {
    const rows: Array<[string, string]> = [
      ['alt', 'image alt text'],
      ['aria-label', 'aria label'],
      ['title', 'tooltip'],
      ['placeholder', 'placeholder'],
    ];
    for (const [attr, kind] of rows) expect(kindOf(at({ tag: 'img', attr }))).toBe(kind);
  });

  it('words every row of the tag table, and every heading as a headline', () => {
    const rows: Array<[string, string]> = [
      ['p', 'paragraph'],
      ['a', 'link text'],
      ['button', 'button text'],
      ['li', 'list item'],
      ['title', 'page title'],
      ['h1', 'headline'],
      ['h2', 'headline'],
      ['h3', 'headline'],
      ['h4', 'headline'],
      ['h5', 'headline'],
      ['h6', 'headline'],
    ];
    for (const [tag, kind] of rows) expect(kindOf(at({ tag }))).toBe(kind);
  });

  it("reads a <title> inside an <svg> as a tooltip, the graphic's name", () => {
    expect(kindOf(at({ tag: 'title', svg: true }))).toBe('tooltip');
  });

  it('reads a Vue-bound attribute as the attribute it binds', () => {
    const rows: Array<[string, string]> = [
      [':title', 'tooltip'],
      ['v-bind:title', 'tooltip'],
      [':alt', 'image alt text'],
      [':placeholder', 'placeholder'],
      [':aria-label', 'aria label'],
      [':data-note', 'data-note attribute'],
    ];
    for (const [attr, kind] of rows) expect(kindOf(at({ tag: 'input', attr }))).toBe(kind);
    expect(roleOf(at({ tag: 'a', attr: 'v-bind:title' }))).toBe('tooltip');
    expect(roleOf(at({ tag: 'div', attr: 'v-bind:data-note' }))).toBe('data_note');
  });

  it('reads a constructor tag, attribute or meta name as plain text, never from a prototype', () => {
    expect(kindOf(at({ tag: 'constructor' }))).toBe('text in <constructor>');
    expect(kindOf(at({ tag: 'div', attr: 'constructor' }))).toBe('constructor attribute');
    expect(kindOf(at({ tag: 'meta', attr: 'content', meta: 'constructor' }))).toBe('content attribute');
  });

  it("words a component's prop as the component and the prop", () => {
    expect(kindOf(at({ tag: 'Card', attr: 'title' }))).toBe('card title');
    expect(kindOf(at({ tag: 'Image', attr: 'alt' }))).toBe('image alt');
  });

  it('says a component prop that spells a kind is a prop, so it never reads as that kind (F6)', () => {
    expect(kindOf(at({ tag: 'Page', attr: 'title' }))).toBe('page title prop');
    expect(kindOf(at({ tag: 'Meta', attr: 'description' }))).toBe('meta description prop');
    expect(kindOf(at({ tag: 'Share', attr: 'title' }))).toBe('share title prop');
    expect(kindOf(at({ tag: 'Card', attr: 'title' }))).toBe('card title');
    expect(roleOf(at({ tag: 'Page', attr: 'title' }))).toBe('page_title_prop');
  });

  it('words a place with no element as its file', () => {
    expect(kindOf(at({}))).toBe('text in index.html');
  });
});

describe('roleOf', () => {
  it('takes the kind word, underscored, where the vocabulary has one', () => {
    expect(roleOf(at({ tag: 'h3' }))).toBe('headline');
    expect(roleOf(at({ tag: 'meta', attr: 'content', meta: 'twitter:description' }))).toBe('share_description');
    expect(roleOf(at({ tag: 'img', attr: 'alt' }))).toBe('image_alt_text');
  });

  it('takes the tag name where there is no kind word, a component written as its words', () => {
    expect(roleOf(at({ tag: 'span' }))).toBe('span');
    expect(roleOf(at({ tag: 'PricingCard' }))).toBe('pricing_card');
  });

  it("takes the attribute's name where there is no kind word", () => {
    expect(roleOf(at({ tag: 'div', attr: 'data-label' }))).toBe('data_label');
  });

  it("names a component's prop by the component and the prop", () => {
    expect(roleOf(at({ tag: 'Image', attr: 'alt' }))).toBe('image_alt');
    expect(roleOf(at({ tag: 'Card', attr: 'title' }))).toBe('card_title');
  });

  it('names a place with neither tag nor attribute text', () => {
    expect(roleOf(at({}))).toBe('text');
  });

  it('caps the role at 48 characters, cut on a word boundary', () => {
    const attr = 'data-an-extremely-long-attribute-name-that-goes-on-and-on-xyz';
    expect(attr.length).toBe(61);
    const role = roleOf(at({ tag: 'div', attr }));
    expect(role.length).toBeLessThanOrEqual(48);
    expect(role).toBe('data_an_extremely_long_attribute_name_that_goes');
  });
});

describe('wordsOf and firstWords', () => {
  it('splits camel case and keeps a leading digit', () => {
    expect(wordsOf('PricingCard')).toBe('pricing_card');
    expect(wordsOf('2col')).toBe('2col');
  });

  it('cuts on a word boundary, and a single word too long takes the hard cut', () => {
    expect(firstWords('Frequently asked questions here', 3, 24)).toBe('frequently_asked');
    const long = 'abcdefghijklmnopqrstuvwxyzabcd';
    expect(long.length).toBe(30);
    expect(firstWords(long, 3, 24)).toBe(long.slice(0, 24));
  });
});

describe('metaCopyNameOf', () => {
  const attrs =
    (map: Record<string, string>) =>
    (name: string): string | undefined =>
      Object.hasOwn(map, name) ? map[name] : undefined;

  it('answers the name a meta holds copy under', () => {
    expect(metaCopyNameOf('meta', attrs({ property: 'og:description' }))).toBe('og:description');
    expect(metaCopyNameOf('meta', attrs({ name: 'description' }))).toBe('description');
  });

  it('answers null for a URL-valued meta and for any other tag', () => {
    expect(metaCopyNameOf('meta', attrs({ property: 'og:url' }))).toBeNull();
    expect(metaCopyNameOf('link', attrs({ name: 'description' }))).toBeNull();
  });
});

describe('baseName', () => {
  it('joins the page, the section and the role', () => {
    expect(baseName({ page: 'home', section: 'top', role: 'headline' })).toBe('home_top_headline');
  });

  it('spells no section as page, and a head text carries none', () => {
    expect(baseName({ page: 'home', section: null, role: 'link_text' })).toBe('home_page_link_text');
    expect(baseName({ page: 'home', role: 'page_title' })).toBe('home_page_title');
  });

  it('carries no page part for a component file', () => {
    expect(baseName({ section: 'pricing_card', role: 'headline' })).toBe('pricing_card_headline');
  });

  it('puts page_ in front of a name that would open with a digit', () => {
    expect(baseName({ page: '2026', section: 'footer', role: 'paragraph' })).toBe('page_2026_footer_paragraph');
  });

  it('cuts the section from its end, then the page from its start, to 48, the role whole', () => {
    const section = 'alpha_bravo_charlie_delta_echo_foxtrot_golf_hotel_india_juli';
    expect(section.length).toBe(60);
    // The section alone gives way: its last words go until the name fits.
    expect(baseName({ page: 'home', section, role: 'paragraph' })).toBe('home_alpha_bravo_charlie_delta_echo_paragraph');
    // A long page then loses words from its start, down to its last.
    const name = baseName({ page: 'products_enterprise_security_overview_extra', section, role: 'paragraph' });
    expect(name).toBe('security_overview_extra_alpha_paragraph');
    expect(baseName({ page: 'home', section, role: 'paragraph' }).length).toBeLessThanOrEqual(48);
  });
});

describe('numberNames', () => {
  it('numbers a repeated base from 1 in run order, and leaves a lone one bare', () => {
    expect(numberNames(['a', 'b', 'a'], () => false)).toEqual(['a_1', 'b', 'a_2']);
  });

  it('continues from 2 where the bare name is declared', () => {
    expect(numberNames(['a'], (n) => n === 'a')).toEqual(['a_2']);
    expect(numberNames(['a', 'a'], (n) => n === 'a')).toEqual(['a_2', 'a_3']);
  });

  it('numbers a lone base whose _1 is declared, skipping the taken number', () => {
    expect(numberNames(['a'], (n) => n === 'a_1')).toEqual(['a_2']);
  });
});

/**
 * The marked element's chain up a fixture row's markup, parsed with a tag
 * stack: the rows are well-formed by construction, so no tokenizer is needed.
 */
interface Node {
  tag: string;
  attrs: string;
  parent: Node | null;
  children: Array<Node | string>;
}

function chainOf(markup: string): SectionNode[] {
  const root: Node = { tag: '#root', attrs: '', parent: null, children: [] };
  let at = root;
  let marked: Node | null = null;
  const tags = /<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of markup.matchAll(tags)) {
    if (m[5] !== undefined) {
      at.children.push(m[5]);
    } else if (m[1] === '/') {
      at = at.parent as Node;
    } else {
      const node: Node = { tag: m[2] as string, attrs: m[3] as string, parent: at, children: [] };
      at.children.push(node);
      if (/\sdata-mark\b/.test(node.attrs)) marked = node;
      if (m[4] !== '/') at = node;
    }
  }
  const textOf = (node: Node): string =>
    node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
  const headingOf = (node: Node): string | undefined => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (/^h[1-6]$/.test(child.tag)) return textOf(child);
      const inner = headingOf(child);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  const chain: SectionNode[] = [];
  for (let node = marked; node !== null && node !== root; node = node.parent) {
    const here: Node = node;
    chain.push({
      tag: here.tag,
      id: () => /\sid="([^"]*)"/.exec(here.attrs)?.[1],
      heading: () => headingOf(here),
    });
  }
  return chain;
}

describe('sectionWord', () => {
  for (const row of SECTION_WORD_ROWS) {
    it(`answers the fixture row: ${row.name}`, () => {
      expect(sectionWord(chainOf(row.markup))).toBe(row.word);
    });
  }
});

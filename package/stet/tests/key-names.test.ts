/**
 * The vocabulary and the naming rule (cli/key-names.ts): the element kinds the
 * dashboard shows, the role a new key takes from them, the section word, and
 * how a run's names are joined and numbered.
 */
import { describe, expect, it } from 'vitest';

import {
  baseName,
  firstWords,
  itemReader,
  itemWord,
  kindOf,
  looseHeadingRole,
  metaCopyNameOf,
  numberNames,
  roleOf,
  sectionOf,
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

  it('joins the item between the section and the role', () => {
    expect(baseName({ page: 'home', section: 'services', item: 'card_4', role: 'headline' })).toBe(
      'home_services_card_4_headline',
    );
  });

  it('keeps the item whole while a 60-character section is cut', () => {
    const section = 'alpha_bravo_charlie_delta_echo_foxtrot_golf_hotel_india_juli';
    const name = baseName({ page: 'home', section, item: 'step_1_item_2', role: 'paragraph' });
    expect(name).toBe('home_alpha_bravo_charlie_step_1_item_2_paragraph');
    expect(name.length).toBeLessThanOrEqual(48);
  });

  it('keeps every item part and the role past 48, the item winning over the cap', () => {
    const item = 'step_1_item_2_item_3_item_4_item_5_item_6_item_7';
    const name = baseName({ page: 'home', section: 'process', item, role: 'paragraph' });
    expect(name).toBe(`${item}_paragraph`);
    expect(name.length).toBeGreaterThan(48);
    expect(name).toContain('step_1');
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
 * A fixture row's markup as a plain object tree, parsed with a tag stack: the
 * rows are well-formed by construction, so no tokenizer is needed.
 */
interface Node {
  tag: string;
  attrs: string;
  parent: Node | null;
  children: Array<Node | string>;
}

function treeOf(markup: string): { root: Node; marked: Node } {
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
  return { root, marked: marked as Node };
}

const elements = (node: Node): Node[] => node.children.filter((c): c is Node => typeof c !== 'string');
const textOf = (node: Node): string => node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const firstHeading = (node: Node): Node | undefined => {
  for (const child of elements(node)) {
    if (/^h[1-6]$/.test(child.tag)) return child;
    const inner = firstHeading(child);
    if (inner !== undefined) return inner;
  }
  return undefined;
};

/** The marked element's chain up the tree, as the section rule reads it. */
function chainOf(marked: Node | null, root: Node): SectionNode[] {
  const chain: SectionNode[] = [];
  for (let node = marked; node !== null && node !== root; node = node.parent) {
    const here: Node = node;
    chain.push({
      tag: here.tag,
      id: () => /\sid="([^"]*)"/.exec(here.attrs)?.[1],
      heading: () => {
        const found = firstHeading(here);
        return found === undefined ? undefined : textOf(found);
      },
      headingTag: () => firstHeading(here)?.tag,
    });
  }
  return chain;
}

/**
 * The item rule over the plain tree: an element carries a text where it holds
 * a text run of its own outside any text-carrying ancestor, or a copy
 * attribute — the static-HTML walk's key elements and copy attributes.
 */
function itemsOf(marked: Node, root: Node): ReturnType<ReturnType<typeof itemReader<Node>>>[] {
  const carries = (n: Node): boolean =>
    /\s(aria-label|alt|title|placeholder)="/.test(n.attrs) ||
    (n.children.some((c) => typeof c === 'string' && c.trim() !== '') &&
      !(function inside(p: Node | null): boolean {
        return p !== null && p !== root && (p.children.some((c) => typeof c === 'string' && c.trim() !== '') || inside(p.parent));
      })(n.parent));
  const all = (n: Node): Node[] => [n, ...elements(n).flatMap(all)];
  const read = itemReader<Node>({
    parentOf: (n) => (n.parent === null || n.parent === root ? undefined : n.parent),
    childrenOf: (n) => elements(n),
    tagOf: (n) => n.tag,
    textsIn: (n) => all(n).filter(carries),
  });
  const up: Node[] = [];
  for (let node: Node | null = marked; node !== null && node !== root; node = node.parent) up.push(node);
  return up.map(read);
}

describe('sectionWord', () => {
  for (const row of SECTION_WORD_ROWS) {
    it(`answers the fixture row: ${row.name}`, () => {
      const { root, marked } = treeOf(row.markup);
      const items = itemsOf(marked, root);
      const found = itemWord(items);
      expect(found?.item).toBe(row.item);
      // Inside a repeated item, the section is read above the outermost one.
      const up: Node[] = [];
      for (let node: Node | null = marked; node !== null && node !== root; node = node.parent) up.push(node);
      const from = found === null ? marked : (up[found.outermost]?.parent ?? null);
      expect(sectionWord(chainOf(from === root ? null : from, root))).toBe(row.word);
    });
  }

  it('answers the node its word came from', () => {
    const { root, marked } = treeOf('<section id="outer"><div><p data-mark>Words in a div.</p></div></section>');
    const chain = chainOf(marked, root);
    const found = sectionOf(chain);
    expect(found?.word).toBe('outer');
    expect(found?.node).toBe(chain[2]);
    expect(sectionOf(chainOf(treeOf('<main><p data-mark>No section here.</p></main>').marked, root))).toBeNull();
  });
});

describe('itemWord', () => {
  it('reads positions and headings over a plain object tree as the html walk does', () => {
    const { root, marked } = treeOf(
      '<ul><li><h3>One heading</h3><p>One text</p></li><li><h3>Two heading</h3><p data-mark>Two text</p></li><li><p>Three</p></li></ul>',
    );
    const items = itemsOf(marked, root);
    const li = items[1];
    expect(li?.tag).toBe('li');
    expect(li?.parentTag).toBe('ul');
    expect(li?.position()).toEqual({ n: 2, of: 3 });
    expect(li?.headed()).toBe(true);
    expect(itemWord(items)).toEqual({ item: 'item_2', outermost: 1 });
  });
});

describe('looseHeadingRole', () => {
  const sectionHeadedBy = (tag: string): SectionNode[] => {
    const { root, marked } = treeOf(`<section id="process"><${tag}>The title</${tag}><div data-mark>x</div></section>`);
    return chainOf(marked, root);
  };

  it('reads an h3 under a section first headed h2 as a subheadline', () => {
    expect(looseHeadingRole('h3', sectionHeadedBy('h2'))).toBe('subheadline');
  });

  it('reads an h3 under a section first headed h3 as a headline', () => {
    expect(looseHeadingRole('h3', sectionHeadedBy('h3'))).toBe('headline');
  });

  it('reads an h2 as a headline always', () => {
    expect(looseHeadingRole('h2', sectionHeadedBy('h1'))).toBe('headline');
  });
});

describe('summary', () => {
  it('reads a <summary> as a headline', () => {
    expect(roleOf(at({ tag: 'summary' }))).toBe('headline');
    expect(kindOf(at({ tag: 'summary' }))).toBe('headline');
  });
});

/**
 * The section and item rules' fixture table: each row a piece of markup, the
 * element it marks (the one carrying `data-mark`), the section word that
 * element's key is named under, and the repeated item it sits in. One table
 * drives key-names' `sectionWord` and `itemWord`, the static-HTML walk and the
 * JSX walk, so the three readings of the rules cannot drift apart.
 *
 * The markup is valid both as HTML and as JSX: every element closed, every
 * attribute quoted, `data-mark` bare.
 */
export interface SectionWordRow {
  name: string;
  markup: string;
  /** The section word the marked element answers; `null` where no section does. */
  word: string | null;
  /** The repeated item the marked element sits in (`card_2`); absent where it sits in none. */
  item?: string;
}

export const SECTION_WORD_ROWS: readonly SectionWordRow[] = [
  {
    name: 'an id of three words and more, cut to its first three',
    markup: '<section id="hero-banner-main-area"><p data-mark>Your week, sorted.</p></section>',
    word: 'hero_banner_main',
  },
  {
    name: 'a landmark with no id, by its tag name',
    markup: '<nav><a data-mark href="/">Home page</a></nav>',
    word: 'nav',
  },
  {
    name: 'a landmark with an id, by its id',
    markup: '<footer id="site-footer"><p data-mark>All rights reserved.</p></footer>',
    word: 'site_footer',
  },
  {
    name: 'a lone headed article, by its tag name',
    markup: '<article><h3>Outright acquisition</h3><p data-mark>Psyon acquires the data.</p></article>',
    word: 'article',
  },
  {
    name: 'a heading holding an inline element, read as all its text',
    markup: '<section><h2>Frequently <em>asked</em> questions</h2><p data-mark>Answers follow here.</p></section>',
    word: 'frequently_asked',
  },
  {
    name: 'an id opening with a digit',
    markup: '<section id="2col"><p data-mark>Two columns of text.</p></section>',
    word: '2col',
  },
  {
    name: 'a heading opening with a digit',
    markup: '<section><h2>2026 annual report</h2><p data-mark>The year in review.</p></section>',
    word: '2026_annual_report',
  },
  {
    name: 'an element directly in main answers no section',
    markup: '<main id="main"><p data-mark>Straight in the page.</p></main>',
    word: null,
  },
  {
    name: "an attribute on a section answers that section's own word",
    markup:
      '<section id="outer"><section id="inner" aria-label="The inner part" data-mark><p>Some words inside.</p></section></section>',
    word: 'inner',
  },
  {
    name: 'a card among three headed articles, by its place, under the section above it',
    markup:
      '<section id="services"><article><h3>Data sourcing work</h3><p>We find the data.</p></article>' +
      '<article><h3>Labelling the data</h3><p data-mark>We label the data.</p></article>' +
      '<article><h3>Evaluation of models</h3><p>We test the models.</p></article></section>',
    word: 'services',
    item: 'card_2',
  },
  {
    name: 'a nav item holding one link is no item',
    markup: '<nav><ul><li><a href="/">Home page</a></li><li><a data-mark href="/about">About the team</a></li></ul></nav>',
    word: 'nav',
  },
  {
    name: 'a step of an ordered list holding a heading and a paragraph',
    markup:
      '<section id="process"><ol><li><h3>First we talk</h3><p data-mark>A short call to begin.</p></li>' +
      '<li><h3>Then we build</h3><p>The work gets done.</p></li></ol></section>',
    word: 'process',
    item: 'step_1',
  },
  {
    name: 'a headed item inside a step, chained outermost first',
    markup:
      '<section id="process"><ol><li><h3>First we talk</h3><ul><li><h4>Book a slot</h4><p>Pick any free time.</p></li>' +
      '<li><h4>Join the call</h4><p data-mark>Bring your questions along.</p></li></ul></li>' +
      '<li><h3>Then we build</h3><p>The work gets done.</p></li></ol></section>',
    word: 'process',
    item: 'step_1_item_2',
  },
  {
    name: 'a details question and its answer, an item by its summary',
    markup:
      '<section id="faq"><details><summary>Is it free to start?</summary><p data-mark>Yes, the first call is free.</p></details>' +
      '<details><summary>How long does it take?</summary><p>About two weeks in all.</p></details></section>',
    word: 'faq',
    item: 'item_1',
  },
  {
    name: 'an article holding one text is no item, and names its section by its tag',
    markup: '<section id="news"><article><h3 data-mark>First short news</h3></article><article><h3>Second short news</h3></article></section>',
    word: 'article',
  },
];

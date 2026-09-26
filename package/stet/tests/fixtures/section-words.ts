/**
 * The section rule's fixture table: each row a piece of markup, the element it
 * marks (the one carrying `data-mark`), and the section word that element's
 * key is named under. One table drives key-names' `sectionWord`, the
 * static-HTML walk (`sectionWordOf`) and the JSX walk (`jsxSectionWord`), so
 * the three readings of the rule cannot drift apart.
 *
 * The markup is valid both as HTML and as JSX: every element closed, every
 * attribute quoted, `data-mark` bare.
 */
export interface SectionWordRow {
  name: string;
  markup: string;
  /** The section word the marked element answers; `null` where no section does. */
  word: string | null;
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
    name: 'a headed article, by its heading',
    markup: '<article><h3>Outright acquisition</h3><p data-mark>Psyon acquires the data.</p></article>',
    word: 'outright_acquisition',
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
];

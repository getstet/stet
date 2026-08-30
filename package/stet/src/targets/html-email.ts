/**
 * The html-email target — the second adapter in the seam, and the first whose
 * illegal constructs return findings.
 *
 * `escape` serves the SAME TWO contexts as `web.ts`'s and no others: HTML body
 * text, and quoted attribute values. An email client renders HTML, so the five
 * characters and their order are identical — an unquoted attribute value still
 * ends at the first space, a URL still keeps its `javascript:` scheme, a
 * `script` or JSON context is still corrupted by entity-escaping and
 * unprotected without it, and CSS still has its own grammar. Each needs its own
 * encoder.
 *
 * The table is deliberately NOT shared with `web.ts`. Two adapters whose escape
 * tables coincide today are not one job: telegram-md2's MarkdownV2 table is a
 * completely different set, and hoisting a shared `escapeHtml` now would couple
 * these two the day one of them needs an email-only entity (`&nbsp;` is already
 * a candidate). The duplicated eleven-line escape body, cross-referenced in
 * both files, is the cheaper trade — revisit if telegram lands and the HTML
 * pair still coincides.
 */

import type { Finding } from '../validate.js';
import type { TargetAdapter } from './adapter.js';

/**
 * The names the construct rule treats as markup. Module-local, like `seo.ts`'s
 * word lists: extending it is one entry here and one row in the adapter's test
 * table, and nothing outside this file reads it.
 *
 * Its scope is the PARSER-RELEVANT set, not the modern one. The WHATWG index
 * alone describes what an author should write; a blocking security rule has to
 * describe what a parser will do, so the list also carries the obsolete names
 * that alias a live element or change tokenization (`image` is the canonical
 * XSS alias the parser rewrites to `img`; `plaintext`, `xmp` and `listing`
 * switch tokenizer mode), the post-index modern names, and the SVG/MathML
 * children that execute, inject or escape. The other foreign-content children
 * — `desc`, `symbol`, `marker`, `filter` — deliberately pass: they are inert
 * containers whose payload would need one of the listed vectors anyway, and
 * every name added widens the false-positive class below.
 *
 * The accepted false positives, all of them consequences of blocking with no
 * override path:
 *   (a) an ELEMENT-NAMED local part — `<a@x.com>`, `<mark@example.com>`,
 *       `<address@acme.com>` block, because `@` is a word boundary. A local
 *       part that is not an element name (`<support@mirra.to>`) passes.
 *   (b) an ELEMENT-NAMED placeholder — `<Time>`, `<Address>`, `Insert <image>
 *       here` block, while `<Date>` and `<Your Name>` pass. This class is every
 *       name on the list, so it widened when the list did.
 *   (c) a hyphenated word in angle brackets reads as a custom-element open —
 *       `<opt-in>`, `<sign-up>`, `<follow-up>`, which is the product's own
 *       vocabulary. `<3-2-1 go>` and `<555-1234>` pass: the branch needs a
 *       leading letter.
 *   (d) an SVG child that is also an ordinary English verb blocks — `<use this
 *       link>`, `<set aside>` — because `use` and `set` are on the list below.
 *       This is a different surprise from (b): nothing about those two words
 *       looks like an element name to the operator who typed them.
 *
 * The accepted false NEGATIVE: an unknown non-hyphenated name passes
 * (`<wrapper>`, `<foo onclick=alert(1)>`). Blocking every `<alpha` open is
 * exactly the rule whose false positives forced this form, and the host's
 * render shell escapes slot content regardless — this rule is defence in depth,
 * not the only line.
 */
const HTML_ELEMENTS = [
  // WHATWG index
  'a','abbr','address','area','article','aside','audio','b','base','bdi','bdo','blockquote','body','br','button',
  'canvas','caption','cite','code','col','colgroup','data','datalist','dd','del','details','dfn','dialog','div',
  'dl','dt','em','embed','fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6','head',
  'header','hgroup','hr','html','i','iframe','img','input','ins','kbd','label','legend','li','link','main','map',
  'mark','menu','meta','meter','nav','noscript','object','ol','optgroup','option','output','p','param','picture',
  'pre','progress','q','rp','rt','ruby','s','samp','script','section','select','slot','small','source','span',
  'strong','style','sub','summary','sup','table','tbody','td','template','textarea','tfoot','th','thead','time',
  'title','tr','track','u','ul','var','video','wbr','svg','math','center','font','marquee','big','strike','tt',
  // obsolete / parser-relevant: alias listed elements or change tokenization
  'image','plaintext','xmp','listing','frame','frameset','noframes','applet','bgsound','noembed','keygen',
  'menuitem','blink','nobr','basefont','acronym','dir','isindex','spacer','multicol','nextid','rb','rtc',
  // post-index modern names
  'search','portal','fencedframe',
  // SVG/MathML children that execute, inject, or escape (svg/math themselves are
  // above; a slot may land inside a host's existing foreign-content context;
  // mglyph/malignmark are the text-integration-point breakout pair)
  'animate','animatemotion','animatetransform','set','use','foreignobject','mglyph','malignmark',
];

/**
 * A known-or-custom HTML element open, terminated or not. The trailing
 * alternation treats any hyphenated name as a custom element, because a custom
 * element is markup by the model's own definition.
 *
 * No closing `>` is required: the 81%-case string shell supplies its own, so
 * `<script src="//evil` inside a slot is the injection this rule exists for and
 * a rule demanding the closer inside the value would miss it.
 *
 * NO `g` flag. A global regex reused through `.test()` carries `lastIndex`
 * between calls and silently skips every other value. `\b` after the
 * alternation backtracks, so a shorter name earlier in the list cannot shadow a
 * longer one (`<colgroup>` blocks despite `col`), and no entry carries a regex
 * metacharacter, so `join('|')` needs no quoting.
 */
const MARKUP_TAG = new RegExp(
  '</?(?:' + HTML_ELEMENTS.join('|') + '|[a-z][a-z0-9]*-[a-z0-9-]*)\\b',
  'i',
);

/** The same vocabulary, anchored — `opensMarkupTag` reads it. */
const TAG_AT_START = new RegExp(`^${MARKUP_TAG.source}`, 'i');

/**
 * Whether a tag OPENS at the start of this text — the construct rule's own
 * element and custom-element vocabulary, anchored.
 *
 * `cli/email-extract.ts`'s segmenter reads it to decide where a template
 * literal's markup begins, so "what counts as a tag" is answered once for the
 * whole package. Sharing it is what keeps the two sides consistent: a `<` the
 * segmenter leaves inside a slot's text (`only if 5 < 6`) is exactly a `<` this
 * rule will not call markup when that value reaches the save gate.
 */
export function opensMarkupTag(text: string): boolean {
  return TAG_AT_START.test(text);
}

export const htmlEmailTarget: TargetAdapter = {
  name: 'html-email',

  escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // The numeric form, not `&apos;`, for the same reason web's is: `&#39;`
      // survives the HTML4-era contexts `&apos;` does not, and doctor's decoder
      // resolves both.
      .replace(/'/g, '&#39;');
  },

  /**
   * Derived from the 600px email-safe content width at the same ~16px/char
   * ratio web's 40 tracks against 640px: 600/16 = 37.5, floored — an
   * over-estimate of lines beats an under-estimate for an advisory. Mobile is
   * the same 320px class as web's.
   *
   * 600px is an email CONVENTION with no canon ruling behind it, and it sits
   * outside §13.1's config device-width setting (640/320 defaults) — a second
   * width source, which the phase-2 measurement work reconciles rather than
   * assumes the config governs.
   */
  charsPerLine: { desktop: 37, mobile: 20 },

  /**
   * The slots model's teeth: markup belongs to the host's render shell, never
   * the store, so a contained string carrying an element open cannot be saved
   * (§13.1e — "markup is not in the content" is what dissolves unbalanced-markup
   * bugs, and this is its enforcement). One finding per offending string; the
   * `key` is the entry path the walker handed over, so the finding names the
   * string an operator has to fix.
   */
  illegalConstructs(value: string, key: string): Array<Finding & { rule: 'construct'; severity: 'error' }> {
    if (!MARKUP_TAG.test(value)) return [];
    return [
      {
        rule: 'construct',
        severity: 'error',
        key,
        message: `${key}: an HTML element open in ${this.name} content — markup belongs to the host's render shell, never the stored value; move the tag into the shell and keep the copy here`,
      },
    ];
  },
};

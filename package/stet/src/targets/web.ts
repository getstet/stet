/**
 * The web target — the first adapter in the seam.
 *
 * `escape` serves TWO contexts and no others: HTML body text, and quoted
 * attribute values. The five-character set is exactly right there and wrong
 * everywhere else — an unquoted attribute value ends at the first space, so
 * `x onmouseover=alert(1)` survives this function intact; a URL keeps its
 * `javascript:` scheme; a `script` or JSON context (JSON-LD included) is
 * corrupted by entity-escaping and unprotected without it, since `</script>`
 * closes the block and U+2028/U+2029 break the parse either way; CSS has its
 * own grammar again. Each of those needs its own encoder. The restriction is
 * documented rather than assumed because `escape` has no runtime caller yet:
 * this comment is the guardrail its first consumer will meet.
 *
 * Its escape is the mirror image of `cli/doctor.ts`'s `decodeEntities`, and the
 * two are deliberately NOT shared code: one encodes for emission, the other
 * decodes fetched HTML for containment. Doctor resolves a superset (six named
 * entities including `nbsp`, plus the numeric forms wholesale) because it reads
 * whatever a host's serializer produced; an encoder emits one canonical form
 * per character. The order is mirrored for the same reason in each direction —
 * this file writes `&` FIRST so a later replacement's entity is not re-encoded,
 * doctor resolves `&amp;` LAST so an escaped `&amp;amp;` does not become an `&`
 * that swallows the text after it.
 *
 * The html-email adapter's escape table is character-for-character this one,
 * and also deliberately NOT shared: an email client renders HTML, so the two
 * coincide today, but they are two jobs rather than one. Before hoisting a
 * shared `escapeHtml` out of the pair, read the rationale at the top of
 * `src/targets/html-email.ts` — it holds the telegram-md2 divergence that makes
 * extraction premature, and the condition under which the pair is worth
 * revisiting.
 */

import type { Finding } from '../validate.js';
import type { TargetAdapter } from './adapter.js';

export const webTarget: TargetAdapter = {
  name: 'web',

  escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // The numeric form, not `&apos;`: doctor's decoder resolves both, and
      // `&#39;` also survives the HTML4-era contexts `&apos;` does not.
      .replace(/'/g, '&#39;');
  },

  /**
   * The phase-1 line estimate's metrics, tracking the plan's 640/320 default
   * device widths. This is the package's one home for them — a derivation
   * §13.1's config-widths setting re-derives when it lands with measurement,
   * rather than forks.
   */
  charsPerLine: { desktop: 40, mobile: 20 },

  /**
   * Web has none: React and HTML impose no value-level construct a candidate
   * string can violate. Stated rather than left implicit, so an empty legality
   * check reads as a decision instead of an omission.
   */
  illegalConstructs(): Array<Finding & { rule: 'construct'; severity: 'error' }> {
    return [];
  },
};

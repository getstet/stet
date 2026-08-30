/**
 * The target seam: one adapter per render destination, and the one registry a
 * consumer looks them up in. Adding a target is one adapter file plus one
 * registry row — no consumer branches on a target name, which is what keeps
 * that promise true (plan §13.6 B).
 *
 * The recipe's preview half is absent deliberately: it joins when the
 * preview-route factory exists to consume it, because inventing a contract
 * against no consumer is how a seam rots. The recipe's limits-and-severity slot
 * stays on the descriptor's key-level `limits`, which the validation capability
 * already owns; target-wide limit semantics arrive with the first target that
 * needs them.
 */

import type { Target } from '../types.js';
import type { Finding } from '../validate.js';
import { htmlEmailTarget } from './html-email.js';
import { webTarget } from './web.js';

export interface TargetAdapter {
  readonly name: Target;
  /**
   * Escape text for surfaces stet itself emits. Values are stored raw (§13.7 —
   * the host owns its render).
   *
   * CONTEXT-RESTRICTED, and the restriction is the contract: the output is
   * inert in HTML body text and in QUOTED attribute values, and nowhere else.
   * An unquoted attribute (`title=VALUE` — a space and `onmouseover=` end the
   * value), a URL (a `javascript:` scheme survives entity-escaping untouched),
   * a `script` or JSON context including JSON-LD (escaping corrupts the JSON;
   * not escaping lets `</script>` close the block; U+2028/U+2029 pass either
   * way) and a CSS context each need their own encoder. Reaching for this one
   * there produces output that looks escaped and is not.
   */
  escape(text: string): string;
  /**
   * Budget estimation metrics — characters per rendered line, per device. Every
   * value is an integer of at least 1, asserted structurally over the registry
   * rather than clamped at runtime: a clamp would silently repair a broken
   * adapter, where the assertion fails the suite at the row that declared 0 —
   * which otherwise estimates "Infinity lines".
   */
  readonly charsPerLine: { readonly desktop: number; readonly mobile: number };
  /**
   * The target's illegal constructs in a candidate string; web declares none.
   * A construct finding BLOCKS — structural illegality is not fit advice — so
   * the blocking path is first exercised by the html-email adapter. The `key`
   * is the entry-pathed one the caller walked to (`footer_links[2]`), so a
   * finding names the string an operator has to fix.
   *
   * The return type carries the contract rather than describing it: an adapter
   * that tried to file a construct finding as a warning, or under another
   * rule, would not compile.
   */
  illegalConstructs(value: string, key: string): Array<Finding & { rule: 'construct'; severity: 'error' }>;
}

/** The one registry. A target absent here has no adapter yet, by construction. */
const ADAPTERS: Partial<Record<Target, TargetAdapter>> = {
  web: webTarget,
  'html-email': htmlEmailTarget,
};

/**
 * The adapter for a target, for a consumer that requires one. An unshipped
 * target throws and names itself — never a silent fall back to web, which would
 * emit one target's rules under another's name.
 */
export function targetAdapter(name: Target): TargetAdapter {
  const adapter = targetAdapterIfShipped(name);
  if (adapter === undefined) {
    throw new Error(
      `no adapter is shipped for target "${name}" yet — it arrives as one adapter file and one registry row`,
    );
  }
  return adapter;
}

/**
 * The same lookup for a consumer that must survive an unshipped target:
 * committed content declares targets whose adapters ship in later changes, and
 * `stet check` reading it is not a crash. Each caller states its own fallback —
 * they differ on purpose, and the difference is a correctness argument rather
 * than a convenience.
 */
export function targetAdapterIfShipped(name: Target): TargetAdapter | undefined {
  // Own keys only. A plain object answers every `Object.prototype` name, so a
  // bare lookup hands `__proto__` and `constructor` back as adapters and the
  // throwing form above stops throwing for them. These four functions are
  // public exports, so the guard belongs here rather than at each caller.
  return Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
}

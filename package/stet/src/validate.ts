import { z } from 'zod';

import { targetAdapterIfShipped } from './targets/adapter.js';
import { webTarget } from './targets/web.js';
import type { Descriptor, Target } from './types.js';

/**
 * Hex only. A named color (`rebeccapurple`) and `rgb()` are deliberately
 * rejected: one machine-comparable form is what makes contrast lint and email
 * safety checkable offline. Curated palettes are phase 2.
 */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** `{{name}}`, with whitespace tolerated inside the braces. */
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** No bare `off` — "turn off notifications" is not a promotion. */
const PROMOTIONAL = /(\d+\s*%|\bdiscount\b|\bsale\b)/i;

/**
 * A numbered placeholder tag: `<1>`, `</1>` or `<1/>`. These are the ONLY
 * `<`-shapes the tag rule reads — values are stored raw and the emitter escapes
 * them, so any other `<` in a value is prose and never a finding.
 */
export const PLACEHOLDER = /<(\/?)(\d+)(\/?)>/g;

export type FindingRule = 'limit' | 'vars' | 'class' | 'budget' | 'construct' | 'tags';

export interface Finding {
  rule: FindingRule;
  severity: 'error' | 'warning';
  /**
   * The content key — possibly entry-pathed (`footer_links[2]`, `labels.email`)
   * where the rule walked into a structured value — or the template name for a
   * template-level class rule.
   */
  key: string;
  message: string;
  length?: number;
  max?: number;
  vars?: string[];
  slot?: string;
  device?: 'desktop' | 'mobile';
  estimate?: number;
  budget?: number;
}

export interface Verdict {
  ok: boolean;
  findings: Finding[];
}

export type Advisory = Finding & {
  rule: 'budget';
  severity: 'warning';
  device: 'desktop' | 'mobile';
  estimate: number;
  budget: number;
  /**
   * Which adapter's metrics produced the estimate — set on EVERY advisory, not
   * only on a fallback, because "what was this measured against" is a fact
   * worth carrying uniformly and always-set is the simpler contract. A
   * programmatic consumer reads this rather than parsing the disclosure out of
   * the message prose.
   */
  metricsFrom: Target;
};

export interface SaveCandidate {
  key: string;
  value: unknown;
  locale?: string;
}

export type SaveVerdict = Verdict;

/**
 * The runtime parser for a key's declared shape. Generated from the descriptor,
 * so the validation rules and the types cannot drift apart. An undeclared key
 * has no shape to enforce — the currency check is where it surfaces.
 */
export function shapeSchema(d: Descriptor, key: string): z.ZodType {
  const def = d.keys[key];
  if (!def) return z.unknown();
  switch (def.shape) {
    case 'text':
    case 'richtext':
    case 'media':
      return z.string();
    case 'list':
      return z.array(z.string());
    case 'record':
      return z.record(z.string(), z.unknown());
    case 'enum':
      return z.enum((def.values ?? ['']) as [string, ...string[]]);
    case 'number':
      return z.number();
    case 'color':
      return z.string().regex(HEX_COLOR);
  }
}

/**
 * Every string a value contains, each with the path an operator would fix. A
 * list entry and a record field are each a rendered string with the same
 * overflow consequence as a `text` value, so a rule that walks this sees them
 * all; `enum`, `number` and `color` have no length semantics and yield nothing.
 *
 * It reads the key's DECLARED shape, never `typeof` alone — a list stored where
 * `text` is declared yields no strings here, and the shape check is what
 * catches that. The default arm is an exhaustiveness check: a ninth shape
 * breaks the build here rather than drifting silently past.
 */
function stringsOf(
  d: Descriptor,
  key: string,
  value: unknown,
): Array<{ path: string; text: string }> {
  const def = d.keys[key];
  if (!def) return [];
  switch (def.shape) {
    case 'text':
    case 'richtext':
    case 'media':
      return typeof value === 'string' ? [{ path: key, text: value }] : [];
    case 'list': {
      if (!Array.isArray(value)) return [];
      const found: Array<{ path: string; text: string }> = [];
      value.forEach((entry, index) => {
        if (typeof entry === 'string') found.push({ path: `${key}[${index}]`, text: entry });
      });
      return found;
    }
    case 'record': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
      const found: Array<{ path: string; text: string }> = [];
      // A non-string field is skipped, and nothing upstream rejects it: the
      // record shape is `z.record(z.string(), z.unknown())`, so a field holding
      // an object passes the shape check and then carries no length or variable
      // rule at all. Phase 1 walks top-level fields only — a nested structure
      // is out of scope, stated in the validation spec rather than assumed away
      // here, because unbounded recursion is the worse trade.
      for (const [field, entry] of Object.entries(value)) {
        if (typeof entry === 'string') found.push({ path: `${key}.${field}`, text: entry });
      }
      return found;
    }
    case 'enum':
    case 'number':
    case 'color':
      return [];
    default:
      def.shape satisfies never;
      return [];
  }
}

/**
 * Over `max`: a warning when severity is advisory, a rejection when it is hard.
 * The limit applies to every string the value contains, one finding each, so a
 * long entry inside a list or a record cannot hide behind its container.
 *
 * A key declaring `tags` is measured over its PLAIN text — the placeholders
 * removed — and reports that length, so the counter and a reader agree on what
 * the value says.
 *
 * The unit is the UTF-16 code unit — `String.length`, which the fit estimate
 * counts too. An NFD `é` is 2 and an emoji is 2, so the count and an operator's
 * idea of "characters" can differ; the message keeps the colloquial word
 * because that is what an operator reads, and closing the gap means grapheme
 * segmentation, a dependency phase 1 does not take.
 */
export function checkLimits(d: Descriptor, key: string, value: unknown): Verdict {
  const limits = d.keys[key]?.limits;
  if (!limits) return { ok: true, findings: [] };

  const severity = limits.severity === 'hard' ? 'error' : 'warning';
  const tagged = d.keys[key]?.tags !== undefined;
  const findings: Finding[] = [];
  for (const { path, text } of stringsOf(d, key, value)) {
    const measured = tagged ? plainOf(text) : text;
    if (measured.length <= limits.max) continue;
    findings.push({
      rule: 'limit',
      severity,
      key: path,
      length: measured.length,
      max: limits.max,
      message: `${path}: ${measured.length} characters exceeds the ${limits.max}-character limit`,
    });
  }
  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/**
 * Every `{{variable}}` a value interpolates must be on the key's whitelist.
 *
 * It walks the same contained strings the limit check does, one finding per
 * offending entry: this is an ERROR-severity gate, so a placeholder a `text`
 * value cannot get past must not be passable by the same string sitting in a
 * list entry or a record field.
 */
export function checkVars(d: Descriptor, key: string, value: unknown): Verdict {
  const declared = new Set(d.keys[key]?.vars ?? []);
  const findings: Finding[] = [];
  for (const { path, text } of stringsOf(d, key, value)) {
    const unknown: string[] = [];
    for (const found of text.matchAll(VARIABLE)) {
      const name = found[1];
      if (name !== undefined && !declared.has(name) && !unknown.includes(name)) unknown.push(name);
    }
    if (unknown.length === 0) continue;
    findings.push({
      rule: 'vars',
      severity: 'error',
      key: path,
      vars: unknown,
      message: `${path}: undeclared variable${unknown.length > 1 ? 's' : ''} ${unknown
        .map((v) => `{{${v}}}`)
        .join(', ')} — declare them on the key or fix the placeholder`,
    });
  }
  return { ok: findings.length === 0, findings };
}

/**
 * A tagged value's text as a reader sees it: the paired placeholders removed
 * and each self-closing one standing for the one space its element renders as,
 * so a `<br>` between two lines never fuses their words. It is the one
 * placeholder grammar — the length rule measures it, and the static-HTML host's
 * locator names its key from it.
 */
export function plainOf(text: string): string {
  return text.replace(PLACEHOLDER, (_match, closing: string, _number: string, selfClosing: string) =>
    closing === '' && selfClosing === '/' ? ' ' : '',
  );
}

/**
 * Placeholder tags are kept whole. A key declaring `tags: n` accepts only a
 * value carrying exactly `1..n`, each opened once and closed once (or
 * self-closed once), properly nested. Reordering is allowed — a translation may
 * move the emphasised part — because the tags' identity lives in the document,
 * never in the value.
 *
 * A key WITHOUT `tags` is not checked at all: a `<1>` in ordinary prose is
 * prose. One finding per contained string, naming the first fault found, since
 * the message states what the value must carry and what it does.
 */
export function checkTags(d: Descriptor, key: string, value: unknown): Verdict {
  const declared = d.keys[key]?.tags;
  if (declared === undefined) return { ok: true, findings: [] };

  const findings: Finding[] = [];
  for (const { path, text } of stringsOf(d, key, value)) {
    const fault = tagFault(text, declared);
    if (fault === null) continue;
    findings.push({
      rule: 'tags',
      severity: 'error',
      key: path,
      message: `${path}: the value must carry placeholder tags 1..${declared}, each once and balanced — found ${fault}`,
    });
  }
  return { ok: findings.length === 0, findings };
}

/** The first way `text` fails the tag rule for a count of `declared`, or null. */
function tagFault(text: string, declared: number): string | null {
  const open: number[] = [];
  const seen = new Set<number>();
  for (const found of text.matchAll(PLACEHOLDER)) {
    const closing = found[1] === '/';
    const number = Number(found[2]);
    const selfClosing = found[3] === '/';
    if (number < 1 || number > declared) return `tag ${number} beyond 1..${declared}`;
    if (closing) {
      // A close whose number is nowhere open closes nothing; one that is open
      // but not innermost leaves the element above it hanging, which is the
      // fault worth naming.
      const top = open[open.length - 1];
      if (top === number) open.pop();
      else if (open.includes(number)) return `<${top}> never closed`;
      else return `</${number}> before <${number}>`;
      continue;
    }
    if (seen.has(number)) return `tag ${number} twice`;
    seen.add(number);
    if (!selfClosing) open.push(number);
  }
  const hanging = open[open.length - 1];
  if (hanging !== undefined) return `<${hanging}> never closed`;
  for (let number = 1; number <= declared; number += 1) {
    if (!seen.has(number)) return `tag ${number} missing`;
  }
  return null;
}

/**
 * The class gate. In scope = the template's declared slot values ∪ its
 * `wrapperProvides`. Siblings are caller-supplied, keyed by flattened key
 * (`welcome__subject`) and resolved draft-over-active before the call — core
 * never fetches. Verifying a `wrapperProvides` claim against the render path
 * that actually sends is `stet doctor`'s job.
 *
 * `siblings` is scope, not just slots: it also carries
 * `brand__footer_address` where the caller can resolve it, because the postal
 * rule reads it there. A caller that omits the key gets the warning, and that
 * is the rule's own semantics rather than a spurious finding — the caller
 * demonstrated no address either.
 */
export function checkClassRules(
  d: Descriptor,
  template: string,
  siblings: Record<string, unknown>,
): Verdict {
  const def = d.templates?.[template];
  if (!def) {
    return {
      ok: false,
      findings: [
        {
          rule: 'class',
          severity: 'error',
          key: template,
          message: `"${template}" is not a template in this descriptor`,
        },
      ],
    };
  }

  const slots = [...def.slots].sort((a, b) => rankSlot(a) - rankSlot(b));

  if (def.class === 'marketing') {
    // Two independent rules, so the findings accumulate rather than each
    // returning: a template can fail the unsubscribe gate and be missing its
    // postal line at the same time, and an operator should see both. Only the
    // unsubscribe gate decides `ok`.
    const findings: Finding[] = [];
    const provided = new Set(def.wrapperProvides ?? []);
    const inScope =
      provided.has('unsubscribe_url') ||
      slots.some((slot) => tokensIn(siblings[`${template}__${slot}`]).has('unsubscribe_url'));
    if (!inScope) {
      findings.push({
        rule: 'class',
        severity: 'error',
        key: template,
        message: `${template}: a marketing template needs {{unsubscribe_url}} in scope — carry it in a slot, or declare it in wrapperProvides if the host's frame already sends it`,
      });
    }

    // The postal line warns and never blocks: stet can verify an address
    // exists, it cannot conjure one, so a missing address is a copy item rather
    // than a gate. Either carrier satisfies it — the host's frame declaring it,
    // or a brand value the caller resolved into scope.
    const brand = siblings['brand__footer_address'];
    const postal =
      provided.has('postal_address') || (typeof brand === 'string' && brand.trim() !== '');
    if (!postal) {
      findings.push({
        rule: 'class',
        severity: 'warning',
        key: template,
        message: `${template}: a marketing template needs a postal address in scope — declare postal_address in wrapperProvides if the host's frame carries it, or give brand__footer_address a value`,
      });
    }

    return { ok: inScope, findings };
  }

  // Transactional: primary purpose is linted, never gated.
  const findings: Finding[] = [];
  for (const slot of slots) {
    const value = siblings[`${template}__${slot}`];
    if (typeof value === 'string' && PROMOTIONAL.test(value)) {
      findings.push({
        rule: 'class',
        severity: 'warning',
        key: `${template}__${slot}`,
        slot,
        message: `${template}__${slot}: promotional wording in a transactional template can cost it its primary purpose`,
      });
    }
  }
  return { ok: true, findings };
}

function rankSlot(slot: string): number {
  return slot === 'subject' ? 0 : 1;
}

function tokensIn(value: unknown): Set<string> {
  const found = new Set<string>();
  if (typeof value !== 'string') return found;
  for (const match of value.matchAll(VARIABLE)) if (match[1] !== undefined) found.add(match[1]);
  return found;
}

/**
 * A phase-1 estimate, not a measurement — the measured-verdict machinery is
 * phase 2, and only the postMessage measurement contract yields a real verdict.
 * At most one advisory, naming the device that overshoots hardest. A key with
 * no budget gets no verdict, and no budget ever blocks a publish.
 *
 * The estimate counts per explicit line, so a line break the operator typed is
 * not invisible, and it reads the line metrics of the KEY's declared target. A
 * target whose adapter has not shipped estimates under web's metrics and says
 * so in the message: an approximate estimate beats none, where a construct
 * verdict under the wrong rulebook would be worse than none.
 *
 * Single-string values only. A structured value's layout is the host's and
 * phase 1 has no per-entry fit contract; `richtext` and `media` are strings, so
 * their budgets estimate like any other.
 */
export function checkBudget(d: Descriptor, key: string, value: unknown): Advisory | null {
  const def = d.keys[key];
  if (!def || !def.budget || typeof value !== 'string') return null;
  const budget = def.budget;

  const adapter = targetAdapterIfShipped(def.target);
  const metrics = adapter ?? webTarget;
  const { charsPerLine } = metrics;
  const fallback =
    adapter === undefined ? ` (${webTarget.name} metrics — ${def.target} adapter not shipped)` : '';

  // Estimation-side normalization only — the candidate is never rewritten, and
  // what gets stored is what the operator sent. A file-authored value (`draft
  // --value-file`) arrives with the trailing newline every POSIX editor writes,
  // which is a line terminator rather than a line, and CRLF would otherwise
  // spend a character of width on the `\r`. Both would inflate an estimate the
  // spec defines over DELIBERATE breaks. One trailing empty segment goes; a
  // second survives, because a blank line the operator typed is content.
  const segments = value.replace(/\r\n/g, '\n').split('\n');
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();

  let worst: Advisory | null = null;
  let worstOvershoot = 0;
  for (const device of ['desktop', 'mobile'] as const) {
    const allowed = budget[device];
    if (allowed === undefined) continue;
    const estimate = segments.reduce(
      (lines, segment) => lines + Math.max(1, Math.ceil(segment.length / charsPerLine[device])),
      0,
    );
    const overshoot = estimate - allowed;
    if (overshoot > 0 && overshoot > worstOvershoot) {
      worstOvershoot = overshoot;
      worst = {
        rule: 'budget',
        severity: 'warning',
        key,
        device,
        estimate,
        budget: allowed,
        metricsFrom: metrics.name,
        message: `${key}: an estimated ${estimate} ${device} lines against a budget of ${allowed} — an estimate, not a measurement${fallback}`,
      };
    }
  }
  return worst;
}

/**
 * The one entry a save path calls: limits, variables, class rules, constructs,
 * budget — in that order, errors before warnings. Siblings carry the template's
 * other slot values where the candidate is a slot, plus `brand__footer_address`
 * where the caller can resolve it — the class rules' scope, not the slot list;
 * the candidate itself is merged in, so a caller never has to include it twice.
 */
export function validateSave(
  d: Descriptor,
  candidate: SaveCandidate,
  siblings?: Record<string, unknown>,
): SaveVerdict {
  const findings: Finding[] = [
    ...checkLimits(d, candidate.key, candidate.value).findings,
    ...checkVars(d, candidate.key, candidate.value).findings,
    ...checkTags(d, candidate.key, candidate.value).findings,
  ];

  const template = templateOf(d, candidate.key);
  if (template) {
    findings.push(
      ...checkClassRules(d, template, { ...siblings, [candidate.key]: candidate.value }).findings,
    );
  }

  // Constructs run under the KEY's own target, per contained string. An
  // unshipped target is SKIPPED rather than checked under web's rulebook — a
  // target's constructs are its own, and the deliberate asymmetry with the
  // budget fallback above is that a wrong verdict is worse than no verdict.
  const target = d.keys[candidate.key]?.target;
  const adapter = target === undefined ? undefined : targetAdapterIfShipped(target);
  if (adapter) {
    for (const { path, text } of stringsOf(d, candidate.key, candidate.value)) {
      findings.push(...adapter.illegalConstructs(text, path));
    }
  }

  const advisory = checkBudget(d, candidate.key, candidate.value);
  if (advisory) findings.push(advisory);

  const ordered = [
    ...findings.filter((f) => f.severity === 'error'),
    ...findings.filter((f) => f.severity !== 'error'),
  ];
  return { ok: !ordered.some((f) => f.severity === 'error'), findings: ordered };
}

/** The template a slot key belongs to, by declaration rather than by parsing. */
export function templateOf(d: Descriptor, key: string): string | null {
  for (const template of Object.keys(d.templates ?? {})) {
    if (key.startsWith(`${template}__`)) return template;
  }
  return null;
}

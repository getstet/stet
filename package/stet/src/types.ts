/**
 * The contract types, hand-declared against `descriptor.schema.json`. The JSON
 * document is canonical — these mirror it so TypeScript consumers get the same
 * shape without a codegen step, and the schema stays readable by consumers with
 * no JavaScript runtime at all.
 */

export type Shape =
  | 'text'
  | 'list'
  | 'record'
  | 'enum'
  | 'color'
  | 'number'
  | 'richtext'
  | 'media';

export type Target = 'web' | 'html-email' | 'telegram-md2';

/**
 * The target a key gets when nothing declares one — what `stet register` writes
 * for a literal it adopts out of a page. It lives here because this file is one
 * of the three sanctioned homes for a target name: a bare `'web'` written into
 * `cli/` would be the inline target branch the target seam exists to forbid.
 */
export const DEFAULT_TARGET: Target = 'web';

/**
 * The target `stet register` gives a literal it adopts out of an EMAIL surface,
 * so email copy gets email rules. Beside `DEFAULT_TARGET` for the same reason:
 * this file is a sanctioned home for a target name, and a bare `'html-email'`
 * written into `cli/` would be the inline target branch the seam forbids.
 */
export const EMAIL_TARGET: Target = 'html-email';

export type Severity = 'advisory' | 'hard';

export interface Limits {
  max: number;
  severity: Severity;
}

/** Max rendered lines per device. Advisory in phase 1. */
export interface Budget {
  desktop?: number;
  mobile?: number;
}

export interface KeyDef {
  shape: Shape;
  target: Target;
  limits?: Limits;
  budget?: Budget;
  /** Required if and only if `shape` is `enum`. */
  values?: string[];
  vars?: string[];
  derivesFrom?: string;
  tmpl?: string;
  pages?: string[];
  label?: string;
  help?: string;
  previewUrl?: string;
  section?: string;
  /** Only `false` is expressible: a key that omits it follows the project mode. */
  agentPublish?: false;
  pack?: string;
}

export interface JsonLdDef {
  type: string;
  bindings: Record<string, string>;
}

/** Each field names the content key that carries it — explicit references, never inferred (§13.1c). */
export interface PageSeo {
  title?: string;
  description?: string;
  robots?: string;
  canonical?: string;
  ogImage?: string;
  ogImageAlt?: string;
}

export interface PageDef {
  route: string;
  parent?: string;
  locales?: string[];
  seo?: PageSeo;
  jsonLd?: JsonLdDef;
}

export type TemplateClass = 'transactional' | 'marketing';

export type TemplateTrigger = 'form' | 'app-event' | 'schedule' | 'ci' | 'manual';

/**
 * Where a template's slots are consumed: the host module and export, and sample
 * props sufficient to invoke it. `stet email verify` renders through this and
 * `stet doctor` walks its import closure; an entry without one is declared but
 * not centrally verifiable, and both tools say so.
 */
export interface RenderPointer {
  file: string;
  export: string;
  sampleProps: Record<string, unknown>;
}

export interface TemplateDef {
  class: TemplateClass;
  trigger: TemplateTrigger;
  clock?: string;
  sender?: string;
  /** Each slot resolves to a key named `<template>__<slot>`. */
  slots: string[];
  wrapperProvides?: string[];
  render?: RenderPointer;
}

export interface Descriptor {
  version: number;
  keys: Record<string, KeyDef>;
  pages?: Record<string, PageDef>;
  templates?: Record<string, TemplateDef>;
}

/**
 * The augmentation point for the generated ambient types. A host's generated
 * `.d.ts` declares `interface StetRegistry { keys: 'hero_headline' | … }`
 * inside `declare module '@getstet/stet'`; an unaugmented host degrades to
 * `string`, so the package compiles everywhere and the offline checks remain
 * the guarantee.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface -- the augmentation target
export interface StetRegistry {}

export type ContentKey = StetRegistry extends { keys: infer K extends string }
  ? K
  : string;

/** Something a caller should see but which must never fail a read. */
export interface Warning {
  code: string;
  key: string;
  locale: string;
  reason: string;
}

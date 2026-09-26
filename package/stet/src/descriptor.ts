import * as ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

import type { Descriptor, KeyDef } from './types.js';

/**
 * A descriptor that cannot be trusted, with the failing path named. Nothing
 * downstream — codegen, checks, resolution — runs on a rejected descriptor.
 */
export class DescriptorError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'DescriptorError';
    this.path = path;
  }
}

/** Reported, never thrown: the descriptor is usable and something is off. */
export interface DescriptorWarning {
  code: string;
  path: string;
  message: string;
}

let compiled: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (!compiled) {
    // ajv ships CommonJS, so the ESM default import is the module namespace,
    // not the constructor — take the named export.
    const ajv = new ajv2020.Ajv2020({ allErrors: true, strict: false });
    compiled = ajv.compile(DESCRIPTOR_SCHEMA);
  }
  return compiled;
}

/** Load and validate a descriptor. Throws `DescriptorError` naming the failing path. */
export function loadDescriptor(raw: unknown): Descriptor {
  return loadDescriptorWithWarnings(raw).descriptor;
}

/**
 * `loadDescriptor` plus the non-fatal findings — an incomplete template slot
 * set is a warning, not a rejection, because a malformed slot key degrades to
 * an ordinary key rather than breaking the project.
 */
export function loadDescriptorWithWarnings(raw: unknown): {
  descriptor: Descriptor;
  warnings: DescriptorWarning[];
} {
  const validate = schemaValidator();
  if (!validate(raw)) {
    const errors = (validate.errors ?? []).filter((e) => e.keyword !== 'if');
    const first = errors[0];
    if (first) throw schemaError(first);
    throw new DescriptorError('', 'descriptor failed schema validation');
  }
  const descriptor = raw as Descriptor;
  return { descriptor, warnings: checkDescriptorStructure(descriptor) };
}

/**
 * The rules a JSON Schema cannot express: references that must resolve, and the
 * `<template>__<slot>` naming convention, which is a convention rather than a
 * type. Reachable on its own for hand-built descriptors, which never meet ajv.
 */
export function checkDescriptorStructure(d: Descriptor): DescriptorWarning[] {
  const warnings: DescriptorWarning[] = [];
  const pageNames = new Set(Object.keys(d.pages ?? {}));

  for (const [key, def] of Object.entries(d.keys)) {
    if (def.derivesFrom !== undefined && !(def.derivesFrom in d.keys)) {
      throw new DescriptorError(
        `keys/${key}/derivesFrom`,
        `key "${key}" derives from "${def.derivesFrom}", which is not a key in this descriptor`,
      );
    }
    if (def.derivesFrom !== undefined && !(def.tmpl ?? '').includes('{v}')) {
      throw new DescriptorError(
        `keys/${key}/tmpl`,
        `key "${key}" derives from "${def.derivesFrom}" but its tmpl does not contain {v}`,
      );
    }
    if (def.shape === 'enum' && (def.values === undefined || def.values.length === 0)) {
      throw new DescriptorError(
        `keys/${key}/values`,
        `key "${key}" declares shape: enum and must declare its value set`,
      );
    }
    def.pages?.forEach((page, i) => {
      if (!pageNames.has(page)) {
        throw new DescriptorError(
          `keys/${key}/pages/${i}`,
          `key "${key}" names page "${page}", which is not declared in the pages section`,
        );
      }
    });
  }

  // Existence only. The shape stays unconstrained on purpose — a robots key is
  // legitimately `text` or `list` — so a wrong-shaped reference surfaces through
  // the seo rules, which read the value, rather than here.
  for (const { page, kind, field, key } of pageKeyReferences(d)) {
    if (key in d.keys) continue;
    throw kind === 'seo'
      ? new DescriptorError(
          `pages/${page}/seo/${field}`,
          `page "${page}" references SEO field "${field}" through "${key}", which is not a key in this descriptor`,
        )
      : new DescriptorError(
          `pages/${page}/jsonLd/bindings/${field}`,
          `page "${page}" binds JSON-LD field "${field}" to "${key}", which is not a key in this descriptor`,
        );
  }

  for (const [template, def] of Object.entries(d.templates ?? {})) {
    // The render pointer is checked here as well as in the schema: a hand-built
    // descriptor never meets ajv, and a pointer with an empty file or a
    // non-object sample-props set would reach the renderer as a spawn argument.
    const render = def.render;
    if (render !== undefined) {
      for (const field of ['file', 'export'] as const) {
        if (typeof render[field] !== 'string' || render[field] === '') {
          throw new DescriptorError(
            `templates/${template}/render/${field}`,
            `template "${template}" declares a render pointer whose ${field} is not a non-empty string`,
          );
        }
      }
      const props: unknown = render.sampleProps;
      if (props === null || typeof props !== 'object' || Array.isArray(props)) {
        throw new DescriptorError(
          `templates/${template}/render/sampleProps`,
          `template "${template}" declares a render pointer whose sampleProps is not an object — it is the one argument the export is called with`,
        );
      }
    }

    def.slots.forEach((slot, i) => {
      const slotKey = `${template}__${slot}`;
      if (!(slotKey in d.keys)) {
        warnings.push({
          code: 'incomplete_slot_set',
          path: `templates/${template}/slots/${i}`,
          message: `template "${template}" declares slot "${slot}" with no "${slotKey}" key — the slot has nowhere to store a value`,
        });
      }
    });
  }

  return warnings;
}

/**
 * A readable label from the key name, for consumers a key reaches without one.
 * Deterministic: the same key always yields the same label.
 */
export function deriveLabel(key: string): string {
  const separator = key.lastIndexOf('__');
  const leaf = separator === -1 ? key : key.slice(separator + 2);
  const words = leaf.split('_').filter((w) => w.length > 0);
  const first = words[0];
  if (first === undefined) return key;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/**
 * A key's declaration, read as an own property: a key name from a command line,
 * a document or a request never answers from the prototype (`constructor`).
 */
export function keyDefOf(d: Descriptor, key: string): KeyDef | undefined {
  return Object.hasOwn(d.keys, key) ? d.keys[key] : undefined;
}

function schemaError(err: ErrorObject): DescriptorError {
  const params = err.params as Record<string, unknown>;
  const segments = err.instancePath.split('/').filter((s) => s.length > 0);
  let message: string;

  switch (err.keyword) {
    case 'required':
      segments.push(String(params['missingProperty']));
      message = `must declare "${String(params['missingProperty'])}"`;
      break;
    case 'additionalProperties':
      segments.push(String(params['additionalProperty']));
      message = `is not a property this contract declares`;
      break;
    case 'enum':
      message = `must be one of: ${(params['allowedValues'] as string[]).join(', ')}`;
      break;
    case 'const':
      message = `must be ${JSON.stringify(params['allowedValue'])}`;
      break;
    case 'type':
      message = `must be ${String(params['type'])}`;
      break;
    case 'pattern':
      message = `must match ${String(params['pattern'])}`;
      break;
    case 'not':
      // The one `not` in the schema: `values` outside shape: enum.
      message = `must not declare "values" — only a key of shape: enum carries a value set`;
      break;
    default:
      message = err.message ?? 'is invalid';
  }

  const path = segments.join('/');
  return new DescriptorError(path, `descriptor invalid at ${path}: ${message}`);
}

// The published contract. `descriptor.schema.json` at the package root is
// CANONICAL (operator, 2026-08-18); the module below is generated from it —
// run `npm run codegen:schema` after editing the JSON. The core reads no files.
import { DESCRIPTOR_SCHEMA } from './descriptor-schema.generated.js';
export { DESCRIPTOR_SCHEMA };

/**
 * Every page field that names a key — each `seo` field and each JSON-LD
 * binding — in page order: the one walk the structural check reads, `remove`
 * drops through and `rename` rewrites through.
 */
export function pageKeyReferences(
  descriptor: Descriptor,
): Array<{ page: string; kind: 'seo' | 'jsonLd'; field: string; key: string }> {
  const out: Array<{ page: string; kind: 'seo' | 'jsonLd'; field: string; key: string }> = [];
  for (const [page, def] of Object.entries(descriptor.pages ?? {})) {
    for (const [field, key] of Object.entries(def.seo ?? {})) {
      if (key !== undefined) out.push({ page, kind: 'seo', field, key });
    }
    for (const [field, key] of Object.entries(def.jsonLd?.bindings ?? {})) out.push({ page, kind: 'jsonLd', field, key });
  }
  return out;
}

/**
 * stet core — the content contract, the committed snapshot, the read path and
 * the offline checks. Everything here is a pure function over parsed data: no
 * file system, no network, no database.
 *
 * This file is the root surface: the read path and the checks a host runs. The
 * generator half is reached by the CLI by module path, and the preview token
 * pair ships on `@getstet/stet/server`. The closure of this file reaches no
 * Node builtin — the offline guard and the conformance walk both assert it —
 * so a bundler targeting the browser can follow every edge out of here.
 */

// The contract types, mirroring descriptor.schema.json.
export type {
  Budget,
  ContentKey,
  Descriptor,
  JsonLdDef,
  KeyDef,
  Limits,
  PageDef,
  PageSeo,
  Severity,
  Shape,
  StetRegistry,
  Target,
  TemplateClass,
  TemplateDef,
  TemplateTrigger,
  Warning,
} from './types.js';

// Descriptor: load, validate, label.
export {
  DESCRIPTOR_SCHEMA,
  DescriptorError,
  checkDescriptorStructure,
  deriveLabel,
  loadDescriptor,
  loadDescriptorWithWarnings,
} from './descriptor.js';
export type { DescriptorWarning } from './descriptor.js';

// Snapshot: the committed values, the currency check, the smells.
export { checkCurrency, loadSnapshot, snapshotSmells } from './snapshot.js';
export type { CurrencyReport, Snapshot } from './snapshot.js';

// Resolution: key to value, in one order, in every host mode.
export { activeRow, resolve } from './resolve.js';
export type { Resolution, ResolutionSource, ResolveQuery, StoreRow } from './resolve.js';

// Preview: the states a preview names, and the override resolver.
export { pageSpan, resolvePreview } from './preview.js';
export type { PreviewState } from './preview.js';

// The read bundle: the build-time contract, in both its forms.
export { readBundle, resolveAll, resolveFromBundle } from './bundle.js';
export type { Bundle } from './bundle.js';

// Ambient access: the framework-free accessor contract.
export { AccessError, createAccessor } from './access.js';
export type { Accessor, AccessorOptions } from './access.js';

// The store contract: one interface, and the answers an adapter may return.
export type {
  DraftRefusal,
  NotSupported,
  SaveDraftParams,
  StoreAdapter,
  StoreError,
  VersionRow,
} from './store.js';

// Save-time validation: shapes, limits, variables, class rules, fit budgets.
export {
  checkBudget,
  checkClassRules,
  checkLimits,
  checkTags,
  checkVars,
  plainOf,
  shapeSchema,
  templateOf,
  validateSave,
} from './validate.js';
export type {
  Advisory,
  Finding,
  FindingRule,
  SaveCandidate,
  SaveVerdict,
  Verdict,
} from './validate.js';

// The SEO check: nine rules over the descriptor and the committed snapshot.
export { SEO_SEVERITY, seoCheck } from './seo.js';
export type { SeoFinding, SeoRule } from './seo.js';

// Targets: one adapter per render destination, and the one registry.
export { targetAdapter, targetAdapterIfShipped } from './targets/adapter.js';
export type { TargetAdapter } from './targets/adapter.js';
export { htmlEmailTarget } from './targets/html-email.js';
export { webTarget } from './targets/web.js';

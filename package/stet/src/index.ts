/**
 * stet core — the content contract, the committed snapshot, the read path and
 * the offline checks. Everything here is a pure function over parsed data: no
 * file system, no network, no database. This file is the package's inventory.
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

// Codegen: the typed registry, the ambient types, the source hash they carry.
export {
  canonicalize,
  embeddedHash,
  generateRegistry,
  generatedBody,
  generatedHeader,
  sourceHash,
} from './codegen.js';

// Snapshot: the committed values, the generated module, the offline checks.
export {
  checkCurrency,
  checkGeneratedCurrent,
  generateDefaultsModule,
  loadSnapshot,
  snapshotSmells,
} from './snapshot.js';
export type { CurrencyReport, GeneratedCheck, GeneratedState, Snapshot } from './snapshot.js';

// Resolution: key to value, in one order, in every host mode.
export { activeRow, resolve } from './resolve.js';
export type { Resolution, ResolutionSource, ResolveQuery, StoreRow } from './resolve.js';

// Preview: the states a preview names, the signed token, the override resolver.
export { mintPreviewToken, pageSpan, resolvePreview, verifyPreviewToken } from './preview.js';
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
  checkVars,
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

// The SEO check: eight rules over the descriptor and the committed snapshot.
export { SEO_SEVERITY, seoCheck } from './seo.js';
export type { SeoFinding, SeoRule } from './seo.js';

// Targets: one adapter per render destination, and the one registry.
export { targetAdapter, targetAdapterIfShipped } from './targets/adapter.js';
export type { TargetAdapter } from './targets/adapter.js';
export { htmlEmailTarget } from './targets/html-email.js';
export { webTarget } from './targets/web.js';

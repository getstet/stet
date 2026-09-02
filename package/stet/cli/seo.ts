/**
 * `stet seo check` — the nine SEO rules over the descriptor and the committed
 * snapshot.
 *
 * It builds no adapter, exactly as `check` does not: the loading path is
 * `check`'s own, not `loadProject`, which constructs an adapter and throws on a
 * store-declaring project whose connection variable is unset. That project is
 * the whole point — a fork PR, no secrets, nothing deployed — and it is what
 * lets this be the only SEO checker that runs before a deploy exists.
 *
 * What it does NOT see is production. The rules read committed copy, so after a
 * publish made directly against a production store the snapshot is stale until
 * `stet pull` runs; a store-backed project is told so, once, in a warn that
 * never moves the exit code (§14 S8).
 */

import { seoCheck } from '../src/seo.js';
import type { Descriptor } from '../src/types.js';
import type { Snapshot } from '../src/snapshot.js';
import { flag, noPositionals, parse, refuseEnv } from './args.js';
import { descriptorOf, snapshotOf } from './check.js';
import { loadConfig, seoOverrides, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { Report } from './report.js';
import { isStoreBacked } from './store.js';

export async function runSeoCheck(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'seo check');
  const { values, positionals } = parse(args, { json: 'boolean' });
  noPositionals(positionals, 'seo check');

  const report = new Report();
  const config = loadConfig(io.cwd);
  staleness(config, report);

  // Structure warnings ride along from `descriptorOf` — an incomplete slot set
  // is reported here too, and that is correct output rather than noise to
  // suppress: the descriptor is this command's input as much as check's.
  const descriptor = descriptorOf(config, io.cwd, report);
  const snapshot = descriptor === null ? null : snapshotOf(config, io.cwd, report);
  if (descriptor !== null && snapshot !== null) rules(config, descriptor, snapshot, report);

  return report.emit(io, { json: flag(values, 'json') });
}

/**
 * The §14 S8 warn, keyed on store-backedness rather than on a connection: some
 * declared block — the bare `store` or any `environments` member — names an
 * adapter other than `snapshot`. A config-level fact, so no network is touched
 * and no adapter is constructed, and a declared `adapter: 'snapshot'` is not a
 * store and gets no warn.
 */
function staleness(config: StetConfig, report: Report): void {
  const declared = [config.store, ...Object.values(config.environments ?? {})];
  if (!declared.some(isStoreBacked)) return;
  report.warn(
    'store',
    'seo check validates the committed snapshot, not production — after a prod-direct publish, run stet pull so CI checks current copy',
  );
}

/**
 * The rules, reported both ways. Line-wise through `Report` so a human reads
 * one message per finding, AND whole through `report.data`, because
 * `CliFinding` has no page or locale field and stuffing them into `key` would
 * break that field's documented contract — a `--json` consumer filters on the
 * structured block without parsing prose.
 */
function rules(
  config: StetConfig,
  descriptor: Descriptor,
  snapshot: Snapshot,
  report: Report,
): void {
  const findings = seoCheck(descriptor, snapshot, seoOverrides(config));
  for (const finding of findings) {
    const where = finding.key ?? finding.page;
    if (finding.severity === 'error') report.error(finding.rule, finding.message, where);
    else report.warn(finding.rule, finding.message, where);
  }

  // An adopted host with no pages runs every rule over nothing and prints
  // `0 pages checked` — a pass that says only that there was no input. The warn
  // takes the staleness warn's SHAPE (structured, outside the severity table, no
  // rule id, never moves the exit) and its own kind: the subject is the
  // descriptor's declaration state, not the store. A descriptor with no keys is
  // a bare repo and stays silent.
  if (Object.keys(descriptor.keys).length > 0 && Object.keys(descriptor.pages ?? {}).length === 0) {
    report.warn(
      'config',
      'no pages declared — the SEO rules have nothing to check; run stet pages scan to declare them',
    );
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  report.line(
    `seo: ${Object.keys(descriptor.pages ?? {}).length} pages checked, ` +
      `${errors} errors, ${findings.length - errors} warnings`,
  );
  report.data('seo', findings);
}

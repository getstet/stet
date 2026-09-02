/**
 * `stet check` — descriptor, snapshot and generated files, offline and
 * complete. It builds no adapter at all: not "skips the store when one is
 * missing", but has no path that could reach one, which is what makes the
 * check run on a plane, in a container, and identically with the database
 * down.
 *
 * The composition is the whole command. Every rule here already exists in
 * `src/`; check loads the files, runs them in order, and reports.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkDescriptorStructure, loadDescriptorWithWarnings } from '../src/descriptor.js';
import {
  checkGeneratedCurrent,
  generateDefaultsModule,
  generateRegistry,
} from '../src/codegen.js';
import { checkCurrency, loadSnapshot, type Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { flag, noPositionals, parse, refuseEnv } from './args.js';
import { loadConfig, type StetConfig } from './config.js';
import type { CliIo } from './main.js';
import { Report } from './report.js';
import { validateValue } from './validate.js';

export async function runCheck(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'check');
  const { values, positionals } = parse(args, { json: 'boolean' });
  noPositionals(positionals, 'check');

  const report = new Report();
  const config = loadConfig(io.cwd);
  check(config, io.cwd, report);
  return report.emit(io, { json: flag(values, 'json') });
}

/** The check itself, so `doctor` reports the same facts without a second implementation. */
export function check(config: StetConfig, cwd: string, report: Report): void {
  const descriptor = descriptorOf(config, cwd, report);
  if (!descriptor) return;
  const snapshot = snapshotOf(config, cwd, report);
  if (!snapshot) return;

  currency(descriptor, snapshot, report);
  generated(config, cwd, descriptor, snapshot, report);
  values(descriptor, snapshot, report);
}

/**
 * The descriptor, loaded offline, with its structure warnings pushed into the
 * report — an incomplete slot set degrades one slot, it does not break the
 * project, so it is reported and never fatal.
 *
 * Exported for `seo check`, the second offline command: `loadProject` is not
 * reusable there because it constructs an adapter and throws on a
 * store-declaring project whose connection variable is unset, which is exactly
 * the fork-PR case the offline posture exists for.
 */
export function descriptorOf(config: StetConfig, cwd: string, report: Report): Descriptor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(cwd, config.descriptorPath), 'utf8'));
  } catch (error) {
    report.error('config', `${config.descriptorPath}: ${(error as Error).message}`);
    return null;
  }
  try {
    const loaded = loadDescriptorWithWarnings(raw);
    // Structure warnings are reported, never fatal: an incomplete slot set
    // degrades one slot, it does not break the project.
    for (const warning of checkDescriptorStructure(loaded.descriptor)) {
      report.warn('config', `${warning.path}: ${warning.message}`);
    }
    return loaded.descriptor;
  } catch (error) {
    report.error('config', `${config.descriptorPath}: ${(error as Error).message}`);
    return null;
  }
}

/** The committed snapshot, loaded offline. Exported beside `descriptorOf`, for the same caller. */
export function snapshotOf(config: StetConfig, cwd: string, report: Report): Snapshot | null {
  try {
    return loadSnapshot(JSON.parse(readFileSync(join(cwd, config.snapshotPath), 'utf8')));
  } catch (error) {
    report.error('config', `${config.snapshotPath}: ${(error as Error).message}`);
    return null;
  }
}

/** The descriptor and the snapshot as sets, both directions. */
function currency(descriptor: Descriptor, snapshot: Snapshot, report: Report): void {
  const currencyReport = checkCurrency(descriptor, snapshot);
  for (const key of currencyReport.missing) {
    report.error('config', `${key}: declared in the descriptor with no value in the snapshot`, key);
  }
  for (const key of currencyReport.orphans) {
    report.warn('config', `${key}: in the snapshot, not in the descriptor — stale`, key);
  }
  for (const warning of currencyReport.warnings) {
    report.warn('config', `${warning.key} (${warning.locale}): ${warning.reason}`, warning.key);
  }
  report.line(
    `snapshot: ${Object.keys(descriptor.keys).length} keys declared, ` +
      `${currencyReport.missing.length} missing, ${currencyReport.orphans.length} stale`,
  );
  // `--json` carries what the human output states, so a script never has to
  // parse the prose to learn the same three numbers.
  report.data('snapshot', {
    declared: Object.keys(descriptor.keys).length,
    missing: currencyReport.missing,
    stale: currencyReport.orphans,
  });
}

/**
 * The generated files against their sources. Three states, three fixes: stale
 * (the source moved), hand-edited (the hashes agree and the body does not),
 * and absent — which is a warning, because a project that has never run the
 * file's regenerator is unfinished, not broken.
 *
 * Each file carries its OWN regenerator, because the two do not share one:
 * `upgrade` rewrites the descriptor-derived registry and never touches the
 * snapshot-derived defaults module, which only `pull` rewrites. A finding that
 * named the wrong command sent the reader around a loop the command could not
 * close.
 */
function generated(
  config: StetConfig,
  cwd: string,
  descriptor: Descriptor,
  snapshot: Snapshot,
  report: Report,
): void {
  const files: { path: string; generate: () => string; source: unknown; remedy: string }[] = [
    {
      path: config.codegen.registry,
      source: descriptor,
      generate: () => generateRegistry(descriptor).keysTs,
      remedy: 'stet upgrade',
    },
    {
      // The ambient union is the one file that TYPES a key, so a stale one
      // keeps `copy('removed_key')` compiling in the host — exactly the residue
      // a removal that outran its codegen leaves behind. It carries the same
      // generated header the registry does, so it currency-checks the same way,
      // and `upgrade` writes both unconditionally.
      path: config.codegen.dts,
      source: descriptor,
      generate: () => generateRegistry(descriptor).dts,
      remedy: 'stet upgrade',
    },
    {
      path: config.codegen.defaults,
      source: snapshot,
      generate: () => generateDefaultsModule(snapshot),
      remedy: 'stet pull',
    },
  ];

  const states: Record<string, string> = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(cwd, file.path), 'utf8');
    } catch {
      report.warn('config', `${file.path}: not generated — run ${file.remedy}`);
      states[file.path] = 'absent';
      continue;
    }
    const state = checkGeneratedCurrent(text, file.source, file.generate);
    if (state.status === 'staleSource') {
      report.error('config', `${file.path}: stale — its source moved; run ${file.remedy}`);
    } else if (state.status === 'handEdited') {
      report.error('config', `${file.path}: hand-edited — run ${file.remedy} instead of editing`);
    } else {
      report.line(`generated: ${file.path} current`);
    }
    states[file.path] = state.status;
  }
  report.data('generated', states);
}

/** Every committed value, through the same validator `stet draft` runs. */
function values(descriptor: Descriptor, snapshot: Snapshot, report: Report): void {
  const checked = checkValues(descriptor, snapshot, report);
  report.line(`values: ${checked} checked`);
  report.data('values', { checked });
}

/**
 * The value pass itself, answering how many values it checked so the caller
 * owns its own count line.
 *
 * Exported for `remove`, the second consumer: it runs this over the forms a
 * removal would LEAVE and prints the findings the cleaned forms produce that
 * the current ones do not — so the class gate is re-run rather than
 * re-implemented, and a caution can quote the gate's own text.
 *
 * Membership is an OWN-property test. A snapshot orphan named `constructor`
 * answers a bare `in` from the prototype, and the value then reaches
 * `shapeSchema`, whose bare index returns `Object.prototype.constructor` — a
 * definition with no `shape`, which falls past every switch arm and hands the
 * caller `undefined` to parse against.
 */
export function checkValues(descriptor: Descriptor, snapshot: Snapshot, report: Report): number {
  let checked = 0;
  for (const locale of Object.keys(snapshot).sort()) {
    for (const key of Object.keys(snapshot[locale] ?? {}).sort()) {
      if (!Object.hasOwn(descriptor.keys, key)) continue; // reported as stale by the currency check
      checked += 1;
      validateValue(descriptor, snapshot, key, snapshot[locale]?.[key], locale, report);
    }
  }
  return checked;
}

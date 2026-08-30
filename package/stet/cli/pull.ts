/**
 * `stet pull` — the store's truth, materialized into the repo forms.
 *
 * Three artifacts, one resolution path and one serializer: the refreshed
 * snapshot (`defaults.json`, canonical), the generated defaults module, and —
 * on a store-backed project only — the read bundle with its version metadata.
 * A snapshot-only project gets no bundle, because its committed `defaults.json`
 * IS the bundle; emitting a second copy of the same bytes under another name is
 * the divergence the archived contract exists to prevent.
 *
 * It MERGES; it never deletes. Only the enabled locales are resolved — the
 * resolve chain would materialize a value for every key in any locale it is
 * asked, so touching a merely-present locale would inflate it rather than
 * preserve it — and within those, only resolved keys overwrite. Every other
 * locale block, and every orphan key, survives byte-for-byte. Orphans are
 * `audit`'s to report.
 */

import { join } from 'node:path';

import type { Bundle } from '../src/bundle.js';
import { activeRow, resolve } from '../src/resolve.js';
import { generateDefaultsModule, type Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';
import { shapeSchema } from '../src/validate.js';
import { writeJsonDeterministic, writeText } from './artifacts.js';
import { ENV_OPTION, noPositionals, parse, text } from './args.js';
import type { CliIo } from './main.js';
import { loadProject, refuseAbsence } from './project.js';
import { Report } from './report.js';
import { isStoreBacked } from './store.js';

export async function runPull(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION });
  noPositionals(positionals, 'pull');

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    const report = new Report();
    report.environment(project.environment.name);
    // A non-default source is deliberate — `pull --env prod` IS the release
    // step — so it is warned, never refused: refusing would break that step's
    // symmetry. The warn names the source and the git diff is the review
    // surface, so a staging mirror never lands silently over prod's copy.
    if (project.environment.name !== 'default') {
      report.warn(
        'store',
        `the committed snapshot and defaults module are being rewritten from the ${project.environment.name} environment, ` +
          'not the default one — read the git diff before committing it',
      );
    }
    const answer = await project.readRows();
    // A mirror-read: writing these files from an absent store would overwrite
    // good committed artifacts with degraded ones.
    refuseAbsence(answer, 'pull');

    const { config, descriptor, snapshot } = project;
    const keys = Object.keys(descriptor.keys).sort();
    const enabled = config.locales.enabled;

    const merged: Snapshot = {};
    for (const locale of Object.keys(snapshot).sort()) merged[locale] = { ...snapshot[locale] };
    const bundleValues: Record<string, Record<string, unknown>> = {};
    for (const locale of Object.keys(snapshot).sort()) bundleValues[locale] = { ...snapshot[locale] };
    const meta: NonNullable<Bundle['meta']> = {};

    const defaultLocale = config.locales.default;
    for (const locale of enabled) {
      const block = merged[locale] ?? {};
      const bundleBlock = bundleValues[locale] ?? {};
      for (const key of keys) {
        // The active row OF THIS LOCALE — exact, never the fallback chain.
        const live = activeRow(answer.rows.filter((r) => r.key === key), locale);
        let value: unknown;

        if (locale === defaultLocale) {
          // The default block is written in full: it is the floor every other
          // locale falls back to, and a gap in it is a key that renders nothing.
          const resolution = resolve(descriptor, snapshot, answer.rows, { key, locale });
          if (resolution.value === undefined) continue;
          value = resolution.value;
          // A stored value that failed its shape was quarantined by resolution,
          // so the value here came from somewhere else and the row behind it
          // must not stamp a version. The guard is not redundant with `live`.
          if (resolution.source !== 'active') {
            writeValue(block, bundleBlock, descriptor, key, value);
            warnOffShape(descriptor, key, locale, value, report);
            continue;
          }
        } else if (live !== undefined) {
          // A non-default locale gains a key only from its OWN row. Writing the
          // fallback chain's materialization here would stamp the default
          // locale's words into `de` as though someone had translated them —
          // and, because the block then answers for that key, kill the chain
          // for it forever. `pull` never deletes, so nothing would undo it.
          value = live.value;
        } else {
          // No row of this locale: whatever the block already carries stays
          // exactly as it is.
          continue;
        }

        writeValue(block, bundleBlock, descriptor, key, value);
        warnOffShape(descriptor, key, locale, value, report);
        if (live?.version !== undefined) (meta[locale] ??= {})[key] = { version: live.version };
      }
      merged[locale] = block;
      bundleValues[locale] = bundleBlock;
    }

    writeJsonDeterministic(join(io.cwd, config.snapshotPath), merged);
    writeText(join(io.cwd, config.codegen.defaults), generateDefaultsModule(merged));
    report.line(`wrote ${config.snapshotPath}`);
    report.line(`wrote ${config.codegen.defaults}`);

    if (isStoreBacked(project.environment.block)) {
      const bundle: Bundle = { values: bundleValues, meta };
      writeJsonDeterministic(join(io.cwd, config.bundlePath), bundle);
      report.line(`wrote ${config.bundlePath}`);
    } else {
      report.line(
        `no bundle written: this project is snapshot-only, so ${config.snapshotPath} IS the bundle — ` +
          'commit it and point any reader (including python/stet_read.py) at that file',
      );
    }

    report.line(`${keys.length} keys × ${enabled.length} locale(s): ${enabled.join(', ')}`);
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

/**
 * The bundle materializes every key, derived included — that is what a non-JS
 * consumer reads. The snapshot never carries a derived key: it is the source
 * derivation runs FROM, and a stored copy would be a second truth for the same
 * sentence.
 */
function writeValue(
  block: Record<string, unknown>,
  bundleBlock: Record<string, unknown>,
  descriptor: Descriptor,
  key: string,
  value: unknown,
): void {
  bundleBlock[key] = value;
  if (descriptor.keys[key]?.derivesFrom === undefined) block[key] = value;
}

/**
 * A committed value that fails its own declared shape passes through — `pull`
 * mirrors, it does not enforce, and dropping the key would delete content to
 * make a report clean. It says so, once, because a value that quarantines at
 * read time is worth knowing about before the page shows it. Enforcement is
 * `stet check`'s.
 */
function warnOffShape(
  descriptor: Descriptor,
  key: string,
  locale: string,
  value: unknown,
  report: Report,
): void {
  if (shapeSchema(descriptor, key).safeParse(value).success) return;
  report.warn(
    'shape',
    `${key} (${locale}): the value written fails the declared ${descriptor.keys[key]?.shape} shape — ` +
      'it will quarantine at read time; run stet check',
    key,
  );
}

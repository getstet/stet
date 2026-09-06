/**
 * `stet email verify` — the custody proof.
 *
 * The claim the migration makes is that lifting a template's copy into stet
 * changed nothing a recipient will see. This proves it the only way that claim
 * can be proven: render the file as it was BEFORE, render the working tree's
 * file AFTER, and compare the two results byte for byte. Anything looser —
 * a DOM comparison, a screenshot, a human read — passes a template whose
 * spacing quietly moved.
 *
 * The before comes from git (`HEAD:./<file>`, cwd the app root — the `./` form
 * survives a git root ABOVE the app root, which is the ordinary monorepo
 * shape), materialized BESIDE the original so its relative imports resolve
 * against the working tree's own siblings and dependencies. Where there is no
 * before — an untracked file, or a HEAD version that will not load — `--capture`
 * records the current render as the baseline instead, and that fixture is
 * committed so the proof survives the migration commit.
 *
 * It is the migration gate, not a standing check: once the custody edit is
 * committed there is no before left to drift from, and verify reports nothing
 * pending. A template with no render pointer is reported unverifiable and does
 * not move the exit code — the descriptor is the registry however an entry got
 * there, and a hand-written entry without a pointer is a complete entry.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { resolve as resolveKey } from '../src/resolve.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor, TemplateDef } from '../src/types.js';
import { flag, noPositionals, parse, refuseEnv } from './args.js';
import { asUpdate, planJson, writePlanned, type WritePlan } from './artifacts.js';
import { descriptorOf, snapshotOf } from './check.js';
import { loadConfig, type StetConfig } from './config.js';
import { MAX_OUTPUT, renderTemplate, type RenderResult } from './email-render.js';
import type { CliIo } from './main.js';
import { clip, plural, Report, shapeOf } from './report.js';

/** `src/validate.ts`'s own placeholder form — one spelling of what a `{{var}}` is. */
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Where a captured baseline lives. Project data, and meant to be committed. */
const FIXTURE_DIR = join('.stet', 'email-fixtures');

/**
 * The git messages that mean "there is no before to compare against", in three
 * classes. The first is a file git has never seen. The other two are a
 * repository with no commit at all and no repository at all — which is the
 * capture case in every ordinary sense, since no commit exists to compare
 * against either way.
 *
 * Everything else — a corrupted object above all — is that template's ERROR.
 * Reading only the exit code would fold all of them together and report a pass
 * after `--capture`, which is the one outcome this command must never produce.
 * The child is spawned with `LC_ALL=C` so a translated git still says this.
 */
const NO_BEFORE = ['exists on disk, but not in', "invalid object name 'HEAD'", 'not a git repository'];

/** Enough of a git failure to act on. */
const GIT_EXCERPT = 300;

export async function runEmailVerify(args: string[], io: CliIo): Promise<number> {
  refuseEnv(args, 'email verify');
  const { values, positionals } = parse(args, { capture: 'boolean', recapture: 'boolean', json: 'boolean' });
  noPositionals(positionals, 'email verify');
  const json = flag(values, 'json');
  // `--recapture` implies `--capture` and additionally REPLACES a baseline that
  // is already there. They are two flags because replacing one silently is how
  // a drift gets laundered: run capture again after the rewrite and the proof
  // becomes a comparison of the shell with itself.
  const recapture = flag(values, 'recapture');
  const capture = recapture || flag(values, 'capture');

  const config = loadConfig(io.cwd);
  const report = new Report();
  const descriptor = descriptorOf(config, io.cwd, report);
  if (!descriptor) return report.emit(io, { json });
  const snapshot = snapshotOf(config, io.cwd, report);
  if (!snapshot) return report.emit(io, { json });

  const templates = descriptor.templates ?? {};
  const fixtures: WritePlan[] = [];
  const results: Array<{ template: string; state: string; detail?: string }> = [];
  let pointered = 0;

  for (const name of Object.keys(templates).sort()) {
    const entry = templates[name];
    if (entry === undefined) continue;
    if (entry.render === undefined) {
      // Declared but not centrally verifiable, which is a complete state and
      // not a failure: the exit code does not move.
      report.line(`${name}: unverifiable — the entry declares no render pointer`);
      results.push({ template: name, state: 'unverifiable' });
      continue;
    }
    pointered += 1;
    // A note the render seam raised about the POINTER rather than the copy —
    // it rides the verdict line either way, so a pointer naming an export the
    // module does not have is visible even on a template that passes.
    const notes: string[] = [];
    const outcome = verifyTemplate({ io, config, descriptor, snapshot, name, entry, capture, recapture, fixtures, notes });
    const said = [outcome.detail, ...new Set(notes)].filter((part) => part !== undefined && part !== '').join(' — ');
    results.push({ template: name, state: outcome.state, ...(said === '' ? {} : { detail: said }) });
    if (outcome.state === 'FAIL') {
      report.error('email', `${name}: FAIL — ${said === '' ? 'the renders differ' : said}`, name);
    } else {
      report.line(`${name}: ${outcome.state}${said === '' ? '' : ` — ${said}`}`);
    }
  }

  report.data('templates', results);

  if (pointered === 0) {
    report.line('email verify: no template carries a render pointer — nothing is centrally verifiable');
    return report.emit(io, { json });
  }

  if (fixtures.length > 0) {
    for (const plan of fixtures) report.line(`capture ${plan.label}`);
    const { written } = writePlanned(fixtures);
    report.line(
      `email verify --capture: wrote ${plural(written.length, 'baseline')} — commit them, ` +
        'so the proof survives the migration commit',
    );
  }

  return report.emit(io, { json });
}

interface VerifyContext {
  io: CliIo;
  config: StetConfig;
  descriptor: Descriptor;
  snapshot: Snapshot;
  name: string;
  entry: TemplateDef;
  capture: boolean;
  recapture: boolean;
  fixtures: WritePlan[];
  /** Where the render seam's pointer notes collect, for the verdict line. */
  notes: string[];
}

type Outcome = { state: 'PASS' | 'FAIL' | 'captured'; detail?: string };

/**
 * One template's proof. Everything that can go wrong here is that template's
 * own outcome — the walk continues, because a project mid-migration wants every
 * template's verdict in one run rather than the first one's.
 */
function verifyTemplate(ctx: VerifyContext): Outcome {
  const { io, entry } = ctx;
  const pointer = entry.render;
  if (pointer === undefined) return { state: 'FAIL', detail: 'no render pointer' };

  const props = mergedProps(ctx);
  if ('missing' in props) return { state: 'FAIL', detail: props.missing };

  const workingFile = join(io.cwd, pointer.file);
  if (!existsSync(workingFile)) {
    return { state: 'FAIL', detail: `${pointer.file} is not in the working tree — the render pointer names a file that is not there` };
  }

  // The AFTER render is needed either way: it is what a pass compares against,
  // and what `--capture` records as the baseline.
  const after = renderTemplate(io, {
    hostDir: io.cwd,
    file: workingFile,
    exportName: pointer.export,
    props: props.values,
  });
  if (!after.ok) {
    return { state: 'FAIL', detail: `the working tree's ${pointer.file} did not render (${after.reason}) — ${clip(after.detail, GIT_EXCERPT)}` };
  }
  if (after.note !== undefined) ctx.notes.push(after.note);

  const source = gitBefore(io, pointer.file);
  if (source.kind === 'error') {
    return { state: 'FAIL', detail: `could not read ${pointer.file} at HEAD — ${source.detail}` };
  }

  const again = (): string | null => secondRender(ctx, workingFile, pointer.export, props.values, after.result);

  if (source.kind === 'tracked') {
    const before = renderBefore(ctx, source.bytes, pointer.file, pointer.export, props.values);
    if (before.kind === 'collision') {
      // NOT capturable: HEAD holds a usable before and the only blocker is the
      // file on the reserved path.
      return againstFixture(
        ctx,
        after.result,
        pointer.file,
        again,
        false,
        `a file is already at ${before.path}, beside ${pointer.file} — that is where HEAD's version is ` +
          'materialized to render the before, and stet removes what it puts there, so writing over it would ' +
          'delete a file stet did not create. Move or rename that file and re-run: HEAD still holds this ' +
          'template’s before, so --capture records nothing here — a baseline taken now would record the ' +
          'CURRENT render, which proves nothing about a rewrite that already happened',
      );
    }
    if (before.render.ok) return compare(before.render.result, after.result, pointer.file, again);
    return againstFixture(
      ctx,
      after.result,
      pointer.file,
      again,
      true,
      `HEAD's ${pointer.file} did not render (${before.render.reason}) — ${clip(before.render.detail, GIT_EXCERPT)}. ` +
        'No baseline has been recorded either. Re-run with --capture BEFORE the shell rewrite to record the ' +
        'current render instead; a capture taken after it compares the rewritten template against itself',
    );
  }

  // Untracked: git has no before at all. A fixture stands in until the custody
  // edit commits, and git is preferred over a fixture wherever both exist —
  // which is why this is reached only when git had nothing.
  return againstFixture(
    ctx,
    after.result,
    pointer.file,
    again,
    true,
    `${pointer.file} is not in HEAD and no baseline has been recorded. Commit the file as it stands, then ` +
      'verify — the before then comes from the commit, where no later edit can move it. Where committing first ' +
      'is not possible, --capture records the current render as the baseline, and only a capture taken BEFORE ' +
      'the shell rewrite proves anything: one taken after it compares the rewritten template against itself',
  );
}

/**
 * The fixture route — the answer wherever git has no usable before.
 *
 * The ORDER is the whole mechanism. A baseline that is already recorded is read
 * and compared against first, and `--capture` does not touch it. Capturing over
 * a baseline is how the proof gets laundered: run `--capture` again after the
 * rewrite and the recorded render becomes the rewritten one, so the next run
 * compares the shell against itself and passes. Replacing a baseline therefore
 * takes `--recapture`, which is not a flag anyone types by habit.
 *
 * `capturable` is false on the collision route, where recording a NEW baseline
 * is the same laundering by another door: git holds a perfectly good before and
 * the blocker is a host file sitting on the reserved path, so a capture would
 * bank the already-rewritten render as the truth. A baseline that was recorded
 * EARLIER still stands in for the comparison — that is the whole reason the
 * route runs through here rather than failing outright.
 */
function againstFixture(
  ctx: VerifyContext,
  after: string,
  file: string,
  again: () => string | null,
  capturable: boolean,
  noBaseline: string,
): Outcome {
  const capture = capturable && ctx.capture;
  const recapture = capturable && ctx.recapture;
  const fixture = readFixture(ctx.io.cwd, ctx.name);

  if (fixture.kind === 'baseline' && !recapture) {
    const verdict = compare(fixture.result, after, file, again);
    if (!capture) return verdict;
    return {
      ...verdict,
      detail:
        `${verdict.detail ?? ''} — compared against the baseline already recorded, which --capture leaves in ` +
        'place; --recapture replaces it',
    };
  }

  if (fixture.kind === 'unreadable' && !recapture) {
    return {
      state: 'FAIL',
      // `--recapture` is only a remedy where a capture can happen at all. On the
      // collision route it records nothing, so offering it would send the reader
      // back to the same message.
      detail: capturable
        ? `a baseline exists for ${ctx.name} but cannot be read (${fixture.detail}) — restore it from the commit ` +
          'it was captured in, or pass --recapture to record the current render over it, which proves nothing ' +
          'about a rewrite that already happened'
        : `${noBaseline}. The baseline recorded for ${ctx.name} cannot be read either (${fixture.detail}), so ` +
          'nothing stands in for HEAD meanwhile — restore it from the commit it was captured in, or clear that ' +
          'path and let HEAD answer',
    };
  }

  if (capture) return captureBaseline(ctx, after, fixture.kind !== 'none');
  return { state: 'FAIL', detail: noBaseline };
}

/**
 * The equality gate itself.
 *
 * A mismatch has two causes and they need different answers. Usually the copy
 * drifted, and the fix is in the file. But a template that renders a date or a
 * random id cannot pass a byte comparison AT ALL, and telling that adopter the
 * copy changed sends them hunting an edit nobody made — so a failure asks the
 * template to render a second time and reports which of the two it met.
 */
function compare(before: string, after: string, file: string, again: () => string | null): Outcome {
  if (before === after) return { state: 'PASS', detail: `${after.length} bytes, identical` };
  const unstable = again();
  if (unstable !== null) {
    return {
      state: 'FAIL',
      detail:
        `${file} renders differently every time — two renders of the same input differed ` +
        `(${after.length} bytes, then ${unstable.length}), so a byte comparison can never pass it. ` +
        'Pin the varying value in the render pointer’s sampleProps, or declare this entry without a pointer',
    };
  }
  const at = firstDifference(before, after);
  return {
    state: 'FAIL',
    detail:
      `the render changed: ${before.length} bytes before, ${after.length} after, first differing at byte ${at}. ` +
      `before: ${JSON.stringify(excerpt(before, at))} · after: ${JSON.stringify(excerpt(after, at))}. ` +
      `The copy in ${file} no longer produces what it produced before the rewrite. ` +
      'Two renders of the working tree agreed, so drift is the likelier answer — a template whose output is not a ' +
      'function of its input can also produce this, on a slower clock than two renders apart',
  };
}

/** How much of each side to quote around the first difference. */
const DIFF_EXCERPT = 60;

/** The offset of the first differing character, or the shorter length. */
function firstDifference(before: string, after: string): number {
  const shared = Math.min(before.length, after.length);
  for (let i = 0; i < shared; i++) {
    if (before.charAt(i) !== after.charAt(i)) return i;
  }
  return shared;
}

/**
 * The window around an offset. It starts a little BEFORE the difference: the
 * first differing byte is usually mid-word, and a quote that opens there reads
 * as nonsense without the run-up.
 */
function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 20);
  return `${start === 0 ? '' : '…'}${text.slice(start, start + DIFF_EXCERPT)}${
    start + DIFF_EXCERPT < text.length ? '…' : ''
  }`;
}

/**
 * The working tree rendered a second time, returned only when it disagrees with
 * the first — the signature of a template whose output is not a function of its
 * input. `null` means the render is stable and the mismatch is real drift.
 */
function secondRender(
  ctx: VerifyContext,
  file: string,
  exportName: string,
  props: Record<string, unknown>,
  first: string,
): string | null {
  const repeat = renderTemplate(ctx.io, { hostDir: ctx.io.cwd, file, exportName, props });
  if (!repeat.ok || repeat.result === first) return null;
  return repeat.result;
}

type BeforeRender =
  | { kind: 'rendered'; render: RenderResult }
  | { kind: 'collision'; path: string };

/**
 * HEAD's version of the file, materialized BESIDE the original and rendered
 * there — so `../base` and every other relative import resolve against the same
 * working-tree siblings the after render sees. The temp file is removed whatever
 * happens, including a render that throws.
 *
 * Which is exactly why a file ALREADY at that path is a collision rather than a
 * write: the `finally` removes whatever it finds there, so writing over a host's
 * own file would overwrite it and then delete it. One template reported
 * unverifiable is the smaller loss.
 *
 * The guard is `lstatSync`, not `existsSync`: `existsSync` FOLLOWS the link, so
 * a dangling symlink at the reserved path reads as absent — and the write then
 * lands on the link's target, somewhere else in the host tree, while the
 * `finally` removes only the link. That leaves HEAD's bytes behind under a name
 * the host chose. The question here is whether anything occupies the path, and
 * a broken link occupies it.
 */
function renderBefore(
  ctx: VerifyContext,
  bytes: Buffer,
  relFile: string,
  exportName: string,
  props: Record<string, unknown>,
): BeforeRender {
  const abs = join(ctx.io.cwd, relFile);
  const name = `.stet-before-${basename(abs)}`;
  const temp = join(dirname(abs), name);
  if (lstatSync(temp, { throwIfNoEntry: false }) !== undefined) return { kind: 'collision', path: name };
  try {
    writeFileSync(temp, bytes);
    return { kind: 'rendered', render: renderTemplate(ctx.io, { hostDir: ctx.io.cwd, file: temp, exportName, props }) };
  } finally {
    rmSync(temp, { force: true });
  }
}

type BeforeSource =
  | { kind: 'tracked'; bytes: Buffer }
  | { kind: 'untracked' }
  | { kind: 'error'; detail: string };

/**
 * HEAD's bytes for one path.
 *
 * The `./` prefix is load-bearing: it makes the path CWD-relative, so the
 * lookup works when `.git` sits above the app root (a monorepo, or Mirra's own
 * `echogram/` over `frontend/`). The bare `HEAD:<path>` form is repo-root
 * relative and fails there — silently routing every template to "untracked" and
 * making `--capture` look like the answer.
 */
function gitBefore(io: CliIo, relFile: string): BeforeSource {
  const child = spawnSync('git', ['show', `HEAD:./${relFile}`], {
    cwd: io.cwd,
    // The C locale, so the routing below reads what git wrote rather than a
    // translation of it — an operator's `LANG` must not turn a corrupted object
    // into an "untracked" file.
    env: { ...io.env, LC_ALL: 'C' },
    maxBuffer: MAX_OUTPUT,
  });
  if (child.error !== undefined) {
    return { kind: 'error', detail: `git could not be run: ${child.error.message}` };
  }
  if (child.status === 0) return { kind: 'tracked', bytes: child.stdout };

  const stderr = (child.stderr as Buffer | null)?.toString('utf8').trim() ?? '';
  // Routed on the MESSAGE, not the exit code: every git failure exits non-zero,
  // and treating them alike would report a template as new when the truth was a
  // broken repository or a pointer naming a file that never existed.
  if (NO_BEFORE.some((message) => stderr.includes(message))) return { kind: 'untracked' };
  return { kind: 'error', detail: clip(stderr === '' ? `git exited ${String(child.status)}` : stderr, GIT_EXCERPT) };
}

/** The current render, planned as this template's baseline. */
function captureBaseline(ctx: VerifyContext, result: string, replacing: boolean): Outcome {
  const rel = join(FIXTURE_DIR, `${ctx.name}.json`);
  ctx.fixtures.push(asUpdate(planJson(join(ctx.io.cwd, rel), { result }, rel)));
  return {
    state: 'captured',
    detail: `${result.length} bytes recorded as the baseline${replacing ? ', over the one that was there' : ''}`,
  };
}

type Fixture =
  | { kind: 'none' }
  | { kind: 'baseline'; result: string }
  | { kind: 'unreadable'; detail: string };

/**
 * A previously captured baseline.
 *
 * A file that is there but will not yield a render is `unreadable`, never
 * `none`: folding the two together would let a truncated or hand-edited fixture
 * be silently captured over, which is the same laundering by another route.
 */
function readFixture(cwd: string, name: string): Fixture {
  const path = join(cwd, FIXTURE_DIR, `${name}.json`);
  if (!existsSync(path)) return { kind: 'none' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { kind: 'unreadable', detail: clip(error instanceof Error ? error.message : String(error), GIT_EXCERPT) };
  }
  // `Object.hasOwn`: the fixture is JSON-parsed, so a bare read would answer for
  // `constructor` and hand the comparison a function's source.
  if (raw === null || typeof raw !== 'object' || !Object.hasOwn(raw, 'result')) {
    return { kind: 'unreadable', detail: 'it holds no result field' };
  }
  const held = (raw as { result: unknown }).result;
  if (typeof held !== 'string') return { kind: 'unreadable', detail: `its result is ${typeof held}, not a string` };
  return { kind: 'baseline', result: held };
}

/**
 * The ONE argument the export is called with: the sample props the pointer
 * declares, plus every slot's resolved value under its flattened name, with
 * each `{{var}}` substituted from those same sample props.
 *
 * The substitution is what reproduces the before: the original file
 * interpolated `props.name` into its markup, so the seeded `{{name}}` has to
 * become the same characters before the shell renders it.
 */
function mergedProps(ctx: VerifyContext): { values: Record<string, unknown> } | { missing: string } {
  const { descriptor, snapshot, config, name, entry } = ctx;
  const pointer = entry.render;
  const sample = pointer?.sampleProps ?? {};
  const values: Record<string, unknown> = { ...sample };

  for (const slot of entry.slots) {
    const key = `${name}__${slot}`;
    const resolved = resolveKey(descriptor, snapshot, null, { key, locale: config.locales.default });
    if (resolved.value === undefined) {
      return { missing: `the slot ${JSON.stringify(slot)} resolves to no value (${key}) — seed it before verifying` };
    }
    if (typeof resolved.value !== 'string') {
      // A slot value is text. Passing a number or an object through renders
      // whatever it stringifies to, and the comparison then reports a byte
      // difference — a true sentence about the wrong problem, which sends the
      // reader looking for a copy edit nobody made.
      return {
        missing:
          `${key} resolved to ${shapeOf(resolved.value)}, not a string — fix the snapshot value; ` +
          'a slot that is not text cannot be compared as copy',
      };
    }
    let unresolved: string | null = null;
    const substituted = resolved.value.replace(VARIABLE, (whole: string, variable: string) => {
      // `Object.hasOwn`: `sampleProps` is JSON-parsed, so a bare lookup would
      // answer for `constructor` and hand the renderer a function.
      if (!Object.hasOwn(sample, variable)) {
        unresolved ??= variable;
        return whole;
      }
      return String((sample as Record<string, unknown>)[variable]);
    });
    if (unresolved !== null) {
      return {
        missing:
          `${key} seeds {{${unresolved}}}, which is not a member of this template's sampleProps — ` +
          'add it to the render pointer, or fix the placeholder',
      };
    }
    values[key] = substituted;
  }
  return { values };
}

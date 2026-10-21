/**
 * `stet email render` and `stet email test` — a declared template, rendered
 * the way the host would send it.
 *
 * Both go through the one render path `email verify` uses: the pointer's
 * request, `renderTemplate`, the runner. What these commands add is the values:
 * the slots resolve from the snapshot, or from the store with the drafts laid
 * over them under `--draft`, so an editor sees (or sends themselves) the email
 * their pending words would produce. `test` hands the render to the host's own
 * send function, which `emailSend` in `stet.config.json` names; the runner
 * calls it in the same child, after the frame and the fill, so the host
 * function receives exactly the markup `render` writes.
 */

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { resolve as resolveKey } from '../src/resolve.js';
import { ENV_OPTION, flag, parse, required, text } from './args.js';
import {
  containedPointer,
  outsideLine,
  pointerRequest,
  renderTemplate,
  sendRequest,
  slotSubject,
  templateProps,
  type RenderRequest,
} from './email-render.js';
import type { CliIo } from './main.js';
import { loadProject, refuseAbsence, type LoadedProject } from './project.js';
import { CliError, Report, sanitizeLine, UsageError } from './report.js';
import { isStoreBacked } from './store.js';

interface Rendered {
  html: string;
  subject: string | null;
}

export async function runEmailRender(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION, draft: 'boolean', locale: 'string', out: 'string' });
  const name = required(positionals, 'email render', 'template');
  const out = text(values, 'out');

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    // No environment line: stdout carries the html and nothing else.
    const report = new Report();
    const rendered = await renderEmail(io, project, report, 'email render', name, {
      draft: flag(values, 'draft'),
      locale: text(values, 'locale') ?? 'default',
    });
    if (rendered === null) return report.emit(io);

    if (out === undefined) {
      io.stdout(rendered.html);
    } else {
      try {
        writeFileSync(resolvePath(io.cwd, out), rendered.html, 'utf8');
      } catch (error) {
        report.error('email', (error as Error).message);
        return report.emit(io);
      }
      if (rendered.subject !== null) io.stderr(`subject: ${sanitizeLine(rendered.subject)}`);
    }
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

export async function runEmailTest(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, { ...ENV_OPTION, to: 'string', draft: 'boolean', locale: 'string' });
  const name = required(positionals, 'email test', 'template');
  const to = text(values, 'to');
  if (to === undefined || to === '') throw new UsageError('stet email test <template> --to ADDR');
  // The mount's test-send refuses the same characters: an address carrying a
  // line break reaches a host's mail header as a second header.
  if (/[\r\n]/.test(to)) throw new CliError('recipient must not contain a newline');

  const project = await loadProject(io, { env: text(values, 'env') });
  try {
    const send = project.config.emailSend;
    if (send === undefined) {
      throw new CliError('stet email test needs emailSend in stet.config.json — the host function that sends one email');
    }
    const report = new Report();
    report.environment(project.environment.name);
    const rendered = await renderEmail(io, project, report, 'email test', name, {
      draft: flag(values, 'draft'),
      locale: text(values, 'locale') ?? 'default',
      send: { ...send, to },
    });
    if (rendered === null) return report.emit(io);

    report.line(`sent ${name} to ${to}`);
    return report.emit(io);
  } finally {
    await project.dispose();
  }
}

interface RenderOptions {
  draft: boolean;
  locale: string;
  /** `email test`: the host send function and the recipient. */
  send?: { file: string; export: string; to: string };
}

/**
 * One template rendered with the values the snapshot or store resolves, or null
 * with the reason on the report. A snapshot-only site reads no store at all; a
 * store-backed one reads with the drafts under `--draft` and refuses to render
 * from a store that did not answer, since an email built from the committed
 * words would be sent as though it carried the stored ones.
 */
async function renderEmail(
  io: CliIo,
  project: LoadedProject,
  report: Report,
  command: string,
  name: string,
  opts: RenderOptions,
): Promise<Rendered | null> {
  const { descriptor, snapshot } = project;
  const templates = descriptor.templates ?? {};
  const entry = Object.hasOwn(templates, name) ? templates[name] : undefined;
  if (entry === undefined) {
    report.error('email', `${name} is not a template in the descriptor`, name);
    return null;
  }
  const pointer = entry.render;
  const probe = pointerRequest(io.cwd, descriptor, name, {});
  if (probe === null || pointer === undefined) {
    report.error('email', `${name} has no render pointer — declare one, or render it through the host`, name);
    return null;
  }
  const outside = containedPointer(io.cwd, pointer, opts.send);
  if (outside !== null) {
    report.error('email', outsideLine(outside), name);
    return null;
  }

  let rows = null;
  if (isStoreBacked(project.environment.block)) {
    const answer = await project.readRows({ preview: opts.draft, locale: opts.locale });
    refuseAbsence(answer, command);
    rows = answer.rows;
  }
  const valueOf = (key: string): unknown =>
    resolveKey(descriptor, snapshot, rows, { key, locale: opts.locale, preview: opts.draft }).value;

  const props = templateProps(name, entry, valueOf);
  if ('missing' in props) {
    report.error('email', `${name}: ${props.missing}`, name);
    return null;
  }

  const subject = slotSubject(name, entry, descriptor, props.values, valueOf);
  const request: RenderRequest =
    opts.send === undefined ? { ...probe, props: props.values } : sendRequest(probe, props.values, name, subject, opts.send);

  const rendered = renderTemplate(io, request);
  if (!rendered.ok) {
    // A send failure is the host's own error, printed as it stands.
    report.error('email', rendered.reason === 'send-failed' ? rendered.detail : `${name} did not render (${rendered.reason}) — ${rendered.detail}`, name);
    return null;
  }
  if (rendered.note !== undefined) report.warn('email', rendered.note, name);

  const result = JSON.parse(rendered.result) as string | Record<string, string>;
  const html = typeof result === 'string' ? result : result['html'];
  if (typeof html !== 'string') {
    report.error('email', `${name} renders a map with no html member — the email is its html`, name);
    return null;
  }
  const mapSubject = typeof result === 'string' ? undefined : result['subject'];
  return { html, subject: typeof mapSubject === 'string' ? mapSubject : subject };
}

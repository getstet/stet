/**
 * A temp host project with one declared email template, for the dashboard's
 * email preview and `stet dev`'s mount renderer.
 *
 * The template `welcome` has the slots headline, subject, preheader and
 * greeting (`{{name}}`, which its key requires). Its render pointer, the
 * template source and the snapshot are the caller's to change; the host
 * links the workspace's `node_modules`, so the runner can compile the
 * template with the host's own TypeScript.
 *
 * Consumers: `tests/email-preview.test.ts` and `tests/dev.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { makeEmailHost, type EmailHost } from './email-host.js';

export const SNAPSHOT = {
  welcome__headline: 'Welcome to mirra',
  welcome__subject: 'Welcome aboard',
  welcome__preheader: 'Your first week starts here',
  welcome__greeting: 'Hi {{name}}',
} as const;

export interface PreviewHostOptions {
  /** The template's source; the default renders the headline and greeting in an h1 and a p. */
  template?: string;
  /** The pointer's `file`, `frame` and `fill` overrides. */
  pointer?: { file?: string; frame?: { file: string; export: string; args?: string[] | '$all' }; fill?: boolean };
  /** Extra `stet.config.json` members. */
  config?: Record<string, unknown>;
  /** Files to put in the host, by relative path. */
  files?: Record<string, string>;
  /** Replaces the snapshot's default block. */
  snapshot?: Record<string, string>;
  /** Further locales' blocks of the snapshot. */
  locales?: Record<string, Record<string, string>>;
}

export const DEFAULT_TEMPLATE =
  'export function welcome(props: Record<string, string>): string {\n' +
  "  return '<html><head><title>' + props.welcome__subject + '</title></head><body>' +\n" +
  "    '<h1>' + props.welcome__headline + '</h1><p>' + props.welcome__greeting + '</p>' +\n" +
  "    '<p>' + props.welcome__preheader + '</p></body></html>';\n" +
  '}\n';

export interface PreviewHost extends EmailHost {
  /** The host's directory with symlinks resolved, as the workspace names it. */
  real: string;
}

export function previewHost(opts: PreviewHostOptions = {}): PreviewHost {
  const host = makeEmailHost();
  const pointer = {
    file: opts.pointer?.file ?? 'lib/email/welcome.ts',
    export: 'welcome',
    sampleProps: { name: 'Ada' },
    ...(opts.pointer?.frame === undefined ? {} : { frame: opts.pointer.frame }),
    ...(opts.pointer?.fill === undefined ? {} : { fill: opts.pointer.fill }),
  };
  const text = { shape: 'text', target: 'html-email' } as const;
  host.put(
    'content/descriptor.json',
    `${JSON.stringify({
      version: 1,
      keys: {
        welcome__headline: { ...text, limits: { max: 60, severity: 'advisory' } },
        welcome__subject: text,
        welcome__preheader: text,
        welcome__greeting: { ...text, vars: ['name'], requires: ['name'] },
      },
      templates: {
        welcome: {
          class: 'transactional',
          trigger: 'manual',
          slots: ['headline', 'subject', 'preheader', 'greeting'],
          render: pointer,
        },
      },
    })}\n`,
  );
  host.put('content/defaults.json', `${JSON.stringify({ default: opts.snapshot ?? SNAPSHOT, ...opts.locales })}\n`);
  host.put('lib/email/welcome.ts', opts.template ?? DEFAULT_TEMPLATE);
  host.put(
    'stet.config.json',
    `${JSON.stringify({ project: 'default', managedSurfaces: [], emailSurfaces: [], ...opts.config })}\n`,
  );
  for (const [rel, body] of Object.entries(opts.files ?? {})) host.put(rel, body);
  return { ...host, real: host.dir };
}

const outsides: string[] = [];

/** Every directory `outsideFile` made, removed. */
export function cleanupOutsideFiles(): void {
  for (const dir of outsides) rmSync(dir, { recursive: true, force: true });
  outsides.length = 0;
}

/** A file outside the host, in a directory of its own: its absolute path and its path from the host. */
export function outsideFile(host: EmailHost, source: string): { rel: string; abs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stet-outside-'));
  outsides.push(dir);
  const abs = join(dir, 'tpl.ts');
  writeFileSync(abs, source, 'utf8');
  return { rel: relative(host.dir, abs), abs };
}

/** A symlink inside the host, at `rel`, to a file outside it. */
export function linkOut(host: EmailHost, rel: string, target: string): void {
  mkdirSync(dirname(join(host.dir, rel)), { recursive: true });
  symlinkSync(target, join(host.dir, rel));
}

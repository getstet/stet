/**
 * `stet audit lighthouse` where the optional `typescript` peer is not there.
 *
 * Its own file because `vi.mock` is file-scoped and shadows any real resolution
 * (`eject-no-typescript.test.ts` stands alone for the same reason). The
 * footprint line for a mount no client reads cannot say whether `stet upgrade`
 * takes the mount out, so it names the install that lets upgrade decide.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('typescript', () => {
  const error = new Error("Cannot find package 'typescript' imported from lighthouse") as Error & { code?: string };
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
});

import { runCli, type CliIo } from '../cli/main.js';
import { cleanLhr, fakeLighthouse } from './helpers/lighthouse.js';

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
}

describe('stet audit lighthouse — the footprint without typescript', () => {
  it('says to install typescript for a mount no client reads, and not that the mount is not the one stet init wrote', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-nots-'));
    write(cwd, 'stet.config.json', JSON.stringify({ project: 't', managedSurfaces: ['app/**/*.tsx'] }));
    write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {}, pages: { home: { route: '/' } } }));
    write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
    write(
      cwd,
      'app/layout.tsx',
      "import { CopyProvider } from '@getstet/stet/react';\nimport type { Descriptor } from '@getstet/stet';\nimport descriptorJson from '../content/descriptor.json';\nimport { RESOLVED } from '../content/resolved';\n\n" +
        'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body><CopyProvider descriptor={descriptorJson as unknown as Descriptor} resolved={RESOLVED}>{children}</CopyProvider></body></html>;\n}\n',
    );
    write(cwd, 'lib/content.ts', "import { createServerCopy } from '@getstet/stet/react/server';\nexport const copy = createServerCopy(d, r);\n");
    const out: string[] = [];
    const io: CliIo = {
      cwd,
      env: { STET_WORKSPACE: join(cwd, '.no-workspace.json') },
      stdout: (line) => out.push(line),
      stderr: () => {},
      lighthouse: fakeLighthouse({ '/': cleanLhr() }).start,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    };
    expect(await runCli(['audit', 'lighthouse', '--url', 'http://127.0.0.1:3999/'], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('stet  app/layout.tsx mounts CopyProvider and no client reads — install typescript, then stet upgrade can unmount it');
    expect(text).not.toContain('not the one stet init wrote');
  });
});

/**
 * `stet audit lighthouse --build` signalled while the preview's free port is
 * being probed: the build has exited, the run has ended on the signal, and no
 * preview is spawned after the one `finally` has run.
 *
 * Its own file because `vi.mock('node:net')` is file-scoped. The probe's server
 * raises the signal on its `listen`, the one point the window can be hit
 * deterministically in process.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:net', async (importOriginal) => {
  const net = await importOriginal<typeof import('node:net')>();
  return {
    ...net,
    createServer: (...args: Parameters<typeof net.createServer>) => {
      const server = net.createServer(...args);
      const listen = server.listen.bind(server) as (...a: unknown[]) => typeof server;
      server.listen = ((...a: unknown[]) => {
        process.emit('SIGINT', 'SIGINT');
        return listen(...a);
      }) as typeof server.listen;
      return server;
    },
  };
});

import { runCli, type CliIo } from '../cli/main.js';
import { cleanLhr, fakeLighthouse } from './helpers/lighthouse.js';

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
}

describe('stet audit lighthouse --build — a signal during the port probe', () => {
  it('spawns no preview, exits 130 and prints no report', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stet-lighthouse-sigport-'));
    write(cwd, 'stet.config.json', JSON.stringify({ project: 't', managedSurfaces: ['app/**/*.tsx'] }));
    write(cwd, 'content/descriptor.json', JSON.stringify({ version: 1, keys: {}, pages: { home: { route: '/' } } }));
    write(cwd, 'content/defaults.json', JSON.stringify({ default: {} }));
    write(cwd, 'app/layout.tsx', 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n');
    write(cwd, 'lib/content.ts', "import { createServerCopy } from '@getstet/stet/react/server';\nexport const copy = createServerCopy(d, r);\n");
    write(cwd, 'package.json', JSON.stringify({ name: 'h', private: true, scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" } }));
    const workspace = join(cwd, '.workspace.json');
    const preview = "node -e \"require('fs').writeFileSync('preview.pid', String(process.pid)); setInterval(() => {}, 1000)\"";
    writeFileSync(workspace, JSON.stringify({ sites: [{ path: realpathSync(cwd), previewCommand: preview }] }));
    const out: string[] = [];
    const io: CliIo = {
      cwd,
      env: { STET_WORKSPACE: workspace },
      stdout: (line) => out.push(line),
      stderr: () => {},
      lighthouse: fakeLighthouse({ '/': cleanLhr() }).start,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      previewWaitMs: 3_000,
    };
    expect(await runCli(['audit', 'lighthouse', '--build'], io)).toBe(130);
    // The preview would write its pid file within a moment of its spawn.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(join(cwd, 'built.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'preview.pid'))).toBe(false);
    expect(out).toEqual([]);
  }, 30_000);
});

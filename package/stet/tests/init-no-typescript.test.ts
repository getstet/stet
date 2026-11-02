/**
 * `stet init` where stet's own `typescript` does not load (P3-12).
 * `init` mounts no provider, so nothing in it needs the compiler: the scaffold
 * is written whole and the not-mounted line printed. This file mocks
 * `typescript` so the dynamic import rejects — kept separate so the mock never
 * shadows the real compiler the other init/scan tests parse with.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('typescript', () =>
  Promise.reject(
    Object.assign(new Error("Cannot find package 'typescript' imported from init"), {
      code: 'ERR_MODULE_NOT_FOUND',
    }),
  ),
);

import { runInit } from '../cli/init.js';
import type { CliIo } from '../cli/main.js';

const APP_LAYOUT = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

describe('runInit — typescript absent (P3-12)', () => {
  it('writes the scaffold and degrades the mount to a snippet, never a half-adopted repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stet-init-nots-'));
    // A React host, and it says so: the provider mount is what this case is
    // about, and init scaffolds against the host's own declared dependencies.
    write(dir, 'package.json', `${JSON.stringify({ name: 'host', private: true, dependencies: { react: '^19' } }, null, 2)}\n`);
    write(dir, 'app/layout.tsx', APP_LAYOUT);
    const out: string[] = [];
    const io: CliIo = { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: () => {} };

    // init mounts nothing, so it loads no compiler for a mount at all.
    const code = await runInit(['--yes'], io);
    expect(code).toBe(0);

    // The scaffold committed despite the missing peer.
    for (const f of ['content/descriptor.json', 'lib/content.ts', 'stet.config.json']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    // The layout is untouched and the line says who mounts the provider.
    expect(readFileSync(join(dir, 'app/layout.tsx'), 'utf8')).toBe(APP_LAYOUT);
    expect(out).toContain('CopyProvider: not mounted — stet register mounts it in app/layout.tsx when a client component first reads copy');
    expect(out.join('\n')).not.toContain("'typescript' is not installed");
  });
});

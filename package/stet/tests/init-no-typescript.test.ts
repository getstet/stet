/**
 * `stet init` on a host with the optional `typescript` peer absent (P3-12).
 * `typescript` is loaded BEFORE any file is written, so its absence degrades the
 * ONE mount edit to a printed snippet rather than leaving a half-adopted repo
 * (the scaffold written, the mount then throwing). This file mocks `typescript`
 * so the dynamic import rejects — kept separate so the mock never shadows the
 * real compiler the other init/scan tests parse with.
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

    // --yes would apply the mount if typescript were present; here it still cannot
    // parse, so the mount degrades regardless.
    const code = await runInit(['--yes'], io);
    expect(code).toBe(0);

    // The scaffold committed despite the missing peer.
    for (const f of ['content/descriptor.json', 'lib/content.ts', 'stet.config.json']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    // The mount was skipped with the actionable message and the manual snippet,
    // and the layout is untouched.
    expect(readFileSync(join(dir, 'app/layout.tsx'), 'utf8')).toBe(APP_LAYOUT);
    const joined = out.join('\n');
    expect(joined).toContain("'typescript' is not installed");
    expect(joined).toContain("import { CopyProvider } from '@getstet/stet/react'");
  });
});

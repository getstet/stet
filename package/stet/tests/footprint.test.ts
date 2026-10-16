import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultConfig, type StetConfig } from '../cli/config.js';
import { clientReadFiles, INIT_READ_IMPORT, readPathImport, SERVER_READ_IMPORT } from '../cli/footprint.js';

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
}

const config = (): StetConfig => ({ ...defaultConfig(), managedSurfaces: ['app/**/*.tsx'] });
const READ_BODY = "\nimport { readBundle, resolveAll } from '@getstet/stet';\n\nexport const copy = createServerCopy(descriptor, resolved);\n";

describe('readPathImport — the read path as upgrade and the audit read it (D7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stet-footprint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the line init wrote, once, as init-line under LF and CRLF', () => {
    write(dir, 'lib/content.ts', `${INIT_READ_IMPORT}${READ_BODY}`);
    expect(readPathImport(dir, config())).toBe('init-line');
    write(dir, 'lib/content.ts', `${INIT_READ_IMPORT}${READ_BODY}`.replace(/\n/g, '\r\n'));
    expect(readPathImport(dir, config())).toBe('init-line');
  });

  it('reads any other @getstet/stet/react import, beside the line or in its place, or the line twice, as other', () => {
    write(dir, 'lib/content.ts', `import { createServerCopy, useCopy } from '@getstet/stet/react';${READ_BODY}`);
    expect(readPathImport(dir, config())).toBe('other');
    write(dir, 'lib/content.ts', `${INIT_READ_IMPORT}\nimport { useCopy } from '@getstet/stet/react';${READ_BODY}`);
    expect(readPathImport(dir, config())).toBe('other');
    write(dir, 'lib/content.ts', `${INIT_READ_IMPORT}\n${INIT_READ_IMPORT}${READ_BODY}`);
    expect(readPathImport(dir, config())).toBe('other');
  });

  it('reads react/server, an html host and a missing read path as clean', () => {
    write(dir, 'lib/content.ts', `${SERVER_READ_IMPORT}${READ_BODY}`);
    expect(readPathImport(dir, config())).toBe('clean');
    write(dir, 'lib/content.ts', `${INIT_READ_IMPORT}${READ_BODY}`);
    expect(readPathImport(dir, { ...config(), host: 'html' })).toBe('clean');
    rmSync(join(dir, 'lib/content.ts'));
    expect(readPathImport(dir, config())).toBe('clean');
  });
});

describe('clientReadFiles — the files that read copy on the client (D7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stet-footprint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every useCopy import from @getstet/stet/react across the checkout, and nothing else', () => {
    write(dir, 'app/nav.tsx', "'use client';\nimport { useCopy } from '@getstet/stet/react';\nexport function Nav() { return <a>{useCopy()('k')}</a>; }\n");
    write(dir, 'components/Nav.tsx', "'use client';\nimport { useCopy } from '@getstet/stet/react';\n");
    write(dir, 'lib/client.ts', "export { useCopy } from '@getstet/stet/react';\n");
    write(dir, 'app/wrapped.tsx', "'use client';\nimport { useCopy } from\n  '@getstet/stet/react';\n");
    write(dir, 'app/page.tsx', "import { copy } from '@/lib/content';\nexport default function Page() { return <h1>{copy('k')}</h1>; }\n");
    write(dir, 'app/layout.tsx', "import { CopyProvider } from '@getstet/stet/react';\n");
    write(dir, 'node_modules/x/index.js', "import { useCopy } from '@getstet/stet/react';\n");
    write(dir, 'dist/app.js', "import { useCopy } from '@getstet/stet/react';\n");
    write(dir, 'build/app.js', "import { useCopy } from '@getstet/stet/react';\n");
    expect(clientReadFiles(dir, { ...config(), rootLayout: 'app/layout.tsx' })).toEqual(['app/nav.tsx', 'app/wrapped.tsx', 'components/Nav.tsx', 'lib/client.ts']);
  });

  it('lists a file reaching the provider module by namespace, default, side-effect, dynamic import or require, and not the root layout nor the read path stet rewrites first', () => {
    const withLayout = { ...config(), rootLayout: 'app/layout.tsx' };
    write(dir, 'components/Ns.tsx', "'use client';\nimport * as stet from '@getstet/stet/react';\nexport const A = stet.useCopy;\n");
    write(dir, 'components/Req.tsx', "'use client';\nconst { useCopy } = require('@getstet/stet/react');\nexport const B = useCopy;\n");
    write(dir, 'components/Dflt.tsx', "'use client';\nimport stet from '@getstet/stet/react';\nexport const C = stet;\n");
    write(dir, 'components/Side.tsx', "import '@getstet/stet/react';\n");
    write(dir, 'components/Lazy.tsx', "export const load = () => import('@getstet/stet/react');\n");
    write(dir, 'components/Server.tsx', "import { createServerCopy } from '@getstet/stet/react/server';\n");
    write(dir, 'app/layout.tsx', "import { CopyProvider } from '@getstet/stet/react';\n");
    write(dir, 'lib/content.ts', `${INIT_READ_IMPORT}${READ_BODY}`);
    expect(clientReadFiles(dir, withLayout)).toEqual(['components/Dflt.tsx', 'components/Lazy.tsx', 'components/Ns.tsx', 'components/Req.tsx', 'components/Side.tsx']);
    // A read path `upgrade` leaves for the hand still imports the index: the mount stays.
    write(dir, 'lib/content.ts', `import { createServerCopy, useCopy } from '@getstet/stet/react';${READ_BODY}`);
    expect(clientReadFiles(dir, withLayout)).toContain('lib/content.ts');
  });

  it("lists a root layout that reads copy beyond its own CopyProvider import, and not one holding the import alone", () => {
    const withLayout = { ...config(), rootLayout: 'src/main.tsx' };
    write(dir, 'src/main.tsx', "import { CopyProvider } from '@getstet/stet/react';\n");
    expect(clientReadFiles(dir, withLayout)).toEqual([]);
    write(dir, 'src/main.tsx', "import { CopyProvider } from '@getstet/stet/react';\nimport { useCopy } from '@getstet/stet/react';\n");
    expect(clientReadFiles(dir, withLayout)).toEqual(['src/main.tsx']);
    write(dir, 'src/main.tsx', "import { CopyProvider, useCopy } from '@getstet/stet/react';\n");
    expect(clientReadFiles(dir, withLayout)).toEqual(['src/main.tsx']);
  });

  it('answers the same with typescript absent: the walk is text, no compiler', async () => {
    write(dir, 'components/Nav.tsx', "'use client';\nimport { useCopy } from '@getstet/stet/react';\n");
    vi.resetModules();
    vi.doMock('typescript', () =>
      Promise.reject(Object.assign(new Error("Cannot find package 'typescript'"), { code: 'ERR_MODULE_NOT_FOUND' })),
    );
    try {
      const fresh = await import('../cli/footprint.js');
      expect(fresh.clientReadFiles(dir, config())).toEqual(['components/Nav.tsx']);
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});

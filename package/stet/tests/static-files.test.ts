import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentTypeOf, servableFile } from '../cli/static-files.js';

describe('servableFile — the containment the dashboard pane and the documents server share (D1)', () => {
  let parent: string;
  let root: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'stet-static-'));
    root = join(parent, 'site');
    mkdirSync(join(root, 'x', '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'a.html'), '<p>a</p>');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'x', '.git', 'config'), '[core]');
    writeFileSync(join(root, 'node_modules', 'a.js'), 'x');
    writeFileSync(join(parent, 'secret'), 'outside');
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true }));

  it('answers a file inside the checkout, each segment decoded once', () => {
    expect(servableFile(root, '/a.html')).toMatch(/a\.html$/);
    expect(servableFile(root, '/a%2Ehtml')).toMatch(/a\.html$/);
  });

  it('refuses the dot-leading family, node_modules, a climb and a malformed escape', () => {
    for (const path of ['/.env', '/%2Eenv', '/x/.git/config', '/node_modules/a.js', '/%2e%2e/secret', '/../secret', '/%E0%A4%A']) {
      expect(servableFile(root, path), path).toBeNull();
    }
  });

  it('refuses a symlink that points outside the root', () => {
    symlinkSync(join(parent, 'secret'), join(root, 'out.html'));
    expect(servableFile(root, '/out.html')).toBeNull();
  });
});

describe('contentTypeOf', () => {
  it('reads an own entry only, so a file named after a prototype member is bytes', () => {
    expect(contentTypeOf('x.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeOf('x.constructor')).toBe('application/octet-stream');
  });
});

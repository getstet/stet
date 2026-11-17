#!/usr/bin/env node
// The release build carries none of the development-only state handling:
// build with `next build`, then search everything it wrote for the names only
// that code uses. Any hit fails the check and is listed.
//
//   npm run check:release               # build, then search
//   npm run check:release -- --no-build # search the last build

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, '.next');
// `next dev` writes under .next/dev, and both share .next/cache; neither is
// release output. Source maps are skipped: a server chunk's map embeds the
// root layout's source text, which names the branch the build dropped.
const NOT_RELEASE = new Set([join(BUILD, 'dev'), join(BUILD, 'cache')]);
const isSourceMap = (path) => path.endsWith('.map');

// Names from dev/dev-root.tsx and dev/fixtures.ts: the state parameter, the
// three message types, the capture hook, the module itself, and fixture and
// seeded-account data.
const NAMES = [
  'stet-state',
  'stet:draft',
  'stet:draft-clear',
  'stet:tokens',
  '__stet',
  'DevRoot',
  'dev/dev-root',
  'signup-unavailable',
  'settings-leaving',
  'Maya Chen',
  'Featherstonehaugh',
];

if (!process.argv.includes('--no-build')) {
  execFileSync('npx', ['next', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (NOT_RELEASE.has(path) || isSourceMap(path)) continue;
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

let searched = 0;
const hits = [];
for (const path of files(BUILD)) {
  searched += 1;
  const text = readFileSync(path, 'latin1');
  for (const name of NAMES) if (text.includes(name)) hits.push(`${relative(ROOT, path)}: ${name}`);
}

if (hits.length > 0) {
  console.error(`release check: FAIL — development-only names in the release build:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log(`release check: pass — ${searched} files under .next, none carries any of ${NAMES.length} development-only names`);

// Exports a release build for iOS, Android and the web and fails if any name
// that belongs to the development-only state handling, capture helper or mock
// layer appears in it. Those sit behind `__DEV__`, which is false in a release
// bundle, so the minifier drops them.
//
//   node scripts/check-release.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.stet', 'release-check');

// One name per dev-only piece: the web state hook, the preview messages, the
// component sandbox and its forced-state, replay and motion messages, the state
// links, the capture channel and helper, the key-read recorder, the mock
// layer's fixtures and its seeded accounts.
const NAMES = [
  'stet-state',
  'stet:draft',
  'stet:tokens',
  'stet:state-force',
  'stet:play',
  'stet:motion',
  'stet:sandbox',
  '__stet/component',
  'Component not found',
  'stet/state',
  '/next?device=',
  'stetDevice',
  'recordReads',
  'focusedScreen',
  'applyMockState',
  'weather-loading',
  'weather-failed',
  'city-not-found',
  'session-expired',
  'many-alerts',
  'trial-ended',
  'long-name',
  'returning@example.com',
  'weather-demo',
];

rmSync(OUT, { recursive: true, force: true });
execFileSync('npx', ['expo', 'export', '--platform', 'all', '--no-bytecode', '--output-dir', OUT], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, NODE_ENV: 'production' },
});

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (/\.(js|hbc|html|json)$/.test(entry.name)) yield p;
  }
}

const hits = [];
let scanned = 0;
for (const file of files(OUT)) {
  const text = readFileSync(file, 'latin1');
  scanned += 1;
  for (const name of NAMES) {
    const count = text.split(name).length - 1;
    if (count) hits.push({ name, file: path.relative(ROOT, file), count });
  }
}

console.log(`scanned ${scanned} files in ${path.relative(ROOT, OUT)} for ${NAMES.length} dev-only names`);
if (hits.length) {
  for (const h of hits) console.log(`FOUND ${JSON.stringify(h.name)} ×${h.count} in ${h.file}`);
  console.log('release check failed: development-only code reached the release build');
  process.exit(1);
}
console.log('release check passed: 0 hits');

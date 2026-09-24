// The stet pre-commit gate's runner, copied into git's common directory by
// `stet hook install` and run by the hook. It reads the checkouts from
// stet-gate.json beside it and runs `stet check` and `stet scan` in each one
// of this worktree that the commit touches, with the stet installed in that
// checkout. It never runs npx and never reaches the registry. Node built-ins
// only: it runs outside any package.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\n$/, '');
const say = (line) => process.stderr.write(`stet pre-commit gate: ${line}\n`);

const top = git(['rev-parse', '--show-toplevel']);
const common = realpathSync(resolve(top, git(['rev-parse', '--git-common-dir'], top)));
const here = realpathSync(resolve(top, git(['rev-parse', '--git-dir'], top)));
// '' in the main worktree, 'worktrees/<name>' in a linked one.
const worktree = relative(common, here);

let entries;
try {
  entries = JSON.parse(readFileSync(join(common, 'stet-gate.json'), 'utf8')).entries;
  if (!Array.isArray(entries)) throw new Error('no entries');
} catch {
  say(`${join(common, 'stet-gate.json')} is missing or unreadable — run stet hook install in a stet checkout, or stet hook remove there`);
  process.exit(1);
}

/** The stet installed for `dir`: its own node_modules, else the nearest above it inside the worktree. */
function localStet(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const bin = join(at, 'node_modules', '.bin', 'stet');
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      /* keep walking */
    }
    if (at === top || dirname(at) === at) return null;
  }
}

/** One stet command in `dir`; a stet that is there but cannot start (a folder, a missing interpreter) is named. */
function run(stet, command, dir) {
  const result = spawnSync(stet, [command], { cwd: dir, stdio: 'inherit' });
  if (result.error !== undefined) {
    say(`${stet} could not run: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

let code = 0;
for (const entry of entries) {
  if (entry.worktree !== worktree || typeof entry.checkout !== 'string') continue;
  const label = entry.checkout === '' ? 'the repository root' : `${entry.checkout}/`;
  const spec = entry.checkout === '' ? [] : ['--', `:(literal)${entry.checkout}/`];
  // Asked, never listed: exit 0 is nothing staged there, and a commit staging
  // thousands of names under the checkout has no list to overflow a buffer.
  if (spawnSync('git', ['diff', '--cached', '--quiet', ...spec], { cwd: top, stdio: 'ignore' }).status === 0) continue;
  const dir = join(top, entry.checkout);
  if (!existsSync(join(dir, 'stet.config.json'))) {
    say(`${label} is no longer a stet checkout in this worktree — run stet hook install in the checkout, or stet hook remove there`);
    code = 1;
    continue;
  }
  const stet = localStet(dir);
  if (stet === null) {
    say(`stet is not installed in ${label} — run npm install there, or take it out of the gate with stet hook remove there`);
    code = 1;
    continue;
  }
  if (!run(stet, 'check', dir)) {
    code = 1;
    continue;
  }
  if (!run(stet, 'scan', dir)) code = 1;
}
process.exit(code);

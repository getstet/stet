// The stet pre-commit gate's runner, copied into git's common directory by
// `stet hook install` and run by the hook. It reads the checkouts from
// stet-gate.json beside it and runs `stet check` and `stet scan` — and `stet
// seo check` where the checkout's entry carries `seo` — in each listed folder
// that the commit touches, with the stet installed in that checkout. A listed
// folder is gated in every worktree where it is a stet checkout with stet
// installed, whichever worktree's install listed it.
// It never runs npx and never reaches the registry. Node built-ins only: it
// runs outside any package.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\n$/, '');
const say = (line) => process.stderr.write(`stet pre-commit gate: ${line}\n`);

const top = git(['rev-parse', '--show-toplevel']);
const common = realpathSync(resolve(top, git(['rev-parse', '--git-common-dir'], top)));
const here = realpathSync(resolve(top, git(['rev-parse', '--git-dir'], top)));
// '' in the main worktree, 'worktrees/<name>' in a linked one.
const worktree = relative(common, here);
// This worktree's identity: the id file install wrote in its git dir. An entry
// recording another id was written by an earlier worktree of the same name, and
// is that worktree's; git deletes the file with the worktree.
let hereId;
try {
  hereId = readFileSync(join(here, 'stet-gate-id'), 'utf8').trim();
} catch {
  /* install never ran in this worktree */
}

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

/**
 * Whether git tracks anything under `path`, which it asks about literally and
 * without regard to case (a case-insensitive disk lets the index spell it
 * differently); an answer it cannot give counts as yes.
 */
function tracksAnything(path) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', `:(literal,icase)${path}`], { cwd: top, encoding: 'utf8' });
  return listed.status !== 0 || listed.stdout !== '';
}

/**
 * Whether the stet at `bin` came with the branch rather than from an install:
 * git tracks something under its node_modules folder, or under the place that
 * folder links to inside this worktree (a tracked symlink, a tracked package
 * file behind an untracked .bin/stet, a tracked .bin/stet).
 */
function tracksStet(bin) {
  const modules = dirname(dirname(bin));
  if (tracksAnything(relative(top, modules))) return true;
  const real = relative(realpathSync(top), realpathSync(modules));
  return real !== '' && !/^\.\.([/\\]|$)/.test(real) && !isAbsolute(real) && tracksAnything(real);
}

/** One stet command in `dir`; a stet that is there but cannot start (a folder, a missing interpreter) is named. */
function run(stet, args, dir) {
  const result = spawnSync(stet, args, { cwd: dir, stdio: 'inherit' });
  if (result.error !== undefined) {
    say(`${stet} could not run: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

// One run per folder. A folder is gated in every worktree of the repository:
// this worktree's own entry gates it as install wrote it, and another
// worktree's entry — a merged branch's, or one whose worktree git has since
// removed — gates it wherever the folder is a stet checkout with stet
// installed, and passes silently where it is not.
const folders = new Map();
for (const entry of entries) {
  if (typeof entry?.worktree !== 'string' || typeof entry?.checkout !== 'string') continue;
  const folder = folders.get(entry.checkout) ?? { own: undefined, seo: false };
  if (entry.worktree === worktree && (typeof entry.id !== 'string' || entry.id === hereId)) folder.own = entry;
  else if (entry.seo === true) folder.seo = true;
  folders.set(entry.checkout, folder);
}

let code = 0;
for (const [checkout, { own, seo: elsewhereSeo }] of folders) {
  const label = checkout === '' ? 'the repository root' : `${checkout}/`;
  const spec = checkout === '' ? [] : ['--', `:(literal)${checkout}/`];
  // Asked, never listed: exit 0 is nothing staged there, and a commit staging
  // thousands of names under the checkout has no list to overflow a buffer.
  if (spawnSync('git', ['diff', '--cached', '--quiet', ...spec], { cwd: top, stdio: 'ignore' }).status === 0) continue;
  const dir = join(top, checkout);
  if (!existsSync(join(dir, 'stet.config.json'))) {
    if (own === undefined) continue;
    say(`${label} is no longer a stet checkout in this worktree — run stet hook install in the checkout, or stet hook remove there`);
    code = 1;
    continue;
  }
  const stet = localStet(dir);
  // Another worktree's entry never runs a stet the branch committed: only an
  // install the worktree made itself.
  if (own === undefined && stet !== null && tracksStet(stet)) continue;
  if (stet === null) {
    if (own === undefined) continue;
    say(`stet is not installed in ${label} — run npm install there, or take it out of the gate with stet hook remove there`);
    code = 1;
    continue;
  }
  if (!run(stet, ['check'], dir)) {
    code = 1;
    continue;
  }
  if (!run(stet, ['scan'], dir)) {
    code = 1;
    continue;
  }
  // Only a folder whose entry opted in: hook install and a passing upgrade set
  // `seo`; this worktree's own entry decides, else any other worktree's.
  const seo = own === undefined ? elsewhereSeo : own.seo === true;
  if (seo && !run(stet, ['seo', 'check'], dir)) code = 1;
}
process.exit(code);

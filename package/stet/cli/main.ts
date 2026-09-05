#!/usr/bin/env node
/**
 * The dispatch. `runCli` is the whole command surface, callable in process:
 * the offline suite drives every command with an injected store, captured
 * output and a temp-directory cwd, so nothing in the test path spawns a child
 * process — and a memory store keeps its rows across the several commands one
 * scenario needs.
 *
 * Everything below the shebang is a library. The bin entry at the bottom fires
 * only when Node was pointed at this file, so importing it costs nothing.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { StoreAdapter } from '../src/store.js';
import { runAgentsInstall } from './agents.js';
import { runAudit } from './audit.js';
import { runCheck } from './check.js';
import { runDoctor } from './doctor.js';
import { runEject } from './eject.js';
import { runEmailExtract } from './email-extract.js';
import { runEmailVerify } from './email-verify.js';
import { runHookInstall } from './hook.js';
import { runInit } from './init.js';
import { packageVersion } from './installed.js';
import { runPagesScan } from './pages.js';
import { runPull } from './pull.js';
import { runDiff, runGet, runList } from './read.js';
import { runRegister } from './register.js';
import { runRemove } from './remove.js';
import { CliError, UsageError } from './report.js';
import { runScan } from './scan.js';
import { runSeoCheck } from './seo.js';
import { runUpgrade } from './upgrade.js';
import { runDraft, runPublish, runSeed } from './write.js';

export interface CliIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Test injection; production resolves the adapter from the config. */
  store?: StoreAdapter;
  /**
   * Test injection, per environment, keyed by selector — what lets an offline
   * case drive `--env` at all. `store` is the shorthand for `{default: store}`
   * and every single-store consumer keeps using it.
   */
  stores?: Record<string, StoreAdapter>;
  /** `doctor --url`; tests inject a fake. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Interactive input, wired to `node:readline/promises` by the bin entry on a
   * TTY and left undefined everywhere else. `init` is the sole consumer:
   * undefined means non-interactive, so its two questions take their defaults
   * and the provider-mount edit is skipped unless `--yes` is passed.
   */
  ask?: (question: string, choices?: string[]) => Promise<string>;
  confirm?: (question: string) => Promise<boolean>;
}

/** 0 ok · 1 findings or failure · 2 usage. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  try {
    switch (command) {
      case undefined:
        io.stderr(usage());
        return 2;
      case 'help':
      case '--help':
      case '-h':
        io.stdout(usage());
        return 0;
      case '--version':
        // Answerable in any directory: nothing below reads a config, and the
        // version comes from the installation's own manifest.
        io.stdout(packageVersion());
        return 0;
      case 'init':
        return await runInit(rest, io);
      case 'scan':
        return await runScan(rest, io);
      case 'register':
        return await runRegister(rest, io);
      case 'remove':
        return await runRemove(rest, io);
      case 'eject':
        return await runEject(rest, io);
      case 'hook': {
        // Two-token, like `seo`: `install` is its only subcommand today, so a
        // bare or wrong `stet hook` teaches the form rather than guessing.
        const sub = rest[0];
        if (sub !== 'install') {
          throw new UsageError(
            sub === undefined ? 'stet hook install' : `stet hook has one subcommand, install — got "${sub}"`,
          );
        }
        return await runHookInstall(rest.slice(1), io);
      }
      case 'agents': {
        // Two-token, like `hook`: `install` is its only subcommand today, so a
        // bare or wrong `stet agents` teaches the form rather than guessing.
        const sub = rest[0];
        if (sub !== 'install') {
          throw new UsageError(
            sub === undefined ? 'stet agents install' : `stet agents has one subcommand, install — got "${sub}"`,
          );
        }
        return await runAgentsInstall(rest.slice(1), io);
      }
      case 'pages': {
        // Two-token, like `hook` and `agents`: `scan` is its only subcommand
        // today, so a bare or wrong `stet pages` teaches the form rather than
        // guessing at one.
        const sub = rest[0];
        if (sub !== 'scan') {
          throw new UsageError(
            sub === undefined ? 'stet pages scan' : `stet pages has one subcommand, scan — got "${sub}"`,
          );
        }
        return await runPagesScan(rest.slice(1), io);
      }
      case 'email': {
        // Two-token, like `hook` and `seo`. Both subcommands exist, so a bare
        // or misspelled `stet email` lists them rather than guessing at one.
        const sub = rest[0];
        if (sub === 'extract') return await runEmailExtract(rest.slice(1), io);
        if (sub === 'verify') return await runEmailVerify(rest.slice(1), io);
        throw new UsageError(
          sub === undefined
            ? 'stet email extract | stet email verify'
            : `stet email has two subcommands, extract and verify — got "${sub}"`,
        );
      }
      case 'import':
        // Named, not "unknown command": the fast-follow is real, so the error
        // teaches what is coming rather than implying a typo.
        throw new UsageError(
          'stet import is a named fast-follow, not yet available in this release — ' +
            'adopt existing copy with stet scan + stet register for now',
        );
      case 'check':
        return await runCheck(rest, io);
      case 'seo': {
        // Two-token, like `pages`. `check` is its only subcommand today, so a
        // bare `stet seo` teaches the form rather than guessing at one.
        const sub = rest[0];
        if (sub !== 'check') {
          throw new UsageError(
            sub === undefined ? 'stet seo check' : `stet seo has one subcommand, check — got "${sub}"`,
          );
        }
        return await runSeoCheck(rest.slice(1), io);
      }
      case 'list':
        return await runList(rest, io);
      case 'get':
        return await runGet(rest, io);
      case 'diff':
        return await runDiff(rest, io);
      case 'draft':
        return await runDraft(rest, io);
      case 'publish':
        return await runPublish(rest, io);
      case 'seed':
        return await runSeed(rest, io);
      case 'pull':
        return await runPull(rest, io);
      case 'audit':
        return await runAudit(rest, io);
      case 'doctor':
        return await runDoctor(rest, io);
      case 'upgrade':
        return await runUpgrade(rest, io);
      default:
        io.stderr(`unknown command: ${command}`);
        io.stderr(usage());
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`usage: ${error.message}`);
      return 2;
    }
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

export function usage(): string {
  return [
    'stet — typed, versioned content keys with a committed snapshot fallback',
    '',
    'Setup (write or edit files in the adopting project):',
    '  init [--app DIR] [--host html] [--yes]   scaffold a project; the shown edits mount the CopyProvider and write the agent guidance',
    '  scan                       report unkeyed copy in the managed surfaces — warn by default',
    '  register --from scan [--write] [--verbose]   add a key and rewrite the consuming leaf; --verbose lists every parse refusal',
    '  remove <key> [<key>...] [--write]   delete keys from descriptor + snapshot; plan first, --write applies',
    "  pages scan [--apply [names…]]   declare the host's static routes as pages; scaffold their SEO keys empty",
    '  eject --write [--verbose]  un-rewrite the host, write content back, remove the dependency; --verbose lists every parse refusal',
    '  hook install               the opt-in pre-commit gate (stet check + stet scan)',
    '  agents install             write the agent-routing guidance (AGENTS.md / CLAUDE.md)',
    '',
    'Email templates (the bulk adoption pair):',
    '  email extract [paths…] [--apply [names…]]   declare templates: entry, slots, render pointer, shell',
    '  email verify [--capture] [--recapture]   render each declared template before and after, and compare the bytes',
    '',
    'Reading (work in every mode):',
    '  check                      descriptor, snapshot and generated files — offline, no store',
    '  seo check                  the offline SEO rules over descriptor + snapshot',
    '  list [--locale L]          every key: resolution source, active version, draft pending',
    '  get <key> [--locale L]     the resolved value',
    '  diff <key> [--locale L]    the active value against the pending draft',
    '',
    'Writing (through the store RPCs; snapshot-only projects publish by committing):',
    '  draft <key> --value=V | --value-file F   [--locale L] [--label T] [--note N]',
    '                                           [--publish-at ISO] [--force] [--editor E]',
    '  publish <key> [--locale L] [--editor E]  make the draft live',
    '  publish --due [--editor E]               publish every draft whose stamp has passed',
    '  seed                                     the snapshot as version 1, once per key',
    '',
    'Project:',
    '  pull                       resolve into the repo forms: snapshot, defaults module, bundle',
    '  audit [--strict]           descriptor against the store — reports, never deletes',
    '  doctor [--report] [--url U --key K]      mode, health, and what is serving production',
    '  upgrade [--store A] [--dry-run] [--verify]   migrations, the registry, the version stamp',
    '',
    'Options: --json on check, seo check, pages scan, list, get, audit, doctor and both email commands.',
    '  --env <name>             the environments-map connection to run against; check and seo check take none',
    '',
    'Global flags:',
    '  --help, -h               this usage',
    '  --version                the installed stet version',
    '',
    'A value that begins with a dash needs the joined form — `--value=-5` rather',
    'than `--value -5` — or `--value-file`, because an argument parser cannot tell',
    'a dash-leading value from the next option. Long values belong in a file anyway.',
  ].join('\n');
}

// The bin entry. Guarded, because this module is also what the test suite
// imports: without the guard every import would run a command with the test
// runner's own argv.
//
// The path is REALPATH'd first. npm installs a bin as a symlink
// (`node_modules/.bin/stet` → the compiled file), and Node reports the symlink
// in `process.argv[1]` while `import.meta.url` is already resolved — so a bare
// comparison is false for every install that is not a direct `node dist/…`
// invocation, and the command would print nothing and exit 0.
if (import.meta.url === entryUrl()) {
  const io: CliIo = {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
  // Interactive input only on a real TTY — `init` is the sole consumer. A pipe
  // or CI leaves ask/confirm undefined, so init defaults its two questions and
  // skips the provider-mount edit unless `--yes`. `readline/promises` is loaded
  // only here, so a library import of this module never pulls it in.
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    io.ask = async (question, choices) => {
      const hint = choices !== undefined && choices.length > 0 ? ` [${choices.join('/')}]` : '';
      const answer = (await rl.question(`${question}${hint} `)).trim();
      return answer === '' && choices?.[0] !== undefined ? choices[0] : answer;
    };
    io.confirm = async (question) => {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    };
    const code = await runCli(process.argv.slice(2), io);
    rl.close();
    process.exit(code);
  }
  process.exit(await runCli(process.argv.slice(2), io));
}

/** The resolved URL of the file Node was pointed at, or null when there is none. */
function entryUrl(): string | null {
  const entry = process.argv[1];
  if (entry === undefined) return null;
  try {
    return pathToFileURL(realpathSync(entry)).href;
  } catch {
    // argv[1] names something unreadable: not this file, so not the bin entry.
    return null;
  }
}

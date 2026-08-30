#!/usr/bin/env node
/**
 * The render runner — `stet email verify`'s one execution of host code, shipped
 * as a static asset (like `templates/pre-commit`) and located through
 * `packageRoot()`. It runs in a CHILD process, one render per invocation, so a
 * template that crashes fails itself and the walk continues.
 *
 * Everything it renders with is the HOST's: `typescript` transpiles `.ts`/`.tsx`
 * on require, so every import resolves from the host's own `node_modules`, and a
 * React element result renders through the host's `react-dom/server`. stet adds
 * no dependency of its own and forks no resolver.
 *
 * Usage: node email-runner.cjs <hostDir> <file> <exportName> <propsJson>
 * Stdout is the JSON-serialized render and nothing else; diagnostics go to
 * stderr, and the exit code names the failure — `cli/email-render.ts` maps the
 * table one-to-one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { createRequire } = require('module');

/**
 * The exit table. `cli/email-render.ts` reads it as its failure taxonomy, and
 * maps anything outside it — including the 1 a malformed argv answers with,
 * which the seam never produces — to `render-threw` with this process's stderr.
 */
const OK = 0;
const EXPORT_NOT_FUNCTION = 2;
const TS7_UNSUPPORTED = 3;
const MISSING_DEPENDENCY = 4;
const RENDER_THREW = 5;
const NOT_RENDERABLE = 6;

/**
 * The same refusal `loadTypescript` gives (`cli/source-scan.ts`'s `TS7_REFUSAL`,
 * which a shipped asset cannot import — a test asserts the two agree).
 * TypeScript 7's package root exports version constants only — no
 * `transpileModule`, no `createSourceFile` — so a host on 7.x is refused by name
 * rather than crashing on a missing function.
 */
const TS7_MESSAGE =
  "stet's source tools use the TypeScript 5 compiler API — typescript 7 is not yet supported; install typescript@5 as a devDependency";

/**
 * What a specifier that is neither relative nor a package name gets appended to
 * its resolution failure: the runner maps ONE alias form, and the remedy names
 * both ways out rather than leaving an adopter to guess at stet's resolver.
 */
/** The install line `loadTypescript` gives, verbatim — one answer, two places. */
const TYPESCRIPT_INSTALL =
  "stet needs 'typescript' to read your source — install it as a dev dependency: npm i -D typescript";

/**
 * The prefix a line on stderr carries when the render SUCCEEDED and there is
 * still something the caller should say. `cli/email-render.ts` picks these out;
 * everything else on stderr belongs to the host's own template, which writes
 * there for the duration of the render.
 */
const NOTE = 'stet-note: ';

const ALIAS_REMEDY =
  'stet renders through Node\'s own resolver plus one alias form: a single-wildcard "paths" entry declared in the app root\'s own tsconfig.json ("@/*": ["./src/*"]). Rewrite this import as a relative path, or declare the template without a render pointer.';

const [hostDirArg, fileArg, exportName, propsJson] = process.argv.slice(2);
if (hostDirArg === undefined || fileArg === undefined || exportName === undefined || propsJson === undefined) {
  process.stderr.write('usage: email-runner.cjs <hostDir> <file> <exportName> <propsJson>');
  process.exitCode = 1;
} else {
  // Both paths absolute before anything uses them: a relative hostDir makes
  // `createRequire` throw ERR_INVALID_ARG_VALUE rather than resolve the host.
  const hostDir = path.resolve(hostDirArg);
  const file = path.resolve(fileArg);
  const outcome = run(hostDir, file, exportName, propsJson);
  // One writer, and no `process.exit` anywhere: stdout is a pipe here, so an
  // immediate exit would truncate the render mid-write.
  if (outcome.out !== undefined) process.stdout.write(outcome.out);
  if (outcome.err !== undefined) process.stderr.write(outcome.err);
  process.exitCode = outcome.code;
}

/** The whole render, with every failure mapped to its exit rather than thrown. */
function run(hostDir, file, exportName, propsJson) {
  try {
    const hostRequire = createRequire(path.join(hostDir, 'package.json'));
    const ts = hostRequire('typescript');
    // Refused BEFORE any require hook is installed — a half-hooked process that
    // then fails to compile would report the wrong reason.
    if (typeof ts.transpileModule !== 'function') return { code: TS7_UNSUPPORTED, err: TS7_MESSAGE };

    installAliasResolver(aliasMappings(ts, hostDir));
    installTranspileHooks(ts);

    // Host code writes to stderr for the duration, so "nothing but the render on
    // stdout" holds by construction: a template with a `console.log` in it would
    // otherwise interleave its own line into the JSON the seam parses.
    const mod = offStdout(() => require(file));
    // `Object.hasOwn`, not a bare index: `exportName` comes from the descriptor,
    // and a bare `mod['constructor']` would resolve Object.prototype's — a
    // function, which the check below would then CALL.
    let fn = Object.hasOwn(mod, exportName) ? mod[exportName] : undefined;
    let note;
    // A hand-written pointer may name the SOURCE name of a default-exported
    // template (`export default function Digest`), which this transpile puts on
    // `exports.default` and nowhere else. Where the named export is simply
    // absent and the default is a function, that is the template — and where the
    // named export exists, it wins, so this can never redirect a real export.
    //
    // It says so when it fires: the other reason a pointer names an export the
    // module does not have is a typo, and a render that quietly succeeds is
    // exactly what would hide one.
    if (fn === undefined && Object.hasOwn(mod, 'default') && typeof mod.default === 'function') {
      fn = mod.default;
      note = `${NOTE}export ${JSON.stringify(exportName)} is not on the module; rendered its default export\n`;
    }
    if (typeof fn !== 'function') {
      return { code: EXPORT_NOT_FUNCTION, err: `${file}: export ${JSON.stringify(exportName)} is not a function` };
    }

    const result = offStdout(() => fn(JSON.parse(propsJson)));
    if (typeof result === 'string') return { code: OK, out: JSON.stringify(result), err: note };
    if (isElement(result)) {
      const { renderToStaticMarkup } = hostRequire('react-dom/server');
      return { code: OK, out: JSON.stringify(offStdout(() => renderToStaticMarkup(result))), err: note };
    }
    if (isStringMap(result)) return { code: OK, out: JSON.stringify(result), err: note };
    return {
      code: NOT_RENDERABLE,
      err:
        `${file}: the ${exportName} export returned ${describe(result)} — a template returns a string, ` +
        'an object whose values are all strings, or a React element',
    };
  } catch (error) {
    return classify(error);
  }
}

/** A thrown failure as an exit plus the stderr the seam surfaces. */
function classify(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  if (code === 'MODULE_NOT_FOUND') {
    const message = messageOf(error);
    const found = /Cannot find module '([^']*)'/.exec(message);
    const spec = found === null ? undefined : found[1];
    // `typescript` is the one missing module with an install line rather than a
    // remedy — the same line `loadTypescript` gives, so a host missing the
    // compiler hears one answer from every stet command that parses source.
    if (spec === 'typescript') return { code: MISSING_DEPENDENCY, err: `${message}\n${TYPESCRIPT_INSTALL}` };
    const aliased = spec !== undefined && !isRelative(spec) && !isBarePackage(spec);
    return { code: MISSING_DEPENDENCY, err: aliased ? `${message}\n${ALIAS_REMEDY}` : message };
  }
  const stack = error !== null && typeof error === 'object' ? error.stack : undefined;
  return { code: RENDER_THREW, err: typeof stack === 'string' ? stack : messageOf(error) };
}

/**
 * `fn()` with the process's stdout routed to stderr. The runner's whole contract
 * with the seam is that stdout carries the render and nothing else; a host
 * template is free to log, and this is what keeps both true at once.
 */
function offStdout(fn) {
  const original = process.stdout.write;
  process.stdout.write = function (...args) {
    return process.stderr.write(...args);
  };
  try {
    return fn();
  } finally {
    process.stdout.write = original;
  }
}

function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * `require.extensions` hooks that transpile per file. No type checking and no
 * cross-file transforms — the host's own `tsc` owns type truth; this exists so
 * the template's own module graph loads.
 */
function installTranspileHooks(ts) {
  for (const ext of ['.ts', '.tsx']) {
    require.extensions[ext] = (m, filename) => {
      const source = fs.readFileSync(filename, 'utf8');
      const out = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
        fileName: filename,
      });
      m._compile(out.outputText, filename);
    };
  }
}

/**
 * The ONE alias form the runner maps: a single-wildcard, single-candidate
 * `paths` entry in the app root's OWN tsconfig.json (`"@/*": ["./src/*"]`, the
 * create-next-app default). `readConfigFile` is comment-safe and reads the local
 * file alone — an `extends` chain is never followed, so what this maps is what
 * the file itself says. Everything richer stays unmapped and fails resolution
 * with the remedy named, rather than resolving under a resolver stet would own.
 */
function aliasMappings(ts, hostDir) {
  const configPath = path.join(hostDir, 'tsconfig.json');
  if (!fs.existsSync(configPath)) return [];
  const read = ts.readConfigFile(configPath, (p) => fs.readFileSync(p, 'utf8'));
  if (read.error !== undefined) return [];
  // Own-property reads at every step. `readConfigFile` builds its result by
  // assignment, so a tsconfig carrying a `"__proto__"` member replaces the
  // object's PROTOTYPE instead of adding a key — and a bare `.compilerOptions`
  // would then read the attacker's, mapping `@/*` at a directory the file never
  // named. Executed against exactly that fixture.
  const options = ownRecord(read.config, 'compilerOptions');
  const paths = ownRecord(options, 'paths');
  if (paths === null) return [];

  const baseUrl = options !== null && Object.hasOwn(options, 'baseUrl') ? options.baseUrl : undefined;
  const base = typeof baseUrl === 'string' ? path.resolve(hostDir, baseUrl) : hostDir;
  const mappings = [];
  for (const pattern of Object.keys(paths)) {
    const candidates = paths[pattern];
    if (!Array.isArray(candidates) || candidates.length !== 1) continue; // multiple fallbacks: unmapped
    const target = candidates[0];
    if (typeof target !== 'string') continue;
    if (!endsInLoneWildcard(pattern) || !endsInLoneWildcard(target)) continue; // non-wildcard entries: unmapped
    mappings.push({ prefix: pattern.slice(0, -1), target: target.slice(0, -1), base });
  }
  return mappings;
}

/** `"@/*"` — a trailing `*` and no other one. */
function endsInLoneWildcard(pattern) {
  return pattern.endsWith('*') && pattern.indexOf('*') === pattern.length - 1;
}

/** One own object member of a parsed-JSON value, or `null` — never the prototype's. */
function ownRecord(value, field) {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, field)) return null;
  const member = value[field];
  return member !== null && typeof member === 'object' && !Array.isArray(member) ? member : null;
}

/**
 * The mappings applied at resolution: swap the prefix, resolve against
 * `baseUrl` (else the tsconfig's own directory), and delegate to Node's
 * resolver — which then tries `.ts`/`.tsx` too, those extensions now being
 * registered. A mapped candidate that does not resolve falls through to the
 * original request, so the failure names the specifier the source actually
 * wrote.
 */
function installAliasResolver(mappings) {
  if (mappings.length === 0) return;
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string') {
      for (const mapping of mappings) {
        if (!request.startsWith(mapping.prefix)) continue;
        const mapped = path.resolve(mapping.base, `${mapping.target}${request.slice(mapping.prefix.length)}`);
        try {
          return original.call(this, mapped, ...rest);
        } catch {
          // Not there under the mapping — let the original request answer.
        }
      }
    }
    return original.call(this, request, ...rest);
  };
}

function isRelative(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec);
}

/**
 * A bare package name — `react`, `node:fs`, `@scope/name`. A scope with no name
 * (`@/lib/content`) is not one, which is exactly the alias shape the remedy is
 * written for.
 */
function isBarePackage(spec) {
  return spec.startsWith('@') ? /^@[^/\s]+\/[^/\s]/.test(spec) : /^[A-Za-z0-9_]/.test(spec);
}

/** A React element — the only result shape that needs the host's renderer. */
function isElement(value) {
  return value !== null && typeof value === 'object' && value.$$typeof !== undefined;
}

/** Mirra's `{ subject, html }` shape: a plain object whose every value is a string. */
function isStringMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((v) => typeof v === 'string');
}

/** What the result WAS, for the not-renderable message. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value === undefined) return 'undefined';
  const kind = typeof value;
  return `${'aeiou'.includes(kind.charAt(0)) ? 'an' : 'a'} ${kind}`;
}

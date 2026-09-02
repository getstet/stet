# stet — package conventions

The npm package is `@getstet/stet`, and its bin is `stet` (one published
package; `@getstet/stet/core`, `@getstet/stet/react` and `@getstet/stet/server`
are subpath exports, never separate packages). This file is the conventions
layer; the change files under `openspec/` are the specification.

## Naming

- Files kebab-case, types PascalCase, functions camelCase.
- **No `utils.ts` may exist**, in any directory, under any spelling
  (`helpers.ts`, `misc.ts`, `common.ts`). A helper lives in the module whose job
  it belongs to, and the module is named after that job.

## Module map

One line per `src/` file — where things live. It never lists which helpers
exist: the three barrels enumerate the shipped surface of their layers —
`src/index.ts` the root, `react/index.ts` the React layer, `server/index.ts` the
server layer — and every remaining door is an alias or a single module:
`./core` (the root's alias), `./react/server`, the four adapter subpaths
(`store-memory`, `store-snapshot`, `store-pg`, `store-postgrest`) and `./schema`.
Nothing else lists what the package exports.

| File | Holds |
|---|---|
| `src/index.ts` | the root surface — the read path and the host-side checks; the generator half is reached by the CLI by module path, and the preview token pair ships on `@getstet/stet/server` |
| `src/types.ts` | hand-declared contract types: `Descriptor`, `KeyDef`, `PageDef`, `TemplateDef`, the registry augmentation point |
| `src/descriptor.ts` | loading and validating a descriptor against the published schema, plus its structural rules |
| `src/codegen.ts` | descriptor → generated artifacts (the key registry with both its unions — every key, and the string-valued keys a `Record<StringKey, string>` map is typed over — plus the ambient types and the defaults module), the source hash they carry, and the generated-file currency check over it |
| `src/snapshot.ts` | the committed snapshot: loading, the descriptor-vs-snapshot currency check, and the smells |
| `src/resolve.ts` | key → value: the resolution order, the locale chain, quarantine of malformed stored values |
| `src/bundle.ts` | the read bundle's format and its read semantics (both forms), and `resolveAll` — every declared key resolved once into the map an accessor takes |
| `src/access.ts` | the framework-free ambient-access contract |
| `src/validate.ts` | save-time checks: shapes, limits, variables, class rules, fit budgets |
| `src/seo.ts` | the offline SEO audit: the eight rules, the one severity table, the two word lists |
| `src/targets/adapter.ts` | the target seam: the adapter contract, and the one registry a consumer looks up by a key's declared target |
| `src/targets/html-email.ts` | the html-email target — the same HTML escaping, the line metrics derived from the email-safe content width, and the element list behind the markup-in-content construct rule |
| `src/targets/web.ts` | the web target — HTML-entity escaping, the line metrics a budget estimate reads, and the decision that web has no illegal constructs |
| `src/store.ts` | the normative store interface, and the answers an adapter may return |
| `src/preview.ts` | the preview seam: the states a preview can name, the per-identity override resolver, and a change's page-span |
| `src/preview-token.ts` | the signed token that names one preview state — mint and verify, the one HMAC in `src/` |

`migrations/` holds the numbered SQL, copied as-is into an adopting project.
`templates/` holds the four assets stet ships and either writes into a host or
runs against one: `starter-descriptor.json` and `starter-defaults.json` (what
`init` scaffolds), `pre-commit` (the hook `hook install` writes), and
`email-runner.cjs` (the child that loads a host template through the host's own
compiler). Every one is resolved through `packageRoot()`, never by a path
relative to the caller.
`conformance/` holds the fixture project, the walk over every spec requirement,
the store suite every adapter passes and the temp-directory host CLI cases run
in; `tests/` holds the unit suite, the offline guard and the non-JS
consumability proof. `python/` holds `stet_read.py`, the non-JS read helper
over the bundle contract — standard library only, shipped in the npm files, and
the one implementation of bundle reading on that side of the fence.

`adapters/` is the transport layer; `cli/` is the terminal I/O layer. One file
per adapter, named for the store it talks to; an adapter adds transport and
nothing else, because the mapping and parsing every adapter needs is
implemented once in `store-shared.ts`:

| File | Holds |
|---|---|
| `adapters/store-memory.ts` | the in-process reference every other adapter is measured against |
| `adapters/store-snapshot.ts` | the read half of a project with no database |
| `adapters/store-pg.ts` | the reference database store, over plain `pg` |
| `adapters/store-postgrest.ts` | the HTTP store, over PostgREST |
| `adapters/store-shared.ts` | the cross-adapter contracts: the row mapping, the changeset row mapping, keyset paging, the conflict vocabulary every raise is built from, the error-code table, PostgREST filter quoting, the refusal parse, telling the four answers apart, and the `stet_meta` shape both SQL adapters read |
| `adapters/changesets.ts` | the one group-revert enumeration, over the public store interface — every surface calls this rather than reimplementing the walk |

`cli/` composes `src/` and `adapters/` and adds only I/O, dispatch and
reporting. Nothing imports from it except its own modules, its tests and the
bin; `src/` stays zero-I/O and its purity roster lists `src/` alone.

| File | Holds |
|---|---|
| `cli/main.ts` | the dispatch, the `CliIo` contract, the usage text, and the bin entry |
| `cli/args.ts` | one command's arguments, over `node:util`'s `parseArgs` |
| `cli/config.ts` | `stet.config.json` — every setting, every default, the adapter table, the environments map, the one selection function every store block is read through, the adoption fields (`router`, `readPath`, `rootLayout`, `apiTokenEnv`, `mountRoute`, `managedSurfaces`/`emailSurfaces`/`copyModules`, `scan`), the host's own path-alias reader and the specifier resolver over it — tsc's rules, which `init` probes, `register --write` guards on and `eject` resolves consumers through — and the path an adopting project keeps its migration copies at |
| `cli/store.ts` | config → adapter, over the four factories; the connection-variable check. Takes the environment selector, and answers store-backed from a resolved block |
| `cli/project.ts` | config + descriptor + snapshot + adapter, loaded once against the selected environment, and the render-vs-compare read rule |
| `cli/report.ts` | what a command prints and what it exits with — the one home for both; the finding kinds include `scan`; and the phrasing helpers a message is built from — `clip` (a one-line preview of quoted text), `shapeOf` (a value's type with its article) and `collapseLines` (a per-file block reduced to one count line past the point where it stops being a list, the caller printing on its own channel) |
| `cli/validate.ts` | one value against its key's rules: the shape check, then the save checks with the template's slots in scope |
| `cli/artifacts.ts` | writing an emitted artifact: the deterministic JSON serializer, the plan-then-apply writers (`planWrite`/`planJson`/`writePlanned`, all-or-nothing), and `writeExecutable` (the hook's `0o755`) |
| `cli/installed.ts` | the files that ship inside stet — the migrations and the manifest |
| `cli/meta.ts` | the bridge from a command holding an adapter to the connection-shaped `stet_meta` helpers; the trio follows the environment selection, so a stamp lands in the database the command was pointed at |
| `cli/check.ts` | `check` — descriptor, snapshot and generated files, offline; each generated-file finding carries the regenerator that rewrites THAT file |
| `cli/seo.ts` | `seo check` — the SEO rules over descriptor and snapshot, offline; and the two structured warns outside the severity table, for a store-backed project and for an adopted host that declares no pages |
| `cli/read.ts` | `list`, `get`, `diff` |
| `cli/write.ts` | `draft`, `publish` (including `--due`), `seed` |
| `cli/pull.ts` | `pull` — the store's truth into the repo forms |
| `cli/audit.ts` | `audit` — the descriptor against the store's rows |
| `cli/doctor.ts` | `doctor` — mode, health, what production is serving, and the wrapper-chain check over each pointered template's relative-import closure |
| `cli/upgrade.ts` | `upgrade` — migrations, the registry, the version stamp |
| `cli/init.ts` | `init` — detect framework/router/store/react, scaffold the new files (the read path branching on whether the host declares react), the one shown edit to existing code (the root-layout `CopyProvider` mount, itself gated on the host declaring react), and the agent-guidance write |
| `cli/pages.ts` | `pages scan` — the host's file-based routing convention read as page records: the arm detector (Astro, Next App, Next Pages) over directory entries and file names, the per-arm route walkers, the skip taxonomy every undeterminable route lands in, and the propose/`--apply` pair that writes records, their scaffolded SEO keys and the codegen in one batch; plus the two helpers it owns for everyone — `walk`, the dirent walk `scan` reaches through `filesForGlobs`, and `normalize`, the descriptor-name grammar `email extract` names templates with |
| `cli/scan.ts` | `scan` — the drift gate over the managed surfaces AND the declared copy modules, per-glob so a dead glob is named; the dialect branch ahead of every compiler-needing call; `classifyAdoption`, the one adopted/diverged/unadopted verdict `register` shares; the position-free baseline; the uncovered-route warn over `pages`' own detector; and `filesForGlobs`, the surface walker `register`/`eject` reuse, which walks through `pages`' dirent walker |
| `cli/register.ts` | `register --from scan` — add a key, seed its default, and produce the leaf-only rewrite; the second loop that adopts a copy module as RECORD, under the property's own name and with no source edit; the `--write` guard over the read-path specifier's own resolvability; regenerate the codegen when keys are added |
| `cli/remove.ts` | `remove` — the `--write`-gated, plan-then-apply key delete: the plan (entry, every locale's value, the files still mentioning the key, the store posture) and the one all-or-nothing batch over the five repo forms — descriptor, snapshot in EVERY locale, and the three regenerated codegen files; the descriptor validator re-run over the post-removal copy as the one reference gate, plus the backstop for the prototype name its own membership tests cannot see; the store untouched by construction, so a removed key's rows become the orphans `audit` already reports |
| `cli/eject.ts` | `eject` — the `--write`-gated, plan-then-apply reversal: un-rewrite the leaves (loaded only where the import probe finds host files to reverse), unwrap the mount, write content back, the whole-host backstop and who imports each planned deletion, the closing line naming what stays, and the dependency, hook and agent-guidance removal; `stetImportRegex`, the one import-position pattern the backstop and that probe share |
| `cli/hook.ts` | `hook install` — the opt-in pre-commit gate; and `hooksDir`, the git-resolved hooks directory `eject` reuses |
| `cli/agents.ts` | the host's agent-guidance block — the builder, the `AGENTS.md`/`CLAUDE.md` targeting, the three-state plan (`planGuidance`), the eject removal (`removeGuidance`), `agents install`, and `fileIdentity`, the `dev:ino` compare `eject` reuses to tell one file from two names |
| `cli/source-scan.ts` | the shared TSX locator (`scanSource`) `scan`/`register`/`eject` all call — which also yields its parse and the spans it CLASSIFIED, so a file both declarations match is read once and every literal is owned by exactly one walk — plus the two detectors beside it: `scanModule` (a declared copy module's literals, the property names proposing themselves as keys) and `scanDialect` (template-dialect prose, pure text, no compiler on its path, dropping the one shape it reads as code rather than copy — a brace-opening run carrying no quote); the one qualifying bar both detectors share, which strips tags with the module's own `TAG` and nothing else; the one dialect-extension predicate (`isDialectFile`/`dialectOf`) `eject` shares; the managed-surface glob matcher (`matchGlob`); `isJsxFile`; the whole-word token matcher (`mentionsToken`) the compiler-less paths grep with, the two parsed predicates built over it — `rendersToken` (does this file READ the slot) and `carriesToken` (does it carry this wrapper token in code, comments excluded) — and the lazy `loadTypescript` |
| `cli/email-render.ts` | the render seam — one host template executed per child process, the failure taxonomy the exit table maps to, and the ceilings (output size, wall clock) |
| `cli/email-extract.ts` | `email extract` — the proposer and its `--apply` batch: the declaration a template's source yields, the skip taxonomy every ambiguity routes to, the shell rewrite, and the surface persistence |
| `cli/email-verify.ts` | `email verify` — the custody proof: HEAD's render against the working tree's, byte for byte, and the captured baseline where git has no before |
| `cli/rewrite.ts` | the source-safe leaf rewrite engine: `planRewrite` (adopt — JSX shapes only, refused at its entry ahead of the staleness check), `applyFileEdits` (the non-overlapping batch), `unRewriteFile` (eject's inverse), `formatDiff`, and `dominantEol` — the line ending an edit into a host file takes |

`react/` is the React read layer, shipped as `@getstet/stet/react`; `server/` is
the HTTP API surface, shipped as `@getstet/stet/server`. Both are sanctioned
impure layers beside `adapters/` — excluded from the `src/` purity roster — and
both are thin over
`src/` and the `adapters/changesets.js` enumeration (`react/` over
`src/access.ts`, `server/` over the store RPCs).

| File | Holds |
|---|---|
| `react/provider.tsx` | `CopyProvider` (holds the resolved map + descriptor) and `useCopy()` — the client accessor from context, memoized, with a clear error outside a provider |
| `react/server.ts` | `createServerCopy` — the server-component accessor, a thin wrapper over `createAccessor`, importing no `react` |
| `react/index.ts` | the `@getstet/stet/react` surface: `CopyProvider`, `useCopy`, `createServerCopy` |
| `server/mount.ts` | `createStetHandler` — the Bearer-authenticated catch-all `{ GET, POST }`: constant-time auth, the RPC-delegating POST routes, the render proxy and Bearer reads, and the fire-and-forget publish hooks |
| `server/index.ts` | the `@getstet/stet/server` surface: `createStetHandler`, its event types, and the preview token pair |

## Rules

1. **Zero I/O in `src/`.** Every function takes parsed data and returns data —
   no `fs`, no `fetch`, no `process.env`, no store access. `node:crypto` is
   permitted in exactly two modules — `codegen.ts` (the source hash) and
   `preview-token.ts` (the token signature) — and neither is reachable from the
   root or React entries; the offline guard and the conformance walk assert both
   halves. I/O belongs to adapters, the CLI and tests. This is what makes the
   offline guarantee structural rather than disciplined.
2. **Determinism.** No `Date.now()`, no `Math.random()`, no locale-sensitive
   comparison in `src/`. Same inputs produce byte-identical generated output, so
   a CI diff is trustworthy.
3. **Grep before writing a helper.** A duplicate under a new name is the failure
   mode this package is most exposed to.
4. **Rule of two.** A helper is born local to the module that needs it. A second
   consumer promotes it — an explicit move, in one commit, that updates the
   first consumer. Nothing is written "for later reuse".
5. **The conformance walk carries the proof.** Every spec requirement has one
   named test in `conformance/`. A seam's proof lands with the seam, never in a
   later batch.

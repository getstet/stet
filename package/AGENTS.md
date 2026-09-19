# stet — package conventions

The npm package is `@getstet/stet`, and its bin is `stet` (one published
package; `@getstet/stet/core`, `@getstet/stet/react` and `@getstet/stet/server`
are subpath exports, never separate packages). This file is the conventions
layer; the specification is the openspec change files in the planning repository
(`nj-io/stet-planning`), where every change is authored before it is built here —
a public commit names the change it implements.

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
| `src/seo.ts` | the offline SEO audit: the nine rules, the one severity table, the two word lists |
| `src/targets/adapter.ts` | the target seam: the adapter contract, and the one registry a consumer looks up by a key's declared target |
| `src/targets/html-email.ts` | the html-email target — the same HTML escaping, the line metrics derived from the email-safe content width, and the element list behind the markup-in-content construct rule |
| `src/targets/web.ts` | the web target — HTML-entity escaping, the line metrics a budget estimate reads, and the decision that web has no illegal constructs |
| `src/store.ts` | the normative store interface, and the answers an adapter may return |
| `src/preview.ts` | the preview seam: the states a preview can name, the per-identity override resolver, and a change's page-span |
| `src/preview-token.ts` | the signed token that names one preview state — mint and verify, the one HMAC in `src/` |

`migrations/` holds the numbered SQL, copied as-is into an adopting project.
`templates/` holds the four assets stet ships and either writes into a host or
runs against one: `starter-descriptor.json` and `starter-defaults.json` (what
`init` scaffolds on a JavaScript host; the static-HTML host is scaffolded empty,
since its page already carries its copy), `pre-commit` (the hook `hook install`
writes), and
`email-runner.cjs` (the child that loads a host template through the host's own
compiler). Every one is resolved through `packageRoot()`, never by a path
relative to the caller.

`dashboard/index.html` is the page `stet dev` serves, located the same way: one file, one nonced style block and one nonced script, no build step and no external reference, with every control carrying `data-act` so the policy it is served under admits it.
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
| `cli/dev.ts` | `stet dev` — the loopback listener, the adapter between Node's request/response pair and the handler's `Request → Response` shape (the unparseable target and the body cap, the two guards a `Request` cannot carry), `--port`/`--no-open`/`--add`, the per-run token, and the browser it opens |
| `cli/dev-routes.ts` | everything the dashboard decides: the Host, Bearer and Origin guards, the page response with its policy and nonce, the route table, the per-site queue, the mounted API and the static-file arm, the dev child's lifecycle, and `captured` — a command run through `runCli` in this process with collecting sinks |
| `cli/workspace.ts` | `~/.stet/projects.json` — the entries, the read and the whole-file write, `loadSite` (the `not-adopted`/`broken`/`ready` verdict every route branches on), `siteId`, the checkout's own `.env` files, `baseEnv`/`childEnv` (the run token taken back out of every child), `siteIo`, and `devDefaults` — the dev URL and command a host implies |
| `cli/git.ts` | git as an argument array — `git(cwd, args)` over `spawnSync` with the run token stripped and no terminal prompt, and `gitState`, the head/branch/dirty triple every reply stamps itself with |
| `cli/files.ts` | which files a declaration names — the dirent walk (`walk`, `WALK_SKIP`) and the glob match over it (`filesForGlobs`, `staticPrefix`); no file content is read here, and `pages`/`scan` re-export what they used to own |
| `cli/html-host.ts` | the static-HTML host: the tokenizer over the detector's blanked text, the key-element rule and the placeholder builder, the proposal set scan and register read, the regenerator pull and the batch write through, the currency check, the mark edits and the strip |
| `cli/args.ts` | one command's arguments, over `node:util`'s `parseArgs` |
| `cli/config.ts` | `stet.config.json` — every setting, every default, the adapter table, the environments map, the one selection function every store block is read through, the host kind (`host` — absent for a JavaScript host, `"html"` for the static-HTML one) and `isHtmlHost`, the ONE predicate every seam branches on, the adoption fields (`router` — `app` \| `pages` \| `astro` — `readPath`, `rootLayout` (absent on an Astro host, which has no root React layout), `apiTokenEnv`, `mountRoute`, `managedSurfaces`/`emailSurfaces`/`copyModules`, `scan`), the host's own path-alias reader and the specifier resolver over it — tsc's rules, which `init` probes, `register --write` guards on and `eject` resolves consumers through — and the path an adopting project keeps its migration copies at |
| `cli/store.ts` | config → adapter, over the four factories; the connection-variable check. Takes the environment selector, and answers store-backed from a resolved block |
| `cli/project.ts` | config + descriptor + snapshot + adapter, loaded once against the selected environment, and the render-vs-compare read rule |
| `cli/report.ts` | what a command prints and what it exits with — the one home for both; the finding kinds include `scan`; the structured fields a finding may carry beside its message (`at`, a file and position; `slot`, a template and slot name) and `FindingLocation` over them; `plural`, the one count-and-noun the modules that spelled it inline now share; `posixRelative`, a path in the `/`-joined spelling every message uses; and the phrasing helpers a message is built from — `clip` (a one-line preview of quoted text), `shapeOf` (a value's type with its article) and `collapseLines` (a per-file block reduced to one count line past the point where it stops being a list, the caller printing on its own channel) |
| `cli/validate.ts` | one value against its key's rules: the shape check, then the save checks with the template's slots in scope |
| `cli/artifacts.ts` | writing an emitted artifact: the deterministic JSON serializer, the plan-then-apply writers (`planWrite`/`planJson`/`writePlanned`, all-or-nothing), `planRepoForms` and `rethrowBatchFailure` (the repo-form batch and its failure, shared by `register`, `pages scan`, `remove`, `pull` and `email extract`; on the static-HTML host the forms are the descriptor, the snapshot and the marked documents, and a document it cannot regenerate refuses the whole batch), and `writeExecutable` (the hook's `0o755`) |
| `cli/installed.ts` | the files that ship inside stet — the migrations and the manifest |
| `cli/meta.ts` | the bridge from a command holding an adapter to the connection-shaped `stet_meta` helpers; the trio follows the environment selection, so a stamp lands in the database the command was pointed at |
| `cli/check.ts` | `check` — descriptor, snapshot and generated files, offline; each generated-file finding carries the regenerator that rewrites THAT file, and on the static-HTML host the generated files are the marked documents |
| `cli/seo.ts` | `seo check` — the SEO rules over descriptor and snapshot, offline; and the two structured warns outside the severity table, for a store-backed project and for an adopted host that declares no pages |
| `cli/read.ts` | `list`, `get`, `diff` |
| `cli/write.ts` | `draft`, `publish` (including `--due`), `seed` |
| `cli/pull.ts` | `pull` — the store's truth into the repo forms; on the static-HTML host the documents are regenerated through the same all-or-nothing batch |
| `cli/audit.ts` | `audit` — the descriptor against the store's rows |
| `cli/doctor.ts` | `doctor` — mode, health, what production is serving, the host kind, the git warn where publish is a commit and the checkout is not a repository, and the wrapper-chain check over each pointered template's relative-import closure |
| `cli/upgrade.ts` | `upgrade` — migrations, the registry, the version stamp; no registry exists on the static-HTML host and it says so |
| `cli/init.ts` | `init` — detect framework/store/react and the router by its route files through the pages detector, scaffold the new files (the read path branching on whether the host declares react, and resolving per request behind a `Proxy` over an mtime-and-size cache, so an edit to the snapshot is served without restarting the host), the one shown edit to existing code (the root-layout `CopyProvider` mount, itself gated on the host declaring react), and the agent-guidance write; plus the static-HTML detection (a root `.html` and a manifest declaring no bundled host) and the config projection that shape writes |
| `cli/pages.ts` | `pages scan` — the host's file-based routing convention read as page records: the arm detector (Astro, Next App, Next Pages) over directory entries and file names plus a markdown page's frontmatter under `pages scan`, the per-arm route walkers, the skip taxonomy every undeterminable route lands in, and the propose/`--apply` pair that writes records, their scaffolded SEO keys and the codegen in one batch — `proposeForHost` and `applyPages` are exported, so the dashboard's SEO tab offers and declares the same proposals the command does; plus the `html` arm, the one arm the CONFIG selects, whose apply binds a page's title and description to the keys its marks name and mints nothing; plus `normalize`, the descriptor-name grammar `email extract` names templates with |
| `cli/scan.ts` | `scan` — the drift gate over the managed surfaces AND the declared copy modules, per-glob so a dead glob is named; the dialect branch ahead of every compiler-needing call; `classifyAdoption`, the one adopted/diverged/unadopted verdict `register` shares; the position-free baseline; the uncovered-route warn over `pages`' own detector; and, on the static-HTML host, the located proposals the `html` dialect yields with their keys |
| `cli/register.ts` | `register --from scan` — add a key, seed its default, and produce the leaf-only rewrite; the second loop that adopts a copy module as RECORD, under the property's own name and with no source edit; the `--write` guard over the read-path specifier's own resolvability; regenerate the codegen when keys are added, through the same rollback batch every other repo write uses; and the html branch, which mints or SHARES a key per located proposal and inserts the one mark |
| `cli/remove.ts` | `remove` — the `--write`-gated, plan-then-apply key delete, its two halves split so the dashboard runs the same plan (`planRemoval`) and the same batch: the plan (entry, every locale's value, the bakes and page-reference drops it will perform, the files still mentioning the key, the store posture) and the one all-or-nothing batch over the five repo forms — descriptor, snapshot in EVERY locale, and the three regenerated codegen files; it owns `keys`, the derivation declarations pointing at them and the page references to them, with the descriptor validator re-run over the post-removal copy as the gate for any reference class a later schema adds; the store untouched by construction, so a removed key's rows become the orphans `audit` already reports; on the static-HTML host the plan names each mark the batch will strip |
| `cli/eject.ts` | `eject` — the `--write`-gated, plan-then-apply reversal: un-rewrite the leaves (loaded only where the import probe finds host files to reverse), unwrap the mount, write content back, the whole-host backstop over `pages`' own dirent walk and who imports each planned deletion, the closing line naming what stays, and the dependency, hook and agent-guidance removal; `stetImportRegex`, the one import-position pattern the backstop and that probe share; and the html arm, which regenerates each document and strips every mark instead |
| `cli/hook.ts` | `hook install` — the opt-in pre-commit gate; and `hooksDir`, the git-resolved hooks directory `eject` reuses |
| `cli/agents.ts` | the host's agent-guidance block — the builder, the `AGENTS.md`/`CLAUDE.md` targeting, the three-state plan (`planGuidance`), the eject removal (`removeGuidance`), `agents install`, and `fileIdentity`, the `dev:ino` compare `eject` reuses to tell one file from two names |
| `cli/source-scan.ts` | the shared TSX locator (`scanSource`) `scan`/`register`/`eject` all call — which also yields its parse and the spans it CLASSIFIED, so a file both declarations match is read once and every literal is owned by exactly one walk — plus the two detectors beside it: `scanModule` (a declared copy module's literals, the property names proposing themselves as keys) and `scanDialect` (template-dialect prose, pure text, no compiler on its path, dropping the one shape it reads as code rather than copy — a brace-opening run carrying no quote); the one qualifying bar both detectors share, which strips tags with the module's own `TAG` and nothing else; the one dialect-extension predicate (`isDialectFile`/`dialectOf`) `eject` shares, `.html` among the five; `blankNonMarkup`, the blanking the static-HTML tokenizer reads tags out of; `freeKey` and the HTML 4 named-entity table with `undecodedEntity` over it; the managed-surface glob matcher (`matchGlob`); `isJsxFile`; the whole-word token matcher (`mentionsToken`) the compiler-less paths grep with, the two parsed predicates built over it — `rendersToken` (does this file READ the slot) and `carriesToken` (does it carry this wrapper token in code, comments excluded) — and the lazy `loadTypescript` |
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
| `server/mount.ts` | `createStetHandler` — the Bearer-authenticated catch-all `{ GET, POST }`: constant-time auth through `bearerMatches`, the RPC-delegating POST routes, the render proxy and Bearer reads, and the fire-and-forget publish hooks |
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

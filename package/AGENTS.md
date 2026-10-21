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
| `src/descriptor.ts` | loading and validating a descriptor against the published schema, plus its structural rules (a slot's `requires` names only its `vars`), and the page-reference walk `remove` and `rename` share |
| `src/codegen.ts` | descriptor → generated artifacts (the key registry with both its unions — every key, and the string-valued keys a `Record<StringKey, string>` map is typed over — plus the ambient types and the defaults module), the source hash they carry, and the generated-file currency check over it |
| `src/snapshot.ts` | the committed snapshot: loading, the descriptor-vs-snapshot currency check, and the smells |
| `src/resolve.ts` | key → value: the resolution order, the locale chain, quarantine of malformed stored values, and `derivedText`, what a derivation renders |
| `src/bundle.ts` | the read bundle's format and its read semantics (both forms), and `resolveAll` — every declared key resolved once into the map an accessor takes |
| `src/access.ts` | the framework-free ambient-access contract |
| `src/validate.ts` | save-time checks: shapes, limits, variables, required variables (`checkRequires`), class rules, fit budgets |
| `src/value-check.ts` | one value against its key's rules as findings: the shape check, then the save checks with the template's slots in scope — the gate the CLI, the dashboard and the mounted API's draft and publish routes share, with the store keys a check reads and the rows as they stand once a set of drafts ships |
| `src/seo.ts` | the offline SEO audit: the fourteen rules, the one severity table, the two word lists |
| `src/targets/adapter.ts` | the target seam: the adapter contract, and the one registry a consumer looks up by a key's declared target |
| `src/targets/html-email.ts` | the html-email target — the same HTML escaping, the line metrics derived from the email-safe content width, and the element list behind the markup-in-content construct rule |
| `src/targets/web.ts` | the web target — HTML-entity escaping, the line metrics a budget estimate reads, and the decision that web has no illegal constructs |
| `src/store.ts` | the normative store interface, and the answers an adapter may return |
| `src/contacts.ts` | the contacts rules the join route, the CLI and every adapter's `addGroup` share: the address, the group key, a group's declaration (`checkDeclaration`), a group's answers |
| `src/preview.ts` | the preview seam: the states a preview can name, the per-identity override resolver, and a change's page-span |
| `src/preview-token.ts` | the signed token that names one preview state — mint and verify — and `hmac` and `sameSignature`, the one signer and the one compare every token uses |

`migrations/` holds the numbered SQL — `001_content_cms.sql`, `002_changesets.sql` and `003_contacts.sql` — copied as-is into an adopting project.
`templates/` holds the assets stet ships and either writes into a host or
runs against one: `starter-descriptor.json` and `starter-defaults.json` (what
`init` scaffolds on a JavaScript host; the static-HTML host is scaffolded empty,
since its page already carries its copy), `pre-commit` (the hook `hook install`
writes), `stet-gate.mjs` (the gate's runner, which install copies into git's
common directory beside the `stet-gate.json` list of checkouts it reads),
`preview-agent.js` (the script `stet dev` adds to every page its preview shows,
which outlines the selected key and shows its draft, shows a tagged draft in
the page's own styling, finds every declared key's text on the page (the census)
and, in Edit mode, takes a click as a pick and edits the text in place),
`email-runner.cjs` (the child that loads a host template through the host's own
compiler), and `forms/` (the sign-up scaffold `init` writes on a Next.js 15.1+
host that collects sign-ups: the forms module, the rate limit, and the join and
unsubscribe routes). Every one is resolved through `packageRoot()`, never by a path
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
| `adapters/store-shared.ts` | the cross-adapter contracts: the row mapping, the changeset row mapping, keyset paging, the conflict vocabulary every raise is built from, the error-code table, the PostgREST filters (equality values bare, list values quoted), the refusal parse, telling the four answers apart, the `stet_meta` shape both SQL adapters read, the contacts mapping and markers, and `invalidDeclaration`, the declaration every `addGroup` refuses |
| `adapters/changesets.ts` | the one group-revert enumeration, over the public store interface — every surface calls this rather than reimplementing the walk |

`cli/` composes `src/` and `adapters/` and adds only I/O, dispatch and
reporting. Nothing imports from it except its own modules, its tests and the
bin; `src/` stays zero-I/O and its purity roster lists `src/` alone.

| File | Holds |
|---|---|
| `cli/main.ts` | the dispatch, the `CliIo` contract, the usage text, `commandHelp` (a command's own usage lines, read out of the usage, for `stet <command> --help`), and the bin entry, which exits once stdout and stderr have flushed |
| `cli/dev.ts` | `stet dev` — the loopback listener, the adapter between Node's request/response pair and the handler's `Request → Response` shape (the unparseable target and the body cap, the two guards a `Request` cannot carry), `--port`/`--no-open`/`--add`, the per-run token, and the browser it opens |
| `cli/dev-routes.ts` | everything the dashboard decides: the Host, Bearer and Origin guards, the page response with its policy and nonce, the route table, the per-site queue, the mounted API and the static-file arm (the preview agent injected into every document it serves, and every file sandboxed), the public agent route, the run's preview channel and the one preview proxy per site, the dev child's lifecycle and the one stop path every child ends through (`endDevServer`, run for every child in parallel when the server closes), the pending list (the stet-written forms git reports uncommitted, read on every site read, save and commit), the commit over `:(literal)` pathspecs, the templates a save carries and the gate on every derived key a save moves, the marks route (where each key renders: the marks on a static-HTML host, the source reads on a JavaScript host, and each place's kind), the save's same-words answer, the push that sets a missing upstream, the branch's live branch, its preview address read through the operator's own `gh` (`previewOfSummary`, `githubRepoOf`) and Publish to live, the merge and split routes over their commands' planners, the keys a commit removed and their restore (the revert, or the keys alone with the removed markup) with the places each was shown at its parent commit, the stale check ahead of a snapshot save's gate, the unread-key routes (`usage`, `route-reads`), the commit's `carries` and the key-history route, the email-preview route and the mount's renderer, and `captured` — a command run through `runCli` in this process with collecting sinks |
| `cli/workspace.ts` | `~/.stet/projects.json` — the entries, the read and the whole-file write, `loadSite` (the `not-adopted`/`broken`/`ready` verdict every route branches on, a ready site carrying its `project` and `router`), `siteId`, the checkout's own `.env` files, `connectionEnv` (the checkout `stet dev` was started in takes the process environment's values for the connection variables its config names, over its files; every other checkout reads its files alone), `connectionNames` and `blockVariables` (the variables a config and a store block name), `baseEnv`/`childEnv` (the run token taken back out of every child), `siteChildEnv` (another checkout's children, without the connection variables its config or the started-in checkout's config names), `siteIo`, and `devDefaults` — the dev URL and command a host implies |
| `cli/git.ts` | git as an argument array — `git(cwd, args)` over `spawnSync` with the run token stripped and no terminal prompt; `gitData`, the variant that answers stdout alone for data; `gitBytes`, the variant that answers stdout as bytes under a ceiling, with stdin; `gitStream`, the process itself for an answer read as it arrives; `gitFiles`, the file list a `ls-files` read answers, null where git cannot; `uncommittedPaths`, the checkout-relative paths that differ from HEAD; `operationInProgress`, a merge, cherry-pick, revert or rebase part-way; `trackable`, whether git tracks or would track a file (the `check-ignore` probe `contacts export --out` and the agent-guidance note share); `gitState`, the checkout's state every dashboard reply stamps itself with — head, branch, upstream, ahead, behind and dirty — from one porcelain v2 status read; `pushRemoteOf`, the remote a push of a branch goes to, in git's own order; and `runTool`, the runner the dashboard's `git` and `gh` calls share — its own process group, a deadline, the run token out of the environment and no prompt |
| `cli/preview-proxy.ts` | the loopback proxy in front of a site's dev server that adds the preview agent to its pages — `startPreviewProxy` (its own port and origin, one upstream, its own Host and pages only; the agent added through latin1 to a page the frame loads, by its `Sec-Fetch-Dest` or, without one, by an answer that opens an HTML document; everything else byte for byte; an upgrade joined only on the dev server's 101, any other answer relayed and both sockets closed; a dev server that stops mid-answer or goes quiet past `UPSTREAM_IDLE_MS` answering the down line; a `Location` or Next's `x-action-redirect` naming the dev server under any loopback spelling of its port moved onto the proxy's origin) and `injectAgent` |
| `cli/liveness.ts` | whether a process or a process group still runs — `alive` and `gone`, `kill(…, 0)` first and a zombie counted as ended where `/proc` says so — whether a URL answers (`answers`), a process group ended (`endGroup`: SIGTERM, two seconds, SIGKILL), and `untilInterrupted`, the signal wait `dev` and the audit share |
| `cli/static-files.ts` | serving a checkout's files: `insideCheckout`, the real-path containment, `servableFile` (every segment decoded, dot-leading segments and `node_modules` refused) and `contentTypeOf`; the dashboard's static route and the audit's documents server share it |
| `cli/lighthouse.ts` | `audit lighthouse` — the pages selected, the target started, each page measured over `--runs`, the report lines and the `--json` object, the `--fix` plan printed and written, the stop of Chrome and the preview on every exit path |
| `cli/lighthouse-run.ts` | the one module that imports Lighthouse and `chrome-launcher`: the part of a result the command reads, the runner over one headless Chrome, the missing-Chrome error, `importAuditPackage`, which raises a package that does not load (`ERR_MODULE_NOT_FOUND`, or Yarn PnP's `MODULE_NOT_FOUND`) as one error, and `auditPackagesPresent`, the check the command makes before it reads the config; Lighthouse, `chrome-launcher` and `selfsigned` are optional peers of the package, and no other command loads them |
| `cli/lighthouse-audits.ts` | reading one Lighthouse run: who acts on each failing audit (`copy`, `fix`, `stet`, `host`), where its element sits, the line it prints, and the median over `--runs` |
| `cli/lighthouse-fix.ts` | `audit lighthouse --fix` — the head edits every site lacking them shares (doctype, charset and viewport metas, `lang` from the config), the Vite shell, the Next root layout's `lang` and the Astro lines |
| `cli/audit-target.ts` | what the audit measures: the checkout's documents served as deployed, or a production preview relayed, fronted over HTTP/2 on a loopback port |
| `cli/footprint.ts` | stet's own footprint on a React host's page: whether the read path imports the provider's index and which files read copy on the client; `upgrade` changes what it finds and the audit reports it |
| `cli/provider-mount.ts` | the root-layout `CopyProvider` mount: whether a layout carries it, where it wraps, the edits `register` plans, the unmount `upgrade` and `eject` plan, and the snippet that names it by hand |
| `cli/seo-documents.ts` | `seo check`'s copy-shaped accessibility rules (`missing-label`, `missing-name`, `missing-lang`, `empty-heading`, `redundant-alt`, and `missing-alt` widened) over the managed html documents and each key's places |
| `cli/files.ts` | which files a declaration names — the dirent walk (`walk`, `WALK_SKIP`) and the glob match over it (`filesForGlobs`, `staticPrefix`); no file content is read here, and `pages`/`scan` re-export what they used to own |
| `cli/html-host.ts` | the static-HTML host: the tokenizer over the detector's blanked text, the key-element rule and the placeholder builder, the proposal set scan and register read, the regenerator pull and the batch write through, the currency check, the mark edits and the strip, and the head-text rule and `derivationOf`, the one comparison of a head text with visible text, which register's two passes and its conversion of an adopted site share; the section word and role of each proposal, and the names register gives at the end of its run, with the key each proposal receives (`keyAt`) that scan prints; `heldTextOf`, the text a declared web key holds, which both hosts' runs share onto equal text; and `proposeHtmlSources`, the claim pass over sources in hand, which the dashboard's restore reads a revision's documents through |
| `cli/args.ts` | one command's arguments, over `node:util`'s `parseArgs` |
| `cli/config.ts` | `stet.config.json` — every setting, every default, the adapter table, the environments map, the one selection function every store block is read through, the host kind (`host` — absent for a JavaScript host, `"html"` for the static-HTML one) and `isHtmlHost`, the ONE predicate every seam branches on, the adoption fields (`router` — `app` \| `pages` \| `astro` — `readPath`, `rootLayout` (absent on an Astro host, which has no root React layout), `apiTokenEnv`, `mountRoute`, `managedSurfaces`/`emailSurfaces`/`copyModules`, `scan`), the host's own path-alias reader and the specifier resolver over it — tsc's rules, which `init` probes, `register --write` guards on and `eject` resolves consumers through — and the path an adopting project keeps its migration copies at |
| `cli/store.ts` | config → adapter, over the four factories; the connection-variable check. Takes the environment selector, and answers store-backed from a resolved block |
| `cli/project.ts` | config + descriptor + snapshot + adapter, loaded once against the selected environment, the render-vs-compare read rule, and `injectedFor` and `openContactsStore`, the contacts store `stet contacts` and `doctor` open |
| `cli/report.ts` | what a command prints and what it exits with — the one home for both; the finding kinds include `scan`; the structured fields a finding may carry beside its message (`at`, a file and position; `slot`, a template and slot name) and `FindingLocation` over them; `plural`, the one count-and-noun the modules that spelled it inline now share; `posixRelative`, a path in the `/`-joined spelling every message uses; and the phrasing helpers a message is built from — `clip` (a one-line preview of quoted text), `shapeOf` (a value's type with its article) and `collapseLines` (a per-file block reduced to one count line past the point where it stops being a list, the caller printing on its own channel); and `sanitizeLine`, over `src/contacts.ts`' control class |
| `cli/validate.ts` | `value-check`'s findings reported into a command's report, and the gate for a key with no name yet |
| `cli/artifacts.ts` | writing an emitted artifact: the deterministic JSON serializer, the plan-then-apply writers (`planWrite`/`planJson`/`writePlanned`, all-or-nothing), `planRepoForms` and `rethrowBatchFailure` (the repo-form batch and its failure, shared by `register`, `pages scan`, `remove`, `pull` and `email extract`; on the static-HTML host the forms are the descriptor, the snapshot and the marked documents, and a document it cannot regenerate refuses the whole batch), and `writeExecutable` (the hook's `0o755`) |
| `cli/installed.ts` | the files that ship inside stet — the migrations and the manifest |
| `cli/meta.ts` | the bridge from a command holding an adapter to the connection-shaped `stet_meta` helpers and rename-log reader; the trio follows the environment selection, so a stamp lands in the database the command was pointed at |
| `cli/check.ts` | `check` — descriptor, snapshot and generated files, offline; each generated-file finding carries the regenerator that rewrites THAT file, and on the static-HTML host the generated files are the marked documents |
| `cli/seo.ts` | `seo check` — the SEO rules over descriptor and snapshot, offline; and the two structured warns outside the severity table, for a store-backed project and for an adopted host that declares no pages |
| `cli/read.ts` | `list`, `get`, `diff` |
| `cli/write.ts` | `draft`, `publish` (including `--due`), `seed` |
| `cli/pull.ts` | `pull` — the store's truth into the repo forms; on the static-HTML host the documents are regenerated through the same all-or-nothing batch |
| `cli/audit.ts` | `audit` — the descriptor against the store's rows |
| `cli/doctor.ts` | `doctor` — mode, health, what production is serving, the host kind, the git warn where publish is a commit and the checkout is not a repository, the older-gate warn where the installed pre-commit hook is the form before 0.3.1, a line on a hooks folder outside the repository or a hooks manager's pre-commit and whether it carries the gate's line, a line naming `stet hook remove` where the shipped gate lists this checkout, the compiler warn where a declared surface or copy module needs `typescript` and it does not load (`compilerCause`, the one classification of that failure the wrapper chain shares), and the wrapper-chain check over the import closure of each pointered template's file and its frame's |
| `cli/upgrade.ts` | `upgrade` — migrations, the registry, the version stamp; no registry exists on the static-HTML host and it says so |
| `cli/contacts.ts` | `stet contacts` — the terminal read surface, export, erase, suppress, import, groups |
| `cli/init.ts` | `init` — detect framework/store/react and the router by its route files through the pages detector, scaffold the new files (the read path branching on whether the host declares react, and resolving per request behind a `Proxy` over an mtime-and-size cache, so an edit to the snapshot is served without restarting the host), the read path importing `@getstet/stet/react/server` and mounting no provider (it prints the not-mounted line; `register` mounts one through `cli/provider-mount.ts` when a client component first reads copy), and the agent-guidance write; plus the third question (whether the site collects sign-ups) and, on a Next.js 15.1+ host, the sign-up scaffold from `templates/forms/` with its contacts block and `.env.example` names; plus the static-HTML detection (a root `.html` and a manifest declaring no bundled host) and the config projection that shape writes |
| `cli/pages.ts` | `pages scan` — the host's file-based routing convention read as page records: the arm detector (Astro, Next App, Next Pages) over directory entries and file names plus a markdown page's frontmatter under `pages scan`, the per-arm route walkers, the skip taxonomy every undeterminable route lands in, and the propose/`--apply` pair that writes records, their scaffolded SEO keys and the codegen in one batch — `proposeForHost` and `applyPages` are exported, so the dashboard's SEO tab offers and declares the same proposals the command does; plus the `html` arm, the one arm the CONFIG selects, whose apply binds a page's title and description to the keys its marks name and mints nothing; plus `fileRoute`, the html arm's file-to-page-route mapping the dashboard's marks route compares with; plus `normalize`, the descriptor-name grammar `email extract` names templates with |
| `cli/scan.ts` | `scan` — the drift gate over the managed surfaces AND the declared copy modules, per-glob so a dead glob is named; the dialect branch ahead of every compiler-needing call; the position-free baseline; the uncovered-route warn over `pages`' own detector; each proposed key taken from register's own naming pass on both hosts, over validated forms, with the role name where the pass cannot run; and, on the static-HTML host, the located proposals the `html` dialect yields with their keys |
| `cli/register-run.ts` | the JSX run's first pass and its names, which `register` adopts and `scan` prints: `planJsxRun` (every surface parsed and classified, the copy modules walked for the names they reserve, a literal a declared web key already holds reusing it, the rest numbered across the run), the accessor kind and target of a file, and `classifyAdoption`, the one adopted/diverged/unadopted verdict `register` and `scan` share |
| `cli/register.ts` | `register --from scan` — add a key, seed its default, and produce the leaf-only rewrite; the second loop that adopts a copy module as RECORD, under the property's own name and with no source edit; the `--write` guard over the read-path specifier's own resolvability; the descriptor, snapshot, codegen and every leaf edit written only under `--write`, through the same rollback batch every other repo write uses; and the html branch, which mints or SHARES a key per located proposal and inserts the one mark |
| `cli/remove.ts` | `remove` — the `--write`-gated, plan-then-apply key delete, its two halves split so the dashboard runs the same plan (`planRemoval`) and the same batch: the plan (entry, every locale's value, the bakes and page-reference drops it will perform, the files still mentioning the key, the store posture) and the one all-or-nothing batch over the five repo forms — descriptor, snapshot in EVERY locale, and the three regenerated codegen files; it owns `keys`, the derivation declarations pointing at them and the page references to them, with the descriptor validator re-run over the post-removal copy as the gate for any reference class a later schema adds; the store untouched by construction, so a removed key's rows become the orphans `audit` already reports; on the static-HTML host the plan names each mark the batch will strip |
| `cli/rename.ts` | `rename` — the command, its `--propose` plan (the names the naming rule gives the declared keys), and the mark and read moves (`markRenames`, `readRenames`, `keyMoveWrites`) `merge` and `split` share |
| `cli/merge.ts` | `merge` — one key folded into another that holds the same words: the planner the dashboard's Link them shares (`planMerge`), its refusals, the forms (the leaving key's pages, derivations, page references and one-sided locales moved to the survivor), and the one batch |
| `cli/split.ts` | `split` — one place of a key given its own key: the planner the dashboard shares (`planSplit`), its refusals, the forms (the entry copied without its pages, every locale's value), the host half filtered to the one line, and the name the naming rule gives that place (`proposedSplitName`) |
| `cli/eject.ts` | `eject` — the `--write`-gated, plan-then-apply reversal: un-rewrite the leaves (loaded only where the import probe finds host files to reverse), unwrap the mount, write content back, the whole-host backstop over `pages`' own dirent walk and who imports each planned deletion, the closing line naming what stays, and the dependency, hook and agent-guidance removal; `stetImportRegex`, the one import-position pattern the backstop and that probe share; and the html arm, which regenerates each document and strips every mark instead |
| `cli/hook.ts` | `hook install` and `hook remove` — the opt-in pre-commit gate: one fixed hook per repository that runs the runner in git's common directory, which gates each listed folder a commit touches in every worktree where it is a stet checkout with stet installed; `gateSite` (a checkout's common directory, worktree, the `stet-gate-id` file in that worktree's git directory and folder), `readGate`/`writeGate` (the `stet-gate.json` list, each entry recording its worktree's id, and an entry whose worktree git removed kept), `hookKind` (the shipped hook, the older form `HOOK_BEFORE_0_3_1`, or the operator's own), which install, `eject` and `doctor` read; `removeFromGate`, one checkout taken out of the list with the hook, runner and list removed after the last, which `hook remove` and `eject` share; `GATE_LINE`, the line a hook stet does not write adds, and `SHARED_GATE_LINE`, its form for a hooks folder other repositories share and for a committed hook, with `gateLineIn`, the one read of which of the two a hook carries; `operatorHook` (the pre-commit that actually runs, husky v9's `.husky/pre-commit` behind its generated `.husky/_`); `withGateLock`, held while the list is read and written; `worktreeTop`, `insideDir`; `hooksDir`, the git-resolved hooks directory `eject` reuses; `isSite`, the one entry-matches-checkout predicate install, remove and `doctor` share, and `entryAlive`, whether the worktree an entry names still exists and still holds the id install wrote; and `armGateSeo`, which `upgrade` runs to add `seo check` to this checkout's entry |
| `cli/agents.ts` | the host's agent-guidance block — the builder, the `AGENTS.md`/`CLAUDE.md` targeting, the three-state plan (`planGuidance`), the eject removal (`removeGuidance`), `agents install`, and `fileIdentity`, the `dev:ino` compare `eject` reuses to tell one file from two names |
| `cli/source-scan.ts` | the shared TSX locator (`scanSource`) `scan`/`register`/`eject` all call — which also yields its parse and the spans it CLASSIFIED, so a file both declarations match is read once and every literal is owned by exactly one walk — plus the two detectors beside it: `scanModule` (a declared copy module's literals, the property names proposing themselves as keys) and `scanDialect` (template-dialect prose, pure text, no compiler on its path, dropping the one shape it reads as code rather than copy — a brace-opening run carrying no quote); the one qualifying bar both detectors share, which strips tags with the module's own `TAG` and nothing else; the one dialect-extension predicate (`isDialectFile`/`dialectOf`) `eject` shares, `.html` among the five; `blankNonMarkup`, the blanking the static-HTML tokenizer reads tags out of; the HTML 4 named-entity table with `undecodedEntity` over it; the managed-surface glob matcher (`matchGlob`); `isJsxFile`; the whole-word token matcher (`mentionsToken`) the compiler-less paths grep with, the two parsed predicates built over it — `rendersToken` (does this file READ the slot) and `carriesToken` (does it carry this wrapper token in code, comments excluded) — and the lazy `loadTypescript` |
| `cli/key-usage.ts` | the unread-key scan — which declared keys the source reads (`read`, `unknown`, `not_found`), over the files git lists: tracked, and untracked but not ignored, the stet bindings resolved by declaration and the key literals followed one hop; the dashboard's badge and `list --json`'s `badge` and `usage` |
| `cli/key-history.ts` | one key's past values from git for a snapshot site's History — one `log --follow`, one `cat-file --batch` read as it streams |
| `cli/import-closure.ts` | the depth-bounded import and re-export closure of files, and whether the walk stopped at an import it does not follow; the wrapper chain and the route reads share it |
| `cli/key-names.ts` | the element vocabulary and the naming rule, a runtime leaf |
| `cli/key-plan.ts` | the naming plan for register and rename |
| `cli/key-reads.ts` | the read forms, a dialect's code spans (`codeOf`, the code and non-code regions of a file), the one brace matcher, the rename's three classes, the test of a module specifier against stet's own modules (`stetModuleTest`) and the parse check over its braces |
| `cli/email-render.ts` | the render seam — one host template executed per child process, the failure taxonomy the exit table maps to, and the ceilings (output size, wall clock); the pointer's request (`pointerRequest`, `templateProps`), its containment inside the project (`containedPointer`) and the optional frame, fill and send the runner applies |
| `cli/email-extract.ts` | `email extract` — the proposer and its `--apply` batch: the declaration a template's source yields, the skip taxonomy every ambiguity routes to, the shell rewrite, and the surface persistence |
| `cli/email-verify.ts` | `email verify` — the custody proof: HEAD's render against the working tree's, byte for byte, with the frame and fill on both sides, and the captured baseline where git has no before |
| `cli/email-send.ts` | `email render` and `email test` — a declared template rendered with the snapshot's or the store's slot values (drafts over them under `--draft`), written out or handed to the host's `emailSend` function |
| `cli/email-preview.ts` | the dashboard's email preview and `stet dev`'s mount renderer — a declared template rendered with the dashboard's words, the markers that let a click name its slot, the sentinels' conversion to `data-stet` spans, and `mountSender`, the mount's Test send over the host's `emailSend` |
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
| `server/mount.ts` | `createStetHandler` — the Bearer-authenticated catch-all `{ GET, POST }`: constant-time auth through `bearerMatches`, the RPC-delegating POST routes (`revert` checks the body's key against the version before the write), the content gate on draft and publish (a 422 with the validator's messages, before anything is written), the render proxy and Bearer reads (`changes?id` answers one change with its members), and the fire-and-forget publish hooks |
| `server/forms.ts` | `createStetFormsHandler` — the public join and unsubscribe routes, separate from the Bearer mount |
| `server/unsubscribe-token.ts` | the unsubscribe token and `unsubscribeUrl`, signed by the forms secret alone |
| `server/http.ts` | the HTTP pieces every server surface shares: `json`, the capped body reads, and the signer and compare re-exported from `src/preview-token.ts` |
| `server/index.ts` | the `@getstet/stet/server` surface: `createStetHandler` and its event types, `createStetFormsHandler` with its option, guard, event and page types, `unsubscribeUrl`, and the preview token pair |

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

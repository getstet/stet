<div align="center">

<img src="https://getstet.github.io/brand/cover.png" alt="stet — one copy layer for all your sites and apps" width="820">

<p>
  <a href="https://www.npmjs.com/package/@getstet/stet"><img alt="npm" src="https://img.shields.io/npm/v/@getstet/stet?color=0e6b74&label=npm"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-0e6b74"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-0e6b74">
  <img alt="Types" src="https://img.shields.io/badge/types-included-0e6b74">
</p>

<p>
  <a href="https://getstet.github.io/docs">Documentation</a> ·
  <a href="https://getstet.github.io/docs/quickstart">Quickstart</a> ·
  <a href="https://getstet.github.io/docs/how-stet-works">How stet works</a> ·
  <a href="https://getstet.github.io/changelog">Changelog</a>
</p>

</div>

---

stet is a copy layer for your codebase. Every user-facing sentence becomes a
typed key with a committed fallback value; the CLI checks, versions and
publishes the words; your framework renders them.

Your copy lives in your repo as data — a `descriptor.json` that declares every
key and a `defaults.json` that carries every value — with generated TypeScript
types over both. Editing a sentence is a reviewed change. Deleting a key a page
still references is a refused change. Shipping a page with no meta description
is a failed check, before anything deploys.

## Install

```sh
npm install @getstet/stet
npx stet init
```

`init` detects your framework and store, scaffolds the descriptor, the
committed snapshot and the typed read path, and shows you its one edit to
existing code before applying it. Then:

```sh
npx stet scan                            # find the copy already in your components
npx stet register --from scan --write    # adopt those strings as keys, byte-identical
npx stet check                           # descriptor, snapshot and types — offline
```

For a plain HTML site with no build, the same three steps run against the pages
themselves:

```sh
npm init -y
npm i -D @getstet/stet
npx stet init                            # detects the html host, writes no read path
npx stet scan                            # locate the element behind every run
npx stet register --from scan --write    # mark each one with data-stet="<key>"
npx stet hook install                    # the pre-commit gate
```

## What you get

- **A committed snapshot, no database required.** `defaults.json` is the
  fallback for every key. A snapshot-only project has nothing to provision and
  nothing to fetch — reads resolve from your repo.
- **Typed keys.** `keys.ts` and ambient types are generated from the
  descriptor; an unknown key is a compile error, in TypeScript or plain JS
  editors alike.
- **Offline checks.** `stet check` validates descriptor, snapshot and generated
  files. `stet seo check` runs its SEO rules over your declared pages and
  committed copy — no network, no database, so it runs on a fork PR before
  anything deploys.
- **Page declaration from your routes.** `stet pages scan` reads your
  file-based routing convention, proposes page records with scaffolded SEO
  keys, and writes nothing without `--apply`.
- **Email custody.** `stet email extract` adopts template copy into slots;
  `stet email verify` proves the rendered output byte-identical through your
  own renderer.
- **A real exit.** `stet eject` un-rewrites your source, writes the content
  back, and removes the dependency. Adoption is reversible by construction.
  `stet hook remove` takes a checkout out of the pre-commit gate and leaves stet
  installed.

## Dashboard

```sh
npx stet dev
```

A server on the loopback interface, and a browser opened on it:

```
dashboard: http://127.0.0.1:4400/?t=<run token>
```

The page edits the checkouts listed in `~/.stet/projects.json`. Running `stet
dev` inside a checkout adds that checkout to the list; `--add <path>` adds one
from anywhere else.

On a snapshot-only project the page saves through the same gate and the same
all-or-nothing write batch the terminal uses, then commits the stet files the
checkout holds uncommitted and pushes the commit. On a store-backed project it
writes drafts and publishes them through the project's own mounted API, against
the environment selected in the header. Health runs `check`, `doctor`, `scan`
and `audit` in the same process; the SEO tab runs `seo check` and `pages scan`;
Setup runs `stet upgrade --dry-run`. Every command answers `--help` with its own
usage.

Each key says what it is — a headline, a paragraph, a page title, a share
description — and where it appears; a key the page does not show says where it
does, with a search result and a share card drawn from the drafts.

The server binds `127.0.0.1` and nothing else, and it has no identity model. A
token is minted per run, carried in the URL the terminal prints, and taken out
of every child process the server starts. Anyone who can reach the port and
holds that token can edit every checkout in the workspace file and run commands
as you: the dev command a site's Setup names is run through your shell.

## The store, when you want one

Publishing without deploys is the optional half: Postgres adapters, draft and
publish with revert, grouped changesets that publish and revert as one unit,
and per-environment connections. A project starts snapshot-only and adds a
store later with `stet upgrade`.

## Frameworks

Next.js (both routers), React and Astro are first-class for scanning and
adoption. A plain HTML site with no build is a host too: stet marks the
elements it manages and regenerates them from the committed snapshot. A head
text that repeats a key the page shows — the share description that is the
headline plus a sentence — is registered as derived from it, so an edit to the
headline reaches the share card. Any JavaScript host reads through
`@getstet/stet/core`. Non-JS services read the committed bundle directly — a
stdlib-only Python helper ships in the package.

## Requirements

Node.js 22 or later. Scanning and adoption use the TypeScript compiler API, so
projects using those commands need `typescript` 5 or 6 as a dev dependency.

## Documentation

The [user guide](https://getstet.github.io/docs) covers installing, adopting
the copy already in your components, the everyday draft-and-publish rhythm,
email templates, the checks, and leaving cleanly.

## License

Apache-2.0

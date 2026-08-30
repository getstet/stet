# stet

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
npx stet scan                    # find the copy already in your components
npx stet register --from scan    # adopt a string as a key, byte-identical
npx stet check                   # descriptor, snapshot and types — offline
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

## The store, when you want one

Publishing without deploys is the optional half: Postgres adapters, draft and
publish with one-click revert, grouped changesets, per-environment connections.
A project starts snapshot-only and adds a store later with `stet upgrade`.

## Frameworks

Next.js (both routers), React and Astro are first-class for scanning and
adoption. Any JavaScript host reads through `@getstet/stet/core`. Non-JS services read
the committed bundle directly — a stdlib-only Python helper ships in the
package.

## Requirements

Node.js 22 or later.

## License

Apache-2.0

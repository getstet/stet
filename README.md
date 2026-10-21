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

Keys are named by where they sit and what they are — home_hero_headline,
home_faq_headline_1. register --from scan --plan-out naming.json writes the
names it would give, for you or an agent to edit with a label and help; --plan
naming.json applies them. stet rename \<old> \<new> moves a key in the
descriptor, the snapshot, the reads stet can prove and every store; stet rename
--propose \<file> writes the names the naming rule gives the keys already
declared, to edit and apply with --plan \<file>. stet merge \<key> --into
\<other> folds one key into another that holds the same words, and stet split
\<key> \<new> --at \<file>:\<line> gives one place of a key its own key.

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
  anything deploys. The pre-commit gate `stet hook install` writes runs `stet
  check`, `stet scan` and `stet seo check` on each commit that touches the
  checkout. A hook committed to the repository carries the guarded line,
  `f="$(git rev-parse --git-common-dir)/stet-gate.mjs"; [ ! -f "$f" ] || node "$f" "$@" || exit 1`,
  so a clone that has not run stet hook install still commits.
- **Lighthouse, with the owner of each failure.** `stet audit lighthouse` runs
  Lighthouse over your declared pages and tags every failing audit as copy to
  write through a key, a head edit `--fix --write` applies, or the site's own
  markup. It needs Google Chrome, and Lighthouse installed as a dev dependency.
- **Page declaration from your routes.** `stet pages scan` reads your
  file-based routing convention, proposes page records with scaffolded SEO
  keys, and writes nothing without `--apply`.
- **Email custody.** `stet email extract` adopts template copy into slots,
  including templates written as a string constant, a registry's subject and a
  shared frame function; `stet email verify` proves the rendered output
  byte-identical through your own renderer; `stet email render` writes an email
  as it would be sent; `stet email test` sends one through your own send
  function.
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
A store-backed checkout reads its connection variables from its `.env` and
`.env.local`; the checkout stet dev was started in also reads them from the
shell, ahead of the files, so `sops exec-env .env.enc 'npx stet dev'` supplies
them without writing them to disk.

On a snapshot-only project the page saves through the same gate and the same
all-or-nothing write batch the terminal uses, then commits the stet files the
checkout holds uncommitted and pushes the commit. On a store-backed project it
writes drafts and publishes them through the project's own mounted API, against
the environment selected in the header. Health runs `check`, `doctor`, `scan`
and `audit` in the same process; the SEO tab runs `seo check`, `pages scan` and the Lighthouse audit;
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

### Editing in the preview

The preview pane has an `Edit | Use` switch, set to Edit when the Content tab
opens. In Edit, hovering copy rings it and names its key, and a click selects
that key; the page's own handlers do not run, so a link does not navigate and a
button does not fire. In Use the page behaves as it does without stet. E
switches between the two when focus is in no field.

A second click, a double click or Enter on selected copy edits the text where
it stands, with the whole text selected so typing replaces it. Enter keeps the
edit and Esc puts the text back. Copy that shares its element with other text,
a value carrying `{{name}}`, an attribute such as alt text, and every tap at a
viewport 760 px wide or narrower open the dashboard's field instead, with the
key's counter beside it. What is typed is an unsaved edit until Save; the page shows
every saved and unsaved draft at once, and the header's unsaved list undoes
each one.

A key with no matching text on the page says so, and names the keys the open
route's files read that the page did not show. A key shown in more than one
place says so before the first keystroke.

### Key badges

Each key shows whether the source reads it. A key some scanned file names shows
no badge. A key no file names shows `not found in any file stet searched`, and
`may be a leftover` once the preview has visited every page the descriptor
declares without finding its text. A key stet cannot judge, because a file
reads copy through a computed key such as ``copy(`tier_${id}`)``, shows
`unknown` with the prefix and the read that taught it, and a read stet cannot
follow at all adds one line above the key list naming it. `stet list --json`
carries the same judgment in each row as `badge` (`read`, `unknown` or
`not_found`), with `usage` listing the learnt prefixes and the reads stet could
not follow. The scan only reads files, and `badge` gates no command.

### Drafts, changes and history

On a store-backed project the page shows each saved draft as `draft ·
<editor> · <time>`. A save over another editor's draft asks `Save yours over
it?` with Take over and Keep theirs. Two tabs of one browser profile share one editor name, so no ask
appears between them. The change bar groups edits
into a change that publishes, previews before and after, and reverts as one
unit. Each key's History lists its past values and restores one.

On a snapshot-only project a save is refused for a key that changed on disk
since the page loaded, naming the new words with Use theirs and Save mine over
it. The Commit button opens what the commit carries, with a word diff per key
and Put back. A key's History comes from git.

### Email preview

The Templates tab renders each email that has a render pointer through your own
renderer, with the slot drafts laid in. A click on the rendered text opens the
slot that wrote it.

On a store-backed project each template also has Test send, which sends the
saved drafts to the address typed there through the function `emailSend` names
in `stet.config.json`:

```json
"emailSend": { "file": "lib/mail.ts", "export": "sendMail" }
```

The function receives `{ to, subject, html, template }`. The same function
serves the terminal:

```sh
npx stet email render welcome --draft --out welcome.html
npx stet email test welcome --to you@example.com --draft
```

`email render` writes the email to `--out` byte for byte. Without `--out` it
writes the markup to stdout followed by one newline, so `stet email render
welcome > welcome.html` holds the markup plus that newline. `email test` prints
`sent <template> to <address>` on success and exits 1 with the host function's
error when it throws.

## The store, when you want one

Publishing without deploys is the optional half: Postgres adapters, draft and
publish with revert, grouped changesets that publish and revert as one unit,
and per-environment connections. A project starts snapshot-only and adds a
store later with `stet upgrade`.

## Contacts

A site's own sign-up form can post to stet: `createStetFormsHandler` on
`@getstet/stet/server` records who joined which group, when and from which
page, in your own Postgres, and serves the one-click unsubscribe your emails
link to. stet sends nothing; your `onJoin` sends the welcome through your own
provider. `stet contacts` lists groups and members, exports or erases one
person, and imports an existing list. Recipes and the SQL reference:
[docs/operator/contacts.md](https://github.com/getstet/stet/blob/main/package/docs/operator/contacts.md).

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

Node.js 22 or later; `stet audit lighthouse` needs 22.19 or later, Google Chrome, and three dev dependencies a plain install leaves out:
`npm i -D lighthouse@13 chrome-launcher@1 selfsigned@5`. Scanning and adoption use the TypeScript compiler API, so
projects using those commands need `typescript` 5 or 6 as a dev dependency.

Upgrading from 0.7.1: npm keeps lighthouse, chrome-launcher and
selfsigned because the lockfile holds them. To drop them, delete their node_modules/ entries from package-lock.json
and run npm i, or install production with npm ci --omit=dev --omit=peer.

## Documentation

The [user guide](https://getstet.github.io/docs) covers installing, adopting
the copy already in your components, the everyday draft-and-publish rhythm,
email templates, the checks, and leaving cleanly.

## License

Apache-2.0

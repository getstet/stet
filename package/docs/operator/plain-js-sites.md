# Plain JavaScript sites

A plain JavaScript site with its own copy table is a host too: name the functions it reads copy through and the attribute its elements carry a key in, import the table, and stet generates the table back from the committed snapshot, placeholders in the site's own spelling.

This page covers the config block, the import, the generated outputs, the second checkout and the status file.

## Keys

A key name is lowercase letters and digits in parts joined by a dot or an underscore: home.title, waitlist.use.music_videos, hero_headline.

`keyStyle` in `stet.config.json` picks the joiner the naming rule uses for the keys stet proposes: `"underscore"` (the default) or `"dotted"`.

## The config block

Four settings describe how the site reads and keeps its copy. A project that sets none of them behaves as before.

```json
{
  "reads": { "functions": ["TS.t", { "name": "TS.tx", "key": 1 }], "attribute": "data-ts" },
  "placeholders": "{name}",
  "keyStyle": "dotted",
  "generated": [{ "file": "js/strings.js", "format": "script", "name": "TS.copyTable" }]
}
```

| Setting | Meaning |
|---|---|
| `reads.functions` | The functions the site reads copy through, by written name (`t`, `TS.t`). An entry is a name, or `{ "name", "key" }` where `key` is the zero-based position of the argument that carries the key (default 0). A call to one is a read of its key, wherever it appears. |
| `reads.attribute` | The `data-*` attribute the site's elements carry a key in. stet reads it beside its own `data-stet`, and writes `data-stet`. |
| `placeholders` | `"{{name}}"` (the default) or `"{name}"`: the spelling the site's own table uses for a variable. stet stores `{{name}}`; a `{name}` site is converted once on import and once on generation. |
| `keyStyle` | `"underscore"` (the default) or `"dotted"`. |
| `generated` | The files stet writes from the snapshot; see below. |
| `statusPath` | Where the status file lives; `content/status.json` by default. Inside the checkout. |
| `scan.builders` | Hyperscript builders whose first argument is not a tag (`h(Card, …)`). |

## The import

```sh
npx stet import js/strings.js --write
```

`stet import <file>` brings in the copy table a project already keeps, from a JSON file or a JavaScript file. It prints the plan first and writes only with `--write`:

```
import: 3 keys from js/strings.js (TS.copyTable)
  new 3 · same 0 · differs 0 · skipped 0
  home.title  "Welcome to {{name}}"  vars: name
  status: 0 approved, 3 proposed
```

- A JavaScript file is evaluated in a context of its own with no `process`, `require`, `fetch` or stet module in reach, under a two-second ceiling. A file that imports another module is refused: import a module that stands alone.
- A file that exports several objects needs `--export NAME`. `--only PREFIX…` keeps the keys opening with a prefix, and `--section WORD` sets the section of the keys it creates.
- A row is a string, a `[value, meta]` pair or a `{ value }` object. A pair whose meta is `approved` records an approval; that needs a name, from git's `user.name` or `--by NAME`.
- A key the snapshot already holds with another value is a `differs` row. Nothing is written until `--replace` takes the file's values or `--only` leaves them out.
- The write is one batch: the descriptor, the snapshot, the generated outputs, the status file and the config's `keyStyle`.

`stet register` lists a JavaScript string it cannot rewrite as `<file>:<line>: "<text>" — read it through <function> by hand`.

## Generated outputs

Each entry of `generated` is a file stet writes from the committed snapshot, beside the snapshot, in every batch that writes it:

| Field | Meaning |
|---|---|
| `file` | The path, inside this checkout. |
| `format` | `script` (a classic script that binds `name` on `window`), `esm` (an export called `name`) or `json`. |
| `name` | The global or export. Required for `script` and `esm`; `TS.copyTable` makes `window.TS` if the page has not. |
| `values` | `value` (the default) writes `"key": "text"`; `value-status` writes `"key": ["text", "approved"]`. |
| `only` | Key names to keep: a name ending in `.` or `_` is a prefix; any other name is one exact key. Absent keeps every key. |

A `script` or `esm` output carries a header with a hash of everything it was generated from. `stet check` says `<file>: stale — its source moved; run stet pull` when an input moved, `<file>: hand-edited — run stet pull instead of editing` when the body changed, and `<file>: not generated — run stet pull` when the file is missing. A `json` output has no header: it is current, or `<file>: differs from the snapshot — run stet pull`.

## Two checkouts

A second checkout that only reads the copy keeps a four-line stet.config.json with copyFrom, and stet check there says when its generated strings file is behind.

```json
{
  "copyFrom": "../topshine",
  "generated": [{ "file": "src/strings.js", "format": "esm", "name": "copy" }]
}
```

`copyFrom` names the folder of the checkout that owns the copy. stet reads the descriptor, the snapshot and the status file from there. The owner holds a `stet.config.json` of its own and does not itself use `copyFrom`. `stet pull` in the second checkout refreshes its generated file. A command that would write the owner's copy (`import`, `approve`, `register`, `rename`, `remove`, `merge`, `split`) answers `this checkout reads its copy from <path>; run <command> there`. The dashboard shows the owner's copy with a note that it is edited there.

## The status file

A key is proposed until someone approves it, in the dashboard or with stet approve; a changed value is proposed again.

`stet approve <key>… [--by NAME]` records the approver and the day in the status file. The file is created by the first approval and from then on holds every declared key. A project that never approves never gains it. `stet list` shows each key's `status` column (`proposed` or `approved <date>`), and `stet check` reports an entry for an undeclared key, an approved entry with no date or approver, and a status file in a store-backed project: there, publishing is the approval and the file is removed.

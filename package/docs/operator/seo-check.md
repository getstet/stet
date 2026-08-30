# `stet seo check`

Eight SEO rules over your descriptor and your committed snapshot. It reads two
files and nothing else — no network, no database, no `--env` — so it runs on a
fork pull request, with every secret unset and nothing deployed.

It works because the registry already holds what the rules need: every page,
every content key, which page each key renders on, and the derivation template
behind a title. A crawler sees the rendered result; stet sees the source.

```bash
npx stet seo check
npx stet seo check --json     # the same findings, plus a structured block
```

## The rules

| Rule | Severity | What fails |
|---|---|---|
| `missing-description` | error | A declared page whose `seo` record names no description key, or whose description key resolves to nothing (an empty or whitespace-only value counts as nothing). |
| `over-length` | error | A resolved title over 60 characters, or a resolved description over 160. |
| `duplicate-title` | error | Two pages whose titles resolve to the same string in the same locale. |
| `canonical-noindex` | error | A page whose canonical resolves to the route of another declared page that carries `noindex`. |
| `visible-content` | error | A JSON-LD binding to a content key that does not declare that page among the pages it renders on. |
| `missing-alt` | error | A page that references an `ogImage` with no `ogImageAlt` that resolves. |
| `anchor-text` | warn | A web-targeted value that IS a generic link label — "click here", "learn more", "read more". |
| `machine-field` | warn | Imperative or incentive copy inside a value bound into JSON-LD — "buy now", "limited time", "#1". |

The values the rules read come from the same resolution path a page render uses:
derived values from their templates, then the committed snapshot. A title the
check measures is the title production serves.

Three of the rules are worth spelling out.

**`over-length` measures the resolved value, template included.** A headline
inside its own limit can still push its title over the bound once `{v} — Mirra`
is applied. That failure is invisible to any external tool, because no external
tool sees the template.

**`duplicate-title` blames the template where there is one.** When every page in
a colliding group derives its title through one identical template, the finding
names the template once and gives the page count. Forty pages sharing a broken
template is one thing to fix, and it is reported as one thing. A group whose
titles come from different places names the pages instead.

**`anchor-text` matches whole values only.** A value that *is* "Learn more" is a
link label; a sentence that happens to contain the phrase is prose. Searching
inside values would bury the warn in false positives, and there is no link-label
marker in the descriptor to narrow it with. The word lists ship inside the
package; pack-configurable lists arrive with packs.

## The exit contract

Exit 1 if any finding's severity is `error`, and 0 otherwise. **A warn never
moves the exit code** — it is reported, on every run, and it does not gate.

Exit 2 means the invocation was wrong: an unknown flag, `stet seo` with no
subcommand, or `--env`, which this command does not take because there is no
store to select.

`--json` emits one object. Each finding carries its rule id as `kind`, and a
`seo` block carries the findings whole — rule, severity, page, key, locale — so
a CI step filters on structure instead of parsing messages.

## The character bounds are an approximation

Google truncates a search result by **pixels**, not characters: roughly 600px for
a desktop title and 920px for a description. Sixty narrow characters can survive
where fifty wide ones do not. The 60/160 bounds are the phase-1 stand-in for that
measurement, chosen because a character count needs no font metrics and so keeps
the check offline. The font-metrics table that measures the real thing is a later
addition.

Treat an `over-length` finding as "this is at risk of truncation", not as a
precise verdict.

## Two gates, two moments

A key-level `limits` on an SEO key and this check are independent by design, and
they fire at different times.

```json
"seo_home_title": {
  "shape": "text",
  "limits": { "max": 60, "severity": "advisory" }
}
```

`limits` is the **save-time** gate: it judges one candidate value as it is
written, before it is stored, and an editor sees it while typing. `stet seo check`
is the **audit**: it judges the resolved whole, after the fact, including values
no one typed because a template produced them.

Neither implies the other. A key with no `limits` is still audited; a value that
passed its limit can still fail `over-length` once its template is applied.

## Overriding a severity

`stet.config.json` may flip any rule between `error` and `warn`:

```json
{
  "seoCheck": {
    "anchor-text": "error",
    "visible-content": "warn"
  }
}
```

There is no third state. A warn already never moves the exit code, so an "off"
would add configuration surface and change nothing. An id that is not a rule, or
a severity that is not `error` or `warn`, is a config error naming the block and
the id.

## It validates committed copy, not production

The check reads the committed snapshot. After a publish made directly against a
production store, that snapshot is behind production until you pull, and CI keeps
checking the older copy. A project that declares a store gets one warn saying so
on every run.

`stet pull --env prod` is the release-procedure step that closes the gap. Run it
after a prod-direct publish, and commit what it writes.

## In pre-commit

Add the command to the hook you already run:

```bash
npx stet seo check
```

Installing the hook is `stet init`'s job, not this command's — this is the line
that goes in it.

## In CI

A minimal GitHub Actions job. There is no service container, no database, and no
secret, which is what lets it run on a pull request from a fork:

```yaml
name: seo
on: pull_request

jobs:
  seo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx stet seo check
```

A packaged composite action that posts findings as pull-request comments is a
later addition. The snippet above is the supported form.

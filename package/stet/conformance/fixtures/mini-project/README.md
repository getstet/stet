# mini-project — the conformance fixture

Inert data, no code. Every section of `add-content-core` tests against it, and
later changes' adapters extend the walk in `../../conformance.test.ts` over the
same files.

| File | What it carries |
|---|---|
| `descriptor.json` | one key of every shape; an `enum` with `values`; a derived SEO key; two `pages` with JSON-LD bindings; three templates (a marketing one declaring `wrapperProvides`, a marketing one without it, a transactional one); a budgeted key; four `agentPublish: false` brand keys; two packs beyond `core` |
| `defaults.json` | a committed value for every non-derived key under `default`, plus one `de` value so the locale chain has something to find |
| `rows.json` | a superseded published row, the active published row, a draft row, and a malformed row (`brand__primary: "rebeccapurple"` — a named color, which the hex-only shape rejects) |
| `bundle.json` | the full-form read bundle: the resolved map plus version metadata. Its values equal `defaults.json`'s (a pulled-and-committed bundle — §13.1's `bundle ≡ defaults.json`), with the derived key materialized, so the two bundle forms are provably interchangeable |

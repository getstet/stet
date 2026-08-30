# ts-host — the fixture host

A stand-in for an adopter's repo, modeling what `stet init` scaffolds: a
`content/keys.ts` registry beside the ambient `content/stet-env.d.ts` (the
product's `config.codegen.dts` name), consumed by `ok.ts`/`bad.ts` from the
`stet` package. The ambient file is written by the compile tests through
`installRegistryDts`, so what `tsc` checks is what codegen emits today.

The tsconfigs use an **include glob** (`content`), not a `files:` list, on
purpose: a `files:` list force-includes the ambient and hides the field bug that
`X.d.ts` collides with `X.ts` and is dropped from an include-globbed program.
With `keys.ts` present, an ambient named `keys.d.ts` would be dropped here too —
so the product must use a distinct stem, and this fixture proves a typo'd key
errors only when it does (P1-2).

#!/usr/bin/env python3
"""Proof that a non-JavaScript build can consume stet's committed artifacts.

Standard library only, no Node runtime, no stet package: this is the Social Hook
case — an `mkdocs build` in a Python CI job reading committed content — and the
reason `defaults.json` is canonical and `defaults.ts` is codegen.

Every read here goes through `python/stet_read.py`, the shipped helper. This
file holds ZERO resolution logic of its own: one implementation per language
surface is the whole point, and the earlier inline copy of the derivation chain
was a second one waiting to drift.

Three assertions over the mini-project fixture:

1. completeness — every non-derived descriptor key has a value in the
   snapshot's default locale, so a build never renders nothing;
2. the two bundle forms, stated honestly — the full form resolves every
   descriptor key; the bare form (a snapshot-only host's committed
   `defaults.json`) resolves every NON-derived key to the same value and
   raises `KeyError` for the derived one. That absence is CORRECT, not a gap:
   the snapshot stores only non-derived keys by design, and a consumer needing
   derived keys reads a `stet pull` full-form bundle. The full form's equality
   with TypeScript resolution is asserted on the TS side, in the conformance
   walk's "The committed bundle is the build-time contract";
3. the locale chain — a checked-in tiny bundle resolves a `de` read of a
   default-only key to the default value, and reads its version metadata.

Exits 0 when all three hold, 1 otherwise.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "conformance" / "fixtures" / "mini-project"

sys.path.insert(0, str(ROOT / "python"))

from stet_read import load, lookup, version  # noqa: E402 — the path is set above


def main():
    with open(FIXTURE / "descriptor.json", encoding="utf-8") as handle:
        keys = json.load(handle)["keys"]
    full = load(FIXTURE / "bundle.json")
    bare = load(FIXTURE / "defaults.json")
    failures = []

    # 1. Completeness. A derived key has no committed value by design.
    derived = sorted(key for key, definition in keys.items() if "derivesFrom" in definition)
    for key in sorted(keys):
        if key in derived:
            continue
        try:
            lookup(bare, key)
        except KeyError:
            failures.append("%s: no value in defaults.json under the default locale" % key)

    # 2. The two forms.
    for key in sorted(keys):
        try:
            from_full = lookup(full, key)
        except KeyError:
            failures.append("%s: resolves to nothing from the full-form bundle" % key)
            continue

        if key in derived:
            try:
                lookup(bare, key)
                failures.append(
                    "%s: the bare form carries a derived key — the snapshot stores "
                    "only non-derived keys" % key
                )
            except KeyError:
                pass  # the designed absence, asserted rather than skipped
            continue

        try:
            from_bare = lookup(bare, key)
        except KeyError:
            continue  # already reported by the completeness pass
        if from_full != from_bare:
            failures.append(
                "%s: bundle forms disagree — full form %r, bare form %r"
                % (key, from_full, from_bare)
            )

    # 3. The locale chain, on a bundle small enough to read at a glance.
    tiny = load(Path(__file__).resolve().parent / "bundle.fixture.json")
    checks = [
        (lookup(tiny, "hero_headline", "de"), "Verpasse nie wieder einen Post.", "the de value"),
        (
            lookup(tiny, "hero_body", "de"),
            "Follow {{handle}} without leaving Telegram.",
            "de falls back to default",
        ),
        (version(tiny, "hero_headline"), 3, "version metadata"),
        (version(tiny, "hero_body"), None, "no version where the bundle carries none"),
    ]
    for got, want, what in checks:
        if got != want:
            failures.append("locale chain (%s): got %r, wanted %r" % (what, got, want))

    # 4. The helper's own hardening, each a defect that would be silent.
    poisoned = load(FIXTURE / "bundle.json")
    poisoned["values"]["default"]["hero_headline"] = "mutated by a consumer"
    if lookup(load(FIXTURE / "bundle.json"), "hero_headline") == "mutated by a consumer":
        failures.append("the cache hands out a shared reference — one consumer's edit rewrites every reader's")

    tiny_path = Path(__file__).resolve().parent / "bundle.fixture.json"
    with open(tiny_path, encoding="utf-8") as handle:
        raw = handle.read()
    bom = tiny_path.parent / ".bom.tmp.json"
    bom.write_text("\ufeff" + raw, encoding="utf-8")
    try:
        if lookup(load(bom), "hero_headline") != "Never miss a post again.":
            failures.append("a byte-order mark defeats the reader")
    except Exception as error:  # noqa: BLE001 — any failure here is the failure
        failures.append("a byte-order mark defeats the reader: %r" % error)
    finally:
        bom.unlink(missing_ok=True)

    if version({"values": {"default": {}}, "meta": {"default": {"k": {"version": True}}}}, "k") is not None:
        failures.append("a JSON true reads as version 1 — bool is a subclass of int")

    if failures:
        print("check_snapshot: %d failure(s)" % len(failures))
        for failure in failures:
            print("  - %s" % failure)
        return 1

    print(
        "check_snapshot: %d keys through python/stet_read.py — the full form resolves every "
        "key, the bare form every non-derived key, and %d derived key(s) are correctly absent "
        "from it, with no JavaScript runtime" % (len(keys), len(derived))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

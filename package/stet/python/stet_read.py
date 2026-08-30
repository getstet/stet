"""Read a stet bundle from Python. Standard library only.

The non-JS floor (plan §13.1): a language-neutral contract — the resolved
key→value map plus version metadata — that any runtime can read with no
JavaScript, no store client and no stet install. Social Hook's `mkdocs build`
is the first consumer; copy this file anywhere.

Two forms, both accepted, exactly as the TypeScript reader accepts them:

    full   {"values": {locale: {key: value}}, "meta": {locale: {key: {"version": n}}}}
    bare   {locale: {key: value}}

The bare form IS the committed ``defaults.json`` of a snapshot-only project —
that file is the bundle, with no separate artifact to fetch. Detection is on a
top-level ``values`` key, mirroring ``readBundle``: a bare map whose first
locale happened to be named ``values`` is not a case that exists, but a
key-keyed map (``{key: value}``, no locale layer) would parse silently as one
locale named after a key, so pass a locale→key map and nothing else.

**The bare form carries no derived keys, by design.** The committed snapshot
stores only non-derived keys — a derived key's value is computed from another
key's, and a stored copy would be a second truth for the same sentence. A
consumer that needs derived keys reads a ``stet pull`` full-form bundle, where
every declared key is materialized.

Resolution here is the locale chain and nothing else: requested locale, then
``default``. No derivation, no store, no draft state.
"""

import copy
import json
import urllib.request

__all__ = ["load", "lookup", "version", "clear_cache"]

DEFAULT_TIMEOUT = 10.0

_CACHE = {}


def load(path_or_url, refresh=False, timeout=DEFAULT_TIMEOUT):
    """The bundle at a file path or an ``http(s)://`` URL, normalized and cached.

    The cache is keyed by source, so a build that reads forty keys opens the
    file once. Pass ``refresh=True`` to re-read.

    ``timeout`` bounds a URL read (seconds). Without it ``urlopen`` inherits the
    process default — which is no timeout at all — and one unreachable host
    hangs a build until someone kills it.

    The returned bundle is a DEEP COPY of the cached one. Callers mutate what
    they are handed; a shared reference would let one consumer's edit rewrite
    every later reader's view of the same file, with nothing to trace it to.
    """
    source = str(path_or_url)
    if refresh or source not in _CACHE:
        _CACHE[source] = _normalize(_read(source, timeout))
    return copy.deepcopy(_CACHE[source])


def clear_cache():
    """Forget every cached bundle. For tests and long-lived processes."""
    _CACHE.clear()


def lookup(bundle, key, locale="default"):
    """The value of ``key``, walking the locale chain: ``locale`` then ``default``.

    Raises ``KeyError`` naming the key when neither locale carries it — which
    is the correct answer for a derived key read out of a bare-form bundle.
    """
    values = _normalize(bundle)["values"]
    for candidate in _chain(locale):
        block = values.get(candidate)
        if isinstance(block, dict) and key in block:
            return block[key]
    raise KeyError(
        "%s: no value in locale %r or 'default' — the bundle does not carry this key "
        "(a derived key is absent from the bare form by design)" % (key, locale)
    )


def version(bundle, key, locale="default"):
    """The stored version behind a key, or ``None`` where the bundle has no meta.

    A bare-form bundle never has one: a snapshot-only project has no versions,
    which is why the field is absent rather than zero.
    """
    meta = _normalize(bundle).get("meta") or {}
    for candidate in _chain(locale):
        entry = meta.get(candidate, {}).get(key)
        if not isinstance(entry, dict):
            continue
        found = entry.get("version")
        # `bool` is a subclass of `int` in Python, so a JSON `true` would
        # otherwise pass the type check and be returned as version 1.
        if isinstance(found, int) and not isinstance(found, bool):
            return found
    return None


def _chain(locale):
    return ["default"] if locale == "default" else [locale, "default"]


def _read(source, timeout=DEFAULT_TIMEOUT):
    # `utf-8-sig` on both paths: a BOM is invisible in an editor and makes
    # `json.loads` fail with a message that names neither the file nor the BOM.
    if source.startswith("http://") or source.startswith("https://"):
        with urllib.request.urlopen(source, timeout=timeout) as response:  # noqa: S310 — the caller's own URL
            return json.loads(response.read().decode("utf-8-sig"))
    with open(source, encoding="utf-8-sig") as handle:
        return json.load(handle)


def _normalize(raw):
    """Either form in, the full form out. The wrapper is detected by ``values``."""
    if not isinstance(raw, dict):
        raise ValueError("a bundle must be a JSON object")
    if "values" in raw:
        values = raw["values"]
        if not isinstance(values, dict):
            raise ValueError('bundle "values" must be an object keyed by locale')
        meta = raw.get("meta")
        return {"values": values, "meta": meta if isinstance(meta, dict) else None}
    return {"values": raw, "meta": None}

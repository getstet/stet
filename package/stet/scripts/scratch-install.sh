#!/usr/bin/env bash
#
# The install proofs the in-repo suite structurally cannot make.
#
# Two defects are invisible from inside the workspace, because the workspace
# has `pg` installed and runs the CLI as a path rather than as a bin:
#
#   1. a static import chain to `store-pg` crashes EVERY command — `check`
#      included — on the default install, where the optional `pg` peer is
#      absent (`ERR_MODULE_NOT_FOUND` at module load);
#   2. npm installs a bin as a SYMLINK, and Node reports the symlink in
#      `process.argv[1]` while `import.meta.url` is already resolved — so an
#      un-realpath'd entry guard is false for every real install, and the
#      command prints nothing and exits 0.
#
# This packs the package, installs the tarball into a throwaway host with no
# `pg`, and asserts the behaviour end to end. Run from anywhere:
#
#   package/stet/scripts/scratch-install.sh
#
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/stet-scratch.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok — $*"; }

echo "packing $PACKAGE_DIR"
( cd "$PACKAGE_DIR" && npm run build >/dev/null )
TARBALL="$( cd "$PACKAGE_DIR" && npm pack --pack-destination "$SCRATCH" 2>/dev/null | tail -1 )"

HOST="$SCRATCH/host"
mkdir -p "$HOST/content"
cp "$PACKAGE_DIR/conformance/fixtures/mini-project/descriptor.json" "$HOST/content/"
cp "$PACKAGE_DIR/conformance/fixtures/mini-project/defaults.json" "$HOST/content/"
cat > "$HOST/package.json" <<'JSON'
{ "name": "stet-scratch-host", "version": "1.0.0", "type": "module", "private": true }
JSON

cd "$HOST"
echo "installing $TARBALL into a host with no pg"
npm install "$SCRATCH/$TARBALL" >/dev/null 2>&1
[ -d node_modules/pg ] && fail "this host has pg installed; the proof needs one without it"
ok "pg is absent — this is the default install"

echo "the bin, through npm's symlink"
[ -L node_modules/.bin/stet ] || fail "node_modules/.bin/stet is not a symlink; the guard proof is void"
./node_modules/.bin/stet --help | grep -q '^stet — typed' || fail "the symlinked bin printed nothing"
ok "./node_modules/.bin/stet --help"
npx stet --help | grep -q '^stet — typed' || fail "npx stet printed nothing"
ok "npx stet --help"
node node_modules/@getstet/stet/dist/cli/main.js --help | grep -q '^stet — typed' || fail "the direct invocation printed nothing"
ok "node …/dist/cli/main.js --help"

echo "every command runs with no database driver present"
for command in check list doctor; do
  ./node_modules/.bin/stet "$command" >/dev/null || fail "stet $command failed on the default install"
  ok "stet $command"
done

echo "a configured pg store fails with an actionable message, not a module error"
echo '{ "store": { "adapter": "pg" } }' > stet.config.json
OUTPUT="$(STET_DATABASE_URL=postgresql://localhost:5432/none ./node_modules/.bin/stet list 2>&1 || true)"
case "$OUTPUT" in
  *ERR_MODULE_NOT_FOUND*) fail "the missing peer surfaced as a module-resolution error: $OUTPUT" ;;
  *"needs the optional peer dependency"*) ok "names the missing peer and how to fix it" ;;
  *) fail "unexpected output: $OUTPUT" ;;
esac

# And `check` is unmoved by any of it: it never constructs an adapter.
STET_DATABASE_URL=postgresql://localhost:5432/none ./node_modules/.bin/stet check >/dev/null \
  || fail "stet check dialed something"
ok "stet check with a pg store configured and no driver"

echo "the react-free server accessor, on a host with no react"
[ -d node_modules/react ] && fail "this host has react installed; the react-free proof is void"
cat > react-server-probe.mjs <<'JS'
import { readFileSync } from 'node:fs';

import { createServerCopy } from '@getstet/stet/react/server';
import { readBundle, resolveAll } from '@getstet/stet';

const descriptor = JSON.parse(readFileSync('content/descriptor.json', 'utf8'));
const bundle = readBundle(JSON.parse(readFileSync('content/defaults.json', 'utf8')));
const { resolved } = resolveAll(descriptor, bundle);
const copy = createServerCopy(descriptor, resolved);
process.stdout.write(copy('hero_headline'));
JS
PROBE="$(node react-server-probe.mjs)" || fail "@getstet/stet/react/server did not load on a react-less host"
[ -n "$PROBE" ] || fail "createServerCopy resolved nothing"
ok "import { createServerCopy } from '@getstet/stet/react/server' — resolved and called"

# The contrast that makes the subpath load-bearing: `@getstet/stet/react`'s index
# re-exports the provider, which imports the optional react peer.
sed 's|@getstet/stet/react/server|@getstet/stet/react|' react-server-probe.mjs > react-index-probe.mjs
if node react-index-probe.mjs >/dev/null 2>&1; then
  fail "@getstet/stet/react loaded without react installed — the subpath proves nothing"
fi
ok "@getstet/stet/react itself does not load there — the subpath is the react-free door"

echo "PASS — the packed tarball installs and runs on a host with no pg"

#!/bin/sh
# Walks the three flows on one device with Maestro and keeps the screenshots.
#   sh maestro/walk.sh <device id or udid/serial> <out dir>
set -e
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$2"
for flow in first-run returning settings; do
  maestro --device "$1" test --test-output-dir "$2/$flow" "$here/$flow.yaml"
done

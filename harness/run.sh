#!/usr/bin/env bash
# Build + capture the Provider Usage component harness.
# Usage: ./harness/run.sh [--plugin <path>] [--width W] [--fixture name]
set -euo pipefail
cd "$(dirname "$0")/.."
PLUGIN=""
for a in "$@"; do case "$a" in --plugin|--width|--fixture) ;; -*) ;; esac; done

# Pass through args to build & capture.
build_args=()
capture_args=()
prev=""
for a in "$@"; do
  if [ "$a" = "--plugin" ]; then prev="plugin"
  elif [ "$prev" = "plugin" ]; then build_args+=( "--plugin" "$a" ); prev=""
  elif [ "$a" = "--width" ] || [ "$a" = "--fixture" ]; then capture_args+=( "$a" ); prev=""
  elif [ "$prev" != "" ]; then capture_args+=( "$a" ); prev=""
  fi
done

echo "== build =="
node harness/build.mjs "${build_args[@]}"
echo "== capture =="
node harness/capture.mjs "${capture_args[@]}"
echo "== verify =="
node harness/verify.mjs "${capture_args[@]}"
echo "Done. Screenshots: harness/dist/shots/*.png"
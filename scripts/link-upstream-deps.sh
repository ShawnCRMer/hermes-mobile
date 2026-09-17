#!/usr/bin/env bash
# Symlink React/router/store packages from upstream's node_modules so
# TypeScript resolves a single copy of each type definition.
# Called by npm postinstall after both mobile and upstream deps are installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
NM="$ROOT/node_modules"
UNM="$ROOT/upstream/node_modules"

if [ ! -d "$UNM/react" ]; then
  echo "⚠️  upstream/node_modules not found — run npm ci in upstream/ first."
  exit 0
fi

link() {
  local pkg="$1"
  local from="$NM/$pkg"
  local to="$UNM/$pkg"

  if [ ! -d "$to" ]; then
    echo "  skip $pkg (not in upstream)"
    return
  fi

  rm -rf "$from"
  mkdir -p "$(dirname "$from")"
  ln -s "$(python3 -c "import os; print(os.path.relpath('$to', os.path.dirname('$from')))")" "$from"
  echo "  linked $pkg"
}

echo "=== Linking upstream deps ==="
link react
link react-dom
link react-router
link nanostores
link "@types/react"
link "@types/react-dom"
link "@tanstack/react-query"
link "@nanostores/react"
echo "=== Done ==="

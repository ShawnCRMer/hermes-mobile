#!/usr/bin/env bash
# Fetch BeeWare's Python-Apple-support xcframework for iOS.
# Usage: scripts/fetch-python-framework.sh [version] [build]
# Default: Python 3.13 b15 (the version ADR-002 probed against)
set -euo pipefail

PYTHON_VERSION="${1:-3.13}"
BUILD="${2:-15}"
TAG="Python-${PYTHON_VERSION}-iOS-support.b${BUILD}"
URL="https://github.com/beeware/Python-Apple-support/releases/download/${PYTHON_VERSION}-b${BUILD}/${TAG}.tar.gz"
CHECKSUM_URL="${URL}.sha256"

DEST_DIR="$(cd "$(dirname "$0")/../ios/App/Frameworks" && pwd -P)"
CACHE_DIR="$(cd "$(dirname "$0")/.." && pwd -P)/.cache/python-framework"

mkdir -p "$CACHE_DIR" "$DEST_DIR"

TARBALL="$CACHE_DIR/${TAG}.tar.gz"

if [ -d "$DEST_DIR/Python.xcframework" ]; then
    echo "Python.xcframework already present at $DEST_DIR"
    echo "Delete it first to re-fetch."
    exit 0
fi

echo "Downloading $TAG..."
if [ ! -f "$TARBALL" ]; then
    curl -fSL --progress-bar -o "$TARBALL" "$URL"
fi

echo "Verifying checksum..."
if curl -fsSL "$CHECKSUM_URL" -o "$TARBALL.sha256" 2>/dev/null; then
    EXPECTED=$(awk '{print $1}' "$TARBALL.sha256")
    ACTUAL=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "ERROR: SHA-256 mismatch"
        echo "  Expected: $EXPECTED"
        echo "  Actual:   $ACTUAL"
        rm -f "$TARBALL"
        exit 1
    fi
    echo "Checksum OK."
else
    echo "Warning: could not fetch checksum file; skipping verification."
fi

echo "Extracting to $DEST_DIR..."
tar xzf "$TARBALL" -C "$DEST_DIR"

if [ -d "$DEST_DIR/Python.xcframework" ]; then
    echo "Done. Python.xcframework installed."
else
    echo "ERROR: Python.xcframework not found after extraction."
    echo "Contents of $DEST_DIR:"
    ls -la "$DEST_DIR"
    exit 1
fi

echo ""
echo "Framework slices:"
ls -d "$DEST_DIR/Python.xcframework/"*/
echo ""
echo "Next: run scripts/build-python-layer.sh to package stdlib + deps."

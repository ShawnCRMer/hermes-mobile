#!/usr/bin/env bash
# Cross-build the three native packages that lack iOS wheels.
# Requires: Rust toolchain, maturin >= 1.8, cibuildwheel >= 3.0.
# Produces wheels in .cache/ios-wheels/ for both device and simulator.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WHEEL_DIR="$PROJECT_ROOT/.cache/ios-wheels"
mkdir -p "$WHEEL_DIR"

# Pinned versions from upstream uv.lock
PYDANTIC_CORE_VERSION="2.46.4"
JITER_VERSION="0.16.0"
CRYPTOGRAPHY_VERSION="50.0.0"

echo "=== iOS Wheel Builder ==="
echo "Output: $WHEEL_DIR"
echo ""

# Ensure Rust iOS targets
echo "Checking Rust iOS targets..."
rustup target add aarch64-apple-ios 2>/dev/null || true
rustup target add aarch64-apple-ios-sim 2>/dev/null || true

check_tool() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: $1 not found. Install it first."
        echo "  pip install $1"
        exit 1
    fi
}

check_tool maturin

build_wheel() {
    local pkg="$1"
    local version="$2"
    local target="$3"
    local platform_tag="$4"

    local wheel_glob="$WHEEL_DIR/${pkg//-/_}-${version}-*${platform_tag}*.whl"
    if compgen -G "$wheel_glob" >/dev/null 2>&1; then
        echo "  [cached] $pkg $version for $platform_tag"
        return 0
    fi

    echo "  Building $pkg $version for $target ($platform_tag)..."

    local src_dir="$PROJECT_ROOT/.cache/wheel-src/$pkg-$version"
    if [ ! -d "$src_dir" ]; then
        mkdir -p "$PROJECT_ROOT/.cache/wheel-src"
        pip download --no-binary=:all: --no-deps "$pkg==$version" \
            -d "$PROJECT_ROOT/.cache/wheel-src/"
        local sdist
        sdist=$(ls "$PROJECT_ROOT/.cache/wheel-src/$pkg-$version"* 2>/dev/null | head -1)
        if [ -z "$sdist" ]; then
            sdist=$(ls "$PROJECT_ROOT/.cache/wheel-src/${pkg//-/_}-$version"* 2>/dev/null | head -1)
        fi
        if [ -z "$sdist" ]; then
            echo "    ERROR: Could not download sdist for $pkg"
            return 1
        fi
        mkdir -p "$src_dir"
        tar xf "$sdist" -C "$src_dir" --strip-components=1 2>/dev/null || \
            unzip -q "$sdist" -d "$src_dir" 2>/dev/null || true
    fi

    (
        cd "$src_dir"
        maturin build --release \
            --target "$target" \
            --interpreter python3.13 \
            --out "$WHEEL_DIR" \
            2>&1 | tail -5
    )
    echo "    Done."
}

echo ""
echo "--- pydantic-core $PYDANTIC_CORE_VERSION ---"
build_wheel "pydantic-core" "$PYDANTIC_CORE_VERSION" "aarch64-apple-ios" "ios_13_0_arm64_iphoneos"
build_wheel "pydantic-core" "$PYDANTIC_CORE_VERSION" "aarch64-apple-ios-sim" "ios_13_0_arm64_iphonesimulator"

echo ""
echo "--- jiter $JITER_VERSION ---"
build_wheel "jiter" "$JITER_VERSION" "aarch64-apple-ios" "ios_13_0_arm64_iphoneos"
build_wheel "jiter" "$JITER_VERSION" "aarch64-apple-ios-sim" "ios_13_0_arm64_iphonesimulator"

echo ""
echo "--- cryptography $CRYPTOGRAPHY_VERSION ---"
build_wheel "cryptography" "$CRYPTOGRAPHY_VERSION" "aarch64-apple-ios" "ios_13_0_arm64_iphoneos"
build_wheel "cryptography" "$CRYPTOGRAPHY_VERSION" "aarch64-apple-ios-sim" "ios_13_0_arm64_iphonesimulator"

echo ""
echo "=== Wheels built ==="
ls -lh "$WHEEL_DIR"/*.whl 2>/dev/null || echo "(no wheels found — check errors above)"

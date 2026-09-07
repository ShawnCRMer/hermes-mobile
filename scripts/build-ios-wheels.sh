#!/usr/bin/env bash
# Cross-build the three native packages that lack iOS wheels.
# Requires: Rust toolchain with iOS targets, maturin >= 1.8.
# Produces wheels in .cache/ios-wheels/ for both device and simulator.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WHEEL_DIR="$PROJECT_ROOT/.cache/ios-wheels"
SRC_DIR="$PROJECT_ROOT/.cache/wheel-src"
FRAMEWORK_DIR="$PROJECT_ROOT/ios/App/Frameworks/Python.xcframework"
mkdir -p "$WHEEL_DIR" "$SRC_DIR"

# Pinned versions from upstream uv.lock
PYDANTIC_CORE_VERSION="2.46.4"
JITER_VERSION="0.16.0"
# cryptography omitted — only used by Bitwarden secrets + Weixin adapter, not on iOS path

echo "=== iOS Wheel Builder ==="
echo "Output: $WHEEL_DIR"
echo ""

# Ensure Rust iOS targets
echo "Checking Rust iOS targets..."
rustup target add aarch64-apple-ios 2>/dev/null || true
rustup target add aarch64-apple-ios-sim 2>/dev/null || true

# Find maturin
if command -v maturin &>/dev/null; then
    MATURIN="maturin"
elif python3 -m maturin --version &>/dev/null; then
    MATURIN="python3 -m maturin"
else
    echo "ERROR: maturin not found. Install: pip3 install --user maturin"
    exit 1
fi
echo "Using maturin: $($MATURIN --version)"

# Verify Python.xcframework exists (needed for cross-compilation headers)
if [ ! -d "$FRAMEWORK_DIR" ]; then
    echo "ERROR: Python.xcframework not found. Run scripts/fetch-python-framework.sh first."
    exit 1
fi

# PyO3 cross-compilation config
export PYO3_CROSS_PYTHON_VERSION="3.13"
export PYO3_CROSS="1"

download_sdist() {
    local pkg="$1"
    local version="$2"
    local pkg_under="${pkg//-/_}"
    local dest="$SRC_DIR/$pkg-$version"

    if [ -d "$dest" ] && [ -f "$dest/Cargo.toml" -o -f "$dest/pyproject.toml" ]; then
        echo "  [cached source] $pkg $version"
        return 0
    fi

    echo "  Downloading $pkg $version sdist from PyPI..."

    # Get download URL from PyPI JSON API
    local json
    json=$(curl -sL "https://pypi.org/pypi/$pkg/$version/json")

    local url
    url=$(echo "$json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for u in data['urls']:
    if u['packagetype'] == 'sdist':
        print(u['url'])
        break
" 2>/dev/null)

    if [ -z "$url" ]; then
        echo "    ERROR: Could not find sdist URL for $pkg $version"
        return 1
    fi

    local tarball="$SRC_DIR/$pkg-$version.tar.gz"
    curl -sL "$url" -o "$tarball"
    mkdir -p "$dest"
    tar xf "$tarball" -C "$dest" --strip-components=1
    rm "$tarball"
    echo "  Downloaded."
}

build_wheel() {
    local pkg="$1"
    local version="$2"
    local target="$3"
    local platform_tag="$4"

    local pkg_under="${pkg//-/_}"
    local wheel_glob="$WHEEL_DIR/${pkg_under}-${version}-*${platform_tag}*.whl"
    if compgen -G "$wheel_glob" >/dev/null 2>&1; then
        echo "  [cached] $pkg $version for $platform_tag"
        return 0
    fi

    echo "  Building $pkg $version for $target..."
    local src_dir="$SRC_DIR/$pkg-$version"

    # Point PyO3 at the right framework slice for headers/lib
    case "$target" in
        aarch64-apple-ios)
            local slice_dir="$FRAMEWORK_DIR/ios-arm64"
            ;;
        aarch64-apple-ios-sim)
            local slice_dir="$FRAMEWORK_DIR/ios-arm64_x86_64-simulator"
            ;;
    esac

    if [ -d "$slice_dir/Python.framework" ]; then
        export PYO3_CROSS_LIB_DIR="$slice_dir/Python.framework"
    fi

    # Set PyO3 config file for the target (avoids interpreter platform mismatch)
    case "$target" in
        aarch64-apple-ios)
            export PYO3_CONFIG_FILE="$PROJECT_ROOT/.cache/pyo3-ios-device.txt"
            ;;
        aarch64-apple-ios-sim)
            export PYO3_CONFIG_FILE="$PROJECT_ROOT/.cache/pyo3-ios-sim.txt"
            ;;
    esac

    # Point _PYTHON_SYSCONFIGDATA_NAME at the iOS sysconfig module
    local sysconfigdata_dir
    case "$target" in
        aarch64-apple-ios)
            sysconfigdata_dir="$FRAMEWORK_DIR/ios-arm64/lib-arm64/python3.13"
            export _PYTHON_SYSCONFIGDATA_NAME="_sysconfigdata__ios_arm64-iphoneos"
            ;;
        aarch64-apple-ios-sim)
            sysconfigdata_dir="$FRAMEWORK_DIR/ios-arm64_x86_64-simulator/lib-arm64/python3.13"
            export _PYTHON_SYSCONFIGDATA_NAME="_sysconfigdata__ios_arm64-iphonesimulator"
            ;;
    esac

    (
        cd "$src_dir"
        # Cross-compile: no --interpreter (causes platform mismatch).
        # PyO3 reads PYO3_CONFIG_FILE for ABI info.
        # -undefined dynamic_lookup: Python symbols resolved at runtime by the embedded interpreter.
        PYTHONPATH="$sysconfigdata_dir" \
        RUSTFLAGS="-C link-arg=-undefined -C link-arg=dynamic_lookup" \
        $MATURIN build --release \
            --target "$target" \
            --out "$WHEEL_DIR" \
            2>&1
    )

    if compgen -G "$wheel_glob" >/dev/null 2>&1; then
        echo "    OK: $(ls $wheel_glob | xargs -n1 basename)"
    else
        # maturin may use a different platform tag — check what was produced
        local any_wheel="$WHEEL_DIR/${pkg_under}-${version}-*.whl"
        if compgen -G "$any_wheel" >/dev/null 2>&1; then
            echo "    Built (check platform tag): $(ls $any_wheel | xargs -n1 basename)"
        else
            echo "    FAILED: no wheel produced"
            return 1
        fi
    fi
}

# Download all sdists first (fast, parallel-friendly)
echo "--- Downloading sources ---"
download_sdist "pydantic-core" "$PYDANTIC_CORE_VERSION"
download_sdist "jiter" "$JITER_VERSION"
# cryptography omitted (see requirements.ios.txt)

# Build for device and simulator
echo ""
echo "--- pydantic-core $PYDANTIC_CORE_VERSION ---"
build_wheel "pydantic-core" "$PYDANTIC_CORE_VERSION" "aarch64-apple-ios" "ios_13_0_arm64_iphoneos"
build_wheel "pydantic-core" "$PYDANTIC_CORE_VERSION" "aarch64-apple-ios-sim" "ios_13_0_arm64_iphonesimulator"

echo ""
echo "--- jiter $JITER_VERSION ---"
build_wheel "jiter" "$JITER_VERSION" "aarch64-apple-ios" "ios_13_0_arm64_iphoneos"
build_wheel "jiter" "$JITER_VERSION" "aarch64-apple-ios-sim" "ios_13_0_arm64_iphonesimulator"

echo ""
echo "=== Wheels built ==="
ls -lh "$WHEEL_DIR"/*.whl 2>/dev/null || echo "(no wheels found — check errors above)"

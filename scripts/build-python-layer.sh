#!/usr/bin/env bash
# Package the Python layer for the iOS bundle.
# Produces ios/App/python/ with stdlib, app_packages, and hermes tree.
# Requires: Python.xcframework already fetched, iOS wheels built.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

PYTHON_DIR="$PROJECT_ROOT/ios/App/python"
FRAMEWORK_DIR="$PROJECT_ROOT/ios/App/Frameworks/Python.xcframework"
UPSTREAM_DIR="$PROJECT_ROOT/upstream"
WHEEL_DIR="$PROJECT_ROOT/.cache/ios-wheels"
BEEWARE_INDEX="https://pypi.anaconda.org/beeware/simple"

# Choose platform: device or simulator
PLATFORM="${1:-simulator}"
case "$PLATFORM" in
    device)
        PLATFORM_TAG="ios_13_0_arm64_iphoneos"
        STDLIB_ARCH_DIR="lib-arm64"
        ;;
    simulator)
        PLATFORM_TAG="ios_13_0_arm64_iphonesimulator"
        STDLIB_ARCH_DIR="lib-arm64"
        ;;
    *)
        echo "Usage: $0 [device|simulator]"
        exit 1
        ;;
esac

echo "=== Building Python layer for $PLATFORM ==="

# Verify prerequisites
if [ ! -d "$FRAMEWORK_DIR" ]; then
    echo "ERROR: Python.xcframework not found. Run scripts/fetch-python-framework.sh first."
    exit 1
fi

if [ ! -d "$UPSTREAM_DIR/hermes_cli" ]; then
    echo "ERROR: upstream submodule not initialized. Run: git submodule update --init"
    exit 1
fi

# Clean and create structure
rm -rf "$PYTHON_DIR"
mkdir -p "$PYTHON_DIR/stdlib" "$PYTHON_DIR/app_packages" "$PYTHON_DIR/hermes"

# ── 1. stdlib ──────────────────────────────────────────────────────────────
echo ""
echo "--- Copying stdlib ---"

# The shared stdlib lives in lib/python3.13/ (common to all slices)
STDLIB_SRC="$FRAMEWORK_DIR/lib/python3.13"
if [ ! -d "$STDLIB_SRC" ]; then
    echo "ERROR: Cannot find stdlib at $STDLIB_SRC"
    exit 1
fi

rsync -a --exclude='test/' --exclude='tests/' --exclude='__pycache__/' \
    --exclude='*.pyc' --exclude='idle_test/' --exclude='tkinter/' \
    --exclude='turtle*' --exclude='turtledemo/' \
    "$STDLIB_SRC/" "$PYTHON_DIR/stdlib/"

# Arch-specific modules (_sysconfigdata, lib-dynload) are in the platform slice
SLICE_DIR=$(find "$FRAMEWORK_DIR" -maxdepth 1 -name "*$PLATFORM*" -type d | head -1)
if [ -z "$SLICE_DIR" ]; then
    echo "Warning: No platform-specific slice found for $PLATFORM."
    SLICE_DIR=$(find "$FRAMEWORK_DIR" -maxdepth 1 -type d -name "ios-*" | head -1)
fi

if [ -d "$SLICE_DIR/$STDLIB_ARCH_DIR/python3.13" ]; then
    rsync -a --exclude='__pycache__/' \
        "$SLICE_DIR/$STDLIB_ARCH_DIR/python3.13/" "$PYTHON_DIR/stdlib/"
    echo "  Copied arch-specific modules from $STDLIB_ARCH_DIR"
fi

echo "  stdlib: $(du -sh "$PYTHON_DIR/stdlib" | cut -f1)"

# ── 2. app_packages (pip install) ──────────────────────────────────────────
echo ""
echo "--- Installing app_packages ---"

# Step 1: Install pure-Python packages (py3-none-any wheels) — no platform filter
python3.13 -m pip install \
    --no-deps \
    --target "$PYTHON_DIR/app_packages" \
    --break-system-packages \
    -r "$PROJECT_ROOT/python/requirements.ios.txt" \
    2>&1 | grep -v "already satisfied" || true

# Step 2: Overwrite native packages with our cross-compiled iOS wheels
# (pip rejects iOS-tagged wheels on macOS, so unzip directly)
for whl in "$WHEEL_DIR"/*"$PLATFORM_TAG"*.whl; do
    [ -f "$whl" ] || continue
    echo "  Unpacking iOS wheel: $(basename "$whl")"
    unzip -qo "$whl" -d "$PYTHON_DIR/app_packages" -x "*.dist-info/*"
done

# Step 3: Pure-Python fallbacks for packages that have C extensions on macOS
# (markupsafe, pyyaml, charset-normalizer — their pure-Python fallbacks work on iOS)
for pkg in markupsafe charset-normalizer; do
    # Remove the macOS .so if pip installed one
    find "$PYTHON_DIR/app_packages" -path "*/${pkg//-/_}*" -name "*.so" -delete 2>/dev/null || true
    find "$PYTHON_DIR/app_packages" -path "*/${pkg//-/_}*" -name "*.dylib" -delete 2>/dev/null || true
done

echo "  app_packages: $(du -sh "$PYTHON_DIR/app_packages" | cut -f1)"

# ── 3. hermes tree (pruned from upstream) ──────────────────────────────────
echo ""
echo "--- Copying Hermes Python tree ---"

# Allowlist of directories to copy
HERMES_DIRS=(
    hermes_cli
    agent
    tools
    gateway
    plugins
    providers
    tui_gateway
    cron
    hermes
    skills
)

for dir in "${HERMES_DIRS[@]}"; do
    if [ -d "$UPSTREAM_DIR/$dir" ]; then
        rsync -a --exclude='__pycache__/' --exclude='*.pyc' \
            --exclude='node_modules/' --exclude='tests/' --exclude='test/' \
            "$UPSTREAM_DIR/$dir" "$PYTHON_DIR/hermes/"
    fi
done

# Copy root Python files needed by imports
for f in hermes_constants.py hermes_bootstrap.py run_agent.py utils.py \
         toolsets.py toolset_distributions.py registration_lifecycle.py \
         trajectory_compressor.py setup.py; do
    if [ -f "$UPSTREAM_DIR/$f" ]; then
        cp "$UPSTREAM_DIR/$f" "$PYTHON_DIR/hermes/"
    fi
done

# Copy the mobile boot module into the hermes tree
cp "$PROJECT_ROOT/python/hermes_mobile_boot.py" "$PYTHON_DIR/hermes/"

# Prune messaging adapters (gateway/platforms/)
rm -rf "$PYTHON_DIR/hermes/gateway/platforms" 2>/dev/null || true

echo "  hermes: $(du -sh "$PYTHON_DIR/hermes" | cut -f1)"

# ── 4. Precompile .pyc ────────────────────────────────────────────────────
echo ""
echo "--- Precompiling .pyc ---"

# Use Python 3.13 for precompilation (3.9 can't parse match/type params)
COMPILE_PY="${COMPILE_PY:-$(command -v python3.13 2>/dev/null || echo python3)}"
$COMPILE_PY -m compileall -q --invalidation-mode unchecked-hash \
    "$PYTHON_DIR/stdlib" "$PYTHON_DIR/app_packages" "$PYTHON_DIR/hermes" \
    2>/dev/null || true

# Strip .py from stdlib only where .pyc exists (keep hermes .py for tracebacks)
find "$PYTHON_DIR/stdlib" -name '*.py' | while read -r pyfile; do
    pyc="${pyfile%.*}.pyc"
    pycache_dir="$(dirname "$pyfile")/__pycache__"
    base="$(basename "$pyfile" .py)"
    if [ -f "$pyc" ] || compgen -G "$pycache_dir/${base}.cpython-*.pyc" >/dev/null 2>&1; then
        rm "$pyfile"
    fi
done

echo "  After compile: stdlib=$(du -sh "$PYTHON_DIR/stdlib" | cut -f1), " \
     "app_packages=$(du -sh "$PYTHON_DIR/app_packages" | cut -f1), " \
     "hermes=$(du -sh "$PYTHON_DIR/hermes" | cut -f1)"

# ── 5. .so → .fwork rewrite (required for iOS code signing) ───────────────
echo ""
echo "--- Rewriting .so → .fwork for iOS signing ---"

FWORK_COUNT=0
find "$PYTHON_DIR" -name "*.so" -type f | while read -r so_file; do
    rel_path="${so_file#$PYTHON_DIR/}"
    dotted_name=$(echo "$rel_path" | sed 's|/|.|g; s|\.so$||')
    fwork_dir="$PROJECT_ROOT/ios/App/Frameworks/$dotted_name"
    mkdir -p "$fwork_dir"
    mv "$so_file" "$fwork_dir/$dotted_name.so"

    # Write .fwork marker (CPython follows this on iOS)
    echo "Frameworks/$dotted_name/$dotted_name.so" > "$so_file.fwork"

    # Write .origin marker (reverse pointer)
    echo "../../../python/$rel_path" > "$fwork_dir/$dotted_name.so.origin"

    FWORK_COUNT=$((FWORK_COUNT + 1))
done
echo "  Rewrote $FWORK_COUNT .so files to .fwork."

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "=== Python layer built ==="
echo "  Total: $(du -sh "$PYTHON_DIR" | cut -f1)"
echo "  stdlib:       $(du -sh "$PYTHON_DIR/stdlib" | cut -f1)"
echo "  app_packages: $(du -sh "$PYTHON_DIR/app_packages" | cut -f1)"
echo "  hermes:       $(du -sh "$PYTHON_DIR/hermes" | cut -f1)"
echo ""
echo "Add ios/App/python/ and ios/App/Frameworks/*.so directories to the Xcode project."

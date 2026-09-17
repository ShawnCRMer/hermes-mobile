#!/usr/bin/env bash
# Package the Python layer for the iOS bundle.
# Produces ios/App/python/ with stdlib, app_packages, and hermes tree.
# Requires: Python.xcframework already fetched, iOS wheels built.
#
# The layer is PLATFORM-NEUTRAL: it serves device and simulator builds alike.
#   - stdlib/ carries the pure-Python standard library only. The binary
#     modules (lib-dynload) differ per platform and are copied out of the
#     matching Python.xcframework slice at Xcode build time by
#     scripts/xcode-prepare-python-modules.sh.
#   - app_packages/ carries BOTH the iphoneos and iphonesimulator builds of
#     each native wheel side by side (CPython only ever looks for the suffix
#     matching the running platform); the build phase deletes the other one.
#   - No .so → .fwork rewriting happens here any more. That, plus framework
#     packaging and code signing, is done inside the built .app by the build
#     phase, because signing needs the build's identity and the destination
#     platform is only known then.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

PYTHON_DIR="$PROJECT_ROOT/ios/App/python"
FRAMEWORK_DIR="$PROJECT_ROOT/ios/App/Frameworks/Python.xcframework"
UPSTREAM_DIR="$PROJECT_ROOT/upstream"
WHEEL_DIR="$PROJECT_ROOT/.cache/ios-wheels"
PY_VER="python3.13"

if [ $# -gt 0 ]; then
    echo "Note: the platform argument is no longer used — the layer now serves device and simulator." >&2
fi

echo "=== Building platform-neutral Python layer ==="

# Verify prerequisites
if [ ! -d "$FRAMEWORK_DIR" ]; then
    echo "ERROR: Python.xcframework not found. Run scripts/fetch-python-framework.sh first."
    exit 1
fi

if [ ! -d "$UPSTREAM_DIR/hermes_cli" ]; then
    echo "ERROR: upstream submodule not initialized. Run: git submodule update --init"
    exit 1
fi

if ! ls "$WHEEL_DIR"/*iphoneos*.whl >/dev/null 2>&1 || ! ls "$WHEEL_DIR"/*iphonesimulator*.whl >/dev/null 2>&1; then
    echo "ERROR: iOS wheels missing in $WHEEL_DIR (need both iphoneos and iphonesimulator). Run scripts/build-ios-wheels.sh."
    exit 1
fi

# Stale artifacts from the previous (build-time-relocating) layout.
find "$PROJECT_ROOT/ios/App/Frameworks" -maxdepth 1 -type d \
    \( -name 'stdlib.*' -o -name 'app_packages.*' \) -exec rm -rf {} + 2>/dev/null || true

# Clean and create structure
rm -rf "$PYTHON_DIR"
mkdir -p "$PYTHON_DIR/stdlib" "$PYTHON_DIR/app_packages" "$PYTHON_DIR/hermes"

# ── 1. stdlib (pure Python, shared by all slices) ─────────────────────────
echo ""
echo "--- Copying stdlib ---"

STDLIB_SRC="$FRAMEWORK_DIR/lib/$PY_VER"
if [ ! -d "$STDLIB_SRC" ]; then
    echo "ERROR: Cannot find stdlib at $STDLIB_SRC"
    exit 1
fi

rsync -a --exclude='test/' --exclude='tests/' --exclude='__pycache__/' \
    --exclude='*.pyc' --exclude='idle_test/' --exclude='tkinter/' \
    --exclude='turtle*' --exclude='turtledemo/' --exclude='lib-dynload/' \
    "$STDLIB_SRC/" "$PYTHON_DIR/stdlib/"

# Ship every slice's sysconfig data module so `sysconfig` resolves on both
# platforms; lib-dynload itself is copied per platform at build time.
for slice in "$FRAMEWORK_DIR"/ios-*; do
    for archlib in "$slice"/lib-*/"$PY_VER"; do
        [ -d "$archlib" ] || continue
        for sc in "$archlib"/_sysconfigdata__*.py; do
            [ -f "$sc" ] && cp "$sc" "$PYTHON_DIR/stdlib/"
        done
    done
done

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

# Step 2: Overlay our cross-compiled iOS wheels for BOTH platforms. Their
# extension modules carry distinct suffixes (…-iphoneos.so / …-iphonesimulator.so)
# so they coexist; pure-Python files are identical between the two.
# (pip rejects iOS-tagged wheels on macOS, so unzip directly.)
for whl in "$WHEEL_DIR"/*.whl; do
    [ -f "$whl" ] || continue
    echo "  Unpacking iOS wheel: $(basename "$whl")"
    unzip -qo "$whl" -d "$PYTHON_DIR/app_packages" -x "*.dist-info/*"
done

# Step 3: Purge every macOS binary pip pulled in for the host (pydantic-core,
# jiter, ruamel.yaml.clib, markupsafe, charset-normalizer, …). Packages with
# pure-Python fallbacks keep working; the rest are replaced by the iOS wheels.
find "$PYTHON_DIR/app_packages" \( -name "*-darwin.so" -o -name "*.dylib" \) -delete 2>/dev/null || true
# Belt and braces: anything that is not an iOS-tagged extension is foreign.
find "$PYTHON_DIR/app_packages" -name "*.so" ! -name "*-iphoneos.so" ! -name "*-iphonesimulator.so" -delete 2>/dev/null || true

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
for f in run_agent.py utils.py toolsets.py toolset_distributions.py \
         registration_lifecycle.py trajectory_compressor.py setup.py; do
    if [ -f "$UPSTREAM_DIR/$f" ]; then
        cp "$UPSTREAM_DIR/$f" "$PYTHON_DIR/hermes/"
    fi
done

# All top-level hermes_*.py modules (constants, state, logging, time, watchdog, etc.)
for f in "$UPSTREAM_DIR"/hermes_*.py; do
    [ -f "$f" ] && cp "$f" "$PYTHON_DIR/hermes/"
done

# Copy the mobile boot module and default config into the hermes tree
cp "$PROJECT_ROOT/python/hermes_mobile_boot.py" "$PYTHON_DIR/hermes/"
cp "$PROJECT_ROOT/python/ios_config.yaml" "$PYTHON_DIR/hermes/"

# Prune messaging adapters (gateway/platforms/)
rm -rf "$PYTHON_DIR/hermes/gateway/platforms" 2>/dev/null || true

echo "  hermes: $(du -sh "$PYTHON_DIR/hermes" | cut -f1)"

# ── 4. Precompile .pyc ────────────────────────────────────────────────────
echo ""
echo "--- Precompiling .pyc ---"

# Use Python 3.13 for precompilation (3.9 can't parse match/type params)
COMPILE_PY="${COMPILE_PY:-$(command -v python3.13 2>/dev/null || echo python3)}"

# app_packages and hermes keep their .py (tracebacks) with normal
# __pycache__/*.cpython-313.pyc caches alongside.
$COMPILE_PY -m compileall -q --invalidation-mode unchecked-hash \
    "$PYTHON_DIR/app_packages" "$PYTHON_DIR/hermes" \
    2>/dev/null || true

# The stdlib ships source-less. CPython only consults __pycache__/ when the
# .py source exists; a module whose source is gone must be a legacy
# `module.pyc` in the SAME directory (SourcelessFileLoader). compileall -b
# writes exactly that. Stripping .py while leaving __pycache__ behind makes
# the whole stdlib un-importable — Py_Initialize dies with
# "init_fs_encoding: failed to get the Python codec of the filesystem encoding".
$COMPILE_PY -m compileall -q -b --invalidation-mode unchecked-hash \
    "$PYTHON_DIR/stdlib" 2>/dev/null || true

find "$PYTHON_DIR/stdlib" -name '*.py' | while read -r pyfile; do
    if [ -f "${pyfile%.py}.pyc" ]; then
        rm "$pyfile"
    fi
done
find "$PYTHON_DIR/stdlib" -type d -name '__pycache__' -prune -exec rm -rf {} +

echo "  After compile: stdlib=$(du -sh "$PYTHON_DIR/stdlib" | cut -f1), " \
     "app_packages=$(du -sh "$PYTHON_DIR/app_packages" | cut -f1), " \
     "hermes=$(du -sh "$PYTHON_DIR/hermes" | cut -f1)"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "=== Python layer built ==="
echo "  Total: $(du -sh "$PYTHON_DIR" | cut -f1)"
echo "  stdlib:       $(du -sh "$PYTHON_DIR/stdlib" | cut -f1)   (no lib-dynload — added per platform at build time)"
echo "  app_packages: $(du -sh "$PYTHON_DIR/app_packages" | cut -f1)   (device: $(find "$PYTHON_DIR/app_packages" -name '*-iphoneos.so' | wc -l | tr -d ' ') .so, simulator: $(find "$PYTHON_DIR/app_packages" -name '*-iphonesimulator.so' | wc -l | tr -d ' ') .so)"
echo "  hermes:       $(du -sh "$PYTHON_DIR/hermes" | cut -f1)"
echo ""
echo "ios/App/python/ is referenced by the Xcode project as a folder resource;"
echo "the 'Prepare Python Binary Modules' build phase finishes the job per platform."

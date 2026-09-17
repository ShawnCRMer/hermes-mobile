#!/bin/sh
# Xcode "Run Script" build phase: Prepare Python Binary Modules.
#
# Runs AFTER "Copy Bundle Resources" has copied ios/App/python/ into the
# .app and turns the Python extension modules into code-signable frameworks,
# following the scheme documented in CPython's "Using Python on iOS"
# (Doc/using/ios.rst) and its iOSTestbed project:
#
#   1. Copy the platform-correct stdlib binaries (lib-dynload) out of the
#      matching Python.xcframework slice — iphoneos for device builds,
#      iphonesimulator for simulator builds. The committed python/ layer does
#      NOT carry lib-dynload precisely so that one layer serves both.
#   2. Delete any app_packages extension modules built for the OTHER
#      platform (the layer ships both tags side by side).
#   3. Move every remaining <name>.cpython-313-<tag>.so into
#      Frameworks/<dotted.name>.framework/<dotted.name> with an Info.plist,
#      and leave a <name>.cpython-313-<tag>.fwork stub in its place (the .so
#      suffix is REPLACED by .fwork, exactly as CPython's iOSTestbed does) whose
#      content is the framework binary path relative to the bundle root.
#      CPython's iOS loader follows .fwork stubs when importing.
#   4. Sign each generated framework with the build's signing identity.
#
# iOS refuses to dlopen Mach-O binaries that live under Resources (unsigned
# by Xcode's resource copy), which is why step 3 is required at all.
#
# Every step is idempotent so incremental builds are safe.
set -eu

: "${CODESIGNING_FOLDER_PATH:?must run as an Xcode build phase}"
: "${PROJECT_DIR:?must run as an Xcode build phase}"

PYTHON_DIR="$CODESIGNING_FOLDER_PATH/python"
XCFRAMEWORK="$PROJECT_DIR/Frameworks/Python.xcframework"
PY_VER="python3.13"

if [ ! -d "$PYTHON_DIR" ]; then
    echo "warning: $PYTHON_DIR missing — run scripts/build-python-layer.sh first; skipping Python module prep"
    exit 0
fi

if [ "${EFFECTIVE_PLATFORM_NAME:-}" = "-iphonesimulator" ]; then
    SLICE="ios-arm64_x86_64-simulator"
    TAG="iphonesimulator"
else
    SLICE="ios-arm64"
    TAG="iphoneos"
fi

# First architecture of the build (the simulator slice has lib-arm64 and lib-x86_64).
ARCH="${ARCHS%% *}"
[ -n "$ARCH" ] || ARCH="arm64"
SLICE_LIB="$XCFRAMEWORK/$SLICE/lib-$ARCH/$PY_VER"
if [ ! -d "$SLICE_LIB" ]; then
    SLICE_LIB="$XCFRAMEWORK/$SLICE/lib-arm64/$PY_VER"
fi

echo "Preparing Python binary modules for $TAG ($ARCH) from $SLICE"

# ── 1. platform stdlib binaries ──────────────────────────────────────────
if [ -d "$SLICE_LIB/lib-dynload" ]; then
    mkdir -p "$PYTHON_DIR/stdlib/lib-dynload"
    # Only re-copy .so files that are not already represented by a .fwork
    # stub from an earlier build (keeps incremental builds fast).
    for so in "$SLICE_LIB"/lib-dynload/*.so; do
        base=$(basename "$so")
        if [ ! -f "$PYTHON_DIR/stdlib/lib-dynload/${base%.so}.fwork" ]; then
            cp "$so" "$PYTHON_DIR/stdlib/lib-dynload/$base"
        fi
    done
    # The platform sysconfig data module lives next to lib-dynload in the slice.
    for sc in "$SLICE_LIB"/_sysconfigdata__*.py; do
        [ -f "$sc" ] && cp "$sc" "$PYTHON_DIR/stdlib/"
    done
else
    echo "error: no lib-dynload at $SLICE_LIB — run scripts/fetch-python-framework.sh"
    exit 1
fi

# Stubs left over from a previous build for the OTHER platform (e.g. after
# switching device <-> simulator without a clean) must go, or Python could
# pick the wrong tag when both are present.
find "$PYTHON_DIR" -name "*.cpython-313-*.fwork" ! -name "*-$TAG.fwork" -delete
# Mis-named stubs from the earlier layer format (".so.fwork") are never loaded.
find "$PYTHON_DIR" -name "*.so.fwork" -delete

# ── 2. drop extension modules for the other platform ─────────────────────
find "$PYTHON_DIR" -name "*.cpython-313-*.so" ! -name "*-$TAG.so" -delete
# Anything macOS-tagged that slipped in from the host pip run.
find "$PYTHON_DIR" \( -name "*-darwin.so" -o -name "*.dylib" \) -delete

# ── 3. relocate .so → Frameworks/<dotted>.framework ──────────────────────
FRAMEWORKS_DIR="$CODESIGNING_FOLDER_PATH/Frameworks"
mkdir -p "$FRAMEWORKS_DIR"
CREATED_LIST=$(mktemp -t hermes-py-frameworks)

install_dylib() {
    FULL_EXT="$1"
    # Path relative to python/  e.g. stdlib/lib-dynload/_socket.cpython-313-iphoneos.so
    REL_EXT="${FULL_EXT#$PYTHON_DIR/}"
    # Dotted module identity: strip everything from the first '.' of the
    # filename, then '/' → '.'  e.g. stdlib.lib-dynload._socket
    DOTTED=$(printf '%s' "$REL_EXT" | sed 's|\.cpython-313-[a-z]*\.so$||; s|\.so$||' | tr '/' '.')
    FW_DIR="$FRAMEWORKS_DIR/$DOTTED.framework"
    # Bundle IDs may not contain '_'.
    FW_ID=$(printf '%s.%s' "${PRODUCT_BUNDLE_IDENTIFIER:-com.mobilehermes.app}" "$DOTTED" | tr '_' '-')

    mkdir -p "$FW_DIR"
    cat > "$FW_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>$DOTTED</string>
	<key>CFBundleIdentifier</key><string>$FW_ID</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>$DOTTED</string>
	<key>CFBundlePackageType</key><string>FMWK</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleSupportedPlatforms</key><array><string>${TAG_PLATFORM:-iPhoneOS}</string></array>
	<key>CFBundleVersion</key><string>1</string>
	<key>MinimumOSVersion</key><string>${IPHONEOS_DEPLOYMENT_TARGET:-13.0}</string>
</dict>
</plist>
PLIST

    mv "$FULL_EXT" "$FW_DIR/$DOTTED"
    # CPython follows this stub: path relative to the app bundle root. The
    # stub REPLACES the .so suffix (foo.cpython-313-iphoneos.fwork); the
    # importer's suffix table lists ".<SOABI>.fwork", so ".so.fwork" is ignored.
    printf 'Frameworks/%s.framework/%s\n' "$DOTTED" "$DOTTED" > "${FULL_EXT%.so}.fwork"
    # Back-reference (mirrors CPython's testbed; handy when debugging).
    printf '%s.fwork\n' "${REL_EXT%.so}" > "$FW_DIR/$DOTTED.origin"
    printf '%s\n' "$FW_DIR" >> "$CREATED_LIST"
}

if [ "$TAG" = "iphonesimulator" ]; then
    TAG_PLATFORM="iPhoneSimulator"
else
    TAG_PLATFORM="iPhoneOS"
fi

find "$PYTHON_DIR" -name "*.so" -type f | while read -r FULL_EXT; do
    install_dylib "$FULL_EXT"
done

COUNT=$(wc -l < "$CREATED_LIST" | tr -d ' ')
echo "Relocated $COUNT extension modules into $FRAMEWORKS_DIR"

# Incremental builds: Xcode only re-copies the python/ folder resource when
# it changed, so a framework produced by an earlier run may exist while its
# stub was removed above (other-platform sweep after a device<->simulator
# switch in a shared product, or the legacy ".so.fwork" naming). Recreate
# any missing stub for THIS platform from the framework's .origin
# back-reference, and drop frameworks that belong to the other platform.
for origin in "$FRAMEWORKS_DIR"/stdlib.*.framework/*.origin "$FRAMEWORKS_DIR"/app_packages.*.framework/*.origin; do
    [ -f "$origin" ] || continue
    fw_dir=$(dirname "$origin")
    dotted=$(basename "$fw_dir" .framework)
    stub_rel=$(head -n 1 "$origin" | tr -d '\r\n')
    stub_rel="${stub_rel%.so.fwork}"
    stub_rel="${stub_rel%.fwork}.fwork"
    case "$stub_rel" in
        *-"$TAG".fwork)
            if [ ! -f "$PYTHON_DIR/$stub_rel" ] && [ -f "$fw_dir/$dotted" ]; then
                mkdir -p "$(dirname "$PYTHON_DIR/$stub_rel")"
                printf 'Frameworks/%s.framework/%s\n' "$dotted" "$dotted" > "$PYTHON_DIR/$stub_rel"
                printf '%s\n' "$stub_rel" > "$origin"
                echo "Restored stub $stub_rel"
            fi
            ;;
        *.cpython-313-*.fwork)
            echo "Removing other-platform framework $dotted"
            rm -rf "$fw_dir"
            ;;
    esac
done

# ── 4. sign ───────────────────────────────────────────────────────────────
if [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ] && [ "${CODE_SIGNING_ALLOWED:-YES}" != "NO" ]; then
    echo "Signing Python frameworks as ${EXPANDED_CODE_SIGN_IDENTITY_NAME:-$EXPANDED_CODE_SIGN_IDENTITY}"
    # Sign every framework the layer produced (not just this build's new ones):
    # an incremental build may have re-copied a binary into an existing bundle.
    for fw in "$FRAMEWORKS_DIR"/stdlib.*.framework "$FRAMEWORKS_DIR"/app_packages.*.framework; do
        [ -d "$fw" ] || continue
        # shellcheck disable=SC2086
        /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" ${OTHER_CODE_SIGN_FLAGS:-} \
            -o runtime --timestamp=none \
            --preserve-metadata=identifier,entitlements,flags --generate-entitlement-der \
            "$fw"
    done
else
    echo "Code signing disabled — leaving Python frameworks unsigned"
fi

rm -f "$CREATED_LIST"

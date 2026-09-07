#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_SHA="${1:-}"

echo "==> Fetching upstream..."
git -C upstream fetch origin

if [ -z "$TARGET_SHA" ]; then
  TARGET_SHA="$(git -C upstream rev-parse origin/main)"
fi

CURRENT_SHA="$(git -C upstream rev-parse HEAD)"
if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
  echo "Already at $TARGET_SHA — nothing to do."
  exit 0
fi

SHORT_OLD="${CURRENT_SHA:0:10}"
SHORT_NEW="${TARGET_SHA:0:10}"
echo "==> Bumping upstream: $SHORT_OLD → $SHORT_NEW"

# Save pre-bump manifest for diffing
cp src/bridge/manifest.json /tmp/hermes-mobile-manifest-old.json

git -C upstream checkout "$TARGET_SHA"

echo "==> Installing upstream dependencies..."
(cd upstream && npm ci --workspace apps/desktop --workspace apps/shared)

echo "==> Updating manifest SHA..."
node -e "
const fs = require('fs');
const p = 'src/bridge/manifest.json';
const m = JSON.parse(fs.readFileSync(p, 'utf8'));
m.upstreamSha = '$TARGET_SHA';
fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
"

echo "==> Running typecheck..."
npx tsc --noEmit

echo "==> Running build..."
npm run build

echo "==> Running tests..."
npm test

echo "==> Running bridge scan..."
if ! npm run scan-bridge-usage; then
  echo ""
  echo "!! Bridge scan found gaps — new methods need impl/stub/omit entries."
  exit 1
fi

echo "==> Diffing bridge manifest..."
if diff -u /tmp/hermes-mobile-manifest-old.json src/bridge/manifest.json; then
  echo "   (no manifest changes)"
else
  echo ""
  echo "   Manifest changed — review the diff above."
fi

rm -f /tmp/hermes-mobile-manifest-old.json

echo ""
echo "✓ Bump to $SHORT_NEW succeeded. Stage and commit when ready:"
echo "  git add upstream src/bridge/manifest.json"
echo "  git commit -m 'bump upstream to $SHORT_NEW'"

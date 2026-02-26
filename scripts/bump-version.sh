#!/bin/bash
# Bump version across all files from a single source (Cargo.toml)
#
# Usage:
#   ./scripts/bump-version.sh 0.7.0    # Set specific version
#   ./scripts/bump-version.sh           # Sync current Cargo.toml version to other files

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${1:-}" ]; then
  NEW_VERSION="$1"
  # Update Cargo.toml first
  sed -i '' "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$ROOT/Cargo.toml"
  echo "Cargo.toml -> $NEW_VERSION"
else
  # Read version from Cargo.toml
  NEW_VERSION=$(grep '^version = ' "$ROOT/Cargo.toml" | head -1 | sed 's/version = "\(.*\)"/\1/')
  echo "Syncing version $NEW_VERSION from Cargo.toml"
fi

# Tauri configs
for f in "$ROOT/tauri.conf.json" "$ROOT/src-tauri/tauri.conf.json"; do
  if [ -f "$f" ]; then
    sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$f"
    echo "$(basename "$(dirname "$f")")/$(basename "$f") -> $NEW_VERSION"
  fi
done

# docs/index.html - matches patterns like "v0.6.1" and "Grove v0.6.1"
sed -i '' "s/v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/v$NEW_VERSION/g" "$ROOT/docs/index.html"
echo "docs/index.html -> v$NEW_VERSION"

echo "Done."

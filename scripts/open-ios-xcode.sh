#!/usr/bin/env bash
# Tauri's options server must remain alive while Xcode builds the app.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export PATH="$DEVELOPER_DIR/usr/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
xcodebuild -checkFirstLaunchStatus
pnpm --dir grove-ios install --frozen-lockfile
make web-build
cd grove-ios
if [[ ! -d gen/apple ]]; then
  pnpm exec tauri ios init --ci
fi
python3 ../scripts/prepare-ios-xcode.py
echo "Keep this command running while using Xcode. Select your physical iPhone to test on the phone."
# Grove serves its embedded UI itself; it does not need a Vite dev server.
exec pnpm exec tauri ios dev --open --no-dev-server --no-watch --host 127.0.0.1

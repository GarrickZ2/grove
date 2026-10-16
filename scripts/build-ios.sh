#!/usr/bin/env bash
# Build a device IPA for local re-signing; never imports signing credentials.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "iOS builds require macOS and Xcode." >&2
  exit 1
fi
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [[ ! -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  echo "Install Xcode or set DEVELOPER_DIR to its Contents/Developer directory." >&2
  exit 1
fi
# cargo-mobile2 rebuilds the archive subprocess environment and drops
# DEVELOPER_DIR. PATH survives, so select Xcode's real executable rather than
# /usr/bin/xcodebuild (the shim follows the global xcode-select setting).
export PATH="$DEVELOPER_DIR/usr/bin:$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin:$PATH"
if ! xcodebuild -checkFirstLaunchStatus; then
  echo "Open Xcode, review its license and complete first-launch setup, then retry make ios-ipa." >&2
  exit 1
fi
for tool in pnpm cargo rustup xcodegen python3; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing build tool: $tool" >&2
    exit 1
  fi
done

rustup target add aarch64-apple-ios
pnpm --dir grove-ios install --frozen-lockfile
make web-build

# A convenience default only. No passkey is baked into the app. Users can edit
# this address in the app if the computer changes networks.
if [[ -z "${GROVE_IOS_SERVER_URL:-}" ]]; then
  ios_interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  ios_address="$(ipconfig getifaddr "${ios_interface:-en0}" 2>/dev/null || true)"
  if [[ -n "$ios_address" ]]; then
    export GROVE_IOS_SERVER_URL="http://${ios_address}:3001"
  fi
fi
python3 - <<'PY'
import os
from urllib.parse import urlsplit
value = os.environ.get('GROVE_IOS_SERVER_URL', '')
if value:
    url = urlsplit(value)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username
        or url.password or url.query or url.fragment or url.path not in ('', '/')):
        raise SystemExit('GROVE_IOS_SERVER_URL must be a server origin without credentials, path, query or fragment.')
    print('Pre-filled server:', value)
PY

# Tauri forwards TAURI_* variables to Xcode's Rust build phase; arbitrary
# GROVE_* variables do not survive that subprocess boundary.
export TAURI_GROVE_IOS_SERVER_URL="${GROVE_IOS_SERVER_URL:-}"

cd grove-ios
if [[ ! -d gen/apple ]]; then
  pnpm exec tauri ios init --ci
fi
python3 ../scripts/prepare-ios-xcode.py
# Refresh native icons even when the Xcode project already exists.
pnpm exec tauri icon ../src-tauri/icons/icon.png --output build/icons --ios-color '#111111'
python3 - <<'ICONS'
from pathlib import Path
import json
import shutil
source = Path('build/icons/ios')
catalog = Path('gen/apple/Assets.xcassets/AppIcon.appiconset')
for image in json.loads((catalog / 'Contents.json').read_text())['images']:
    filename = image.get('filename')
    if filename:
        icon = source / filename
        if not icon.is_file():
            raise SystemExit(f'Missing generated iOS icon: {icon}')
        shutil.copy2(icon, catalog / filename)
ICONS
pnpm exec tauri ios build --target aarch64 --no-sign --archive-only --ci

# The user's installation tool supplies signing/provisioning. Do not run
# Xcode's signed IPA export or include a developer account in this artifact.
python3 - <<'PY'
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

archives = list(Path('gen/apple').glob('**/*.xcarchive/Products/Applications/*.app'))
if len(archives) != 1:
    raise SystemExit(f'Expected one device app archive, found {len(archives)}; inspect gen/apple/build.')
app = archives[0]
with (app / 'Info.plist').open('rb') as stream:
    info = plistlib.load(stream)
if info.get('DTPlatformName') != 'iphoneos':
    raise SystemExit('Refusing to package a simulator app as an IPA.')
if not (app / info['CFBundleExecutable']).is_file():
    raise SystemExit('App executable is missing.')
output = Path('build/Grove.ipa').resolve()
output.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='grove-ios-') as temporary:
    payload = Path(temporary) / 'Payload'
    payload.mkdir()
    shutil.copytree(app, payload / app.name, symlinks=True)
    subprocess.run(['ditto', '-c', '-k', '--keepParent', str(payload), str(output)], check=True)
print(f'IPA ready for re-signing: {output}')
subprocess.run(['shasum', '-a', '256', str(output)], check=True)
print('Next, from the Grove checkout: cargo run -- ios')
PY

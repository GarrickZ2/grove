# Grove iOS — local device test

This is a standalone Tauri mobile crate. It bundles `grove-web/dist` and runs
a loopback HTTP/WebSocket transport to a user-selected Grove Mobile server.
Git, terminal sessions and agents continue to run on the computer. There are
no desktop plugins, signing credentials or GitHub publishing steps here.

## Build an IPA

Requires macOS, complete Xcode first-launch setup (including the iOS SDK),
Rust, pnpm and XcodeGen. The pinned Tauri CLI is installed locally.

```sh
make ios-ipa
```

Output: `grove-ios/build/Grove.ipa`. This is an **unsigned device
build**, not directly installable until a sideloading tool signs it. The script
archives without signing and packages `Payload/*.app`, checking that the app
targets `iphoneos` rather than the simulator.

The script uses Xcode via `DEVELOPER_DIR`; it does not change the global
`xcode-select` setting or accept licenses. Generated Xcode files and build
artifacts are ignored. `tauri ios init` recreates them when missing.

The computer's primary interface address is pre-filled when available. Override
it with an origin only (never put a Secret Key in the build environment):

```sh
GROVE_IOS_SERVER_URL=http://192.168.1.10:3001 make ios-ipa
```

## Install and connect

Download the latest official release's IPA to your system Downloads directory:

```sh
grove device ios
# From source:
cargo run -- device ios
```

The file is saved as `Grove-<release-tag>.ipa`. The command checks the device
archive and release size, plus SHA256 when supplied by GitHub. It does not
replace an existing file with different contents. If the latest release has
no IPA attached, it reports that explicitly; it does not build from source.

Choose your own signing and installation tool. Grove does not detect, configure,
launch or integrate with third-party installers, and does not request Apple ID
credentials. Local developers can still use the IPA produced by `make ios-ipa`.

After installation, run `grove mobile` on your computer, open Grove on your
phone, and connect to that server. Use the server management screen to save,
add or switch servers.

For local Xcode testing, run `make ios-xcode` and keep that terminal running.
It prepares the frontend, configures tool paths for Xcode's GUI environment,
and opens Xcode with Tauri's required options server alive. Opening the generated
project alone is insufficient: the Rust build phase needs that server.
Select your own signing team and the physical phone (not a similarly named
simulator), then Run. Xcode installation does not require Sideloadly; a free
personal team may be used subject to Apple's limits.

## Current test-client boundaries

- Named server profiles are saved in `servers.json`; the old single address is
  offered as the initial address when migrating. Each profile owns an immutable
  loopback origin, isolating Web Storage, credentials, drafts and requests.
  Saved origins remain stable across app launches; if a port is unavailable,
  connection fails explicitly without assigning another profile's storage.
- The native profile file contains no credentials. Remembered sign-in uses the
  existing revocable device-key flow in each origin's WKWebView storage. The
  iOS sign-in screen defaults to remembering when supported; users can opt out.
  Remote logout/revocation clears only that server's credential. Proxy cookies
  are suppressed because cookies, unlike Web Storage, are not isolated by port.
- HTTP and WebSocket forwarding preserve authentication, query strings,
  streaming bodies and error status. TLS certificate validation stays enabled;
  self-signed Grove TLS is not silently trusted. Use LAN HTTP for the first test
  or a server with a valid HTTPS certificate.
- The local connection screen is protected by a per-process setup token and
  same-origin checks. Connected web content has no Tauri command capability.
- Browser UI is reused; desktop tray, global shortcuts and native drag/save
  dialogs are disabled. External browser handoff, native file sharing, Radio,
  push notifications and background operation are not acceptance criteria for
  this first device build.
- The desktop service must remain reachable. iOS may suspend the app; test
  foreground reconnection and transcript recovery on a real device.

The native background/active notifications now stop and recreate the loopback
listeners on their original ports. A local health check must pass before the
web client resumes signed requests and reattaches chats. This does not revoke
device credentials or restart remote Agents. Rebinding has bounded retries;
failures never select a different storage origin. The latest 80 transport
lifecycle entries (stages and local ports, no credentials) are available in the
app container at `Library/Caches/grove-transport-diagnostics.json` and in the
device console under `Grove transport`.

## Validation

```sh
make ios-test
make web-lint web-build
```

Device acceptance: install, allow LAN access, sign in, open a task, send a
message, receive streaming replies, background/foreground the app, and verify
keyboard layout and the Server link while the backend is unreachable.

The device display name is **Grove**. Each build regenerates the iOS icon catalog
from `src-tauri/icons/icon.png`; changing the icon in Sideloadly is unnecessary.

## Automatic Live Activity

On iOS 16.2+, authenticated task events feed one ActivityKit activity for the
current server. Running tasks are grouped by task rather than chat. Explicit
turn completion, failure, permission and form events drive the status; an idle
or disconnected socket is never interpreted as success. There is no app setting
or APNs dependency. iOS's system Live Activities permission still applies.

The WidgetKit extension is generated by `scripts/prepare-ios-xcode.py` from
`native/project.yml`; it must be embedded and signed together with the app.
Do not add the Swift files only to an ignored generated Xcode project.

The app uses the authenticated Radio WebSocket, reconnect snapshots, and
upstream WebSocket ping/pong liveness. Activity state expires after 90 seconds
without a confirmed update. Background suspension can stop updates; reopening
the app resynchronizes state. Successful batches end with a 30-second lock-screen
dismissal policy (Dynamic Island dismissal timing is controlled by iOS).
Only task names/counts/status and server name reach ActivityKit, not prompts,
responses, access tokens, or approval payloads. Native activity links reopen only
saved server origins and route to the task or task list after authentication.

Device acceptance (without attaching a debugger): start a real task, verify
compact/expanded island and lock-screen display, complete/fail/cancel it, test
multiple chats in one task, switch servers, lose/recover network, and tap an
activity from both warm and cold app starts. Build/tests alone do not establish
background runtime duration or visual acceptance.

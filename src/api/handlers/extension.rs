//! Chrome Extension integration handlers for Axum.
//! Enables dynamic page sniffing, multi-port discovery, and browser tab queries.

use axum::{
    body::Body,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use rust_embed::Embed;
use serde_json::json;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

use crate::api::error::ApiError;
use crate::api::handlers::folder::{pick_folder, response_for, BrowseFolderResponse};
use crate::api::state::{ExtensionSession, EXTENSION_SESSION};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

// ─── Companion extension package (download + Chrome launcher) ────────────────
//
// In release builds rust-embed bakes the contents of `grove-extension/dist`
// into the binary. In debug builds it reads from disk on each call, so a
// `pnpm --filter grove-extension run build` is enough to refresh without
// re-compiling Rust. The download endpoint zips the embedded files in-memory
// once, then caches the bytes in a `OnceLock`.
#[derive(Embed)]
#[folder = "grove-extension/dist"]
struct ExtensionAssets;

static EXTENSION_ZIP_CACHE: OnceLock<Vec<u8>> = OnceLock::new();

/// Filename every Chrome extension must ship. Its presence is what separates
/// a real companion build from an empty placeholder directory.
const MANIFEST_FILENAME: &str = "manifest.json";

/// Error surfaced when the companion was never built into this binary.
const ASSETS_MISSING: &str =
    "extension assets are not bundled in this build (build grove-extension first)";

/// True when `paths` contains the extension manifest at the top level.
///
/// `grove-extension/dist` is gitignored, so a checkout that has never run the
/// extension build can still hold a placeholder file such as `.gitkeep`, and
/// release builds bake whatever is in that directory into the binary. Merely
/// counting embedded files therefore reports success for an embed holding
/// nothing Chrome can load, so require the manifest itself.
fn manifest_present<I, S>(paths: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    paths.into_iter().any(|p| p.as_ref() == MANIFEST_FILENAME)
}

/// REST endpoint: GET /api/v1/extension/status
/// Lightweight probe — returns whether the Chrome companion extension is
/// currently connected over WebSocket. Pure read of EXTENSION_SESSION,
/// doesn't go through the WS bridge, so it's cheap enough to call on
/// page mount without polling.
pub async fn get_extension_status() -> Json<serde_json::Value> {
    let connected = match EXTENSION_SESSION.read() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => {
            // Lock poisoning means some writer panicked while holding the lock.
            // Don't silently report `connected=false` — surface it so the
            // underlying writer crash can be diagnosed. Then degrade gracefully.
            eprintln!(
                "[grove] WARN: EXTENSION_SESSION RwLock poisoned: {}",
                poisoned
            );
            false
        }
    };
    Json(json!({ "connected": connected }))
}

/// REST endpoint: GET /api/v1/extension/tabs
/// Fetches all active browser tabs in real-time from the connected extension.
pub async fn get_extension_tabs() -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    // 1. Retrieve the active extension session
    let session_tx = {
        let session_guard = EXTENSION_SESSION
            .read()
            .map_err(|_| ApiError::internal("Internal server lock error"))?;
        if let Some(session) = &*session_guard {
            session.sender.clone()
        } else {
            return Err(ApiError::bad_request(
                "Browser extension is offline or not connected",
            ));
        }
    };

    // 2. Generate a unique request ID and set up a oneshot channel for the response
    let req_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();

    {
        let session_guard = EXTENSION_SESSION
            .read()
            .map_err(|_| ApiError::internal("Internal server lock error"))?;
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                pending.insert(req_id.clone(), tx);
            }
        } else {
            return Err(ApiError::bad_request(
                "Browser extension disconnected during request",
            ));
        }
    }

    // 3. Send the request to the extension via WebSocket
    let request_payload = json!({
        "type": "GET_ALL_TABS",
        "id": req_id.clone()
    });

    if session_tx.send(request_payload).is_err() {
        // Clean up on send failure
        cleanup_request(&req_id);
        return Err(ApiError::internal(
            "Failed to send query to browser extension",
        ));
    }

    // 4. Await the response with a timeout (1.5 seconds)
    match tokio::time::timeout(Duration::from_millis(1500), rx).await {
        Ok(Ok(response_data)) => Ok(Json(response_data)),
        Ok(Err(_)) => Err(ApiError::internal(
            "Extension connection severed while awaiting response",
        )),
        Err(_) => {
            // Clean up on timeout
            cleanup_request(&req_id);
            Err(ApiError::internal("Query to browser extension timed out"))
        }
    }
}

/// Helper to clean up any orphaned oneshot channels from the pending list (e.g. on timeouts)
fn cleanup_request(req_id: &str) {
    if let Ok(session_guard) = EXTENSION_SESSION.read() {
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                pending.remove(req_id);
            }
        }
    }
}

/// WebSocket Upgrade handler: GET /api/v1/extension/ws
///
/// The endpoint is loopback-only (axum binds to 127.0.0.1) — same trust
/// model as the rest of Grove's local API.
pub async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_ws)
}

async fn handle_ws(socket: WebSocket) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<serde_json::Value>();

    // 1. Register the new session globally. Refuse if an extension is
    //    already connected — accepting a second connection would orphan
    //    the first one's `pending_requests` map and the previously-routed
    //    responses would arrive at a session that no longer knows about
    //    them.
    let session = ExtensionSession {
        sender: tx,
        pending_requests: std::sync::Mutex::new(HashMap::new()),
    };

    // Take the slot atomically. `std::sync::RwLockWriteGuard` is !Send, so the
    // guard must be dropped before any `.await` below — keep this block tight.
    // Recover from a poisoned lock rather than panicking (poisoning would
    // cascade across every subsequent WS upgrade attempt).
    let claimed = {
        let mut session_guard = match EXTENSION_SESSION.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if session_guard.is_some() {
            false
        } else {
            *session_guard = Some(session);
            true
        }
    };
    if !claimed {
        // Politely refuse the second connection with a clean Close frame so
        // the client surfaces a normal close handshake (1008 policy-violation)
        // instead of treating the drop as 1006.
        let _ = ws_sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1008,
                reason: "another extension instance is already connected".into(),
            })))
            .await;
        return;
    }

    // 2. Spawn a background task to forward outbound payloads to the WebSocket
    let mut ws_write_task = tokio::spawn(async move {
        while let Some(msg_val) = rx.recv().await {
            let text_frame = Message::Text(msg_val.to_string().into());
            if ws_sender.send(text_frame).await.is_err() {
                break;
            }
        }
    });

    // 3. Main loop to process inbound text messages from the extension
    let mut ws_read_task = tokio::spawn(async move {
        while let Some(Ok(message)) = ws_receiver.next().await {
            if let Ok(text) = message.to_text() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
                    if let Some(msg_type) = parsed.get("type").and_then(|v| v.as_str()) {
                        match msg_type {
                            "ALL_TABS_RESPONSE"
                            | "PROXY_FETCH_RESPONSE"
                            | "BROWSER_OPEN_RESPONSE"
                            | "BROWSER_SNAPSHOT_RESPONSE"
                            | "BROWSER_INTERACT_RESPONSE"
                            | "BROWSER_EXTRACT_RESPONSE"
                            | "BROWSER_SCREENSHOT_RESPONSE" => {
                                if let Some(req_id) = parsed.get("id").and_then(|v| v.as_str()) {
                                    resolve_pending_request(
                                        req_id,
                                        parsed
                                            .get("data")
                                            .cloned()
                                            .unwrap_or(serde_json::Value::Null),
                                    );
                                }
                            }
                            "ping" => {
                                // Keep-alive heartbeat; nothing to do here, the
                                // mere fact that the WS is still readable is the
                                // signal we care about.
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    });

    // 4. Await termination of either task (read or write disconnect)
    tokio::select! {
        _ = &mut ws_write_task => {},
        _ = &mut ws_read_task => {},
    };

    // 5. Clean up session on disconnect. Take the session out FIRST, then
    //    drop the senders explicitly so any REST callers blocked on `rx.await`
    //    wake immediately with `RecvError` rather than waiting for their
    //    individual timeouts. Without this drain, every in-flight request
    //    has to time out independently (1.5s–5s each) when the extension
    //    disconnects.
    let removed = EXTENSION_SESSION.write().ok().and_then(|mut g| g.take());
    if let Some(session) = removed {
        if let Ok(mut pending) = session.pending_requests.lock() {
            pending.clear();
        }
    }
    ws_write_task.abort();
    ws_read_task.abort();
}

/// Resolves a pending REST thread's oneshot channel when the WS replies
fn resolve_pending_request(req_id: &str, data: serde_json::Value) {
    if let Ok(session_guard) = EXTENSION_SESSION.read() {
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                if let Some(tx) = pending.remove(req_id) {
                    let _ = tx.send(data);
                }
            }
        }
    }
}

/// Sends a request to the connected browser extension to fetch the title of a URL dynamically.
/// This runs in the browser context, preserving active cookie sessions (perfect for SSO internal sites).
///
/// Respects the master `browser_control.enabled` switch — when the user has
/// turned off "Allow AI Browser Action", we do NOT route fetches through the
/// extension (cookies / SSO state must not leak through a disabled feature).
pub async fn proxy_fetch_title(url: &str) -> Option<String> {
    if !crate::storage::config::load_config()
        .browser_control
        .enabled
    {
        return None;
    }
    // 1. Retrieve the active extension session
    let session_tx = {
        let session_guard = EXTENSION_SESSION.read().ok()?;
        if let Some(session) = &*session_guard {
            session.sender.clone()
        } else {
            return None;
        }
    };

    // 2. Generate a unique request ID and register it
    let req_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();

    {
        let session_guard = EXTENSION_SESSION.read().ok()?;
        if let Some(session) = &*session_guard {
            if let Ok(mut pending) = session.pending_requests.lock() {
                pending.insert(req_id.clone(), tx);
            } else {
                return None;
            }
        } else {
            return None;
        }
    }

    // 3. Send the request to the extension via WebSocket
    let request_payload = json!({
        "type": "PROXY_FETCH_TITLE",
        "id": req_id.clone(),
        "url": url
    });

    if session_tx.send(request_payload).is_err() {
        cleanup_request(&req_id);
        return None;
    }

    // 4. Await the response with a timeout (2.5 seconds)
    match tokio::time::timeout(Duration::from_millis(2500), rx).await {
        Ok(Ok(response_data)) => {
            // Extension returns { "url": "...", "title": "..." }
            if let Some(title) = response_data.get("title").and_then(|v| v.as_str()) {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            None
        }
        _ => {
            cleanup_request(&req_id);
            None
        }
    }
}

/// Dispatch a browser command to the connected Chrome Companion Extension
/// over WebSocket. All MCP browser tools + the REST /extension/command
/// endpoint funnel through here. Single critical section per call: we
/// grab the sender and register the pending oneshot under one `read()`
/// guard, then release before awaiting the response.
async fn send_extension_command(
    cmd_type: &str,
    payload: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let req_id = format!("req-{}", REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();

    // Single guard scope: clone sender + insert pending entry atomically.
    let session_tx = {
        let session_guard = EXTENSION_SESSION.read().map_err(|_| "Server lock error")?;
        let Some(session) = &*session_guard else {
            return Err("Browser Companion Extension is offline or not connected".to_string());
        };
        let mut pending = session
            .pending_requests
            .lock()
            .map_err(|_| "Pending requests registry lock error")?;
        pending.insert(req_id.clone(), tx);
        session.sender.clone()
    };

    let mut request_payload = payload;
    if let Some(obj) = request_payload.as_object_mut() {
        obj.insert("type".to_string(), json!(cmd_type));
        obj.insert("id".to_string(), json!(req_id));
    } else {
        cleanup_request(&req_id);
        return Err("Payload must be a JSON object".to_string());
    }

    if session_tx.send(request_payload).is_err() {
        cleanup_request(&req_id);
        return Err("Failed to send command to Browser Companion Extension".to_string());
    }

    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(response_data)) => Ok(response_data),
        Ok(Err(_)) => Err("Extension connection severed while awaiting response".to_string()),
        Err(_) => {
            cleanup_request(&req_id);
            Err("Command query to Browser Companion Extension timed out".to_string())
        }
    }
}

/// REST endpoint POST /api/v1/extension/command
#[derive(Debug, serde::Deserialize)]
pub struct ExtensionCommandRequest {
    pub cmd_type: String,
    pub payload: serde_json::Value,
}

pub async fn handle_extension_command(
    Json(req): Json<ExtensionCommandRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    // Respect the master `browser_control.enabled` switch — without this gate
    // a REST caller can still drive the user's browser via the connected
    // extension even after the user has disabled "Allow AI Browser Action".
    if !crate::storage::config::load_config()
        .browser_control
        .enabled
    {
        return Err(ApiError::bad_request(
            "Browser control is disabled. Enable 'Allow AI Browser Action' in Grove Settings.",
        ));
    }
    // Route through the same dispatcher the MCP tools use.
    match send_extension_command(&req.cmd_type, req.payload, 5000).await {
        Ok(res) => Ok(Json(res)),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// Opens a URL in the browser and automatically moves the tab into a project-scoped Chrome Tab Group
pub async fn browser_open(
    url: &str,
    group_name: Option<&str>,
) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_OPEN",
        json!({
            "url": url,
            "groupName": group_name
        }),
        3000,
    )
    .await
}

/// Takes a snapshot of a specific tab, generating an A11y Tree with unique reference tags (@e1, @e2).
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_snapshot(tab_id: u32) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_SNAPSHOT",
        json!({
            "tabId": tab_id,
        }),
        4000,
    )
    .await
}

/// Simulates interactive DOM gestures (click, fill, focus, check, etc.) via element reference tags (@e) or CSS selectors.
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_interact(
    tab_id: u32,
    action: &str,
    target: &str,
    value: Option<&str>,
) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_INTERACT",
        json!({
            "tabId": tab_id,
            "action": action,
            "target": target,
            "value": value
        }),
        3000,
    )
    .await
}

/// Extracts structured elements (innerText, outerHTML, value, URL, document title) from a specific tab.
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_extract(
    tab_id: u32,
    extract_type: &str,
    target: Option<&str>,
) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_EXTRACT",
        json!({
            "tabId": tab_id,
            "extractType": extract_type,
            "target": target
        }),
        3000,
    )
    .await
}

/// Captures a viewport-wide screenshot of a specific tab as a base64 PNG.
/// `tab_id` is the Chrome tab id returned by `browser_open`.
pub async fn browser_screenshot(tab_id: u32) -> Result<serde_json::Value, String> {
    send_extension_command(
        "BROWSER_SCREENSHOT",
        json!({
            "tabId": tab_id,
        }),
        5000,
    )
    .await
}

/// Build the companion zip in memory from the embedded `grove-extension/dist`
/// files. Returns an error if the embed is empty (extension dist not built).
fn build_extension_zip() -> Result<Vec<u8>, String> {
    if !manifest_present(ExtensionAssets::iter()) {
        return Err(ASSETS_MISSING.to_string());
    }
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for path in ExtensionAssets::iter() {
            let file = ExtensionAssets::get(&path)
                .ok_or_else(|| format!("missing embedded asset: {}", path))?;
            writer
                .start_file(path.as_ref(), options)
                .map_err(|e| format!("zip start_file {}: {}", path, e))?;
            writer
                .write_all(file.data.as_ref())
                .map_err(|e| format!("zip write {}: {}", path, e))?;
        }
        writer.finish().map_err(|e| format!("zip finish: {}", e))?;
    }
    Ok(buf)
}

/// GET /api/v1/extension/download — stream the Chrome companion zip.
/// First call builds the zip from embedded assets; subsequent calls hit the
/// in-memory cache.
pub async fn download_extension() -> Result<Response, (StatusCode, Json<ApiError>)> {
    let bytes: Vec<u8> = if let Some(cached) = EXTENSION_ZIP_CACHE.get() {
        cached.clone()
    } else {
        let built = build_extension_zip()
            .map_err(|e| ApiError::internal(format!("extension package unavailable: {}", e)))?;
        let _ = EXTENSION_ZIP_CACHE.set(built.clone());
        built
    };
    let len = bytes.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"grove-companion.zip\"",
        )
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from(bytes))
        .map_err(|e| ApiError::internal(format!("response build failed: {}", e)))
}

// ─── Path validation for user-chosen install location ────────────────────────
//
// Backend never picks a default — the install wizard requires the user to
// choose a folder. We only accept absolute paths, and refuse a handful of
// system locations where writing could corrupt the OS or require sudo.

fn validate_install_path(p: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(p);
    if !path.is_absolute() {
        return Err(format!("path must be absolute: {}", p));
    }
    // Reject empty or root-ish directories. Writing to `/` or `/System` etc.
    // is either harmless-but-noisy (Chrome won't load it) or requires sudo,
    // which we can't escalate — surface a useful error instead.
    let forbidden = ["/", "/System", "/usr", "/etc", "/var", "/bin", "/sbin"];
    for f in forbidden {
        if path.as_os_str() == std::ffi::OsStr::new(f) {
            return Err(format!("refusing to install into system path: {}", p));
        }
    }
    Ok(path)
}

/// Subdirectory name the install wizard creates inside the user-chosen
/// parent folder. Kept stable so reinstalls + grove upgrades land in the
/// same place, and Chrome's "Load unpacked" picker shows a recognisable
/// folder name.
const COMPANION_SUBDIR: &str = "grove-companion";

#[derive(Debug, serde::Deserialize)]
pub struct InstallExtensionRequest {
    /// Absolute path to a PARENT directory the user picked via the install
    /// wizard's folder picker. Backend creates `<path>/grove-companion/`
    /// inside it and unpacks the embedded files there — never bare into
    /// the parent. Wizard always supplies one; there is no backend default.
    pub path: String,
}

/// POST /api/v1/extension/install — create `<chosen-parent>/grove-companion/`
/// and unpack the embedded companion files into it. Returns the absolute
/// install path (i.e. the subdirectory) so the user can point Chrome's
/// "Load unpacked" at exactly the directory containing `manifest.json`.
///
/// Idempotent: subsequent calls overwrite the existing subdirectory file
/// by file — we don't delete it first, which would race with Chrome
/// reading the manifest. Files removed in newer versions stick around as
/// harmless orphans (Chrome ignores unknown files).
pub async fn install_extension_to_disk(
    Json(req): Json<InstallExtensionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let parent = validate_install_path(&req.path).map_err(ApiError::bad_request)?;
    // Check before creating anything. A binary built without the extension
    // would otherwise leave an empty grove-companion directory in the user's
    // folder and still report success, sending them to Chrome with a path
    // that has no manifest to load.
    if !manifest_present(ExtensionAssets::iter()) {
        return Err(ApiError::internal(ASSETS_MISSING));
    }
    // Create the dedicated subfolder. Without this, the user's chosen folder
    // (e.g. ~/Documents) ends up littered with manifest.json + assets/ —
    // breaking their organisation and making cleanup hard.
    let dir = parent.join(COMPANION_SUBDIR);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(ApiError::bad_request(format!(
            "could not create {}: {}",
            dir.display(),
            e
        )));
    }
    let mut written = 0usize;
    for path in ExtensionAssets::iter() {
        let file = ExtensionAssets::get(&path)
            .ok_or_else(|| ApiError::internal(format!("missing embedded asset: {}", path)))?;
        let dest = dir.join(path.as_ref());
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ApiError::bad_request(format!("could not create {}: {}", parent.display(), e))
            })?;
        }
        std::fs::write(&dest, file.data.as_ref()).map_err(|e| {
            ApiError::bad_request(format!("could not write {}: {}", dest.display(), e))
        })?;
        written += 1;
    }
    Ok(Json(json!({
        "ok": true,
        "path": dir.display().to_string(),
        "files": written,
    })))
}

#[derive(Debug, serde::Deserialize)]
pub struct RevealPathRequest {
    pub path: String,
}

/// POST /api/v1/extension/reveal-path — open the install directory in the
/// OS file manager so the user can drag-paste the path into Chrome.
pub async fn reveal_install_path(
    Json(req): Json<RevealPathRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let dir = validate_install_path(&req.path).map_err(ApiError::bad_request)?;
    if !dir.exists() {
        return Err(ApiError::bad_request(format!(
            "path does not exist: {}. Install the companion first.",
            dir.display()
        )));
    }
    let path_str = dir.display().to_string();
    let spawned = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&path_str).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(&path_str)
            .spawn()
    } else {
        std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn()
    };
    match spawned {
        Ok(_) => Ok(Json(json!({ "ok": true, "path": path_str }))),
        Err(e) => Err(ApiError::internal(format!(
            "could not open file manager: {}",
            e
        ))),
    }
}

/// GET /api/v1/extension/browse-install-folder — pop a native folder picker
/// so the user can choose where the companion gets installed.
///
/// Shares `folder::pick_folder` with the repo picker, so the response
/// distinguishes the three outcomes the same way: `{ path }` on selection,
/// `{ path: null, cancelled: true }` when the user dismissed the dialog, and
/// `{ path: null, cancelled: false }` when no native picker could be shown
/// (headless host, or `DISPLAY` set but pointing at a dead session). The
/// frontend falls back to the in-app folder browser on that last case.
/// Previously all three outcomes returned a bare `{ path: null }`, so an
/// unavailable picker was indistinguishable from a cancel and clicking the
/// button on a remote or headless Grove did nothing at all.
pub async fn browse_install_folder() -> Json<BrowseFolderResponse> {
    response_for(pick_folder("Where to install Grove Companion?"))
}

/// POST /api/v1/extension/open-chrome — launch the user's default browser
/// on `chrome://extensions/`. All Chromium-based browsers (Brave, Edge,
/// Vivaldi, Arc, Opera) accept the `chrome://` URL and forward to their
/// internal protocol, so detecting the default browser is enough — no
/// per-browser URL lookup needed.
pub async fn open_chrome_extensions(
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let url = "chrome://extensions/";
    let spawned = open_url_with_default_browser(url);
    match spawned {
        Ok(browser) => Ok(Json(json!({ "ok": true, "url": url, "browser": browser }))),
        Err(e) => Err(ApiError::bad_request(format!(
            "could not launch browser ({}). Copy {} into your browser's address bar instead.",
            e, url
        ))),
    }
}

/// Best-effort launch of a `chrome://` URL via the user's default browser.
/// Returns a human-readable browser identifier on success.
fn open_url_with_default_browser(url: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle_id) = macos_default_browser_bundle_id() {
            let r = std::process::Command::new("open")
                .args(["-b", &bundle_id, url])
                .spawn();
            if r.is_ok() {
                return Ok(bundle_id);
            }
        }
        // Fallback: try Chrome by bundle id, then by app name, then a
        // hard-coded Chromium family. `open` with a `chrome://` URL but
        // no `-a` / `-b` won't dispatch to the default browser because
        // chrome:// is not a universal scheme.
        for (label, bundle) in [
            ("Chrome", "com.google.Chrome"),
            ("Brave", "com.brave.Browser"),
            ("Edge", "com.microsoft.edgemac"),
            ("Arc", "company.thebrowser.Browser"),
            ("Vivaldi", "com.vivaldi.Vivaldi"),
            ("Opera", "com.operasoftware.Opera"),
        ] {
            if std::process::Command::new("open")
                .args(["-b", bundle, url])
                .spawn()
                .is_ok()
            {
                return Ok(label.to_string());
            }
        }
        Err("no Chromium-based browser found".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        // `xdg-settings get default-web-browser` returns a .desktop file name
        // (e.g. `brave-browser.desktop`). Map it to an exec command via
        // `xdg-mime` indirection if possible, otherwise just run the desktop
        // file's binary stem.
        if let Ok(output) = std::process::Command::new("xdg-settings")
            .args(["get", "default-web-browser"])
            .output()
        {
            if output.status.success() {
                let desktop = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // strip .desktop and any "browser-" prefix — gets us a
                // sensible binary name in 90% of cases (firefox, brave-browser,
                // google-chrome, microsoft-edge, opera, vivaldi, chromium).
                let binary = desktop.trim_end_matches(".desktop").to_string();
                if !binary.is_empty() {
                    if std::process::Command::new(&binary).arg(url).spawn().is_ok() {
                        return Ok(binary);
                    }
                }
            }
        }
        for cmd in [
            "google-chrome",
            "chromium",
            "brave-browser",
            "microsoft-edge",
            "vivaldi",
            "opera",
        ] {
            if std::process::Command::new(cmd).arg(url).spawn().is_ok() {
                return Ok(cmd.to_string());
            }
        }
        Err("no Chromium-based browser found".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        // Detection on Windows is fiddly (HKCU\\...\\UserChoice + ProgId
        // command lookup). For now, try the common Chromium browsers in
        // turn — defaults work for ~95% of Windows users.
        let _ = url;
        let candidates = [
            ("Chrome", "chrome"),
            ("Edge", "msedge"),
            ("Brave", "brave"),
            ("Vivaldi", "vivaldi"),
            ("Opera", "opera"),
        ];
        for (label, exe) in candidates {
            let r = std::process::Command::new("cmd")
                .args(["/C", "start", "", exe, url])
                .spawn();
            if r.is_ok() {
                return Ok(label.to_string());
            }
        }
        Err("no Chromium-based browser found".to_string())
    }
}

#[cfg(target_os = "macos")]
fn macos_default_browser_bundle_id() -> Option<String> {
    // LaunchServices stores per-scheme handlers in
    // `~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`.
    // For the default browser specifically, look for the `LSHandlerURLScheme = http`
    // entry — its `LSHandlerRoleAll` is the bundle id of the user's default
    // browser app. The plist is a binary-format plist, so we use the `plist`
    // crate already in dependencies.
    let home = dirs::home_dir()?;
    let plist_path = home
        .join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    let value: plist::Value = plist::from_file(&plist_path).ok()?;
    let handlers = value.as_dictionary()?.get("LSHandlers")?.as_array()?;
    for handler in handlers {
        let dict = handler.as_dictionary()?;
        if dict
            .get("LSHandlerURLScheme")
            .and_then(|v| v.as_string())
            .map(str::to_ascii_lowercase)
            .as_deref()
            == Some("http")
        {
            if let Some(role) = dict.get("LSHandlerRoleAll").and_then(|v| v.as_string()) {
                return Some(role.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_present_accepts_a_real_build() {
        assert!(manifest_present([
            "manifest.json",
            "index.html",
            "assets/background.js"
        ]));
        assert!(manifest_present(vec![
            "icons/32.png".to_string(),
            "manifest.json".to_string(),
        ]));
    }

    #[test]
    fn manifest_present_rejects_placeholder_only_embed() {
        // The exact shape that shipped a "successful" install of nothing: an
        // unbuilt grove-extension/dist holding only the directory placeholder.
        assert!(!manifest_present([".gitkeep"]));
        assert!(!manifest_present(Vec::<&str>::new()));
    }

    #[test]
    fn manifest_present_requires_the_manifest_at_the_top_level() {
        // Chrome loads the manifest from the directory root, so a nested one
        // does not make the embed loadable.
        assert!(!manifest_present(["nested/manifest.json"]));
    }
}

//! Build script for Grove
//!
//! The published crate includes pre-built frontend assets in `grove-web/dist`
//! so `cargo install grove-rs --features gui` does not require Node.js.

use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=grove-web/dist");
    println!("cargo:rerun-if-changed=grove-web/src");
    println!("cargo:rerun-if-changed=grove-web/index.html");
    println!("cargo:rerun-if-changed=grove-web/package.json");

    ensure_frontend_dist();
    build_tauri();
}

fn ensure_frontend_dist() {
    let dist_dir = Path::new("grove-web/dist");
    let grove_web_dir = Path::new("grove-web");

    if dist_dir.join("index.html").exists() {
        return;
    }

    if !grove_web_dir.exists() {
        panic!("grove-web/dist is missing from the package");
    }

    let npm_check = Command::new("npm").arg("--version").output();
    if npm_check.is_err() || !npm_check.unwrap().status.success() {
        panic!("grove-web/dist is missing; run `npm run build --prefix grove-web` before building");
    }

    println!("cargo:warning=Building frontend (this may take a moment)...");

    let node_modules = grove_web_dir.join("node_modules");
    if !node_modules.exists() && !run_npm(grove_web_dir, "ci") && !run_npm(grove_web_dir, "install")
    {
        panic!("failed to install frontend dependencies");
    }

    if !run_npm(grove_web_dir, "run build") {
        panic!("failed to build frontend; run `npm run build --prefix grove-web` for details");
    }

    if !dist_dir.join("index.html").exists() {
        panic!("frontend build did not produce grove-web/dist/index.html");
    }
}

fn run_npm(dir: &Path, command: &str) -> bool {
    let mut cmd = Command::new("npm");
    cmd.current_dir(dir);
    for arg in command.split_whitespace() {
        cmd.arg(arg);
    }

    cmd.status().map(|status| status.success()).unwrap_or(false)
}

fn build_tauri() {
    #[cfg(feature = "gui")]
    {
        // GUI windows load the frontend from `http://localhost:<dynamic port>`
        // (WebviewUrl::External), which Tauri treats as a REMOTE origin. Remote
        // origins always go through the IPC ACL, and app-defined commands only
        // become ACL-visible if the app declares an AppManifest that
        // autogenerates `allow-<command>` permissions. Without this, every
        // `invoke()` of a custom command from the webview is rejected with
        // "<command> not allowed. Plugin not found".
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "open_external_url",
                "download_file_dialog",
                "save_bytes_dialog",
                "resolve_external_drag_path",
                "toggle_devtools",
                "toggle_main_window_visibility",
                "tray_resolve_permission",
                "tray_open_main",
                "tray_open_settings",
                "tray_open_task",
                "tray_take_pending_navigate",
                "toggle_tray_popover_visibility",
                "tray_set_pinned",
                "tray_is_pinned",
                "tray_update_theme_icons",
            ]),
        ))
        .expect("failed to run tauri-build");
    }

    // macOS dev convenience: `make gui` runs the bare `cargo run` binary, not a
    // packaged .app, so it has no embedded Info.plist. Without an embedded
    // `NSMicrophoneUsageDescription`, macOS TCC silently denies microphone
    // access to the process — the WKWebView's getUserMedia then returns an
    // empty stream (no permission prompt, blank audio). Embedding the plist as
    // a `__TEXT,__info_plist` section makes macOS show the mic prompt so voice
    // transcription works in the dev binary too. (Release .app bundles get the
    // plist from the Tauri bundler; this section is harmless there.)
    #[cfg(all(target_os = "macos", feature = "gui"))]
    embed_info_plist();
}

#[cfg(all(target_os = "macos", feature = "gui"))]
fn embed_info_plist() {
    let plist = Path::new("src-tauri/Info.plist");
    match std::fs::canonicalize(plist) {
        Ok(abs) => {
            println!("cargo:rerun-if-changed=src-tauri/Info.plist");
            // Path must not contain commas (the -Wl arg is comma-separated).
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                abs.display()
            );
        }
        Err(e) => println!("cargo:warning=could not embed Info.plist: {e}"),
    }
}

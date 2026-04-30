//! GUI desktop application using Tauri
//!
//! This module provides the `grove gui` command which launches a native
//! desktop window using Tauri, sharing the same frontend as `grove web`.

use crate::api;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const DAEMON_ENV: &str = "GROVE_GUI_DAEMON";

/// Open an http(s) URL in the OS default browser.
///
/// Tauri 2's `plugin:shell|open` requires a scope validator that is
/// awkward to wire through capability files, so we ship a tiny custom
/// command that shells out to the platform opener directly. Only
/// http/https URLs are accepted.
/// Toggle the WebView devtools window for the main window.
///
/// Available because Tauri is built with the `devtools` feature, so this
/// works in both debug and release builds. The frontend binds a global
/// shortcut (Cmd/Ctrl+Shift+I, F12) that calls this command.
#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[tauri::command]
fn toggle_main_window_visibility(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("refused non-http(s) url: {url}"));
    }
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![url.as_str()]);
    #[cfg(target_os = "windows")]
    let cmd = ("cmd", vec!["/C", "start", "", url.as_str()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = ("xdg-open", vec![url.as_str()]);

    std::process::Command::new(cmd.0)
        .args(cmd.1)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Show a native "Save As" dialog, download the given http(s) URL, and
/// write its bytes to the chosen path.
///
/// Returns `Ok(Some(path))` on success, `Ok(None)` if the user cancelled
/// the dialog, or `Err(msg)` on failure. Only http/https is accepted.
#[tauri::command]
async fn download_file_dialog(
    url: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("refused non-http(s) url: {url}"));
    }

    let handle = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested_name)
        .save_file()
        .await;
    let Some(file) = handle else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();

    let url_for_blocking = url;
    let path_for_blocking = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let resp = ureq::get(&url_for_blocking)
            .call()
            .map_err(|e| e.to_string())?;
        let mut reader = resp.into_reader();
        let mut out = std::fs::File::create(&path_for_blocking).map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut out).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(Some(path.display().to_string()))
}

/// Try to daemonize the GUI process so the terminal is released immediately.
///
/// Returns `true` if the current process is the **parent** that spawned a
/// background child — the caller should exit.  Returns `false` if we are
/// already the daemon child (or daemonize is not applicable) — proceed with
/// the normal GUI startup.
pub fn try_daemonize(port: u16) -> bool {
    // Already the daemon child — run the GUI
    if std::env::var(DAEMON_ENV).as_deref() == Ok("1") {
        return false;
    }

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false, // cannot determine exe path, run in foreground
    };

    // Build log path: ~/.grove/gui.log
    let log_path = dirs::home_dir()
        .map(|h| h.join(".grove").join("gui.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/grove-gui.log"));

    let log_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
        Ok(f) => f,
        Err(_) => return false, // can't open log, run in foreground
    };
    let stderr_file = match log_file.try_clone() {
        Ok(f) => f,
        Err(_) => match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(f) => f,
            Err(_) => return false, // can't open stderr log, run in foreground
        },
    };

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["gui", "--port", &port.to_string()])
        .env(DAEMON_ENV, "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log_file))
        .stderr(std::process::Stdio::from(stderr_file));

    // Start a new process group so the child is not killed when the terminal closes
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd.spawn();

    match child {
        Ok(c) => {
            println!("Grove GUI launched in background (pid: {})", c.id());
            println!("Logs: {}", log_path.display());
            true // parent should exit
        }
        Err(e) => {
            eprintln!("Failed to daemonize: {e}. Running in foreground.");
            false
        }
    }
}

/// When launched as a macOS .app bundle, the process inherits a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin). This function expands it by querying the
/// user's login shell and appending common installation directories so that
/// tools like tmux, claude, fzf, etc. can be found.
#[cfg(target_os = "macos")]
fn expand_path_for_app_bundle() {
    let home = std::env::var("HOME").unwrap_or_default();

    // Common paths that are frequently missing in app-bundle launches
    let extra_paths = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        &format!("{home}/.cargo/bin"),
        &format!("{home}/.local/bin"),
        "/opt/local/bin", // MacPorts
    ];

    // Seed with existing PATH so we don't lose anything
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = current.split(':').filter(|s| !s.is_empty()).collect();

    // Prepend extra paths that are not already present
    for p in extra_paths.iter().rev() {
        if !p.is_empty() && !parts.contains(p) {
            parts.insert(0, p);
        }
    }

    // Also try to read the full PATH from the user's login shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let shell_path_str = std::process::Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    for p in shell_path_str.trim().split(':') {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }

    let new_path = parts.join(":");
    // SAFETY: called once at startup before any threads are spawned
    #[allow(unused_unsafe)]
    unsafe {
        std::env::set_var("PATH", &new_path);
    }
}

/// Execute the GUI desktop application
pub async fn execute(port: u16) {
    // Expand PATH before anything else so dependency checks work correctly (macOS only)
    #[cfg(target_os = "macos")]
    expand_path_for_app_bundle();
    // Check for embedded assets
    if !api::has_embedded_assets() {
        eprintln!("Error: No embedded frontend assets found.");
        eprintln!("Please build the frontend first:");
        eprintln!("  cd grove-web && npm install && npm run build");
        eprintln!("Then rebuild with GUI support:");
        eprintln!("  cargo build --release --features gui");
        std::process::exit(1);
    }

    // Flag to track if the server is ready
    let server_ready = Arc::new(AtomicBool::new(false));
    let server_ready_clone = server_ready.clone();

    // Bind to a port (with auto-fallback if in use)
    let (listener, actual_port) = match api::bind_with_fallback("127.0.0.1", port, 10).await {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Failed to bind to port: {}", e);
            eprintln!("Try a different port with: grove gui --port <port>");
            std::process::exit(1);
        }
    };

    println!(
        "Grove GUI: Starting API server on http://localhost:{}",
        actual_port
    );

    // Start HTTP server in a background task
    let server_handle = tokio::spawn(async move {
        // Initialize FileWatchers for all live tasks
        api::init_file_watchers();

        // Start the agent_graph MCP listener (loopback-only). Non-fatal on failure.
        match api::handlers::agent_graph_mcp::start_listener(
            api::handlers::agent_graph_mcp::DEFAULT_BASE_PORT,
            api::handlers::agent_graph_mcp::DEFAULT_MAX_ATTEMPTS,
        )
        .await
        {
            Ok(port) => println!("[agent_graph_mcp] listener on http://127.0.0.1:{port}"),
            Err(e) => eprintln!(
                "[agent_graph_mcp] failed to bind listener: {} — agent_graph tools disabled",
                e
            ),
        }

        let auth = std::sync::Arc::new(api::auth::ServerAuth::no_auth());
        let app = api::create_router(None, auth);

        // Signal that server is ready
        server_ready_clone.store(true, Ordering::SeqCst);

        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("API server error: {}", e);
        }

        api::shutdown_file_watchers();
    });

    // Wait for server to be ready
    while !server_ready.load(Ordering::SeqCst) {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    // Give the server a moment to fully initialize
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Build and run Tauri application
    println!("Grove GUI: Launching desktop window...");

    let tauri_app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_external_url,
            download_file_dialog,
            toggle_devtools,
            toggle_main_window_visibility,
            crate::tray::tray_resolve_permission,
            crate::tray::tray_open_main,
            crate::tray::tray_open_settings,
            crate::tray::tray_open_task,
            crate::tray::tray_take_pending_navigate,
        ])
        .setup(move |app| {
            // Create a window pointing to our HTTP server
            let url = format!("http://localhost:{}", actual_port);
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title("Grove")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1280.0, 720.0)
            .center()
            .disable_drag_drop_handler()
            .build()?;

            // Register menubar tray + popover. Gated by config so users who
            // dislike the menubar surface can opt out cleanly. Failure here
            // should not block the main window from launching — log only.
            let cfg = crate::storage::config::load_config();
            if cfg.notifications.tray_enabled {
                if let Err(e) = crate::tray::init(&app.handle().clone(), actual_port) {
                    eprintln!("[Grove] failed to initialize menubar tray: {}", e);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    let tauri_app = match tauri_app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("Tauri error: {}", e);
            std::process::exit(1);
        }
    };

    // On macOS we want Cmd+W (and the red traffic light) to hide the
    // window instead of terminating the process, so clicking the Dock
    // icon can bring it back. Quit still works via Cmd+Q / Dock → Quit,
    // which Tauri delivers as RunEvent::ExitRequested.
    tauri_app.run(|app_handle, event| {
        use tauri::Manager;

        // Hide tray popover when it loses focus — applies on every platform
        // so the popover behaves like a transient menu bar attachment.
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Focused(false),
            ..
        } = &event
        {
            if label == "tray-popover" {
                if let Some(win) = app_handle.get_webview_window("tray-popover") {
                    let _ = win.hide();
                }
            }
        }

        // Cross-platform: tray-popover close → hide, never quit the app.
        // (On Windows/Linux without this guard an Alt+F4 on the popover
        // would terminate the whole Grove process.)
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
        {
            if label == "tray-popover" {
                if let Some(win) = app_handle.get_webview_window("tray-popover") {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            match event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    // macOS: red traffic light hides instead of quits, so
                    // re-clicking the Dock icon brings the window back.
                    // Skip tray-popover here — the cross-platform handler
                    // above already took care of it.
                    if label != "tray-popover" {
                        if let Some(window) = app_handle.get_webview_window(&label) {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                }
                tauri::RunEvent::Reopen {
                    has_visible_windows: false,
                    ..
                } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, event);
        }
    });

    println!("Grove GUI closed.");

    // Abort the server task when Tauri exits and check for panic
    server_handle.abort();
    match server_handle.await {
        Ok(()) => {}
        Err(ref e) if e.is_cancelled() => {}
        Err(e) if e.is_panic() => {
            let panic = e.into_panic();
            let msg = if let Some(s) = panic.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            eprintln!("[Grove] API server panicked: {}", msg);
        }
        Err(e) => eprintln!("[Grove] API server error: {}", e),
    }
}

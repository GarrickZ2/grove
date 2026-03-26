//! GUI desktop application using Tauri
//!
//! This module provides the `grove gui` command which launches a native
//! desktop window using Tauri, sharing the same frontend as `grove web`.

use crate::api;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const DAEMON_ENV: &str = "GROVE_GUI_DAEMON";

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
    // Expand PATH before anything else so dependency checks work correctly
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

    let tauri_result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
            Ok(())
        })
        .run(tauri::generate_context!());

    match tauri_result {
        Ok(()) => {
            println!("Grove GUI closed.");
        }
        Err(e) => {
            eprintln!("Tauri error: {}", e);
            std::process::exit(1);
        }
    }

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

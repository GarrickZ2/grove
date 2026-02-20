//! GUI desktop application using Tauri
//!
//! This module provides the `grove gui` command which launches a native
//! desktop window using Tauri, sharing the same frontend as `grove web`.

use crate::api;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Execute the GUI desktop application
pub async fn execute(port: u16) {
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

        let app = api::create_router(None);

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

    // Abort the server task when Tauri exits
    server_handle.abort();
}

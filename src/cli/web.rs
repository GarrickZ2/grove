//! Web server CLI command

use crate::api;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Default port for the web server
pub const DEFAULT_PORT: u16 = 3001;

/// Build the frontend if needed
fn build_frontend(project_dir: &Path) -> bool {
    let grove_web_dir = project_dir.join("grove-web");
    let dist_dir = grove_web_dir.join("dist");

    // Check if dist exists
    if dist_dir.exists() {
        return true;
    }

    // Check if grove-web directory exists
    if !grove_web_dir.exists() {
        return false;
    }

    println!("Building frontend...");

    // Run npm install if node_modules doesn't exist
    let node_modules = grove_web_dir.join("node_modules");
    if !node_modules.exists() {
        let status = Command::new("npm")
            .arg("install")
            .current_dir(&grove_web_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();

        if status.is_err() || !status.unwrap().success() {
            eprintln!("Failed to run npm install");
            return false;
        }
    }

    // Run npm run build
    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir(&grove_web_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();

    if status.is_err() || !status.unwrap().success() {
        eprintln!("Failed to build frontend");
        return false;
    }

    true
}

/// Find the project directory (where Cargo.toml is)
fn find_project_dir() -> Option<PathBuf> {
    // Try current directory
    let cwd = std::env::current_dir().ok()?;
    if cwd.join("grove-web").exists() {
        return Some(cwd);
    }

    // Try CARGO_MANIFEST_DIR
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let path = PathBuf::from(manifest_dir);
        if path.join("grove-web").exists() {
            return Some(path);
        }
    }

    // Try relative to executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            if exe_dir.join("grove-web").exists() {
                return Some(exe_dir.to_path_buf());
            }
        }
    }

    None
}

/// Execute the web server
pub async fn execute(port: u16, no_open: bool, dev: bool) {
    if dev {
        // Development mode: run vite dev server + API server
        execute_dev_mode(port, no_open).await;
    } else {
        // Production mode: serve static files
        execute_prod_mode(port, no_open).await;
    }
}

/// Run in development mode (Vite dev server + API)
async fn execute_dev_mode(api_port: u16, no_open: bool) {
    let project_dir = find_project_dir();

    if project_dir.is_none() {
        eprintln!("Could not find grove-web directory for development mode");
        eprintln!("Please run this command from the project root");
        std::process::exit(1);
    }

    let project_dir = project_dir.unwrap();
    let grove_web_dir = project_dir.join("grove-web");

    // Check if node_modules exists
    if !grove_web_dir.join("node_modules").exists() {
        println!("Installing dependencies...");
        let status = Command::new("npm")
            .arg("install")
            .current_dir(&grove_web_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();

        if status.is_err() || !status.unwrap().success() {
            eprintln!("Failed to run npm install");
            std::process::exit(1);
        }
    }

    // Start Vite dev server in background
    let vite_port = 5173;
    println!("Starting Vite dev server on port {}...", vite_port);

    let mut vite_process = Command::new("npm")
        .args(["run", "dev", "--", "--port", &vite_port.to_string()])
        .current_dir(&grove_web_dir)
        .env("VITE_API_URL", format!("http://localhost:{}", api_port))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Failed to start Vite dev server");

    // Give Vite time to start
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Open browser
    if !no_open {
        let url = format!("http://localhost:{}", vite_port);
        println!("Opening browser: {}", url);
        let _ = open::that(&url);
    }

    println!("API server starting on port {}...", api_port);
    println!("\nDev mode URLs:");
    println!("  Frontend: http://localhost:{}", vite_port);
    println!("  API:      http://localhost:{}/api/v1", api_port);
    println!("\nPress Ctrl+C to stop");

    // Start API server (blocking)
    if let Err(e) = api::start_server(api_port, None).await {
        eprintln!("API server error: {}", e);
    }

    // Clean up Vite process
    let _ = vite_process.kill();
    let _ = vite_process.wait(); // Wait to avoid zombie process
}

/// Run in production mode (static files + API)
async fn execute_prod_mode(port: u16, no_open: bool) {
    // Check for embedded assets first
    let has_embedded = api::has_embedded_assets();

    // Try to find external static directory (for development override)
    let static_dir = api::find_static_dir();

    // If no embedded assets and no external files, try to build
    if !has_embedded && static_dir.is_none() {
        if let Some(project_dir) = find_project_dir() {
            if build_frontend(&project_dir) {
                // Rebuild static_dir after building
                let built_dir = project_dir.join("grove-web").join("dist");
                let url = format!("http://localhost:{}", port);

                if !no_open {
                    let url_clone = url.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        println!("Opening browser: {}", url_clone);
                        let _ = open::that(&url_clone);
                    });
                }

                if let Err(e) = api::start_server(port, Some(built_dir)).await {
                    eprintln!("Server error: {}", e);
                    std::process::exit(1);
                }
                return;
            }
        }

        // No embedded assets and couldn't build
        eprintln!("Could not find or build frontend files.");
        eprintln!("Please build the frontend first:");
        eprintln!("  cd grove-web && npm install && npm run build");
        std::process::exit(1);
    }

    let url = format!("http://localhost:{}", port);

    // Open browser after a short delay
    if !no_open {
        let url_clone = url.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            println!("Opening browser: {}", url_clone);
            let _ = open::that(&url_clone);
        });
    }

    // Start the server (will use embedded assets if no external static_dir)
    if let Err(e) = api::start_server(port, static_dir).await {
        eprintln!("Server error: {}", e);
        std::process::exit(1);
    }
}

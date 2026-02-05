//! Build script for Grove
//!
//! This script builds the frontend if:
//! 1. grove-web/dist doesn't exist
//! 2. Node.js (npm) is available
//!
//! This enables `cargo install grove-rs` to work without pre-built frontend files.

use std::path::Path;
use std::process::Command;

fn main() {
    let dist_dir = Path::new("grove-web/dist");
    let grove_web_dir = Path::new("grove-web");

    // Rerun if frontend source changes
    println!("cargo:rerun-if-changed=grove-web/src");
    println!("cargo:rerun-if-changed=grove-web/index.html");
    println!("cargo:rerun-if-changed=grove-web/package.json");

    // If dist already exists, we're done
    if dist_dir.exists() && dist_dir.join("index.html").exists() {
        return;
    }

    // Check if grove-web directory exists
    if !grove_web_dir.exists() {
        println!("cargo:warning=grove-web directory not found, web UI will not be available");
        // Create empty dist to avoid rust-embed errors
        std::fs::create_dir_all(dist_dir).ok();
        std::fs::write(dist_dir.join(".gitkeep"), "").ok();
        return;
    }

    // Check if npm is available
    let npm_check = Command::new("npm").arg("--version").output();
    if npm_check.is_err() || !npm_check.unwrap().status.success() {
        println!("cargo:warning=npm not found, skipping frontend build");
        println!("cargo:warning=Web UI will not be available");
        println!("cargo:warning=To enable web UI, install Node.js and run:");
        println!("cargo:warning=  cd grove-web && npm install && npm run build");
        // Create empty dist to avoid rust-embed errors
        std::fs::create_dir_all(dist_dir).ok();
        std::fs::write(dist_dir.join(".gitkeep"), "").ok();
        return;
    }

    println!("cargo:warning=Building frontend (this may take a moment)...");

    // Run npm install if node_modules doesn't exist
    let node_modules = grove_web_dir.join("node_modules");
    if !node_modules.exists() {
        let status = Command::new("npm")
            .arg("ci")
            .current_dir(grove_web_dir)
            .status();

        if status.is_err() || !status.unwrap().success() {
            // Try npm install as fallback
            let status = Command::new("npm")
                .arg("install")
                .current_dir(grove_web_dir)
                .status();

            if status.is_err() || !status.unwrap().success() {
                println!("cargo:warning=Failed to install frontend dependencies");
                std::fs::create_dir_all(dist_dir).ok();
                std::fs::write(dist_dir.join(".gitkeep"), "").ok();
                return;
            }
        }
    }

    // Run npm run build
    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir(grove_web_dir)
        .status();

    if status.is_err() || !status.unwrap().success() {
        println!("cargo:warning=Failed to build frontend");
        std::fs::create_dir_all(dist_dir).ok();
        std::fs::write(dist_dir.join(".gitkeep"), "").ok();
        return;
    }

    println!("cargo:warning=Frontend built successfully");
}

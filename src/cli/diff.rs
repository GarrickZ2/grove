//! `grove diff` CLI command — open diff review in browser

use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::storage::workspace;

/// Execute the `grove diff` command
pub fn execute(task_id: Option<String>, port: u16) {
    // 1. Resolve task_id: argument > GROVE_TASK_ID env var
    let task_id = task_id.or_else(|| std::env::var("GROVE_TASK_ID").ok());

    let task_id = match task_id {
        Some(id) => id,
        None => {
            eprintln!("Error: Cannot determine task ID.");
            eprintln!("Run this command inside a Grove task session (GROVE_TASK_ID is set automatically),");
            eprintln!("or pass it explicitly: grove diff <task_id>");
            std::process::exit(1);
        }
    };

    // 2. Resolve project key: GROVE_PROJECT env > current directory git root
    let project_key = std::env::var("GROVE_PROJECT").ok().unwrap_or_else(|| {
        if let Ok(git_root) = crate::git::repo_root(".") {
            workspace::project_hash(&git_root)
        } else {
            eprintln!("Error: Not in a git repository and GROVE_PROJECT not set.");
            std::process::exit(1);
        }
    });

    // 3. Check if web server is running
    let server_running = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(500),
    )
    .is_ok();

    // 4. Start web server in background if not running
    if !server_running {
        println!("Starting web server on port {}...", port);
        let exe = std::env::current_exe().unwrap_or_else(|_| "grove".into());
        let _child = Command::new(exe)
            .args(["web", "--no-open", "--port", &port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        // Wait a bit for server to start
        std::thread::sleep(Duration::from_secs(2));
    }

    // 5. Open browser to review page
    let url = format!(
        "http://localhost:{}/review/{}/{}",
        port, project_key, task_id
    );
    println!("Opening diff review: {}", url);
    if let Err(e) = open::that(&url) {
        eprintln!("Failed to open browser: {}", e);
        eprintln!("Please open manually: {}", url);
    }
}

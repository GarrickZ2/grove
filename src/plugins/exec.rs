//! `grove.exec` — Grove-mediated command execution for plugins. The command
//! runs with its working directory locked to the task worktree and a hard
//! timeout; output streams back as newline-delimited JSON.
//!
//! exec is gated by the `exec` permission, which is the **nuclear** one: a
//! spawned OS process is itself unsandboxable (Node's own docs say as much), so
//! granting exec is effectively full machine trust. The CWD lock and timeout
//! are ergonomics and a runaway guard — not a security boundary. The panel can
//! call this directly (same-origin fetch streaming) without a node backend.
//!
//! Stream protocol (one JSON object per line):
//!   `{"type":"stdout","line":"…"}`  `{"type":"stderr","line":"…"}`
//!   `{"type":"exit","code":<int|null>}`  `{"type":"error","message":"…"}`

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

/// Hard cap on a single exec; the child is killed past this.
const EXEC_TIMEOUT: Duration = Duration::from_secs(600);

fn line(v: Value) -> String {
    let mut s = v.to_string();
    s.push('\n');
    s
}

/// Spawn `command`/`args` in `cwd` and return a receiver streaming NDJSON lines.
/// Errors are delivered in-band as `{"type":"error",…}`, so the stream item
/// type is infallible (`String`).
pub fn run(
    command: String,
    args: Vec<String>,
    cwd: String,
) -> mpsc::Receiver<std::result::Result<String, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<std::result::Result<String, std::io::Error>>(64);
    tokio::spawn(async move {
        let mut cmd = tokio::process::Command::new(crate::check::program_path(&command));
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx
                    .send(Ok(line(
                        json!({ "type": "error", "message": format!("spawn failed: {}", e) }),
                    )))
                    .await;
                return;
            }
        };
        let process_tree = crate::platform::ProcessTree::adopt(&child);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let tx_out = tx.clone();
        let out_task = tokio::spawn(async move {
            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if tx_out
                        .send(Ok(line(json!({ "type": "stdout", "line": l }))))
                        .await
                        .is_err()
                    {
                        break; // client disconnected
                    }
                }
            }
        });
        let tx_err = tx.clone();
        let err_task = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if tx_err
                        .send(Ok(line(json!({ "type": "stderr", "line": l }))))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        });

        let status = match tokio::time::timeout(EXEC_TIMEOUT, child.wait()).await {
            Ok(Ok(st)) => Some(st),
            Ok(Err(_)) => None,
            Err(_) => {
                process_tree.terminate();
                let _ = child.start_kill();
                let _ = tx
                    .send(Ok(line(
                        json!({ "type": "error", "message": "exec timed out" }),
                    )))
                    .await;
                None
            }
        };
        let _ = out_task.await;
        let _ = err_task.await;
        if let Some(st) = status {
            let _ = tx
                .send(Ok(line(json!({ "type": "exit", "code": st.code() }))))
                .await;
        }
    });
    rx
}

//! Runs the agent-browser package, always its latest release, through npx.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const PACKAGE: &str = "agent-browser@latest";
const LIST_TIMEOUT: Duration = Duration::from_secs(120);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// One driver process. `env` is applied on top of Grove's own environment.
pub struct Invocation<'a> {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: &'a Path,
    pub stdin: Option<String>,
    pub timeout: Duration,
}

pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run(invocation: Invocation<'_>) -> Result<Output, String> {
    let mut args = vec!["-y".to_string(), PACKAGE.to_string()];
    args.extend(invocation.args);
    let output = crate::tmux::run_npx(
        args,
        &invocation.env,
        invocation.cwd,
        invocation.stdin,
        invocation.timeout,
    )
    .await
    .map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "Browser control needs Node.js with npx. Install Node.js and try again.".to_string()
        }
        std::io::ErrorKind::TimedOut => "The browser command timed out.".to_string(),
        _ => format!("Could not start agent-browser: {error}"),
    })?;
    Ok(Output {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Download the browser agent-browser launches.
pub async fn install_browser() -> Result<(), String> {
    let home = crate::storage::grove_dir();
    let output = run(Invocation {
        args: vec!["install".to_string()],
        env: HashMap::new(),
        cwd: &home,
        stdin: None,
        timeout: INSTALL_TIMEOUT,
    })
    .await?;
    if output.success {
        Ok(())
    } else {
        // The end of what agent-browser printed: its reason and advice, not
        // the download progress before it.
        let said = format!("{}\n{}", output.stdout, output.stderr);
        let lines: Vec<&str> = said
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let tail = lines[lines.len().saturating_sub(20)..].join("\n");
        Err(if tail.is_empty() {
            "The browser could not be installed.".to_string()
        } else {
            tail
        })
    }
}

pub(super) fn last_line(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

/// Every tool agent-browser offers, as its MCP server lists them. Read once per
/// Grove run.
pub async fn tools() -> Result<Vec<Value>, String> {
    static CACHE: LazyLock<Mutex<Option<Vec<Value>>>> = LazyLock::new(Default::default);
    if let Some(cached) = CACHE.lock().unwrap().clone() {
        return Ok(cached);
    }
    let tools = tokio::time::timeout(LIST_TIMEOUT, list_tools())
        .await
        .map_err(|_| "Timed out reading the browser tool list.".to_string())??;
    *CACHE.lock().unwrap() = Some(tools.clone());
    Ok(tools)
}

async fn list_tools() -> Result<Vec<Value>, String> {
    let args = ["-y", PACKAGE, "mcp", "--tools", "all"].map(str::to_string);
    let home = crate::storage::grove_dir();
    let mut child = crate::tmux::spawn_npx_stdio(args.to_vec(), &home)
        .map_err(|error| format!("Could not start agent-browser: {error}"))?;
    let mut input = child
        .stdin
        .take()
        .ok_or("Could not open agent-browser input.")?;
    let output = child
        .stdout
        .take()
        .ok_or("Could not open agent-browser output.")?;
    let mut lines = tokio::io::BufReader::new(output).lines();

    async fn send(input: &mut tokio::process::ChildStdin, message: Value) -> Result<(), String> {
        input
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|error| error.to_string())
    }
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"grove","version":env!("CARGO_PKG_VERSION")}
        }}),
    )
    .await?;

    let mut tools = Vec::new();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message.get("id").and_then(Value::as_i64) {
            Some(1) => {
                send(
                    &mut input,
                    json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                )
                .await?;
                send(
                    &mut input,
                    json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
                )
                .await?;
            }
            Some(id) => {
                let result = message
                    .get("result")
                    .ok_or("agent-browser refused tools/list.")?;
                if let Some(page) = result.get("tools").and_then(Value::as_array) {
                    tools.extend(page.iter().cloned());
                }
                match result.get("nextCursor").and_then(Value::as_str) {
                    Some(cursor) => {
                        send(
                            &mut input,
                            json!({"jsonrpc":"2.0","id":id + 1,"method":"tools/list",
                                   "params":{"cursor":cursor}}),
                        )
                        .await?;
                    }
                    None => {
                        let _ = child.start_kill();
                        return Ok(tools);
                    }
                }
            }
            None => {}
        }
    }
    Err("agent-browser exited before listing its tools.".to_string())
}

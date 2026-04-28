//! `grove mcp-bridge` — stdio↔HTTP bridge for the agent_graph MCP listener.
//!
//! Some ACP agents (notably Trae) ignore MCP server entries injected via
//! `NewSessionRequest.mcp_servers` and only honor entries from their own
//! MCP config file. Because Grove picks a dynamic listener port at boot, the
//! user can't pin a stable URL into Trae's config either.
//!
//! This subcommand is the workaround: the user wires
//!
//!   {"mcpServers":{"grove":{"command":"grove","args":["mcp-bridge"]}}}
//!
//! into the agent's MCP config. Grove spawns the agent with `GROVE_MCP_TOKEN`
//! and `GROVE_MCP_PORT` already in the env (see `acp::run_acp_session`); the
//! agent in turn spawns this bridge, which inherits both env vars, and the
//! bridge becomes a thin proxy: read line-delimited JSON-RPC from stdin,
//! POST to the Streamable-HTTP MCP endpoint, write the response (and any SSE
//! server-pushed notifications) back to stdout.
//!
//! Discovery falls back to `~/.grove/mcp.port` when env vars are absent —
//! useful for ad-hoc testing, not for the agent path which always has env.
//!
//! ## Notes for token format
//! The token is interpolated into the URL path verbatim (no percent encoding
//! on either side). Both Grove server and bridge implicitly require it to be
//! url-path-safe (`[A-Za-z0-9._~-]`). Today Grove generates `uuid::Uuid`
//! tokens which always satisfy this; if that ever changes both sides need to
//! switch to percent-encode/decode in lockstep.

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use crate::api::handlers::agent_graph_mcp;

const ACCEPT_HEADER: &str = "application/json, text/event-stream";

/// Default per-request timeout. Long enough for `grove_agent_spawn` (90s ACP
/// handshake + slack); user can override via `GROVE_MCP_BRIDGE_TIMEOUT_SECS`
/// if a custom agent takes longer to come up. `0` disables the timeout.
const DEFAULT_TIMEOUT_SECS: u64 = 300;

pub fn run() -> i32 {
    // multi_thread runtime so that long SSE responses don't starve other
    // pipelined requests when we tokio::spawn each one.
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[mcp-bridge] failed to build tokio runtime: {}", e);
            return 1;
        }
    };
    rt.block_on(async_main())
}

async fn async_main() -> i32 {
    let url = match resolve_endpoint() {
        Ok(u) => u,
        Err(msg) => {
            eprintln!("[mcp-bridge] {}", msg);
            return 1;
        }
    };

    let timeout_secs = std::env::var("GROVE_MCP_BRIDGE_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    let mut builder = reqwest::Client::builder();
    if timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }
    let client = Arc::new(builder.build().expect("reqwest client builds"));
    let url = Arc::new(url);

    use tokio::io::{AsyncBufReadExt, BufReader};
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let client = client.clone();
        let url = url.clone();
        // Each request handled on its own task so a long SSE response on one
        // request doesn't block subsequent requests on stdin.
        tokio::spawn(async move {
            handle_one(&client, &url, &line).await;
        });
    }
    0
}

async fn handle_one(client: &reqwest::Client, url: &str, request_line: &str) {
    let resp = match client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", ACCEPT_HEADER)
        .body(request_line.to_string())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit_error(request_line, &format!("HTTP error: {}", e));
            return;
        }
    };

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        emit_error(request_line, &format!("HTTP {}: {}", status.as_u16(), body));
        return;
    }

    // 202 Accepted with no body is the Streamable HTTP "notification posted"
    // response — nothing to forward back to stdout.
    if status == reqwest::StatusCode::ACCEPTED {
        return;
    }

    if content_type.starts_with("text/event-stream") {
        forward_sse(resp, request_line).await;
    } else {
        let body = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                emit_error(request_line, &format!("read body: {}", e));
                return;
            }
        };
        if !body.trim().is_empty() {
            write_stdout_line(&body);
        }
    }
}

/// Build the full MCP HTTP URL by combining the listener port (env →
/// `mcp.port` file) with the per-session token (env). Returns a human-readable
/// error if neither source yields what we need.
fn resolve_endpoint() -> Result<String, String> {
    let token = std::env::var("GROVE_MCP_TOKEN").map_err(|_| {
        "GROVE_MCP_TOKEN not set — mcp-bridge must be spawned by an agent that \
         was launched by Grove (the parent agent process inherits the token \
         from Grove's spawn env)."
            .to_string()
    })?;

    let port = if let Ok(p) = std::env::var("GROVE_MCP_PORT") {
        p.parse::<u16>()
            .map_err(|e| format!("GROVE_MCP_PORT parse: {}", e))?
    } else {
        agent_graph_mcp::read_port_file_validated()
            .map_err(|e| format!("no GROVE_MCP_PORT in env and port file unusable: {}", e))?
    };

    Ok(format!("http://127.0.0.1:{}/mcp/{}", port, token))
}

/// Read a `text/event-stream` body byte-by-byte, decode lines as UTF-8 (so
/// multi-byte chars that cross chunk boundaries don't get mangled), and emit
/// every accumulated `data:` payload as one line on stdout when an empty
/// line terminates the event.
///
/// `request_line` is the originating JSON-RPC line — used to extract `id` if
/// the stream errors out, so the MCP client gets a JSON-RPC error and doesn't
/// hang waiting for a response.
async fn forward_sse(resp: reqwest::Response, request_line: &str) {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    // Byte-level buffer: split on `\n` byte boundaries (always safe since
    // `\n` cannot appear inside a multi-byte UTF-8 sequence). Only after a
    // complete line is extracted do we attempt UTF-8 decoding.
    let mut buf: Vec<u8> = Vec::new();
    let mut data_lines: Vec<String> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(b) => b,
            Err(e) => {
                emit_error(request_line, &format!("SSE read error: {}", e));
                return;
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(idx) = buf.iter().position(|b| *b == b'\n') {
            let line_bytes = buf.drain(..=idx).collect::<Vec<u8>>();
            // Drop trailing `\n` and optional `\r`.
            let mut end = line_bytes.len() - 1; // skip \n
            if end > 0 && line_bytes[end - 1] == b'\r' {
                end -= 1;
            }
            let line = match std::str::from_utf8(&line_bytes[..end]) {
                Ok(s) => s,
                Err(e) => {
                    emit_error(request_line, &format!("SSE line not valid UTF-8: {}", e));
                    return;
                }
            };
            if line.is_empty() {
                if !data_lines.is_empty() {
                    let payload = data_lines.join("\n");
                    write_stdout_line(&payload);
                    data_lines.clear();
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
            // Other SSE fields (event:, id:, retry:, comment lines `:...`) ignored.
        }
    }
    // Stream closed mid-event — flush whatever we have.
    if !data_lines.is_empty() {
        write_stdout_line(&data_lines.join("\n"));
    }
}

fn write_stdout_line(payload: &str) {
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    let _ = h.write_all(payload.as_bytes());
    let _ = h.write_all(b"\n");
    let _ = h.flush();
}

/// Best-effort: turn an upstream failure into a JSON-RPC error response so the
/// MCP client doesn't hang waiting for a response.
///
/// We attempt to lift the request `id` out of `request_line` so the error is
/// correlated to the call. If `request_line` isn't valid JSON we fall back to
/// `id: null` — strictly that's only spec-compliant for parse errors, but a
/// non-JSON line on stdin is itself a caller-side parse error from our POV.
fn emit_error(request_line: &str, msg: &str) {
    let id = serde_json::from_str::<serde_json::Value>(request_line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    let err = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32603,
            "message": msg,
        }
    });
    if let Ok(s) = serde_json::to_string(&err) {
        write_stdout_line(&s);
    }
    eprintln!("[mcp-bridge] {}", msg);
}

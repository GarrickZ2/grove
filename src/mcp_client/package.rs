//! Short-lived stdio discovery for package-based MCP servers.
use super::{now, server_info, Result, ServerInfo, MAX_BODY};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::OnceLock, time::Duration};

#[derive(Clone, Serialize)]
pub struct PackageProbeSummary {
    pub id: String,
    pub status: String,
    pub server_info: Option<ServerInfo>,
    pub tool_count: Option<usize>,
    pub checked_at: Option<u64>,
    pub error: Option<String>,
}

struct PackageProbeJob {
    summary: PackageProbeSummary,
    abort: Option<tokio::task::AbortHandle>,
}

fn package_jobs() -> &'static std::sync::Mutex<HashMap<String, PackageProbeJob>> {
    static JOBS: OnceLock<std::sync::Mutex<HashMap<String, PackageProbeJob>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

pub async fn start_package_probe(
    package: Value,
    values: HashMap<String, String>,
) -> Result<PackageProbeSummary> {
    let mut config = crate::storage::extensions::resolve_package_mcp_config(&package, &values)
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let summary = PackageProbeSummary {
        id: id.clone(),
        status: "pending".into(),
        server_info: None,
        tool_count: None,
        checked_at: None,
        error: None,
    };
    let mut jobs = package_jobs().lock().unwrap();
    if jobs.len() >= 64 {
        jobs.retain(|_, job| job.summary.status == "pending");
    }
    if jobs
        .values()
        .filter(|job| job.summary.status == "pending")
        .count()
        >= 8
    {
        return Err("Too many package checks are running. Cancel one and try again.".into());
    }
    let cwd = crate::storage::grove_dir().join("mcp-probes").join(&id);
    let job_id = id.clone();
    let container_name =
        (package["registryType"] == "oci").then(|| format!("grove-mcp-probe-{id}"));
    if let Some(name) = &container_name {
        config.args.splice(1..1, ["--name".into(), name.clone()]);
    }
    let task = tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(120), probe_package_process(config, cwd, container_name)).await
            .unwrap_or_else(|_| Err("Starting the package timed out. Check the runtime, package version, and environment variables, then retry.".into()));
        if let Some(job) = package_jobs().lock().unwrap().get_mut(&job_id) {
            job.summary.checked_at = Some(now());
            match result {
                Ok((info, count)) => {
                    job.summary.status = "complete".into();
                    job.summary.server_info = info;
                    job.summary.tool_count = count;
                }
                Err(error) => {
                    job.summary.status = "failed".into();
                    job.summary.error = Some(error);
                }
            }
            job.abort = None;
        }
    });
    jobs.insert(
        id,
        PackageProbeJob {
            summary: summary.clone(),
            abort: Some(task.abort_handle()),
        },
    );
    Ok(summary)
}

pub fn package_probe_status(id: &str) -> Result<PackageProbeSummary> {
    package_jobs()
        .lock()
        .unwrap()
        .get(id)
        .map(|job| job.summary.clone())
        .ok_or_else(|| "This package check is no longer available. Connect again.".into())
}

pub fn cancel_package_probe(id: &str) {
    if let Some(job) = package_jobs().lock().unwrap().remove(id) {
        if let Some(abort) = job.abort {
            abort.abort();
        }
    }
}

struct ProbeWorkspace(PathBuf);
impl Drop for ProbeWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct ProbeStderr(tokio::task::JoinHandle<()>);
impl Drop for ProbeStderr {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) async fn probe_package_process(
    config: crate::storage::extensions::ResolvedMcpConfig,
    cwd: PathBuf,
    container_name: Option<String>,
) -> Result<(Option<ServerInfo>, Option<usize>)> {
    std::fs::create_dir_all(&cwd).map_err(|_| "Could not create a temporary package workspace.")?;
    let _workspace = ProbeWorkspace(cwd.clone());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cwd, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect the package workspace.")?;
    }
    let cleanup = container_name.map(|name| vec!["rm".into(), "--force".into(), name]);
    let mut process =
        crate::tmux::spawn_mcp_probe(&config, &cwd, cleanup).map_err(|_| {
            match config.command.as_deref() {
                Some("npx") => "Could not start NPM. Install Node.js with npx and try again.",
                Some("uvx") => "Could not start PyPI. Install uv with uvx and try again.",
                Some("docker") => "Could not start OCI. Install and start Docker, then try again.",
                _ => "Could not start the MCP package.",
            }
        })?;
    let mut input = process
        .child
        .stdin
        .take()
        .ok_or("Could not open the server input.")?;
    let mut output = tokio::io::BufReader::new(
        process
            .child
            .stdout
            .take()
            .ok_or("Could not open the server output.")?,
    );
    let mut stderr = process
        .child
        .stderr
        .take()
        .ok_or("Could not open the server error stream.")?;
    // Keep a bounded diagnostic buffer, but only return fixed classifications:
    // package output can contain credentials and must never be copied into APIs.
    let logs = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = logs.clone();
    let mut stderr_task = ProbeStderr(tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut chunk = [0u8; 1024];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
            let mut bytes = captured.lock().unwrap();
            bytes.extend_from_slice(&chunk[..count]);
            let excess = bytes.len().saturating_sub(16384);
            bytes.drain(..excess);
        }
    }));
    match package_handshake(&mut input, &mut output).await {
        Ok(info) => Ok(info),
        Err(error) => {
            let _ = tokio::time::timeout(Duration::from_millis(100), &mut stderr_task.0).await;
            Err(package_startup_error(
                &logs.lock().unwrap(),
                error,
                config.command.as_deref(),
            ))
        }
    }
}

fn package_startup_error(logs: &[u8], fallback: String, runtime: Option<&str>) -> String {
    let text = String::from_utf8_lossy(logs);
    if [
        "UnknownIssuer",
        "CERTIFICATE_VERIFY_FAILED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]
    .iter()
    .any(|code| text.contains(code))
    {
        return if runtime == Some("uvx") {
            "uv could not verify the package registry certificate. Check its certificate settings; UV_SYSTEM_CERTS=true uses the system trust store.".into()
        } else {
            "The package manager could not verify the registry certificate. Check the runtime's certificate settings.".into()
        };
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_diagnostics_never_return_provider_output_or_credentials() {
        let error = package_startup_error(
            b"API_KEY=private-value invalid peer certificate: UnknownIssuer",
            "Server exited".into(),
            Some("uvx"),
        );
        assert!(error.contains("UV_SYSTEM_CERTS"));
        assert!(!error.contains("private-value"));
        assert_eq!(
            package_startup_error(
                b"API_KEY=private-value",
                "Server exited".into(),
                Some("npx")
            ),
            "Server exited"
        );
    }
}

async fn package_send<W: tokio::io::AsyncWrite + Unpin>(
    input: &mut W,
    message: Value,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut bytes =
        serde_json::to_vec(&message).map_err(|_| "Could not prepare the MCP request.")?;
    bytes.push(b'\n');
    input.write_all(&bytes).await.map_err(|_| "The server exited. Check the package name, version, startup arguments, and environment variables.")?;
    input
        .flush()
        .await
        .map_err(|_| "The server closed its input.".to_string())
}

pub(super) async fn package_response<W, R>(input: &mut W, output: &mut R, id: u64) -> Result<Value>
where
    W: tokio::io::AsyncWrite + Unpin,
    R: tokio::io::AsyncBufRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    loop {
        let mut bytes = Vec::new();
        let count = (&mut *output)
            .take((MAX_BODY + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| "Could not read the MCP response.")?;
        if count == 0 {
            return Err("The server exited before connecting. Check the package name, version, startup arguments, and required environment variables.".into());
        }
        if bytes.len() > MAX_BODY {
            return Err("The MCP response is too large.".into());
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let message: Value = serde_json::from_slice(&bytes).map_err(|_| "The package did not return valid MCP messages. Check its executable and startup arguments.")?;
        if message["jsonrpc"] != "2.0" {
            return Err("The package did not return a valid MCP response.".into());
        }
        if !message["method"].is_null() {
            if !message["id"].is_null() {
                package_send(input, json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"This connection checks MCP metadata only."}})).await?;
            }
            continue;
        }
        if message["id"] == id {
            return Ok(message);
        }
        // Some older implementations use a generic error id on discovery.
        if !message["error"].is_null() {
            return Ok(message);
        }
    }
}

pub(super) async fn package_handshake<W, R>(
    input: &mut W,
    output: &mut R,
) -> Result<(Option<ServerInfo>, Option<usize>)>
where
    W: tokio::io::AsyncWrite + Unpin,
    R: tokio::io::AsyncBufRead + Unpin,
{
    let modern_meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"Grove","version":env!("CARGO_PKG_VERSION")},"io.modelcontextprotocol/clientCapabilities":{}});
    package_send(
        input,
        json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":modern_meta}}),
    )
    .await?;
    let mut response = package_response(input, output, 1).await?;
    let modern = response["result"]["supportedVersions"]
        .as_array()
        .is_some_and(|versions| versions.iter().any(|v| v == "2026-07-28"));
    if !modern {
        package_send(input, json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Grove","version":env!("CARGO_PKG_VERSION")}}})).await?;
        response = package_response(input, output, 2).await?;
        if !response["error"].is_null() {
            return Err("The server could not initialize. Check its required environment variables and startup arguments.".into());
        }
        if !matches!(
            response["result"]["protocolVersion"].as_str(),
            Some("2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25")
        ) {
            return Err("This MCP package uses an unsupported protocol version.".into());
        }
        package_send(
            input,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await?;
    }
    let result = &response["result"];
    let info = if modern {
        server_info(&result["_meta"]["io.modelcontextprotocol/serverInfo"])
    } else {
        server_info(&result["serverInfo"])
    };
    let count = if result["capabilities"]["tools"].is_object() {
        let mut count = 0usize;
        let mut cursor = None;
        let mut seen = std::collections::HashSet::new();
        for page in 0..128 {
            let mut params = if modern {
                json!({"_meta":modern_meta})
            } else {
                json!({})
            };
            if let Some(value) = &cursor {
                params["cursor"] = json!(value);
            }
            let id = 3 + page;
            package_send(
                input,
                json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":params}),
            )
            .await?;
            let tools = package_response(input, output, id).await?;
            let items = tools["result"]["tools"].as_array().ok_or("The server connected but could not list its tools. Check the supplied credentials.")?;
            count = count.saturating_add(items.len());
            cursor = tools["result"]["nextCursor"].as_str().map(str::to_string);
            match &cursor {
                None => break,
                Some(value) if seen.insert(value.clone()) && page < 127 => {}
                Some(_) => return Err("The server did not finish listing its tools.".into()),
            }
        }
        Some(count)
    } else {
        None
    };
    Ok((info, count))
}

//! `contributes.backend` — a plugin's private node backend process that its
//! panel talks to over Grove-mediated JSON-RPC (newline-delimited, over stdio).
//! Independent of `contributes.mcp` (which serves the AI agent): a plugin may
//! ship either, both, or neither.
//!
//! Two-hop transport:
//! ```text
//!   panel iframe ─postMessage→ Grove web host ─HTTP→ this manager ─stdio→ node
//! ```
//! `grove.backend.invoke(method, params)` in the panel becomes a
//! `{ id, method, params }` line on the process's stdin; the matching
//! `{ id, result | error }` line on stdout resolves the call.
//!
//! One process per **(plugin, scope key)**: a task panel keys on its task id
//! (the process is launched with that task's project fs access); app-wide events
//! and integrations use `"global"` (no project access). Task processes are
//! reaped on idle; global processes live until exit or plugin uninstall.
//!
//! The node process follows the same runtime policy as the MCP server (see
//! [`super::runtime`]): scoped permissions use Node's Permission Model, while
//! `exec` runs unrestricted because it already grants full machine trust.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::error::{GroveError, Result};

/// Per-request timeout for a backend invoke.
const INVOKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Reap a backend process after this long with no invoke.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

static BACKENDS: Lazy<RwLock<HashMap<String, Arc<Backend>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Lazily-started idle reaper (forced on first invoke; runs in the tokio rt).
static REAPER: Lazy<()> = Lazy::new(|| {
    tokio::spawn(reaper_loop());
});

struct Backend {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>,
    next_id: AtomicU64,
    last_used: Mutex<Instant>,
}

impl Backend {
    async fn send_event(&self, name: &str, data: &Value) -> Result<()> {
        let line = json!({ "type": "grove:event", "name": name, "data": data }).to_string() + "\n";
        self.stdin
            .lock()
            .await
            .write_all(line.as_bytes())
            .await
            .map_err(|error| GroveError::session(format!("backend stdin write failed: {error}")))?;
        *self.last_used.lock().await = Instant::now();
        Ok(())
    }

    async fn send_host_response(
        &self,
        id: u64,
        result: std::result::Result<Value, String>,
    ) -> Result<()> {
        let value = match result {
            Ok(result) => json!({ "type": "grove:host_response", "id": id, "result": result }),
            Err(message) => json!({
                "type": "grove:host_response",
                "id": id,
                "error": { "message": message },
            }),
        };
        self.stdin
            .lock()
            .await
            .write_all((value.to_string() + "\n").as_bytes())
            .await
            .map_err(|error| GroveError::session(format!("backend stdin write failed: {error}")))?;
        Ok(())
    }
}

fn key(plugin_id: &str, scope_key: &str) -> String {
    format!("{}::{}", plugin_id, scope_key)
}

/// Invoke `method` on a plugin's backend, spawning the process if needed.
/// `task` is `Some((project_id, task_id))` for a task panel (the process gets
/// that task's project fs access); `None` for an app-scoped sidebar panel.
pub async fn invoke(
    plugin_id: &str,
    task: Option<(&str, &str)>,
    method: &str,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    // Default 30s; a caller can raise it for a slow op, clamped to [1s, 10min].
    let invoke_timeout = timeout_ms
        .map(|m| Duration::from_millis(m.clamp(1_000, 600_000)))
        .unwrap_or(INVOKE_TIMEOUT);
    Lazy::force(&REAPER);
    let scope_key = task
        .map(|(_, t)| t.to_string())
        .unwrap_or_else(|| "global".to_string());
    let backend = get_or_spawn(plugin_id, task, &scope_key).await?;

    let id = backend.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    backend.pending.lock().await.insert(id, tx);

    let line = json!({ "id": id, "method": method, "params": params }).to_string() + "\n";
    {
        let mut stdin = backend.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| GroveError::session(format!("backend stdin write failed: {}", e)))?;
        stdin.flush().await.ok();
    }
    *backend.last_used.lock().await = Instant::now();

    match tokio::time::timeout(invoke_timeout, rx).await {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(msg))) => Err(GroveError::session(format!("backend error: {}", msg))),
        Ok(Err(_)) => Err(GroveError::session(
            "backend process closed before replying".to_string(),
        )),
        Err(_) => {
            backend.pending.lock().await.remove(&id);
            Err(GroveError::session("backend invoke timed out".to_string()))
        }
    }
}

/// Type-erased invocation for callers reached indirectly from backend host calls.
pub fn invoke_boxed<'a>(
    plugin_id: &'a str,
    task: Option<(&'a str, &'a str)>,
    method: &'a str,
    params: Value,
    timeout_ms: Option<u64>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(invoke(plugin_id, task, method, params, timeout_ms))
}

/// Start a plugin's app-scoped backend without inventing a second runtime.
/// Event-driven plugins are started once with the rest of the plugin runtime;
/// process exit is handled by the existing backend manager and is not supervised.
pub async fn ensure_global(plugin_id: &str) -> Result<()> {
    let _ = get_or_spawn(plugin_id, None, "global").await?;
    Ok(())
}

/// Deliver a Grove event to one plugin backend. The same event envelope is used
/// by panel subscriptions, so plugin code can share handlers across surfaces.
pub async fn send_event(plugin_id: &str, name: &str, data: Value) -> Result<()> {
    let backend = get_or_spawn(plugin_id, None, "global").await?;
    backend.send_event(name, &data).await
}

fn manifest_has(plugin: &crate::storage::plugins::Plugin, contribution: &str) -> bool {
    std::fs::read_to_string(std::path::Path::new(&plugin.local_path).join("plugin.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|manifest| {
            manifest
                .get("contributes")
                .and_then(|value| value.get(contribution))
                .cloned()
        })
        .is_some()
}

fn plugin_has_permission(plugin_id: &str, permission: &str) -> bool {
    let Ok(Some(plugin)) = crate::storage::plugins::get(plugin_id) else {
        return false;
    };
    std::fs::read_to_string(std::path::Path::new(&plugin.local_path).join("plugin.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|manifest| manifest.get("permissions").cloned())
        .and_then(|permissions| permissions.as_array().cloned())
        .is_some_and(|permissions| {
            permissions
                .iter()
                .any(|value| value.as_str() == Some(permission))
        })
}

/// Start existing plugin backends so they can subscribe to Grove events even
/// when no panel is open. This is ordinary plugin lifecycle, not crash recovery.
async fn start_registered_backend(plugin: &crate::storage::plugins::Plugin) {
    let consumes_host_events =
        plugin_has_permission(&plugin.id, "chat:read") || manifest_has(plugin, "connectProviders");
    if manifest_has(plugin, "backend") && consumes_host_events {
        if let Err(error) = ensure_global(&plugin.id).await {
            eprintln!("[plugin:{}] failed to start backend: {error}", plugin.name);
        }
    }
}

/// Re-registration may replace a dev plugin's code or contributions. Retire its
/// old processes, then activate the current manifest as part of plugin lifecycle.
pub async fn registered(plugin: &crate::storage::plugins::Plugin) {
    shutdown_plugin(&plugin.id).await;
    start_registered_backend(plugin).await;
}

pub async fn start_global_backends() {
    for plugin in crate::storage::plugins::list().unwrap_or_default() {
        start_registered_backend(&plugin).await;
    }
}

/// Fan one Radio event into every running backend allowed to observe chat
/// activity. App-scoped backends receive every task; task-scoped backends only
/// receive their own task.
pub async fn publish_radio(task_id: &str, data: Value) {
    let backends = BACKENDS
        .read()
        .await
        .iter()
        .filter_map(|(key, backend)| {
            let (plugin_id, scope) = key.split_once("::")?;
            (scope == "global" || scope == task_id).then(|| (plugin_id.to_owned(), backend.clone()))
        })
        .collect::<Vec<_>>();
    for (plugin_id, backend) in backends {
        if plugin_has_permission(&plugin_id, "chat:read") {
            let _ = backend.send_event("grove:radio", &data).await;
        }
    }
}

/// Kill every backend process for a plugin (called on uninstall).
pub async fn shutdown_plugin(plugin_id: &str) {
    let prefix = format!("{}::", plugin_id);
    let mut map = BACKENDS.write().await;
    let keys: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for k in keys {
        if let Some(b) = map.remove(&k) {
            let _ = b.child.lock().await.start_kill();
        }
    }
}

async fn get_or_spawn(
    plugin_id: &str,
    task: Option<(&str, &str)>,
    scope_key: &str,
) -> Result<Arc<Backend>> {
    let k = key(plugin_id, scope_key);
    if let Some(b) = BACKENDS.read().await.get(&k).cloned() {
        return Ok(b);
    }
    let mut map = BACKENDS.write().await;
    if let Some(b) = map.get(&k).cloned() {
        return Ok(b); // lost the race; reuse the winner
    }
    let backend = spawn(plugin_id, task, scope_key).await?;
    map.insert(k, backend.clone());
    Ok(backend)
}

/// Resolved details of the task a backend is scoped to.
struct TaskInfo {
    worktree: String,
    name: String,
    branch: String,
    target: String,
    project_name: String,
    project_path: String,
}

fn resolve_task(project_id: &str, task_id: &str) -> Option<TaskInfo> {
    let projects = crate::storage::workspace::load_projects().ok()?;
    let p = projects
        .iter()
        .find(|p| crate::storage::workspace::project_hash(&p.path) == project_id)?;
    let task = crate::storage::tasks::get_task(project_id, task_id).ok()??;
    Some(TaskInfo {
        worktree: task.worktree_path,
        name: task.name,
        branch: task.branch,
        target: task.target,
        project_name: p.name.clone(),
        project_path: p.path.clone(),
    })
}

async fn spawn(
    plugin_id: &str,
    task: Option<(&str, &str)>,
    scope_key: &str,
) -> Result<Arc<Backend>> {
    let plugin = crate::storage::plugins::get(plugin_id)?
        .ok_or_else(|| GroveError::not_found(format!("plugin not found: {}", plugin_id)))?;

    let manifest_path = std::path::Path::new(&plugin.local_path).join("plugin.json");
    let manifest: Value = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| GroveError::not_found("plugin manifest unreadable".to_string()))?;
    let decl = manifest
        .get("contributes")
        .and_then(|c| c.get("backend"))
        .ok_or_else(|| {
            GroveError::not_found("plugin declares no contributes.backend".to_string())
        })?;

    // Resolve command/args files relative to the plugin folder (like the MCP path).
    let plugin_dir = std::path::Path::new(&plugin.local_path);
    let resolve = |s: &str| -> String {
        let candidate = plugin_dir.join(s);
        if candidate.is_file() {
            candidate.display().to_string()
        } else {
            s.to_string()
        }
    };
    let command = match decl.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => resolve(c),
        _ => {
            return Err(GroveError::not_found(
                "contributes.backend has no command".to_string(),
            ))
        }
    };
    let user_args: Vec<String> = decl
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(resolve).collect())
        .unwrap_or_default();
    let perms: std::collections::HashSet<String> = manifest
        .get("permissions")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let task_info = match task {
        Some((pid, tid)) => resolve_task(pid, tid),
        None => None,
    };
    let project_dir = task_info.as_ref().map(|t| t.worktree.clone());

    let storage_root = crate::storage::plugin_data::data_dir(plugin_id);
    let _ = std::fs::create_dir_all(&storage_root);

    // Node runtime gating + permission flags (same policy as the MCP server).
    let mut args: Vec<String> = Vec::new();
    if super::runtime::is_node_command(&command) {
        if !super::runtime::node_supports_permissions(&command) {
            return Err(GroveError::config(format!(
                "plugin '{}' backend needs node >= {} (check `node --version`)",
                plugin.name,
                super::runtime::MIN_NODE_MAJOR
            )));
        }
        args = super::runtime::node_permission_flags(
            &perms,
            &plugin.local_path,
            &storage_root.display().to_string(),
            project_dir.as_deref(),
        );
    }
    args.extend(user_args);

    let context = build_context(&plugin, task, task_info.as_ref(), &storage_root);

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
        .env("GROVE_CONTEXT", context.to_string())
        // The backend reaches Grove over its own stdout (we own this pipe), so
        // grove.events.emit writes a notification line rather than calling HTTP.
        .env("GROVE_EVENTS_TRANSPORT", "stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Manifest-declared extra env.
    if let Some(env) = decl.get("env").and_then(|v| v.as_object()) {
        for (k, v) in env {
            if let Some(s) = v.as_str() {
                cmd.env(k, s);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| GroveError::session(format!("failed to spawn plugin backend: {}", e)))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| GroveError::session("backend stdin unavailable".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GroveError::session("backend stdout unavailable".to_string()))?;
    let stderr = child.stderr.take();

    let backend = Arc::new(Backend {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        last_used: Mutex::new(Instant::now()),
    });

    tokio::spawn(reader_loop(
        stdout,
        Arc::downgrade(&backend),
        plugin_id.to_string(),
        scope_key.to_string(),
    ));
    if let Some(err) = stderr {
        tokio::spawn(drain_stderr(err, plugin.name.clone()));
    }
    Ok(backend)
}

/// The `GROVE_CONTEXT` blob handed to the backend — the same shape the MCP
/// server gets, so `getGroveContext()` works identically on both.
fn build_context(
    plugin: &crate::storage::plugins::Plugin,
    task: Option<(&str, &str)>,
    info: Option<&TaskInfo>,
    storage_root: &std::path::Path,
) -> Value {
    use crate::storage::plugin_data::{scope_dir, Scope};
    let dir_str = |s: Scope| {
        scope_dir(&plugin.id, &s)
            .ok()
            .map(|p| p.display().to_string())
    };
    let project_id = task.map(|(p, _)| p.to_string());
    let task_id = task.map(|(_, t)| t.to_string());
    let project_type = info.map(|i| {
        if i.worktree.contains("studios") {
            "studio"
        } else {
            "repo"
        }
    });
    json!({
        "projectId": project_id,
        "projectName": info.map(|i| i.project_name.clone()),
        "projectPath": info.map(|i| i.project_path.clone()),
        "projectType": project_type,
        "projectDir": info.map(|i| i.worktree.clone()),
        "taskId": task_id,
        "taskName": info.map(|i| i.name.clone()),
        "branch": info.map(|i| i.branch.clone()),
        "target": info.map(|i| i.target.clone()),
        "pluginDir": plugin.local_path,
        "dataDir": storage_root.display().to_string(),
        "storage": {
            "global": dir_str(Scope::Global),
            "project": project_id.clone().and_then(|p| dir_str(Scope::Project(p))),
            "task": project_id
                .clone()
                .zip(task_id.clone())
                .and_then(|(p, t)| dir_str(Scope::Task(p, t))),
        },
    })
}

/// Read JSON-RPC response lines off stdout and resolve pending invokes. On EOF
/// (process exit/crash) the backend is removed from the registry and all
/// pending calls fail, so the next invoke respawns a fresh process.
async fn reader_loop(stdout: ChildStdout, weak: Weak<Backend>, plugin_id: String, task_id: String) {
    let map_key = key(&plugin_id, &task_id);
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // ignore non-JSON chatter
        };
        // Event push (grove.events.emit on the backend) — fan out to the panel.
        if v.get("type").and_then(|t| t.as_str()) == Some("grove:event") {
            if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                crate::plugins::events::publish(
                    &plugin_id,
                    &task_id,
                    &json!({ "name": name, "data": data }),
                );
            }
            continue;
        }
        // Backend → Grove API call. This makes the existing plugin backend
        // transport bidirectional; Connect is one consumer, not a new runtime.
        if v.get("type").and_then(|t| t.as_str()) == Some("grove:host_call") {
            let Some(id) = v.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(method) = v.get("method").and_then(Value::as_str) else {
                continue;
            };
            let Some(backend) = weak.upgrade() else {
                break;
            };
            let plugin_id = plugin_id.clone();
            let method = method.to_owned();
            let params = v.get("params").cloned().unwrap_or(Value::Null);
            tokio::spawn(async move {
                let result = if method == "usage.totalTokens" {
                    let allowed = plugin_has_permission(&plugin_id, "chat:read");
                    let from = params.get("fromTs").and_then(Value::as_i64);
                    let to = params.get("toTs").and_then(Value::as_i64);
                    match (allowed, from, to) {
                        (true, Some(from), Some(to)) if from < to => {
                            crate::storage::token_usage::total_tokens(from, to)
                                .map(|total| json!({ "totalTokens": total }))
                                .map_err(|error| error.to_string())
                        }
                        _ => Err(
                            "usage.totalTokens requires chat:read and a valid time range"
                                .to_string(),
                        ),
                    }
                } else {
                    crate::plugins::connect_provider::handle_host_call(&plugin_id, &method, params)
                        .await
                        .map_err(|error| error.to_string())
                };
                let _ = backend.send_host_response(id, result).await;
            });
            continue;
        }
        let Some(backend) = weak.upgrade() else {
            break;
        };
        if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
            if let Some(tx) = backend.pending.lock().await.remove(&id) {
                let payload = if let Some(err) = v.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("backend error")
                        .to_string();
                    Err(msg)
                } else {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(payload);
            }
        }
        // Notifications (no id) are reserved for a future push channel.
    }
    if let Some(backend) = weak.upgrade() {
        let mut pending = backend.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("backend process exited".to_string()));
        }
    }
    let mut backends = BACKENDS.write().await;
    if let (Some(exited), Some(current)) = (weak.upgrade(), backends.get(&map_key)) {
        if Arc::ptr_eq(&exited, current) {
            backends.remove(&map_key);
        }
    }
}

/// Forward a backend's stderr to Grove's stderr, prefixed with the plugin name.
async fn drain_stderr(stderr: ChildStderr, plugin_name: String) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[plugin:{}] {}", plugin_name, line);
    }
}

async fn reaper_loop() {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let now = Instant::now();
        let mut stale: Vec<String> = Vec::new();
        {
            let map = BACKENDS.read().await;
            for (k, b) in map.iter() {
                // App-scoped backends may subscribe to Grove events or maintain
                // their own external integrations. Keep them alive normally;
                // there is intentionally no crash supervisor or restart loop.
                if k.ends_with("::global") {
                    continue;
                }
                if now.duration_since(*b.last_used.lock().await) > IDLE_TIMEOUT {
                    stale.push(k.clone());
                }
            }
        }
        if !stale.is_empty() {
            let mut map = BACKENDS.write().await;
            for k in stale {
                if let Some(b) = map.remove(&k) {
                    // Re-check under the write lock: a backend invoked between the
                    // read and write phases must not be killed mid-RPC (TOCTOU).
                    if now.duration_since(*b.last_used.lock().await) <= IDLE_TIMEOUT {
                        map.insert(k, b);
                        continue;
                    }
                    let _ = b.child.lock().await.start_kill();
                }
            }
        }
    }
}

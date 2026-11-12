//! Browser control for agents: a thin pass-through to agent-browser.
//!
//! An agent names an agent-browser tool and its arguments; Grove runs it and
//! returns the result as it came. Grove owns only what is around the call:
//! which browser a call reaches (each Task's test browser, or the user's own
//! through the Companion; see [`relay`]), the user's approval for their own
//! browser, the sensitive-tool switch, and the panel that shows the pages.

pub mod driver;
pub mod relay;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::session_approval::{self, Capability, Decision, Requester};
use crate::storage::config;

const TOOL_PREFIX: &str = "agent_browser_";
/// How long Grove waits for one process before giving up on it. The tool's own
/// `timeoutMs` argument governs the command itself.
const PROCESS_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PANEL_TIMEOUT: Duration = Duration::from_secs(15);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// Arguments, command-line flags and tools that would move a call to another
/// browser than the one Grove bound it to, or hand out the bound browser's
/// connection to use without Grove, which would get around the approval and
/// the sensitive-tool switch.
const BINDING_ARGS: &[&str] = &["session", "namespace", "restore"];
const BINDING_FLAGS: &[&str] = &[
    "--auto-connect",
    "--cdp",
    "--namespace",
    "--profile",
    "--provider",
    "--restore",
    "--session",
    "--state",
];
const BINDING_TOOLS: &[&str] = &["connect", "get_cdp_url"];

/// Tools that reach a logged-in session's secrets, or that could run one of
/// these indirectly. Off in the personal browser unless the user turned on
/// `sensitive_tools`.
const SENSITIVE_TOOL_PREFIXES: &[&str] = &[
    "auth_",
    "clipboard_",
    "cookies_",
    "network_",
    "state_",
    "storage_",
    "trace_",
];
const SENSITIVE_TOOLS: &[&str] = &[
    "batch",
    "console",
    "errors",
    "eval",
    "set_credentials",
    "set_headers",
    "wait_for_function",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Managed,
    Personal,
}

/// The Task a call belongs to, and the chat Session making it.
pub struct Scope {
    pub project: String,
    pub task: String,
    pub chat: String,
    pub task_name: String,
    pub cwd: PathBuf,
}

#[derive(Default)]
struct SessionState {
    /// The browser the last call used, which the panel shows first.
    target: Option<Target>,
    /// Every browser this Task has used.
    connected: Vec<Target>,
}

/// One Task's browsers.
struct Session {
    key: String,
    restore_key: String,
    relay_token: String,
    state: Mutex<SessionState>,
    cwd: Mutex<PathBuf>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(Default::default);

/// agent-browser only accepts letters, numbers, hyphens and underscores.
fn short_hash(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hasher.finalize()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn session_key(project: &str, task: &str) -> String {
    format!("grove-{}", short_hash(&[project, task]))
}

fn session_for(scope: &Scope) -> Arc<Session> {
    let key = session_key(&scope.project, &scope.task);
    let mut sessions = SESSIONS.lock().unwrap();
    let session = sessions.entry(key.clone()).or_insert_with(|| {
        Arc::new(Session {
            key,
            restore_key: format!("grove-project-{}", short_hash(&[&scope.project])),
            relay_token: uuid::Uuid::new_v4().simple().to_string(),
            state: Mutex::default(),
            cwd: Mutex::new(scope.cwd.clone()),
        })
    });
    *session.cwd.lock().unwrap() = scope.cwd.clone();
    session.clone()
}

fn find_session(project: &str, task: &str) -> Option<Arc<Session>> {
    SESSIONS
        .lock()
        .unwrap()
        .get(&session_key(project, task))
        .cloned()
}

/// Which browser a call reaches. Each browser gets its own agent-browser
/// session, so moving between them leaves both as they were.
fn build_env(session: &Session, target: Target) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    match target {
        Target::Managed => {
            env.insert("AGENT_BROWSER_SESSION".to_string(), session.key.clone());
            // Logins carry across a Project's Tasks.
            env.insert(
                "AGENT_BROWSER_RESTORE".to_string(),
                session.restore_key.clone(),
            );
        }
        Target::Personal => {
            env.insert(
                "AGENT_BROWSER_SESSION".to_string(),
                format!("{}-personal", session.key),
            );
            let port = crate::api::handlers::agent_graph_mcp::listener_port()
                .ok_or("Grove's local listener is not running.")?;
            env.insert(
                "AGENT_BROWSER_CDP".to_string(),
                format!(
                    "ws://127.0.0.1:{port}/browser-relay/{}",
                    session.relay_token
                ),
            );
        }
    }
    Ok(env)
}

// ─── Calling agent-browser ───────────────────────────────────────────────────

fn tool_name(tool: &str) -> Result<String, String> {
    let name = tool.trim().trim_start_matches(TOOL_PREFIX);
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !valid {
        return Err(format!("Unknown browser tool: {tool}"));
    }
    Ok(name.to_string())
}

/// Refuse a call that would move to another browser than Grove's binding.
fn check_binding(tool: &str, args: &Value) -> Result<(), String> {
    const REFUSAL: &str =
        "Grove chooses the browser: use `target` to pick the test browser or the user's own.";
    if BINDING_TOOLS.contains(&tool) {
        return Err(REFUSAL.to_string());
    }
    let Some(object) = args.as_object() else {
        return Ok(());
    };
    if BINDING_ARGS.iter().any(|arg| object.contains_key(*arg)) {
        return Err(REFUSAL.to_string());
    }
    let extra = object.get("extraArgs").and_then(Value::as_array);
    let rebinds = extra
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|arg| {
            BINDING_FLAGS
                .iter()
                .any(|flag| arg == *flag || arg.starts_with(&format!("{flag}=")))
        });
    if rebinds {
        return Err(REFUSAL.to_string());
    }
    Ok(())
}

fn is_sensitive_tool(tool: &str) -> bool {
    SENSITIVE_TOOLS.contains(&tool)
        || SENSITIVE_TOOL_PREFIXES
            .iter()
            .any(|prefix| tool.starts_with(prefix))
}

/// Run one tool and return agent-browser's `tools/call` result.
async fn call_driver(
    session: &Session,
    target: Target,
    tool: &str,
    args: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let env = build_env(session, target)?;
    let cwd = session.cwd.lock().unwrap().clone();
    let output = driver::run(driver::Invocation {
        args: vec![
            "mcp".to_string(),
            "call".to_string(),
            format!("{TOOL_PREFIX}{tool}"),
            "-".to_string(),
        ],
        env,
        cwd: &cwd,
        stdin: Some(args.to_string()),
        timeout,
    })
    .await?;
    serde_json::from_str(output.stdout.trim()).map_err(|_| {
        driver::last_line(&output.stderr)
            .or_else(|| driver::last_line(&output.stdout))
            .unwrap_or_else(|| "agent-browser returned nothing.".to_string())
    })
}

/// Which browser this call goes to. The user's own browser is chosen call by
/// call: a call that does not name it lands in the test browser.
fn resolve_target(personal_browser: bool, requested: Option<Target>) -> Result<Target, String> {
    match requested {
        Some(Target::Personal) if !personal_browser => Err(
            "The user does not let agents use their own browser. Enable it in Grove Settings."
                .to_string(),
        ),
        requested => Ok(requested.unwrap_or(Target::Managed)),
    }
}

/// Run a tool for an agent. Returns agent-browser's `tools/call` result as it
/// came, or why the call was not made.
pub async fn invoke(
    scope: &Scope,
    tool: &str,
    args: Value,
    requested: Option<Target>,
) -> Result<Value, String> {
    let settings = config::load_config().browser_control;
    let tool = tool_name(tool)?;
    let args = if args.is_null() { json!({}) } else { args };
    check_binding(&tool, &args)?;
    let target = resolve_target(settings.personal_browser, requested)?;
    if target == Target::Personal && !settings.sensitive_tools && is_sensitive_tool(&tool) {
        return Err(
            "This tool can read login data, so it is off in the user's own browser. Use the test browser, or ask the user to allow sensitive tools in Grove Settings."
                .to_string(),
        );
    }

    let session = session_for(scope);
    match target {
        Target::Personal => {
            relay::ensure_companion()?;
            let requester = Requester {
                project: scope.project.clone(),
                task: scope.task.clone(),
                chat: scope.chat.clone(),
            };
            if !settings.personal_browser_bypass {
                match session_approval::wait(
                    &requester,
                    Capability::PersonalBrowser,
                    APPROVAL_TIMEOUT,
                )
                .await
                {
                    Decision::Allowed => {}
                    Decision::Denied => return Err("The user refused to let you use their own browser. Continue in the test browser or ask them directly.".to_string()),
                    Decision::Unanswered => return Err("The user did not answer the request to use their own browser within 2 minutes; they may be away. Continue in the test browser, or try again later.".to_string()),
                }
            }
            relay::register_token(
                &session.relay_token,
                &session.key,
                settings.auto_groups.then(|| scope.task_name.clone()),
            );
        }
        Target::Managed => {
            if let Some(notice) = prepare_managed_browser() {
                return Err(notice);
            }
        }
    }
    {
        let mut state = session.state.lock().unwrap();
        state.target = Some(target);
        if !state.connected.contains(&target) {
            state.connected.push(target);
        }
    }
    let mut result = call_driver(&session, target, &tool, &args, PROCESS_TIMEOUT).await?;
    drop_lifecycle(&mut result);
    Ok(result)
}

/// agent-browser reports its daemon's launch bookkeeping (`lifecycle`) in
/// every result, several times over: under `data`, or under each step's
/// `result` for a batch. It says nothing about the page, so it is removed.
/// `structuredContent.stdout` is `structuredContent.response` again as a
/// string, so it is removed too; everything else is left as it came.
fn drop_lifecycle(result: &mut Value) {
    fn without_lifecycle(value: &mut Value) -> bool {
        let mut removed = false;
        if let Some(data) = value.get_mut("data").and_then(Value::as_object_mut) {
            removed |= data.remove("lifecycle").is_some();
        }
        for step in value.as_array_mut().into_iter().flatten() {
            if let Some(result) = step.get_mut("result").and_then(Value::as_object_mut) {
                removed |= result.remove("lifecycle").is_some();
            }
        }
        removed
    }
    // The same response also arrives as JSON text.
    fn rewrite_text(text: &mut Value) {
        let Some(mut parsed) = text
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
        else {
            return;
        };
        if without_lifecycle(&mut parsed) {
            if let Ok(rewritten) = serde_json::to_string_pretty(&parsed) {
                *text = Value::String(rewritten);
            }
        }
    }
    if let Some(blocks) = result.get_mut("content").and_then(Value::as_array_mut) {
        for block in blocks {
            if let Some(text) = block.get_mut("text") {
                rewrite_text(text);
            }
        }
    }
    if let Some(structured) = result
        .get_mut("structuredContent")
        .and_then(Value::as_object_mut)
    {
        if let Some(response) = structured.get_mut("response") {
            without_lifecycle(response);
        }
        structured.remove("stdout");
    }
}

// ─── First use ───────────────────────────────────────────────────────────────

#[derive(Clone)]
enum Preparation {
    Running,
    Ready,
    Failed(String),
}

static PREPARATION: Mutex<Option<Preparation>> = Mutex::new(None);

fn install_marker() -> PathBuf {
    crate::storage::grove_dir()
        .join("browser")
        .join("installed")
}

/// The browser agent-browser was told to launch, through its environment
/// variable or its user config file, if any.
fn configured_browser() -> Option<String> {
    if let Ok(path) = std::env::var("AGENT_BROWSER_EXECUTABLE_PATH") {
        if !path.trim().is_empty() {
            return Some(path.trim().to_string());
        }
    }
    let file = std::env::var_os("AGENT_BROWSER_CONFIG")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".agent-browser").join("config.json")))?;
    executable_path_in(&std::fs::read_to_string(file).ok()?)
}

/// `executablePath` from an agent-browser config file, when it names one.
fn executable_path_in(config: &str) -> Option<String> {
    let config: Value = serde_json::from_str(config).ok()?;
    let path = config.get("executablePath")?.as_str()?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// The test browser is downloaded on first use. That takes minutes, longer
/// than a tool call should hang, so it runs in the background meanwhile.
/// Nothing is downloaded when agent-browser was given a browser to use.
fn prepare_managed_browser() -> Option<String> {
    if install_marker().exists() || configured_browser().is_some() {
        return None;
    }
    let mut preparation = PREPARATION.lock().unwrap();
    match preparation.clone() {
        Some(Preparation::Ready) => None,
        Some(Preparation::Running) => Some(PREPARING.to_string()),
        Some(Preparation::Failed(error)) => {
            *preparation = None;
            Some(install_failed(&error))
        }
        None => {
            *preparation = Some(Preparation::Running);
            tokio::spawn(async {
                let outcome = match driver::install_browser().await {
                    Ok(()) => {
                        let marker = install_marker();
                        if let Some(parent) = marker.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(marker, "");
                        Preparation::Ready
                    }
                    Err(error) => Preparation::Failed(error),
                };
                *PREPARATION.lock().unwrap() = Some(outcome);
            });
            Some(PREPARING.to_string())
        }
    }
}

/// What the agent is told when the test browser cannot be downloaded, such
/// as on Linux ARM64 where no Chrome for Testing build exists: install a
/// browser and tell agent-browser where it is.
fn install_failed(error: &str) -> String {
    format!(
        "The test browser could not be installed on this machine ({os}/{arch}). agent-browser said:\n{error}\n\n\
         Install Chrome or Chromium yourself (for example `sudo apt install chromium` on Debian/Ubuntu; \
         ask the user if it needs their password), then set \"executablePath\" to its path in \
         ~/.agent-browser/config.json, for example {{\"executablePath\": \"/usr/bin/chromium\"}}, \
         and retry. Grove uses that browser from then on.",
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
    )
}

const PREPARING: &str =
    "Grove is installing the test browser for first use. This takes a minute or two; retry this call shortly.";

// ─── Help ────────────────────────────────────────────────────────────────────

/// `topic` is empty for the tool list, "guide" for agent-browser's own guide,
/// or a tool name for that tool's definition.
pub async fn help(topic: Option<&str>) -> Result<String, String> {
    match topic.map(str::trim).filter(|topic| !topic.is_empty()) {
        Some("guide") => {
            let home = crate::storage::grove_dir();
            let output = driver::run(driver::Invocation {
                args: ["skills", "get", "core"].map(str::to_string).to_vec(),
                env: HashMap::new(),
                cwd: &home,
                stdin: None,
                timeout: Duration::from_secs(60),
            })
            .await?;
            Ok(output.stdout)
        }
        Some(topic) => {
            let wanted = format!("{TOOL_PREFIX}{}", tool_name(topic)?);
            let tools = driver::tools().await?;
            let tool = tools
                .iter()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(wanted.as_str()))
                .ok_or_else(|| format!("Unknown browser tool: {topic}"))?;
            serde_json::to_string_pretty(tool).map_err(|error| error.to_string())
        }
        None => {
            let tools = driver::tools().await?;
            let lines: Vec<String> = tools
                .iter()
                .filter_map(|tool| {
                    let name = tool.get("name")?.as_str()?.trim_start_matches(TOOL_PREFIX);
                    let description = tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    Some(format!("- {name}: {description}"))
                })
                .collect();
            Ok(lines.join("\n"))
        }
    }
}

// ─── Panel ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub active: bool,
    pub target: Option<Target>,
    pub connected: Vec<Target>,
}

pub fn status(project: &str, task: &str) -> SessionStatus {
    let Some(session) = find_session(project, task) else {
        return SessionStatus {
            active: false,
            target: None,
            connected: Vec::new(),
        };
    };
    let state = session.state.lock().unwrap();
    SessionStatus {
        active: state.target.is_some(),
        target: state.target,
        connected: state.connected.clone(),
    }
}

fn active_session(project: &str, task: &str) -> Result<(Arc<Session>, Target), String> {
    let session = find_session(project, task).ok_or("This Task has no browser yet.")?;
    let target = session.state.lock().unwrap().target;
    let target = target.ok_or("This Task has no browser yet.")?;
    Ok((session, target))
}

/// The port of a browser's live view, while agent-browser is running for it.
pub async fn stream_port(project: &str, task: &str, viewed: Option<Target>) -> Result<u16, String> {
    let (session, target) = active_session(project, task)?;
    let target = viewed.unwrap_or(target);
    let result = call_driver(&session, target, "stream_status", &json!({}), PANEL_TIMEOUT).await?;
    result
        .pointer("/structuredContent/response/data/port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| "The browser is not streaming.".to_string())
}

/// Show another tab in the panel. agent-browser streams the tab it is on, so
/// the agent moves there too.
pub async fn switch_tab(
    project: &str,
    task: &str,
    target: Target,
    tab: &str,
) -> Result<(), String> {
    let (session, _) = active_session(project, task)?;
    let result = call_driver(
        &session,
        target,
        "tab_switch",
        &json!({"tab": tab}),
        PANEL_TIMEOUT,
    )
    .await?;
    if result.get("isError") == Some(&Value::Bool(true)) {
        let text = result.pointer("/content/0/text").and_then(Value::as_str);
        return Err(text.unwrap_or("The browser refused that.").to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_browser_named_in_the_agent_browser_config() {
        assert_eq!(
            executable_path_in(r#"{"executablePath": " /usr/bin/chromium "}"#).as_deref(),
            Some("/usr/bin/chromium")
        );
        assert_eq!(executable_path_in(r#"{"executablePath": ""}"#), None);
        assert_eq!(executable_path_in(r#"{"headed": true}"#), None);
        assert_eq!(executable_path_in("not json"), None);
    }

    #[test]
    fn an_install_failure_tells_the_agent_what_to_do() {
        let text = install_failed("Chrome for Testing does not provide Linux ARM64 builds.");
        assert!(text.contains("does not provide Linux ARM64 builds"));
        assert!(text.contains("~/.agent-browser/config.json"));
        assert!(text.contains("\"executablePath\""));
    }

    #[test]
    fn accepts_tool_names_with_or_without_the_prefix() {
        assert_eq!(tool_name("click").unwrap(), "click");
        assert_eq!(tool_name("agent_browser_click").unwrap(), "click");
        assert!(tool_name("").is_err());
        assert!(tool_name("click; rm -rf /").is_err());
    }

    #[test]
    fn refuses_calls_that_would_leave_the_bound_browser() {
        assert!(check_binding("connect", &json!({})).is_err());
        assert!(check_binding("get_cdp_url", &json!({})).is_err());
        assert!(check_binding("open", &json!({"session": "other"})).is_err());
        for flag in ["--cdp", "--cdp=9222", "--session=x", "--auto-connect"] {
            assert!(
                check_binding("open", &json!({"extraArgs": [flag]})).is_err(),
                "{flag}"
            );
        }
        assert!(check_binding("open", &json!({"url": "https://example.com"})).is_ok());
        assert!(check_binding("snapshot", &json!({"extraArgs": ["--full"]})).is_ok());
    }

    #[test]
    fn removes_the_launch_bookkeeping_and_the_stdout_copy() {
        let response =
            json!({"success": true, "data": {"clicked": "@e1", "lifecycle": {"launchHash": 1}}});
        let mut result = json!({
            "content": [
                {"type": "text", "text": serde_json::to_string_pretty(&response).unwrap()},
                {"type": "text", "text": "plain page text"},
            ],
            "isError": false,
            "structuredContent": {
                "exitCode": 0,
                "response": response,
                "stdout": format!("{response}\n"),
            },
        });
        drop_lifecycle(&mut result);
        let kept = json!({"success": true, "data": {"clicked": "@e1"}});
        assert_eq!(
            result["content"][0]["text"],
            json!(serde_json::to_string_pretty(&kept).unwrap())
        );
        assert_eq!(result["content"][1]["text"], json!("plain page text"));
        assert_eq!(result["structuredContent"]["response"], kept);
        assert!(result["structuredContent"].get("stdout").is_none());
        assert_eq!(result["structuredContent"]["exitCode"], json!(0));
    }

    #[test]
    fn removes_the_launch_bookkeeping_from_each_batch_step() {
        let steps = json!([
            {"command": ["get", "title"], "result": {"lifecycle": {}, "title": "A"}, "success": true},
        ]);
        let mut result = json!({
            "content": [{"type": "text", "text": serde_json::to_string_pretty(&steps).unwrap()}],
            "structuredContent": {"response": steps, "stdout": format!("{steps}\n")},
        });
        drop_lifecycle(&mut result);
        let kept =
            json!([{"command": ["get", "title"], "result": {"title": "A"}, "success": true}]);
        assert_eq!(result["structuredContent"]["response"], kept);
        assert!(result["structuredContent"].get("stdout").is_none());
        assert_eq!(
            result["content"][0]["text"],
            json!(serde_json::to_string_pretty(&kept).unwrap())
        );
    }

    #[test]
    fn sessions_are_per_task_and_safe_for_the_driver() {
        let key = session_key("project", "task");
        assert_ne!(key, session_key("project", "other"));
        assert!(key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn uses_the_personal_browser_only_when_a_call_asks() {
        assert_eq!(resolve_target(true, None), Ok(Target::Managed));
        assert_eq!(
            resolve_target(true, Some(Target::Personal)),
            Ok(Target::Personal)
        );
        assert!(resolve_target(false, Some(Target::Personal)).is_err());
    }

    #[test]
    fn treats_login_data_tools_as_sensitive() {
        for tool in [
            "cookies_get",
            "storage_get",
            "network_requests",
            "eval",
            "batch",
        ] {
            assert!(is_sensitive_tool(tool), "{tool}");
        }
        for tool in ["open", "snapshot", "click", "screenshot"] {
            assert!(!is_sensitive_tool(tool), "{tool}");
        }
    }
}

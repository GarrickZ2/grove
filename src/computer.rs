//! Computer use for agents: a thin pass-through to agent-desktop.
//!
//! An agent names an agent-desktop tool and its arguments; Grove runs it and
//! returns the result as it came. Grove owns only what is around the call:
//! each chat Session asks the user once before its first call and gets its own
//! agent-desktop session, and the latest image a result carried is kept so the
//! panel can show it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::session_approval::{self, Capability, Decision, Requester};
use crate::storage::config;

const PACKAGE: &str = "agent-desktop@latest";
const TOOL_PREFIX: &str = "desktop_";
/// How long Grove waits for one process before giving up on it.
const PROCESS_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const HELP_TIMEOUT: Duration = Duration::from_secs(120);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// The Session making a call, and where its process runs.
pub struct Scope {
    pub project: String,
    pub task: String,
    pub chat: String,
    /// The chat Session's title, which labels its tab in the panel.
    pub chat_title: String,
    pub cwd: std::path::PathBuf,
}

#[derive(Clone)]
struct Screenshot {
    title: String,
    data: String,
    mime_type: String,
    taken_at: chrono::DateTime<chrono::Utc>,
}

/// (project, task, chat). Kept in memory only: it may show anything on the
/// user's screen.
type ShotKey = (String, String, String);

static SCREENSHOTS: LazyLock<Mutex<HashMap<ShotKey, Screenshot>>> = LazyLock::new(Default::default);

fn package_args() -> Vec<String> {
    vec!["-y".to_string(), PACKAGE.to_string()]
}

/// Whether agent-desktop may use the screen, as `agent-desktop permissions`
/// reports it (macOS). Each state is agent-desktop's own word, `granted` when
/// allowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub accessibility: String,
    pub screen_recording: String,
}

const PERMISSIONS_TIMEOUT: Duration = Duration::from_secs(60);

async fn run_permissions(extra: &[&str]) -> Result<std::process::Output, String> {
    let mut args = package_args();
    args.push("permissions".to_string());
    args.extend(extra.iter().map(|arg| arg.to_string()));
    let home = crate::storage::grove_dir();
    crate::tmux::run_npx(args, &HashMap::new(), &home, None, PERMISSIONS_TIMEOUT)
        .await
        .map_err(|error| format!("Could not start agent-desktop: {error}"))
}

pub async fn permissions() -> Result<Permissions, String> {
    let output = run_permissions(&[]).await?;
    let report: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "agent-desktop did not report its permissions.".to_string())?;
    let state = |name: &str| {
        report
            .pointer(&format!("/data/{name}/state"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    };
    Ok(Permissions {
        accessibility: state("accessibility"),
        screen_recording: state("screen_recording"),
    })
}

/// One macOS permission computer use needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Accessibility,
    ScreenRecording,
}

/// Ask macOS for `permission` and open its page in System Settings.
///
/// macOS grants these to the app Grove runs under (Grove.app, or the terminal
/// that started it), and agent-desktop runs as part of Grove, so Grove asks
/// for itself: macOS then lists the right app, which agent-desktop's own guide
/// cannot tell.
pub async fn request_permission(permission: Permission) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || macos::request(permission))
            .await
            .map_err(|error| error.to_string())?;
        let pane = match permission {
            Permission::Accessibility => "Privacy_Accessibility",
            Permission::ScreenRecording => "Privacy_ScreenCapture",
        };
        open::that_detached(format!(
            "x-apple.systempreferences:com.apple.preference.security?{pane}"
        ))
        .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err("Only macOS asks for these permissions.".to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Permission;
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(
            allocator: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFTypeRef;
        fn CFRelease(value: CFTypeRef);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub(super) fn request(permission: Permission) {
        // SAFETY: plain calls into system frameworks with valid CF objects;
        // the dictionary is released after use.
        unsafe {
            match permission {
                Permission::Accessibility => {
                    let keys = [kAXTrustedCheckOptionPrompt];
                    let values = [kCFBooleanTrue];
                    let options = CFDictionaryCreate(
                        std::ptr::null(),
                        keys.as_ptr(),
                        values.as_ptr(),
                        1,
                        &kCFTypeDictionaryKeyCallBacks,
                        &kCFTypeDictionaryValueCallBacks,
                    );
                    AXIsProcessTrustedWithOptions(options);
                    if !options.is_null() {
                        CFRelease(options);
                    }
                }
                Permission::ScreenRecording => {
                    CGRequestScreenCaptureAccess();
                }
            }
        }
    }
}

/// Each chat Session gets its own agent-desktop session, so snapshot refs one
/// Session took cannot be used by another. Set when the server starts; an
/// agent cannot pass it per call.
fn driver_session(chat: &str) -> String {
    let digest = Sha256::digest(chat.as_bytes());
    let hash: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("grove-{hash}")
}

fn tool_name(tool: &str) -> String {
    let tool = tool.trim();
    if tool.starts_with(TOOL_PREFIX) {
        tool.to_string()
    } else {
        format!("{TOOL_PREFIX}{}", tool.replace('-', "_"))
    }
}

/// Run one agent-desktop tool for an agent. Returns its `tools/call` result.
pub async fn invoke(scope: &Scope, tool: &str, args: Value) -> Result<Value, String> {
    let settings = config::load_config().browser_control;
    if !settings.computer_use {
        return Err(
            "The user does not let agents use their computer. Enable it in Grove Settings."
                .to_string(),
        );
    }
    let requester = Requester {
        project: scope.project.clone(),
        task: scope.task.clone(),
        chat: scope.chat.clone(),
    };
    if !settings.computer_use_bypass {
        match session_approval::wait(&requester, Capability::Computer, APPROVAL_TIMEOUT).await {
            Decision::Allowed => {}
            Decision::Denied => {
                return Err("The user refused to let you use their computer. Ask them directly if you need it.".to_string())
            }
            Decision::Unanswered => {
                return Err("The user did not answer the request to use their computer within 2 minutes; they may be away. Try again later.".to_string())
            }
        }
    }
    let args = if args.is_null() { json!({}) } else { args };
    let result = tokio::time::timeout(
        PROCESS_TIMEOUT,
        call(
            Some(&driver_session(&scope.chat)),
            &scope.cwd,
            json!({"name": tool_name(tool), "arguments": args}),
        ),
    )
    .await
    .map_err(|_| "The computer command timed out.".to_string())??;
    keep_screenshot(scope, &result);
    Ok(result)
}

/// Remember the last image a result carried, whichever tool returned it.
fn keep_screenshot(scope: &Scope, result: &Value) {
    let image = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks
                .iter()
                .rev()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        });
    let Some(image) = image else {
        return;
    };
    let (Some(data), Some(mime_type)) = (
        image.get("data").and_then(Value::as_str),
        image.get("mimeType").and_then(Value::as_str),
    ) else {
        return;
    };
    SCREENSHOTS.lock().unwrap().insert(
        key(&scope.project, &scope.task, &scope.chat),
        Screenshot {
            title: scope.chat_title.clone(),
            data: data.to_string(),
            mime_type: mime_type.to_string(),
            taken_at: chrono::Utc::now(),
        },
    );
}

/// One MCP exchange with a fresh `agent-desktop mcp` process: `params` is a
/// `tools/call` request, or Null for `tools/list`.
async fn call(session: Option<&str>, cwd: &Path, params: Value) -> Result<Value, String> {
    let mut args = package_args();
    args.push("mcp".to_string());
    if let Some(session) = session {
        args.extend(["--session".to_string(), session.to_string()]);
    }
    let mut child =
        crate::tmux::spawn_npx_stdio(args, cwd).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                "Computer use needs Node.js with npx. Install Node.js and try again.".to_string()
            }
            _ => format!("Could not start agent-desktop: {error}"),
        })?;
    let mut input = child
        .stdin
        .take()
        .ok_or("Could not open agent-desktop input.")?;
    let output = child
        .stdout
        .take()
        .ok_or("Could not open agent-desktop output.")?;
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
    let request = if params.is_null() {
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
    } else {
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":params})
    };
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
                send(&mut input, request.clone()).await?;
            }
            Some(id) => {
                if let Some(error) = message.get("error") {
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("agent-desktop refused the call.");
                    return Ok(json!({"content":[{"type":"text","text":text}],"isError":true}));
                }
                let result = message.get("result").cloned().unwrap_or(Value::Null);
                if !params.is_null() {
                    let _ = child.start_kill();
                    return Ok(result);
                }
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
                        return Ok(json!({ "tools": tools }));
                    }
                }
            }
            None => {}
        }
    }
    Err("agent-desktop exited before answering.".to_string())
}

async fn tools() -> Result<Vec<Value>, String> {
    static CACHE: LazyLock<Mutex<Option<Vec<Value>>>> = LazyLock::new(Default::default);
    if let Some(tools) = CACHE.lock().unwrap().clone() {
        return Ok(tools);
    }
    let home = crate::storage::grove_dir();
    let listed = tokio::time::timeout(HELP_TIMEOUT, call(None, &home, Value::Null))
        .await
        .map_err(|_| "Timed out reading the computer tool list.".to_string())??;
    let tools = listed
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    *CACHE.lock().unwrap() = Some(tools.clone());
    Ok(tools)
}

fn short_name(tool: &Value) -> Option<&str> {
    Some(tool.get("name")?.as_str()?.trim_start_matches(TOOL_PREFIX))
}

fn result_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `topic` is empty for the tool list, "guide" for agent-desktop's own guides,
/// or a tool name for that tool's definition.
pub async fn help(topic: Option<&str>) -> Result<String, String> {
    match topic.map(str::trim).filter(|topic| !topic.is_empty()) {
        Some("guide") => {
            let home = crate::storage::grove_dir();
            let mut text = String::new();
            for name in ["desktop", "platform"] {
                let params = json!({"name": "desktop_skills_get", "arguments": {"name": name}});
                let result = tokio::time::timeout(HELP_TIMEOUT, call(None, &home, params))
                    .await
                    .map_err(|_| "Timed out reading the guide.".to_string())??;
                text.push_str(&result_text(&result));
                text.push_str("\n\n");
            }
            Ok(text)
        }
        Some(topic) => {
            let wanted = tool_name(topic);
            let tools = tools().await?;
            let tool = tools
                .iter()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(wanted.as_str()))
                .ok_or_else(|| format!("No computer tool is named {topic}."))?;
            serde_json::to_string_pretty(tool).map_err(|error| error.to_string())
        }
        None => {
            let tools = tools().await?;
            let lines: Vec<String> = tools
                .iter()
                .filter_map(|tool| {
                    let name = short_name(tool)?;
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

fn key(project: &str, task: &str, chat: &str) -> ShotKey {
    (project.to_string(), task.to_string(), chat.to_string())
}

/// One chat Session's latest screenshot, as the panel lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub chat_id: String,
    pub title: String,
    pub taken_at: chrono::DateTime<chrono::Utc>,
}

/// Every Session in a Task that has a screenshot, oldest first, so tabs keep
/// their places as new screenshots arrive.
pub fn shots(project: &str, task: &str) -> Vec<Shot> {
    let screenshots = SCREENSHOTS.lock().unwrap();
    let mut shots: Vec<Shot> = screenshots
        .iter()
        .filter(|((shot_project, shot_task, _), _)| shot_project == project && shot_task == task)
        .map(|((_, _, chat), shot)| Shot {
            chat_id: chat.clone(),
            title: shot.title.clone(),
            taken_at: shot.taken_at,
        })
        .collect();
    shots.sort_by(|a, b| a.chat_id.cmp(&b.chat_id));
    shots
}

/// A Session's latest screenshot as (mime type, bytes).
pub fn screenshot(project: &str, task: &str, chat: &str) -> Option<(String, Vec<u8>)> {
    use base64::Engine;
    let shot = SCREENSHOTS
        .lock()
        .unwrap()
        .get(&key(project, task, chat))
        .cloned()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(shot.data)
        .ok()?;
    Some((shot.mime_type, bytes))
}

/// The user closed a Session's computer tab in the panel. Its next image
/// shows it again.
pub fn close(project: &str, task: &str, chat: &str) {
    SCREENSHOTS
        .lock()
        .unwrap()
        .remove(&key(project, task, chat));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_chat_session_gets_its_own_driver_session() {
        assert_eq!(driver_session("chat-a"), driver_session("chat-a"));
        assert_ne!(driver_session("chat-a"), driver_session("chat-b"));
        assert!(driver_session("chat-a")
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn tool_names_take_the_driver_prefix() {
        assert_eq!(tool_name("screenshot"), "desktop_screenshot");
        assert_eq!(tool_name("list-windows"), "desktop_list_windows");
        assert_eq!(tool_name("desktop_click"), "desktop_click");
    }

    fn scope(chat: &str) -> Scope {
        Scope {
            project: "computer-test".to_string(),
            task: "t1".to_string(),
            chat: chat.to_string(),
            chat_title: format!("Title {chat}"),
            cwd: std::env::temp_dir(),
        }
    }

    #[test]
    fn keeps_each_sessions_last_image() {
        let image = |data: &str| {
            json!({"content": [
                {"type": "text", "text": "{}"},
                {"type": "image", "data": data, "mimeType": "image/png"}
            ]})
        };
        keep_screenshot(&scope("a"), &image("aGk="));
        keep_screenshot(&scope("b"), &image("Ynll"));
        keep_screenshot(&scope("a"), &json!({"content": []}));
        assert_eq!(screenshot("computer-test", "t1", "a").unwrap().1, b"hi");
        assert_eq!(screenshot("computer-test", "t1", "b").unwrap().1, b"bye");
        let shots = shots("computer-test", "t1");
        assert_eq!(shots.len(), 2);
        assert_eq!(shots[0].title, "Title a");
        close("computer-test", "t1", "a");
        assert!(screenshot("computer-test", "t1", "a").is_none());
        assert!(screenshot("computer-test", "t1", "b").is_some());
    }
}

//! Hook 通知系统

use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::path::PathBuf;
use std::process::Command;

use crate::error::Result;
use crate::storage::{database, tasks, workspace::project_hash};

/// 通知级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    Notice = 0,
    Warn = 1,
    Critical = 2,
}

/// Hook 通知条目（增强版：level + timestamp + message + chat_id）
///
/// `chat_id` 是后加的字段:旧记录(以及未在 chat 上下文里触发的 hook)为 None,
/// 前端 fallback 只跳到 task 不跳 chat session。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEntry {
    pub level: NotificationLevel,
    #[serde(default = "Utc::now")]
    pub timestamp: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

/// Hooks 文件结构
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HooksFile {
    #[serde(default)]
    pub tasks: HashMap<String, HookEntry>,
}

#[derive(Debug, Clone)]
pub struct HookNotificationRecord {
    pub project_key: String,
    pub task_id: String,
    pub entry: HookEntry,
}

pub fn level_to_str(level: NotificationLevel) -> &'static str {
    match level {
        NotificationLevel::Notice => "notice",
        NotificationLevel::Warn => "warn",
        NotificationLevel::Critical => "critical",
    }
}

pub fn level_from_str(value: &str) -> Option<NotificationLevel> {
    match value {
        "notice" => Some(NotificationLevel::Notice),
        "warn" => Some(NotificationLevel::Warn),
        "critical" => Some(NotificationLevel::Critical),
        _ => None,
    }
}

/// What produced a hook notification. Rides on the radio fact (not persisted);
/// surfaces key their presentation policy off it: config switch, banner title,
/// sound choice, permission buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookKind {
    TurnComplete,
    PermissionRequired,
    ElicitationRequired,
    /// Fired by `grove hooks` CLI (agent shell hooks). The CLI renders its own
    /// machine itself; the server-side fact only feeds badges and remote
    /// surfaces.
    External,
}

impl HookKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookKind::TurnComplete => "turn_complete",
            HookKind::PermissionRequired => "permission_required",
            HookKind::ElicitationRequired => "elicitation_required",
            HookKind::External => "external",
        }
    }

    pub fn parse(value: &str) -> Option<HookKind> {
        match value {
            "turn_complete" => Some(HookKind::TurnComplete),
            "permission_required" => Some(HookKind::PermissionRequired),
            "elicitation_required" => Some(HookKind::ElicitationRequired),
            "external" => Some(HookKind::External),
            _ => None,
        }
    }

    /// Default attention level when the caller doesn't override it — mirrors
    /// the historical mapping in the ACP notify path.
    pub fn default_level(&self) -> NotificationLevel {
        match self {
            HookKind::PermissionRequired => NotificationLevel::Warn,
            _ => NotificationLevel::Notice,
        }
    }
}

/// One attention fact to persist and broadcast. `permission` is only set for
/// [`HookKind::PermissionRequired`].
#[derive(Debug, Clone)]
pub struct HookFact {
    pub kind: HookKind,
    /// Semantic event label, e.g. "Task Complete" / "Permission Required".
    /// Renderers may fall back to a kind-derived label when None.
    pub label: Option<String>,
    pub level: Option<NotificationLevel>,
    pub message: Option<String>,
    pub chat_id: Option<String>,
    pub permission: Option<crate::radio::PermissionInfo>,
}

/// 加载项目的 hook 通知
pub fn load_hooks(project_key: &str) -> HooksFile {
    let conn = database::connection();
    let mut stmt = match conn.prepare(
        "SELECT task_id, level, timestamp, message, chat_id
         FROM hook_notifications
         WHERE project_key = ?1",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return HooksFile::default(),
    };

    let rows = match stmt.query_map(params![project_key], |row| {
        let task_id: String = row.get(0)?;
        let level: String = row.get(1)?;
        let timestamp: String = row.get(2)?;
        let message: Option<String> = row.get(3)?;
        let chat_id: Option<String> = row.get(4)?;
        Ok((task_id, level, timestamp, message, chat_id))
    }) {
        Ok(rows) => rows,
        Err(_) => return HooksFile::default(),
    };

    let mut hooks = HooksFile::default();
    for row in rows.flatten() {
        let (task_id, level, timestamp, message, chat_id) = row;
        let Some(level) = level_from_str(&level) else {
            continue;
        };
        let timestamp = DateTime::parse_from_rfc3339(&timestamp)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        hooks.tasks.insert(
            task_id,
            HookEntry {
                level,
                timestamp,
                message,
                chat_id,
            },
        );
    }
    hooks
}

/// 加载所有项目的 hook 通知，按时间倒序返回。
pub fn load_all_hooks() -> Vec<HookNotificationRecord> {
    let conn = database::connection();
    let mut stmt = match conn.prepare(
        "SELECT project_key, task_id, level, timestamp, message, chat_id
         FROM hook_notifications
         ORDER BY timestamp DESC",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![], |row| {
        let project_key: String = row.get(0)?;
        let task_id: String = row.get(1)?;
        let level: String = row.get(2)?;
        let timestamp: String = row.get(3)?;
        let message: Option<String> = row.get(4)?;
        let chat_id: Option<String> = row.get(5)?;
        Ok((project_key, task_id, level, timestamp, message, chat_id))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    rows.flatten()
        .filter_map(
            |(project_key, task_id, level, timestamp, message, chat_id)| {
                let level = level_from_str(&level)?;
                let timestamp = DateTime::parse_from_rfc3339(&timestamp)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                Some(HookNotificationRecord {
                    project_key,
                    task_id,
                    entry: HookEntry {
                        level,
                        timestamp,
                        message,
                        chat_id,
                    },
                })
            },
        )
        .collect()
}

/// 保存项目的 hook 通知
pub fn save_hooks(project_key: &str, hooks: &HooksFile) -> Result<()> {
    let conn = database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM hook_notifications WHERE project_key = ?1",
        params![project_key],
    )?;
    for (task_id, entry) in &hooks.tasks {
        tx.execute(
            "INSERT INTO hook_notifications (project_key, task_id, level, timestamp, message, chat_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project_key,
                task_id,
                level_to_str(entry.level),
                entry.timestamp.to_rfc3339(),
                entry.message,
                entry.chat_id,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 删除指定 task 的 hook 通知
pub fn remove_task_hook(project_key: &str, task_id: &str) {
    let conn = database::connection();
    let _ = conn.execute(
        "DELETE FROM hook_notifications WHERE project_key = ?1 AND task_id = ?2",
        params![project_key, task_id],
    );
}

pub fn remove_all_hooks() {
    let conn = database::connection();
    let _ = conn.execute("DELETE FROM hook_notifications", []);
}

/// Set on headless serving surfaces (`grove mobile`): the process must not
/// play sounds or spawn OS banners — no human sits at that machine's desktop.
/// Per-surface renderers (in-process renderer, CLI, frontend engine) check
/// this instead of the backend sprinkling mode checks around.
static OS_RENDER_DISABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn set_os_render_disabled() {
    OS_RENDER_DISABLED.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub fn os_render_disabled() -> bool {
    OS_RENDER_DISABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Persist one hook notification and broadcast the enriched `HookAdded` fact.
/// All hook write paths (ACP notify, `grove hooks` CLI, hooks report API)
/// funnel through here — the radio publish is what lets every surface render
/// its own notification purely via push, no polling.
///
/// The write is a single atomic UPSERT guarded by level rank (a higher level
/// overwrites, equal/lower leaves the existing record untouched — same
/// keep-highest semantics `HooksFile::update` had). No load→modify→rewrite
/// round-trip, so concurrent writes to different tasks of one project can't
/// clobber each other. Errors propagate: the report API turns them into a 5xx
/// so the CLI falls back to its local write instead of losing the fact.
pub fn update_hook(project_key: &str, task_id: &str, fact: HookFact) -> Result<()> {
    let level = fact.level.unwrap_or_else(|| fact.kind.default_level());
    let timestamp = Utc::now().to_rfc3339();
    {
        let conn = database::connection();
        conn.execute(
            "INSERT INTO hook_notifications (project_key, task_id, level, timestamp, message, chat_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(project_key, task_id) DO UPDATE SET
                level = excluded.level,
                timestamp = excluded.timestamp,
                message = excluded.message,
                chat_id = excluded.chat_id
             WHERE (CASE hook_notifications.level
                        WHEN 'notice' THEN 0
                        WHEN 'warn' THEN 1
                        ELSE 2 END)
                 < (CASE excluded.level
                        WHEN 'notice' THEN 0
                        WHEN 'warn' THEN 1
                        ELSE 2 END)",
            params![
                project_key,
                task_id,
                level_to_str(level),
                timestamp,
                fact.message.clone(),
                fact.chat_id.clone()
            ],
        )?;
    }
    // Display names: surfaces shouldn't need a project/task fetch to compose
    // a banner title. Best-effort — None is fine.
    let project_name = crate::storage::workspace::load_project_by_hash(project_key)
        .ok()
        .flatten()
        .map(|p| p.name);
    let task_name = tasks::get_task(project_key, task_id)
        .ok()
        .flatten()
        .map(|t| t.name);
    crate::radio::publish(crate::radio::RadioEvent::HookAdded {
        project_id: project_key.to_string(),
        task_id: task_id.to_string(),
        level: Some(level_to_str(level).to_string()),
        message: fact.message,
        kind: Some(fact.kind.as_str().to_string()),
        label: fact.label,
        chat_id: fact.chat_id,
        permission: fact.permission,
        project_name,
        task_name,
    });
    Ok(())
}

/// 加载 hooks 并自动清理不存在的 task
/// project_path: 项目的完整路径
pub fn load_hooks_with_cleanup(project_path: &str) -> HooksFile {
    let project_key = project_hash(project_path);
    let mut hooks = load_hooks(&project_key);

    if hooks.tasks.is_empty() {
        return hooks;
    }

    // 获取项目的 task 列表
    let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();
    let archived_tasks = tasks::load_archived_tasks(&project_key).unwrap_or_default();

    // 收集所有存在的 task id
    let existing_ids: HashSet<String> = active_tasks
        .iter()
        .map(|t| t.id.clone())
        .chain(archived_tasks.iter().map(|t| t.id.clone()))
        .collect();

    // 找出需要清理的 task id
    let to_remove: Vec<String> = hooks
        .tasks
        .keys()
        .filter(|id| !existing_ids.contains(*id))
        .cloned()
        .collect();

    // 如果有需要清理的，执行清理并保存
    if !to_remove.is_empty() {
        for id in &to_remove {
            hooks.tasks.remove(id);
        }
        // 静默保存，忽略错误
        let _ = save_hooks(&project_key, &hooks);
    }

    hooks
}

// === Notification utilities (shared by CLI hooks and ACP) ===

pub static ACTIVE_BASE_URL: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();

#[cfg(feature = "gui")]
pub fn set_active_base_url(url: String) {
    record_server_base_url(url);
}

/// Record the running server's loopback base URL so same-machine CLIs (the
/// `grove hooks` reporter) can find it even when the bound port fell back
/// from the default. Process-local OnceCell plus the cross-process endpoint
/// file; last writer wins per boot, which is fine — one grove server owns a
/// machine's task sessions at a time.
pub fn record_server_base_url(base_url: String) {
    let _ = ACTIVE_BASE_URL.set(base_url.clone());
    let grove_dir = crate::storage::grove_dir();
    if std::fs::create_dir_all(&grove_dir).is_ok() {
        let _ = std::fs::write(grove_dir.join("gui_endpoint"), base_url);
    }
}

#[cfg(target_os = "macos")]
pub fn get_active_base_url() -> String {
    get_server_base_url()
}

/// Portable (all-platform) resolution of the running Grove server's base URL:
/// in-process override first, then the endpoint file written by GUI mode,
/// then the default loopback port. Used by the `grove hooks` CLI to hand its
/// attention fact to the live server process.
pub fn get_server_base_url() -> String {
    if let Some(url) = ACTIVE_BASE_URL.get() {
        return url.clone();
    }
    let grove_dir = crate::storage::grove_dir();
    let endpoint_file = grove_dir.join("gui_endpoint");
    if let Ok(content) = std::fs::read_to_string(&endpoint_file) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "http://127.0.0.1:3001".to_string()
}

/// Play a system sound.
#[cfg(target_os = "macos")]
pub fn play_sound(sound: &str) {
    let path = format!("/System/Library/Sounds/{}.aiff", sound);
    Command::new("afplay").arg(&path).spawn().ok();
}

#[cfg(not(target_os = "macos"))]
pub fn play_sound(_sound: &str) {
    // No-op on Windows (Toast notifications include their own sound)
    // and Linux (no portable sound API).
}

/// Send a desktop notification banner.
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
pub fn send_banner(
    title: &str,
    message: &str,
    project_id: &str,
    task_id: &str,
    chat_id: Option<&str>,
    is_permission: bool,
    approve_opt: Option<&str>,
    deny_opt: Option<&str>,
) {
    let notify_bin = ensure_grove_app();
    if notify_bin.exists() {
        let app_path = notify_bin
            .parent() // MacOS/
            .and_then(|p| p.parent()) // Contents/
            .and_then(|p| p.parent()); // Grove.app/
        if let Some(app) = app_path {
            let base_url = get_active_base_url();
            Command::new("open")
                .args([
                    "-n", // new instance each time
                    "-a",
                    &app.to_string_lossy(),
                    "--args",
                    title,
                    message,
                    project_id,
                    task_id,
                    chat_id.unwrap_or(""),
                    if is_permission { "true" } else { "false" },
                    approve_opt.unwrap_or(""),
                    deny_opt.unwrap_or(""),
                    &base_url,
                ])
                .spawn()
                .ok();
        }
    } else {
        // Fallback to osascript (no custom icon)
        let script = format!(
            r#"display notification "{}" with title "{}""#,
            message.replace('"', "\\\""),
            title.replace('"', "\\\"")
        );
        Command::new("osascript").args(["-e", &script]).spawn().ok();
    }
}

#[cfg(target_os = "windows")]
pub fn send_banner(
    title: &str,
    message: &str,
    _project_id: &str,
    _task_id: &str,
    _chat_id: Option<&str>,
    _is_permission: bool,
    _approve_opt: Option<&str>,
    _deny_opt: Option<&str>,
) {
    // Windows 10+ toast notification via PowerShell
    let icon_attr = ensure_notification_icon()
        .map(|p| {
            // Toast XML uses file:/// URIs; backslashes must be forward slashes.
            // Run the path through xml_escape so apostrophes (e.g. usernames like
            // "O'Brien"), `<`, `>` and `&` don't break the surrounding
            // PowerShell single-quoted XML string.
            let uri = p.to_string_lossy().replace('\\', "/");
            format!(
                r#"<image placement="appLogoOverride" src="file:///{}"/>"#,
                xml_escape(&uri),
            )
        })
        .unwrap_or_default();

    let script = format!(
        r#"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric">{icon}<text>{title}</text><text>{body}</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Grove").Show($toast)
"#,
        icon = icon_attr,
        title = xml_escape(title),
        body = xml_escape(message),
    );
    // Pin to Windows PowerShell 5.1 — the WinRT type bridge used by this script
    // is not available in PowerShell 7 / pwsh by default. Falling back to "powershell"
    // (PATH lookup) lets a user-installed pwsh shim hijack notifications silently.
    let ps_exe = std::env::var("SystemRoot")
        .map(|root| {
            format!(
                "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                root
            )
        })
        .unwrap_or_else(|_| "powershell".to_string());

    // Capture stderr to a log file so toast failures aren't completely silent —
    // and don't use eprintln!, which would scribble onto the TUI's alternate screen.
    match Command::new(&ps_exe)
        .args(["-NoProfile", "-Command", &script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => {
            // Reap async without blocking the caller.
            std::thread::spawn(move || {
                if let Ok(output) = child.wait_with_output() {
                    if !output.status.success() && !output.stderr.is_empty() {
                        log_notify_error(&format!(
                            "toast notification failed: {}",
                            String::from_utf8_lossy(&output.stderr).trim()
                        ));
                    }
                }
            });
        }
        Err(e) => {
            log_notify_error(&format!("failed to spawn powershell for toast: {}", e));
        }
    }
}

/// Append a notification-related error to `~/.grove/logs/notify.log`.
/// Used in lieu of eprintln! so messages don't corrupt the TUI alternate screen.
#[cfg(target_os = "windows")]
fn log_notify_error(msg: &str) {
    use std::io::Write;
    let log_dir = crate::storage::grove_dir().join("logs");
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let log_path = log_dir.join("notify.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = writeln!(f, "{} {}", chrono::Utc::now().to_rfc3339(), msg);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn send_banner(
    title: &str,
    message: &str,
    _project_id: &str,
    _task_id: &str,
    _chat_id: Option<&str>,
    _is_permission: bool,
    _approve_opt: Option<&str>,
    _deny_opt: Option<&str>,
) {
    // Linux: use notify-send if available, with custom icon when present.
    // Use `--` so a title/message starting with `-` is not parsed as an option flag.
    let mut cmd = Command::new("notify-send");
    if let Some(icon_path) = ensure_notification_icon() {
        cmd.args(["-i", &icon_path.to_string_lossy()]);
    }
    cmd.args(["--", title, message]).spawn().ok();
}

/// Escape XML special characters and single quotes (for PowerShell single-quoted string).
/// Also collapses CR/LF to spaces and strips control characters that are illegal
/// in XML 1.0 (would otherwise make `LoadXml` throw).
#[cfg(target_os = "windows")]
fn xml_escape(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            // Allowed whitespace
            '\t' | '\n' | '\r' => Some(' '),
            // Strip illegal XML 1.0 control chars
            '\x00'..='\x08' | '\x0B' | '\x0C' | '\x0E'..='\x1F' => None,
            other => Some(other),
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "''")
}

// ─── Cross-platform notification icon helpers (Windows + Linux) ──────────────

#[cfg(any(target_os = "windows", target_os = "linux"))]
static NOTIFY_ICON_PNG: &[u8] = include_bytes!("../src-tauri/icons/icon.png");

/// Ensure the Grove notification icon is written to `~/.grove/icons/icon.png`.
/// Returns the path if successful.
///
/// Uses a sha256 sentinel file (`icon.png.sha256`) so a future Grove release that
/// ships a different icon — even one with the same byte length — refreshes the
/// on-disk copy without manual cleanup.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn ensure_notification_icon() -> Option<PathBuf> {
    use sha2::{Digest, Sha256};

    let icon_dir = crate::storage::grove_dir().join("icons");
    let icon_path = icon_dir.join("icon.png");
    let sentinel_path = icon_dir.join("icon.png.sha256");

    let expected_hash = {
        let mut h = Sha256::new();
        h.update(NOTIFY_ICON_PNG);
        hex::encode(h.finalize())
    };

    let needs_write = !icon_path.exists()
        || fs::read_to_string(&sentinel_path)
            .map(|s| s.trim() != expected_hash)
            .unwrap_or(true);

    if needs_write {
        fs::create_dir_all(&icon_dir).ok()?;
        fs::write(&icon_path, NOTIFY_ICON_PNG).ok()?;
        // Sentinel write is best-effort — a missing sentinel just causes one extra
        // rewrite next call, no functional break.
        let _ = fs::write(&sentinel_path, &expected_hash);
    }
    Some(icon_path)
}

// ─── macOS Grove.app bundle for native notifications with custom icon ────────

#[cfg(target_os = "macos")]
static ICON_ICNS: &[u8] = include_bytes!("../src-tauri/icons/icon.icns");

#[cfg(target_os = "macos")]
static NOTIFY_SWIFT_SRC: &str = r#"
import Cocoa
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        if args.count > 1 {
            // ─── Trigger Mode: Send Banner ───
            let title = args[1]
            let body = args.count > 2 ? args[2] : ""
            let projectId = args.count > 3 ? args[3] : ""
            let taskId = args.count > 4 ? args[4] : ""
            let chatId = args.count > 5 ? args[5] : ""
            let isPermission = args.count > 6 ? (args[6] == "true") : false
            let approveRaw = args.count > 7 ? args[7] : "allow"
            let denyRaw = args.count > 8 ? args[8] : "deny"
            let baseUrl = args.count > 9 ? args[9] : "http://127.0.0.1:3001"

            var categories: Set<UNNotificationCategory> = []
            let categoryId = "PERMISSION_CATEGORY_" + UUID().uuidString
            if isPermission {
                let approveAction = UNNotificationAction(
                    identifier: "APPROVE_ACTION",
                    title: "Allow once",
                    options: []
                )
                let denyAction = UNNotificationAction(
                    identifier: "DENY_ACTION",
                    title: "Reject",
                    options: []
                )
                let category = UNNotificationCategory(
                    identifier: categoryId,
                    actions: [approveAction, denyAction],
                    intentIdentifiers: [],
                    options: []
                )
                categories.insert(category)
            }
            center.setNotificationCategories(categories)

            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                guard granted else {
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                if isPermission {
                    content.categoryIdentifier = categoryId
                }
                content.userInfo = [
                    "projectId": projectId,
                    "taskId": taskId,
                    "chatId": chatId,
                    "approveOpt": approveRaw,
                    "denyOpt": denyRaw,
                    "baseUrl": baseUrl
                ]

                let req = UNNotificationRequest(
                    identifier: UUID().uuidString, content: content, trigger: nil)
                center.add(req) { _ in
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
            }
        } else {
            // ─── Activation Mode: macOS launched us on banner click ───
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
                NSApp.terminate(nil)
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler handler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        handler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let projectId = userInfo["projectId"] as? String ?? ""
        let taskId = userInfo["taskId"] as? String ?? ""
        let chatId = userInfo["chatId"] as? String ?? ""
        let approveOpt = userInfo["approveOpt"] as? String ?? "allow"
        let denyOpt = userInfo["denyOpt"] as? String ?? "deny"
        var baseUrl = userInfo["baseUrl"] as? String ?? "http://127.0.0.1:3001"
        let homeDir = FileManager.default.homeDirectoryForCurrentUser
        let endpointFile = homeDir.appendingPathComponent(".grove").appendingPathComponent("gui_endpoint")
        if let savedEndpoint = try? String(contentsOf: endpointFile, encoding: .utf8) {
            let trimmed = savedEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                baseUrl = trimmed
            }
        }

        func encode(_ s: String) -> String {
            s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
        }

        var urlString = ""
        if response.actionIdentifier == "APPROVE_ACTION" {
            urlString = "\(baseUrl)/api/v1/gui/resolve-permission?projectId=\(encode(projectId))&taskId=\(encode(taskId))&chatId=\(encode(chatId))&optionId=\(encode(approveOpt))"
        } else if response.actionIdentifier == "DENY_ACTION" {
            urlString = "\(baseUrl)/api/v1/gui/resolve-permission?projectId=\(encode(projectId))&taskId=\(encode(taskId))&chatId=\(encode(chatId))&optionId=\(encode(denyOpt))"
        } else {
            urlString = "\(baseUrl)/api/v1/gui/open-task?projectId=\(encode(projectId))&taskId=\(encode(taskId))&chatId=\(encode(chatId))"
        }

        if let url = URL(string: urlString) {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            let semaphore = DispatchSemaphore(value: 0)
            let task = URLSession.shared.dataTask(with: request) { _, _, _ in
                semaphore.signal()
            }
            task.resume()
            _ = semaphore.wait(timeout: .now() + 2.0)
        }

        completionHandler()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
"#;

/// Ensure `~/.grove/Grove.app` exists with icon and compiled Swift notifier.
/// Returns the path to the `grove-notify` binary.
#[cfg(target_os = "macos")]
pub fn ensure_grove_app() -> PathBuf {
    use sha2::{Digest, Sha256};

    let grove_dir = crate::storage::grove_dir();
    let app_dir = grove_dir.join("Grove.app").join("Contents");
    let macos_dir = app_dir.join("MacOS");
    let res_dir = app_dir.join("Resources");
    let notify_bin = macos_dir.join("grove-notify");
    let sentinel_path = res_dir.join("swift_src.sha256");

    let expected_hash = {
        let mut h = Sha256::new();
        h.update(NOTIFY_SWIFT_SRC.as_bytes());
        hex::encode(h.finalize())
    };

    let needs_rebuild = !notify_bin.exists()
        || !sentinel_path.exists()
        || fs::read_to_string(&sentinel_path)
            .map(|s| s.trim() != expected_hash)
            .unwrap_or(true);

    if needs_rebuild {
        let app_bundle = grove_dir.join("Grove.app");
        if app_bundle.exists() {
            let _ = fs::remove_dir_all(&app_bundle);
        }
    } else {
        return notify_bin;
    }

    // Create directory structure
    fs::create_dir_all(&macos_dir).ok();
    fs::create_dir_all(&res_dir).ok();

    // Write Info.plist
    let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.grove.app</string>
    <key>CFBundleName</key>
    <string>Grove</string>
    <key>CFBundleExecutable</key>
    <string>grove-notify</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>"#;
    fs::write(app_dir.join("Info.plist"), plist).ok();

    // Write icon
    fs::write(res_dir.join("AppIcon.icns"), ICON_ICNS).ok();

    // Write Swift source and compile
    let swift_src = grove_dir.join("grove-notify.swift");
    fs::write(&swift_src, NOTIFY_SWIFT_SRC).ok();

    let status = Command::new("swiftc")
        .args([
            "-O",
            "-suppress-warnings",
            "-o",
            &notify_bin.to_string_lossy(),
            &swift_src.to_string_lossy(),
        ])
        .status();

    // Clean up source file
    fs::remove_file(&swift_src).ok();

    if status.is_ok_and(|s| s.success()) {
        // Write the sentinel file
        let _ = fs::write(&sentinel_path, &expected_hash);

        // Ad-hoc sign so UNUserNotificationCenter works without developer account
        let app_bundle = grove_dir.join("Grove.app");
        Command::new("codesign")
            .args([
                "--force",
                "--deep",
                "-s",
                "-",
                &app_bundle.to_string_lossy(),
            ])
            .status()
            .ok();

        // Register with Launch Services so macOS recognizes the bundle icon
        Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
            .args(["-f", &grove_dir.join("Grove.app").to_string_lossy()])
            .status()
            .ok();
    }

    notify_bin
}

#[cfg(test)]
mod tests {
    use super::*;

    struct HomeGuard(String);

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            std::env::set_var("HOME", &self.0);
        }
    }

    #[test]
    fn test_save_load_remove_roundtrip() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let original_home = std::env::var("HOME").unwrap_or_default();
        let _home_guard = HomeGuard(original_home);
        let temp_home = std::env::temp_dir().join(format!(
            "grove-hooks-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::env::set_var("HOME", &temp_home);

        let mut hooks = HooksFile::default();
        hooks.tasks.insert(
            "test-task".to_string(),
            HookEntry {
                level: NotificationLevel::Warn,
                timestamp: Utc::now(),
                message: Some("hello".into()),
                chat_id: None,
            },
        );

        save_hooks("project-a", &hooks).unwrap();
        let loaded = load_hooks("project-a");

        assert_eq!(loaded.tasks.len(), 1);
        assert_eq!(loaded.tasks["test-task"].level, NotificationLevel::Warn);
        assert_eq!(loaded.tasks["test-task"].message.as_deref(), Some("hello"));

        remove_task_hook("project-a", "test-task");
        assert!(load_hooks("project-a").tasks.is_empty());

        let mut other_hooks = HooksFile::default();
        other_hooks.tasks.insert(
            "other-task".to_string(),
            HookEntry {
                level: NotificationLevel::Notice,
                timestamp: Utc::now(),
                message: None,
                chat_id: None,
            },
        );
        save_hooks("project-a", &hooks).unwrap();
        save_hooks("project-b", &other_hooks).unwrap();

        remove_all_hooks();
        assert!(load_hooks("project-a").tasks.is_empty());
        assert!(load_hooks("project-b").tasks.is_empty());

        let _ = std::fs::remove_dir_all(temp_home);
    }

    /// The UPSERT in `update_hook` must reproduce the old keep-highest
    /// semantics: a higher level overwrites, equal/lower leaves the existing
    /// record (message included) untouched.
    #[test]
    fn test_update_hook_keeps_existing_higher_level() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let original_home = std::env::var("HOME").unwrap_or_default();
        let _home_guard = HomeGuard(original_home);
        let temp_home = std::env::temp_dir().join(format!(
            "grove-hooks-upsert-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::env::set_var("HOME", &temp_home);

        let write = |level: NotificationLevel, message: &str| {
            update_hook(
                "project-upsert",
                "test-task",
                HookFact {
                    kind: HookKind::TurnComplete,
                    label: None,
                    level: Some(level),
                    message: Some(message.to_string()),
                    chat_id: None,
                    permission: None,
                },
            )
            .unwrap();
        };

        write(NotificationLevel::Critical, "critical");
        write(NotificationLevel::Notice, "notice");

        let loaded = load_hooks("project-upsert");
        assert_eq!(loaded.tasks["test-task"].level, NotificationLevel::Critical);
        assert_eq!(
            loaded.tasks["test-task"].message.as_deref(),
            Some("critical")
        );

        // A HIGHER level still can't happen after critical, but an equal-level
        // write on a fresh task must insert normally.
        write(NotificationLevel::Warn, "warn-on-other");
        update_hook(
            "project-upsert",
            "other-task",
            HookFact {
                kind: HookKind::TurnComplete,
                label: None,
                level: Some(NotificationLevel::Warn),
                message: Some("fresh".to_string()),
                chat_id: None,
                permission: None,
            },
        )
        .unwrap();
        let loaded = load_hooks("project-upsert");
        assert_eq!(loaded.tasks["other-task"].level, NotificationLevel::Warn);
        assert_eq!(loaded.tasks["other-task"].message.as_deref(), Some("fresh"));

        remove_all_hooks();
        let _ = std::fs::remove_dir_all(temp_home);
    }
}

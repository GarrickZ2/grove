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

/// Hook 通知条目（增强版：level + timestamp + message）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEntry {
    pub level: NotificationLevel,
    #[serde(default = "Utc::now")]
    pub timestamp: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
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

impl HooksFile {
    /// 更新 task 的通知（只保留更高级别）
    pub fn update(&mut self, task_id: &str, level: NotificationLevel, message: Option<String>) {
        let current_level = self.tasks.get(task_id).map(|e| e.level);
        if current_level.is_none() || level > current_level.unwrap() {
            self.tasks.insert(
                task_id.to_string(),
                HookEntry {
                    level,
                    timestamp: Utc::now(),
                    message,
                },
            );
        }
    }
}

fn level_to_str(level: NotificationLevel) -> &'static str {
    match level {
        NotificationLevel::Notice => "notice",
        NotificationLevel::Warn => "warn",
        NotificationLevel::Critical => "critical",
    }
}

fn level_from_str(value: &str) -> Option<NotificationLevel> {
    match value {
        "notice" => Some(NotificationLevel::Notice),
        "warn" => Some(NotificationLevel::Warn),
        "critical" => Some(NotificationLevel::Critical),
        _ => None,
    }
}

/// 加载项目的 hook 通知
pub fn load_hooks(project_key: &str) -> HooksFile {
    let conn = database::connection();
    let mut stmt = match conn.prepare(
        "SELECT task_id, level, timestamp, message
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
        Ok((task_id, level, timestamp, message))
    }) {
        Ok(rows) => rows,
        Err(_) => return HooksFile::default(),
    };

    let mut hooks = HooksFile::default();
    for row in rows.flatten() {
        let (task_id, level, timestamp, message) = row;
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
            },
        );
    }
    hooks
}

/// 加载所有项目的 hook 通知，按时间倒序返回。
pub fn load_all_hooks() -> Vec<HookNotificationRecord> {
    let conn = database::connection();
    let mut stmt = match conn.prepare(
        "SELECT project_key, task_id, level, timestamp, message
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
        Ok((project_key, task_id, level, timestamp, message))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    rows.flatten()
        .filter_map(|(project_key, task_id, level, timestamp, message)| {
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
                },
            })
        })
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
            "INSERT INTO hook_notifications (project_key, task_id, level, timestamp, message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project_key,
                task_id,
                level_to_str(entry.level),
                entry.timestamp.to_rfc3339(),
                entry.message
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

/// 写入一条新通知并通过 radio 广播 `HookAdded`。所有 hook 写入路径
/// （ACP notify、`grove hooks` CLI、未来的 MCP server）都应走这里，
/// 确保前端能够纯 push 刷新，无需轮询。
///
/// `save_hooks` 失败不会向上传递（调用方都把 hook 写入当成 fire-and-forget），
/// 但会打到 stderr 让运维 / 用户能看到 —— 静默吞 IO 错误会让通知丢失却没线索。
pub fn update_hook(
    project_key: &str,
    task_id: &str,
    level: NotificationLevel,
    message: Option<String>,
) {
    let mut hooks = load_hooks(project_key);
    hooks.update(task_id, level, message);
    match save_hooks(project_key, &hooks) {
        Ok(()) => {
            crate::api::handlers::walkie_talkie::broadcast_radio_event(
                crate::api::handlers::walkie_talkie::RadioEvent::HookAdded {
                    project_id: project_key.to_string(),
                    task_id: task_id.to_string(),
                },
            );
        }
        Err(e) => {
            eprintln!(
                "hooks: failed to save hook for {}/{}: {}",
                project_key, task_id, e
            );
        }
    }
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
pub fn send_banner(title: &str, message: &str) {
    let notify_bin = ensure_grove_app();
    if notify_bin.exists() {
        let app_path = notify_bin
            .parent() // MacOS/
            .and_then(|p| p.parent()) // Contents/
            .and_then(|p| p.parent()); // Grove.app/
        if let Some(app) = app_path {
            Command::new("open")
                .args([
                    "-n", // new instance each time
                    "-a",
                    &app.to_string_lossy(),
                    "--args",
                    title,
                    message,
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
pub fn send_banner(title: &str, message: &str) {
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
pub fn send_banner(title: &str, message: &str) {
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
        let title = args.count > 1 ? args[1] : "Grove"
        let body  = args.count > 2 ? args[2] : ""

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else {
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body  = body
            let req = UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(req) { _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
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
    let grove_dir = crate::storage::grove_dir();
    let app_dir = grove_dir.join("Grove.app").join("Contents");
    let macos_dir = app_dir.join("MacOS");
    let res_dir = app_dir.join("Resources");
    let notify_bin = macos_dir.join("grove-notify");

    // Already built — fast path
    if notify_bin.exists() {
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
        hooks.update("test-task", NotificationLevel::Warn, Some("hello".into()));

        save_hooks("project-a", &hooks).unwrap();
        let loaded = load_hooks("project-a");

        assert_eq!(loaded.tasks.len(), 1);
        assert_eq!(loaded.tasks["test-task"].level, NotificationLevel::Warn);
        assert_eq!(loaded.tasks["test-task"].message.as_deref(), Some("hello"));

        remove_task_hook("project-a", "test-task");
        assert!(load_hooks("project-a").tasks.is_empty());

        let _ = std::fs::remove_dir_all(temp_home);
    }

    #[test]
    fn test_update_keeps_existing_higher_level() {
        let mut hooks = HooksFile::default();
        hooks.update(
            "test-task",
            NotificationLevel::Critical,
            Some("critical".into()),
        );
        hooks.update(
            "test-task",
            NotificationLevel::Notice,
            Some("notice".into()),
        );

        assert_eq!(hooks.tasks["test-task"].level, NotificationLevel::Critical);
        assert_eq!(
            hooks.tasks["test-task"].message.as_deref(),
            Some("critical")
        );
    }
}

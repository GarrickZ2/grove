//! Hook 通知系统

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::process::Command;

use crate::error::Result;
use crate::storage::{self, tasks, workspace::project_hash};

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

/// 向后兼容的反序列化：支持旧格式（裸字符串）和新格式（table）
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum HookEntryCompat {
    /// 新格式：完整 HookEntry table
    Full(HookEntry),
    /// 旧格式：裸 NotificationLevel 字符串
    Legacy(NotificationLevel),
}

impl From<HookEntryCompat> for HookEntry {
    fn from(compat: HookEntryCompat) -> Self {
        match compat {
            HookEntryCompat::Full(entry) => entry,
            HookEntryCompat::Legacy(level) => HookEntry {
                level,
                timestamp: Utc::now(),
                message: None,
            },
        }
    }
}

/// 向后兼容的反序列化中间结构
#[derive(Debug, Clone, Deserialize)]
struct HooksFileCompat {
    #[serde(default)]
    tasks: HashMap<String, HookEntryCompat>,
}

/// Hooks 文件结构
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HooksFile {
    #[serde(default)]
    pub tasks: HashMap<String, HookEntry>,
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

/// 加载项目的 hooks 文件（向后兼容旧格式）
pub fn load_hooks(project_key: &str) -> HooksFile {
    let project_dir = storage::grove_dir().join("projects").join(project_key);
    let hooks_path = project_dir.join("hooks.toml");

    if hooks_path.exists() {
        let content = match fs::read_to_string(&hooks_path) {
            Ok(s) => s,
            Err(_) => return HooksFile::default(),
        };

        // 先尝试新格式
        if let Ok(file) = toml::from_str::<HooksFile>(&content) {
            return file;
        }

        // 回退到兼容格式（处理旧的裸字符串值）
        if let Ok(compat) = toml::from_str::<HooksFileCompat>(&content) {
            return HooksFile {
                tasks: compat
                    .tasks
                    .into_iter()
                    .map(|(k, v)| (k, HookEntry::from(v)))
                    .collect(),
            };
        }

        HooksFile::default()
    } else {
        HooksFile::default()
    }
}

/// 保存项目的 hooks 文件
pub fn save_hooks(project_key: &str, hooks: &HooksFile) -> Result<()> {
    let project_dir = storage::grove_dir().join("projects").join(project_key);
    fs::create_dir_all(&project_dir)?;

    let hooks_path = project_dir.join("hooks.toml");
    let content = toml::to_string_pretty(hooks)?;
    fs::write(&hooks_path, content)?;
    Ok(())
}

/// 删除指定 task 的 hook 通知
pub fn remove_task_hook(project_key: &str, task_id: &str) {
    let mut hooks = load_hooks(project_key);
    if hooks.tasks.remove(task_id).is_some() {
        // 静默保存，忽略错误
        let _ = save_hooks(project_key, &hooks);
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
    // No-op on non-macOS platforms
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

#[cfg(not(target_os = "macos"))]
pub fn send_banner(title: &str, message: &str) {
    // Linux: use notify-send if available
    Command::new("notify-send")
        .args([title, message])
        .spawn()
        .ok();
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

    #[test]
    fn test_deserialize_old_format() {
        let old = r#"[tasks]
handle-tt-account-unbind = "notice"
"#;
        // New HooksFile format should fail (expects table, not string)
        let result = toml::from_str::<HooksFile>(old);
        println!("Direct HooksFile parse: {:?}", result);

        // Compat format should work
        let compat = toml::from_str::<HooksFileCompat>(old);
        println!("Compat parse: {:?}", compat);
        assert!(compat.is_ok(), "Compat format should parse old hooks.toml");

        let compat = compat.unwrap();
        let hooks = HooksFile {
            tasks: compat
                .tasks
                .into_iter()
                .map(|(k, v)| (k, HookEntry::from(v)))
                .collect(),
        };
        assert_eq!(hooks.tasks.len(), 1);
        assert_eq!(
            hooks.tasks["handle-tt-account-unbind"].level,
            NotificationLevel::Notice
        );
    }

    #[test]
    fn test_deserialize_new_format() {
        let new = r#"[tasks.demo-task]
level = "notice"
timestamp = "2026-02-06T15:25:11.594286Z"
"#;
        let result = toml::from_str::<HooksFile>(new);
        println!("New format parse: {:?}", result);
        assert!(
            result.is_ok(),
            "New format should parse: {:?}",
            result.err()
        );

        let hooks = result.unwrap();
        assert_eq!(hooks.tasks.len(), 1);
        assert_eq!(hooks.tasks["demo-task"].level, NotificationLevel::Notice);
    }

    #[test]
    fn test_roundtrip() {
        let mut hooks = HooksFile::default();
        hooks.update("test-task", NotificationLevel::Warn, Some("hello".into()));

        let serialized = toml::to_string_pretty(&hooks).unwrap();
        println!("Serialized:\n{}", serialized);

        let deserialized = toml::from_str::<HooksFile>(&serialized);
        println!("Deserialized: {:?}", deserialized);
        assert!(
            deserialized.is_ok(),
            "Roundtrip should work: {:?}",
            deserialized.err()
        );

        let deserialized = deserialized.unwrap();
        assert_eq!(deserialized.tasks.len(), 1);
        assert_eq!(
            deserialized.tasks["test-task"].level,
            NotificationLevel::Warn
        );
        assert_eq!(
            deserialized.tasks["test-task"].message.as_deref(),
            Some("hello")
        );
    }
}

//! Hook 通知系统

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;

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
pub fn save_hooks(project_key: &str, hooks: &HooksFile) -> Result<(), String> {
    let project_dir = storage::grove_dir().join("projects").join(project_key);
    fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;

    let hooks_path = project_dir.join("hooks.toml");
    let content = toml::to_string_pretty(hooks).map_err(|e| e.to_string())?;
    fs::write(&hooks_path, content).map_err(|e| e.to_string())
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

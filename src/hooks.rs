//! Hook 通知系统

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::storage::{self, tasks, workspace::project_hash};

/// 通知级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    Notice = 0,
    Warn = 1,
    Critical = 2,
}


/// Hooks 文件结构
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HooksFile {
    #[serde(default)]
    pub tasks: HashMap<String, NotificationLevel>,
}

impl HooksFile {
    /// 更新 task 的通知级别（只保留更高级别）
    pub fn update(&mut self, task_id: &str, level: NotificationLevel) {
        let current = self.tasks.get(task_id).copied();
        if current.is_none() || level > current.unwrap() {
            self.tasks.insert(task_id.to_string(), level);
        }
    }
}

/// 加载项目的 hooks 文件
pub fn load_hooks(project_name: &str) -> HooksFile {
    let project_dir = storage::grove_dir().join("projects").join(project_name);
    let hooks_path = project_dir.join("hooks.toml");

    if hooks_path.exists() {
        fs::read_to_string(&hooks_path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        HooksFile::default()
    }
}

/// 保存项目的 hooks 文件
pub fn save_hooks(project_name: &str, hooks: &HooksFile) -> Result<(), String> {
    let project_dir = storage::grove_dir().join("projects").join(project_name);
    fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;

    let hooks_path = project_dir.join("hooks.toml");
    let content = toml::to_string_pretty(hooks).map_err(|e| e.to_string())?;
    fs::write(&hooks_path, content).map_err(|e| e.to_string())
}

/// 从项目路径提取项目名称
pub fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string()
}

/// 加载 hooks 并自动清理不存在的 task
/// project_path: 项目的完整路径（用于计算 project_key）
/// project_name: 项目名称（用于 hooks 存储路径）
pub fn load_hooks_with_cleanup(project_path: &str, project_name: &str) -> HooksFile {
    let mut hooks = load_hooks(project_name);

    if hooks.tasks.is_empty() {
        return hooks;
    }

    // 获取项目的 task 列表
    let project_key = project_hash(project_path);
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
        let _ = save_hooks(project_name, &hooks);
    }

    hooks
}

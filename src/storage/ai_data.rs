use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::ensure_project_dir;

/// AI TODO 数据结构
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TodoData {
    #[serde(default)]
    pub todo: Vec<String>,
    #[serde(default)]
    pub done: Vec<String>,
}

impl TodoData {
    pub fn is_empty(&self) -> bool {
        self.todo.is_empty() && self.done.is_empty()
    }
}

/// 获取 ai 目录路径
fn ai_dir(project: &str, task_id: &str) -> io::Result<PathBuf> {
    let dir = ensure_project_dir(project)?.join("ai").join(task_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 读取 AI summary
pub fn load_summary(project: &str, task_id: &str) -> io::Result<String> {
    let path = ai_dir(project, task_id)?.join("summary.md");
    if path.exists() {
        std::fs::read_to_string(&path)
    } else {
        Ok(String::new())
    }
}

/// 保存 AI summary
pub fn save_summary(project: &str, task_id: &str, content: &str) -> io::Result<()> {
    let path = ai_dir(project, task_id)?.join("summary.md");
    std::fs::write(&path, content)
}

/// 读取 AI TODO
pub fn load_todo(project: &str, task_id: &str) -> io::Result<TodoData> {
    let path = ai_dir(project, task_id)?.join("todo.json");
    if path.exists() {
        let content = std::fs::read_to_string(&path)?;
        serde_json::from_str(&content).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    } else {
        Ok(TodoData::default())
    }
}

/// 保存 AI TODO
pub fn save_todo(project: &str, task_id: &str, data: &TodoData) -> io::Result<()> {
    let path = ai_dir(project, task_id)?.join("todo.json");
    let content = serde_json::to_string_pretty(data).map_err(io::Error::other)?;
    std::fs::write(&path, content)
}

/// 获取 todo.json 距上次修改过了多少秒
pub fn todo_modified_secs_ago(project: &str, task_id: &str) -> Option<u64> {
    let path = ai_dir(project, task_id).ok()?.join("todo.json");
    let metadata = std::fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok()?;
    modified.elapsed().ok().map(|d| d.as_secs())
}

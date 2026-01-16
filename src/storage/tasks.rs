use std::io;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ensure_project_dir;

/// 任务状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Active,
    Archived,
}

/// 任务数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// 任务 ID (slug 形式，如 "oauth-login")
    pub id: String,
    /// 任务名称 (用户输入，如 "Add OAuth login")
    pub name: String,
    /// 分支名 (如 "feature/oauth-login")
    pub branch: String,
    /// 目标分支 (如 "main")
    pub target: String,
    /// Worktree 路径
    pub worktree_path: String,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 更新时间
    #[serde(default = "default_updated_at")]
    pub updated_at: DateTime<Utc>,
    /// 任务状态
    pub status: TaskStatus,
}

fn default_updated_at() -> DateTime<Utc> {
    Utc::now()
}

/// 任务列表容器 (用于 TOML 序列化)
#[derive(Debug, Default, Serialize, Deserialize)]
struct TasksFile {
    #[serde(default)]
    tasks: Vec<Task>,
}

/// 获取 tasks.toml 文件路径
fn tasks_file_path(project: &str) -> io::Result<PathBuf> {
    let dir = ensure_project_dir(project)?;
    Ok(dir.join("tasks.toml"))
}

/// 加载任务列表
pub fn load_tasks(project: &str) -> io::Result<Vec<Task>> {
    let path = tasks_file_path(project)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)?;
    let tasks_file: TasksFile =
        toml::from_str(&content).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(tasks_file.tasks)
}

/// 保存任务列表
pub fn save_tasks(project: &str, tasks: &[Task]) -> io::Result<()> {
    let path = tasks_file_path(project)?;

    let tasks_file = TasksFile {
        tasks: tasks.to_vec(),
    };

    let content = toml::to_string_pretty(&tasks_file)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    std::fs::write(&path, content)?;
    Ok(())
}

/// 添加单个任务
pub fn add_task(project: &str, task: Task) -> io::Result<()> {
    let mut tasks = load_tasks(project)?;
    tasks.push(task);
    save_tasks(project, &tasks)
}

// ========== Archived Tasks (分离存储) ==========

/// 获取 archived.toml 文件路径
fn archived_file_path(project: &str) -> io::Result<PathBuf> {
    let dir = ensure_project_dir(project)?;
    Ok(dir.join("archived.toml"))
}

/// 加载归档任务列表
pub fn load_archived_tasks(project: &str) -> io::Result<Vec<Task>> {
    let path = archived_file_path(project)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)?;
    let tasks_file: TasksFile =
        toml::from_str(&content).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(tasks_file.tasks)
}

/// 保存归档任务列表
pub fn save_archived_tasks(project: &str, tasks: &[Task]) -> io::Result<()> {
    let path = archived_file_path(project)?;

    let tasks_file = TasksFile {
        tasks: tasks.to_vec(),
    };

    let content = toml::to_string_pretty(&tasks_file)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    std::fs::write(&path, content)?;
    Ok(())
}

/// 归档任务 (tasks.toml → archived.toml)
pub fn archive_task(project: &str, task_id: &str) -> io::Result<()> {
    let mut tasks = load_tasks(project)?;
    let mut archived = load_archived_tasks(project)?;

    // 找到并移除任务
    if let Some(pos) = tasks.iter().position(|t| t.id == task_id) {
        let mut task = tasks.remove(pos);
        task.status = TaskStatus::Archived;
        task.updated_at = Utc::now();
        archived.push(task);

        save_tasks(project, &tasks)?;
        save_archived_tasks(project, &archived)?;
    }

    Ok(())
}

/// 恢复任务 (archived.toml → tasks.toml)
pub fn recover_task(project: &str, task_id: &str) -> io::Result<()> {
    let mut tasks = load_tasks(project)?;
    let mut archived = load_archived_tasks(project)?;

    // 找到并移除归档任务
    if let Some(pos) = archived.iter().position(|t| t.id == task_id) {
        let mut task = archived.remove(pos);
        task.status = TaskStatus::Active;
        task.updated_at = Utc::now();
        tasks.push(task);

        save_tasks(project, &tasks)?;
        save_archived_tasks(project, &archived)?;
    }

    Ok(())
}

/// 删除活跃任务
pub fn remove_task(project: &str, task_id: &str) -> io::Result<()> {
    let mut tasks = load_tasks(project)?;
    tasks.retain(|t| t.id != task_id);
    save_tasks(project, &tasks)
}

/// 删除归档任务
pub fn remove_archived_task(project: &str, task_id: &str) -> io::Result<()> {
    let mut archived = load_archived_tasks(project)?;
    archived.retain(|t| t.id != task_id);
    save_archived_tasks(project, &archived)
}

/// 更新任务的 target branch
pub fn update_task_target(project: &str, task_id: &str, new_target: &str) -> io::Result<()> {
    let mut tasks = load_tasks(project)?;

    if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
        task.target = new_target.to_string();
        task.updated_at = Utc::now();
        save_tasks(project, &tasks)?;
    }

    Ok(())
}

/// 根据 task_id 获取任务（从 tasks.toml）
pub fn get_task(project: &str, task_id: &str) -> io::Result<Option<Task>> {
    let tasks = load_tasks(project)?;
    Ok(tasks.into_iter().find(|t| t.id == task_id))
}

/// 根据 task_id 获取归档任务
pub fn get_archived_task(project: &str, task_id: &str) -> io::Result<Option<Task>> {
    let archived = load_archived_tasks(project)?;
    Ok(archived.into_iter().find(|t| t.id == task_id))
}

/// 生成 slug (用于任务 ID 和目录名)
pub fn to_slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// 生成分支名
/// - 如果 task_name 包含 `/`，使用第一个 `/` 前面的作为前缀
/// - 否则使用默认前缀 `grove/`
/// - 所有非法字符由 to_slug() 处理（转为 -，合并连续 -）
pub fn generate_branch_name(task_name: &str) -> String {
    if let Some(slash_idx) = task_name.find('/') {
        // 用户提供了前缀 - 只取第一个 / 前面的
        let prefix = &task_name[..slash_idx];
        let body = &task_name[slash_idx + 1..];
        let prefix_slug = to_slug(prefix);
        let body_slug = to_slug(body); // 后续的 / 也会被转成 -

        if prefix_slug.is_empty() {
            // 前缀为空（比如 "/xxx"）→ 使用默认 grove/
            if body_slug.is_empty() {
                "grove/task".to_string()
            } else {
                format!("grove/{}", body_slug)
            }
        } else if body_slug.is_empty() {
            format!("{}/task", prefix_slug)
        } else {
            format!("{}/{}", prefix_slug, body_slug)
        }
    } else {
        // 没有 / → 默认使用 grove/ 前缀
        let slug = to_slug(task_name);
        if slug.is_empty() {
            "grove/task".to_string()
        } else {
            format!("grove/{}", slug)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_slug() {
        assert_eq!(to_slug("Add OAuth login"), "add-oauth-login");
        assert_eq!(to_slug("Fix: header bug"), "fix-header-bug");
        assert_eq!(to_slug("  multiple   spaces  "), "multiple-spaces");
    }

    #[test]
    fn test_generate_branch_name() {
        // 用户提供前缀
        assert_eq!(generate_branch_name("fix/header bug"), "fix/header-bug");
        assert_eq!(
            generate_branch_name("feature/oauth login"),
            "feature/oauth-login"
        );
        assert_eq!(generate_branch_name("hotfix/urgent"), "hotfix/urgent");
        assert_eq!(
            generate_branch_name("fix data / add enum"),
            "fix-data/add-enum"
        );

        // 默认 grove/ 前缀
        assert_eq!(
            generate_branch_name("Add new feature"),
            "grove/add-new-feature"
        );
        assert_eq!(
            generate_branch_name("Fix: header bug"),
            "grove/fix-header-bug"
        );
        assert_eq!(generate_branch_name("#123 bug fix"), "grove/123-bug-fix");

        // 边缘情况
        assert_eq!(generate_branch_name("fix/feat/xxx"), "fix/feat-xxx");
        assert_eq!(generate_branch_name("/xxx"), "grove/xxx");
        assert_eq!(generate_branch_name("add - - enum"), "grove/add-enum");
        assert_eq!(generate_branch_name("fix/"), "fix/task");
        assert_eq!(generate_branch_name("   "), "grove/task");
    }
}

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

/// 更新 task 的 updated_at 时间戳
pub fn touch_task(project: &str, task_id: &str) -> io::Result<()> {
    let mut tasks = load_tasks(project)?;

    if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
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

/// 基于当前时间戳生成 6 位短哈希
fn generate_time_hash() -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    let mut hash = FNV_OFFSET_BASIS;
    for byte in timestamp.to_le_bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:06x}", hash & 0xFFFFFF)
}

/// 截断 slug 到最多 max_words 个单词
fn truncate_to_words(slug: &str, max_words: usize) -> String {
    slug.split('-')
        .take(max_words)
        .collect::<Vec<_>>()
        .join("-")
}

/// 生成分支名核心逻辑（不含哈希后缀）
fn generate_branch_name_base(task_name: &str, max_words: usize) -> String {
    if let Some(slash_idx) = task_name.find('/') {
        // 用户提供了前缀 - 只取第一个 / 前面的
        let prefix = &task_name[..slash_idx];
        let body = &task_name[slash_idx + 1..];
        let prefix_slug = to_slug(prefix);
        let body_slug = truncate_to_words(&to_slug(body), max_words);

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
        let slug = truncate_to_words(&to_slug(task_name), max_words);
        if slug.is_empty() {
            "grove/task".to_string()
        } else {
            format!("grove/{}", slug)
        }
    }
}

/// 生成分支名（用于实际创建分支）
/// - 如果 task_name 包含 `/`，使用第一个 `/` 前面的作为前缀
/// - 否则使用默认前缀 `grove/`
/// - 所有非法字符由 to_slug() 处理（转为 -，合并连续 -）
/// - 限制最多 3 个单词
/// - 添加 6 位时间戳哈希后缀防止重名
pub fn generate_branch_name(task_name: &str) -> String {
    let base = generate_branch_name_base(task_name, 3);
    let hash = generate_time_hash();
    format!("{}-{}", base, hash)
}

/// 生成分支名预览（用于 UI 显示）
/// 显示 `<hash>` 占位符而非实际哈希值
pub fn preview_branch_name(task_name: &str) -> String {
    let base = generate_branch_name_base(task_name, 3);
    format!("{}-<hash>", base)
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
    fn test_truncate_to_words() {
        assert_eq!(
            truncate_to_words("add-oauth-login-support", 3),
            "add-oauth-login"
        );
        assert_eq!(truncate_to_words("bug", 3), "bug");
        assert_eq!(truncate_to_words("a-b-c-d-e", 3), "a-b-c");
        assert_eq!(truncate_to_words("single", 3), "single");
    }

    #[test]
    fn test_generate_branch_name_base() {
        // 用户提供前缀 - 限制 3 个单词
        assert_eq!(
            generate_branch_name_base("fix/header bug", 3),
            "fix/header-bug"
        );
        assert_eq!(
            generate_branch_name_base("feature/add oauth login support for github", 3),
            "feature/add-oauth-login"
        );
        assert_eq!(
            generate_branch_name_base("hotfix/urgent", 3),
            "hotfix/urgent"
        );

        // 默认 grove/ 前缀 - 限制 3 个单词
        assert_eq!(
            generate_branch_name_base("Add new feature for testing", 3),
            "grove/add-new-feature"
        );
        assert_eq!(
            generate_branch_name_base("Fix: header bug", 3),
            "grove/fix-header-bug"
        );

        // 边缘情况
        assert_eq!(generate_branch_name_base("fix/", 3), "fix/task");
        assert_eq!(generate_branch_name_base("   ", 3), "grove/task");
        assert_eq!(generate_branch_name_base("/xxx", 3), "grove/xxx");
    }

    #[test]
    fn test_generate_branch_name_has_hash() {
        let branch = generate_branch_name("feature/add oauth login support");
        // 格式: feature/add-oauth-login-xxxxxx
        assert!(branch.starts_with("feature/add-oauth-login-"));
        // 最后 6 位是哈希
        let hash_part = branch.split('-').last().unwrap();
        assert_eq!(hash_part.len(), 6);
        // 哈希应该是十六进制
        assert!(hash_part.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_preview_branch_name() {
        assert_eq!(
            preview_branch_name("feature/add oauth login support for github"),
            "feature/add-oauth-login-<hash>"
        );
        assert_eq!(preview_branch_name("fix/bug"), "fix/bug-<hash>");
        assert_eq!(
            preview_branch_name("Add new feature for testing"),
            "grove/add-new-feature-<hash>"
        );
    }

    #[test]
    fn test_generate_time_hash() {
        let hash1 = generate_time_hash();
        assert_eq!(hash1.len(), 6);
        assert!(hash1.chars().all(|c| c.is_ascii_hexdigit()));

        // 生成两次，应该不同（时间不同）
        std::thread::sleep(std::time::Duration::from_millis(1));
        let hash2 = generate_time_hash();
        assert_ne!(hash1, hash2);
    }
}

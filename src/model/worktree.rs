use chrono::{DateTime, Utc};

/// Worktree 的运行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// TODO: Conflict and Error are reserved for future conflict detection
#[allow(dead_code)]
pub enum WorktreeStatus {
    /// ○ idle: worktree 存在，无 session
    Idle,
    /// ● live: worktree 存在，session 运行中
    Live,
    /// ✓ merged: 已合并到 target branch
    Merged,
    /// ⚠ conflict: 存在合并冲突
    Conflict,
    /// ✗ broken: Task 存在但 worktree 被删除
    Broken,
    /// ✗ error: 异常状态
    Error,
    /// 📦 archived: 已归档
    Archived,
}

impl WorktreeStatus {}

/// 文件变更统计（overview 阶段不再计算，按需通过 diff API 获取）
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct FileChanges {
    pub additions: u32,
    pub deletions: u32,
    pub files_changed: u32,
}

impl FileChanges {
    #[allow(dead_code)]
    pub fn new(additions: u32, deletions: u32, files_changed: u32) -> Self {
        Self {
            additions,
            deletions,
            files_changed,
        }
    }
}

/// 单个 Worktree 的完整信息
#[derive(Debug, Clone)]
pub struct Worktree {
    /// 任务 ID (slug)
    pub id: String,
    /// 任务名称（显示用）
    pub task_name: String,
    /// 分支名称
    pub branch: String,
    /// 目标分支
    pub target: String,
    /// 当前状态
    pub status: WorktreeStatus,
    /// 文件变更统计（overview 阶段不再计算）
    #[allow(dead_code)]
    pub file_changes: FileChanges,
    /// Worktree 路径
    pub path: String,
    /// 解析后的 multiplexer 类型 ("tmux" | "zellij" | "acp")
    pub multiplexer: String,
    /// 创建时间
    // TODO: reserved for sorting/display in future UI
    #[allow(dead_code)]
    pub created_at: DateTime<Utc>,
    /// 更新时间
    pub updated_at: DateTime<Utc>,
    /// 创建来源: "agent" | "user" | ""
    pub created_by: String,
    /// 是否为 Local Task（指向主仓库，非 worktree）
    pub is_local: bool,
}

/// 格式化相对时间
pub fn format_relative_time(dt: DateTime<Utc>) -> String {
    let now = Utc::now();
    let duration = now.signed_duration_since(dt);

    let seconds = duration.num_seconds();
    if seconds < 0 {
        return "just now".to_string();
    }

    let minutes = duration.num_minutes();
    let hours = duration.num_hours();
    let days = duration.num_days();

    if seconds < 60 {
        "just now".to_string()
    } else if minutes < 60 {
        if minutes == 1 {
            "1 min ago".to_string()
        } else {
            format!("{} mins ago", minutes)
        }
    } else if hours < 24 {
        if hours == 1 {
            "1 hour ago".to_string()
        } else {
            format!("{} hours ago", hours)
        }
    } else if days < 30 {
        if days == 1 {
            "1 day ago".to_string()
        } else {
            format!("{} days ago", days)
        }
    } else if days < 365 {
        let months = days / 30;
        if months == 1 {
            "1 month ago".to_string()
        } else {
            format!("{} months ago", months)
        }
    } else {
        let years = days / 365;
        if years == 1 {
            "1 year ago".to_string()
        } else {
            format!("{} years ago", years)
        }
    }
}

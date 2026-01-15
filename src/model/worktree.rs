use chrono::{DateTime, Utc};

/// Worktree 的运行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl WorktreeStatus {
    /// 返回状态对应的图标
    pub fn icon(&self) -> &'static str {
        match self {
            WorktreeStatus::Idle => "○",
            WorktreeStatus::Live => "●",
            WorktreeStatus::Merged => "✓",
            WorktreeStatus::Conflict => "⚠",
            WorktreeStatus::Broken => "✗",
            WorktreeStatus::Error => "✗",
            WorktreeStatus::Archived => "📦",
        }
    }

    /// 返回状态文字标签
    pub fn label(&self) -> &'static str {
        match self {
            WorktreeStatus::Idle => "Idle",
            WorktreeStatus::Live => "Live",
            WorktreeStatus::Merged => "Merged",
            WorktreeStatus::Conflict => "Conflict",
            WorktreeStatus::Broken => "Broken",
            WorktreeStatus::Error => "Error",
            WorktreeStatus::Archived => "Archived",
        }
    }
}

/// 文件变更统计
#[derive(Debug, Clone, Default)]
pub struct FileChanges {
    pub additions: u32,
    pub deletions: u32,
}

impl FileChanges {
    pub fn new(additions: u32, deletions: u32) -> Self {
        Self { additions, deletions }
    }

    pub fn is_clean(&self) -> bool {
        self.additions == 0 && self.deletions == 0
    }

    /// 格式化显示，如 "+5 -2" 或 "clean"
    pub fn display(&self) -> String {
        if self.is_clean() {
            "clean".to_string()
        } else {
            format!("+{} -{}", self.additions, self.deletions)
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
    /// 落后 target branch 的 commit 数（None 表示无需显示）
    pub commits_behind: Option<u32>,
    /// 文件变更统计
    pub file_changes: FileChanges,
    /// 是否已归档
    pub archived: bool,
    /// Worktree 路径
    pub path: String,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 更新时间
    pub updated_at: DateTime<Utc>,
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

/// Project 层级的 Tab 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProjectTab {
    #[default]
    Current,
    Other,
    Archived,
}

impl ProjectTab {
    /// 切换到下一个 Tab（循环）
    pub fn next(&self) -> Self {
        match self {
            ProjectTab::Current => ProjectTab::Other,
            ProjectTab::Other => ProjectTab::Archived,
            ProjectTab::Archived => ProjectTab::Current,
        }
    }

    /// Tab 显示名称
    pub fn label(&self) -> &'static str {
        match self {
            ProjectTab::Current => "Current",
            ProjectTab::Other => "Other",
            ProjectTab::Archived => "Archived",
        }
    }

    /// 转换为数组索引
    pub fn index(&self) -> usize {
        match self {
            ProjectTab::Current => 0,
            ProjectTab::Other => 1,
            ProjectTab::Archived => 2,
        }
    }
}

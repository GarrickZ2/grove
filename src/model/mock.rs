//! Mock 数据生成（已弃用，保留文件避免编译错误）
//! 真实数据通过 loader.rs 从 tasks.toml 加载

use chrono::Utc;

use super::worktree::{FileChanges, Worktree, WorktreeStatus};

/// 生成 Mock 数据（已弃用）
#[allow(dead_code)]
pub fn generate_mock_worktrees() -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    let now = Utc::now();

    let current = vec![Worktree {
        id: "mock-task".to_string(),
        task_name: "Mock Task".to_string(),
        branch: "feature/mock".to_string(),
        target: "main".to_string(),
        status: WorktreeStatus::Idle,
        commits_behind: None,
        file_changes: FileChanges::default(),
        archived: false,
        path: String::new(),
        created_at: now,
        updated_at: now,
    }];

    (current, vec![], vec![])
}

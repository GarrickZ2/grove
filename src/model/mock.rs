use super::worktree::{FileChanges, Worktree, WorktreeStatus};

/// 生成 Mock 数据，返回 (Current, Other, Archived) 三个 Tab 的 worktree 列表
pub fn generate_mock_worktrees() -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    // Current Tab - 基于当前 HEAD 的 worktree
    let current = vec![
        Worktree {
            task_name: "Add OAuth login".to_string(),
            branch: "feature/oauth".to_string(),
            status: WorktreeStatus::Live,
            commits_behind: Some(2),
            file_changes: FileChanges::new(5, 2),
            archived: false,
            path: "~/.worktrees/oauth".to_string(),
        },
        Worktree {
            task_name: "Fix header bug".to_string(),
            branch: "fix/header".to_string(),
            status: WorktreeStatus::Idle,
            commits_behind: None,
            file_changes: FileChanges::new(1, 0),
            archived: false,
            path: "~/.worktrees/header".to_string(),
        },
        Worktree {
            task_name: "Refactor auth".to_string(),
            branch: "refactor/auth".to_string(),
            status: WorktreeStatus::Merged,
            commits_behind: None,
            file_changes: FileChanges::new(0, 0),
            archived: false,
            path: "~/.worktrees/auth".to_string(),
        },
    ];

    // Other Tab - 基于其他 branch 的 worktree
    let other = vec![
        Worktree {
            task_name: "API refactor".to_string(),
            branch: "feature/api-v2".to_string(),
            status: WorktreeStatus::Idle,
            commits_behind: Some(5),
            file_changes: FileChanges::new(120, 45),
            archived: false,
            path: "~/.worktrees/api-v2".to_string(),
        },
        Worktree {
            task_name: "Database migration".to_string(),
            branch: "feature/db-migration".to_string(),
            status: WorktreeStatus::Conflict,
            commits_behind: Some(3),
            file_changes: FileChanges::new(30, 10),
            archived: false,
            path: "~/.worktrees/db-migration".to_string(),
        },
    ];

    // Archived Tab
    let archived = vec![Worktree {
        task_name: "Old feature".to_string(),
        branch: "feature/old".to_string(),
        status: WorktreeStatus::Idle,
        commits_behind: None,
        file_changes: FileChanges::new(0, 0),
        archived: true,
        path: String::new(), // 已归档，无 worktree 路径
    }];

    (current, other, archived)
}

/// 生成空的 Mock 数据（用于测试空状态显示）
#[allow(dead_code)]
pub fn generate_empty_mock() -> (Vec<Worktree>, Vec<Worktree>, Vec<Worktree>) {
    (vec![], vec![], vec![])
}

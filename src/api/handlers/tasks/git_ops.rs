//! Task git operation handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use crate::api::error::ApiError;
use crate::git;
use crate::storage::tasks;

use super::super::common::find_project_by_id;
use super::types::*;

/// POST /api/v1/projects/{id}/tasks/{taskId}/sync
pub async fn sync_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    match crate::operations::tasks::sync_task(&project.path, &project_key, &task_id) {
        Ok(target) => Ok(Json(GitOperationResponse {
            success: true,
            message: format!("Synced with {}", target),
            warning: None,
        })),
        Err(e) => {
            let error_msg = e.to_string();
            let message = if error_msg.contains("conflict") || error_msg.contains("CONFLICT") {
                "Conflict detected - please resolve in terminal".to_string()
            } else {
                format!("Sync failed: {}", error_msg)
            };
            Ok(Json(GitOperationResponse {
                success: false,
                message,
                warning: None,
            }))
        }
    }
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/commit
pub async fn commit_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<CommitRequest>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    if let Err(e) = git::add_and_commit(&task.worktree_path, &req.message) {
        return Ok(Json(GitOperationResponse {
            success: false,
            message: e.to_string(),
            warning: None,
        }));
    }

    let _ = tasks::touch_task(&project_key, &task_id);

    Ok(Json(GitOperationResponse {
        success: true,
        message: "Committed successfully".to_string(),
        warning: None,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/merge
pub async fn merge_task(
    Path((id, task_id)): Path<(String, String)>,
    body: Option<Json<MergeRequest>>,
) -> Result<Json<GitOperationResponse>, StatusCode> {
    let (project, project_key) = find_project_by_id(&id)?;

    let method_str = body.as_ref().and_then(|b| b.method.as_deref());
    let method = match method_str {
        Some("squash") => crate::operations::tasks::MergeMethod::Squash,
        Some("merge-commit") => crate::operations::tasks::MergeMethod::MergeCommit,
        _ => {
            let task = tasks::get_task(&project_key, &task_id)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .ok_or(StatusCode::NOT_FOUND)?;
            let count =
                git::commits_behind(&task.worktree_path, &task.branch, &task.target).unwrap_or(0);
            if count > 1 {
                crate::operations::tasks::MergeMethod::Squash
            } else {
                crate::operations::tasks::MergeMethod::MergeCommit
            }
        }
    };

    match crate::operations::tasks::merge_task(&project.path, &project_key, &task_id, method) {
        Ok(result) => Ok(Json(GitOperationResponse {
            success: true,
            message: format!("Merged into {}", result.target_branch),
            warning: result.warning,
        })),
        Err(e) => Ok(Json(GitOperationResponse {
            success: false,
            message: e.to_string(),
            warning: None,
        })),
    }
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/reset
pub async fn reset_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiError>)> {
    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let task_info = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    match crate::operations::tasks::reset_task(
        &project.path,
        &project_key,
        &task_id,
        &task_info.multiplexer,
        &task_info.session_name,
    ) {
        Ok(_) => Ok(Json(GitOperationResponse {
            success: true,
            message: "Task reset successfully".to_string(),
            warning: None,
        })),
        Err(e) => Ok(Json(GitOperationResponse {
            success: false,
            message: format!("Failed to reset task: {}", e),
            warning: None,
        })),
    }
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/rebase-to
pub async fn rebase_to_task(
    Path((id, task_id)): Path<(String, String)>,
    Json(req): Json<RebaseToRequest>,
) -> Result<Json<GitOperationResponse>, (StatusCode, Json<ApiError>)> {
    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "Cannot rebase local task".to_string(),
            }),
        ));
    }

    let (project, project_key) = find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let _task = tasks::get_task(&project_key, &task_id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to load task: {}", e),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "Task not found".to_string(),
                }),
            )
        })?;

    if !git::branch_exists(&project.path, &req.target) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("Branch '{}' does not exist", req.target),
            }),
        ));
    }

    tasks::update_task_target(&project_key, &task_id, &req.target).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to update task target: {}", e),
            }),
        )
    })?;

    Ok(Json(GitOperationResponse {
        success: true,
        message: format!("Target branch changed to '{}'", req.target),
        warning: None,
    }))
}

fn review_diff_entries(
    worktree_path: &str,
    target: &str,
    query: &DiffQuery,
) -> Result<Vec<git::ReviewDiffEntry>, (StatusCode, Json<ApiError>)> {
    let base = query
        .from_ref
        .clone()
        .unwrap_or_else(|| git::effective_review_base(worktree_path, target));
    let result = git::ReviewComparison::new(worktree_path, &base, query.to_ref.as_deref())
        .and_then(|comparison| comparison.entries());
    result.map_err(|error| ApiError::internal(format!("Failed to load diff: {error}")))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/diff
pub async fn get_diff(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<DiffResponse>, (StatusCode, Json<ApiError>)> {
    let (_project, project_key) = find_project_by_id(&id)
        .map_err(|status| ApiError::map_status(status, "Failed to load project"))?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|error| ApiError::internal(format!("Failed to load task: {error}")))?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    let diff_entries = review_diff_entries(&task.worktree_path, &task.target, &query)?;

    let mut total_additions = 0u32;
    let mut total_deletions = 0u32;

    let files: Vec<DiffFileEntry> = diff_entries
        .into_iter()
        .filter(|entry| {
            entry.additions > 0 || entry.deletions > 0 || entry.is_binary || entry.status == 'R'
        })
        .map(|entry| {
            total_additions += entry.additions;
            total_deletions += entry.deletions;

            let status = match entry.status {
                'A' => DiffStatus::Added,
                'D' => DiffStatus::Deleted,
                'R' => DiffStatus::Renamed,
                'U' => DiffStatus::Untracked,
                _ => DiffStatus::Modified,
            };

            DiffFileEntry {
                path: entry.path,
                old_path: entry.old_path,
                status,
                additions: entry.additions,
                deletions: entry.deletions,
                is_binary: entry.is_binary,
            }
        })
        .collect();

    Ok(Json(DiffResponse {
        files,
        total_additions,
        total_deletions,
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/commits
pub async fn get_commits(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<CommitsResponse>, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    // Base 走 origin fallback：本地 target 落后于 origin/<target> 的大仓库
    // 里，两点间的 commit 列表会被远端领先的 commits 撑爆。
    let base = git::effective_review_base(&task.worktree_path, &task.target);

    // Version 下拉最多列 500 条 —— 评审用不到更细的粒度，列全只会拖慢
    // 接口与前端渲染。真实总数单独计数（git rev-list --count）。
    const MAX_VERSION_COMMITS: usize = 500;
    let log_entries = git::log_target_to_head(&task.worktree_path, &base, MAX_VERSION_COMMITS)
        .unwrap_or_default();
    let total = git::count_target_to_head(&task.worktree_path, &base)
        .unwrap_or(log_entries.len() as u32)
        .max(log_entries.len() as u32);
    let truncated = total as usize > log_entries.len();

    // skip_versions: 顶部连续多少条 commit 的 tree 与 HEAD 的 tree 相同。
    // gix log 返回的第一条就是 HEAD,其 tree_id 即可作为基准 —— 无需再查。
    let dirty = git::has_uncommitted_changes(&task.worktree_path).unwrap_or(false);
    let skip_versions = if dirty {
        0u32
    } else if let Some(head_tree) = log_entries.first().map(|e| e.tree_id.clone()) {
        log_entries
            .iter()
            .take_while(|e| e.tree_id == head_tree)
            .count() as u32
    } else {
        // No commits between target..HEAD — worktree is at exactly target.
        0
    };

    let commits: Vec<CommitEntry> = log_entries
        .into_iter()
        .map(|entry| CommitEntry {
            hash: entry.hash,
            message: entry.message,
            time_ago: entry.time_ago,
        })
        .collect();

    Ok(Json(CommitsResponse {
        commits,
        total,
        skip_versions,
        truncated,
    }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}/diff/file?path=...&from_ref=...&to_ref=...
pub async fn get_single_file_diff(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<SingleFileDiffQuery>,
) -> Result<axum::response::Response, StatusCode> {
    let (_project, project_key) = find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    let default_base = git::effective_review_base(&task.worktree_path, &task.target);
    let from_ref = query.from_ref.as_deref().or(Some(&default_base));
    let to_ref = query.to_ref.as_deref();

    let result = crate::diff::get_single_file_diff(
        &task.worktree_path,
        &query.path,
        from_ref,
        to_ref,
        query.old_path.as_deref(),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(result).into_response())
}

#[cfg(test)]
mod review_diff_tests {
    use super::*;

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        git::git_cmd(path, &["init", "-b", "main"]).unwrap();
        git::git_cmd(path, &["config", "user.email", "test@example.com"]).unwrap();
        git::git_cmd(path, &["config", "user.name", "test"]).unwrap();
        git::git_cmd(path, &["commit", "--allow-empty", "-m", "initial"]).unwrap();
        dir
    }

    #[test]
    fn review_detects_untracked_and_committed_renames_without_changing_index() {
        let dir = init_repo();
        let path = dir.path().to_str().unwrap();
        let original = (0..30).map(|i| format!("line {i}\n")).collect::<String>();
        std::fs::write(dir.path().join("old name.txt"), &original).unwrap();
        git::git_cmd(path, &["add", "old name.txt"]).unwrap();
        git::git_cmd(path, &["commit", "-m", "base"]).unwrap();
        let base = git::git_cmd(path, &["rev-parse", "HEAD"]).unwrap();
        std::fs::rename(
            dir.path().join("old name.txt"),
            dir.path().join("new name.txt"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("new name.txt"),
            original.replace("line 15\n", "changed line\n"),
        )
        .unwrap();
        let before = git::git_cmd(path, &["status", "--porcelain=v1"]).unwrap();
        let comparison = git::ReviewComparison::new(path, &base, None).unwrap();
        let entries = comparison.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, 'R');
        assert_eq!(entries[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(entries[0].path, "new name.txt");
        assert_eq!((entries[0].additions, entries[0].deletions), (1, 1));
        let diff = crate::diff::get_single_file_diff(
            path,
            "new name.txt",
            Some(&base),
            None,
            Some("old name.txt"),
        )
        .unwrap();
        assert_eq!(diff.change_type, "renamed");
        assert_eq!(diff.old_path, "old name.txt");
        assert_eq!((diff.additions, diff.deletions), (1, 1));
        assert_eq!(
            before,
            git::git_cmd(path, &["status", "--porcelain=v1"]).unwrap()
        );
        git::git_cmd(path, &["add", "-A"]).unwrap();
        git::git_cmd(path, &["commit", "-m", "rename"]).unwrap();
        let committed = git::ReviewComparison::new(path, &base, Some("HEAD")).unwrap();
        let entries = committed.entries().unwrap();
        assert_eq!(entries[0].status, 'R');
        assert_eq!(entries[0].old_path.as_deref(), Some("old name.txt"));
        let diff = crate::diff::get_single_file_diff(
            path,
            "new name.txt",
            Some(&base),
            Some("HEAD"),
            Some("old name.txt"),
        )
        .unwrap();
        assert_eq!(diff.change_type, "renamed");
        assert_eq!((diff.additions, diff.deletions), (1, 1));
    }

    #[test]
    fn review_keeps_pure_renames_and_untracked_status() {
        let dir = init_repo();
        let path = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("old"), "").unwrap();
        git::git_cmd(path, &["add", "old"]).unwrap();
        git::git_cmd(path, &["commit", "-m", "base"]).unwrap();
        std::fs::rename(dir.path().join("old"), dir.path().join("new")).unwrap();
        std::fs::write(dir.path().join("extra"), "new content\n").unwrap();
        let entries = review_diff_entries(
            path,
            "HEAD",
            &DiffQuery {
                from_ref: None,
                to_ref: None,
            },
        )
        .unwrap();
        assert!(entries
            .iter()
            .any(|e| e.status == 'R' && e.path == "new" && e.additions == 0 && e.deletions == 0));
        assert!(entries.iter().any(|e| e.status == 'U' && e.path == "extra"));
    }

    #[tokio::test]
    async fn invalid_refs_return_json_errors_instead_of_empty_changes() {
        let dir = init_repo();
        let path = dir.path().to_str().unwrap();
        for to_ref in [None, Some("HEAD".to_owned())] {
            let query = DiffQuery {
                from_ref: None,
                to_ref,
            };
            let error = review_diff_entries(path, "missing-target", &query).unwrap_err();
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let message = body["error"].as_str().unwrap();
            assert!(message.contains("Failed to load diff"));
            assert!(message.contains("missing-target"));
        }
    }

    #[test]
    fn remote_only_target_loads_changes_and_preserves_explicit_ref_errors() {
        let dir = init_repo();
        let path = dir.path().to_str().unwrap();
        git::git_cmd(path, &["update-ref", "refs/remotes/origin/main", "HEAD"]).unwrap();
        git::git_cmd(path, &["checkout", "-b", "task"]).unwrap();
        git::git_cmd(path, &["branch", "-D", "main"]).unwrap();
        let mut query = DiffQuery {
            from_ref: None,
            to_ref: None,
        };
        assert!(review_diff_entries(path, "main", &query)
            .unwrap()
            .is_empty());

        std::fs::write(dir.path().join("new.txt"), "new content\n").unwrap();
        git::git_cmd(path, &["add", "new.txt"]).unwrap();
        let entries = review_diff_entries(path, "main", &query).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new.txt");
        assert_eq!(entries[0].additions, 1);

        query.from_ref = Some("main".to_owned());
        assert!(review_diff_entries(path, "main", &query).is_err());
        query.from_ref = None;
        query.to_ref = Some("missing-version".to_owned());
        assert!(review_diff_entries(path, "main", &query).is_err());
    }
}

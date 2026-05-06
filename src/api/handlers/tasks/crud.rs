//! Task CRUD handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};

use std::fs;

use crate::api::error::ApiError;
use crate::git;
use crate::hooks;
use crate::model::loader;
use crate::session::{self, SessionType};
use crate::storage::{self, notes, tasks, workspace};

use super::super::common;
use super::super::projects::{storage_task_to_response, TaskResponse};
use super::types::*;

/// Get git user.name for a task's worktree (used for display purposes in frontend).
pub(crate) fn get_git_user_name(project_key: &str, task_id: &str) -> Option<String> {
    tasks::get_task(project_key, task_id)
        .ok()
        .flatten()
        .and_then(|task| git::git_user_name(&task.worktree_path))
}

/// GET /api/v1/projects/{id}/tasks
pub async fn list_tasks(
    Path(id): Path<String>,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<TaskListResponse>, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;
    let filter = query.filter.as_deref().unwrap_or("active");

    if project.project_type == workspace::ProjectType::Studio {
        let filter_owned = filter.to_string();
        let pk = project_key.clone();
        let mut tasks: Vec<TaskResponse> = tokio::task::spawn_blocking(move || {
            let stored = if filter_owned == "archived" {
                tasks::load_archived_tasks(&pk).unwrap_or_default()
            } else {
                tasks::load_tasks(&pk).unwrap_or_default()
            };
            stored.iter().map(storage_task_to_response).collect()
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        return Ok(Json(TaskListResponse { tasks }));
    }

    let project_path = project.path.clone();
    let filter_owned = filter.to_string();
    let mut tasks: Vec<TaskResponse> = tokio::task::spawn_blocking(move || {
        if filter_owned == "archived" {
            let archived = loader::load_archived_worktrees(&project_path);
            archived.iter().map(common::worktree_to_response).collect()
        } else {
            let active = loader::load_worktrees(&project_path);
            active.iter().map(common::worktree_to_response).collect()
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(Json(TaskListResponse { tasks }))
}

/// GET /api/v1/projects/{id}/tasks/{taskId}
pub async fn get_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;

    if project.project_type == workspace::ProjectType::Studio {
        let pk = project_key.clone();
        let tid = task_id.clone();
        let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
            tasks::get_task(&pk, &tid)
                .ok()
                .flatten()
                .or_else(|| tasks::get_archived_task(&pk, &tid).ok().flatten())
                .map(|task| storage_task_to_response(&task))
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return result.map(Json).ok_or(StatusCode::NOT_FOUND);
    }

    let project_path = project.path.clone();
    let tid = task_id.clone();
    let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
        if tid == crate::storage::tasks::LOCAL_TASK_ID {
            return loader::load_local_task(&project_path)
                .map(|wt| common::worktree_to_response(&wt));
        }
        let active = loader::load_worktrees(&project_path);
        if let Some(wt) = active.iter().find(|wt| wt.id == tid) {
            return Some(common::worktree_to_response(wt));
        }
        let archived = loader::load_archived_worktrees(&project_path);
        archived
            .iter()
            .find(|wt| wt.id == tid)
            .map(common::worktree_to_response)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    result.map(Json).ok_or(StatusCode::NOT_FOUND)
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/activate
///
/// Marks a task workspace as actively viewed. Triggered by the frontend
/// when the user enters the task page so the file watcher attaches lazily
/// (instead of eagerly at server startup). Idempotent.
///
/// Skipped for archived tasks (their worktree may not exist on disk) and
/// the LOCAL_TASK_ID pseudo-task.
pub async fn activate_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;

    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Ok(StatusCode::NO_CONTENT);
    }

    let is_studio = project.project_type == workspace::ProjectType::Studio;
    let project_path = project.path.clone();
    let pk = project_key.clone();
    let tid = task_id.clone();

    let worktree_path: Option<String> = tokio::task::spawn_blocking(move || {
        if is_studio {
            // Studio tasks: only active (non-archived)
            tasks::get_task(&pk, &tid)
                .ok()
                .flatten()
                .map(|t| t.worktree_path)
        } else {
            // Coding tasks: only active worktrees, skip archived
            let active = loader::load_worktrees(&project_path);
            active
                .iter()
                .find(|wt| wt.id == tid)
                .map(|wt| wt.path.clone())
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(path) = worktree_path else {
        return Ok(StatusCode::NO_CONTENT);
    };
    if !std::path::Path::new(&path).exists() {
        return Ok(StatusCode::NO_CONTENT);
    }

    crate::api::state::ensure_task_active(&project_key, &task_id, &path);
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/tasks
pub async fn create_task(
    Path(id): Path<String>,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ApiError>)> {
    let (project, project_key) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let full_config = storage::config::load_config();
    let is_studio = project.project_type == workspace::ProjectType::Studio;

    let result = if is_studio {
        crate::operations::tasks::create_studio_task(
            &project.path,
            &project_key,
            req.name.clone(),
            &full_config.default_session_type(),
            "user",
        )
    } else {
        let target = req.target.unwrap_or_else(|| {
            git::current_branch(&project.path).unwrap_or_else(|_| "main".to_string())
        });
        let autolink_patterns = &full_config.auto_link.patterns;

        crate::operations::tasks::create_task(
            &project.path,
            &project_key,
            req.name.clone(),
            target,
            &full_config.default_session_type(),
            autolink_patterns,
            "user",
        )
    }
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("already exists") {
            (StatusCode::CONFLICT, Json(ApiError { error: msg }))
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: msg }),
            )
        }
    })?;

    if let Some(ref notes_content) = req.notes {
        if !notes_content.is_empty() {
            let _ = notes::save_notes(&project_key, &result.task.id, notes_content);
        }
    }

    let _ = crate::storage::taskgroups::ensure_system_groups();
    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    Ok(Json(TaskResponse {
        id: result.task.id.clone(),
        name: result.task.name.clone(),
        branch: result.task.branch.clone(),
        target: result.task.target.clone(),
        status: "idle".to_string(),
        additions: 0,
        deletions: 0,
        files_changed: 0,
        initial_commit: None,
        commits: Vec::new(),
        created_at: result.task.created_at.to_rfc3339(),
        updated_at: result.task.updated_at.to_rfc3339(),
        path: result.worktree_path.clone(),
        multiplexer: result.task.multiplexer.clone(),
        created_by: result.task.created_by.clone(),
        is_local: false,
    }))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/archive
pub async fn archive_task(
    Path((id, task_id)): Path<(String, String)>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ArchiveConfirmResponse>)> {
    let (project, project_key) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ArchiveConfirmResponse::error(
                "PROJECT_NOT_FOUND",
                "Project not found",
                task_id.clone(),
            )),
        )
    })?;

    let force = query.force.unwrap_or(false);

    if project.project_type == workspace::ProjectType::Studio {
        let task = tasks::get_task(&project_key, &task_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_LOAD_FAILED",
                        "Failed to load task",
                        task_id.clone(),
                    )),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                )
            })?;

        if !force {
            let input_dir = std::path::Path::new(&task.worktree_path).join("input");
            let output_dir = std::path::Path::new(&task.worktree_path).join("output");
            let scripts_dir = std::path::Path::new(&task.worktree_path).join("scripts");
            let has_files = [input_dir, output_dir, scripts_dir].iter().any(|dir| {
                fs::read_dir(dir)
                    .map(|mut it| it.next().is_some())
                    .unwrap_or(false)
            });

            if has_files {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ArchiveConfirmResponse::confirm_required(
                        task.name,
                        String::new(),
                        String::new(),
                        true,
                        true,
                        false,
                        false,
                    )),
                ));
            }
        }

        let archived = tasks::archive_task(&project_key, &task_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ArchiveConfirmResponse::error(
                        "ARCHIVE_FAILED",
                        "Archive failed",
                        task_id.clone(),
                    )),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                )
            })?;

        if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::GroupChanged);
        }

        return Ok(Json(storage_task_to_response(&archived)));
    }

    if !force {
        let task = match tasks::get_task(&project_key, &task_id).ok().flatten() {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(ArchiveConfirmResponse::error(
                        "TASK_NOT_FOUND",
                        "Task not found",
                        task_id.clone(),
                    )),
                ));
            }
        };

        let mut worktree_dirty = false;
        let mut dirty_check_failed = false;
        match git::has_uncommitted_changes(&task.worktree_path) {
            Ok(v) => worktree_dirty = v,
            Err(_) => {
                dirty_check_failed = true;
            }
        }

        let mut branch_merged = true;
        let mut merge_check_failed = false;
        match git::is_merged(&project.path, &task.branch, &task.target) {
            Ok(v) => {
                branch_merged = v
                    || git::is_diff_empty(&project.path, &task.branch, &task.target)
                        .unwrap_or(false);
            }
            Err(_) => {
                merge_check_failed = true;
            }
        }

        let needs_confirm =
            worktree_dirty || !branch_merged || dirty_check_failed || merge_check_failed;
        if needs_confirm {
            return Err((
                StatusCode::CONFLICT,
                Json(ArchiveConfirmResponse::confirm_required(
                    task.name,
                    task.branch,
                    task.target,
                    worktree_dirty,
                    branch_merged,
                    dirty_check_failed,
                    merge_check_failed,
                )),
            ));
        }
    }

    let task_info = tasks::get_task(&project_key, &task_id).ok().flatten();
    let task_mux_str = task_info
        .as_ref()
        .map(|t| t.multiplexer.clone())
        .unwrap_or_default();
    let task_sname = task_info
        .as_ref()
        .map(|t| t.session_name.clone())
        .unwrap_or_default();

    let _ = crate::operations::tasks::archive_task(
        &project.path,
        &project_key,
        &task_id,
        &task_mux_str,
        &task_sname,
    )
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ArchiveConfirmResponse::error(
                "ARCHIVE_FAILED",
                "Archive failed",
                task_id.clone(),
            )),
        )
    })?;

    if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    let archived = loader::load_archived_worktrees(&project.path);
    let task = archived.iter().find(|wt| wt.id == task_id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ArchiveConfirmResponse::error(
                "ARCHIVED_TASK_NOT_FOUND",
                "Archived task not found",
                task_id.clone(),
            )),
        )
    })?;

    Ok(Json(common::worktree_to_response(task)))
}

/// POST /api/v1/projects/{id}/tasks/{taskId}/recover
pub async fn recover_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Json<TaskResponse>, (StatusCode, Json<ApiError>)> {
    let (project, project_key) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let _result = crate::operations::tasks::recover_task(&project.path, &project_key, &task_id)
        .map_err(|e| {
            let status = match &e {
                crate::error::GroveError::NotFound(_) => StatusCode::NOT_FOUND,
                crate::error::GroveError::Git(_) => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (
                status,
                Json(ApiError {
                    error: e.to_string(),
                }),
            )
        })?;

    let project_path = project.path.clone();
    let tid = task_id.clone();
    let result: Option<TaskResponse> = tokio::task::spawn_blocking(move || {
        let active = loader::load_worktrees(&project_path);
        active
            .iter()
            .find(|wt| wt.id == tid)
            .map(common::worktree_to_response)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: e.to_string(),
            }),
        )
    })?;

    let _ = crate::storage::taskgroups::ensure_system_groups();
    {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    result.map(Json).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Failed to find recovered task".to_string(),
            }),
        )
    })
}

/// DELETE /api/v1/projects/{id}/tasks/{taskId}
pub async fn delete_task(
    Path((id, task_id)): Path<(String, String)>,
) -> Result<StatusCode, StatusCode> {
    if task_id == crate::storage::tasks::LOCAL_TASK_ID {
        return Err(StatusCode::BAD_REQUEST);
    }

    let (project, project_key) = common::find_project_by_id(&id)?;

    let task = tasks::get_task(&project_key, &task_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .or_else(|| {
            tasks::get_archived_task(&project_key, &task_id)
                .ok()
                .flatten()
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    if project.project_type == workspace::ProjectType::Studio {
        let task_path = std::path::Path::new(&task.worktree_path);
        let expected_prefix = workspace::studio_project_dir(&project.path).join("tasks");
        if task_path.exists() && task_path.starts_with(&expected_prefix) {
            fs::remove_dir_all(task_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }

        let _ = tasks::remove_task(&project_key, &task_id);
        let _ = tasks::remove_archived_task(&project_key, &task_id);
        hooks::remove_task_hook(&project_key, &task_id);
        let _ = storage::delete_task_data(&project_key, &task_id);
        crate::symbols::on_task_deleted(&project_key, &task_id);

        if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
            use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
            broadcast_radio_event(RadioEvent::GroupChanged);
        }

        return Ok(StatusCode::NO_CONTENT);
    }

    let task_session_type = session::resolve_session_type(&task.multiplexer);
    let session_name = session::resolve_session_name(&task.session_name, &project_key, &task_id);
    let _ = session::kill_session(&task_session_type, &session_name);
    if matches!(task_session_type, SessionType::Zellij) {
        crate::zellij::layout::remove_session_layout(&session_name);
    }

    let _ = git::remove_worktree(&project.path, &task.worktree_path);
    let _ = git::delete_branch(&project.path, &task.branch);

    let _ = tasks::remove_task(&project_key, &task_id);
    let _ = tasks::remove_archived_task(&project_key, &task_id);

    hooks::remove_task_hook(&project_key, &task_id);
    let _ = storage::delete_task_data(&project_key, &task_id);
    crate::symbols::on_task_deleted(&project_key, &task_id);

    if crate::storage::taskgroups::remove_task_from_all_groups(&project_key, &task_id) {
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);
    }

    Ok(StatusCode::NO_CONTENT)
}

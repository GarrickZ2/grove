//! Project CRUD handlers and helpers

use axum::{extract::Path, http::StatusCode, Json};
use chrono::Utc;
use std::fs;

use crate::api::error::ApiError;
use crate::git;
use crate::model::loader;
use crate::storage::{tasks, workspace};

use super::types::*;
use crate::api::handlers::common;

/// Convert a storage TaskStatus to the string the frontend expects.
pub fn storage_task_status_to_string(status: &tasks::TaskStatus) -> &'static str {
    match status {
        tasks::TaskStatus::Active => "idle",
        tasks::TaskStatus::Archived => "archived",
    }
}

/// Convert a storage Task to the TaskResponse DTO.
pub fn storage_task_to_response(task: &tasks::Task) -> TaskResponse {
    TaskResponse {
        id: task.id.clone(),
        name: task.name.clone(),
        branch: task.branch.clone(),
        target: task.target.clone(),
        status: storage_task_status_to_string(&task.status).to_string(),
        additions: task.code_additions,
        deletions: task.code_deletions,
        files_changed: task.files_changed,
        commits: Vec::new(),
        created_at: task.created_at.to_rfc3339(),
        updated_at: task.updated_at.to_rfc3339(),
        path: task.worktree_path.clone(),
        multiplexer: task.multiplexer.clone(),
        created_by: task.created_by.clone(),
        is_local: task.is_local,
    }
}

/// Count tasks for a project
fn count_project_tasks(project_key: &str) -> u32 {
    let active_tasks = tasks::load_tasks(project_key).unwrap_or_default();
    active_tasks.len() as u32
}

/// Resolve the studio project directory, returning error if not a Studio project
pub(crate) fn resolve_studio_dir(
    id: &str,
) -> Result<(workspace::RegisteredProject, std::path::PathBuf), (StatusCode, Json<ApiError>)> {
    let (project, _) = common::find_project_by_id(id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    if project.project_type != workspace::ProjectType::Studio {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "Not a Studio project".to_string(),
            }),
        ));
    }
    let dir = workspace::studio_project_dir(&project.path);
    Ok((project, dir))
}

/// List resource files in a directory (non-recursive, skipping symlinks)
pub(crate) fn list_resource_files(dir: &std::path::Path) -> Vec<ResourceFile> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return files,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let link_meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if link_meta.file_type().is_symlink() {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        files.push(ResourceFile {
            name: name.clone(),
            path: name,
            size: if meta.is_file() { meta.len() } else { 0 },
            modified_at: crate::api::handlers::studio_common::format_modified_time(&meta),
            is_dir: meta.is_dir(),
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

/// Validate that a symlink entry points inside the given directory
/// GET /api/v1/projects
pub async fn list_projects() -> Result<Json<ProjectListResponse>, StatusCode> {
    let cwd = std::env::current_dir().ok();

    let mut auto_registered = false;
    if let Some(ref cwd) = cwd {
        let cwd_str = cwd.to_string_lossy().to_string();
        if git::is_git_repo(&cwd_str) {
            if let Ok(git_root) = git::repo_root(&cwd_str) {
                let name = std::path::Path::new(&git_root)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());

                match workspace::add_project(&name, &git_root) {
                    Ok(_) => auto_registered = true,
                    Err(e) if e.to_string().contains("already registered") => {}
                    Err(_) => {}
                }
            }
        }
    }

    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let current_project_id = cwd.as_ref().and_then(|cwd| {
        projects.iter().find_map(|p| {
            let project_path = std::path::Path::new(&p.path);
            if cwd.starts_with(project_path) {
                Some(workspace::project_hash(&p.path))
            } else {
                None
            }
        })
    });

    if auto_registered {
        if let Some(ref id) = current_project_id {
            eprintln!("Auto-registered current directory as project: {}", id);
        }
    }

    let items: Vec<ProjectListItem> = projects
        .iter()
        .map(|p| {
            let id = workspace::project_hash(&p.path);
            let task_count = count_project_tasks(&id);
            let is_studio = p.project_type == workspace::ProjectType::Studio;
            let exists = if is_studio {
                workspace::studio_project_dir(&p.path).exists()
            } else {
                std::path::Path::new(&p.path).exists()
            };
            let is_git_repo = if is_studio {
                false
            } else {
                exists && git::is_git_usable(&p.path)
            };

            ProjectListItem {
                id,
                name: p.name.clone(),
                path: p.path.clone(),
                added_at: p.added_at.to_rfc3339(),
                task_count,
                live_count: 0,
                is_git_repo,
                exists,
                project_type: p.project_type.as_str().to_string(),
            }
        })
        .collect();

    Ok(Json(ProjectListResponse {
        projects: items,
        current_project_id,
    }))
}

/// GET /api/v1/projects/{id}
pub async fn get_project(Path(id): Path<String>) -> Result<Json<ProjectResponse>, StatusCode> {
    let (project, _) = common::find_project_by_id(&id)?;

    let project_name = project.name.clone();
    let project_path = project.path.clone();
    let added_at = project.added_at.to_rfc3339();
    let project_type = project.project_type.as_str().to_string();
    let is_studio = project.project_type == workspace::ProjectType::Studio;
    let exists = if is_studio {
        workspace::studio_project_dir(&project_path).exists()
    } else {
        std::path::Path::new(&project_path).exists()
    };
    if !exists {
        return Ok(Json(ProjectResponse {
            id,
            name: project_name,
            path: project.path,
            current_branch: String::new(),
            tasks: Vec::new(),
            local_task: None,
            added_at,
            is_git_repo: false,
            exists: false,
            project_type,
        }));
    }

    if is_studio {
        let project_key = id.clone();
        let (tasks_list, _) = tokio::task::spawn_blocking(move || {
            let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();
            let archived_tasks = tasks::load_archived_tasks(&project_key).unwrap_or_default();
            let mut all: Vec<TaskResponse> = active_tasks
                .iter()
                .chain(archived_tasks.iter())
                .map(storage_task_to_response)
                .collect();
            all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            (all, ())
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return Ok(Json(ProjectResponse {
            id,
            name: project_name,
            path: project.path,
            current_branch: String::new(),
            tasks: tasks_list,
            local_task: None,
            added_at,
            is_git_repo: false,
            exists: true,
            project_type,
        }));
    }

    let (all_tasks, local_task, current_branch, is_git_usable): (
        Vec<TaskResponse>,
        Option<TaskResponse>,
        String,
        bool,
    ) = tokio::task::spawn_blocking(move || {
        let is_git_usable = git::is_git_usable(&project_path);

        let (active, local) = loader::load_worktrees_and_local(&project_path);
        let archived = loader::load_archived_worktrees(&project_path);

        use rayon::prelude::*;
        let mut all_tasks: Vec<TaskResponse> = active
            .iter()
            .chain(archived.iter())
            .collect::<Vec<_>>()
            .par_iter()
            .map(|wt| common::worktree_to_response(wt))
            .collect();

        all_tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        let local_task = local.map(|wt| common::worktree_to_response(&wt));

        let current_branch = if is_git_usable {
            git::current_branch(&project_path).unwrap_or_else(|_| "unknown".to_string())
        } else {
            String::new()
        };

        (all_tasks, local_task, current_branch, is_git_usable)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ProjectResponse {
        id,
        name: project_name,
        path: project.path,
        current_branch,
        tasks: all_tasks,
        local_task,
        added_at,
        is_git_repo: is_git_usable,
        exists: true,
        project_type,
    }))
}

/// POST /api/v1/projects
pub async fn add_project(
    Json(req): Json<AddProjectRequest>,
) -> Result<Json<ProjectResponse>, (StatusCode, Json<ApiError>)> {
    let expanded_path = workspace::expand_tilde(&req.path);

    if !std::path::Path::new(&expanded_path).exists() {
        return Err(ApiError::bad_request(format!(
            "Path does not exist: {}",
            expanded_path
        )));
    }

    let is_git = git::is_git_repo(&expanded_path);
    let resolved_path = if is_git {
        let repo_root = git::repo_root(&expanded_path).map_err(|e| {
            ApiError::bad_request(format!("Failed to resolve Git repo root: {}", e))
        })?;
        git::get_main_repo_path(&repo_root).unwrap_or(repo_root)
    } else {
        std::path::Path::new(&expanded_path)
            .canonicalize()
            .map_err(|e| ApiError::bad_request(format!("Failed to resolve path: {}", e)))?
            .to_string_lossy()
            .to_string()
    };

    let name = req.name.unwrap_or_else(|| {
        std::path::Path::new(&resolved_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    workspace::add_project(&name, &resolved_path).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("already registered") {
            (
                StatusCode::CONFLICT,
                Json(ApiError {
                    error: format!("Project already registered: {}", resolved_path),
                }),
            )
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: msg }),
            )
        }
    })?;

    let id = workspace::project_hash(&resolved_path);
    let current_branch = if is_git {
        git::current_branch(&resolved_path).unwrap_or_else(|_| "unknown".to_string())
    } else {
        String::new()
    };

    Ok(Json(ProjectResponse {
        id,
        name,
        path: resolved_path,
        current_branch,
        tasks: Vec::new(),
        local_task: None,
        added_at: chrono::Utc::now().to_rfc3339(),
        is_git_repo: is_git,
        exists: true,
        project_type: "repo".to_string(),
    }))
}

/// POST /api/v1/projects/new
pub async fn create_new_project(
    Json(req): Json<NewProjectRequest>,
) -> Result<Json<ProjectResponse>, (StatusCode, Json<ApiError>)> {
    let name = req.name.trim().to_string();
    let is_studio = req.project_type.as_deref() == Some("studio");

    if name.is_empty() {
        return Err(ApiError::bad_request("Project name is required"));
    }

    if is_studio {
        let virtual_path = workspace::create_studio_project(&name).map_err(|e| {
            let msg = e.to_string();
            let status = if msg.contains("already exists") || msg.contains("already registered") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(ApiError { error: msg }))
        })?;

        let id = workspace::project_hash(&virtual_path);
        Ok(Json(ProjectResponse {
            id,
            name,
            path: virtual_path,
            current_branch: String::new(),
            tasks: Vec::new(),
            local_task: None,
            added_at: Utc::now().to_rfc3339(),
            is_git_repo: false,
            exists: true,
            project_type: "studio".to_string(),
        }))
    } else {
        let init_git = req.init_git;
        let resolved_path =
            crate::operations::projects::create_new_project(&req.parent_dir, &name, init_git)
                .map_err(|e| {
                    let msg = e.to_string();
                    let status =
                        if msg.contains("already exists") || msg.contains("already registered") {
                            StatusCode::CONFLICT
                        } else if msg.contains("does not exist")
                            || msg.contains("not a directory")
                            || msg.contains("Invalid project name")
                            || msg.contains("is required")
                        {
                            StatusCode::BAD_REQUEST
                        } else {
                            StatusCode::INTERNAL_SERVER_ERROR
                        };
                    (status, Json(ApiError { error: msg }))
                })?;

        let id = workspace::project_hash(&resolved_path);
        let current_branch = if init_git {
            git::current_branch(&resolved_path).unwrap_or_else(|_| "main".to_string())
        } else {
            String::new()
        };

        Ok(Json(ProjectResponse {
            id,
            name,
            path: resolved_path,
            current_branch,
            tasks: Vec::new(),
            local_task: None,
            added_at: Utc::now().to_rfc3339(),
            is_git_repo: init_git,
            exists: true,
            project_type: "repo".to_string(),
        }))
    }
}

/// DELETE /api/v1/projects/{id}
pub async fn delete_project(Path(id): Path<String>) -> Result<StatusCode, StatusCode> {
    let (project, _) = common::find_project_by_id(&id)?;

    workspace::remove_project(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    Ok(StatusCode::NO_CONTENT)
}

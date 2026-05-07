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
        initial_commit: task.initial_commit.clone(),
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

/// List resource files in a directory (non-recursive, skipping symlinks).
/// `dir`  — the directory to scan.
/// `base` — the root directory; paths in results are relative to this.
pub(crate) fn list_resource_files(
    dir: &std::path::Path,
    base: &std::path::Path,
) -> Vec<ResourceFile> {
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
        let rel_path = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        files.push(ResourceFile {
            name: name.clone(),
            path: rel_path,
            size: if meta.is_file() { meta.len() } else { 0 },
            modified_at: crate::api::handlers::studio_common::format_modified_time(&meta),
            is_dir: meta.is_dir(),
        });
    }
    files.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir); // dirs first
        }
        a.name.cmp(&b.name)
    });
    files
}

/// Validate that a symlink entry points inside the given directory
/// GET /api/v1/projects
#[cfg_attr(feature = "perf-monitor", tracing::instrument(skip_all))]
pub async fn list_projects() -> Result<Json<ProjectListResponse>, StatusCode> {
    let cwd = std::env::current_dir().ok();

    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("load_projects").entered();
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    #[cfg(feature = "perf-monitor")]
    drop(_s);

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

    use rayon::prelude::*;

    #[cfg(feature = "perf-monitor")]
    let total_count_ns = std::sync::atomic::AtomicU64::new(0);
    #[cfg(feature = "perf-monitor")]
    let total_exists_ns = std::sync::atomic::AtomicU64::new(0);
    #[cfg(feature = "perf-monitor")]
    let total_git_ns = std::sync::atomic::AtomicU64::new(0);

    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!(
        "enrich_projects",
        n_projects = projects.len(),
        count_ms = tracing::field::Empty,
        exists_ms = tracing::field::Empty,
        git_ms = tracing::field::Empty,
    )
    .entered();
    let items: Vec<ProjectListItem> = projects
        .par_iter()
        .map(|p| {
            let id = workspace::project_hash(&p.path);

            #[cfg(feature = "perf-monitor")]
            let _t = std::time::Instant::now();
            let task_count = count_project_tasks(&id);
            #[cfg(feature = "perf-monitor")]
            total_count_ns.fetch_add(
                _t.elapsed().as_nanos() as u64,
                std::sync::atomic::Ordering::Relaxed,
            );

            let is_studio = p.project_type == workspace::ProjectType::Studio;

            #[cfg(feature = "perf-monitor")]
            let _t = std::time::Instant::now();
            let exists = if is_studio {
                workspace::studio_project_dir(&p.path).exists()
            } else {
                std::path::Path::new(&p.path).exists()
            };
            #[cfg(feature = "perf-monitor")]
            total_exists_ns.fetch_add(
                _t.elapsed().as_nanos() as u64,
                std::sync::atomic::Ordering::Relaxed,
            );

            #[cfg(feature = "perf-monitor")]
            let _t = std::time::Instant::now();
            let is_git_repo = if is_studio {
                false
            } else {
                exists && git::is_git_usable(&p.path)
            };
            #[cfg(feature = "perf-monitor")]
            total_git_ns.fetch_add(
                _t.elapsed().as_nanos() as u64,
                std::sync::atomic::Ordering::Relaxed,
            );

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
    #[cfg(feature = "perf-monitor")]
    {
        let span = tracing::Span::current();
        span.record(
            "count_ms",
            total_count_ns.load(std::sync::atomic::Ordering::Relaxed) / 1_000_000,
        );
        span.record(
            "exists_ms",
            total_exists_ns.load(std::sync::atomic::Ordering::Relaxed) / 1_000_000,
        );
        span.record(
            "git_ms",
            total_git_ns.load(std::sync::atomic::Ordering::Relaxed) / 1_000_000,
        );
    }
    #[cfg(feature = "perf-monitor")]
    drop(_s);

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

    // Load all tasks directly from DB — no git subprocess calls.
    // Status detection (live/idle/merged/conflict) is TUI-only; web only needs
    // archived vs active, which is stored in the DB.
    let (all_tasks, local_task, current_branch, is_git_repo): (
        Vec<TaskResponse>,
        Option<TaskResponse>,
        String,
        bool,
    ) = tokio::task::spawn_blocking(move || {
        let project_key = workspace::project_hash(&project_path);

        // gix-based check — no git subprocess. Requires HEAD to resolve, so freshly
        // `git init`'d repos with no commits report false (frontend gates git UI on this).
        let is_git_repo = git::is_git_usable(&project_path);

        let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();
        let archived_tasks = tasks::load_archived_tasks(&project_key).unwrap_or_default();

        // Split local task out; it is not included in the main task list.
        let local_task_db = active_tasks.iter().find(|t| t.is_local).cloned();

        // current_branch from DB (stored by TUI sync); empty string for non-git projects.
        let current_branch = local_task_db
            .as_ref()
            .map(|t| t.branch.clone())
            .unwrap_or_default();

        let mut all_tasks: Vec<TaskResponse> = active_tasks
            .iter()
            .filter(|t| !t.is_local)
            .chain(archived_tasks.iter())
            .map(storage_task_to_response)
            .collect();
        all_tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        let local_task = local_task_db.as_ref().map(storage_task_to_response);

        (all_tasks, local_task, current_branch, is_git_repo)
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
        is_git_repo,
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

    // Local Task 已在 add_project_with_type 中创建,此处读取以填充响应。
    let local_task = loader::load_local_task(&resolved_path).map(|wt| TaskResponse {
        id: wt.id,
        name: wt.task_name,
        branch: wt.branch,
        target: wt.target,
        status: "idle".to_string(),
        additions: 0,
        deletions: 0,
        files_changed: 0,
        initial_commit: None,
        commits: Vec::new(),
        created_at: wt.created_at.to_rfc3339(),
        updated_at: wt.updated_at.to_rfc3339(),
        path: wt.path,
        multiplexer: wt.multiplexer,
        created_by: wt.created_by,
        is_local: true,
    });

    let _ = crate::storage::taskgroups::ensure_system_groups();
    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    Ok(Json(ProjectResponse {
        id,
        name,
        path: resolved_path,
        current_branch,
        tasks: Vec::new(),
        local_task,
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

        let local_task = loader::load_local_task(&resolved_path).map(|wt| TaskResponse {
            id: wt.id,
            name: wt.task_name,
            branch: wt.branch,
            target: wt.target,
            status: "idle".to_string(),
            additions: 0,
            deletions: 0,
            files_changed: 0,
            initial_commit: None,
            commits: Vec::new(),
            created_at: wt.created_at.to_rfc3339(),
            updated_at: wt.updated_at.to_rfc3339(),
            path: wt.path,
            multiplexer: wt.multiplexer,
            created_by: wt.created_by,
            is_local: true,
        });
        let _ = crate::storage::taskgroups::ensure_system_groups();
        use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
        broadcast_radio_event(RadioEvent::GroupChanged);

        Ok(Json(ProjectResponse {
            id,
            name,
            path: resolved_path,
            current_branch,
            tasks: Vec::new(),
            local_task,
            added_at: Utc::now().to_rfc3339(),
            is_git_repo: init_git,
            exists: true,
            project_type: "repo".to_string(),
        }))
    }
}

/// DELETE /api/v1/projects/{id}
pub async fn rename_project(
    Path(id): Path<String>,
    Json(req): Json<RenameProjectRequest>,
) -> Result<Json<ProjectResponse>, (StatusCode, Json<ApiError>)> {
    let trimmed = req.name.trim().to_string();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request(
            "Project name cannot be empty".to_string(),
        ));
    }

    let (project, _) = common::find_project_by_id(&id).map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Project not found".to_string(),
            }),
        )
    })?;

    let hash = workspace::project_hash(&project.path);
    workspace::rename_project(&hash, &trimmed).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: e.to_string(),
            }),
        )
    })?;

    get_project(Path(id)).await.map_err(|s| {
        (
            s,
            Json(ApiError {
                error: "Failed to load updated project".to_string(),
            }),
        )
    })
}

pub async fn delete_project(Path(id): Path<String>) -> Result<StatusCode, StatusCode> {
    let (project, _) = common::find_project_by_id(&id)?;

    workspace::remove_project(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    Ok(StatusCode::NO_CONTENT)
}

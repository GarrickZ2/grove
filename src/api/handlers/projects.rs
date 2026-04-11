//! Project API handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::git;
use crate::git::git_cmd;
use crate::model::loader;
use crate::storage::{tasks, workspace};
use crate::watcher;

use super::studio_common::{
    self, AddWorkDirectoryRequest, WorkDirectoryEntry, WorkDirectoryListResponse,
    WorkDirectoryQuery,
};

// ============================================================================
// Request/Response DTOs
// ============================================================================

/// Project list item (for GET /projects)
#[derive(Debug, Serialize)]
pub struct ProjectListItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub added_at: String,
    pub task_count: u32,
    pub live_count: u32,
    pub is_git_repo: bool,
    /// Whether the filesystem path still exists. When false, the project is
    /// considered "missing" — UI should show a warning state and only allow
    /// Delete (to clean up stale metadata).
    pub exists: bool,
    /// Project type: "repo" or "studio"
    pub project_type: String,
}

/// Project list response
#[derive(Debug, Serialize)]
pub struct ProjectListResponse {
    pub projects: Vec<ProjectListItem>,
    /// ID of the project matching the current working directory (if any)
    pub current_project_id: Option<String>,
}

/// Task response (matches frontend Task type)
#[derive(Debug, Serialize)]
pub struct TaskResponse {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub target: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub files_changed: u32,
    pub commits: Vec<CommitResponse>,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
    pub multiplexer: String,
    pub created_by: String,
    pub is_local: bool,
}

/// Commit response
#[derive(Debug, Serialize)]
pub struct CommitResponse {
    pub hash: String,
    pub message: String,
    pub time_ago: String,
}

/// Full project response (for GET /projects/{id})
#[derive(Debug, Serialize)]
pub struct ProjectResponse {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current_branch: String,
    /// Worktree tasks only. Local Task is returned via `local_task`.
    pub tasks: Vec<TaskResponse>,
    /// The project's Local Task (每个 project 永远有且只有一个),with real session state.
    /// Frontend can synthesize one locally as a fallback, but this field has accurate status.
    pub local_task: Option<TaskResponse>,
    pub added_at: String,
    pub is_git_repo: bool,
    /// Whether the filesystem path still exists. When false, the project is
    /// considered "missing"; `tasks` / `local_task` / `current_branch` are
    /// forced to empty defaults and no git I/O is attempted.
    pub exists: bool,
    /// Project type: "repo" or "studio"
    pub project_type: String,
}

/// Add project request
#[derive(Debug, Deserialize)]
pub struct AddProjectRequest {
    pub path: String,
    pub name: Option<String>,
}

/// Create new project request
#[derive(Debug, Deserialize)]
pub struct NewProjectRequest {
    /// 父目录(必须存在且为目录) — ignored for studio projects
    #[serde(default)]
    pub parent_dir: String,
    /// 项目名(同时作为目录名和 Grove 项目名)
    pub name: String,
    /// 是否初始化为 git 仓库 — ignored for studio projects
    #[serde(default)]
    pub init_git: bool,
    /// Project type: "repo" (default) or "studio"
    #[serde(default)]
    pub project_type: Option<String>,
}

/// Simple API error body
#[derive(Debug, Serialize)]
pub struct ProjectError {
    pub error: String,
}

/// Project stats response
#[derive(Debug, Serialize)]
pub struct ProjectStatsResponse {
    pub total_tasks: u32,
    pub live_tasks: u32,
    pub idle_tasks: u32,
    pub merged_tasks: u32,
    pub archived_tasks: u32,
    /// Weekly activity (last 7 days, index 0 = today)
    pub weekly_activity: Vec<u32>,
}

/// Branch info response
#[derive(Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// Branches list response
#[derive(Debug, Serialize)]
pub struct BranchesResponse {
    pub branches: Vec<BranchInfo>,
    pub current: String,
}

// ============================================================================
// Helper functions
// ============================================================================

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

/// Convert WorktreeStatus to string
fn status_to_string(status: &crate::model::WorktreeStatus) -> &'static str {
    match status {
        crate::model::WorktreeStatus::Live => "live",
        crate::model::WorktreeStatus::Idle => "idle",
        crate::model::WorktreeStatus::Merged => "merged",
        crate::model::WorktreeStatus::Conflict => "conflict",
        crate::model::WorktreeStatus::Broken => "broken",
        crate::model::WorktreeStatus::Error => "broken",
        crate::model::WorktreeStatus::Archived => "archived",
    }
}

/// Convert Worktree to TaskResponse
fn worktree_to_response(wt: &crate::model::Worktree, _project_key: &str) -> TaskResponse {
    // Get commits
    let commits = git::recent_log(&wt.path, &wt.target, 10)
        .unwrap_or_default()
        .into_iter()
        .map(|log| CommitResponse {
            hash: String::new(), // log doesn't include hash, we can add it later if needed
            message: log.message,
            time_ago: log.time_ago,
        })
        .collect();

    TaskResponse {
        id: wt.id.clone(),
        name: wt.task_name.clone(),
        branch: wt.branch.clone(),
        target: wt.target.clone(),
        status: status_to_string(&wt.status).to_string(),
        additions: 0,
        deletions: 0,
        files_changed: 0,
        commits,
        created_at: wt.created_at.to_rfc3339(),
        updated_at: wt.updated_at.to_rfc3339(),
        path: wt.path.clone(),
        multiplexer: wt.multiplexer.clone(),
        created_by: wt.created_by.clone(),
        is_local: wt.is_local,
    }
}

/// Find project by ID (hash)
fn find_project_by_id(id: &str) -> Result<workspace::RegisteredProject, StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Count tasks for a project
fn count_project_tasks(project_key: &str) -> u32 {
    let active_tasks = tasks::load_tasks(project_key).unwrap_or_default();
    active_tasks.len() as u32
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/v1/projects
/// List all registered projects
pub async fn list_projects() -> Result<Json<ProjectListResponse>, StatusCode> {
    // Get current working directory
    let cwd = std::env::current_dir().ok();

    // Check if we need to auto-register current directory
    let mut auto_registered = false;
    if let Some(ref cwd) = cwd {
        let cwd_str = cwd.to_string_lossy().to_string();
        if git::is_git_repo(&cwd_str) {
            if let Ok(git_root) = git::repo_root(&cwd_str) {
                // Auto-register this project (add_project handles worktree internally)
                let name = std::path::Path::new(&git_root)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());

                // Try to add, ignore "already registered" error
                match workspace::add_project(&name, &git_root) {
                    Ok(_) => auto_registered = true,
                    Err(e) if e.to_string().contains("already registered") => {}
                    Err(_) => {}
                }
            }
        }
    }

    // Reload projects (in case we auto-registered one)
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Find project matching current directory
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

    // Log auto-registration
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
            // Studio projects use virtual path — check studio dir instead
            let exists = if is_studio {
                workspace::studio_project_dir(&p.path).exists()
            } else {
                std::path::Path::new(&p.path).exists()
            };
            // Live check: HEAD 可用才算 git repo(与 TUI 侧一致,避免半 init 状态分叉)
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
/// Get a single project with its tasks
pub async fn get_project(Path(id): Path<String>) -> Result<Json<ProjectResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;

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
    let id_clone = id.clone();

    // Missing project: skip all git I/O and return clean defaults. The frontend
    // will show a dedicated "Project Missing" state with a Delete-only path.
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

    // Studio projects: no git I/O needed, return tasks from storage directly
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

    // Heavy git I/O — run on blocking thread pool so other projects aren't starved
    let (all_tasks, local_task, current_branch, is_git_usable) =
        tokio::task::spawn_blocking(move || {
            // Live check: `.git/` 存在且 HEAD 已创建才算可用
            let is_git_usable = git::is_git_usable(&project_path);

            // Worktree tasks + Local Task 一次性加载,避免重复 git I/O
            let (active, local) = loader::load_worktrees_and_local(&project_path);
            let archived = loader::load_archived_worktrees(&project_path);

            use rayon::prelude::*;
            let mut all_tasks: Vec<TaskResponse> = active
                .iter()
                .chain(archived.iter())
                .collect::<Vec<_>>()
                .par_iter()
                .map(|wt| worktree_to_response(wt, &id_clone))
                .collect();

            all_tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

            let local_task = local.map(|wt| worktree_to_response(&wt, &id_clone));

            // 非 git 项目没有分支,返回空串
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
/// Add a new project (supports both git and non-git directories)
pub async fn add_project(
    Json(req): Json<AddProjectRequest>,
) -> Result<Json<ProjectResponse>, (StatusCode, Json<ProjectError>)> {
    let bad_request = |msg: &str| {
        (
            StatusCode::BAD_REQUEST,
            Json(ProjectError {
                error: msg.to_string(),
            }),
        )
    };

    // Expand ~/... (frontend placeholder text suggests users may type it)
    let expanded_path = workspace::expand_tilde(&req.path);

    // Validate path exists
    if !std::path::Path::new(&expanded_path).exists() {
        return Err(bad_request(&format!(
            "Path does not exist: {}",
            expanded_path
        )));
    }

    // Resolve the effective project path
    let is_git = git::is_git_repo(&expanded_path);
    let resolved_path = if is_git {
        // Git 项目: 解析到 repo root (处理 worktree)
        let repo_root = git::repo_root(&expanded_path)
            .map_err(|e| bad_request(&format!("Failed to resolve Git repo root: {}", e)))?;
        git::get_main_repo_path(&repo_root).unwrap_or(repo_root)
    } else {
        // 非 git 项目: 规范化绝对路径
        std::path::Path::new(&expanded_path)
            .canonicalize()
            .map_err(|e| bad_request(&format!("Failed to resolve path: {}", e)))?
            .to_string_lossy()
            .to_string()
    };

    // Determine name
    let name = req.name.unwrap_or_else(|| {
        std::path::Path::new(&resolved_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    // Add project (internally handles worktree + is_git_repo 字段)
    workspace::add_project(&name, &resolved_path).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("already registered") {
            (
                StatusCode::CONFLICT,
                Json(ProjectError {
                    error: format!("Project already registered: {}", resolved_path),
                }),
            )
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ProjectError { error: msg }),
            )
        }
    })?;

    // Return the new project
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
/// Create a brand new project: mkdir + (optional) git init + register.
/// Name is used as both the directory name and the Grove project name.
/// On failure at any step, no cleanup is performed — the caller receives a
/// clear error describing which step failed.
pub async fn create_new_project(
    Json(req): Json<NewProjectRequest>,
) -> Result<Json<ProjectResponse>, (StatusCode, Json<ProjectError>)> {
    let name = req.name.trim().to_string();
    let is_studio = req.project_type.as_deref() == Some("studio");

    let bad_request = |msg: &str| {
        (
            StatusCode::BAD_REQUEST,
            Json(ProjectError {
                error: msg.to_string(),
            }),
        )
    };

    if name.is_empty() {
        return Err(bad_request("Project name is required"));
    }

    if is_studio {
        // Studio: create directory under ~/.grove/studios/, no filesystem path needed
        let virtual_path = workspace::create_studio_project(&name).map_err(|e| {
            let msg = e.to_string();
            let status = if msg.contains("already registered") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(ProjectError { error: msg }))
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
        // Repo: delegate to shared operation (TUI + API)
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
                    (status, Json(ProjectError { error: msg }))
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
/// Delete a project (removes metadata only, not actual git repo)
pub async fn delete_project(Path(id): Path<String>) -> Result<StatusCode, StatusCode> {
    let project = find_project_by_id(&id)?;

    workspace::remove_project(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Notify Radio/Blitz clients that group slots may have changed
    use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
    broadcast_radio_event(RadioEvent::GroupChanged);

    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Studio Resource API
// ============================================================================

#[derive(Debug, Serialize)]
pub struct ResourceFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct ResourceListResponse {
    pub files: Vec<ResourceFile>,
}

#[derive(Debug, Serialize)]
pub struct InstructionsResponse {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct InstructionsUpdateRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ResourceDeleteQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct ResourceFileQuery {
    pub path: String,
}

/// Resolve the studio project directory, returning error if not a Studio project
fn resolve_studio_dir(
    id: &str,
) -> Result<(workspace::RegisteredProject, std::path::PathBuf), (StatusCode, Json<ProjectError>)> {
    let project = find_project_by_id(id).map_err(|s| {
        (
            s,
            Json(ProjectError {
                error: "Project not found".to_string(),
            }),
        )
    })?;
    if project.project_type != workspace::ProjectType::Studio {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ProjectError {
                error: "Not a Studio project".to_string(),
            }),
        ));
    }
    let dir = workspace::studio_project_dir(&project.path);
    Ok((project, dir))
}

fn list_resource_files(dir: &std::path::Path) -> Vec<ResourceFile> {
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
            modified_at: studio_common::format_modified_time(&meta),
            is_dir: meta.is_dir(),
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

fn ensure_link_points_inside(dir: &std::path::Path, name: &str) -> Result<PathBuf, ProjectError> {
    studio_common::validate_symlink_entry(dir, name).map_err(|err| ProjectError { error: err })
}

/// GET /api/v1/projects/{id}/resource
pub async fn list_resources(
    Path(id): Path<String>,
) -> Result<Json<ResourceListResponse>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let files = list_resource_files(&resource_dir);
    Ok(Json(ResourceListResponse { files }))
}

/// GET /api/v1/projects/{id}/resource/workdir
pub async fn list_resource_workdirs(
    Path(id): Path<String>,
) -> Result<Json<WorkDirectoryListResponse>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let entries = studio_common::list_workdir_entries(&workdir_dir);
    Ok(Json(WorkDirectoryListResponse { entries }))
}

/// POST /api/v1/projects/{id}/resource/workdir
pub async fn add_resource_workdir(
    Path(id): Path<String>,
    Json(request): Json<AddWorkDirectoryRequest>,
) -> Result<Json<WorkDirectoryEntry>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    fs::create_dir_all(&workdir_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to create resource directory: {e}"),
            }),
        )
    })?;

    let target = PathBuf::from(request.path.trim());
    if !target.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ProjectError {
                error: "Path must be absolute".to_string(),
            }),
        ));
    }
    if !target.exists() || !target.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ProjectError {
                error: "Selected path must be an existing directory".to_string(),
            }),
        ));
    }

    let link_name = studio_common::create_unique_symlink_name(&workdir_dir, &target);
    let link_path = workdir_dir.join(&link_name);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to create symlink: {e}"),
            }),
        )
    })?;

    #[cfg(not(unix))]
    {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(ProjectError {
                error: "Work Directory is currently only supported on Unix-like systems"
                    .to_string(),
            }),
        ));
    }

    Ok(Json(WorkDirectoryEntry {
        name: link_name,
        target_path: target.to_string_lossy().to_string(),
        exists: true,
    }))
}

/// DELETE /api/v1/projects/{id}/resource/workdir
pub async fn delete_resource_workdir(
    Path(id): Path<String>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let link_path = ensure_link_points_inside(&workdir_dir, &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;

    fs::remove_file(link_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to remove symlink: {e}"),
            }),
        )
    })?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/resource/workdir/open
pub async fn open_resource_workdir(
    Path(id): Path<String>,
    Query(query): Query<WorkDirectoryQuery>,
) -> Result<StatusCode, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let workdir_dir = studio_dir.join("resource");
    let link_path = ensure_link_points_inside(&workdir_dir, &query.name)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(err)))?;

    // Open the symlink path directly — the OS will follow the link.
    // This avoids a TOCTOU race that would occur if we read_link() and then
    // passed the raw target string to `open`.
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&link_path).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(&link_path).spawn();

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/{id}/resource/upload
pub async fn upload_resource(
    Path(id): Path<String>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<Vec<ResourceFile>>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    std::fs::create_dir_all(&resource_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to create resource directory: {}", e),
            }),
        )
    })?;

    let max_upload_size = studio_common::MAX_UPLOAD_SIZE;

    let mut uploaded = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field.file_name().unwrap_or("upload").to_string();
        let safe_name = filename.replace(['/', '\\'], "_");
        if safe_name.is_empty() || safe_name.starts_with('.') {
            continue;
        }
        let data = field.bytes().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ProjectError {
                    error: format!("Failed to read upload: {}", e),
                }),
            )
        })?;
        if data.len() > max_upload_size {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ProjectError {
                    error: format!(
                        "File '{}' too large ({} bytes, max 100 MB)",
                        safe_name,
                        data.len()
                    ),
                }),
            ));
        }
        let file_path = resource_dir.join(&safe_name);
        std::fs::write(&file_path, &data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ProjectError {
                    error: format!("Failed to write file: {}", e),
                }),
            )
        })?;
        let meta = std::fs::metadata(&file_path).ok();
        uploaded.push(ResourceFile {
            name: safe_name.clone(),
            path: safe_name,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(data.len() as u64),
            modified_at: chrono::Utc::now().to_rfc3339(),
            is_dir: false,
        });
    }
    Ok(Json(uploaded))
}

/// DELETE /api/v1/projects/{id}/resource
pub async fn delete_resource(
    Path(id): Path<String>,
    Query(query): Query<ResourceDeleteQuery>,
) -> Result<StatusCode, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let file_path = resource_dir.join(&query.path);

    // Security check
    let canonical_base = resource_dir.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProjectError {
                error: "Resource directory not found".to_string(),
            }),
        )
    })?;
    let canonical_file = file_path.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProjectError {
                error: "File not found".to_string(),
            }),
        )
    })?;
    if !canonical_file.starts_with(&canonical_base) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ProjectError {
                error: "Access denied".to_string(),
            }),
        ));
    }

    if canonical_file.is_dir() {
        std::fs::remove_dir_all(&canonical_file)
    } else {
        std::fs::remove_file(&canonical_file)
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to delete: {}", e),
            }),
        )
    })?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/projects/{id}/resource/preview
pub async fn preview_resource(
    Path(id): Path<String>,
    Query(query): Query<ResourceFileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let canonical_file = resolve_resource_file(&resource_dir, &query.path)?;

    const MAX_PREVIEW_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
    let file_size = std::fs::metadata(&canonical_file)
        .map(|m| m.len())
        .unwrap_or(0);
    if file_size > MAX_PREVIEW_SIZE {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ProjectError {
                error: format!("File too large to preview ({} bytes, max 10 MB)", file_size),
            }),
        ));
    }

    let content = std::fs::read(&canonical_file).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProjectError {
                error: "Failed to read file".to_string(),
            }),
        )
    })?;

    let text = studio_common::decode_text_bytes(&content);

    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        text,
    ))
}

/// GET /api/v1/projects/{id}/resource/download
pub async fn download_resource(
    Path(id): Path<String>,
    Query(query): Query<ResourceFileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let resource_dir = studio_dir.join("resource");
    let canonical_file = resolve_resource_file(&resource_dir, &query.path)?;

    let content = std::fs::read(&canonical_file).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProjectError {
                error: "Failed to read file".to_string(),
            }),
        )
    })?;
    let filename = studio_common::sanitize_filename_for_header(
        &canonical_file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string()),
    );
    let content_type =
        studio_common::guess_content_type(canonical_file.extension().and_then(|e| e.to_str()));

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, content_type.to_string()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", filename),
            ),
        ],
        content,
    ))
}

fn resolve_resource_file(
    resource_dir: &::std::path::Path,
    relative_path: &str,
) -> Result<PathBuf, (StatusCode, Json<ProjectError>)> {
    let file_path = resource_dir.join(relative_path);
    let canonical_base = resource_dir.canonicalize().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Resource directory not accessible: {e}"),
            }),
        )
    })?;
    let canonical_file = file_path.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProjectError {
                error: "File not found".to_string(),
            }),
        )
    })?;
    if !canonical_file.starts_with(&canonical_base) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ProjectError {
                error: "Access denied".to_string(),
            }),
        ));
    }
    Ok(canonical_file)
}

/// GET /api/v1/projects/{id}/instructions
pub async fn get_instructions(
    Path(id): Path<String>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("instructions.md");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ProjectError {
                    error: format!("Failed to read instructions: {}", e),
                }),
            ))
        }
    };
    Ok(Json(InstructionsResponse { content }))
}

/// PUT /api/v1/projects/{id}/instructions
pub async fn update_instructions(
    Path(id): Path<String>,
    Json(body): Json<InstructionsUpdateRequest>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("instructions.md");
    std::fs::write(&path, &body.content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to write instructions: {}", e),
            }),
        )
    })?;
    Ok(Json(InstructionsResponse {
        content: body.content,
    }))
}

/// GET /api/v1/projects/{id}/memory
pub async fn get_memory(
    Path(id): Path<String>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("memory.md");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ProjectError {
                    error: format!("Failed to read memory: {}", e),
                }),
            ))
        }
    };
    Ok(Json(InstructionsResponse { content }))
}

/// PUT /api/v1/projects/{id}/memory
pub async fn update_memory(
    Path(id): Path<String>,
    Json(body): Json<InstructionsUpdateRequest>,
) -> Result<Json<InstructionsResponse>, (StatusCode, Json<ProjectError>)> {
    let (_project, studio_dir) = resolve_studio_dir(&id)?;
    let path = studio_dir.join("memory.md");
    std::fs::write(&path, &body.content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProjectError {
                error: format!("Failed to write memory: {}", e),
            }),
        )
    })?;
    Ok(Json(InstructionsResponse {
        content: body.content,
    }))
}

/// GET /api/v1/projects/{id}/stats
/// Get project statistics
pub async fn get_stats(Path(id): Path<String>) -> Result<Json<ProjectStatsResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;
    let project_key = workspace::project_hash(&project.path);

    // Missing project: skip git I/O entirely (mirrors get_project)
    if !std::path::Path::new(&project.path).exists() {
        return Ok(Json(ProjectStatsResponse {
            total_tasks: 0,
            live_tasks: 0,
            idle_tasks: 0,
            merged_tasks: 0,
            archived_tasks: 0,
            weekly_activity: vec![0; 7],
        }));
    }

    // Load all worktrees on blocking thread pool
    let project_path = project.path.clone();
    let (active, archived) = tokio::task::spawn_blocking(move || {
        let active = loader::load_worktrees(&project_path);
        let archived = loader::load_archived_worktrees(&project_path);
        (active, archived)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut live_tasks = 0u32;
    let mut idle_tasks = 0u32;
    let mut merged_tasks = 0u32;

    for wt in active.iter() {
        match wt.status {
            crate::model::WorktreeStatus::Live => live_tasks += 1,
            crate::model::WorktreeStatus::Idle => idle_tasks += 1,
            crate::model::WorktreeStatus::Merged => merged_tasks += 1,
            _ => idle_tasks += 1, // Count conflict/broken as idle for stats
        }
    }

    let total_tasks = active.len() as u32;
    let archived_tasks = archived.len() as u32;

    // Calculate weekly activity from all tasks' edit history
    let now = Utc::now();
    let mut weekly: [u32; 7] = [0; 7];
    let active_tasks = tasks::load_tasks(&project_key).unwrap_or_default();

    for task in &active_tasks {
        if let Ok(events) = watcher::load_edit_history(&project_key, &task.id) {
            for event in events {
                let duration = now.signed_duration_since(event.timestamp);
                let days_ago = duration.num_days();
                if (0..7).contains(&days_ago) {
                    weekly[days_ago as usize] += 1;
                }
            }
        }
    }

    Ok(Json(ProjectStatsResponse {
        total_tasks,
        live_tasks,
        idle_tasks,
        merged_tasks,
        archived_tasks,
        weekly_activity: weekly.to_vec(),
    }))
}

/// Query parameters for branch listing
#[derive(Debug, Deserialize)]
pub struct BranchQueryParams {
    /// Remote name: "local" (default), "origin", "upstream", etc.
    #[serde(default = "default_remote")]
    pub remote: String,
}

fn default_remote() -> String {
    "local".to_string()
}

/// GET /api/v1/projects/{id}/branches?remote=local|origin|upstream|...
/// Get list of branches for a project
pub async fn get_branches(
    Path(id): Path<String>,
    Query(params): Query<BranchQueryParams>,
) -> Result<Json<BranchesResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;

    // Get current branch
    let current = git::current_branch(&project.path).unwrap_or_else(|_| "unknown".to_string());

    // Get Grove-managed branches from tasks (to filter them out)
    let project_key = workspace::project_hash(&project.path);
    let mut grove_branches = HashSet::new();

    // Collect branches from active tasks
    if let Ok(active_tasks) = tasks::load_tasks(&project_key) {
        for task in active_tasks {
            grove_branches.insert(task.branch);
        }
    }

    // Collect branches from archived tasks
    if let Ok(archived_tasks) = tasks::load_archived_tasks(&project_key) {
        for task in archived_tasks {
            grove_branches.insert(task.branch);
        }
    }

    // Fetch branches based on remote parameter
    let branch_names = if params.remote == "local" {
        // Local branches only
        git::list_branches(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    } else {
        // Remote branches
        let remote_output = git_cmd(
            &project.path,
            &[
                "branch",
                "-r",
                "--format=%(refname:short)",
                "--list",
                &format!("{}/*", params.remote),
            ],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        remote_output
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && !s.contains("HEAD"))
            .collect()
    };

    let branches: Vec<BranchInfo> = branch_names
        .into_iter()
        .filter(|name| {
            // Only filter out Grove branches for local branches
            if params.remote == "local" {
                !grove_branches.contains(name)
            } else {
                true
            }
        })
        .map(|name| {
            let is_current = name == current;
            BranchInfo { name, is_current }
        })
        .collect();

    Ok(Json(BranchesResponse { branches, current }))
}

/// Open command response
#[derive(Debug, Serialize)]
pub struct OpenResponse {
    pub success: bool,
    pub message: String,
}

/// POST /api/v1/projects/{id}/init-git
/// Initialize a git repository in a non-git project directory.
///
/// Delegates to `operations::projects::init_git_repo` for the actual work
/// (shared with TUI).
pub async fn init_git(Path(id): Path<String>) -> Result<Json<ProjectResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;
    let project_path = project.path.clone();

    let init_result = tokio::task::spawn_blocking(move || {
        crate::operations::projects::init_git_repo(&project_path)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Err(e) = init_result {
        eprintln!("init_git failed for {}: {}", project.path, e);
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    // 返回完整的 project 数据(复用 get_project)
    get_project(Path(id)).await
}

/// POST /api/v1/projects/{id}/open-ide
/// Open project in IDE
pub async fn open_ide(Path(id): Path<String>) -> Result<Json<OpenResponse>, StatusCode> {
    use crate::storage::config;
    use std::process::Command;

    let project = find_project_by_id(&id)?;
    let config = config::load_config();

    // Get IDE command from config, default to "code" (VS Code)
    let ide_cmd = config.web.ide.unwrap_or_else(|| "code".to_string());

    // Check if it's an app path (.app) or a command
    let result = if ide_cmd.ends_with(".app") {
        // It's an application path, use 'open -a' with the app bundle
        Command::new("open")
            .args(["-a", &ide_cmd, &project.path])
            .spawn()
    } else {
        // It's a command (like "code", "cursor", etc.)
        Command::new(&ide_cmd).arg(&project.path).spawn()
    };

    let display_name = if ide_cmd.ends_with(".app") {
        std::path::Path::new(&ide_cmd)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&ide_cmd)
            .to_string()
    } else {
        ide_cmd.clone()
    };

    match result {
        Ok(_) => Ok(Json(OpenResponse {
            success: true,
            message: format!("Opening {} in {}", project.name, display_name),
        })),
        Err(e) => Ok(Json(OpenResponse {
            success: false,
            message: format!("Failed to open IDE '{}': {}", display_name, e),
        })),
    }
}

/// POST /api/v1/projects/{id}/open-terminal
/// Open project in terminal
pub async fn open_terminal(Path(id): Path<String>) -> Result<Json<OpenResponse>, StatusCode> {
    use crate::storage::config;
    use std::process::Command;

    let project = find_project_by_id(&id)?;
    let config = config::load_config();

    // Get terminal command from config
    let terminal_cmd = config.web.terminal.as_deref();

    let (result, display_name) = match terminal_cmd {
        // Handle .app paths first
        Some(cmd) if cmd.ends_with(".app") => {
            let app_name = std::path::Path::new(cmd)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(cmd);

            // Special handling for iTerm
            if app_name.to_lowercase().contains("iterm") {
                (
                    Command::new("osascript")
                        .args([
                            "-e",
                            &format!(
                                r#"tell application "iTerm"
                                    activate
                                    create window with default profile
                                    tell current session of current window
                                        write text "cd '{}'"
                                    end tell
                                end tell"#,
                                project.path
                            ),
                        ])
                        .spawn(),
                    app_name.to_string(),
                )
            } else {
                // Generic .app handling via 'open -a'
                (
                    Command::new("open")
                        .args(["-a", cmd, &project.path])
                        .spawn(),
                    app_name.to_string(),
                )
            }
        }
        Some("iterm") | Some("iTerm") => {
            // Open iTerm with specified directory
            (
                Command::new("osascript")
                    .args([
                        "-e",
                        &format!(
                            r#"tell application "iTerm"
                                activate
                                create window with default profile
                                tell current session of current window
                                    write text "cd '{}'"
                                end tell
                            end tell"#,
                            project.path
                        ),
                    ])
                    .spawn(),
                "iTerm".to_string(),
            )
        }
        Some("warp") | Some("Warp") => {
            // Open Warp terminal
            (
                Command::new("open")
                    .args(["-a", "Warp", &project.path])
                    .spawn(),
                "Warp".to_string(),
            )
        }
        Some("kitty") => {
            // Open Kitty terminal
            (
                Command::new("kitty")
                    .args(["--directory", &project.path])
                    .spawn(),
                "Kitty".to_string(),
            )
        }
        Some("alacritty") => {
            // Open Alacritty terminal
            (
                Command::new("alacritty")
                    .args(["--working-directory", &project.path])
                    .spawn(),
                "Alacritty".to_string(),
            )
        }
        Some(cmd) => {
            // Try to use custom command directly
            (
                Command::new(cmd).arg(&project.path).spawn(),
                cmd.to_string(),
            )
        }
        None => {
            // Default: open macOS Terminal.app
            (
                Command::new("open")
                    .args(["-a", "Terminal", &project.path])
                    .spawn(),
                "Terminal".to_string(),
            )
        }
    };

    match result {
        Ok(_) => Ok(Json(OpenResponse {
            success: true,
            message: format!("Opening {} in {}", project.name, display_name),
        })),
        Err(e) => Ok(Json(OpenResponse {
            success: false,
            message: format!("Failed to open terminal '{}': {}", display_name, e),
        })),
    }
}

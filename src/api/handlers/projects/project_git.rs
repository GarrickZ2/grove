//! Project git/IDE/terminal handlers

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use std::collections::HashSet;
use std::process::Command;

use crate::git;
use crate::git::git_cmd;
use crate::model::loader;
use crate::storage::{tasks, workspace};
use crate::watcher;

use super::crud::find_project_by_id;
use super::types::*;

/// GET /api/v1/projects/{id}/stats
pub async fn get_stats(Path(id): Path<String>) -> Result<Json<ProjectStatsResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;
    let project_key = workspace::project_hash(&project.path);

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
            _ => idle_tasks += 1,
        }
    }

    let total_tasks = active.len() as u32;
    let archived_tasks = archived.len() as u32;

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

/// GET /api/v1/projects/{id}/branches
pub async fn get_branches(
    Path(id): Path<String>,
    Query(params): Query<BranchQueryParams>,
) -> Result<Json<BranchesResponse>, StatusCode> {
    let project = find_project_by_id(&id)?;

    let current = git::current_branch(&project.path).unwrap_or_else(|_| "unknown".to_string());

    let project_key = workspace::project_hash(&project.path);
    let mut grove_branches = HashSet::new();

    if let Ok(active_tasks) = tasks::load_tasks(&project_key) {
        for task in active_tasks {
            grove_branches.insert(task.branch);
        }
    }

    if let Ok(archived_tasks) = tasks::load_archived_tasks(&project_key) {
        for task in archived_tasks {
            grove_branches.insert(task.branch);
        }
    }

    let branch_names = if params.remote == "local" {
        git::list_branches(&project.path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    } else {
        let remote_pattern = format!("{}/*", params.remote);
        let remote_output = git_cmd(
            &project.path,
            &[
                "branch",
                "-r",
                "--format=%(refname:short)",
                "--list",
                &remote_pattern,
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

/// POST /api/v1/projects/{id}/init-git
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

    super::crud::get_project(Path(id)).await
}

/// POST /api/v1/projects/{id}/open-ide
pub async fn open_ide(Path(id): Path<String>) -> Result<Json<OpenResponse>, StatusCode> {
    use crate::storage::config;

    let project = find_project_by_id(&id)?;
    let config = config::load_config();

    let ide_cmd = config.web.ide.unwrap_or_else(|| "code".to_string());

    let result = if ide_cmd.ends_with(".app") {
        Command::new("open")
            .args(["-a", &ide_cmd, &project.path])
            .spawn()
    } else {
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
pub async fn open_terminal(Path(id): Path<String>) -> Result<Json<OpenResponse>, StatusCode> {
    use crate::storage::config;

    let project = find_project_by_id(&id)?;
    let config = config::load_config();

    let terminal_cmd = config.web.terminal.as_deref();

    let (result, display_name) = match terminal_cmd {
        Some(cmd) if cmd.ends_with(".app") => {
            let app_name = std::path::Path::new(cmd)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(cmd);

            if app_name.to_lowercase().contains("iterm") {
                let script = format!(
                    r#"tell application "iTerm"
                                    activate
                                    create window with default profile
                                    tell current session of current window
                                        write text "cd '{}'"
                                    end tell
                                end tell"#,
                    project.path
                );
                (
                    Command::new("osascript").args(["-e", &script]).spawn(),
                    app_name.to_string(),
                )
            } else {
                (
                    Command::new("open")
                        .args(["-a", cmd, &project.path])
                        .spawn(),
                    app_name.to_string(),
                )
            }
        }
        Some("iterm") | Some("iTerm") => {
            let script = format!(
                r#"tell application "iTerm"
                                activate
                                create window with default profile
                                tell current session of current window
                                    write text "cd '{}'"
                                end tell
                            end tell"#,
                project.path
            );
            (
                Command::new("osascript").args(["-e", &script]).spawn(),
                "iTerm".to_string(),
            )
        }
        Some("warp") | Some("Warp") => (
            Command::new("open")
                .args(["-a", "Warp", &project.path])
                .spawn(),
            "Warp".to_string(),
        ),
        Some("kitty") => (
            Command::new("kitty")
                .args(["--directory", &project.path])
                .spawn(),
            "Kitty".to_string(),
        ),
        Some("alacritty") => (
            Command::new("alacritty")
                .args(["--working-directory", &project.path])
                .spawn(),
            "Alacritty".to_string(),
        ),
        Some(cmd) => (
            Command::new(cmd).arg(&project.path).spawn(),
            cmd.to_string(),
        ),
        None => (
            Command::new("open")
                .args(["-a", "Terminal", &project.path])
                .spawn(),
            "Terminal".to_string(),
        ),
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

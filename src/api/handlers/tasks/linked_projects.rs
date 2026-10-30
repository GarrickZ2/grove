//! Task-level linked Project workspace configuration.

use axum::{extract::Path, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::api::error::ApiError;
use crate::storage::{tasks, workspace};

use super::super::common;

const MAX_LINKED_PROJECTS: usize = 32;

#[derive(Debug, Serialize)]
pub struct LinkedProjectItem {
    pub id: String,
    pub name: String,
    pub exists: bool,
    pub project_type: Option<String>,
    pub is_git_repo: bool,
    /// Task whose Code Review represents this project in an aggregated
    /// Review panel. Only set for existing Repo projects (their Local Task).
    pub review_task_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LinkedProjectsResponse {
    pub linked_projects: Vec<LinkedProjectItem>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLinkedProjectsRequest {
    pub project_ids: Vec<String>,
}

fn api_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn resolve_items(
    ids: Vec<String>,
    registered: &[workspace::RegisteredProject],
) -> LinkedProjectsResponse {
    let linked_projects = ids
        .into_iter()
        .map(|id| {
            registered
                .iter()
                .find(|project| workspace::project_hash(&project.path) == id)
                .map(|project| {
                    let directory = workspace::project_directory(project);
                    let exists = directory.is_dir();
                    let review_task_id = (exists
                        && project.project_type == workspace::ProjectType::Repo
                        && crate::model::loader::sync_local_task(&project.path))
                    .then(|| tasks::LOCAL_TASK_ID.to_string());
                    LinkedProjectItem {
                        id: id.clone(),
                        name: project.name.clone(),
                        exists,
                        project_type: Some(project.project_type.as_str().to_string()),
                        is_git_repo: project.is_git_repo,
                        review_task_id,
                    }
                })
                .unwrap_or_else(|| LinkedProjectItem {
                    id: id.clone(),
                    name: "Unavailable project".to_string(),
                    exists: false,
                    project_type: None,
                    is_git_repo: false,
                    review_task_id: None,
                })
        })
        .collect();
    LinkedProjectsResponse { linked_projects }
}

pub async fn get_linked_projects(
    Path((project_id, task_id)): Path<(String, String)>,
) -> Result<Json<LinkedProjectsResponse>, (StatusCode, Json<ApiError>)> {
    let (_, project_key) = common::find_project_by_id(&project_id)
        .map_err(|status| api_error(status, "Project not found"))?;
    tasks::get_task(&project_key, &task_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Task not found"))?;

    let ids = tasks::load_linked_project_ids(&project_key, &task_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let registered = workspace::load_projects()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(resolve_items(ids, &registered)))
}

pub async fn update_linked_projects(
    Path((project_id, task_id)): Path<(String, String)>,
    Json(request): Json<UpdateLinkedProjectsRequest>,
) -> Result<Json<LinkedProjectsResponse>, (StatusCode, Json<ApiError>)> {
    let (_, project_key) = common::find_project_by_id(&project_id)
        .map_err(|status| api_error(status, "Project not found"))?;
    tasks::get_task(&project_key, &task_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Task not found"))?;

    if request.project_ids.len() > MAX_LINKED_PROJECTS {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            format!("A task can link at most {MAX_LINKED_PROJECTS} projects"),
        ));
    }

    let registered = workspace::load_projects()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let registered_ids: HashSet<String> = registered
        .iter()
        .map(|project| workspace::project_hash(&project.path))
        .collect();
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(request.project_ids.len());
    for id in request.project_ids {
        if id == project_key {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "A task cannot link its own project",
            ));
        }
        if !registered_ids.contains(&id) {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                format!("Linked project {id} is not registered"),
            ));
        }
        if seen.insert(id.clone()) {
            normalized.push(id);
        }
    }

    tasks::replace_linked_project_ids(&project_key, &task_id, &normalized)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(resolve_items(normalized, &registered)))
}

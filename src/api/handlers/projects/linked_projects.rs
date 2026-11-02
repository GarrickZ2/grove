//! Project-level default linked Projects.
//!
//! This set is only a template for new user-created Tasks: task creation
//! copies it once into the Task's own linked Projects
//! (`storage::tasks::copy_project_linked_projects_to_task`). Editing it never
//! changes existing Tasks, and the ACP resolver never reads it.

use axum::{extract::Path, http::StatusCode, Json};

use crate::api::error::ApiError;
use crate::api::handlers::common;
use crate::api::handlers::tasks::linked_projects::{
    api_error, normalize_linked_ids, resolve_items, LinkedProjectsResponse,
    UpdateLinkedProjectsRequest,
};
use crate::storage::{tasks, workspace};

/// GET /api/v1/projects/{id}/linked-projects
pub async fn get_project_linked_projects(
    Path(project_id): Path<String>,
) -> Result<Json<LinkedProjectsResponse>, (StatusCode, Json<ApiError>)> {
    let (_, project_key) = common::find_project_by_id(&project_id)
        .map_err(|status| api_error(status, "Project not found"))?;
    let ids = tasks::load_project_linked_project_ids(&project_key)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let registered = workspace::load_projects()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(resolve_items(ids, &registered)))
}

/// PUT /api/v1/projects/{id}/linked-projects
pub async fn update_project_linked_projects(
    Path(project_id): Path<String>,
    Json(request): Json<UpdateLinkedProjectsRequest>,
) -> Result<Json<LinkedProjectsResponse>, (StatusCode, Json<ApiError>)> {
    let (_, project_key) = common::find_project_by_id(&project_id)
        .map_err(|status| api_error(status, "Project not found"))?;
    let registered = workspace::load_projects()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let normalized =
        normalize_linked_ids(request.project_ids, &project_key, &registered, "project")?;
    tasks::replace_project_linked_project_ids(&project_key, &normalized)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(resolve_items(normalized, &registered)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(response: &LinkedProjectsResponse) -> Vec<String> {
        response
            .linked_projects
            .iter()
            .map(|item| item.id.clone())
            .collect()
    }

    #[tokio::test]
    async fn project_linked_projects_validate_and_round_trip() {
        let _lock = crate::storage::database::test_lock().lock().await;
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        let own = workspace::project_hash(&workspace::create_studio_project("Owner").unwrap());
        let other = workspace::project_hash(&workspace::create_studio_project("Other").unwrap());

        let empty = get_project_linked_projects(Path(own.clone()))
            .await
            .unwrap();
        assert!(empty.linked_projects.is_empty());

        // Duplicates collapse, order is kept.
        let saved = update_project_linked_projects(
            Path(own.clone()),
            Json(UpdateLinkedProjectsRequest {
                project_ids: vec![other.clone(), other.clone()],
            }),
        )
        .await
        .unwrap();
        assert_eq!(ids(&saved), [other.clone()]);
        assert_eq!(saved.linked_projects[0].name, "Other");
        let loaded = get_project_linked_projects(Path(own.clone()))
            .await
            .unwrap();
        assert_eq!(ids(&loaded), [other.clone()]);

        // Self-link, unregistered IDs and unknown owners are rejected.
        for (owner, project_ids, status) in [
            (own.clone(), vec![own.clone()], StatusCode::BAD_REQUEST),
            (own.clone(), vec!["missing".into()], StatusCode::BAD_REQUEST),
            ("missing".to_string(), vec![], StatusCode::NOT_FOUND),
        ] {
            let error = update_project_linked_projects(
                Path(owner),
                Json(UpdateLinkedProjectsRequest { project_ids }),
            )
            .await
            .unwrap_err();
            assert_eq!(error.0, status);
        }
        // A rejected write leaves the stored set unchanged.
        let loaded = get_project_linked_projects(Path(own.clone()))
            .await
            .unwrap();
        assert_eq!(ids(&loaded), [other.clone()]);

        // A linked Project that disappears is reported, not dropped.
        let conn = crate::storage::database::connection();
        conn.execute("DELETE FROM projects WHERE hash = ?1", [&other])
            .unwrap();
        drop(conn);
        let loaded = get_project_linked_projects(Path(own)).await.unwrap();
        assert_eq!(ids(&loaded), [other]);
        assert!(!loaded.linked_projects[0].exists);

        crate::storage::set_grove_dir_override(None);
    }
}

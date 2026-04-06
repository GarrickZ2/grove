//! TaskGroup API handlers

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;

use crate::api::handlers::walkie_talkie::{broadcast_radio_event, RadioEvent};
use crate::storage::taskgroups;
use crate::storage::tasks::LOCAL_TASK_ID;

// ============================================================================
// Request DTOs
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateGroupRequest {
    pub name: Option<String>,
    pub color: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertSlotRequest {
    pub position: u16,
    pub project_id: String,
    pub task_id: String,
    pub target_chat_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetSlotsRequest {
    pub slots: Vec<UpsertSlotRequest>,
}

// ============================================================================
// Handlers
// ============================================================================

/// GET /taskgroups — list all task groups
/// Note: ensure_system_groups() is called at startup and after task create/archive/delete,
/// so we don't need to call it on every list request.
pub async fn list_groups() -> impl IntoResponse {
    match taskgroups::load_groups() {
        Ok(groups) => Ok(Json(serde_json::json!({ "groups": groups }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// POST /taskgroups — create a new task group
pub async fn create_group(Json(body): Json<CreateGroupRequest>) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Group name cannot be empty".to_string(),
        ));
    }
    match taskgroups::create_group(name, body.color) {
        Ok(group) => {
            broadcast_radio_event(RadioEvent::GroupChanged);
            Ok((StatusCode::CREATED, Json(serde_json::json!(group))))
        }
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// PATCH /taskgroups/{id} — update a task group
pub async fn update_group(
    Path(id): Path<String>,
    Json(body): Json<UpdateGroupRequest>,
) -> impl IntoResponse {
    match taskgroups::update_group(&id, body.name, body.color) {
        Ok(Some(group)) => {
            broadcast_radio_event(RadioEvent::GroupChanged);
            Ok(Json(serde_json::json!(group)))
        }
        Ok(None) => Err((StatusCode::NOT_FOUND, format!("Group '{}' not found", id))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// DELETE /taskgroups/{id} — delete a task group
/// Moves its tasks back to _main or _local before deleting.
pub async fn delete_group(Path(id): Path<String>) -> impl IntoResponse {
    // System groups cannot be deleted
    if id == taskgroups::MAIN_GROUP_ID || id == taskgroups::LOCAL_GROUP_ID {
        return Err((
            StatusCode::BAD_REQUEST,
            "Cannot delete system groups".to_string(),
        ));
    }

    // Before deleting, batch-move tasks back to system groups (single load+save)
    if let Ok(mut groups) = taskgroups::load_groups() {
        let slots_to_move: Vec<taskgroups::TaskSlot> = groups
            .iter()
            .find(|g| g.id == id)
            .map(|g| g.slots.clone())
            .unwrap_or_default();

        if !slots_to_move.is_empty() {
            let mut main_max = groups
                .iter()
                .find(|g| g.id == taskgroups::MAIN_GROUP_ID)
                .map(|g| g.slots.iter().map(|s| s.position).max().unwrap_or(0))
                .unwrap_or(0);
            let mut local_max = groups
                .iter()
                .find(|g| g.id == taskgroups::LOCAL_GROUP_ID)
                .map(|g| g.slots.iter().map(|s| s.position).max().unwrap_or(0))
                .unwrap_or(0);

            for slot in &slots_to_move {
                let (target_id, pos) = if slot.task_id == LOCAL_TASK_ID {
                    local_max += 1;
                    (taskgroups::LOCAL_GROUP_ID, local_max)
                } else {
                    main_max += 1;
                    (taskgroups::MAIN_GROUP_ID, main_max)
                };
                if let Some(target) = groups.iter_mut().find(|g| g.id == target_id) {
                    target.slots.push(taskgroups::TaskSlot {
                        position: pos,
                        project_id: slot.project_id.clone(),
                        task_id: slot.task_id.clone(),
                        target_chat_id: slot.target_chat_id.clone(),
                    });
                }
            }
            // Remove the group and save everything in one write
            groups.retain(|g| g.id != id);
            let _ = taskgroups::save_groups_pub(&groups);
            broadcast_radio_event(RadioEvent::GroupChanged);
            return Ok(StatusCode::NO_CONTENT);
        }
    }

    match taskgroups::delete_group(&id) {
        Ok(true) => {
            broadcast_radio_event(RadioEvent::GroupChanged);
            Ok(StatusCode::NO_CONTENT)
        }
        Ok(false) => Err((StatusCode::NOT_FOUND, format!("Group '{}' not found", id))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// POST /taskgroups/{id}/slots — upsert a slot in a task group
pub async fn upsert_slot(
    Path(group_id): Path<String>,
    Json(body): Json<UpsertSlotRequest>,
) -> impl IntoResponse {
    if body.position == 0 {
        return Err((StatusCode::BAD_REQUEST, "Position must be >= 1".to_string()));
    }
    let slot = taskgroups::TaskSlot {
        position: body.position,
        project_id: body.project_id,
        task_id: body.task_id,
        target_chat_id: body.target_chat_id,
    };

    match taskgroups::upsert_slot(&group_id, slot) {
        Ok(Some(group)) => {
            broadcast_radio_event(RadioEvent::GroupChanged);
            Ok(Json(serde_json::json!(group)))
        }
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            format!("Group '{}' not found", group_id),
        )),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// DELETE /taskgroups/{id}/slots/{position} — remove a slot from a task group
pub async fn remove_slot(Path((group_id, position)): Path<(String, u16)>) -> impl IntoResponse {
    match taskgroups::remove_slot(&group_id, position) {
        Ok(Some(group)) => {
            broadcast_radio_event(RadioEvent::GroupChanged);
            Ok(Json(serde_json::json!(group)))
        }
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            format!("Group '{}' not found", group_id),
        )),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// PUT /taskgroups/{id}/slots — replace all slots at once (for reordering)
pub async fn set_slots(
    Path(group_id): Path<String>,
    Json(body): Json<SetSlotsRequest>,
) -> impl IntoResponse {
    let slots: Vec<taskgroups::TaskSlot> = body
        .slots
        .into_iter()
        .map(|s| taskgroups::TaskSlot {
            position: s.position,
            project_id: s.project_id,
            task_id: s.task_id,
            target_chat_id: s.target_chat_id,
        })
        .collect();

    match taskgroups::set_slots(&group_id, slots) {
        Ok(Some(group)) => {
            broadcast_radio_event(RadioEvent::GroupChanged);
            Ok(Json(serde_json::json!(group)))
        }
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            format!("Group '{}' not found", group_id),
        )),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use axum::{extract::Path, Json};

    use super::*;
    use crate::storage::taskgroups;

    /// Serialization lock — share with storage tests to avoid file contention
    static FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII guard that deletes a group on drop
    struct TestGroup {
        id: String,
    }
    impl Drop for TestGroup {
        fn drop(&mut self) {
            let _ = taskgroups::delete_group(&self.id);
        }
    }

    fn acquire_lock() -> std::sync::MutexGuard<'static, ()> {
        FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[tokio::test]
    async fn test_handler_create_and_list() {
        let _lock = acquire_lock();

        // Create via handler
        let resp = create_group(Json(CreateGroupRequest {
            name: "handler-test".to_string(),
            color: Some("#aabbcc".to_string()),
        }))
        .await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::CREATED);

        // Extract group id from response body
        let body = axum::body::to_bytes(resp.into_body(), 10000).await.unwrap();
        let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let group_id = val["id"].as_str().unwrap().to_string();
        let _guard = TestGroup {
            id: group_id.clone(),
        };

        assert_eq!(val["name"], "handler-test");
        assert_eq!(val["color"], "#aabbcc");

        // List via handler
        let resp = list_groups().await.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 100000)
            .await
            .unwrap();
        let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let groups = val["groups"].as_array().unwrap();
        assert!(groups.iter().any(|g| g["id"] == group_id));
    }

    #[tokio::test]
    async fn test_handler_update_and_delete() {
        let _lock = acquire_lock();

        // Create
        let group = taskgroups::create_group("handler-ud".to_string(), None).unwrap();
        let _guard = TestGroup {
            id: group.id.clone(),
        };

        // Update via handler
        let resp = update_group(
            Path(group.id.clone()),
            Json(UpdateGroupRequest {
                name: Some("handler-updated".to_string()),
                color: None,
            }),
        )
        .await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 10000).await.unwrap();
        let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(val["name"], "handler-updated");

        // Delete via handler
        let resp = delete_group(Path(group.id.clone())).await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::NO_CONTENT);

        // Delete again → 404
        let resp = delete_group(Path(group.id.clone())).await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_handler_slots() {
        let _lock = acquire_lock();

        let group = taskgroups::create_group("handler-slots".to_string(), None).unwrap();
        let _guard = TestGroup {
            id: group.id.clone(),
        };

        // Upsert slot
        let resp = upsert_slot(
            Path(group.id.clone()),
            Json(UpsertSlotRequest {
                position: 3,
                project_id: "p1".to_string(),
                task_id: "t1".to_string(),
                target_chat_id: None,
            }),
        )
        .await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 10000).await.unwrap();
        let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(val["slots"].as_array().unwrap().len(), 1);
        assert_eq!(val["slots"][0]["position"], 3);

        // Remove slot
        let resp = remove_slot(Path((group.id.clone(), 3))).await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);

        // Upsert to non-existent group
        let resp = upsert_slot(
            Path("nonexistent".to_string()),
            Json(UpsertSlotRequest {
                position: 1,
                project_id: "p".to_string(),
                task_id: "t".to_string(),
                target_chat_id: None,
            }),
        )
        .await;
        let resp = resp.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }
}

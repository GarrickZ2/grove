//! Buddy REST is a thin layer over the shared lifecycle and tool operations.
use crate::{
    buddy,
    error::GroveError,
    storage::{buddies as db, custom_agent, database},
};
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

type ApiError = (StatusCode, Json<Value>);
fn error(error: GroveError) -> ApiError {
    let status = match &error {
        GroveError::StorageTagged {
            tag: "buddy_busy", ..
        } => StatusCode::CONFLICT,
        GroveError::InvalidData(_)
        | GroveError::JsonParse(_)
        | GroveError::StorageTagged {
            tag: "unknown_base_agent" | "buddy_segment_read_only",
            ..
        } => StatusCode::BAD_REQUEST,
        GroveError::NotFound(_) => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let code = error.storage_tag().unwrap_or(match status {
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::BAD_REQUEST => "invalid_request",
        _ => "internal_error",
    });
    (
        status,
        Json(json!({"error":code,"message":error.to_string()})),
    )
}
fn view(buddy: db::Buddy, details: bool) -> Result<Value, GroveError> {
    let persona = custom_agent::get(&buddy.custom_agent_id)?
        .ok_or_else(|| GroveError::not_found("Buddy persona not found"))?;
    let preview = buddy::preview::get(&buddy);
    let mut value = json!({"id":buddy.id,"project_hash":buddy.project_hash,"name":persona.name,"avatar":buddy.avatar,"description":buddy.description,
        "agent":persona.base_agent,"active_session_id":buddy.active_session_id,"sort_position":buddy.sort_position,
        "status":preview.status,"last_message_preview":preview.last_message_preview,"last_activity_at":preview.last_activity_at});
    if details {
        let object = value.as_object_mut().unwrap();
        object.extend(serde_json::from_value::<serde_json::Map<String,Value>>(json!({"role":persona.duty,"system_prompt":persona.system_prompt,
            "agent_config":persona.agent_config,"model":persona.model,"mode":persona.mode,"effort":persona.effort,
            "segments":db::list_segments(&database::connection(), &buddy.id)?,"created_at":buddy.created_at,"updated_at":buddy.updated_at}))?);
    }
    Ok(value)
}
#[derive(Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub archived: bool,
}
pub async fn list(Query(query): Query<ListQuery>) -> Result<Json<Vec<Value>>, ApiError> {
    let buddies = db::list(&database::connection(), query.archived).map_err(error)?;
    Ok(Json(
        buddies
            .into_iter()
            .map(|buddy| view(buddy, false))
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?,
    ))
}
pub async fn create(
    Json(input): Json<buddy::CreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let buddy = buddy::create(input).map_err(error)?;
    Ok((StatusCode::CREATED, Json(view(buddy, true).map_err(error)?)))
}
pub async fn get(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        view(buddy::get(&id).map_err(error)?, true).map_err(error)?,
    ))
}
pub async fn update(
    Path(id): Path<String>,
    Json(input): Json<buddy::configuration::Patch>,
) -> Result<Json<Value>, ApiError> {
    let buddy = buddy::configuration::update(&id, input)
        .await
        .map_err(error)?;
    Ok(Json(view(buddy, true).map_err(error)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SwitchInput {
    pub agent: String,
    #[serde(default)]
    pub agent_config: crate::agent_config::AgentConfigSelection,
}
pub async fn switch_agent(
    Path(id): Path<String>,
    Json(input): Json<SwitchInput>,
) -> Result<Json<Value>, ApiError> {
    let buddy = buddy::switch_agent(&id, &input.agent, input.agent_config)
        .await
        .map_err(error)?;
    Ok(Json(view(buddy, true).map_err(error)?))
}
pub async fn archive(Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    buddy::get(&id).map_err(error)?;
    db::archive(&database::connection(), &id).map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn delegations(Path(id): Path<String>) -> Result<Json<Vec<db::Delegation>>, ApiError> {
    buddy::get(&id).map_err(error)?;
    Ok(Json(
        db::list_delegations(&database::connection(), &id).map_err(error)?,
    ))
}
pub async fn cancel(
    Path((id, delegation)): Path<(String, String)>,
) -> Result<Json<db::Delegation>, ApiError> {
    Ok(Json(
        buddy::delegations::cancel(&id, &delegation)
            .await
            .map_err(error)?,
    ))
}
#[derive(Deserialize)]
pub struct OrderInput {
    pub ids: Vec<String>,
}
pub async fn order(Json(input): Json<OrderInput>) -> Result<StatusCode, ApiError> {
    db::reorder(&database::connection(), &input.ids).map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        buddies::test_support::{seed_buddy, Store},
        tasks, workspace,
    };

    fn install_agent() {
        database::connection().execute("INSERT INTO installed_agents(id,installations,selected_install_method,created_at,updated_at) VALUES ('buddy-test-agent','[]','external','now','now')", []).unwrap();
    }

    #[tokio::test]
    async fn rest_creation_profile_order_and_archive_preserve_segments() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        install_agent();
        let (status, Json(created)) = create(Json(
            serde_json::from_value(json!({
                "name":"Teammate", "agent":"buddy-test-agent", "role":"Researcher",
                "system_prompt":"Be precise"
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        let id = created["id"].as_str().unwrap().to_string();
        let chat = created["active_session_id"].as_str().unwrap().to_string();
        assert_eq!(created["role"], "Researcher");
        assert_eq!(created["segments"].as_array().unwrap().len(), 1);
        assert_eq!(created["status"], "idle");
        assert!(workspace::load_projects().unwrap().is_empty());
        let Json(updated) = update(
            Path(id.clone()),
            Json(serde_json::from_value(json!({"name":"Renamed", "role":"Reviewer"})).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(updated["name"], "Renamed");
        assert_eq!(updated["role"], "Reviewer");
        assert_eq!(updated["active_session_id"], chat);
        assert!(serde_json::from_value::<buddy::configuration::Patch>(
            json!({"agent":"different"})
        )
        .is_err());
        let second = seed_buddy(&database::connection(), "rest-second");
        order(Json(OrderInput {
            ids: vec![second.id.clone(), id.clone()],
        }))
        .await
        .unwrap();
        let Json(listed) = list(Query(ListQuery::default())).await.unwrap();
        assert_eq!(listed[0]["id"], second.id);
        assert_eq!(listed[1]["id"], id);
        assert_eq!(
            archive(Path(id.clone())).await.unwrap(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(list(Query(ListQuery::default())).await.unwrap().0.len(), 1);
        assert_eq!(
            list(Query(ListQuery { archived: true })).await.unwrap().0[0]["id"],
            id
        );
        assert!(tasks::find_chat_session(&chat).unwrap().is_some());
        assert_eq!(
            get(Path(id)).await.unwrap().0["segments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            get(Path("missing".into())).await.unwrap_err().0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn busy_switch_is_conflict_and_generic_removal_cannot_stop_segment() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        install_agent();
        let buddy = seed_buddy(&database::connection(), "rest-busy");
        let chat = buddy.active_session_id.as_deref().unwrap();
        let key = format!("{}:_local:{chat}", buddy.project_hash);
        let (handle, _, _guard) =
            crate::acp::new_handle_for_test(&key, &buddy.project_hash, tasks::LOCAL_TASK_ID, chat);
        handle
            .is_busy
            .store(true, std::sync::atomic::Ordering::Release);
        let (status, body) = switch_agent(
            Path(buddy.id.clone()),
            Json(SwitchInput {
                agent: "buddy-test-agent".into(),
                agent_config: Default::default(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body.0["error"], "buddy_busy");
        let path = (
            buddy.project_hash.clone(),
            tasks::LOCAL_TASK_ID.into(),
            chat.to_owned(),
        );
        assert!(matches!(
            super::super::acp::archive_chat(Path(path.clone())).await,
            Err(super::super::acp::AcpError::BadRequest(_))
        ));
        assert!(matches!(
            super::super::acp::delete_chat(
                Path(path),
                Query(
                    serde_json::from_value::<super::super::acp::DeleteChatQuery>(
                        json!({"scope":"agent"})
                    )
                    .unwrap()
                )
            )
            .await,
            Err(super::super::acp::AcpError::BadRequest(_))
        ));
        assert_eq!(
            buddy::get(&buddy.id).unwrap().active_session_id,
            buddy.active_session_id
        );
        assert!(handle.begin_activity().is_ok());
        assert!(
            tasks::delete_chat_session(&buddy.project_hash, tasks::LOCAL_TASK_ID, chat).is_err()
        );
        assert!(
            tasks::archive_chat_session(&buddy.project_hash, tasks::LOCAL_TASK_ID, chat).is_err()
        );
        assert!(tasks::find_chat_session(chat).unwrap().is_some());
    }
}

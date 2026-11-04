//! Buddy group REST, a thin layer over `buddy::group`.
use super::buddies::{error, ApiError};
use crate::{
    buddy::{self, attachments::Outgoing, group},
    error::GroveError,
    storage::{
        buddy_groups::{self as db, Group},
        custom_agent, database,
    },
};
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

fn view(group: Group) -> Result<Value, GroveError> {
    let (members, last) = {
        let conn = database::try_connection()?;
        (
            db::list_members(&conn, &group.id)?,
            db::last_spoken(&conn, &group.id)?,
        )
    };
    let mut people = Vec::new();
    let mut status = "idle";
    for member in members {
        let buddy = buddy::get(&member.buddy_id)?;
        let persona = custom_agent::get(&buddy.custom_agent_id)?
            .ok_or_else(|| GroveError::not_found("Buddy persona not found"))?;
        let state = group::member_status(&buddy, &member);
        status = match (status, state) {
            ("waiting", _) | (_, "waiting") => "waiting",
            ("working", _) | (_, "working") => "working",
            _ => "idle",
        };
        people.push(json!({"buddy_id":buddy.id,"name":persona.name,"avatar":buddy.avatar,"role":persona.duty,
            "status":state,"session_id":member.session_id,"project_hash":buddy.project_hash,"task_id":member.task_id}));
    }
    let preview = last.as_ref().map(|message| {
        let speaker = people
            .iter()
            .find(|person| {
                Some(person["buddy_id"].as_str().unwrap_or_default())
                    == message.sender_id.as_deref()
            })
            .and_then(|person| person["name"].as_str());
        match speaker {
            Some(name) => format!("{name}: {}", message.text),
            None => message.text.clone(),
        }
    });
    Ok(
        json!({"id":group.id,"name":group.name,"pinned":group.pinned_at.is_some(),"sort_position":group.sort_position,
        "status":status,"members":people,"last_message_preview":preview,
        "last_activity_at":last.map_or(group.created_at.clone(), |message| message.created_at),"created_at":group.created_at}),
    )
}

fn load(id: &str) -> Result<Group, GroveError> {
    db::get_group(&*database::try_connection()?, id)?
        .ok_or_else(|| GroveError::not_found("Group not found"))
}

pub async fn list() -> Result<Json<Vec<Value>>, ApiError> {
    let groups = db::list_groups(&database::connection()).map_err(error)?;
    Ok(Json(
        groups
            .into_iter()
            .map(view)
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?,
    ))
}

pub async fn create(
    Json(input): Json<group::CreateInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let created = group::create(input).map_err(error)?;
    Ok((StatusCode::CREATED, Json(view(created).map_err(error)?)))
}

pub async fn get(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(view(load(&id).map_err(error)?).map_err(error)?))
}

#[derive(Deserialize)]
pub struct UpdateInput {
    pub name: String,
}
pub async fn update(
    Path(id): Path<String>,
    Json(input): Json<UpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let group = group::rename(&id, &input.name).map_err(error)?;
    Ok(Json(view(group).map_err(error)?))
}

pub async fn disband(Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    group::disband(&id).await.map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct PinInput {
    pub pinned: bool,
}
pub async fn pin(
    Path(id): Path<String>,
    Json(input): Json<PinInput>,
) -> Result<Json<Value>, ApiError> {
    if !db::set_pinned(&database::connection(), &id, input.pinned).map_err(error)? {
        return Err(error(GroveError::not_found("Group not found")));
    }
    Ok(Json(view(load(&id).map_err(error)?).map_err(error)?))
}

pub async fn stop(Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    group::stop(&id).await.map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    pub before_seq: Option<i64>,
    pub limit: Option<i64>,
}
pub async fn messages(
    Path(id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    let page = db::messages_before(&database::connection(), &id, query.before_seq, limit)
        .map_err(error)?;
    let has_earlier = page.first().is_some_and(|message| message.seq > 1);
    Ok(Json(json!({"messages":page,"has_earlier":has_earlier})))
}

#[derive(Deserialize)]
pub struct AttachmentInput {
    pub name: String,
    pub mime_type: String,
    /// Base64 file content.
    pub data: String,
}
#[derive(Deserialize)]
pub struct SendInput {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
}
pub async fn send(
    Path(id): Path<String>,
    Json(input): Json<SendInput>,
) -> Result<(StatusCode, Json<db::Message>), ApiError> {
    let files = input
        .attachments
        .into_iter()
        .map(|file| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&file.data)
                .map_err(|_| GroveError::invalid_data("Attachment is not valid base64"))?;
            Ok(Outgoing {
                name: file.name,
                mime_type: file.mime_type,
                bytes,
            })
        })
        .collect::<Result<Vec<_>, GroveError>>()
        .map_err(error)?;
    let message = group::send(&id, &input.text, &files).map_err(error)?;
    Ok((StatusCode::CREATED, Json(message)))
}

#[derive(Deserialize)]
pub struct MemberInput {
    pub buddy_id: String,
}
pub async fn add_member(
    Path(id): Path<String>,
    Json(input): Json<MemberInput>,
) -> Result<Json<Value>, ApiError> {
    group::add_member(&id, &input.buddy_id).map_err(error)?;
    Ok(Json(view(load(&id).map_err(error)?).map_err(error)?))
}

pub async fn remove_member(
    Path((id, buddy_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    group::remove_member(&id, &buddy_id).await.map_err(error)?;
    Ok(Json(view(load(&id).map_err(error)?).map_err(error)?))
}

pub async fn ask_again(
    Path((id, buddy_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    group::ask_again(&id, &buddy_id).map_err(error)?;
    Ok(StatusCode::ACCEPTED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::buddies::test_support::{seed_buddy, Store};

    #[tokio::test]
    async fn rest_covers_a_group_from_creation_to_disbanding() {
        let _lock = database::test_lock().lock().await;
        let _store = Store::new();
        {
            let conn = database::connection();
            seed_buddy(&conn, "one");
            seed_buddy(&conn, "two");
            seed_buddy(&conn, "three");
        }
        let (status, Json(created)) = create(Json(group::CreateInput {
            name: Some("Crew".into()),
            buddy_ids: vec!["one".into(), "two".into()],
        }))
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["members"].as_array().unwrap().len(), 2);
        assert_eq!(created["status"], "idle");
        let Json(added) = add_member(
            Path(id.clone()),
            Json(MemberInput {
                buddy_id: "three".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(added["members"].as_array().unwrap().len(), 3);
        let Json(renamed) = update(Path(id.clone()), Json(UpdateInput { name: "New".into() }))
            .await
            .unwrap();
        assert_eq!(renamed["name"], "New");
        let Json(pinned) = pin(Path(id.clone()), Json(PinInput { pinned: true }))
            .await
            .unwrap();
        assert_eq!(pinned["pinned"], true);
        let Json(page) = messages(
            Path(id.clone()),
            Query(MessagesQuery {
                before_seq: None,
                limit: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(page["messages"][0]["text"], "ca-three joined");
        let Json(all) = list().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["last_message_preview"], Value::Null);
        assert_eq!(
            disband(Path(id.clone())).await.unwrap(),
            StatusCode::NO_CONTENT
        );
        assert!(list().await.unwrap().0.is_empty());
    }
}

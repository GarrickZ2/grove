//! Custom Agent (Persona) API handlers
//!
//! REST endpoints:
//!   GET    /api/v1/custom-agents         → list
//!   POST   /api/v1/custom-agents         → create
//!   PATCH  /api/v1/custom-agents/{id}    → update
//!   DELETE /api/v1/custom-agents/{id}    → delete

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;

use crate::storage::custom_agent::{self, CustomAgent, CustomAgentInput, CustomAgentPatch};

#[derive(Debug, Serialize)]
pub struct CustomAgentDto {
    pub id: String,
    pub name: String,
    pub base_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
    pub system_prompt: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<CustomAgent> for CustomAgentDto {
    fn from(a: CustomAgent) -> Self {
        Self {
            id: a.id,
            name: a.name,
            base_agent: a.base_agent,
            model: a.model,
            mode: a.mode,
            effort: a.effort,
            duty: a.duty,
            system_prompt: a.system_prompt,
            created_at: a.created_at.to_rfc3339(),
            updated_at: a.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CustomAgentsListResponse {
    pub agents: Vec<CustomAgentDto>,
}

/// GET /api/v1/custom-agents
pub async fn list() -> impl IntoResponse {
    match custom_agent::list() {
        Ok(items) => Ok(Json(CustomAgentsListResponse {
            agents: items.into_iter().map(Into::into).collect(),
        })),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

fn validate_name(name: &str) -> std::result::Result<(), (StatusCode, String)> {
    if name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name is required".to_string()));
    }
    Ok(())
}

fn validate_base(base: &str) -> std::result::Result<(), (StatusCode, String)> {
    if base.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "base_agent is required".to_string(),
        ));
    }
    Ok(())
}

/// POST /api/v1/custom-agents
pub async fn create(Json(body): Json<CustomAgentInput>) -> impl IntoResponse {
    validate_name(&body.name)?;
    validate_base(&body.base_agent)?;
    match custom_agent::create(body) {
        Ok(item) => Ok((StatusCode::CREATED, Json(CustomAgentDto::from(item)))),
        Err(e) => Err(map_persona_error(&e)),
    }
}

/// PATCH /api/v1/custom-agents/{id}
pub async fn update(
    Path(id): Path<String>,
    Json(patch): Json<CustomAgentPatch>,
) -> impl IntoResponse {
    if let Some(ref name) = patch.name {
        validate_name(name)?;
    }
    if let Some(ref base) = patch.base_agent {
        validate_base(base)?;
    }
    // Refuse a base_agent change while any chat still references this persona.
    // The chat's `acp_session_id` was written by the previous base agent's
    // server; spawning a different base on Resume would either fail
    // LoadSession or silently mismatch — see review #2.
    if patch.base_agent.is_some() {
        if let Some(existing) = custom_agent::get(&id).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("lookup persona: {}", e),
            )
        })? {
            if patch.base_agent.as_deref() != Some(&existing.base_agent) {
                let in_use = crate::storage::tasks::count_chats_with_agent(&id).map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("count chats: {}", e),
                    )
                })?;
                if in_use > 0 {
                    return Err((
                        StatusCode::CONFLICT,
                        format!(
                            "cannot change base agent: persona is in use by {} chat session(s); \
                             archive or delete those chats first",
                            in_use
                        ),
                    ));
                }
            }
        }
    }
    match custom_agent::update(&id, patch) {
        Ok(Some(item)) => Ok(Json(CustomAgentDto::from(item))),
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            format!("custom agent '{}' not found", id),
        )),
        Err(e) => Err(map_persona_error(&e)),
    }
}

/// 把 storage 层抛的 tagged error 映射到合适的 HTTP code，避免把"用户输入
/// 不存在的 base_agent"这种 4xx 当成 500 报。
fn map_persona_error(e: &crate::error::GroveError) -> (StatusCode, String) {
    match e.storage_tag() {
        Some("unknown_base_agent") => (StatusCode::BAD_REQUEST, e.to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// DELETE /api/v1/custom-agents/{id}
pub async fn delete(Path(id): Path<String>) -> impl IntoResponse {
    // Refuse delete while any chat still references this persona — otherwise
    // those chats would be bricked with "Unknown agent: ca-..." on next
    // connect (review #1).
    let in_use = crate::storage::tasks::count_chats_with_agent(&id).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("count chats: {}", e),
        )
    })?;
    if in_use > 0 {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "cannot delete persona: still in use by {} chat session(s); archive or \
                 delete those chats first",
                in_use
            ),
        ));
    }
    match custom_agent::delete(&id) {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err((
            StatusCode::NOT_FOUND,
            format!("custom agent '{}' not found", id),
        )),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;
    use chrono::Utc;

    /// Per-thread grove_dir override so parallel tests in unrelated modules
    /// (e.g. `storage::sketches`) don't see our sandbox via the process-wide
    /// HOME env. Uses `thread_local!` storage in `crate::storage`, which is
    /// safe across `#[tokio::test]` (current-thread runtime by default).
    struct DirGuard {
        temp: std::path::PathBuf,
    }
    impl Drop for DirGuard {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }
    fn sandbox_grove_dir() -> DirGuard {
        let temp = std::env::temp_dir().join(format!(
            "grove-custom-agent-handler-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp).unwrap();
        crate::storage::set_grove_dir_override(Some(temp.clone()));
        DirGuard { temp }
    }

    async fn acquire_lock() -> tokio::sync::MutexGuard<'static, ()> {
        crate::storage::database::test_lock().lock().await
    }

    fn create_persona(name: &str, base: &str) -> custom_agent::CustomAgent {
        custom_agent::create(custom_agent::CustomAgentInput {
            name: name.to_string(),
            base_agent: base.to_string(),
            model: None,
            mode: None,
            effort: None,
            duty: None,
            system_prompt: String::new(),
        })
        .unwrap()
    }

    fn insert_chat_with_agent(agent: &str) -> String {
        let chat = crate::storage::tasks::ChatSession {
            id: format!("chat-{}", uuid::Uuid::new_v4().simple()),
            title: "test chat".to_string(),
            agent: agent.to_string(),
            acp_session_id: None,
            created_at: Utc::now(),
            duty: None,
        };
        crate::storage::tasks::add_chat_session("p", "t", chat.clone()).unwrap();
        chat.id
    }

    #[tokio::test]
    async fn delete_in_use_persona_returns_409() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let persona = create_persona("inuse", "claude");
        let chat_id = insert_chat_with_agent(&persona.id);

        let resp = delete(axum::extract::Path(persona.id.clone()))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        // Persona still exists.
        assert!(custom_agent::get(&persona.id).unwrap().is_some());

        // Cleanup.
        let _ = crate::storage::tasks::delete_chat_session("p", "t", &chat_id);
        let _ = custom_agent::delete(&persona.id);
    }

    #[tokio::test]
    async fn delete_unused_persona_returns_204() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let persona = create_persona("unused", "claude");
        let resp = delete(axum::extract::Path(persona.id.clone()))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(custom_agent::get(&persona.id).unwrap().is_none());
    }

    #[tokio::test]
    async fn update_base_agent_change_in_use_returns_409() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let persona = create_persona("p1", "claude");
        let chat_id = insert_chat_with_agent(&persona.id);

        let patch = custom_agent::CustomAgentPatch {
            base_agent: Some("codex".to_string()),
            ..Default::default()
        };
        let resp = update(axum::extract::Path(persona.id.clone()), Json(patch))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        // base_agent unchanged.
        let after = custom_agent::get(&persona.id).unwrap().unwrap();
        assert_eq!(after.base_agent, "claude");

        let _ = crate::storage::tasks::delete_chat_session("p", "t", &chat_id);
        let _ = custom_agent::delete(&persona.id);
    }

    #[tokio::test]
    async fn update_same_base_agent_in_use_returns_200() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let persona = create_persona("p2", "claude");
        let chat_id = insert_chat_with_agent(&persona.id);

        // Same base_agent → allowed even when in-use.
        let patch = custom_agent::CustomAgentPatch {
            name: Some("renamed".to_string()),
            base_agent: Some("claude".to_string()),
            ..Default::default()
        };
        let resp = update(axum::extract::Path(persona.id.clone()), Json(patch))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let after = custom_agent::get(&persona.id).unwrap().unwrap();
        assert_eq!(after.name, "renamed");

        let _ = crate::storage::tasks::delete_chat_session("p", "t", &chat_id);
        let _ = custom_agent::delete(&persona.id);
    }

    #[tokio::test]
    async fn update_base_agent_change_unused_returns_200() {
        let _lock = acquire_lock().await;
        let _dir = sandbox_grove_dir();

        let persona = create_persona("p3", "claude");
        let patch = custom_agent::CustomAgentPatch {
            base_agent: Some("codex".to_string()),
            ..Default::default()
        };
        let resp = update(axum::extract::Path(persona.id.clone()), Json(patch))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let after = custom_agent::get(&persona.id).unwrap().unwrap();
        assert_eq!(after.base_agent, "codex");
        let _ = custom_agent::delete(&persona.id);
    }
}

//! Agent discovery API handlers

use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct BaseAgentDto {
    pub id: String,
    pub display_name: String,
    pub icon_id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BaseAgentsResponse {
    pub agents: Vec<BaseAgentDto>,
}

/// GET /api/v1/agents/base
///
/// Return every built-in ACP base agent with backend-derived availability.
/// Settings uses this as the source of truth instead of probing commands in
/// the browser.
///
/// `base_acp_agent_statuses` probes PATH on every call (no cache) so the UI
/// immediately reflects newly installed agents without a restart.
pub async fn list_base_agents() -> Json<BaseAgentsResponse> {
    let agents = crate::acp::base_acp_agent_statuses()
        .into_iter()
        .map(|status| BaseAgentDto {
            id: status.agent.id.to_string(),
            display_name: status.agent.display_name.to_string(),
            icon_id: status.agent.icon_id.to_string(),
            available: status.available,
            unavailable_reason: status.unavailable_reason,
        })
        .collect();

    Json(BaseAgentsResponse { agents })
}

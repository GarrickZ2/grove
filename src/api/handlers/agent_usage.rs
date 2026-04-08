//! Agent usage quota HTTP handler.
//!
//! GET /api/v1/agent-usage/{agent}?force=<bool>
//!
//! Returns the current Claude / Codex / Gemini quota, or 404 when the agent
//! isn't one of the three supported IDs or when no usage data is available
//! (missing credentials, expired token, upstream error). The frontend treats
//! 404 as "feature not available for this agent" and hides the badge.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde::Serialize;

use crate::agent_usage::{self, AgentUsage, UsageError};

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    /// Bypass the 60s in-memory cache and fetch fresh data.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Serialize)]
pub struct UsageErrorResponse {
    pub error: String,
    pub message: String,
}

fn into_http_error(err: UsageError) -> (StatusCode, Json<UsageErrorResponse>) {
    let status = match err {
        UsageError::UnsupportedAgent => StatusCode::NOT_FOUND,
        UsageError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
        UsageError::Forbidden(_) => StatusCode::FORBIDDEN,
        UsageError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
        UsageError::Upstream(_) => StatusCode::BAD_GATEWAY,
        UsageError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let body = UsageErrorResponse {
        error: err.code().to_string(),
        message: err.message().to_string(),
    };
    (status, Json(body))
}

/// GET /api/v1/agent-usage/{agent}
pub async fn get_agent_usage(
    Path(agent): Path<String>,
    Query(query): Query<UsageQuery>,
) -> Result<Json<AgentUsage>, (StatusCode, Json<UsageErrorResponse>)> {
    agent_usage::fetch_usage(&agent, query.force)
        .await
        .map(Json)
        .map_err(into_http_error)
}

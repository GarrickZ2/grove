//! Agent usage quota HTTP handler.
//!
//! GET /api/v1/agent-usage/{agent}?force=<bool>&model=<string>
//!
//! Returns the current quota for the requested agent. The optional `model`
//! query parameter lets multi-provider agents (e.g. opencode) specify which
//! underlying model's quota to fetch — the cache key is derived from the
//! provider + model pair so different upstream pools don't collide. For
//! standalone agents (claude/codex/gemini/copilot/kimi) the parameter is
//! accepted but ignored — they share one quota pool.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde::Serialize;

use crate::agent_usage::{self, UsageError};

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    pub force: bool,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UsageErrorResponse {
    pub error: String,
    pub message: String,
}

fn into_http_error(err: UsageError) -> (StatusCode, Json<UsageErrorResponse>) {
    let status = match err {
        UsageError::UnsupportedAgent => StatusCode::NO_CONTENT,
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
) -> impl IntoResponse {
    match agent_usage::fetch_usage(&agent, query.model.as_deref(), query.force).await {
        Ok(usage) => Json(usage).into_response(),
        Err(UsageError::UnsupportedAgent) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => into_http_error(err).into_response(),
    }
}

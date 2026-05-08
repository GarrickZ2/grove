//! Statistics API handlers — Global + Project scope, backed by
//! `chat_token_usage`. See `crate::stats` for aggregation logic.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use chrono::{Duration, Utc};
use serde::Deserialize;

use crate::stats::{self, Bucket, Scope, StatisticsResponse};
use crate::storage::workspace;

/// Query parameters for both endpoints.
///
/// `from`/`to` are Unix seconds (inclusive). `bucket` is one of
/// `hourly|daily|weekly|monthly` (defaults to `daily`). All optional —
/// missing values fall back to "last 7 days, daily".
#[derive(Debug, Deserialize)]
pub struct StatisticsQuery {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub bucket: Option<String>,
}

fn resolve_range(query: &StatisticsQuery) -> (i64, i64, Bucket) {
    let now = Utc::now().timestamp();
    let to = query.to.unwrap_or(now);
    let from = query
        .from
        .unwrap_or_else(|| to - Duration::days(7).num_seconds());
    let from = from.min(to);
    let bucket = query
        .bucket
        .as_deref()
        .map(Bucket::parse)
        .unwrap_or(Bucket::Daily);
    (from, to, bucket)
}

/// GET /api/v1/statistics/global
pub async fn get_global_statistics(
    Query(query): Query<StatisticsQuery>,
) -> Json<StatisticsResponse> {
    let (from, to, bucket) = resolve_range(&query);
    Json(stats::aggregate(&Scope::Global, from, to, bucket))
}

/// GET /api/v1/statistics/project/{id}
pub async fn get_project_statistics(
    Path(id): Path<String>,
    Query(query): Query<StatisticsQuery>,
) -> Result<Json<StatisticsResponse>, StatusCode> {
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let project_key = workspace::project_hash(&project.path);

    let (from, to, bucket) = resolve_range(&query);
    Ok(Json(stats::aggregate(
        &Scope::Project(project_key),
        from,
        to,
        bucket,
    )))
}

//! Project-level statistics API handler
//!
//! GET /api/v1/projects/{id}/statistics?from=YYYY-MM-DD&to=YYYY-MM-DD

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;

use crate::stats;
use crate::stats::ProjectStatisticsResponse;
use crate::storage::workspace;

/// Query parameters for statistics endpoint
#[derive(Debug, Deserialize)]
pub struct StatisticsQuery {
    /// Start date (inclusive), "YYYY-MM-DD". Defaults to 30 days ago.
    pub from: Option<String>,
    /// End date (inclusive), "YYYY-MM-DD". Defaults to today.
    pub to: Option<String>,
}

/// GET /api/v1/projects/{id}/statistics
pub async fn get_project_statistics(
    Path(id): Path<String>,
    Query(query): Query<StatisticsQuery>,
) -> Result<Json<ProjectStatisticsResponse>, StatusCode> {
    // Resolve project
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .into_iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let project_key = workspace::project_hash(&project.path);

    let today = Utc::now().date_naive();

    let to = match &query.to {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap_or(today),
        None => today,
    };

    let from = match &query.from {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap_or(to - Duration::days(30)),
        None => to - Duration::days(30),
    };

    // Clamp to [from, today]
    let to = to.min(today);
    let from = from.min(to);

    let response = stats::aggregate_range(&project_key, from, to);

    Ok(Json(response))
}

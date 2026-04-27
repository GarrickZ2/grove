//! MiniMax coding plan usage quota fetcher.
//!
//! Reads the API key from OpenCode's auth.json under the `minimax` entry and
//! calls `https://www.minimax.io/v1/api/openplatform/coding_plan/remains`.
//! The endpoint authenticates by Bearer token alone — the group id is
//! resolved server-side from the key.
//!
//! Returns a `model_remains[]` array with both rolling-interval (≈4–5h) and
//! weekly counters. We surface a window per non-empty model × bucket.

use super::{
    clamp_percent, opencode_auth::read_opencode_token, AcpQuotaProvider, AgentUsage, ExtraInfo,
    UsageWindow, HTTP_TIMEOUT_MINIMAX,
};
use serde::Deserialize;

const USAGE_URL: &str = "https://www.minimax.io/v1/api/openplatform/coding_plan/remains";
pub(super) const OPENCODE_KEY: &str = "minimax";

#[derive(Debug, Deserialize)]
struct ModelRemain {
    model_name: Option<String>,
    // Rolling interval window (typically 4–5h)
    start_time: Option<i64>,
    end_time: Option<i64>,
    remains_time: Option<i64>,
    current_interval_total_count: Option<u64>,
    current_interval_usage_count: Option<u64>,
    // Weekly window
    weekly_start_time: Option<i64>,
    weekly_end_time: Option<i64>,
    weekly_remains_time: Option<i64>,
    current_weekly_total_count: Option<u64>,
    current_weekly_usage_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct BaseResp {
    status_code: Option<i64>,
    status_msg: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MiniMaxResponse {
    model_remains: Option<Vec<ModelRemain>>,
    base_resp: Option<BaseResp>,
}

pub struct MiniMaxProvider;

impl AcpQuotaProvider for MiniMaxProvider {
    fn provider_id(&self) -> &str {
        "minimax"
    }

    fn quota_id(&self, _model: Option<&str>) -> String {
        "minimax".to_string()
    }

    fn fetch_usage(&self, _model: Option<&str>) -> Result<AgentUsage, String> {
        let token = read_opencode_token(OPENCODE_KEY).ok_or("MiniMax token not found")?;
        fetch_with_token(&token)
    }
}

pub(super) fn fetch_with_token(token: &str) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT_MINIMAX)
        .build();
    let resp = agent
        .get(USAGE_URL)
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/plain, */*")
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;
    let body: MiniMaxResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    if let Some(base) = &body.base_resp {
        if base.status_code != Some(0) {
            return Err(format!(
                "api error: {}",
                base.status_msg.clone().unwrap_or_else(|| "unknown".into())
            ));
        }
    }

    let entries = body.model_remains.ok_or("missing model_remains array")?;

    let mut usage = AgentUsage::new("minimax");
    usage.plan = Some("MiniMax".to_string());

    for entry in entries {
        let model = entry.model_name.unwrap_or_else(|| "unknown".to_string());

        // Interval window
        if let (Some(total), Some(remaining)) = (
            entry.current_interval_total_count,
            entry.current_interval_usage_count,
        ) {
            if total > 0 {
                let pct = clamp_percent((remaining as f32 / total as f32) * 100.0);
                let total_window_seconds = match (entry.start_time, entry.end_time) {
                    (Some(s), Some(e)) if e > s => Some((e - s) / 1000),
                    _ => None,
                };
                let resets_in_seconds = entry.remains_time.map(|ms| ms / 1000);
                let resets_at = entry
                    .end_time
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|dt| dt.to_rfc3339());

                usage.windows.push(UsageWindow {
                    label: format!("{} (interval)", model),
                    percentage_remaining: pct,
                    resets_at,
                    resets_in_seconds,
                    total_window_seconds,
                });
                usage.extras.push(ExtraInfo {
                    label: format!("{} interval", model),
                    value: format!("{} / {} left", remaining, total),
                });
            }
        }

        // Weekly window
        if let (Some(total), Some(remaining)) = (
            entry.current_weekly_total_count,
            entry.current_weekly_usage_count,
        ) {
            if total > 0 {
                let pct = clamp_percent((remaining as f32 / total as f32) * 100.0);
                let total_window_seconds = match (entry.weekly_start_time, entry.weekly_end_time) {
                    (Some(s), Some(e)) if e > s => Some((e - s) / 1000),
                    _ => Some(7 * 86400),
                };
                let resets_in_seconds = entry.weekly_remains_time.map(|ms| ms / 1000);
                let resets_at = entry
                    .weekly_end_time
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|dt| dt.to_rfc3339());

                usage.windows.push(UsageWindow {
                    label: format!("{} (weekly)", model),
                    percentage_remaining: pct,
                    resets_at,
                    resets_in_seconds,
                    total_window_seconds,
                });
                usage.extras.push(ExtraInfo {
                    label: format!("{} weekly", model),
                    value: format!("{} / {} left", remaining, total),
                });
            }
        }
    }

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

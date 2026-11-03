//! Synthetic quota fetcher.
//!
//! Reads the token from OpenCode's auth.json under `synthetic`, calls
//! `https://api.synthetic.new/v2/quotas`. The response has up to three
//! buckets: `subscription`, `search.hourly`, `freeToolCalls` — each carrying
//! `{limit, requests, renewsAt}` where `requests` is the count consumed so
//! far in the window. Each one present with a positive limit becomes a window.

use super::super::{
    clamp_percent, iso_to_seconds_remaining, AgentUsage, ExtraInfo, UsageWindow,
    HTTP_TIMEOUT_SYNTHETIC,
};
use serde::Deserialize;

const USAGE_URL: &str = "https://api.synthetic.new/v2/quotas";

#[derive(Debug, Deserialize)]
struct Bucket {
    limit: Option<f64>,
    requests: Option<f64>,
    #[serde(rename = "renewsAt")]
    renews_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchBlock {
    hourly: Option<Bucket>,
}

#[derive(Debug, Deserialize)]
struct SyntheticResponse {
    subscription: Option<Bucket>,
    search: Option<SearchBlock>,
    #[serde(rename = "freeToolCalls")]
    free_tool_calls: Option<Bucket>,
}

pub(crate) fn fetch_with_token(token: &str) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT_SYNTHETIC)
        .build();
    let resp = agent
        .get(USAGE_URL)
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;
    let body: SyntheticResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    usage_from_response(body)
}

fn usage_from_response(body: SyntheticResponse) -> Result<AgentUsage, String> {
    let mut usage = AgentUsage::new("synthetic");
    usage.plan = Some("Synthetic".to_string());

    // Synthetic publishes three fixed-cadence buckets. Hard-code the windows
    // so the frontend can compute a safe-guard line.
    let search_hourly = body.search.and_then(|s| s.hourly);
    for (label, bucket, total_window_seconds) in [
        ("Subscription", body.subscription, 30 * 86400),
        ("Search 1h", search_hourly, 3600),
        ("Free tools", body.free_tool_calls, 86400),
    ] {
        if let Some(bucket) = bucket {
            push_bucket(&mut usage, label, &bucket, Some(total_window_seconds));
        }
    }

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

fn push_bucket(usage: &mut AgentUsage, label: &str, b: &Bucket, total_window_seconds: Option<i64>) {
    // An unknown or zero cap would read as "0% left" and drag the badge down.
    let limit = match b.limit {
        Some(limit) if limit > 0.0 => limit,
        _ => return,
    };
    let requests = b.requests.unwrap_or(0.0);
    let remaining = (limit - requests).max(0.0);
    let pct = clamp_percent(((remaining / limit) * 100.0) as f32);
    usage.windows.push(UsageWindow {
        label: label.to_string(),
        percentage_remaining: pct,
        resets_at: b.renews_at.clone(),
        resets_in_seconds: b.renews_at.as_deref().and_then(iso_to_seconds_remaining),
        total_window_seconds,
    });
    usage.extras.push(ExtraInfo {
        label: label.to_string(),
        value: format!("{}/{} used", requests as i64, limit as i64),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> SyntheticResponse {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn missing_buckets_keep_the_others() {
        let usage =
            usage_from_response(parse(r#"{"subscription":{"limit":100,"requests":25}}"#)).unwrap();
        let labels: Vec<_> = usage.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Subscription"]);
        assert_eq!(usage.percentage_remaining, 75.0);
    }

    #[test]
    fn zero_limit_bucket_does_not_read_as_exhausted() {
        let body = parse(
            r#"{"subscription":{"limit":100,"requests":10},"freeToolCalls":{"limit":0,"requests":0}}"#,
        );
        let usage = usage_from_response(body).unwrap();
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.percentage_remaining, 90.0);
    }
}

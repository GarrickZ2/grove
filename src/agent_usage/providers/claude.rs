//! Claude Code upstream quota API caller.
//!
//! Calls `https://api.anthropic.com/api/oauth/usage` with an already-resolved
//! access token. Does NOT read credentials — that is the agent layer's job.

use super::super::{
    clamp_percent, iso_to_seconds_remaining, AgentUsage, ExtraInfo, UsageWindow,
    HTTP_TIMEOUT_CLAUDE,
};
use serde::Deserialize;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CODE_UA: &str = "claude-code/2.1.92";

#[derive(Debug, Deserialize)]
pub(crate) struct OAuthUsageResponse {
    pub five_hour: Option<OAuthWindow>,
    pub seven_day: Option<OAuthWindow>,
    pub seven_day_opus: Option<OAuthWindow>,
    pub seven_day_sonnet: Option<OAuthWindow>,
    pub extra_usage: Option<OAuthExtraUsage>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OAuthWindow {
    pub utilization: Option<f32>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OAuthExtraUsage {
    pub is_enabled: Option<bool>,
    /// cents
    pub monthly_limit: Option<f64>,
    /// cents
    pub used_credits: Option<f64>,
    pub currency: Option<String>,
}

/// Resolved Claude credentials passed in from the agent layer.
pub(crate) struct Credentials {
    pub access_token: String,
    pub rate_limit_tier: Option<String>,
    pub subscription_type: Option<String>,
}

pub(crate) fn fetch_with_credentials(creds: &Credentials) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT_CLAUDE)
        .build();
    let resp = agent
        .get(USAGE_URL)
        .set("Authorization", &format!("Bearer {}", creds.access_token))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("Accept", "application/json, text/plain, */*")
        .set("Content-Type", "application/json")
        .set("User-Agent", CLAUDE_CODE_UA)
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;

    let body: OAuthUsageResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    usage_from_response(body, creds)
}

/// Some accounts get no `five_hour` window (or a null utilization for it), so
/// every window is optional; only a response with none at all is an error.
fn usage_from_response(
    body: OAuthUsageResponse,
    creds: &Credentials,
) -> Result<AgentUsage, String> {
    let plan = infer_plan(
        creds.rate_limit_tier.as_deref(),
        creds.subscription_type.as_deref(),
    );

    let mut usage = AgentUsage::new("claude-acp");
    usage.plan = Some(plan);

    push_window(
        &mut usage.windows,
        "5h limit",
        body.five_hour.as_ref(),
        Some(5 * 3600),
    );
    push_window(
        &mut usage.windows,
        "7d limit",
        body.seven_day.as_ref(),
        Some(7 * 86400),
    );
    push_window(
        &mut usage.windows,
        "7d Sonnet",
        body.seven_day_sonnet.as_ref(),
        Some(7 * 86400),
    );
    push_window(
        &mut usage.windows,
        "7d Opus",
        body.seven_day_opus.as_ref(),
        Some(7 * 86400),
    );

    if let Some(extra) = body.extra_usage {
        if extra.is_enabled.unwrap_or(false) {
            if let (Some(limit_cents), Some(used_cents)) = (extra.monthly_limit, extra.used_credits)
            {
                let currency = extra
                    .currency
                    .unwrap_or_else(|| "USD".to_string())
                    .to_uppercase();
                usage.extras.push(ExtraInfo {
                    label: "Extra usage".to_string(),
                    value: format!(
                        "${:.2} / ${:.2} {}",
                        used_cents / 100.0,
                        limit_cents / 100.0,
                        currency
                    ),
                });
            }
        }
    }

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

fn push_window(
    out: &mut Vec<UsageWindow>,
    label: &str,
    window: Option<&OAuthWindow>,
    total_window_seconds: Option<i64>,
) {
    let Some(w) = window else { return };
    let Some(util) = w.utilization else { return };
    let remaining = clamp_percent(100.0 - util);
    let resets_in_seconds = w.resets_at.as_deref().and_then(iso_to_seconds_remaining);
    out.push(UsageWindow {
        label: label.to_string(),
        percentage_remaining: remaining,
        resets_at: w.resets_at.clone(),
        resets_in_seconds,
        total_window_seconds,
    });
}

fn infer_plan(rate_limit_tier: Option<&str>, subscription_type: Option<&str>) -> String {
    let tier = rate_limit_tier.unwrap_or("").to_ascii_lowercase();
    let sub = subscription_type.unwrap_or("").to_ascii_lowercase();
    for h in [sub.as_str(), tier.as_str()] {
        if h.contains("max") {
            return "Claude Max".into();
        }
        if h.contains("pro") {
            return "Claude Pro".into();
        }
        if h.contains("team") {
            return "Claude Team".into();
        }
        if h.contains("enterprise") {
            return "Claude Enterprise".into();
        }
    }
    "Claude".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials {
            access_token: String::new(),
            rate_limit_tier: None,
            subscription_type: Some("max".into()),
        }
    }

    fn parse(json: &str) -> OAuthUsageResponse {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn missing_five_hour_window_keeps_the_others() {
        let body = parse(r#"{"five_hour":null,"seven_day":{"utilization":30.0,"resets_at":null}}"#);
        let usage = usage_from_response(body, &creds()).unwrap();
        let labels: Vec<_> = usage.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["7d limit"]);
        assert_eq!(usage.percentage_remaining, 70.0);
    }

    #[test]
    fn five_hour_without_utilization_is_skipped() {
        let body = parse(
            r#"{"five_hour":{"utilization":null,"resets_at":null},"seven_day":{"utilization":10.0}}"#,
        );
        let usage = usage_from_response(body, &creds()).unwrap();
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].label, "7d limit");
    }

    #[test]
    fn no_windows_is_an_error() {
        assert!(usage_from_response(parse("{}"), &creds()).is_err());
    }
}

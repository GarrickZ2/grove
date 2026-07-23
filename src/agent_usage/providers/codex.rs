//! Codex (ChatGPT) upstream quota API caller.
//!
//! Calls `https://chatgpt.com/backend-api/wham/usage` with an already-resolved
//! access token. Does NOT read credentials — that is the agent layer's job.

use super::super::{clamp_percent, AgentUsage, ExtraInfo, UsageWindow, HTTP_TIMEOUT_CODEX};
use serde::Deserialize;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Debug, Deserialize)]
struct UsageResponse {
    plan_type: Option<String>,
    rate_limit: Option<RateLimitBlock>,
    code_review_rate_limit: Option<CodeReviewRateLimitBlock>,
    credits: Option<CreditsBlock>,
}

#[derive(Debug, Deserialize)]
struct RateLimitBlock {
    primary_window: Option<Window>,
    secondary_window: Option<Window>,
}

#[derive(Debug, Deserialize)]
struct CodeReviewRateLimitBlock {
    primary_window: Option<Window>,
}

#[derive(Debug, Deserialize)]
struct Window {
    used_percent: Option<f32>,
    reset_after_seconds: Option<i64>,
    limit_window_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreditsBlock {
    has_credits: Option<bool>,
    unlimited: Option<bool>,
    balance: Option<String>,
}

pub(crate) fn fetch_with_token(token: &str) -> Result<AgentUsage, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT_CODEX)
        .build();
    let resp = agent
        .get(USAGE_URL)
        .set("Authorization", &format!("Bearer {}", token))
        .set("User-Agent", BROWSER_UA)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("usage api call failed: {}", e))?;
    let body: UsageResponse = resp
        .into_json()
        .map_err(|e| format!("parse usage response: {}", e))?;

    usage_from_response(body)
}

/// Convert the upstream response into Grove's normalized quota payload.
///
/// Codex historically exposed both a 5-hour primary window and a weekly
/// secondary window. The 5-hour limit is no longer present for all plans, so
/// neither window can be required independently.
fn usage_from_response(body: UsageResponse) -> Result<AgentUsage, String> {
    let rate = body.rate_limit.ok_or("missing rate_limit")?;
    let has_secondary = rate.secondary_window.is_some();
    let mut usage = AgentUsage::new("codex-acp");
    usage.plan = match body.plan_type.as_deref() {
        Some(p) if !p.trim().is_empty() => Some(format!("ChatGPT {}", p.trim())),
        _ => Some("ChatGPT".to_string()),
    };

    if let Some(primary) = rate.primary_window {
        push_window(
            &mut usage.windows,
            primary,
            if has_secondary {
                "5h limit"
            } else {
                "Quota limit"
            },
            if has_secondary { Some(5 * 3600) } else { None },
        );
    }
    if let Some(secondary) = rate.secondary_window {
        push_window(
            &mut usage.windows,
            secondary,
            "Weekly limit",
            Some(7 * 86400),
        );
    }

    if let Some(cr) = body.code_review_rate_limit.and_then(|b| b.primary_window) {
        if let Some(used) = cr.used_percent {
            usage.windows.push(UsageWindow {
                label: "Code review".to_string(),
                percentage_remaining: clamp_percent(100.0 - used),
                resets_at: absolute_reset(cr.reset_after_seconds),
                resets_in_seconds: cr.reset_after_seconds,
                total_window_seconds: cr.limit_window_seconds,
            });
        }
    }

    if let Some(credits) = body.credits {
        if credits.unlimited.unwrap_or(false) {
            usage.extras.push(ExtraInfo {
                label: "Credits".to_string(),
                value: "Unlimited".to_string(),
            });
        } else if credits.has_credits.unwrap_or(false) {
            if let Some(balance) = credits.balance {
                usage.extras.push(ExtraInfo {
                    label: "Credits".to_string(),
                    value: balance,
                });
            }
        }
    }

    usage.finalize().ok_or_else(|| "no usage windows".into())
}

fn push_window(
    windows: &mut Vec<UsageWindow>,
    window: Window,
    fallback_label: &str,
    fallback_duration: Option<i64>,
) {
    let Some(used_percent) = window.used_percent else {
        return;
    };
    let total_window_seconds = window.limit_window_seconds.or(fallback_duration);
    windows.push(UsageWindow {
        label: quota_label(total_window_seconds, fallback_label).to_string(),
        percentage_remaining: clamp_percent(100.0 - used_percent),
        resets_at: absolute_reset(window.reset_after_seconds),
        resets_in_seconds: window.reset_after_seconds,
        total_window_seconds,
    });
}

fn quota_label(total_window_seconds: Option<i64>, fallback: &str) -> &str {
    match total_window_seconds {
        Some(seconds) if seconds == 5 * 3600 => "5h limit",
        Some(seconds) if (6 * 86400..=8 * 86400).contains(&seconds) => "Weekly limit",
        _ => fallback,
    }
}

fn absolute_reset(reset_after_seconds: Option<i64>) -> Option<String> {
    let secs = reset_after_seconds?;
    let target = chrono::Utc::now() + chrono::Duration::seconds(secs);
    Some(target.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_codex_response_without_the_retired_five_hour_window() {
        let body: UsageResponse = serde_json::from_str(
            r#"{
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 27.5,
                        "reset_after_seconds": 3600,
                        "limit_window_seconds": 604800
                    }
                }
            }"#,
        )
        .unwrap();

        let usage = usage_from_response(body).unwrap();

        assert_eq!(usage.plan.as_deref(), Some("ChatGPT pro"));
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].label, "Weekly limit");
        assert_eq!(usage.windows[0].percentage_remaining, 73.0);
        assert_eq!(usage.windows[0].total_window_seconds, Some(7 * 86400));
    }

    #[test]
    fn preserves_legacy_two_window_response() {
        let body: UsageResponse = serde_json::from_str(
            r#"{
                "rate_limit": {
                    "primary_window": { "used_percent": 10 },
                    "secondary_window": { "used_percent": 40 }
                }
            }"#,
        )
        .unwrap();

        let usage = usage_from_response(body).unwrap();

        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].label, "5h limit");
        assert_eq!(usage.windows[0].total_window_seconds, Some(5 * 3600));
        assert_eq!(usage.windows[1].label, "Weekly limit");
        assert_eq!(usage.windows[1].total_window_seconds, Some(7 * 86400));
    }
}

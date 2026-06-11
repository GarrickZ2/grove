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

    let rate = body.rate_limit.ok_or("missing rate_limit")?;
    let primary = rate.primary_window.ok_or("missing primary_window")?;
    let secondary = rate.secondary_window.ok_or("missing secondary_window")?;
    let primary_used = primary.used_percent.ok_or("primary used_percent missing")?;
    let secondary_used = secondary
        .used_percent
        .ok_or("secondary used_percent missing")?;

    let mut usage = AgentUsage::new("codex-acp");
    usage.plan = match body.plan_type.as_deref() {
        Some(p) if !p.trim().is_empty() => Some(format!("ChatGPT {}", p.trim())),
        _ => Some("ChatGPT".to_string()),
    };

    usage.windows.push(UsageWindow {
        label: "5h limit".to_string(),
        percentage_remaining: clamp_percent(100.0 - primary_used),
        resets_at: absolute_reset(primary.reset_after_seconds),
        resets_in_seconds: primary.reset_after_seconds,
        total_window_seconds: primary.limit_window_seconds.or(Some(5 * 3600)),
    });
    usage.windows.push(UsageWindow {
        label: "Weekly limit".to_string(),
        percentage_remaining: clamp_percent(100.0 - secondary_used),
        resets_at: absolute_reset(secondary.reset_after_seconds),
        resets_in_seconds: secondary.reset_after_seconds,
        total_window_seconds: secondary.limit_window_seconds.or(Some(7 * 86400)),
    });

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

fn absolute_reset(reset_after_seconds: Option<i64>) -> Option<String> {
    let secs = reset_after_seconds?;
    let target = chrono::Utc::now() + chrono::Duration::seconds(secs);
    Some(target.to_rfc3339())
}
